use crate::filesystem::{Reader, Writer};
use crate::herdr::{Lines, Target};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::Child,
    sync::mpsc,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}
struct Viewer {
    id: u64,
    send: mpsc::Sender<Value>,
    size: Option<Size>,
    order: u64,
    slow: tokio_util::sync::CancellationToken,
}
enum Command {
    Add(
        u64,
        mpsc::Sender<Value>,
        tokio_util::sync::CancellationToken,
        Option<Size>,
    ),
    Remove(u64),
    Resize(u64, Option<Size>),
    Refresh(u64),
    Scroll(
        u64,
        i32,
        u16,
        u16,
        tokio::sync::oneshot::Sender<Result<(), String>>,
    ),
}
struct Handle {
    send: mpsc::Sender<Command>,
}
#[derive(Default)]
pub struct Hub {
    resources: Arc<Mutex<HashMap<String, Arc<Handle>>>>,
    next: AtomicU64,
}
pub struct Subscription {
    id: u64,
    handle: Arc<Handle>,
    pub slow: tokio_util::sync::CancellationToken,
}
impl Hub {
    pub fn subscribe(
        &self,
        target: Target,
        terminal: String,
        send: mpsc::Sender<Value>,
    ) -> Result<Subscription, String> {
        self.subscribe_sized(target, terminal, send, None)
    }
    pub fn subscribe_sized(
        &self,
        target: Target,
        terminal: String,
        send: mpsc::Sender<Value>,
        size: Option<Size>,
    ) -> Result<Subscription, String> {
        if size.is_some_and(|size| {
            size.cols == 0 || size.rows == 0 || size.cols > 1000 || size.rows > 1000
        }) {
            return Err("Invalid terminal size.".into());
        }
        let transport = target
            .remote
            .as_ref()
            .map(|host| format!("{:p}", Arc::as_ptr(host)));
        let key = json!([transport, target.path()?, terminal]).to_string();
        let mut resources = self.resources.lock().unwrap();
        resources.retain(|_, resource| !resource.send.is_closed());
        let handle = resources.get(&key).cloned().unwrap_or_else(|| {
            let (send, receive) = mpsc::channel(256);
            let handle = Arc::new(Handle { send });
            resources.insert(key.clone(), handle.clone());
            tokio::spawn(run(
                target,
                terminal,
                receive,
                key,
                Arc::downgrade(&self.resources),
            ));
            handle
        });
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let slow = tokio_util::sync::CancellationToken::new();
        handle
            .send
            .try_send(Command::Add(id, send, slow.clone(), size))
            .map_err(|_| "Terminal input exceeded its limit.")?;
        Ok(Subscription { id, handle, slow })
    }
}
impl Subscription {
    pub fn resize(&self, size: Option<Size>) -> Result<(), String> {
        self.handle
            .send
            .try_send(Command::Resize(self.id, size))
            .map_err(|_| "Terminal input exceeded its limit.".into())
    }
    pub fn refresh(&self) {
        let _ = self.handle.send.try_send(Command::Refresh(self.id));
    }
    pub async fn scroll(&self, lines: i32, column: u16, row: u16) -> Result<(), String> {
        let (send, receive) = tokio::sync::oneshot::channel();
        self.handle
            .send
            .try_send(Command::Scroll(self.id, lines, column, row, send))
            .map_err(|_| "Terminal input exceeded its limit.".to_owned())?;
        receive
            .await
            .map_err(|_| "The Herdr terminal controller is not ready for scrolling.".to_owned())?
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        let command = Command::Remove(self.id);
        if let Err(mpsc::error::TrySendError::Full(command)) = self.handle.send.try_send(command) {
            let send = self.handle.send.clone();
            tokio::spawn(async move {
                let _ = send.send(command).await;
            });
        }
    }
}
struct Running {
    child: Option<Child>,
    input: Writer,
    output: BufReader<Reader>,
    size: Option<Size>,
    lines: Lines,
}
impl Running {
    async fn open(target: &Target, terminal: &str, size: Option<Size>) -> Result<Self, String> {
        if let Some(remote) = &target.remote {
            let mut args = vec![
                target.binary.clone(),
                "terminal".into(),
                "session".into(),
                if size.is_some() { "control" } else { "observe" }.into(),
                terminal.into(),
            ];
            if let Some(size) = size {
                args.extend([
                    "--cols".into(),
                    size.cols.to_string(),
                    "--rows".into(),
                    size.rows.to_string(),
                ]);
            }
            let command = format!(
                "env {} {}",
                target.assignments(true)?,
                args.iter()
                    .map(|arg| termai_engine::repair::shell_quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let channel = remote
                .open_stream(&command, &tokio_util::sync::CancellationToken::new())
                .await?;
            let (read, write) = tokio::io::split(channel.into_stream());
            return Ok(Self {
                child: None,
                input: Box::new(write),
                output: BufReader::new(Box::new(read) as Reader),
                size,
                lines: Lines::default(),
            });
        }
        let mut command = tokio::process::Command::new(&target.binary);
        command.args([
            "terminal",
            "session",
            if size.is_some() { "control" } else { "observe" },
            terminal,
        ]);
        if let Some(size) = size {
            command.args([
                "--cols",
                &size.cols.to_string(),
                "--rows",
                &size.rows.to_string(),
            ]);
        }
        command
            .env_clear()
            .envs(&target.env)
            .env("HERDR_SOCKET_PATH", target.path()?)
            .env("HERDR_SESSION", "")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        Ok(Self {
            input: Box::new(child.stdin.take().unwrap()),
            output: BufReader::new(Box::new(child.stdout.take().unwrap()) as Reader),
            child: Some(child),
            size,
            lines: Lines::default(),
        })
    }
    async fn write(&mut self, message: &Value) -> Result<(), String> {
        tokio::time::timeout(
            Duration::from_secs(1),
            self.input.write_all(format!("{message}\n").as_bytes()),
        )
        .await
        .map_err(|_| "Herdr terminal input timed out.".to_owned())?
        .map_err(|e| e.to_string())
    }
    async fn close(mut self) {
        if self.size.is_some() {
            let _ = self.write(&json!({"type":"terminal.release"})).await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), self.input.shutdown()).await;
        drop(self.input);
        if let Some(mut child) = self.child {
            if tokio::time::timeout(Duration::from_secs(1), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        } else {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                tokio::io::copy(&mut self.output, &mut tokio::io::sink()),
            )
            .await;
        }
    }
}
fn broadcast(viewers: &mut Vec<Viewer>, message: Value) {
    viewers.retain(|viewer| match viewer.send.try_send(message.clone()) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            viewer.slow.cancel();
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    });
}
fn reset(viewers: &mut Vec<Viewer>, frame: &mut Option<Value>) {
    *frame = None;
    broadcast(
        viewers,
        json!({"type":"herdr-frame","width":0,"height":0,"full":true,"bytes":""}),
    );
}
fn desired(viewers: &[Viewer]) -> Option<Size> {
    viewers
        .iter()
        .filter(|v| v.size.is_some())
        .max_by_key(|v| v.order)
        .and_then(|v| v.size)
}
fn dimension(value: &Value) -> Option<u16> {
    value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (1.0..=1000.0).contains(n))
        .map(|n| n as u16)
}
async fn run(
    target: Target,
    terminal: String,
    mut receive: mpsc::Receiver<Command>,
    key: String,
    resources: Weak<Mutex<HashMap<String, Arc<Handle>>>>,
) {
    let mut viewers = Vec::<Viewer>::new();
    let mut running = None::<Running>;
    let mut frame = None::<Value>;
    let mut sequence = 0u64;
    let mut retry = tokio::time::Instant::now();
    let mut refresh = false;
    loop {
        let command = tokio::select! {
            biased;
            command=receive.recv()=>command,
            line=async {
                match &mut running {
                    Some(stream)=>stream.lines.read(&mut stream.output).await,
                    None=>std::future::pending().await,
                }
            }=>{
                match line {
                    Ok(Some(raw)) if raw["type"] != "terminal.closed"=>{
                        if raw["type"] == "terminal.frame" && raw["encoding"] == "ansi" {
                            if let (Some(width),Some(height),Some(bytes)) = (dimension(&raw["width"]), dimension(&raw["height"]),raw["bytes"].as_str()) {
                                let message=json!({"type":"herdr-frame","width":width,"height":height,"full":raw["full"]==true,"bytes":bytes});
                                frame=if raw["full"]==true { Some(message.clone()) } else { None };
                                broadcast(&mut viewers,message);
                                if !viewers.is_empty() { continue; }
                            } else {
                                if let Some(stream)=running.take(){stream.close().await;}
                                reset(&mut viewers,&mut frame);retry=tokio::time::Instant::now()+Duration::from_secs(2);
                                continue;
                            }
                        } else { continue; }
                    }
                    _=>{
                        if let Some(stream)=running.take(){stream.close().await;}
                        reset(&mut viewers,&mut frame);
                        if desired(&viewers).is_some(){broadcast(&mut viewers,json!({"type":"reading-error","message":"Cannot resize the Herdr terminal. Check that Herdr is available and no other terminal controller is attached."}));}
                        retry=tokio::time::Instant::now()+Duration::from_secs(2);
                        continue;
                    }
                }
                None
            },
            _=tokio::time::sleep_until(retry),if running.is_none()&&!viewers.is_empty()=>{
                match Running::open(&target,&terminal,desired(&viewers)).await {
                    Ok(stream)=>{running=Some(stream);refresh=false;},
                    Err(_)=>{
                        if desired(&viewers).is_some(){broadcast(&mut viewers,json!({"type":"reading-error","message":"Cannot resize the Herdr terminal. Check that Herdr is available and no other terminal controller is attached."}));}
                        retry=tokio::time::Instant::now()+Duration::from_secs(2);
                    }
                }
                continue;
            }
        };
        let Some(command) = command else {
            break;
        };
        match command {
            Command::Add(id, send, slow, size) => {
                // A new controller needs a complete baseline even when it joins
                // an already-sized stream whose last message was a delta.
                refresh |= size.is_some_and(|size| {
                    frame.as_ref().is_none_or(|frame| {
                        frame["width"] != size.cols || frame["height"] != size.rows
                    })
                });
                if let Some(frame) = &frame
                    && size.is_none_or(|size| {
                        frame["width"] == size.cols && frame["height"] == size.rows
                    })
                {
                    let _ = send.try_send(frame.clone());
                }
                sequence += 1;
                viewers.push(Viewer {
                    id,
                    send,
                    size,
                    order: sequence,
                    slow,
                });
            }
            Command::Remove(id) => viewers.retain(|v| v.id != id),
            Command::Resize(id, size) => {
                if let Some(viewer) = viewers.iter_mut().find(|v| v.id == id)
                    && viewer.size != size
                {
                    sequence += 1;
                    viewer.order = sequence;
                    viewer.size = size;
                }
            }
            Command::Refresh(id) => {
                if viewers.iter().any(|v| v.id == id && v.size.is_some()) {
                    refresh = true;
                }
            }
            Command::Scroll(id, lines, column, row, send) => {
                if running.is_none()
                    && desired(&viewers).is_some()
                    && retry <= tokio::time::Instant::now()
                {
                    running = Running::open(&target, &terminal, desired(&viewers))
                        .await
                        .ok();
                }
                let result = if !viewers.iter().any(|v| v.id == id && v.size.is_some()) {
                    Ok(())
                } else if let Some(stream) = running.as_mut()
                    && let Some(size) = stream.size
                {
                    let message = json!({"type":"terminal.scroll","source":"wheel","direction":if lines<0{"up"}else{"down"},"lines":1,"column":column.min(size.cols-1),"row":row.min(size.rows-1)});
                    let mut result = Ok(());
                    for _ in 0..lines.unsigned_abs() {
                        if let Err(error) = stream.write(&message).await {
                            result = Err(error);
                            break;
                        }
                    }
                    result
                } else {
                    Err("The Herdr terminal controller is not ready for scrolling.".into())
                };
                let _ = send.send(result);
            }
        }
        let size = desired(&viewers);
        if running
            .as_ref()
            .is_some_and(|s| viewers.is_empty() || size.is_some() != s.size.is_some())
        {
            let stream = running.take().unwrap();
            reset(&mut viewers, &mut frame);
            stream.close().await;
        }
        if viewers.is_empty() {
            if let Some(resources) = resources.upgrade() {
                let mut resources = resources.lock().unwrap();
                if receive.is_empty() {
                    resources.remove(&key);
                    break;
                }
            } else if receive.is_empty() {
                break;
            }
            continue;
        }
        if let Some(stream) = running.as_mut() {
            if let Some(size) = size
                && (refresh || Some(size) != stream.size)
            {
                if stream
                    .write(&json!({"type":"terminal.resize","cols":size.cols,"rows":size.rows}))
                    .await
                    .is_err()
                {
                    let stream = running.take().unwrap();
                    reset(&mut viewers, &mut frame);
                    stream.close().await;
                } else {
                    stream.size = Some(size);
                }
            }
        } else {
            retry = tokio::time::Instant::now();
        }
        refresh = false;
    }
    if let Some(stream) = running {
        stream.close().await;
    }
}
