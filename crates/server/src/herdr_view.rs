use crate::{
    dictation::Recording,
    herdr::Target,
    herdr_terminal_stream::{Hub, Size, Subscription},
    session::Transport,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

struct Inner {
    revision: u64,
    dictation: Option<Recording>,
    dictation_id: String,
}
pub struct View {
    target: Target,
    agent: Value,
    inner: Mutex<Inner>,
    input: tokio::sync::Mutex<()>,
    capacity: Arc<Semaphore>,
    send: crate::viewer_queue::Sender,
    terminal: Subscription,
    cancel: CancellationToken,
}
fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0)
}
fn controls(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
impl View {
    pub fn open(
        target: Target,
        agent: Value,
        hub: &Hub,
        send: crate::viewer_queue::Sender,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>, String> {
        let (frames, mut receive) = mpsc::channel(16);
        let terminal = hub.subscribe(
            target.clone(),
            agent["terminalId"].as_str().ok_or("Agent ended")?.into(),
            frames,
        )?;
        let view = Arc::new(Self {
            target,
            agent,
            inner: Mutex::new(Inner {
                revision: 0,
                dictation: None,
                dictation_id: String::new(),
            }),
            input: tokio::sync::Mutex::new(()),
            capacity: Arc::new(Semaphore::new(128)),
            send,
            terminal,
            cancel,
        });
        view.send(json!({"type":"state","state":{"cwd":view.agent["cwd"],"ready":false,"inputTarget":"program","terminalScroll":true,"exited":false,"prompt":1,"promptRevision":0,"inputRevision":0}}));
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        let slow = view.terminal.slow.clone();
        tokio::spawn(async move {
            loop {
                let frame = tokio::select! {biased;_=lifetime.cancelled()=>break, _=slow.cancelled()=>{if let Some(view)=weak.upgrade(){view.send.too_slow();}break;}, frame=receive.recv()=>frame};
                let Some(frame) = frame else { break };
                let Some(view) = weak.upgrade() else { break };
                if !view.send.send(Transport::Message(frame)) {
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        tokio::spawn(async move {
            let mut screen = None;
            loop {
                let Some(view) = weak.upgrade() else { break };
                let work = view.target.request("pane.read",json!({"pane_id":view.agent["paneId"],"source":"recent_unwrapped","lines":1000,"format":"ansi","strip_ansi":false}));
                let result =
                    tokio::select! {biased;_=lifetime.cancelled()=>break, result=work=>result};
                match result.and_then(|value| value["read"]["text"].as_str().map(str::to_owned).ok_or("Herdr did not return terminal history. Update Herdr to a version supporting recent-unwrapped reads.".into())) {
                    Ok(text)=>if screen.as_ref()!=Some(&text){screen=Some(text.clone());view.send(json!({"type":"screen","text":text}));},
                    Err(message)=>{
                        view.send(json!({"type":"reading-error","message":message}));
                        view.send.send(Transport::Close(1011,"Herdr terminal unavailable".into()));
                        break;
                    }
                }
                drop(view);
                tokio::select! {biased;_=lifetime.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(150))=>{}}
            }
        });
        Ok(view)
    }
    fn send(&self, message: Value) {
        if !self.cancel.is_cancelled() {
            self.send.send(Transport::Message(message));
        }
    }
    fn guard(&self, revision: u64, id: &str) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        if self.cancel.is_cancelled() || inner.revision != revision || inner.dictation_id != id {
            Err("Terminal input changed during dictation. No text was inserted.".into())
        } else {
            Ok(())
        }
    }
    async fn input(
        &self,
        text: &str,
        paste: bool,
        guard: Option<(u64, &str)>,
    ) -> Result<(), String> {
        if text.encode_utf16().count() > 16000 {
            return Err("Terminal input exceeded its limit.".into());
        }
        let _permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Terminal input exceeded its limit.".to_owned())?;
        let _serial = tokio::select! {biased;_=self.cancel.cancelled()=>return Err("The agent view changed. No input was sent.".into()),serial=self.input.lock()=>serial};
        let work = async {
            if self.cancel.is_cancelled() {
                return Err("The agent view changed. No input was sent.".into());
            }
            let snapshot = self.target.snapshot().await?;
            let current = snapshot["terminals"].as_array().and_then(|agents| {
                agents
                    .iter()
                    .find(|a| a["terminalId"] == self.agent["terminalId"])
            });
            if current.is_none_or(|a| a["paneId"] != self.agent["paneId"])
                || self.cancel.is_cancelled()
            {
                return Err("This agent ended or moved. Reopen its tab. No input was sent.".into());
            }
            if let Some((revision, id)) = guard {
                self.guard(revision, id)?;
            }
            self.target
                .request(
                    if paste {
                        "pane.send_input"
                    } else {
                        "pane.send_text"
                    },
                    json!({"pane_id":self.agent["paneId"],"text":text}),
                )
                .await?;
            Ok(())
        };
        tokio::select! {biased;_=self.cancel.cancelled()=>Err("The agent view changed. No input was sent.".into()),result=work=>result}
    }
    pub fn audio(&self, bytes: Vec<u8>) {
        if let Some(recording) = &self.inner.lock().unwrap().dictation {
            recording.audio(bytes);
        }
    }
    pub fn receive(self: &Arc<Self>, message: Value) -> Result<(), String> {
        match message["type"].as_str().unwrap_or("") {
            "ack" => Ok(()),
            "herdr-frame-request" => {
                self.terminal.refresh();
                Ok(())
            }
            "resize" => {
                let cols = integer(&message["cols"]).filter(|n| (1.0..=1000.0).contains(n));
                let rows = integer(&message["rows"]).filter(|n| (1.0..=1000.0).contains(n));
                if cols.is_none()
                    || rows.is_none()
                    || message.get("mobile").is_some_and(|v| !v.is_boolean())
                {
                    return Err("Invalid terminal size".into());
                }
                self.terminal.resize(if message["mobile"] == true {
                    Some(Size {
                        cols: cols.unwrap() as u16,
                        rows: rows.unwrap() as u16,
                    })
                } else {
                    None
                })
            }
            "terminal-scroll" => {
                let lines = integer(&message["lines"]).filter(|n| *n != 0.0 && n.abs() <= 100.0);
                let column = integer(&message["column"]).filter(|n| (0.0..1000.0).contains(n));
                let row = integer(&message["row"]).filter(|n| (0.0..1000.0).contains(n));
                if lines.is_none() || column.is_none() || row.is_none() {
                    return Err("Invalid terminal scroll".into());
                }
                let view = self.clone();
                tokio::spawn(async move {
                    if let Err(message) = view
                        .terminal
                        .scroll(
                            lines.unwrap() as i32,
                            column.unwrap() as u16,
                            row.unwrap() as u16,
                        )
                        .await
                    {
                        view.send(json!({"type":"reading-error","message":message}));
                    }
                });
                Ok(())
            }
            "input" => {
                let text = message["data"]
                    .as_str()
                    .filter(|s| s.encode_utf16().count() <= 16000)
                    .ok_or("Invalid input")?
                    .to_owned();
                self.inner.lock().unwrap().revision += 1;
                let view = self.clone();
                tokio::spawn(async move {
                    if let Err(message) = view.input(&text, false, None).await {
                        view.send(json!({"type":"reading-error","message":message}));
                    }
                });
                Ok(())
            }
            "command" => {
                let command = message["command"]
                    .as_str()
                    .filter(|s| {
                        !s.trim().is_empty() && s.encode_utf16().count() <= 16000 && !controls(s)
                    })
                    .ok_or("Invalid command")?
                    .to_owned();
                let id = message["id"]
                    .as_str()
                    .filter(|s| s.encode_utf16().count() <= 100)
                    .ok_or("Invalid command")?
                    .to_owned();
                self.inner.lock().unwrap().revision += 1;
                let view = self.clone();
                tokio::spawn(async move {
                    let result = view.input(&(command + "\r"), false, None).await;
                    let mut reply = json!({"type":"result","id":id,"accepted":result.is_ok()});
                    if let Err(error) = result {
                        reply["message"] = json!(error);
                    }
                    view.send(reply);
                });
                Ok(())
            }
            "dictation" => {
                let id = message["id"]
                    .as_str()
                    .filter(|s| s.encode_utf16().count() <= 100)
                    .ok_or("Invalid dictation")?
                    .to_owned();
                let mut inner = self.inner.lock().unwrap();
                match message["action"].as_str() {
                    Some("start") => {
                        inner.dictation.take();
                        let revision = inner.revision;
                        if message["target"] != "program"
                            || integer(&message["prompt"]) != Some(1.0)
                            || integer(&message["revision"]) != Some(revision as f64)
                        {
                            self.send(json!({"type":"dictation","id":id,"state":"error","message":"Terminal input changed. Try again."}));
                            return Ok(());
                        }
                        inner.dictation_id = id.clone();
                        let weak = Arc::downgrade(self);
                        let result_id = id.clone();
                        let result = Arc::new(move |text: String| {
                            let weak = weak.clone();
                            let id = result_id.clone();
                            Box::pin(async move {
                                let view=weak.upgrade().ok_or("Terminal input changed during dictation. No text was inserted.".to_owned())?;
                                view.guard(revision, &id)?;
                                if text.is_empty() {
                                    return Ok(());
                                }
                                view.input(&text, true, Some((revision, &id))).await?;
                                let new_revision = {
                                    let mut inner = view.inner.lock().unwrap();
                                    inner.revision += 1;
                                    inner.revision
                                };
                                view.send(json!({"type":"pasted","text":text,"replace":false,"prompt":1,"revision":new_revision,"source":"dictation"}));
                                Ok(())
                            })
                                as futures::future::BoxFuture<'static, Result<(), String>>
                        });
                        let weak = Arc::downgrade(self);
                        let status = Arc::new(move |state: &str, reason: Option<String>| {
                            if let Some(view) = weak.upgrade() {
                                let mut message = json!({"type":"dictation","id":id,"state":state});
                                if let Some(reason) = reason {
                                    message["message"] = json!(reason);
                                }
                                view.send(message);
                            }
                        });
                        inner.dictation = Some(Recording::start_async(
                            std::env::vars().collect(),
                            result,
                            status,
                        ));
                    }
                    Some("finish") if inner.dictation_id == id => {
                        if let Some(recording) = &inner.dictation {
                            recording.finish();
                        }
                    }
                    Some("cancel") if inner.dictation_id == id => {
                        inner.dictation_id.clear();
                        inner.dictation.take();
                    }
                    _ => {}
                }
                Ok(())
            }
            _ => Err("Unknown terminal action".into()),
        }
    }
}
impl Drop for View {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.inner.get_mut().unwrap().dictation.take();
    }
}
