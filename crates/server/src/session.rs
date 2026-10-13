use crate::{
    context,
    dictation::Recording,
    engine::NativeEngine,
    facts::{self, Facts},
    help::HelpProvider,
    history,
    host::{HostServices, NativeHost},
    markers::{Event, Markers},
    paste_mode::PasteMode,
    reading::{self, Captures},
    shell::local_bash,
    storage,
    transfers::Transfers,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use termai_engine::{Request, path, path_repair::directory_input, types::Catalog};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const RC: &str = include_str!("../assets/bashrc.sh");
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    pub cwd: String,
    pub input_revision: u64,
    pub prompt_revision: u64,
    pub ready: bool,
    pub prompt: u64,
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_target: Option<String>,
}
#[derive(Clone)]
pub enum Transport {
    Message(Value),
    Close(u16, String),
}
#[derive(Clone)]
struct Output {
    seq: u64,
    data: String,
    bytes: usize,
}
struct Attachment {
    id: u64,
    send: mpsc::UnboundedSender<Transport>,
}
#[derive(Clone)]
struct InputLine {
    id: String,
    prompt: u64,
    revision: u64,
    serial: u64,
}
struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    write: std::sync::mpsc::Sender<Vec<u8>>,
    kill: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    paused: Arc<(Mutex<bool>, Condvar)>,
}
pub(crate) trait ShellProcess: Send + Sync {
    fn write(&self, text: &str);
    fn pause(&self, paused: bool);
    fn resize(&self, cols: u16, rows: u16);
    fn kill(&self);
}
impl ShellProcess for Pty {
    fn write(&self, text: &str) {
        let _ = self.write.send(text.as_bytes().to_vec());
    }
    fn pause(&self, paused: bool) {
        *self.paused.0.lock().unwrap() = paused;
        self.paused.1.notify_all();
    }
    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().unwrap().resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    fn kill(&self) {
        self.pause(false);
        let _ = self.kill.lock().unwrap().kill();
    }
}
struct Inner {
    state: ShellState,
    pty: Option<Box<dyn ShellProcess>>,
    markers: Markers,
    paste: PasteMode,
    history: termai_engine::types::SharedList<String>,
    history_cwds: Arc<BTreeMap<String, String>>,
    history_cwd_order: VecDeque<String>,
    history_read_at: Option<Instant>,
    last_history: String,
    outputs: VecDeque<Output>,
    output_bytes: usize,
    seq: u64,
    truncated: bool,
    pending: VecDeque<Output>,
    outstanding: VecDeque<(u64, usize)>,
    outstanding_bytes: usize,
    sent_seq: u64,
    socket: Option<Attachment>,
    attachment: u64,
    detached: Instant,
    input_line: Option<InputLine>,
    input_serial: u64,
    captured: Option<Value>,
    captured_result: Option<Value>,
    facts: Facts,
    results: VecDeque<(String, Value)>,
    reading: Captures,
    transfers: Transfers,
    reading_queue: VecDeque<(String, String, u8)>,
    reading_running: bool,
    dictation: Option<(String, Recording)>,
    dictation_serial: u64,
    capture_cleanup: Arc<dyn Fn(String) + Send + Sync>,
}
pub struct Session {
    inner: Mutex<Inner>,
    pub stream_id: String,
    pub engine_mode: String,
    pub files_only: bool,
    pub directory: String,
    pub capture_flight: tokio::sync::Mutex<()>,
    pub plugin_files: tokio::sync::Mutex<crate::plugin_file::Cache>,
    pub remote: Option<Arc<crate::ssh::SSHHost>>,
    services: HostServices,
    help: HelpProvider,
    engine: NativeEngine,
    base_commands: termai_engine::types::SharedList<String>,
    lifetime: CancellationToken,
    prewarming: AtomicBool,
    shell_context: context::Cache,
}
pub(crate) enum ProcessEvent {
    Data(Vec<u8>),
    Closed,
    Exited(u32),
}
impl Inner {
    fn command_result(&self, id: &str) -> Option<Value> {
        self.results
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, v)| v.clone())
    }
    fn remember_command(&mut self, id: &str, result: Value) {
        self.results.push_back((id.into(), result));
        if self.results.len() > 1000 {
            self.results.pop_front();
        }
    }
    fn capture(&mut self, kind: &str, command: String) {
        if self.captured.is_none() {
            let id = storage::random_hex(16);
            self.captured = Some(json!({"id":id,"command":command,"kind":kind}));
            self.send(json!({"type":format!("{kind}-command"),"id":id,"command":command}));
        }
    }
    fn send(&self, value: Value) {
        if let Some(socket) = &self.socket {
            let _ = socket.send.send(Transport::Message(value));
        }
    }
    fn state(&self) {
        self.send(json!({"type":"state","state":self.state}));
    }
    fn flush(&mut self) {
        if self.socket.is_none() {
            return;
        }
        while !self.pending.is_empty() && self.outstanding_bytes < 128 * 1024 {
            let output = self.pending.pop_front().unwrap();
            self.send(json!({"type":"output","seq":output.seq,"data":output.data}));
            self.sent_seq = output.seq;
            self.outstanding.push_back((output.seq, output.bytes));
            self.outstanding_bytes += output.bytes;
        }
        if let Some(pty) = &self.pty {
            pty.pause(self.outstanding_bytes >= 128 * 1024 || !self.pending.is_empty());
        }
    }
    fn reject_input_line(&mut self) {
        if let Some(request) = self.input_line.take() {
            self.send(json!({"type":"input-line","id":request.id,"prompt":request.prompt,"revision":request.revision}));
        }
    }
    fn output(&mut self, data: &str, directory: &str) {
        self.paste.feed(data);
        let (visible, events) = self.markers.feed(data);
        static HISTORY_PREFIX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let history_prefix =
            HISTORY_PREFIX.get_or_init(|| regex::Regex::new(r"^\s*\d+\s+").unwrap());
        for event in events {
            match event {
                Event::Prompt { cwd, code, history } => {
                    self.reject_input_line();
                    let command_cwd = self.state.cwd.clone();
                    let had_prompt = self.state.prompt > 0;
                    self.state = ShellState {
                        cwd: if cwd.is_empty() {
                            self.state.cwd.clone()
                        } else {
                            cwd
                        },
                        input_revision: self.state.input_revision + 1,
                        prompt_revision: self.state.input_revision + 1,
                        ready: true,
                        prompt: self.state.prompt + 1,
                        exited: false,
                        exit_code: Some(code),
                        input_target: Some("shell".into()),
                    };
                    let line = history_prefix.replace(&history, "").trim_end().to_owned();
                    if had_prompt
                        && history != self.last_history
                        && !line.is_empty()
                        && !line.starts_with(char::is_whitespace)
                    {
                        self.history.push(line.clone());
                        if self.history.len() > 5000 {
                            self.history.remove(0);
                        }
                        if !self.history_cwds.contains_key(&line) {
                            self.history_cwd_order.push_back(line.clone());
                        }
                        Arc::make_mut(&mut self.history_cwds).insert(line, command_cwd);
                        if self.history_cwds.len() > 1000 {
                            let numeric = self
                                .history_cwds
                                .keys()
                                .filter_map(|key| {
                                    key.parse::<u32>()
                                        .ok()
                                        .filter(|n| *n != u32::MAX && n.to_string() == *key)
                                        .map(|n| (n, key.clone()))
                                })
                                .min_by_key(|(n, _)| *n);
                            let key = numeric
                                .map(|(_, key)| key)
                                .unwrap_or_else(|| self.history_cwd_order.front().unwrap().clone());
                            Arc::make_mut(&mut self.history_cwds).remove(&key);
                            self.history_cwd_order.retain(|old| *old != key);
                        }
                    }
                    self.last_history = history;
                    self.state();
                }
                Event::Busy => {
                    self.state.ready = false;
                    self.state.input_target = Some("program".into());
                    self.state();
                }
                Event::InputLine { text, cursor } => {
                    if let Some(request) = self.input_line.take() {
                        let mut reply = json!({"type":"input-line","id":request.id,"prompt":request.prompt,"revision":request.revision});
                        if self.state.ready
                            && !self.state.exited
                            && self.captured.is_none()
                            && request.prompt == self.state.prompt
                            && request.revision == self.state.input_revision
                        {
                            reply["text"] = json!(text);
                            reply["cursor"] = json!(cursor);
                        }
                        self.send(reply);
                    }
                }
                Event::Ssh { command } => self.capture("ssh", command),
                Event::Herdr { command } => self.capture("herdr", command),
                Event::ReadingFile { path } => {
                    self.send(json!({"type":"reading-file","path":path}))
                }
                Event::ReadingCapture {
                    file,
                    name,
                    exit_code,
                } => {
                    if self.reading_queue.len() + usize::from(self.reading_running) >= 16 {
                        (self.capture_cleanup)(path::join(&[directory, &file]));
                        self.send(json!({"type":"reading-error","message":"Too many outputs are waiting for Reading Mode."}));
                    } else {
                        self.reading_queue.push_back((file, name, exit_code));
                    }
                }
                event @ (Event::TransferUpload { .. }
                | Event::TransferDownload { .. }
                | Event::TransferCapture { .. }) => {
                    let request = self.transfers.add(event, directory);
                    self.send(json!({"type":"transfer","request":request}));
                }
            }
        }
        if visible.is_empty() {
            return;
        }
        self.seq += 1;
        let output = Output {
            seq: self.seq,
            bytes: visible.len(),
            data: visible,
        };
        self.output_bytes += output.bytes;
        self.outputs.push_back(output.clone());
        while self.outputs.len() > 1
            && (self.output_bytes > 2 * 1024 * 1024 || self.outputs.len() > 16384)
        {
            self.output_bytes -= self.outputs.pop_front().unwrap().bytes;
            self.truncated = true;
        }
        if self.socket.is_some() {
            self.pending.push_back(output);
            self.flush();
        }
    }
}
impl Session {
    pub async fn start(
        cwd: String,
        base_commands: Vec<String>,
        engine_mode: String,
        files_only: bool,
        services: HostServices,
    ) -> Result<Arc<Self>, String> {
        Self::start_host(cwd, base_commands, engine_mode, files_only, services, None).await
    }
    pub async fn start_remote(
        remote: Arc<crate::ssh::SSHHost>,
        engine_mode: String,
        files_only: bool,
        services: HostServices,
    ) -> Result<Arc<Self>, String> {
        Self::start_host(
            remote.cwd.clone(),
            vec![],
            engine_mode,
            files_only,
            services,
            Some(remote),
        )
        .await
    }
    async fn start_host(
        cwd: String,
        base_commands: Vec<String>,
        engine_mode: String,
        files_only: bool,
        services: HostServices,
        remote: Option<Arc<crate::ssh::SSHHost>>,
    ) -> Result<Arc<Self>, String> {
        let env: BTreeMap<_, _> = std::env::vars().collect();
        let nonce = storage::random_hex(12);
        let remote_channel = if let Some(remote) = &remote
            && !files_only
        {
            match remote
                .prepare_shell(RC, &nonce, &CancellationToken::new())
                .await
            {
                Ok(channel) => Some(channel),
                Err(error) => {
                    remote.dispose().await;
                    return Err(error);
                }
            }
        } else {
            None
        };
        let directory = if files_only {
            String::new()
        } else if let Some(remote) = &remote {
            remote.directory()
        } else {
            std::env::temp_dir()
                .join(format!("termai-{}", storage::random_hex(12)))
                .to_string_lossy()
                .into_owned()
        };
        let history = if files_only {
            vec![]
        } else if let Some(remote) = &remote {
            remote.history(&CancellationToken::new()).await
        } else {
            history::history_sources(&env).await
        };
        let capture_cleanup: Arc<dyn Fn(String) + Send + Sync> = if let Some(remote) = &remote {
            let remote = Arc::downgrade(remote);
            Arc::new(move |path| {
                if let Some(remote) = remote.upgrade()
                    && let Ok(runtime) = tokio::runtime::Handle::try_current()
                {
                    runtime.spawn(async move {
                        let _ = remote.files.remove_file(path).await;
                    });
                }
            })
        } else {
            Arc::new(|path| {
                let _ = std::fs::remove_file(path);
            })
        };
        let session = Arc::new(Self {
            stream_id: storage::random_hex(16),
            engine_mode,
            files_only,
            directory: directory.clone(),
            capture_flight: tokio::sync::Mutex::new(()),
            plugin_files: tokio::sync::Mutex::new(Default::default()),
            remote,
            help: HelpProvider::new(services.pool.clone()),
            engine: NativeEngine::new()?,
            services,
            base_commands: base_commands.into(),
            lifetime: CancellationToken::new(),
            prewarming: AtomicBool::new(false),
            shell_context: context::Cache::default(),
            inner: Mutex::new(Inner {
                state: ShellState {
                    cwd: cwd.clone(),
                    input_revision: 0,
                    prompt_revision: 0,
                    ready: files_only,
                    prompt: 0,
                    exited: false,
                    exit_code: None,
                    input_target: None,
                },
                pty: None,
                markers: Markers::new(&nonce),
                paste: PasteMode::default(),
                history: history.into(),
                history_cwds: Arc::default(),
                history_cwd_order: VecDeque::new(),
                history_read_at: None,
                last_history: String::new(),
                outputs: VecDeque::new(),
                output_bytes: 0,
                seq: 0,
                truncated: false,
                pending: VecDeque::new(),
                outstanding: VecDeque::new(),
                outstanding_bytes: 0,
                sent_seq: 0,
                socket: None,
                attachment: 0,
                detached: Instant::now(),
                input_line: None,
                input_serial: 0,
                captured: None,
                captured_result: None,
                facts: Facts::default(),
                results: VecDeque::new(),
                reading: Captures::default(),
                transfers: Transfers::new(capture_cleanup.clone()),
                reading_queue: VecDeque::new(),
                reading_running: false,
                dictation: None,
                dictation_serial: 0,
                capture_cleanup,
            }),
        });
        if files_only {
            return Ok(session);
        }
        if let Some(channel) = remote_channel {
            let (pty, receiver) = crate::ssh_pty::RemotePty::start(channel);
            session.inner.lock().unwrap().pty = Some(Box::new(pty));
            Self::watch_process(&session, receiver);
            return Ok(session);
        }
        storage::private_directory(std::path::Path::new(&directory)).map_err(|e| e.to_string())?;
        let rc = path::join(&[&directory, "bashrc"]);
        storage::create_private(std::path::Path::new(&rc), RC.as_bytes())
            .map_err(|e| e.to_string())?;
        let history_source = history::readline_history_source(&env).await;
        let mut command = CommandBuilder::new(local_bash(&env)?);
        command.args(["--noprofile", "--rcfile", &rc, "-i"]);
        command.cwd(&cwd);
        for (key, value) in &env {
            command.env(key, value);
        }
        for (key, value) in [
            ("TERM", "xterm-256color".into()),
            ("COLORTERM", "truecolor".into()),
            ("TERMAI_TRANSFER_DIR", directory.clone()),
            ("TERMAI_CAPTURE_SSH", "1".into()),
            ("TERMAI_READING_DIR", directory.clone()),
            ("TERMAI_NONCE", nonce),
            ("TERMAI_HISTORY_SOURCE", history_source),
        ] {
            command.env(key, value);
        }
        for (key, name) in [
            ("TERMAI_ENV_FILE", "environment"),
            ("TERMAI_COMMANDS_FILE", "commands"),
            ("TERMAI_FUNCTIONS_FILE", "functions"),
            ("TERMAI_COMPLETIONS_FILE", "completions"),
        ] {
            command.env(key, path::join(&[&directory, name]));
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        let kill = child.clone_killer();
        let handles = (|| {
            Ok::<_, String>((
                pair.master.try_clone_reader().map_err(|e| e.to_string())?,
                pair.master.take_writer().map_err(|e| e.to_string())?,
            ))
        })();
        let (mut reader, mut writer) = match handles {
            Ok(handles) => handles,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let (write, input) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(data) = input.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
        });
        let paused = Arc::new((Mutex::new(false), Condvar::new()));
        session.inner.lock().unwrap().pty = Some(Box::new(Pty {
            master: Mutex::new(pair.master),
            write,
            kill: Mutex::new(kill),
            paused: paused.clone(),
        }));
        let (sender, receiver) = mpsc::channel(128);
        let output = sender.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16384];
            loop {
                let mut pause = paused.0.lock().unwrap();
                while *pause {
                    pause = paused.1.wait(pause).unwrap();
                }
                drop(pause);
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if output
                            .blocking_send(ProcessEvent::Data(buffer[..size].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = output.blocking_send(ProcessEvent::Closed);
        });
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            let _ = sender.blocking_send(ProcessEvent::Exited(code));
        });
        Self::watch_process(&session, receiver);
        Ok(session)
    }
    fn watch_process(session: &Arc<Self>, mut receiver: mpsc::Receiver<ProcessEvent>) {
        let weak = Arc::downgrade(session);
        tokio::spawn(async move {
            let mut bytes = Vec::new();
            let mut closed = false;
            let mut exit = None;
            while let Some(event) = receiver.recv().await {
                let Some(session) = weak.upgrade() else {
                    break;
                };
                let mut inner = session.inner.lock().unwrap();
                let before = inner.state.prompt;
                match event {
                    ProcessEvent::Data(data) => {
                        bytes.extend(data);
                        loop {
                            match std::str::from_utf8(&bytes) {
                                Ok(text) => {
                                    inner.output(text, &session.directory);
                                    bytes.clear();
                                    break;
                                }
                                Err(error) => {
                                    if error.valid_up_to() > 0 {
                                        let text =
                                            String::from_utf8_lossy(&bytes[..error.valid_up_to()]);
                                        inner.output(&text, &session.directory);
                                        bytes.drain(..error.valid_up_to());
                                    }
                                    if let Some(length) = error.error_len() {
                                        inner.output("\u{fffd}", &session.directory);
                                        bytes.drain(..length);
                                    } else {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    ProcessEvent::Closed => {
                        if !bytes.is_empty() {
                            inner.output(&String::from_utf8_lossy(&bytes), &session.directory);
                            bytes.clear();
                        }
                        closed = true;
                    }
                    ProcessEvent::Exited(code) => exit = Some(code),
                }
                if closed && let Some(code) = exit {
                    inner.state.exited = true;
                    inner.state.ready = false;
                    inner.state.input_target = None;
                    inner.state.exit_code = Some(code as f64);
                    inner.state();
                }
                let prompt = inner.state.prompt;
                drop(inner);
                session.schedule_reading();
                if prompt != before {
                    session.schedule_prewarm();
                }
                if closed && exit.is_some() {
                    break;
                }
            }
        });
        let weak = Arc::downgrade(session);
        let lifetime = session.lifetime.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {biased;_=lifetime.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(2))=>{}}
                let Some(session) = weak.upgrade() else {
                    break;
                };
                session.inner.lock().unwrap().transfers.expire();
            }
        });
    }
    pub fn state(&self) -> ShellState {
        self.inner.lock().unwrap().state.clone()
    }
    pub fn filesystem(&self) -> crate::filesystem::FileSystem {
        crate::filesystem::FileSystem {
            remote: self.remote.clone(),
        }
    }
    pub fn home(&self) -> String {
        self.remote
            .as_ref()
            .map(|h| h.home.clone())
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default())
    }
    pub fn expired(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.socket.is_none() && inner.detached.elapsed() >= Duration::from_secs(3600)
    }
    pub fn mark_expired(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        if inner.socket.is_none() && inner.detached.elapsed() >= Duration::from_secs(3600) {
            self.lifetime.cancel();
            true
        } else {
            false
        }
    }
    pub fn attach(
        self: &Arc<Self>,
        after: u64,
        stream: Option<&str>,
    ) -> (u64, mpsc::UnboundedReceiver<Transport>) {
        let (send, receive) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().unwrap();
        if self.lifetime.is_cancelled() {
            let _ = send.send(Transport::Close(1000, "Session ended".into()));
            return (0, receive);
        }
        inner.dictation.take();
        if let Some(old) = inner.socket.take() {
            let _ = old.send.send(Transport::Close(
                4001,
                "This shell was opened in another tab.".into(),
            ));
        }
        inner.attachment += 1;
        let id = inner.attachment;
        inner.socket = Some(Attachment { id, send });
        inner.outstanding.clear();
        inner.outstanding_bytes = 0;
        inner.sent_seq = 0;
        let first = inner.outputs.front().map_or(1, |o| o.seq);
        let changed = stream.is_some_and(|s| !s.is_empty() && s != self.stream_id);
        let gap = changed || after > inner.seq || (after > 0 && after < first - 1);
        inner.send(json!({"type":"hello","streamId":self.stream_id,"engine":self.engine_mode,"reset":after==0||gap,"truncated":((after==0||changed)&&inner.truncated)||(gap&&!changed),"firstSeq":first}));
        inner.pending = inner
            .outputs
            .iter()
            .filter(|o| o.seq > if gap { 0 } else { after })
            .cloned()
            .collect();
        inner.state();
        inner.flush();
        for capture in inner.reading.pending() {
            let mut message = capture;
            message["type"] = json!("reading-capture");
            inner.send(message);
        }
        for request in inner.transfers.pending() {
            inner.send(json!({"type":"transfer","request":request}));
        }
        if let Some(capture) = inner.captured.as_ref().or(inner
            .captured_result
            .as_ref()
            .filter(|r| r["acknowledged"] != true))
        {
            inner.send(json!({"type":format!("{}-command",capture["kind"].as_str().unwrap_or("ssh")),"id":capture["id"],"command":capture["command"]}));
        }
        drop(inner);
        (id, receive)
    }
    pub fn detach(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.socket.as_ref().is_none_or(|socket| socket.id != id) {
            return;
        }
        inner.socket = None;
        inner.dictation.take();
        inner.detached = Instant::now();
        inner.pending.clear();
        inner.outstanding.clear();
        inner.outstanding_bytes = 0;
        if let Some(pty) = &inner.pty {
            pty.pause(false);
        }
    }
    pub fn reading_capture(&self, id: &str) -> Option<reading::Capture> {
        self.inner.lock().unwrap().reading.get(id)
    }
    pub async fn read_file(&self, cwd: &str, input: &str) -> crate::files::Result<reading::File> {
        if let Some(remote) = &self.remote {
            remote.read_for_viewing(cwd, input, &self.lifetime).await
        } else {
            reading::read(cwd, &std::env::var("HOME").unwrap_or_default(), input).await
        }
    }
    pub fn captured(&self) -> Option<Value> {
        self.inner.lock().unwrap().captured.clone()
    }
    pub fn capture_result(&self, id: &str) -> Option<Value> {
        self.inner
            .lock()
            .unwrap()
            .captured_result
            .as_ref()
            .filter(|r| r["id"] == id)
            .and_then(|r| r.get("value"))
            .cloned()
    }
    pub fn acknowledge_capture(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(result) = inner.captured_result.as_mut().filter(|r| r["id"] == id) {
            result["acknowledged"] = json!(true);
        }
        inner.send(json!({"type":"ssh-released","id":id}));
    }
    pub fn release_capture(
        &self,
        id: &str,
        native: bool,
        value: Option<Value>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let capture = inner
            .captured
            .as_ref()
            .filter(|r| r["id"] == id)
            .cloned()
            .ok_or("This connection request is no longer active.")?;
        inner.captured = None;
        if let Some(value) = value {
            let mut result = capture.clone();
            result["value"] = value;
            result["acknowledged"] = json!(false);
            inner.captured_result = Some(result);
        }
        inner.send(json!({"type":"ssh-released","id":id}));
        if native && let Some(pty) = &inner.pty {
            pty.write(&format!(
                "\x07\x05\x15\x1b[200~{}\x1b[201~\n",
                capture["command"].as_str().unwrap_or("")
            ));
        }
        Ok(())
    }
    pub async fn environment(&self) -> BTreeMap<String, String> {
        if let Some(remote) = &self.remote {
            return remote
                .context(self.state().prompt, &self.lifetime)
                .await
                .map(|c| c.environment.as_ref().clone())
                .unwrap_or_default();
        }
        self.shell_context
            .get(&self.directory, self.state().prompt)
            .await
            .environment
            .as_ref()
            .clone()
    }
    pub fn remove_reading_capture(&self, id: &str) {
        self.inner.lock().unwrap().reading.remove(id);
    }
    pub fn transfer(&self, id: &str) -> Option<crate::transfers::Request> {
        self.inner.lock().unwrap().transfers.get(id)
    }
    pub fn acknowledge_transfer(&self, id: &str) {
        self.inner.lock().unwrap().transfers.acknowledge(id);
    }
    pub fn remove_transfer(&self, id: &str) {
        self.inner.lock().unwrap().transfers.remove(id);
    }
    pub fn paste(
        &self,
        text: &str,
        prompt: u64,
        revision: u64,
        replace: bool,
        source: Option<&str>,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.state.ready
            || inner.state.exited
            || inner.captured.is_some()
            || inner.state.prompt != prompt
            || inner.state.input_revision != revision
            || text.is_empty()
            || text.encode_utf16().count() > 16000
            || text
                .chars()
                .any(|c| c < '\x20' || ('\x7f'..='\u{9f}').contains(&c))
        {
            return false;
        }
        inner.state.input_revision += 1;
        if let Some(pty) = &inner.pty {
            pty.write(&format!(
                "{}\x1b[200~{text}\x1b[201~",
                if replace { "\x07\x05\x15" } else { "" }
            ));
        }
        let mut message = json!({"type":"pasted","text":text,"replace":replace,"prompt":inner.state.prompt,"revision":inner.state.input_revision});
        if let Some(source) = source {
            message["source"] = json!(source);
        }
        inner.send(message);
        true
    }
    fn schedule_reading(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.reading_running
                || inner.reading_queue.is_empty()
                || self.lifetime.is_cancelled()
            {
                return;
            }
            inner.reading_running = true;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(session) = weak.upgrade() else { break };
                let job = {
                    let mut inner = session.inner.lock().unwrap();
                    match inner.reading_queue.pop_front() {
                        Some(job) => job,
                        None => {
                            inner.reading_running = false;
                            break;
                        }
                    }
                };
                let (file, name, code) = job;
                let absolute = path::join(&[&session.directory, &file]);
                let cwd = session.state().cwd;
                let result = tokio::select! { biased;_=session.lifetime.cancelled()=>None,result=session.read_file(&cwd,&absolute)=>Some(result)};
                (session.inner.lock().unwrap().capture_cleanup)(absolute);
                let mut inner = session.inner.lock().unwrap();
                if session.lifetime.is_cancelled() {
                    inner.reading_running = false;
                    break;
                }
                let result = result
                    .unwrap()
                    .and_then(|file| inner.reading.add(&name, file.data, code));
                match result {
                    Ok(mut capture) => {
                        capture["type"] = json!("reading-capture");
                        inner.send(capture);
                    }
                    Err(error) => {
                        inner.send(json!({"type":"reading-error","message":error.message}))
                    }
                }
            }
        });
    }
    pub fn receive(self: &Arc<Self>, attachment: u64, message: Value) {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .socket
            .as_ref()
            .is_none_or(|socket| socket.id != attachment)
        {
            return;
        }
        let number = |key: &str| {
            message[key]
                .as_f64()
                .filter(|n| {
                    n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9007199254740991.0
                })
                .map(|n| n as u64)
        };
        let same = inner.state.ready
            && !inner.state.exited
            && inner.captured.is_none()
            && number("prompt") == Some(inner.state.prompt);
        match message["type"].as_str() {
            Some("dictation") => {
                let Some(id) = message["id"].as_str().filter(|id| {
                    id.len() == 36
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
                }) else {
                    return;
                };
                if message["action"] == "cancel"
                    && inner
                        .dictation
                        .as_ref()
                        .is_some_and(|(current, _)| current == id)
                {
                    inner.dictation.take();
                } else if message["action"] == "finish"
                    && inner
                        .dictation
                        .as_ref()
                        .is_some_and(|(current, _)| current == id)
                {
                    inner.dictation.as_ref().unwrap().1.finish();
                } else if message["action"] == "start"
                    && inner
                        .dictation
                        .as_ref()
                        .is_none_or(|(_, recording)| recording.done())
                {
                    let target = if inner.state.exited {
                        None
                    } else if inner.state.ready {
                        Some("shell")
                    } else if inner.state.input_target.as_deref() == Some("program") {
                        Some("program")
                    } else {
                        None
                    };
                    if target.is_none()
                        || inner.captured.is_some()
                        || number("prompt") != Some(inner.state.prompt)
                        || number("revision") != Some(inner.state.input_revision)
                        || dictation_target(&message["target"]) != target
                    {
                        inner.send(json!({"type":"dictation","id":id,"state":"error","message":if target.is_some()&&inner.captured.is_none(){"Terminal input changed. Try dictating again."}else{"Wait for terminal input before dictating."}}));
                        return;
                    }
                    let target = target.unwrap().to_owned();
                    let prompt = inner.state.prompt;
                    let revision = inner.state.input_revision;
                    inner.dictation_serial += 1;
                    let serial = inner.dictation_serial;
                    let weak = Arc::downgrade(self);
                    let result = Arc::new(move |text: String| {
                        let Some(session) = weak.upgrade() else {
                            return Err(
                                "The terminal changed during dictation. No text was inserted."
                                    .into(),
                            );
                        };
                        if text.is_empty()
                            || session.paste_dictation(
                                &text, prompt, revision, &target, attachment, serial,
                            )
                        {
                            Ok(())
                        } else {
                            Err(
                                "The terminal changed during dictation. No text was inserted."
                                    .into(),
                            )
                        }
                    });
                    let weak = Arc::downgrade(self);
                    let recording_id = id.to_owned();
                    let status = Arc::new(move |state: &str, message: Option<String>| {
                        if let Some(session) = weak.upgrade() {
                            let mut inner = session.inner.lock().unwrap();
                            if inner.socket.as_ref().is_none_or(|s| s.id != attachment)
                                || inner.dictation_serial != serial
                                || inner.dictation.is_none()
                            {
                                return;
                            }
                            if state != "ready" {
                                inner.dictation.take();
                            }
                            let mut value =
                                json!({"type":"dictation","id":recording_id,"state":state});
                            if let Some(message) = message {
                                value["message"] = json!(message);
                            }
                            inner.send(value);
                        }
                    });
                    inner.dictation = Some((
                        id.into(),
                        Recording::start(std::env::vars().collect(), result, status),
                    ));
                }
            }
            Some("ack") => {
                if let Some(seq) = number("seq").filter(|seq| *seq <= inner.sent_seq) {
                    while inner.outstanding.front().is_some_and(|(at, _)| *at <= seq) {
                        inner.outstanding_bytes -= inner.outstanding.pop_front().unwrap().1;
                    }
                    inner.flush();
                }
            }
            Some("resize") => {
                if let (Some(cols), Some(rows)) = (
                    message["cols"].as_f64().filter(|n| n.fract() == 0.0),
                    message["rows"].as_f64().filter(|n| n.fract() == 0.0),
                ) && !inner.state.exited
                    && let Some(pty) = &inner.pty
                {
                    pty.resize(cols.clamp(2.0, 300.0) as u16, rows.clamp(2.0, 120.0) as u16);
                }
            }
            Some("input") => {
                if let Some(data) = message["data"]
                    .as_str()
                    .filter(|s| s.encode_utf16().count() <= 65536)
                    && !inner.state.exited
                    && inner.captured.is_none()
                {
                    inner.state.input_revision += 1;
                    if data.contains(['\r', '\n', '\x03']) {
                        if inner.state.ready {
                            inner.state.input_target = None;
                        }
                        inner.state.ready = false;
                        inner.state();
                    }
                    if let Some(pty) = &inner.pty {
                        pty.write(data);
                    }
                }
            }
            Some("replace") => {
                if let (Some(text), Some(id)) = (message["text"].as_str(), message["id"].as_str()) {
                    let accepted = id.encode_utf16().count() <= 100
                        && same
                        && number("revision") == Some(inner.state.input_revision)
                        && text.encode_utf16().count() <= 4000
                        && !control(text);
                    if accepted {
                        inner.state.input_revision += 1;
                        if let Some(pty) = &inner.pty {
                            pty.write(&format!("\x07\x05\x15\x1b[200~{text}\x1b[201~"));
                        }
                        if text.is_empty() {
                            inner.state.prompt_revision = inner.state.input_revision;
                            inner.state();
                        }
                    }
                    inner.send(json!({"type":"edit-result","id":id,"accepted":accepted,"revision":inner.state.input_revision}));
                }
            }
            Some("command") => {
                if let (Some(command), Some(id)) =
                    (message["command"].as_str(), message["id"].as_str())
                {
                    if id.encode_utf16().count() > 100 {
                        return;
                    }
                    // Results are retained separately from output replay.
                    if let Some(previous) = inner.command_result(id) {
                        inner.send(previous);
                        return;
                    }
                    let accepted = same
                        && !command.is_empty()
                        && command.encode_utf16().count() <= 4000
                        && !control(command);
                    let mut result = json!({"type":"result","id":id,"accepted":accepted});
                    if !accepted {
                        result["message"] = json!(
                            "The shell is not at the same prompt. Review the command and try again."
                        );
                    }
                    inner.remember_command(id, result.clone());
                    if accepted {
                        inner.state.input_revision += 1;
                        inner.state.ready = false;
                        inner.state.input_target = None;
                        inner.state();
                        if let Some(pty) = &inner.pty {
                            pty.write(&format!("\x07\x05\x15\x1b[200~{command}\x1b[201~\r"));
                        }
                    }
                    inner.send(result);
                }
            }
            Some("input-line") => {
                if let Some(id) = message["id"]
                    .as_str()
                    .filter(|s| s.encode_utf16().count() <= 100)
                {
                    if !same
                        || inner.input_line.is_some()
                        || number("revision") != Some(inner.state.input_revision)
                    {
                        inner.send(json!({"type":"input-line","id":id,"prompt":message["prompt"],"revision":message["revision"]}));
                        return;
                    }
                    inner.input_serial += 1;
                    let serial = inner.input_serial;
                    inner.input_line = Some(InputLine {
                        id: id.into(),
                        prompt: inner.state.prompt,
                        revision: inner.state.input_revision,
                        serial,
                    });
                    if let Some(pty) = &inner.pty {
                        pty.write("\x18\x12");
                    }
                    let weak = Arc::downgrade(self);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        if let Some(session) = weak.upgrade() {
                            let mut inner = session.inner.lock().unwrap();
                            if inner
                                .input_line
                                .as_ref()
                                .is_some_and(|r| r.serial == serial)
                            {
                                inner.reject_input_line();
                            }
                        }
                    });
                }
            }
            _ => {}
        }
    }
    pub async fn snapshot(
        &self,
        include_paths: bool,
    ) -> Result<(Catalog, Arc<BTreeMap<String, String>>, u64), String> {
        let state = self.state();
        let shell = if let Some(remote) = &self.remote {
            remote.context(state.prompt, &self.lifetime).await?
        } else {
            self.shell_context.get(&self.directory, state.prompt).await
        };
        let refresh = {
            let mut inner = self.inner.lock().unwrap();
            if self.remote.is_none()
                && !self.files_only
                && inner
                    .history_read_at
                    .is_none_or(|at| at.elapsed() > Duration::from_secs(10))
            {
                inner.history_read_at = Some(Instant::now());
                true
            } else {
                false
            }
        };
        let external = if refresh {
            Some(history::history_sources(&shell.environment).await)
        } else {
            None
        };
        let paths = if include_paths && let Some(remote) = &self.remote {
            remote.paths(&state.cwd, &self.lifetime).await?.into()
        } else if include_paths {
            self.services
                .catalog
                .paths_in(&state.cwd, &self.lifetime)
                .await?
        } else {
            Default::default()
        };
        let mut inner = self.inner.lock().unwrap();
        if inner.state.prompt != state.prompt || inner.state.cwd != state.cwd {
            return Err("Shell context changed. Try again.".into());
        }
        if let Some(mut external) = external {
            external.extend(inner.history.iter().cloned());
            let mut seen = std::collections::HashSet::new();
            let mut history = external
                .into_iter()
                .rev()
                .filter(|line| seen.insert(line.clone()))
                .take(5000)
                .collect::<Vec<_>>();
            history.reverse();
            inner.history = history.into();
        }
        Ok((
            Catalog {
                cwd: state.cwd,
                commands: if shell.commands.is_empty() {
                    self.base_commands.clone()
                } else {
                    shell.commands.clone().into()
                },
                functions: Some(shell.functions.clone().into()),
                paths,
                history: inner.history.clone(),
                history_cwds: Some(inner.history_cwds.clone()),
            },
            shell.environment.clone(),
            state.prompt,
        ))
    }
    pub fn receive_binary(&self, attachment: u64, bytes: Vec<u8>) {
        let inner = self.inner.lock().unwrap();
        if inner.socket.as_ref().is_some_and(|s| s.id == attachment)
            && let Some((_, recording)) = &inner.dictation
        {
            recording.audio(bytes);
        }
    }
    fn paste_dictation(
        &self,
        text: &str,
        prompt: u64,
        revision: u64,
        target: &str,
        attachment: u64,
        serial: u64,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let actual = if inner.state.exited {
            None
        } else if inner.state.ready {
            Some("shell")
        } else if inner.state.input_target.as_deref() == Some("program") {
            Some("program")
        } else {
            None
        };
        if actual != Some(target)
            || inner.socket.as_ref().is_none_or(|s| s.id != attachment)
            || inner.dictation_serial != serial
            || inner.dictation.is_none()
            || inner.captured.is_some()
            || inner.state.prompt != prompt
            || inner.state.input_revision != revision
            || text.is_empty()
            || text.encode_utf16().count() > 16000
            || text
                .chars()
                .any(|c| c < '\x20' || ('\x7f'..='\u{9f}').contains(&c))
        {
            return false;
        }
        inner.state.input_revision += 1;
        if let Some(pty) = &inner.pty {
            pty.write(&if target == "shell" {
                format!("\x1b[200~{text}\x1b[201~")
            } else {
                inner.paste.paste(text)
            });
        }
        inner.send(json!({"type":"pasted","text":text,"replace":false,"source":"dictation","prompt":prompt,"revision":inner.state.input_revision}));
        true
    }
    pub async fn context(&self, known: Option<&str>, include_paths: bool) -> Result<Value, String> {
        let (catalog, env, prompt) = self.snapshot(include_paths).await?;
        Ok(self
            .inner
            .lock()
            .unwrap()
            .facts
            .context(prompt, catalog, &env, known, include_paths))
    }
    pub async fn read_facts(
        &self,
        key: &str,
        operations: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        let operations = facts::validate(operations)?;
        let (catalog, env, prompt) = self.snapshot(false).await?;
        if facts::context_key(prompt, &catalog, &env) != key {
            return Err("Shell context changed. Try again.".into());
        }
        let mut host = NativeHost::new(
            self.services.clone(),
            catalog.clone(),
            env,
            self.help.clone(),
        );
        host.remote = self.remote.clone();
        let values = facts::read(&host, operations, cancel).await?;
        let state = self.state();
        if state.prompt != prompt || state.cwd != catalog.cwd || state.exited {
            return Err("Shell context changed. Try again.".into());
        }
        Ok(json!(values))
    }
    pub async fn suggest(&self, text: &str, cancel: &CancellationToken) -> Result<Value, String> {
        let (catalog, env, prompt) = self.snapshot(false).await?;
        let key = facts::context_key(prompt, &catalog, &env);
        let mut host = NativeHost::new(
            self.services.clone(),
            catalog.clone(),
            env.clone(),
            self.help.clone(),
        );
        host.remote = self.remote.clone();
        let mut candidates = None;
        for _ in 0..3 {
            host.verify_listings();
            let result = self.engine.suggest(text, &host, cancel).await?;
            if host.listings_unchanged(cancel).await? {
                candidates = Some(result);
                break;
            }
        }
        let candidates = candidates.ok_or("Directory changed. Try again.")?;
        let (latest, latest_env, latest_prompt) = self.snapshot(false).await?;
        if facts::context_key(latest_prompt, &latest, &latest_env) != key
            || !self.state().ready
            || self.state().exited
        {
            return Err("Shell context changed. Try again.".into());
        }
        Ok(
            json!({"candidates":candidates,"source":"Commands, paths, history & syntax checks","cwd":catalog.cwd}),
        )
    }
    pub async fn repair(
        &self,
        key: &str,
        catalog_key: &str,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        if text.encode_utf16().count() > 2000 {
            return Err("Keep a command under 2,000 characters.".into());
        }
        let (current, env, prompt) = self.snapshot(false).await?;
        if facts::context_key(prompt, &current, &env) != key {
            return Err("Shell context changed. Try again.".into());
        }
        let mut catalog = self
            .inner
            .lock()
            .unwrap()
            .facts
            .repair_catalog(key, catalog_key)
            .ok_or("Shell context changed. Try again.")?;
        if catalog.paths.is_empty() && directory_input(text).is_none() {
            let (rich, rich_env, rich_prompt) = self.snapshot(true).await?;
            if rich_prompt != prompt || facts::context_key(rich_prompt, &rich, &rich_env) != key {
                return Err("Shell context changed. Try again.".into());
            }
            catalog.paths = rich.paths;
        }
        let mut host = NativeHost::new(
            self.services.clone(),
            catalog.clone(),
            env.clone(),
            self.help.clone(),
        );
        host.remote = self.remote.clone();
        let mut candidates = None;
        for _ in 0..3 {
            host.verify_listings();
            let value = self.engine.suggest(text, &host, cancel).await?;
            if host.listings_unchanged(cancel).await? {
                candidates = Some(value);
                break;
            }
        }
        let candidates = candidates.ok_or("Directory changed. Try again.")?;
        let (latest, latest_env, latest_prompt) = self.snapshot(false).await?;
        if latest_prompt != prompt
            || latest.cwd != catalog.cwd
            || self.state().exited
            || facts::context_key(latest_prompt, &latest, &latest_env) != key
        {
            return Err("Shell context changed. Try again.".into());
        }
        Ok(candidates)
    }
    fn schedule_prewarm(self: &Arc<Self>) {
        if self.lifetime.is_cancelled() || self.prewarming.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let Some(session) = weak.upgrade() else {
                return;
            };
            struct Warming(Arc<Session>);
            impl Drop for Warming {
                fn drop(&mut self) {
                    self.0.prewarming.store(false, Ordering::SeqCst);
                }
            }
            let _warming = Warming(session.clone());
            let Ok((catalog, env, _)) = session.snapshot(false).await else {
                return;
            };
            if !session.state().ready || session.state().exited {
                return;
            }
            let mut host = NativeHost::new(
                session.services.clone(),
                catalog.clone(),
                env.clone(),
                session.help.clone(),
            );
            host.remote = session.remote.clone();
            let Ok(targets) = session
                .engine
                .invoke(
                    Request {
                        operation: "prewarmTargets".into(),
                        args: vec![json!(catalog), json!(env)],
                    },
                    &host,
                    &session.lifetime,
                )
                .await
            else {
                return;
            };
            for target in targets
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if session.lifetime.is_cancelled()
                    || session
                        .remote
                        .as_ref()
                        .map_or_else(|| session.services.pool.busy(), |h| h.pool.busy())
                {
                    break;
                }
                let cancel = session.lifetime.child_token();
                let deadline = tokio::time::timeout(
                    Duration::from_secs(4),
                    session.engine.invoke(
                        Request {
                            operation: "discover".into(),
                            args: vec![json!(target), json!(catalog), json!(env)],
                        },
                        &host,
                        &cancel,
                    ),
                )
                .await;
                cancel.cancel();
                if !matches!(deadline, Ok(Ok(_))) {
                    break;
                }
                if session
                    .engine
                    .invoke(
                        Request {
                            operation: "markWarmed".into(),
                            args: vec![json!(target), json!(catalog), json!(env)],
                        },
                        &host,
                        &session.lifetime,
                    )
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::select! {biased;_=session.lifetime.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(20))=>{}}
            }
        });
    }
    pub async fn dispose(&self) {
        self.lifetime.cancel();
        self.help.dispose();
        let _ = self.engine.reset();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.reject_input_line();
            inner.reading.clear();
            inner.transfers.clear();
            inner.reading_queue.clear();
            inner.dictation.take();
            if let Some(socket) = inner.socket.take() {
                let _ = socket
                    .send
                    .send(Transport::Close(1000, "Session ended".into()));
            }
            if let Some(pty) = inner.pty.take() {
                pty.kill();
            }
        }
        if let Some(remote) = &self.remote {
            remote.dispose().await;
        } else if !self.directory.is_empty() {
            let _ = tokio::fs::remove_dir_all(&self.directory).await;
        }
    }
}
fn control(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
fn dictation_target(value: &Value) -> Option<&str> {
    match value {
        Value::Null | Value::Bool(false) => Some("shell"),
        Value::Number(number) if number.as_f64() == Some(0.0) => Some("shell"),
        Value::String(text) if text.is_empty() => Some("shell"),
        Value::String(text) => Some(text),
        _ => None,
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.lifetime.cancel();
        self.help.dispose();
        if let Ok(inner) = self.inner.get_mut()
            && let Some(pty) = inner.pty.take()
        {
            pty.kill();
        }
        if let Some(remote) = self.remote.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    remote.dispose().await;
                });
            }
        } else if !self.directory.is_empty() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone, Default)]
    struct Stub {
        writes: Arc<Mutex<Vec<String>>>,
        paused: Arc<AtomicBool>,
    }
    impl ShellProcess for Stub {
        fn write(&self, text: &str) {
            self.writes.lock().unwrap().push(text.into());
        }
        fn pause(&self, paused: bool) {
            self.paused.store(paused, Ordering::SeqCst);
        }
        fn resize(&self, _: u16, _: u16) {}
        fn kill(&self) {}
    }
    async fn fixture() -> (Arc<Session>, Stub, u64, mpsc::UnboundedReceiver<Transport>) {
        let session = Session::start(
            "/tmp".into(),
            vec![],
            "client".into(),
            true,
            HostServices::new(),
        )
        .await
        .unwrap();
        let stub = Stub::default();
        {
            let mut inner = session.inner.lock().unwrap();
            inner.pty = Some(Box::new(stub.clone()));
            inner.state.prompt = 1;
        }
        let (attachment, mut receive) = session.attach(0, None);
        while receive.try_recv().is_ok() {}
        (session, stub, attachment, receive)
    }
    #[tokio::test]
    async fn output_window_preserves_all_duplicate_partial_and_invalid_acknowledgements() {
        let (session, stub, attachment, mut receive) = fixture().await;
        {
            let mut inner = session.inner.lock().unwrap();
            inner.seq = 100;
            inner.pending = (1..=100)
                .map(|seq| Output {
                    seq,
                    data: "x".repeat(4096),
                    bytes: 4096,
                })
                .collect();
            inner.flush();
        }
        let mut sent = Vec::new();
        let mut collect = |receive: &mut mpsc::UnboundedReceiver<Transport>| {
            while let Ok(Transport::Message(value)) = receive.try_recv() {
                if value["type"] == "output" {
                    sent.push(value["seq"].as_u64().unwrap());
                }
            }
            sent.len()
        };
        assert_eq!(collect(&mut receive), 32);
        for (seq, count) in [(16, 48), (16, 48), (48, 80), (80, 100), (101, 100)] {
            session.receive(attachment, json!({"type":"ack","seq":seq}));
            assert_eq!(collect(&mut receive), count);
        }
        assert_eq!(session.inner.lock().unwrap().outstanding_bytes, 20 * 4096);
        session.receive(attachment, json!({"type":"ack","seq":100}));
        assert_eq!(session.inner.lock().unwrap().outstanding_bytes, 0);
        assert_eq!(sent, (1..=100).collect::<Vec<_>>());
        assert!(session.inner.lock().unwrap().pending.is_empty());
        assert!(!stub.paused.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn stream_changes_replay_from_the_start_even_with_overlapping_sequences() {
        let (session, _, _, _) = fixture().await;
        {
            let mut inner = session.inner.lock().unwrap();
            inner.seq = 3;
            inner.outputs = (1..=3)
                .map(|seq| Output {
                    seq,
                    data: seq.to_string(),
                    bytes: 1,
                })
                .collect();
        }
        for (stream, reset, sequences) in [
            ("previous-server-stream", true, vec![1, 2, 3]),
            (session.stream_id.as_str(), false, vec![3]),
        ] {
            let (_, mut receive) = session.attach(2, Some(stream));
            match receive.try_recv().unwrap() {
                Transport::Message(hello) => {
                    assert_eq!(hello["reset"], reset);
                    assert_eq!(hello["truncated"], false);
                    assert_eq!(hello["streamId"], session.stream_id);
                }
                _ => panic!(),
            }
            let mut actual = Vec::new();
            while let Ok(Transport::Message(value)) = receive.try_recv() {
                if value["type"] == "output" {
                    actual.push(value["seq"].as_u64().unwrap());
                }
            }
            assert_eq!(actual, sequences);
        }
        session.dispose().await;
        let (_, mut receive) = session.attach(0, None);
        assert!(matches!(receive.try_recv(), Ok(Transport::Close(1000, _))));
    }
    #[tokio::test]
    async fn paste_guards_brackets_and_program_input_target_match_reference() {
        let (session, stub, attachment, _) = fixture().await;
        assert!(session.paste("echo dictated", 1, 0, false, None));
        assert_eq!(
            *stub.writes.lock().unwrap(),
            ["\x1b[200~echo dictated\x1b[201~"]
        );
        assert!(!session.paste("stale", 1, 0, false, None));
        assert!(!session.paste("different prompt", 2, 1, false, None));
        assert!(!session.paste("echo evil\r", 1, 1, false, None));
        {
            let mut inner = session.inner.lock().unwrap();
            inner.state.ready = false;
            inner.state.input_target = Some("program".into());
        }
        for data in ["\x1b[1;1R", "\r", "\x03"] {
            session.receive(attachment, json!({"type":"input","data":data}));
            assert_eq!(session.state().input_target.as_deref(), Some("program"));
        }
        {
            let mut inner = session.inner.lock().unwrap();
            inner.state.ready = true;
            inner.state.input_target = Some("shell".into());
        }
        session.receive(attachment, json!({"type":"input","data":"\r"}));
        assert!(!session.state().ready);
        assert!(session.state().input_target.is_none());
    }
    #[tokio::test]
    async fn expiration_claim_and_attachment_are_atomic() {
        let (session, _, attachment, _) = fixture().await;
        assert!(!session.mark_expired());
        session.detach(attachment);
        session.inner.lock().unwrap().detached = Instant::now() - Duration::from_secs(3601);
        assert!(session.mark_expired());
        let (_, mut receive) = session.attach(0, None);
        assert!(matches!(receive.try_recv(), Ok(Transport::Close(1000, _))));
    }
    #[tokio::test]
    async fn control_d_keeps_the_prompt_and_input_snapshots_reject_stale_revisions() {
        let (session, stub, attachment, mut receive) = fixture().await;
        session.inner.lock().unwrap().state.input_target = Some("shell".into());
        session.receive(attachment, json!({"type":"input","data":"\x04"}));
        assert!(session.state().ready);
        assert_eq!(session.state().input_target.as_deref(), Some("shell"));
        session.receive(
            attachment,
            json!({"type":"input-line","id":"stale","prompt":1,"revision":0}),
        );
        match receive.try_recv().unwrap() {
            Transport::Message(message) => assert!(message.get("text").is_none()),
            _ => panic!(),
        }
        assert_eq!(*stub.writes.lock().unwrap(), ["\x04"]);
        session.receive(
            attachment,
            json!({"type":"input-line","id":"current","prompt":1,"revision":1}),
        );
        assert_eq!(*stub.writes.lock().unwrap(), ["\x04", "\x18\x12"]);
        assert_eq!(session.state().input_revision, 1);
    }
    #[tokio::test]
    async fn program_dictation_respects_paste_mode_edits_captures_and_shell_lifecycle() {
        let (session, stub, attachment, mut receive) = fixture().await;
        {
            let mut inner = session.inner.lock().unwrap();
            inner.state.ready = false;
            inner.state.input_target = Some("program".into());
            inner.dictation = Some(("current".into(), Recording::dormant()));
            inner.dictation_serial = 1;
        }
        assert!(session.paste_dictation("Get in it.", 1, 0, "program", attachment, 1));
        assert_eq!(*stub.writes.lock().unwrap(), ["Get in it."]);
        match receive.try_recv().unwrap() {
            Transport::Message(message) => assert_eq!(message["source"], "dictation"),
            _ => panic!(),
        }
        session.inner.lock().unwrap().paste.feed("\x1b[?2004h");
        assert!(session.paste_dictation("More words.", 1, 1, "program", attachment, 1));
        assert_eq!(
            stub.writes.lock().unwrap()[1],
            "\x1b[200~More words.\x1b[201~"
        );
        for (text, prompt, revision, target, owner, serial) in [
            ("stale", 1, 1, "program", attachment, 1),
            ("new prompt", 2, 2, "program", attachment, 1),
            ("shell recording", 1, 2, "shell", attachment, 1),
            ("evil\r", 1, 2, "program", attachment, 1),
            ("old attachment", 1, 2, "program", attachment + 1, 1),
            ("old recording", 1, 2, "program", attachment, 0),
        ] {
            assert!(!session.paste_dictation(text, prompt, revision, target, owner, serial));
        }
        {
            let mut inner = session.inner.lock().unwrap();
            inner.captured = Some(json!({"id":"capture"}));
        }
        assert!(!session.paste_dictation("captured", 1, 2, "program", attachment, 1));
        {
            let mut inner = session.inner.lock().unwrap();
            inner.captured = None;
            inner.state.ready = true;
        }
        assert!(!session.paste_dictation("returned to Bash", 1, 2, "program", attachment, 1));
        {
            let mut inner = session.inner.lock().unwrap();
            inner.state.ready = false;
            inner.state.exited = true;
        }
        assert!(!session.paste_dictation("exited", 1, 2, "program", attachment, 1));
        assert_eq!(stub.writes.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn stale_recording_controls_and_malformed_targets_do_not_start_or_finish_recordings() {
        let (session, _, attachment, mut receive) = fixture().await;
        let current = "11111111-1111-1111-1111-111111111111";
        let stale = "22222222-2222-2222-2222-222222222222";
        session.inner.lock().unwrap().dictation = Some((current.into(), Recording::dormant()));
        for action in ["cancel", "finish"] {
            session.receive(
                attachment,
                json!({"type":"dictation","id":stale,"action":action}),
            );
            let inner = session.inner.lock().unwrap();
            assert_eq!(inner.dictation.as_ref().unwrap().0, current);
            assert!(!inner.dictation.as_ref().unwrap().1.done());
        }
        session.receive(
            attachment,
            json!({"type":"dictation","id":current,"action":"cancel"}),
        );
        assert!(session.inner.lock().unwrap().dictation.is_none());
        for target in [json!({}), json!([]), json!(true), json!(7)] {
            session.receive(attachment, json!({"type":"dictation","id":current,"action":"start","prompt":1,"revision":0,"target":target}));
            assert!(session.inner.lock().unwrap().dictation.is_none());
            match receive.try_recv().unwrap() {
                Transport::Message(message) => assert_eq!(message["state"], "error"),
                _ => panic!(),
            }
        }
        for target in [Value::Null, json!(false), json!(0), json!("")] {
            assert_eq!(dictation_target(&target), Some("shell"));
        }
    }
}
