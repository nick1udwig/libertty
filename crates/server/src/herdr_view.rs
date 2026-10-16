mod frames;
mod history;
mod input;
use crate::protocol::{DictationSource, DictationState, ServerMessage};
use crate::{
    herdr::Target,
    herdr_terminal_stream::{Hub, Size, Subscription},
    protocol::{ClientMessage, controls},
    session::Transport,
};
pub use input::{Ledger, Ledgers};
use libertty_engine::utf16_len;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum LayoutUpdate {
    Reclaim,
    Resize,
}
struct Inner {
    revision: u64,
    input: crate::input_controller::Controller,
    dictation_id: String,
    shell: Option<crate::herdr::ShellInput>,
    context: Option<String>,
    prompt: u64,
    prompt_revision: u64,
    editable: Option<Editable>,
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
#[derive(Clone)]
pub(crate) struct DictationGuard {
    prompt: u64,
    revision: u64,
    shell: bool,
}
struct Input {
    text: String,
    paste: bool,
    guard: Option<(u64, String)>,
    command: Option<String>,
    complete: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    replacement: Option<Replacement>,
    /// Each numbered key in the text, with the byte offset where it ends.
    seqs: Vec<(u64, usize)>,
}
/// The mobile layout a viewer requests, and its progress toward a confirmed redraw.
struct Geometry {
    /// The requested mobile size, or none for a desktop viewer.
    size: Option<Size>,
    /// The size of the last full frame that matched the request.
    baseline: Option<Size>,
    /// The redraw revision a pending layout waits beyond, kept across rapid switches.
    redraw_before: Option<u64>,
}
/// The browser connection a view serves.
pub struct Viewer {
    pub send: crate::viewer_queue::Sender,
    pub cancel: CancellationToken,
    /// The browser terminal's input ledger, and whether an earlier connection created it.
    pub ledger: Option<(Arc<Ledger>, bool)>,
}
pub struct View {
    target: Target,
    agent: crate::herdr::Terminal,
    inner: Mutex<Inner>,
    capacity: Arc<Semaphore>,
    pending_input: mpsc::Sender<Input>,
    send: crate::viewer_queue::Sender,
    terminal: Subscription,
    history: crate::herdr_history::Hub,
    active: tokio::sync::watch::Sender<bool>,
    geometry: Mutex<Geometry>,
    /// Advances with every layout change, so stale confirmations stop.
    layout: tokio::sync::watch::Sender<u64>,
    frame_ready: tokio::sync::Notify,
    frames: Mutex<Option<frames::Frames>>,
    history_delta: Mutex<Option<history::History>>,
    cancel: CancellationToken,
    services: crate::host::HostServices,
    recording_scope: Mutex<String>,
    /// The layout epoch at which the pane last proved it still hosts this terminal.
    validated: Mutex<Option<u64>>,
    /// Frames signal possible foreground changes; without a live stream the shell is polled.
    output: tokio::sync::Notify,
    streaming: AtomicBool,
    /// The browser terminal's delivered keys, and this connection's claim on delivering more.
    ledger: Option<(Arc<Ledger>, u64)>,
}
impl View {
    pub fn open(
        target: Target,
        agent: crate::herdr::Terminal,
        hub: &Hub,
        history: &crate::herdr_history::Hub,
        initial: Option<(Size, Option<u64>)>,
        viewer: Viewer,
    ) -> Result<Arc<Self>, String> {
        let Viewer {
            send,
            cancel,
            ledger,
        } = viewer;
        let initial_size = initial.map(|(size, _)| size);
        let revision = initial.and_then(|(_, revision)| revision);
        let (frames, mut receive) = mpsc::channel(16);
        let terminal = hub.subscribe_sized(
            target.clone(),
            agent.terminal_id.clone(),
            frames,
            initial_size,
        )?;
        let subscription = history.subscribe(target.clone(), agent.pane_id.clone())?;
        let (active, _) = tokio::sync::watch::channel(true);
        let (layout, _) = tokio::sync::watch::channel(0);
        let (pending_input, mut inputs) = mpsc::channel::<Input>(128);
        let (generation, delivered) = ledger
            .as_ref()
            .map_or((0, 0), |(ledger, _)| ledger.connect());
        let view = Arc::new(Self {
            target,
            agent,
            inner: Mutex::new(Inner {
                revision: 0,
                input: Default::default(),
                dictation_id: String::new(),
                shell: None,
                context: None,
                prompt: 1,
                prompt_revision: 0,
                editable: None,
            }),
            capacity: Arc::new(Semaphore::new(128)),
            services: crate::host::HostServices::new(),
            recording_scope: Mutex::new(crate::storage::random_hex(16)),
            validated: Mutex::new(None),
            output: tokio::sync::Notify::new(),
            streaming: AtomicBool::new(false),
            ledger: ledger
                .as_ref()
                .map(|(ledger, _)| (ledger.clone(), generation)),
            pending_input,
            send,
            terminal,
            history: history.clone(),
            active,
            geometry: Mutex::new(Geometry {
                size: initial_size,
                baseline: None,
                redraw_before: revision,
            }),
            layout,
            frame_ready: tokio::sync::Notify::new(),
            frames: Mutex::new(None),
            history_delta: Mutex::new(None),
            cancel,
        });
        if let Some(size) = initial_size {
            view.send(ServerMessage::HerdrLayout {
                cols: size.cols,
                rows: size.rows,
                ready: false,
            });
        }
        if let Some((_, known)) = ledger {
            view.send(ServerMessage::InputAck {
                seq: known.then_some(delivered),
            });
        }
        view.send_state();
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        tokio::spawn(async move {
            loop {
                let Some(view) = weak.upgrade() else { break };
                let started = tokio::time::Instant::now();
                let (shell, context) = tokio::select! { biased; _=lifetime.cancelled()=>break, result=view.target.input_state(&view.agent.pane_id)=>result.unwrap_or_default() };
                let changed = {
                    let mut inner = view.inner.lock().unwrap();
                    let moved = inner.shell != shell
                        || inner
                            .context
                            .as_ref()
                            .is_some_and(|before| before != &context);
                    let changed = moved || inner.context.is_none();
                    if changed {
                        inner.shell = shell;
                        inner.context = Some(context);
                        if moved {
                            inner.editable = None;
                            inner.revision += 1;
                            inner.prompt += 1;
                            inner.prompt_revision = inner.revision;
                        }
                    }
                    changed
                };
                if changed {
                    view.send_state();
                }
                // Starting or finishing a program redraws the pane, so a quiet live stream needs only occasional checks.
                let interval = std::time::Duration::from_millis(300);
                let idle = if view.streaming.load(Ordering::Acquire) {
                    std::time::Duration::from_secs(2)
                } else {
                    interval
                };
                tokio::select! { biased; _=lifetime.cancelled()=>break, _=view.output.notified()=>{}, _=tokio::time::sleep(idle)=>{} }
                tokio::select! { biased; _=lifetime.cancelled()=>break, _=tokio::time::sleep_until(started + interval)=>{} }
            }
        });
        let weak = Arc::downgrade(&view);
        let lifetime = view.cancel.clone();
        // One worker preserves receive order across typing, commands and dictation.
        tokio::spawn(async move {
            let mut deferred = None;
            loop {
                let input = match deferred.take() {
                    Some(input) => Some(input),
                    None => {
                        tokio::select! {biased;_=lifetime.cancelled()=>break,input=inputs.recv()=>input}
                    }
                };
                let Some(mut input) = input else { break };
                let Some(view) = weak.upgrade() else { break };
                let permits = input::coalesce(&mut input, &mut inputs, &mut deferred);
                // Numbered keys wait for an older connection's send and keep only what it never delivered.
                let delivery = match &view.ledger {
                    Some((ledger, generation)) if !input.seqs.is_empty() => {
                        let Some(gate) = ledger.claim(*generation, &mut input).await else {
                            continue;
                        };
                        let (seq, _) = input.seqs[input.seqs.len() - 1];
                        Some((gate, ledger.as_ref(), seq))
                    }
                    _ => None,
                };
                let guard = input
                    .guard
                    .as_ref()
                    .map(|(revision, id)| (*revision, id.as_str()));
                let result = view
                    .input_serial(
                        &input.text,
                        input.paste,
                        guard,
                        input.replacement.as_ref(),
                        delivery.as_ref().map(|(_, ledger, seq)| (*ledger, *seq)),
                    )
                    .await;
                drop(delivery);
                drop(permits);
                if let Some(id) = input
                    .replacement
                    .as_ref()
                    .and_then(|replacement| replacement.edit_id.as_ref())
                {
                    let revision = view.inner.lock().unwrap().revision;
                    view.send(ServerMessage::EditResult {
                        id: (id).to_string(),
                        accepted: result.is_ok(),
                        revision,
                    });
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
                if let ServerMessage::HerdrFrame(frame) = &frame {
                    // An empty reset frame means the stream stopped, so history and shell checks resume polling.
                    let streaming = frame.width > 0;
                    view.streaming.store(streaming, Ordering::Release);
                    view.output.notify_one();
                    view.history
                        .activity(&view.target, &view.agent.pane_id, streaming);
                }
                if let ServerMessage::HerdrFrame(frame) = &frame
                    && frame.full
                {
                    let size = Some(Size {
                        cols: frame.width,
                        rows: frame.height,
                    });
                    let mut geometry = view.geometry.lock().unwrap();
                    if size.is_some() && size == geometry.size {
                        geometry.baseline = size;
                        view.frame_ready.notify_waiters();
                    }
                }
                if !*view.active.borrow() {
                    continue;
                }
                if let ServerMessage::HerdrFrame(frame) = frame {
                    let mut frames = view.frames.lock().unwrap();
                    if let Some(frames) = frames.as_mut() {
                        if frames.push(frame) {
                            view.terminal.snapshot();
                        }
                        if let Some(frame) = frames.next() {
                            view.send(ServerMessage::HerdrFrame(frame));
                        }
                    } else {
                        view.send(ServerMessage::HerdrFrame(frame));
                    }
                } else if let ServerMessage::ReadingError { message } = frame {
                    if view.report_error(&message).await {
                        break;
                    }
                } else {
                    view.send(frame);
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
                        .subscribe(view.target.clone(), view.agent.pane_id.clone())
                        .ok();
                }
                if let Some(history) = &mut history {
                    let message = history.receive.borrow_and_update().clone();
                    if let Some(message) = message {
                        let Some(view) = weak.upgrade() else { break };
                        match message {
                            Ok(message) => {
                                if let ServerMessage::Screen { text, .. } = message.as_ref() {
                                    let mut delivery = view.history_delta.lock().unwrap();
                                    if let Some(delivery) = delivery.as_mut() {
                                        if let Some(message) = delivery.next(text.clone()) {
                                            view.send(message);
                                        }
                                    } else {
                                        view.send(message.as_ref().clone());
                                    }
                                }
                            }
                            Err(message) => {
                                if !view.report_error(&message).await {
                                    view.send.send(Transport::Close(
                                        1011,
                                        "Herdr terminal unavailable".into(),
                                    ));
                                }
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
    async fn report_error(&self, message: &str) -> bool {
        // A pane can close before its metadata event reaches the viewer.
        let current = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return true,
            snapshot = async {
                self.target.shared.resource(&self.target)?
                    .refresh_snapshot(&self.target).await
            } => snapshot,
        };
        let ended = current.is_ok_and(|snapshot| {
            !snapshot.terminals.iter().any(|terminal| {
                terminal.terminal_id == self.agent.terminal_id
                    && terminal.pane_id == self.agent.pane_id
            })
        });
        if ended {
            self.send
                .send(Transport::Close(1000, "Herdr terminal ended".into()));
        } else {
            self.send(ServerMessage::ReadingError {
                message: message.into(),
            });
        }
        ended
    }
    pub fn set_recording_scope(&self, scope: String) {
        *self.recording_scope.lock().unwrap() = scope;
    }
    pub fn enable_history_delta(&self) {
        *self.history_delta.lock().unwrap() = Some(history::History::default());
    }
    pub fn enable_frame_ack(&self) {
        *self.frames.lock().unwrap() = Some(frames::Frames::default());
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
                if view.geometry.lock().unwrap().baseline == Some(size) {
                    break;
                }
                tokio::select! { biased; _=view.cancel.cancelled()=>return, _=layout.changed()=>return, _=&mut ready=>{} }
            }
            let redrawn = tokio::select! { biased; _=layout.changed()=>false, result=crate::herdr_redraw::wait(&view.target, &view.agent.pane_id, before, &view.cancel)=>result };
            // Read the epoch before locking the geometry, so no path holds both.
            let current = *view.layout.borrow() == epoch;
            let confirmed = redrawn && current && {
                let mut geometry = view.geometry.lock().unwrap();
                let current = geometry.size == Some(size);
                if current {
                    geometry.redraw_before = None;
                }
                current
            };
            if confirmed {
                view.send(ServerMessage::HerdrLayout {
                    cols: size.cols,
                    rows: size.rows,
                    ready: true,
                });
                view.terminal.refresh();
            }
        });
    }
    fn send(&self, message: ServerMessage) {
        if !self.cancel.is_cancelled() {
            self.send.send(Transport::Server(message));
        }
    }
    fn send_state(&self) {
        let inner = self.inner.lock().unwrap();
        self.send(ServerMessage::State {
            state: crate::session::ShellState {
                cwd: inner
                    .shell
                    .as_ref()
                    .map(|shell| shell.cwd.clone())
                    .unwrap_or_else(|| self.agent.cwd.clone()),
                ready: inner.shell.is_some(),
                input_target: Some(
                    if inner.shell.is_some() {
                        "shell"
                    } else {
                        "program"
                    }
                    .into(),
                ),
                terminal_scroll: Some(true),
                exited: false,
                prompt: inner.prompt,
                prompt_revision: inner.prompt_revision,
                input_revision: inner.revision,
                input_context: inner.context.clone(),
                exit_code: None,
            },
        });
    }
    async fn editable_screen(&self, text: &str) -> Result<String, String> {
        for _ in 0..20 {
            let reply = self
                .target
                .request(
                    "pane.read",
                    json!({"pane_id":self.agent.pane_id,"source":"recent_unwrapped","lines":1000}),
                )
                .await?;
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
        if utf16_len(text) > 16000 {
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
                seqs: Vec::new(),
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
        seq: Option<u64>,
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
            seqs: seq.map(|seq| (seq, text.len())).into_iter().collect(),
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
            self.send(ServerMessage::Result {
                id: id.into(),
                accepted: result.is_ok(),
                message: result.err(),
            });
        } else if let Err(message) = result {
            self.send(ServerMessage::ReadingError {
                message: (message).to_string(),
            });
        }
    }
    /// Send input in receive order; numbered keys finish their send even if this connection closes meanwhile.
    async fn input_serial(
        &self,
        text: &str,
        paste: bool,
        guard: Option<(u64, &str)>,
        replacement: Option<&Replacement>,
        delivery: Option<(&Ledger, u64)>,
    ) -> Result<(), String> {
        if utf16_len(text) > 16000 {
            return Err("Terminal input exceeded its limit.".into());
        }
        let work = async {
            if self.cancel.is_cancelled() {
                return Err("The agent view changed. No input was sent.".into());
            }
            // Typing bursts reuse one validation until Herdr reports a change; unwatched layouts always validate.
            let epoch = self.target.layout_epoch();
            if epoch.is_none() || *self.validated.lock().unwrap() != epoch {
                self.target.validate_terminal(&self.agent).await?;
                *self.validated.lock().unwrap() = epoch;
            }
            if self.cancel.is_cancelled() {
                return Err("This agent ended or moved. Reopen its tab. No input was sent.".into());
            }
            if let Some((revision, id)) = guard {
                self.guard(revision, id)?;
                let current_shell = self
                    .target
                    .shell_input(&self.agent.pane_id)
                    .await
                    .ok()
                    .flatten();
                if current_shell != self.inner.lock().unwrap().shell {
                    return Err("Terminal input changed during dictation.".into());
                }
            }
            let text = if let Some(replacement) = replacement {
                if self.target.shell_input(&self.agent.pane_id).await?.as_ref()
                    != Some(&replacement.shell)
                {
                    return Err("The shell is no longer at the prompt.".into());
                }
                let reply = self.target.request("pane.read", json!({"pane_id":self.agent.pane_id,"source":"recent_unwrapped","lines":1000})).await?;
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
            if let Some((ledger, seq)) = delivery {
                ledger.sending(seq);
            }
            if let Err(error) = self
                .target
                .request(
                    if paste {
                        "pane.send_input"
                    } else {
                        "pane.send_text"
                    },
                    json!({"pane_id":self.agent.pane_id,"text":text}),
                )
                .await
            {
                *self.validated.lock().unwrap() = None;
                return Err(error);
            }
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
        if delivery.is_some() {
            return work.await;
        }
        tokio::select! {biased;_=self.cancel.cancelled()=>Err("The agent view changed. No input was sent.".into()),result=work=>result}
    }
    pub fn audio(&self, bytes: Vec<u8>) {
        if let Some((_, recording)) = &self.inner.lock().unwrap().input.dictation {
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
        crate::input_coordinator::repair(
            self.clone(),
            crate::protocol::InputStamp { prompt, revision },
            crate::protocol::Repair {
                id,
                text,
                intent,
                prompt,
                revision,
            },
            backend,
        );
    }
    fn refresh_layout(self: &Arc<Self>, size: Size, epoch: u64, update: LayoutUpdate) {
        self.geometry.lock().unwrap().baseline = None;
        self.send(ServerMessage::HerdrLayout {
            cols: size.cols,
            rows: size.rows,
            ready: false,
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let Some(view) = weak.upgrade() else { return };
            // Reclaiming preserves an unfinished resize fence across rapid switches.
            let pending = match update {
                LayoutUpdate::Reclaim => view.geometry.lock().unwrap().redraw_before,
                LayoutUpdate::Resize => None,
            };
            let revision = match pending {
                Some(_) => pending,
                None => {
                    crate::herdr_redraw::revision(&view.target, &view.agent.pane_id, &view.cancel)
                        .await
                }
            };
            let stale = view.cancel.is_cancelled()
                || *view.layout.borrow() != epoch
                || (matches!(update, LayoutUpdate::Reclaim) && !*view.active.borrow());
            {
                let mut geometry = view.geometry.lock().unwrap();
                if stale || geometry.size != Some(size) {
                    return;
                }
                geometry.redraw_before = revision;
            }
            match update {
                LayoutUpdate::Reclaim => view.terminal.claim(),
                LayoutUpdate::Resize => {
                    if view.terminal.resize(Some(size)).is_err() {
                        return;
                    }
                }
            }
            view.confirm_layout(size, revision, epoch);
        });
    }
    pub fn receive<M: TryInto<ClientMessage>>(self: &Arc<Self>, message: M) -> Result<(), String>
    where
        M::Error: std::fmt::Display,
    {
        let message = message
            .try_into()
            .map_err(|error| format!("Invalid terminal action: {error}"))?;
        if self.inner.lock().unwrap().input.intercept(&message) {
            return Ok(());
        }
        match message {
            ClientMessage::Repair(request) => {
                let guard = crate::protocol::InputStamp {
                    prompt: request.prompt,
                    revision: request.revision,
                };
                crate::input_coordinator::repair(self.clone(), guard, request, false);
                Ok(())
            }
            ClientMessage::Ack { seq } => {
                if let Some(frames) = self.frames.lock().unwrap().as_mut() {
                    if frames.acknowledge(seq) {
                        self.terminal.snapshot();
                    }
                    if let Some(frame) = frames.next() {
                        self.send(ServerMessage::HerdrFrame(frame));
                    }
                }
                Ok(())
            }
            ClientMessage::HerdrFrameRequest => {
                if let Some(delivery) = self.history_delta.lock().unwrap().as_mut() {
                    delivery.reset();
                }
                self.terminal.refresh();
                // Subscribe briefly to refresh the shared active resource.
                if let Ok(history) = self
                    .history
                    .subscribe(self.target.clone(), self.agent.pane_id.clone())
                {
                    history.refresh.notify_one();
                }
                Ok(())
            }
            ClientMessage::HerdrActive { active } => {
                let changed = self.active.send_replace(active) != active;
                let epoch = if changed {
                    self.begin_layout()
                } else {
                    *self.layout.borrow()
                };
                if active && changed {
                    let size = self.geometry.lock().unwrap().size;
                    if let Some(size) = size {
                        self.refresh_layout(size, epoch, LayoutUpdate::Reclaim);
                    } else {
                        self.terminal.refresh();
                    }
                }
                Ok(())
            }
            ClientMessage::Resize { cols, rows, mobile } => {
                if !cols.is_finite()
                    || !rows.is_finite()
                    || cols.fract() != 0.0
                    || rows.fract() != 0.0
                    || !(1.0..=1000.0).contains(&cols)
                    || !(1.0..=1000.0).contains(&rows)
                {
                    return Err("Invalid terminal size".into());
                }
                let size = if mobile == Some(true) {
                    Some(Size {
                        cols: cols as u16,
                        rows: rows as u16,
                    })
                } else {
                    None
                };
                let changed =
                    std::mem::replace(&mut self.geometry.lock().unwrap().size, size) != size;
                let epoch = if changed {
                    self.begin_layout()
                } else {
                    *self.layout.borrow()
                };
                if changed && let Some(size) = size {
                    self.refresh_layout(size, epoch, LayoutUpdate::Resize);
                    Ok(())
                } else {
                    self.terminal.resize(size)
                }
            }
            ClientMessage::TerminalScroll { lines, column, row } => {
                if lines == 0 || lines.unsigned_abs() > 100 || column >= 1000 || row >= 1000 {
                    return Err("Invalid terminal scroll".into());
                }
                let view = self.clone();
                tokio::spawn(async move {
                    if let Err(message) = view.terminal.scroll(lines, column, row).await {
                        view.send(ServerMessage::ReadingError {
                            message: (message).to_string(),
                        });
                    }
                });
                Ok(())
            }
            ClientMessage::Input { data: text, seq } => {
                if utf16_len(&text) > 16000 {
                    return Err("Invalid input".into());
                }
                // A reconnecting browser resends keys it could not confirm, so skip the ones already delivered.
                let seq = self.ledger.as_ref().and(seq);
                if let (Some((ledger, _)), Some(seq)) = (&self.ledger, seq)
                    && seq <= ledger.delivered()
                {
                    return Ok(());
                }
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.revision += 1;
                    inner.editable = None;
                }
                self.queue_input(text, None, false, None, seq);
                Ok(())
            }
            ClientMessage::Paste { text } => {
                if text.is_empty() || utf16_len(&text) > 16000 || controls(&text) {
                    return Err("Invalid paste".into());
                }
                self.inner.lock().unwrap().revision += 1;
                self.queue_input(text, None, true, None, None);
                Ok(())
            }
            ClientMessage::Replace {
                id,
                text,
                prompt,
                revision,
            } => {
                if text.is_empty() || utf16_len(&text) > 2000 || controls(&text) {
                    return Err("Invalid replacement".into());
                }
                let replacement = {
                    let mut inner = self.inner.lock().unwrap();
                    let valid = prompt == inner.prompt && revision == inner.revision;
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
                    self.queue_input(text, None, false, Some(replacement), None);
                } else {
                    self.send(ServerMessage::EditResult {
                        id: (id).to_string(),
                        accepted: false,
                        revision: self.inner.lock().unwrap().revision,
                    });
                }
                Ok(())
            }
            ClientMessage::Command { command, id, .. } => {
                if command.trim().is_empty() || utf16_len(&command) > 16000 || controls(&command) {
                    return Err("Invalid command".into());
                }
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
                self.queue_input(command + "\r", Some(id), false, replacement, None);
                Ok(())
            }
            ClientMessage::Dictation(request) => {
                let id = request.id.clone();
                let mut inner = self.inner.lock().unwrap();
                if request.action == crate::protocol::DictationAction::Cancel
                    && inner.dictation_id == id
                {
                    inner.dictation_id.clear();
                }
                if !inner.input.control_dictation(&request) {
                    let revision = inner.revision;
                    if request.target()
                        != Some(if inner.shell.is_some() {
                            "shell"
                        } else {
                            "program"
                        })
                        || request.prompt != Some(inner.prompt)
                        || request.revision != Some(revision)
                    {
                        self.send(ServerMessage::Dictation {
                            resume: None,
                            id: (id).to_string(),
                            state: DictationState::Error,
                            message: Some(
                                ("Terminal input changed. Try dictating again.").to_string(),
                            ),
                        });
                        return Ok(());
                    }
                    inner.dictation_id = id.clone();
                    inner.input.serial += 1;
                    let serial = inner.input.serial;
                    inner.editable = None;
                    let prompt = inner.prompt;
                    let shell = inner.shell.is_some();
                    let guard = DictationGuard {
                        prompt,
                        revision,
                        shell,
                    };
                    let recording = crate::input_coordinator::recording(
                        self,
                        guard,
                        id.clone(),
                        serial,
                        request.reading_phrases,
                        &self.recording_scope.lock().unwrap(),
                    );
                    inner.input.dictation = Some((id, recording));
                }
                Ok(())
            }
            ClientMessage::DictationPaste {
                text,
                prompt,
                revision,
                applied,
                replace,
                reading_phrases: phrases,
            } => {
                if text.is_empty() {
                    return Err("Invalid dictation".into());
                }
                let (revision, prompt, id, replacement, shell) = {
                    let mut inner = self.inner.lock().unwrap();
                    let shell = inner
                        .shell
                        .clone()
                        .ok_or("Dictation alternatives require a shell prompt.")?;
                    if prompt != inner.prompt || revision != inner.revision {
                        return Err("Terminal input changed. Try again.".into());
                    }
                    let id = crate::storage::random_hex(16);
                    inner.dictation_id = id.clone();
                    let replacement = if replace {
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
                let view = self.clone();
                tokio::spawn(async move {
                    let work = async {
                        if view.target.shell_input(&view.agent.pane_id).await?.as_ref()
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
                        view.send(ServerMessage::Pasted {
                            text: (text).to_string(),
                            replace: false,
                            source: Some(DictationSource::Dictation),
                            repairing: Some(true),
                            prompt,
                            revision,
                        });
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
                        view.send(ServerMessage::ReadingError {
                            message: (error).to_string(),
                        });
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
        if let Some((_, recording)) = self.inner.get_mut().unwrap().input.dictation.take() {
            recording.suspend();
        }
    }
}

impl crate::input_coordinator::RepairTarget for View {
    type Guard = crate::protocol::InputStamp;
    fn lifetime(&self) -> &CancellationToken {
        &self.cancel
    }
    fn begin_repair(
        &self,
        guard: &Self::Guard,
        reply: &mut crate::input_coordinator::RepairReply,
        cancel: CancellationToken,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.prompt != guard.prompt || inner.revision != guard.revision {
            if !reply.backend() {
                reply.prompt = inner.prompt;
                reply.revision = inner.revision;
                self.send(ServerMessage::RepairResult(reply.clone()));
            }
            return false;
        }
        inner.dictation_id = reply.id.clone();
        inner.input.replace_repair(reply.id.clone(), cancel);
        true
    }
    async fn suggest(&self, text: &str, cancel: &CancellationToken) -> Result<Value, String> {
        self.target
            .suggest(&self.agent.terminal_id, text, self.services.clone(), cancel)
            .await
    }
    async fn complete_repair(
        &self,
        guard: Self::Guard,
        mut reply: crate::input_coordinator::RepairReply,
        cancel: CancellationToken,
    ) {
        if reply.error.is_none() {
            let applied = async {
                self.guard(guard.revision, &reply.id)?;
                if cancel.is_cancelled() {
                    return Err("Repair cancelled.".to_owned());
                }
                let replacement = {
                    let mut inner = self.inner.lock().unwrap();
                    if inner.prompt != guard.prompt
                        || inner.revision != guard.revision
                        || inner.dictation_id != reply.id
                        || cancel.is_cancelled()
                    {
                        return Err(
                            "Terminal input changed during repair. No text was replaced.".into(),
                        );
                    }
                    let previous = inner
                        .editable
                        .clone()
                        .ok_or("Only the latest dictated text can be replaced.")?;
                    let shell = inner
                        .shell
                        .clone()
                        .ok_or("The shell is no longer at the prompt.")?;
                    if reply.prepared.selected == previous.text {
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
                self.input(
                    &reply.prepared.selected,
                    false,
                    Some((next, &reply.id)),
                    Some(replacement),
                )
                .await?;
                let screen = self.editable_screen(&reply.prepared.selected).await?;
                let mut inner = self.inner.lock().unwrap();
                if inner.revision != next || inner.dictation_id != reply.id || cancel.is_cancelled()
                {
                    return Err("Terminal input changed during repair.".into());
                }
                inner.editable = Some(Editable {
                    text: reply.prepared.selected.clone(),
                    screen,
                });
                Ok::<_, String>(())
            }
            .await;
            reply.accepted = applied.is_ok();
            reply.error = applied.err();
        }
        let mut inner = self.inner.lock().unwrap();
        reply.revision = inner.revision;
        inner.input.finish_repair(&reply.id);
        self.send(ServerMessage::RepairResult(reply));
    }
}
impl crate::input_coordinator::RecordingTarget for View {
    type Guard = DictationGuard;
    const CHANGED: &'static str = "Terminal input changed during dictation. No text was inserted.";
    async fn dictated(
        self: &Arc<Self>,
        guard: DictationGuard,
        id: String,
        _serial: u64,
        text: String,
        phrases: Value,
    ) -> Result<(), String> {
        let DictationGuard {
            prompt,
            revision,
            shell,
        } = guard;
        self.guard(revision, &id)?;
        if text.is_empty() {
            return Ok(());
        }
        self.input(&text, true, Some((revision, &id)), None).await?;
        let screen = if shell {
            self.editable_screen(&text).await.ok()
        } else {
            None
        };
        let new_revision = {
            let mut inner = self.inner.lock().unwrap();
            if inner.revision != revision
                || inner.prompt != prompt
                || inner.dictation_id != id
                || self.cancel.is_cancelled()
            {
                return Err("Terminal input changed during dictation.".into());
            }
            inner.revision += 1;
            inner.editable = screen.map(|screen| Editable {
                text: text.clone(),
                screen,
            });
            inner.revision
        };
        self.send(ServerMessage::Pasted {
            text: (text).to_string(),
            replace: false,
            prompt,
            revision: new_revision,
            source: Some(DictationSource::Dictation),
            repairing: Some(shell && utf16_len(&text) <= 2000),
        });
        if shell && utf16_len(&text) <= 2000 {
            let intent = crate::alternatives::Intent::detect(&text, &phrases);
            self.start_repair(
                crate::storage::random_hex(16),
                text,
                intent,
                prompt,
                new_revision,
                true,
            );
        }
        Ok(())
    }
    fn recording_status(
        &self,
        _guard: &DictationGuard,
        id: &str,
        serial: u64,
        state: &str,
        reply: ServerMessage,
    ) {
        if self.inner.lock().unwrap().input.status(id, serial, state) {
            self.send(reply);
        }
    }
}
