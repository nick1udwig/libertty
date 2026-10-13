use crate::{
    dictation::Recording,
    herdr::Target,
    herdr_terminal_stream::{Hub, Size, Subscription},
    session::Transport,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

struct Inner {
    revision: u64,
    dictation: Option<Recording>,
    dictation_id: String,
    shell: Option<crate::herdr::ShellInput>,
    prompt: u64,
    prompt_revision: u64,
    editable: Option<Editable>,
    repair: Option<(String, CancellationToken)>,
}
#[derive(Clone)]
struct Editable {
    text: String,
    screen: String,
}
struct Replacement {
    previous: Editable,
    revision: u64,
    shell: crate::herdr::ShellInput,
    edit_id: Option<String>,
}
struct Input {
    text: String,
    paste: bool,
    guard: Option<(u64, String)>,
    command: Option<String>,
    complete: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    replacement: Option<Replacement>,
}
pub struct View {
    target: Target,
    agent: Value,
    inner: Mutex<Inner>,
    capacity: Arc<Semaphore>,
    pending_input: mpsc::Sender<Input>,
    send: crate::viewer_queue::Sender,
    terminal: Subscription,
    history: crate::herdr_history::Hub,
    active: tokio::sync::watch::Sender<bool>,
    size: Mutex<Option<Size>>,
    layout: tokio::sync::watch::Sender<u64>,
    redraw_before: Mutex<Option<u64>>,
    baseline: Mutex<Option<Size>>,
    frame_ready: tokio::sync::Notify,
    cancel: CancellationToken,
    services: crate::host::HostServices,
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
        history: &crate::herdr_history::Hub,
        initial: Option<(Size, Option<u64>)>,
        send: crate::viewer_queue::Sender,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>, String> {
        let initial_size = initial.map(|(size, _)| size);
        let revision = initial.and_then(|(_, revision)| revision);
        let (frames, mut receive) = mpsc::channel(16);
        let terminal = hub.subscribe_sized(
            target.clone(),
            agent["terminalId"].as_str().ok_or("Agent ended")?.into(),
            frames,
            initial_size,
        )?;
        let subscription = history.subscribe(target.clone(), agent["paneId"].clone())?;
        let (active, _) = tokio::sync::watch::channel(true);
        let (layout, _) = tokio::sync::watch::channel(0);
        let (pending_input, mut inputs) = mpsc::channel::<Input>(128);
        let view = Arc::new(Self {
            target,
            agent,
            inner: Mutex::new(Inner {
                revision: 0,
                dictation: None,
                dictation_id: String::new(),
                shell: None,
                prompt: 1,
                prompt_revision: 0,
                editable: None,
                repair: None,
            }),
            capacity: Arc::new(Semaphore::new(128)),
            services: crate::host::HostServices::new(),
            pending_input,
            send,
            terminal,
            history: history.clone(),
            active,
            size: Mutex::new(initial_size),
            layout,
            redraw_before: Mutex::new(revision),
            baseline: Mutex::new(None),
            frame_ready: tokio::sync::Notify::new(),
            cancel,
        });
        if let Some(size) = initial_size {
            view.send(
                json!({"type":"herdr-layout","cols":size.cols,"rows":size.rows,"ready":false}),
            );
        }
        view.send_state();
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        tokio::spawn(async move {
            loop {
                let Some(view) = weak.upgrade() else { break };
                let shell = tokio::select! { biased; _=lifetime.cancelled()=>break, result=view.target.shell_input(&view.agent["paneId"])=>result.ok().flatten() };
                let changed = {
                    let mut inner = view.inner.lock().unwrap();
                    if inner.shell == shell {
                        false
                    } else {
                        inner.shell = shell;
                        inner.editable = None;
                        inner.revision += 1;
                        inner.prompt += 1;
                        inner.prompt_revision = inner.revision;
                        true
                    }
                };
                if changed {
                    view.send_state();
                }
                tokio::select! { biased; _=lifetime.cancelled()=>break, _=tokio::time::sleep(std::time::Duration::from_millis(300))=>{} }
            }
        });
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        // One worker preserves receive order across typing, commands and dictation.
        tokio::spawn(async move {
            loop {
                let input = tokio::select! {biased;_=lifetime.cancelled()=>break,input=inputs.recv()=>input};
                let Some(input) = input else { break };
                let Some(view) = weak.upgrade() else { break };
                let guard = input
                    .guard
                    .as_ref()
                    .map(|(revision, id)| (*revision, id.as_str()));
                let result = view
                    .input_serial(&input.text, input.paste, guard, input.replacement.as_ref())
                    .await;
                if let Some(id) = input
                    .replacement
                    .as_ref()
                    .and_then(|replacement| replacement.edit_id.as_ref())
                {
                    let revision = view.inner.lock().unwrap().revision;
                    view.send(json!({"type":"edit-result","id":id,"accepted":result.is_ok(),"revision":revision}));
                    continue;
                }
                if let Some(complete) = input.complete {
                    let _ = complete.send(result);
                } else {
                    view.input_complete(input.command.as_deref(), result);
                }
            }
        });
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        let slow = view.terminal.slow.clone();
        tokio::spawn(async move {
            loop {
                let frame = tokio::select! {biased;_=lifetime.cancelled()=>break, _=slow.cancelled()=>{if let Some(view)=weak.upgrade(){view.send.too_slow();}break;}, frame=receive.recv()=>frame};
                let Some(frame) = frame else { break };
                let Some(view) = weak.upgrade() else { break };
                if frame["full"] == true {
                    let size = frame["width"].as_u64().zip(frame["height"].as_u64()).map(
                        |(cols, rows)| Size {
                            cols: cols as u16,
                            rows: rows as u16,
                        },
                    );
                    if size.is_some() && size == *view.size.lock().unwrap() {
                        *view.baseline.lock().unwrap() = size;
                        view.frame_ready.notify_waiters();
                    }
                }
                if !*view.active.borrow() {
                    continue;
                }
                if !view.send.send(Transport::Message(frame)) {
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        let mut active = view.active.subscribe();
        tokio::spawn(async move {
            let mut history = Some(subscription);
            loop {
                if !*active.borrow_and_update() {
                    history = None;
                } else if history.is_none() {
                    let Some(view) = weak.upgrade() else { break };
                    history = view
                        .history
                        .subscribe(view.target.clone(), view.agent["paneId"].clone())
                        .ok();
                }
                if let Some(history) = &mut history {
                    let message = history.receive.borrow_and_update().clone();
                    if let Some(message) = message {
                        let Some(view) = weak.upgrade() else { break };
                        match message {
                            Ok(message) => view.send(message.as_ref().clone()),
                            Err(message) => {
                                view.send(
                                    json!({"type":"reading-error","message":message.as_ref()}),
                                );
                                view.send.send(Transport::Close(
                                    1011,
                                    "Herdr terminal unavailable".into(),
                                ));
                                break;
                            }
                        }
                    }
                }
                tokio::select! { biased; _=lifetime.cancelled()=>break, changed=active.changed()=>if changed.is_err(){break;}, changed=async { match &mut history {Some(history)=>history.receive.changed().await, None=>std::future::pending().await} }=>if changed.is_err(){break;} }
            }
        });
        if let Some(size) = initial_size {
            view.confirm_layout(size, revision, view.begin_layout());
        }
        Ok(view)
    }
    fn begin_layout(&self) -> u64 {
        self.layout.send_modify(|epoch| *epoch += 1);
        *self.layout.borrow()
    }
    fn confirm_layout(self: &Arc<Self>, size: Size, before: Option<u64>, epoch: u64) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let Some(view) = weak.upgrade() else { return };
            let mut layout = view.layout.subscribe();
            if *layout.borrow_and_update() != epoch {
                return;
            }
            loop {
                let ready = view.frame_ready.notified();
                tokio::pin!(ready);
                ready.as_mut().enable();
                if *view.baseline.lock().unwrap() == Some(size) {
                    break;
                }
                tokio::select! { biased; _=view.cancel.cancelled()=>return, _=layout.changed()=>return, _=&mut ready=>{} }
            }
            let redrawn = tokio::select! { biased; _=layout.changed()=>false, result=crate::herdr_redraw::wait(&view.target, &view.agent["paneId"], before, &view.cancel)=>result };
            if redrawn && *view.layout.borrow() == epoch && *view.size.lock().unwrap() == Some(size)
            {
                *view.redraw_before.lock().unwrap() = None;
                view.send(
                    json!({"type":"herdr-layout","cols":size.cols,"rows":size.rows,"ready":true}),
                );
                view.terminal.refresh();
            }
        });
    }
    fn send(&self, message: Value) {
        if !self.cancel.is_cancelled() {
            self.send.send(Transport::Message(message));
        }
    }
    fn send_state(&self) {
        let inner = self.inner.lock().unwrap();
        self.send(json!({"type":"state","state":{"cwd":inner.shell.as_ref().map(|shell| shell.cwd.as_str()).or(self.agent["cwd"].as_str()).unwrap_or(""),"ready":inner.shell.is_some(),"inputTarget":if inner.shell.is_some(){"shell"}else{"program"},"terminalScroll":true,"exited":false,"prompt":inner.prompt,"promptRevision":inner.prompt_revision,"inputRevision":inner.revision}}));
    }
    async fn editable_screen(&self, text: &str) -> Result<String, String> {
        for _ in 0..20 {
            let reply = self.target.request("pane.read", json!({"pane_id":self.agent["paneId"],"source":"recent_unwrapped","lines":1000})).await?;
            let screen = reply["read"]["text"]
                .as_str()
                .ok_or("Cannot read the shell input.")?;
            if screen.contains(text) {
                return Ok(screen.into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        Err("The shell input has not finished updating.".into())
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
        replacement: Option<Replacement>,
    ) -> Result<(), String> {
        if text.encode_utf16().count() > 16000 {
            return Err("Terminal input exceeded its limit.".into());
        }
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Terminal input exceeded its limit.".to_owned())?;
        let (complete, result) = tokio::sync::oneshot::channel();
        self.pending_input
            .try_send(Input {
                text: text.into(),
                paste,
                guard: guard.map(|(revision, id)| (revision, id.into())),
                command: None,
                complete: Some(complete),
                _permit: permit,
                replacement,
            })
            .map_err(|_| "Terminal input exceeded its limit.".to_owned())?;
        tokio::select! {biased;_=self.cancel.cancelled()=>Err("The agent view changed. No input was sent.".into()),result=result=>result.map_err(|_| "The agent view changed. No input was sent.".to_owned())?}
    }
    fn queue_input(
        &self,
        text: String,
        command: Option<String>,
        paste: bool,
        replacement: Option<Replacement>,
    ) {
        let permit = match self.capacity.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.input_complete(
                    command.as_deref(),
                    Err("Terminal input exceeded its limit.".into()),
                );
                return;
            }
        };
        if let Err(error) = self.pending_input.try_send(Input {
            text,
            paste,
            guard: None,
            command,
            complete: None,
            _permit: permit,
            replacement,
        }) {
            self.input_complete(
                error.into_inner().command.as_deref(),
                Err("Terminal input exceeded its limit.".into()),
            );
        }
    }
    fn input_complete(&self, command: Option<&str>, result: Result<(), String>) {
        if let Some(id) = command {
            let mut reply = json!({"type":"result","id":id,"accepted":result.is_ok()});
            if let Err(error) = result {
                reply["message"] = json!(error);
            }
            self.send(reply);
        } else if let Err(message) = result {
            self.send(json!({"type":"reading-error","message":message}));
        }
    }
    async fn input_serial(
        &self,
        text: &str,
        paste: bool,
        guard: Option<(u64, &str)>,
        replacement: Option<&Replacement>,
    ) -> Result<(), String> {
        if text.encode_utf16().count() > 16000 {
            return Err("Terminal input exceeded its limit.".into());
        }
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
                let current_shell = self
                    .target
                    .shell_input(&self.agent["paneId"])
                    .await
                    .ok()
                    .flatten();
                if current_shell != self.inner.lock().unwrap().shell {
                    return Err("Terminal input changed during dictation.".into());
                }
            }
            let text = if let Some(replacement) = replacement {
                if self
                    .target
                    .shell_input(&self.agent["paneId"])
                    .await?
                    .as_ref()
                    != Some(&replacement.shell)
                {
                    return Err("The shell is no longer at the prompt.".into());
                }
                let reply = self.target.request("pane.read", json!({"pane_id":self.agent["paneId"],"source":"recent_unwrapped","lines":1000})).await?;
                if reply["read"]["text"] != replacement.previous.screen
                    || self.inner.lock().unwrap().revision != replacement.revision
                {
                    return Err("Shell input changed. No replacement was sent.".into());
                }
                format!(
                    "{}{}",
                    "\x7f".repeat(replacement.previous.text.chars().count()),
                    text
                )
            } else {
                text.to_owned()
            };
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
            if let Some(replacement) = replacement {
                if replacement.edit_id.is_some() {
                    let screen = self
                        .editable_screen(text.trim_start_matches('\x7f'))
                        .await?;
                    let mut inner = self.inner.lock().unwrap();
                    if inner.revision == replacement.revision {
                        inner.editable = Some(Editable {
                            text: text.trim_start_matches('\x7f').into(),
                            screen,
                        });
                    }
                } else {
                    self.inner.lock().unwrap().editable = None;
                }
            }
            Ok(())
        };
        tokio::select! {biased;_=self.cancel.cancelled()=>Err("The agent view changed. No input was sent.".into()),result=work=>result}
    }
    pub fn audio(&self, bytes: Vec<u8>) {
        if let Some(recording) = &self.inner.lock().unwrap().dictation {
            recording.audio(bytes);
        }
    }
    fn start_repair(
        self: &Arc<Self>,
        id: String,
        text: String,
        intent: crate::alternatives::Intent,
        prompt: u64,
        revision: u64,
        backend: bool,
    ) {
        let cancel = self.cancel.child_token();
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.revision != revision || inner.prompt != prompt {
                return;
            }
            inner.dictation_id = id.clone();
            if let Some((_, previous)) = inner.repair.replace((id.clone(), cancel.clone())) {
                previous.cancel();
            }
        }
        let view = self.clone();
        tokio::spawn(async move {
            let target = &view.target;
            let terminal = view.agent["terminalId"].as_str().unwrap_or("");
            let services = &view.services;
            let repair_cancel = &cancel;
            let result = tokio::select! { biased;
                _ = cancel.cancelled() => Err("Repair cancelled.".to_owned()),
                result = tokio::time::timeout(std::time::Duration::from_secs(10), crate::alternatives::prepare(&text, &intent, |query| Box::pin(async move { target.suggest(terminal, &query, services.clone(), repair_cancel).await }))) => result.unwrap_or_else(|_| Err("Repair timed out.".into())),
            };
            let mut reply = json!({"type":"repair-result","id":id,"prompt":prompt,"accepted":false,"original":text,"selected":text,"candidates":[]});
            match result {
                Ok(prepared) => {
                    let applied = async {
                        view.guard(revision, &id)?;
                        if cancel.is_cancelled() {
                            return Err("Repair cancelled.".to_owned());
                        }
                        let replacement = {
                            let mut inner = view.inner.lock().unwrap();
                            let previous = inner
                                .editable
                                .clone()
                                .ok_or("Only the latest dictated text can be replaced.")?;
                            let shell = inner
                                .shell
                                .clone()
                                .ok_or("The shell is no longer at the prompt.")?;
                            if prepared.selected == previous.text {
                                return Ok(());
                            }
                            inner.revision += 1;
                            Replacement {
                                previous,
                                shell,
                                revision: inner.revision,
                                edit_id: None,
                            }
                        };
                        let next = replacement.revision;
                        view.input(
                            &prepared.selected,
                            false,
                            Some((next, &id)),
                            Some(replacement),
                        )
                        .await?;
                        let screen = view.editable_screen(&prepared.selected).await?;
                        view.guard(next, &id)?;
                        view.inner.lock().unwrap().editable = Some(Editable {
                            text: prepared.selected.clone(),
                            screen,
                        });
                        Ok::<_, String>(())
                    }
                    .await;
                    reply["accepted"] = json!(applied.is_ok());
                    if let Err(error) = applied {
                        reply["error"] = json!(error);
                    }
                    reply["selected"] = json!(prepared.selected);
                    reply["candidates"] = json!(prepared.candidates);
                }
                Err(error) => {
                    reply["error"] = json!(error);
                }
            }
            let mut inner = view.inner.lock().unwrap();
            reply["revision"] = json!(inner.revision);
            if backend {
                reply["source"] = json!("dictation");
            }
            if inner
                .repair
                .as_ref()
                .is_some_and(|(active, _)| active == &id)
            {
                inner.repair.take();
            }
            view.send(reply);
        });
    }
    pub fn receive(self: &Arc<Self>, message: Value) -> Result<(), String> {
        match message["type"].as_str().unwrap_or("") {
            "repair-cancel" => {
                let inner = self.inner.lock().unwrap();
                if let Some((id, cancel)) = &inner.repair
                    && message["id"].as_str() == Some(id)
                {
                    cancel.cancel();
                }
                Ok(())
            }
            "repair" => {
                let id = message["id"]
                    .as_str()
                    .filter(|id| id.len() <= 100)
                    .ok_or("Invalid repair")?
                    .to_owned();
                let text = message["text"]
                    .as_str()
                    .filter(|text| text.encode_utf16().count() <= 2000 && !controls(text))
                    .ok_or("Invalid repair")?
                    .to_owned();
                let intent = message
                    .get("intent")
                    .map(|value| serde_json::from_value(value.clone()))
                    .transpose()
                    .map_err(|_| "Invalid repair intent")?
                    .unwrap_or_default();
                let (prompt, revision) = {
                    let inner = self.inner.lock().unwrap();
                    if integer(&message["prompt"]) != Some(inner.prompt as f64)
                        || integer(&message["revision"]) != Some(inner.revision as f64)
                    {
                        self.send(json!({"type":"repair-result","id":id,"accepted":false,"revision":inner.revision,"prompt":inner.prompt,"original":text,"selected":text,"candidates":[]}));
                        return Ok(());
                    }
                    (inner.prompt, inner.revision)
                };
                self.start_repair(id, text, intent, prompt, revision, false);
                Ok(())
            }
            "ack" => Ok(()),
            "herdr-frame-request" => {
                self.terminal.refresh();
                // Subscribe briefly to refresh the shared active resource.
                if let Ok(history) = self
                    .history
                    .subscribe(self.target.clone(), self.agent["paneId"].clone())
                {
                    history.refresh.notify_one();
                }
                Ok(())
            }
            "herdr-active" => {
                let active = message["active"].as_bool().ok_or("Invalid viewer state")?;
                let changed = self.active.send_replace(active) != active;
                let epoch = if changed {
                    self.begin_layout()
                } else {
                    *self.layout.borrow()
                };
                if active && changed {
                    let size = *self.size.lock().unwrap();
                    if let Some(size) = size {
                        *self.baseline.lock().unwrap() = None;
                        self.send(json!({"type":"herdr-layout","cols":size.cols,"rows":size.rows,"ready":false}));
                        let weak = Arc::downgrade(self);
                        tokio::spawn(async move {
                            let Some(view) = weak.upgrade() else { return };
                            // Preserve an unfinished resize fence across rapid switches.
                            let pending = *view.redraw_before.lock().unwrap();
                            let revision = match pending {
                                Some(_) => pending,
                                None => {
                                    crate::herdr_redraw::revision(
                                        &view.target,
                                        &view.agent["paneId"],
                                        &view.cancel,
                                    )
                                    .await
                                }
                            };
                            if view.cancel.is_cancelled()
                                || !*view.active.borrow()
                                || *view.layout.borrow() != epoch
                                || *view.size.lock().unwrap() != Some(size)
                            {
                                return;
                            }
                            *view.redraw_before.lock().unwrap() = revision;
                            view.terminal.claim();
                            view.confirm_layout(size, revision, epoch);
                        });
                    } else {
                        self.terminal.refresh();
                    }
                }
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
                let size = if message["mobile"] == true {
                    Some(Size {
                        cols: cols.unwrap() as u16,
                        rows: rows.unwrap() as u16,
                    })
                } else {
                    None
                };
                let changed = {
                    let mut current = self.size.lock().unwrap();
                    let changed = *current != size;
                    *current = size;
                    changed
                };
                let epoch = if changed {
                    self.begin_layout()
                } else {
                    *self.layout.borrow()
                };
                if changed && let Some(size) = size {
                    *self.baseline.lock().unwrap() = None;
                    self.send(json!({"type":"herdr-layout","cols":size.cols,"rows":size.rows,"ready":false}));
                    let weak = Arc::downgrade(self);
                    tokio::spawn(async move {
                        let Some(view) = weak.upgrade() else { return };
                        let revision = crate::herdr_redraw::revision(
                            &view.target,
                            &view.agent["paneId"],
                            &view.cancel,
                        )
                        .await;
                        if view.cancel.is_cancelled()
                            || *view.layout.borrow() != epoch
                            || *view.size.lock().unwrap() != Some(size)
                        {
                            return;
                        }
                        *view.redraw_before.lock().unwrap() = revision;
                        if view.terminal.resize(Some(size)).is_ok() {
                            view.confirm_layout(size, revision, epoch);
                        }
                    });
                    Ok(())
                } else {
                    self.terminal.resize(size)
                }
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
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.revision += 1;
                    inner.editable = None;
                }
                self.queue_input(text, None, false, None);
                Ok(())
            }
            "paste" => {
                let text = message["text"]
                    .as_str()
                    .filter(|text| {
                        !text.is_empty() && text.encode_utf16().count() <= 16000 && !controls(text)
                    })
                    .ok_or("Invalid paste")?
                    .to_owned();
                self.inner.lock().unwrap().revision += 1;
                self.queue_input(text, None, true, None);
                Ok(())
            }
            "replace" => {
                let id = message["id"]
                    .as_str()
                    .filter(|id| id.len() <= 100)
                    .ok_or("Invalid replacement")?
                    .to_owned();
                let text = message["text"]
                    .as_str()
                    .filter(|text| {
                        !text.is_empty() && text.encode_utf16().count() <= 2000 && !controls(text)
                    })
                    .ok_or("Invalid replacement")?
                    .to_owned();
                let replacement = {
                    let mut inner = self.inner.lock().unwrap();
                    let valid = integer(&message["prompt"]) == Some(inner.prompt as f64)
                        && integer(&message["revision"]) == Some(inner.revision as f64);
                    let replacement = inner
                        .shell
                        .clone()
                        .zip(inner.editable.clone())
                        .filter(|_| valid);
                    replacement.map(|(shell, previous)| {
                        inner.revision += 1;
                        Replacement {
                            shell,
                            previous,
                            revision: inner.revision,
                            edit_id: Some(id.clone()),
                        }
                    })
                };
                if let Some(replacement) = replacement {
                    self.queue_input(text, None, false, Some(replacement));
                } else {
                    self.send(json!({"type":"edit-result","id":id,"accepted":false,"revision":self.inner.lock().unwrap().revision}));
                }
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
                let replacement = {
                    let mut inner = self.inner.lock().unwrap();
                    inner.revision += 1;
                    inner
                        .shell
                        .clone()
                        .zip(inner.editable.clone())
                        .map(|(shell, previous)| Replacement {
                            shell,
                            previous,
                            revision: inner.revision,
                            edit_id: None,
                        })
                };
                self.queue_input(command + "\r", Some(id), false, replacement);
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
                        if message["target"]
                            != if inner.shell.is_some() {
                                "shell"
                            } else {
                                "program"
                            }
                            || integer(&message["prompt"]) != Some(inner.prompt as f64)
                            || integer(&message["revision"]) != Some(revision as f64)
                        {
                            self.send(json!({"type":"dictation","id":id,"state":"error","message":"Terminal input changed. Try again."}));
                            return Ok(());
                        }
                        inner.dictation_id = id.clone();
                        inner.editable = None;
                        let prompt = inner.prompt;
                        let shell = inner.shell.is_some();
                        let weak = Arc::downgrade(self);
                        let result_id = id.clone();
                        let phrases = message["readingPhrases"].clone();
                        let result = Arc::new(move |text: String| {
                            let weak = weak.clone();
                            let id = result_id.clone();
                            let phrases = phrases.clone();
                            Box::pin(async move {
                                let view=weak.upgrade().ok_or("Terminal input changed during dictation. No text was inserted.".to_owned())?;
                                view.guard(revision, &id)?;
                                if text.is_empty() {
                                    return Ok(());
                                }
                                view.input(&text, true, Some((revision, &id)), None).await?;
                                let screen = if shell {
                                    view.editable_screen(&text).await.ok()
                                } else {
                                    None
                                };
                                let new_revision = {
                                    let mut inner = view.inner.lock().unwrap();
                                    if inner.revision != revision {
                                        return Err(
                                            "Terminal input changed during dictation.".into()
                                        );
                                    }
                                    inner.revision += 1;
                                    inner.editable = screen.map(|screen| Editable {
                                        text: text.clone(),
                                        screen,
                                    });
                                    inner.revision
                                };
                                view.send(json!({"type":"pasted","text":text,"replace":false,"prompt":prompt,"revision":new_revision,"source":"dictation","repairing":shell && text.encode_utf16().count() <= 2000}));
                                if shell && text.encode_utf16().count() <= 2000 {
                                    let intent =
                                        crate::alternatives::Intent::detect(&text, &phrases);
                                    view.start_repair(
                                        crate::storage::random_hex(16),
                                        text,
                                        intent,
                                        prompt,
                                        new_revision,
                                        true,
                                    );
                                }
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
            "dictation-paste" => {
                let text = message["text"]
                    .as_str()
                    .filter(|text| {
                        !text.is_empty() && text.encode_utf16().count() <= 2000 && !controls(text)
                    })
                    .ok_or("Invalid dictation")?
                    .to_owned();
                let (revision, prompt, id, replacement, shell) = {
                    let mut inner = self.inner.lock().unwrap();
                    let shell = inner
                        .shell
                        .clone()
                        .ok_or("Dictation alternatives require a shell prompt.")?;
                    if integer(&message["prompt"]) != Some(inner.prompt as f64)
                        || integer(&message["revision"]) != Some(inner.revision as f64)
                    {
                        return Err("Terminal input changed. Try again.".into());
                    }
                    let id = crate::storage::random_hex(16);
                    inner.dictation_id = id.clone();
                    let replacement = if message["replace"] == true {
                        inner.editable.clone().map(|previous| Replacement {
                            previous,
                            shell: shell.clone(),
                            revision: inner.revision,
                            edit_id: None,
                        })
                    } else {
                        None
                    };
                    (inner.revision, inner.prompt, id, replacement, shell)
                };
                let applied = message["applied"] == true;
                let phrases = message["readingPhrases"].clone();
                let view = self.clone();
                tokio::spawn(async move {
                    let work = async {
                        if view
                            .target
                            .shell_input(&view.agent["paneId"])
                            .await?
                            .as_ref()
                            != Some(&shell)
                        {
                            return Err("The shell is no longer at the prompt.".to_owned());
                        }
                        if !applied {
                            view.input(
                                &text,
                                replacement.is_none(),
                                Some((revision, &id)),
                                replacement,
                            )
                            .await?;
                        }
                        let screen = view.editable_screen(&text).await?;
                        view.guard(revision, &id)?;
                        let revision = {
                            let mut inner = view.inner.lock().unwrap();
                            inner.revision += 1;
                            inner.editable = Some(Editable {
                                text: text.clone(),
                                screen,
                            });
                            inner.revision
                        };
                        view.send(json!({"type":"pasted","text":text,"replace":false,"source":"dictation","repairing":true,"prompt":prompt,"revision":revision}));
                        let intent = crate::alternatives::Intent::detect(&text, &phrases);
                        view.start_repair(
                            crate::storage::random_hex(16),
                            text,
                            intent,
                            prompt,
                            revision,
                            true,
                        );
                        Ok(())
                    };
                    if let Err(error) = work.await {
                        view.send(json!({"type":"reading-error","message":error}));
                    }
                });
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
