mod handoffs;
#[path = "session/history.rs"]
mod history_cache;
mod output;
use crate::protocol::{DictationSource, DictationState, EngineMode, ServerMessage};
use crate::{
    context,
    engine::NativeEngine,
    facts,
    help::HelpProvider,
    history,
    host::{HostServices, NativeHost},
    markers::{Event, Markers},
    paste_mode::PasteMode,
    protocol::{ClientMessage, controls as control},
    reading::{self, Captures},
    storage,
    transfers::Transfers,
};
use handoffs::{Handoffs, Kind as CaptureKind};
use history_cache::History;
use output::Replay;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use termai_engine::{Request, path, types::Catalog};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub(crate) const RC: &str = include_str!("../assets/bashrc.sh");
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_scroll: Option<bool>,
}
#[derive(Clone)]
pub enum Transport {
    Message(Value),
    Close(u16, String),
}
#[derive(Clone, Copy)]
pub(crate) struct LineGuard {
    prompt: u64,
    revision: u64,
    attachment: u64,
}
#[derive(Clone)]
pub(crate) struct DictationGuard {
    line: LineGuard,
    target: String,
}
struct Attachment {
    id: u64,
    send: mpsc::UnboundedSender<Transport>,
}
struct InputLine {
    id: String,
    prompt: u64,
    revision: u64,
    serial: u64,
    internal: Option<tokio::sync::oneshot::Sender<Option<String>>>,
}
pub(crate) trait ShellProcess: Send + Sync {
    fn write(&self, text: &str);
    fn pause(&self, paused: bool);
    fn resize(&self, cols: u16, rows: u16);
    fn kill(&self);
}
struct Inner {
    state: ShellState,
    pty: Option<Box<dyn ShellProcess>>,
    markers: Markers,
    paste: PasteMode,
    history: History,
    replay: Replay,
    socket: Option<Attachment>,
    attachment: u64,
    detached: Instant,
    leases: usize,
    input_line: Option<InputLine>,
    input_serial: u64,
    input: crate::input_controller::Controller,
    handoffs: Handoffs,
    results: VecDeque<(String, ServerMessage)>,
    reading: Captures,
    transfers: Transfers,
    reading_queue: VecDeque<(String, String, u8)>,
    reading_running: bool,
    capture_cleanup: Arc<dyn Fn(String) + Send + Sync>,
}
pub struct Session {
    inner: Mutex<Inner>,
    pub stream_id: String,
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
/// A Herdr viewer uses its dedicated source without attaching a shell socket.
pub struct Lease(std::sync::Weak<Session>);
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(session) = self.0.upgrade() {
            let mut inner = session.inner.lock().unwrap();
            inner.leases -= 1;
            inner.detached = Instant::now();
        }
    }
}
pub(crate) enum ProcessEvent {
    Data(Vec<u8>),
    Closed,
    Exited(u32),
}
impl Inner {
    fn attached(&self, attachment: u64) -> bool {
        self.socket
            .as_ref()
            .is_some_and(|socket| socket.id == attachment)
    }
    fn repair_current(&self, guard: LineGuard) -> bool {
        self.attached(guard.attachment)
            && self.state.ready
            && !self.state.exited
            && !self.handoffs.active()
            && self.state.prompt == guard.prompt
            && self.state.input_revision == guard.revision
    }

    fn command_result(&self, id: &str) -> Option<ServerMessage> {
        self.results
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, v)| v.clone())
    }
    fn remember_command(&mut self, id: &str, result: ServerMessage) {
        self.results.push_back((id.into(), result));
        if self.results.len() > 1000 {
            self.results.pop_front();
        }
    }
    fn capture(&mut self, kind: CaptureKind, command: String) {
        if let Some(message) = self.handoffs.begin(kind, command) {
            self.send(message);
        }
    }
    fn send(&self, value: ServerMessage) {
        if let Some(socket) = &self.socket {
            let _ = socket.send.send(Transport::Message(value.value()));
        }
    }
    fn state(&self) {
        self.send(ServerMessage::State {
            state: (self.state).clone(),
        });
    }
    fn flush(&mut self) {
        if self.socket.is_none() {
            return;
        }
        while let Some(output) = self.replay.next() {
            self.send(ServerMessage::Output {
                seq: output.seq,
                data: output.data,
            });
        }
        if let Some(pty) = &self.pty {
            pty.pause(self.replay.paused());
        }
    }
    fn reject_input_line(&mut self) {
        if let Some(request) = self.input_line.take() {
            if let Some(reply) = request.internal {
                let _ = reply.send(None);
            } else {
                self.send(ServerMessage::InputLine {
                    id: (request.id).to_string(),
                    prompt: request.prompt,
                    revision: request.revision,
                    cursor: None,
                    text: None,
                });
            }
        }
    }
    fn output(&mut self, data: &str, directory: &str) {
        self.paste.feed(data);
        let (visible, events) = self.markers.feed(data);
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
                        terminal_scroll: None,
                    };
                    self.history.observe(had_prompt, history, command_cwd);
                    self.state();
                }
                Event::Busy => {
                    self.state.ready = false;
                    self.state.input_target = Some("program".into());
                    self.state();
                }
                Event::InputLine { text, cursor } => {
                    if let Some(request) = self.input_line.take() {
                        let valid = self.state.ready
                            && !self.state.exited
                            && !self.handoffs.active()
                            && request.prompt == self.state.prompt
                            && request.revision == self.state.input_revision;
                        let (text, cursor) = if valid {
                            (Some(text), Some(cursor))
                        } else {
                            (None, None)
                        };
                        if let Some(sender) = request.internal {
                            let _ = sender.send(text);
                        } else {
                            self.send(ServerMessage::InputLine {
                                id: request.id,
                                prompt: request.prompt,
                                revision: request.revision,
                                text,
                                cursor,
                            });
                        }
                    }
                }
                Event::Ssh { command } => self.capture(CaptureKind::Ssh, command),
                Event::Herdr { command } => self.capture(CaptureKind::Herdr, command),
                Event::ReadingFile { path } => self.send(ServerMessage::ReadingFile {
                    path: (path).to_string(),
                }),
                Event::ReadingCapture {
                    file,
                    name,
                    exit_code,
                } => {
                    if self.reading_queue.len() + usize::from(self.reading_running) >= 16 {
                        (self.capture_cleanup)(path::join(&[directory, &file]));
                        self.send(ServerMessage::ReadingError {
                            message: ("Too many outputs are waiting for Reading Mode.").to_string(),
                        });
                    } else {
                        self.reading_queue.push_back((file, name, exit_code));
                    }
                }
                event @ (Event::TransferUpload { .. }
                | Event::TransferDownload { .. }
                | Event::TransferCapture { .. }) => {
                    let request = self.transfers.add(event, directory);
                    self.send(ServerMessage::Transfer { request });
                }
            }
        }
        if visible.is_empty() {
            return;
        }
        self.replay.record(visible.into(), self.socket.is_some());
        self.flush();
    }
}
impl Session {
    pub async fn start(
        cwd: String,
        base_commands: Vec<String>,
        files_only: bool,
        services: HostServices,
    ) -> Result<Arc<Self>, String> {
        Self::start_host(cwd, base_commands, files_only, services, None).await
    }
    pub async fn start_remote(
        remote: Arc<crate::ssh::SSHHost>,
        files_only: bool,
        services: HostServices,
    ) -> Result<Arc<Self>, String> {
        Self::start_host(
            remote.cwd.clone(),
            vec![],
            files_only,
            services,
            Some(remote),
        )
        .await
    }
    async fn start_host(
        cwd: String,
        base_commands: Vec<String>,
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
                    terminal_scroll: None,
                },
                pty: None,
                markers: Markers::new(&nonce),
                paste: PasteMode::default(),
                history: History::new(history),
                replay: Replay::default(),
                socket: None,
                attachment: 0,
                detached: Instant::now(),
                leases: 0,
                input_line: None,
                input: Default::default(),
                input_serial: 0,
                handoffs: Handoffs::default(),
                results: VecDeque::new(),
                reading: Captures::default(),
                transfers: Transfers::new(capture_cleanup.clone()),
                reading_queue: VecDeque::new(),
                reading_running: false,
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
        let (pty, receiver) =
            crate::local_pty::LocalPty::start(&cwd, &directory, &env, &nonce).await?;
        session.inner.lock().unwrap().pty = Some(Box::new(pty));
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
        inner.socket.is_none()
            && inner.leases == 0
            && inner.detached.elapsed() >= Duration::from_secs(3600)
    }
    pub fn lease(self: &Arc<Self>) -> Option<Lease> {
        let mut inner = self.inner.lock().unwrap();
        if self.lifetime.is_cancelled() {
            return None;
        }
        inner.leases += 1;
        Some(Lease(Arc::downgrade(self)))
    }
    pub fn mark_expired(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        if inner.socket.is_none()
            && inner.leases == 0
            && inner.detached.elapsed() >= Duration::from_secs(3600)
        {
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
        inner.input.dictation.take();
        if let Some((_, cancel)) = inner.input.repair.take() {
            cancel.cancel();
        }
        inner.reject_input_line();
        if let Some(old) = inner.socket.take() {
            let _ = old.send.send(Transport::Close(
                4001,
                "This shell was opened in another tab.".into(),
            ));
        }
        inner.attachment += 1;
        let id = inner.attachment;
        inner.socket = Some(Attachment { id, send });
        let changed = stream.is_some_and(|stream| !stream.is_empty() && stream != self.stream_id);
        let replay = inner.replay.attach(after, changed);
        inner.send(ServerMessage::Hello {
            stream_id: self.stream_id.clone(),
            engine: EngineMode::Server,
            reset: replay.reset,
            truncated: replay.truncated,
            first_seq: replay.first_seq,
            last_seq: Some(replay.last_seq),
        });
        inner.state();
        inner.flush();
        for capture in inner.reading.pending() {
            inner.send(ServerMessage::ReadingCapture(capture));
        }
        for request in inner.transfers.pending() {
            inner.send(ServerMessage::Transfer { request });
        }
        if let Some(message) = inner.handoffs.pending() {
            inner.send(message);
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
        inner.input.dictation.take();
        if let Some((_, cancel)) = inner.input.repair.take() {
            cancel.cancel();
        }
        inner.reject_input_line();
        inner.detached = Instant::now();
        inner.replay.detach();
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
        self.inner.lock().unwrap().handoffs.captured()
    }
    pub fn capture_result(&self, id: &str) -> Option<Value> {
        self.inner.lock().unwrap().handoffs.result(id)
    }
    pub fn acknowledge_capture(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.handoffs.acknowledge(id);
        inner.send(ServerMessage::SshReleased { id: id.into() });
    }
    pub fn release_capture(
        &self,
        id: &str,
        native: bool,
        value: Option<Value>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let capture = inner.handoffs.release(id, value)?;
        inner.send(ServerMessage::SshReleased { id: id.into() });
        if native && let Some(pty) = &inner.pty {
            pty.write(&format!(
                "\x07\x05\x15\x1b[200~{}\x1b[201~\n",
                capture.command
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
        source: Option<DictationSource>,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.state.ready
            || inner.state.exited
            || inner.handoffs.active()
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
        inner.send(ServerMessage::Pasted {
            text: text.into(),
            replace,
            prompt: inner.state.prompt,
            revision: inner.state.input_revision,
            source,
            repairing: None,
        });
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
                    Ok(capture) => inner.send(ServerMessage::ReadingCapture(capture)),
                    Err(error) => inner.send(ServerMessage::ReadingError {
                        message: (error.message).to_string(),
                    }),
                }
            }
        });
    }
    pub fn receive(self: &Arc<Self>, attachment: u64, message: impl TryInto<ClientMessage>) {
        let Ok(message) = message.try_into() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        if inner
            .socket
            .as_ref()
            .is_none_or(|socket| socket.id != attachment)
        {
            return;
        }
        let same = inner.state.ready
            && !inner.state.exited
            && !inner.handoffs.active()
            && message.prompt() == Some(inner.state.prompt);
        if inner.input.intercept(&message) {
            return;
        }
        match message {
            ClientMessage::Repair(request) => {
                let guard = LineGuard {
                    prompt: request.prompt,
                    revision: request.revision,
                    attachment,
                };
                drop(inner);
                crate::input_coordinator::repair(self.clone(), guard, request, false);
            }
            ClientMessage::Dictation(request) => {
                let id = request.id.as_str();
                if !inner.input.control_dictation(&request) {
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
                        || inner.handoffs.active()
                        || request.prompt != Some(inner.state.prompt)
                        || request.revision != Some(inner.state.input_revision)
                        || request.target() != target
                    {
                        inner.send(ServerMessage::Dictation {
                            id: (id).to_string(),
                            state: DictationState::Error,
                            message: Some(
                                (if target.is_some() && !inner.handoffs.active() {
                                    "Terminal input changed. Try dictating again."
                                } else {
                                    "Wait for terminal input before dictating."
                                })
                                .to_string(),
                            ),
                        });
                        return;
                    }
                    let target = target.unwrap().to_owned();
                    let prompt = inner.state.prompt;
                    let revision = inner.state.input_revision;
                    inner.input.serial += 1;
                    let serial = inner.input.serial;
                    let guard = DictationGuard {
                        line: LineGuard {
                            prompt,
                            revision,
                            attachment,
                        },
                        target,
                    };
                    let recording = crate::input_coordinator::recording(
                        self,
                        guard,
                        id.into(),
                        serial,
                        request.reading_phrases,
                    );
                    inner.input.dictation = Some((id.into(), recording));
                }
            }
            ClientMessage::Ack { seq } => {
                if inner.replay.acknowledge(seq) {
                    inner.flush();
                }
            }
            ClientMessage::Resize { cols, rows, .. } => {
                if cols.is_finite()
                    && rows.is_finite()
                    && cols.fract() == 0.0
                    && rows.fract() == 0.0
                    && !inner.state.exited
                    && let Some(pty) = &inner.pty
                {
                    pty.resize(cols.clamp(2.0, 300.0) as u16, rows.clamp(2.0, 120.0) as u16);
                }
            }
            ClientMessage::Input { data } => {
                if !inner.state.exited && !inner.handoffs.active() {
                    inner.state.input_revision += 1;
                    if data.contains(['\r', '\n', '\x03']) {
                        if inner.state.ready {
                            inner.state.input_target = None;
                        }
                        inner.state.ready = false;
                        inner.state();
                    }
                    if let Some(pty) = &inner.pty {
                        pty.write(&data);
                    }
                }
            }
            ClientMessage::Replace {
                text, id, revision, ..
            } => {
                let accepted = id.encode_utf16().count() <= 100
                    && same
                    && revision == inner.state.input_revision
                    && text.encode_utf16().count() <= 4000
                    && !control(&text);
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
                inner.send(ServerMessage::EditResult {
                    id: (id).to_string(),
                    accepted,
                    revision: inner.state.input_revision,
                });
            }
            ClientMessage::Command { command, id, .. } => {
                {
                    // Results are retained separately from output replay.
                    if let Some(previous) = inner.command_result(&id) {
                        inner.send(previous);
                        return;
                    }
                    let accepted = same
                        && !command.is_empty()
                        && command.encode_utf16().count() <= 4000
                        && !control(&command);
                    let result = ServerMessage::Result { id: id.clone(), accepted, message: (!accepted).then(|| "The shell is not at the same prompt. Review the command and try again.".into()) };
                    inner.remember_command(&id, result.clone());
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
            ClientMessage::InputLine {
                id,
                prompt,
                revision,
            } => {
                if !same || inner.input_line.is_some() || revision != inner.state.input_revision {
                    inner.send(ServerMessage::InputLine {
                        id: (id).to_string(),
                        prompt,
                        revision,
                        cursor: None,
                        text: None,
                    });
                    return;
                }
                inner.input_serial += 1;
                let serial = inner.input_serial;
                inner.input_line = Some(InputLine {
                    id,
                    prompt: inner.state.prompt,
                    revision: inner.state.input_revision,
                    serial,
                    internal: None,
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
            self.remote.is_none()
                && !self.files_only
                && inner.history.reserve_refresh(Instant::now())
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
        if let Some(external) = external {
            inner.history.merge(external);
        }
        let history = inner.history.snapshot();
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
                history,
                history_cwds: Some(inner.history.cwds()),
            },
            shell.environment.clone(),
            state.prompt,
        ))
    }
    pub fn receive_binary(&self, attachment: u64, bytes: Vec<u8>) {
        let inner = self.inner.lock().unwrap();
        if inner.socket.as_ref().is_some_and(|s| s.id == attachment)
            && let Some((_, recording)) = &inner.input.dictation
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
            || inner.input.serial != serial
            || inner.input.dictation.is_none()
            || inner.handoffs.active()
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
        inner.send(ServerMessage::Pasted {
            text: (text).to_string(),
            replace: false,
            source: Some(DictationSource::Dictation),
            repairing: Some(target == "shell" && text.encode_utf16().count() <= 2000),
            prompt,
            revision: inner.state.input_revision,
        });
        true
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
    async fn internal_line(&self, prompt: u64, revision: u64, attachment: u64) -> Option<String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let serial = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.repair_current(LineGuard {
                prompt,
                revision,
                attachment,
            }) || inner.input_line.is_some()
            {
                return None;
            }
            inner.input_serial += 1;
            let serial = inner.input_serial;
            inner.input_line = Some(InputLine {
                id: String::new(),
                prompt,
                revision,
                serial,
                internal: Some(sender),
            });
            inner.pty.as_ref()?.write("\x18\x12");
            serial
        };
        let line = tokio::time::timeout(Duration::from_secs(2), receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        let mut inner = self.inner.lock().unwrap();
        if inner
            .input_line
            .as_ref()
            .is_some_and(|request| request.serial == serial)
        {
            inner.reject_input_line();
        }
        line
    }
    fn send_backend_failure(&self, prompt: u64, revision: u64) {
        let inner = self.inner.lock().unwrap();
        if inner.state.prompt == prompt && inner.state.input_revision == revision {
            let mut reply = crate::protocol::RepairReply::new(
                String::new(),
                String::new(),
                prompt,
                revision,
                true,
            );
            reply.error = Some("Input snapshot unavailable. Original text kept.".into());
            inner.send(ServerMessage::RepairResult(reply));
        }
    }
    fn start_repair(
        self: &Arc<Self>,
        id: String,
        text: String,
        intent: crate::alternatives::Intent,
        guard: LineGuard,
        backend: bool,
    ) {
        crate::input_coordinator::repair(
            self.clone(),
            guard,
            crate::protocol::Repair {
                id,
                text,
                intent,
                prompt: guard.prompt,
                revision: guard.revision,
            },
            backend,
        );
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
            inner.input.dictation.take();
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

impl crate::input_coordinator::RepairTarget for Session {
    type Guard = LineGuard;
    fn lifetime(&self) -> &CancellationToken {
        &self.lifetime
    }
    fn begin_repair(
        &self,
        guard: &LineGuard,
        reply: &mut crate::input_coordinator::RepairReply,
        cancel: CancellationToken,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.repair_current(*guard) {
            if !reply.backend() && inner.attached(guard.attachment) {
                reply.prompt = inner.state.prompt;
                reply.revision = inner.state.input_revision;
                inner.send(ServerMessage::RepairResult(reply.clone()));
            }
            return false;
        }
        inner.input.replace_repair(reply.id.clone(), cancel);
        true
    }
    async fn suggest(&self, text: &str, cancel: &CancellationToken) -> Result<Value, String> {
        Session::suggest(self, text, cancel).await
    }
    async fn complete_repair(
        &self,
        guard: LineGuard,
        mut reply: crate::input_coordinator::RepairReply,
        cancel: CancellationToken,
    ) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.attached(guard.attachment) {
            return;
        }
        reply.accepted = inner.repair_current(guard)
            && !cancel.is_cancelled()
            && reply.error.is_none()
            && inner
                .input
                .repair
                .as_ref()
                .is_some_and(|(id, _)| id == &reply.id);
        if reply.accepted {
            inner.state.input_revision += 1;
            if let Some(pty) = &inner.pty {
                pty.write(&format!(
                    "\x07\x05\x15\x1b[200~{}\x1b[201~",
                    reply.prepared.selected
                ));
            }
        }
        reply.revision = inner.state.input_revision;
        inner.input.finish_repair(&reply.id);
        inner.send(ServerMessage::RepairResult(reply));
    }
}
impl crate::input_coordinator::RecordingTarget for Session {
    type Guard = DictationGuard;
    const CHANGED: &'static str = "The terminal changed during dictation. No text was inserted.";
    async fn dictated(
        self: &Arc<Self>,
        guard: DictationGuard,
        _id: String,
        serial: u64,
        text: String,
        phrases: Value,
    ) -> Result<(), String> {
        let session = self.clone();
        let LineGuard {
            prompt,
            revision,
            attachment,
        } = guard.line;
        if text.is_empty() {
            return Ok(());
        }
        let empty = session.state().input_revision == session.state().prompt_revision;
        if !session.paste_dictation(&text, prompt, revision, &guard.target, attachment, serial) {
            return Err(Self::CHANGED.into());
        }
        if guard.target == "shell" && text.encode_utf16().count() <= 2000 {
            tokio::spawn(async move {
                let original = if empty {
                    Some(text)
                } else {
                    session
                        .internal_line(prompt, revision + 1, attachment)
                        .await
                };
                if let Some(original) = original {
                    let intent = crate::alternatives::Intent::detect(&original, &phrases);
                    session.start_repair(
                        crate::storage::random_hex(16),
                        original,
                        intent,
                        LineGuard {
                            prompt,
                            revision: revision + 1,
                            attachment,
                        },
                        true,
                    );
                } else {
                    session.send_backend_failure(prompt, revision + 1);
                }
            });
        }
        Ok(())
    }
    fn recording_status(
        &self,
        guard: &DictationGuard,
        id: &str,
        serial: u64,
        state: &str,
        reply: ServerMessage,
    ) {
        let mut inner = self.inner.lock().unwrap();
        if inner.attached(guard.line.attachment) && inner.input.status(id, serial, state) {
            inner.send(reply);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictation::Recording;
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
        let session = Session::start("/tmp".into(), vec![], true, HostServices::new())
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
            for _ in 0..100 {
                inner.replay.record("x".repeat(4096).into(), true);
            }
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
        assert_eq!(
            session.inner.lock().unwrap().replay.outstanding_bytes(),
            20 * 4096
        );
        session.receive(attachment, json!({"type":"ack","seq":100}));
        assert_eq!(session.inner.lock().unwrap().replay.outstanding_bytes(), 0);
        assert_eq!(sent, (1..=100).collect::<Vec<_>>());
        assert!(session.inner.lock().unwrap().replay.pending_empty());
        assert!(!stub.paused.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn stream_changes_replay_from_the_start_even_with_overlapping_sequences() {
        let (session, _, _, _) = fixture().await;
        {
            let mut inner = session.inner.lock().unwrap();
            for seq in 1..=3 {
                inner.replay.record(seq.to_string().into(), false);
            }
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
                    assert_eq!(hello["lastSeq"], 3);
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
        assert!(session.lease().is_none());
        let (_, mut receive) = session.attach(0, None);
        assert!(matches!(receive.try_recv(), Ok(Transport::Close(1000, _))));
    }
    #[tokio::test]
    async fn herdr_source_leases_prevent_expiration_and_refresh_idle_time_on_last_disconnect() {
        let (session, _, attachment, _) = fixture().await;
        session.detach(attachment);
        let metadata = session.lease().unwrap();
        let pane = session.lease().unwrap();
        session.inner.lock().unwrap().detached = Instant::now() - Duration::from_secs(3601);
        assert!(!session.mark_expired());
        assert!(!session.expired());
        drop(metadata);
        session.inner.lock().unwrap().detached = Instant::now() - Duration::from_secs(3601);
        assert!(!session.mark_expired());
        drop(pane);
        assert!(!session.mark_expired());
        assert!(session.inner.lock().unwrap().detached.elapsed() < Duration::from_secs(1));
        session.inner.lock().unwrap().detached = Instant::now() - Duration::from_secs(3601);
        assert!(session.mark_expired());
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
            inner.input.dictation = Some(("current".into(), Recording::dormant()));
            inner.input.serial = 1;
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
            inner.handoffs.begin(CaptureKind::Ssh, "ssh host".into());
        }
        assert!(!session.paste_dictation("captured", 1, 2, "program", attachment, 1));
        {
            let mut inner = session.inner.lock().unwrap();
            inner.handoffs = Handoffs::default();
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
        session.inner.lock().unwrap().input.dictation =
            Some((current.into(), Recording::dormant()));
        for action in ["cancel", "finish"] {
            session.receive(
                attachment,
                json!({"type":"dictation","id":stale,"action":action}),
            );
            let inner = session.inner.lock().unwrap();
            assert_eq!(inner.input.dictation.as_ref().unwrap().0, current);
            assert!(!inner.input.dictation.as_ref().unwrap().1.done());
        }
        session.receive(
            attachment,
            json!({"type":"dictation","id":current,"action":"cancel"}),
        );
        assert!(session.inner.lock().unwrap().input.dictation.is_none());
        for target in [json!({}), json!([]), json!(true), json!(7)] {
            session.receive(attachment, json!({"type":"dictation","id":current,"action":"start","prompt":1,"revision":0,"target":target}));
            assert!(session.inner.lock().unwrap().input.dictation.is_none());
            match receive.try_recv().unwrap() {
                Transport::Message(message) => assert_eq!(message["state"], "error"),
                _ => panic!(),
            }
        }
        for target in [Value::Null, json!(false), json!(0), json!("")] {
            assert_eq!(crate::protocol::dictation_target(&target), Some("shell"));
        }
    }
}
