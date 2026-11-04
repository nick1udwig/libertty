use super::*;
use crate::{
    protocol::{ClientMessage, DictationState, DictationTarget, ServerMessage},
    wire,
};
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use herdr_client_lib::{
    client::{Stream, StreamEvent},
    protocol::AttachParams,
};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Mutex};
use tokio::sync::{mpsc, oneshot};

struct Dictated {
    id: String,
    serial: u64,
    revision: u64,
    text: String,
    phrases: Value,
    done: oneshot::Sender<Result<(), String>>,
}
struct Recording {
    input: Mutex<crate::input_controller::Controller>,
    replies: mpsc::Sender<ServerMessage>,
    dictated: mpsc::Sender<Dictated>,
}
impl crate::input_coordinator::RecordingTarget for Recording {
    type Guard = u64;
    const CHANGED: &'static str = "Terminal input changed during dictation.";
    async fn dictated(
        self: &Arc<Self>,
        revision: u64,
        id: String,
        serial: u64,
        text: String,
        phrases: Value,
    ) -> Result<(), String> {
        if !self.input.lock().unwrap().current(&id, serial) {
            return Err(Self::CHANGED.into());
        }
        let (done, wait) = oneshot::channel();
        self.dictated
            .send(Dictated {
                id,
                serial,
                revision,
                text,
                phrases,
                done,
            })
            .await
            .map_err(error)?;
        wait.await.map_err(error)?
    }
    fn recording_status(
        &self,
        _: &u64,
        id: &str,
        serial: u64,
        state: DictationState,
        reply: ServerMessage,
    ) {
        if self.input.lock().unwrap().status(id, serial, state) {
            let _ = self.replies.try_send(reply);
        }
    }
}
impl Drop for Recording {
    fn drop(&mut self) {
        if let Some((_, recording)) = self.input.get_mut().unwrap().dictation.take() {
            recording.suspend();
        }
    }
}
async fn send(socket: &mut WebSocket, value: Value) -> Result<(), String> {
    tokio::time::timeout(
        Duration::from_secs(10),
        socket.send(if socket.protocol().is_some() {
            Message::Binary(
                wire::encode_json(
                    &value,
                    wire::Mode::protocol(socket.protocol().and_then(|p| p.to_str().ok())),
                )
                .into(),
            )
        } else {
            Message::Text(value.to_string().into())
        }),
    )
    .await
    .map_err(error)?
    .map_err(error)
}
#[derive(Default)]
struct Decoder(Vec<u8>);
impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&self.0) {
                Ok(valid) => {
                    text.push_str(valid);
                    self.0.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.0[..valid]).unwrap());
                    self.0.drain(..valid);
                    if let Some(length) = error.error_len() {
                        text.push('\u{fffd}');
                        self.0.drain(..length);
                    } else {
                        break;
                    }
                }
            }
        }
        text
    }
}
#[derive(Default)]
struct Credits {
    sequence: u64,
    pending: VecDeque<(u64, u32)>,
}
impl Credits {
    fn sent(&mut self, bytes: u32) -> u64 {
        self.sequence += 1;
        self.pending.push_back((self.sequence, bytes));
        self.sequence
    }
    fn acknowledge(&mut self, seq: u64) -> Result<u32, String> {
        if seq > self.sequence {
            return Err("Invalid output acknowledgement.".into());
        }
        let mut bytes = 0;
        while self.pending.front().is_some_and(|(id, _)| *id <= seq) {
            bytes += self.pending.pop_front().unwrap().1;
        }
        Ok(bytes)
    }
}
/// Herdr splits queued stream output into frames of this size, so a shorter frame ends the queued first paint.
const HERDR_FRAME: usize = 16 * 1024;
const PAINT_DEADLINE: Duration = Duration::from_millis(1500);
trait PaintSource {
    async fn next(&mut self) -> Result<Option<StreamEvent>, String>;
    async fn consumed(&mut self, bytes: u32) -> Result<(), String>;
}
impl PaintSource for Stream {
    async fn next(&mut self) -> Result<Option<StreamEvent>, String> {
        Stream::next(self).await.map_err(error)
    }
    async fn consumed(&mut self, bytes: u32) -> Result<(), String> {
        Stream::consumed(self, bytes).await.map_err(error)
    }
}
#[derive(Debug, Default, PartialEq)]
struct Paint {
    bytes: Vec<u8>,
    ended: bool,
}
/// Claude Code and Codex start redrawing within 12 milliseconds of a resize, so a program silent this long after the paint does not redraw.
const REDRAW_START: Duration = Duration::from_millis(50);
/// A redraw without synchronized output ends once output stops for this long, as Herdr's own settled screen does.
const REDRAW_QUIET: Duration = Duration::from_millis(10);
const SYNC_BEGIN: &[u8] = b"\x1b[?2026h";
const SYNC_END: &[u8] = b"\x1b[?2026l";
/// Follows synchronized output markers across frame boundaries.
#[derive(Default)]
struct Synchronized {
    carry: Vec<u8>,
    open: bool,
    /// A program began and ended a synchronized redraw; the paint's own reset ends nothing.
    completed: bool,
}
impl Synchronized {
    fn feed(&mut self, bytes: &[u8]) {
        let mut text = std::mem::take(&mut self.carry);
        text.extend_from_slice(bytes);
        for at in 0..text.len().saturating_sub(SYNC_BEGIN.len() - 1) {
            let marker = &text[at..at + SYNC_BEGIN.len()];
            if marker == SYNC_BEGIN {
                self.open = true;
            } else if marker == SYNC_END && self.open {
                self.open = false;
                self.completed = true;
            }
        }
        // A marker shorter than its full length cannot have matched, so its start waits for the next frame.
        self.carry = text[text.len().saturating_sub(SYNC_BEGIN.len() - 1)..].to_vec();
    }
}
/// Herdr sends a large first paint one credit window at a time.
/// Collecting and crediting it here lets the browser replace retained output in one paint instead of scrolling through each window.
/// A program that the attach resized redraws after the paint, so its redraw joins the paint.
/// Synchronized output marks where that redraw ends; a program without it ends its redraw by going quiet.
async fn first_paint(
    source: &mut impl PaintSource,
    deadline: Duration,
    redraw: bool,
) -> Result<Paint, String> {
    let deadline = tokio::time::Instant::now() + deadline;
    let mut paint = Paint::default();
    let mut largest = HERDR_FRAME;
    let mut painted: Option<tokio::time::Instant> = None;
    let mut redrawing = false;
    let mut sync = Synchronized::default();
    loop {
        let wait = match painted {
            None => deadline,
            Some(_) if !redraw || sync.completed && !sync.open => break,
            Some(_) if sync.open => deadline,
            Some(_) if redrawing => tokio::time::Instant::now() + REDRAW_QUIET,
            Some(at) => at + REDRAW_START,
        };
        let Ok(event) = tokio::time::timeout_at(wait.min(deadline), source.next()).await else {
            break;
        };
        match event? {
            Some(StreamEvent::Data(bytes)) => {
                source.consumed(bytes.len() as u32).await?;
                paint.bytes.extend_from_slice(&bytes);
                sync.feed(&bytes);
                if painted.is_some() {
                    redrawing = true;
                } else if bytes.len() < largest {
                    painted = Some(tokio::time::Instant::now());
                }
                largest = largest.max(bytes.len());
            }
            Some(StreamEvent::Closed(_)) | None => {
                paint.ended = true;
                break;
            }
        }
    }
    Ok(paint)
}
fn state(record: &herdr_client_lib::protocol::Terminal, revision: u64, prompt: u64) -> Value {
    let ready = shell(record).is_some();
    json!({"type":"state","state":{"cwd":record.folder().unwrap_or_default(),"inputRevision":revision,"inputContext":context(record),"promptRevision":0,"ready":ready,"prompt":prompt,"exited":false,"inputTarget":if ready {"shell"} else {"program"},"terminalScroll":false}})
}
async fn paste(stream: &Stream, parser: &vt100::Parser, text: &str) -> Result<(), String> {
    if text.contains('\x1b') || text.contains('\0') {
        return Err("Paste contains terminal control characters.".into());
    }
    let text = if parser.screen().bracketed_paste() {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text.to_owned()
    };
    stream.input(text.into_bytes()).await.map_err(error)
}
const ENDED: &str = "Herdr terminal ended";
/// One browser connection to an attached Herdr Core terminal, and the input state it guards.
struct Pane<'a> {
    socket: &'a mut WebSocket,
    target: &'a Target,
    id: &'a str,
    recording_scope: &'a str,
    cancel: &'a CancellationToken,
    client: Client,
    stream: Stream,
    parser: vt100::Parser,
    decoder: Decoder,
    credits: Credits,
    current: herdr_client_lib::protocol::Terminal,
    prompt: u64,
    revision: u64,
    editable: Option<super::input::Editable>,
    repair: Option<super::input::Pending>,
    prepared: mpsc::Sender<super::input::Prepared>,
    recording: Arc<Recording>,
    active: bool,
    last_contact: tokio::time::Instant,
}
impl Pane<'_> {
    async fn send(&mut self, value: Value) -> Result<(), String> {
        send(self.socket, value).await
    }
    async fn send_state(&mut self) -> Result<(), String> {
        self.send(state(&self.current, self.revision, self.prompt))
            .await
    }
    async fn close(&mut self) {
        let _ = self
            .socket
            .send(Message::Close(Some(CloseFrame {
                code: 1000,
                reason: ENDED.into(),
            })))
            .await;
    }
    async fn replace(&mut self, text: &str) -> Result<(), String> {
        self.editable
            .as_ref()
            .ok_or("Only dictated text can be replaced.")?
            .replace(
                &self.client,
                &self.stream,
                &self.parser,
                &self.current,
                text,
            )
            .await
    }
    fn dictated_text(&mut self, text: String, observe: bool) {
        let mut editable = super::input::Editable::new(text, &self.current);
        if observe {
            editable.observe(&self.parser);
        }
        self.editable = Some(editable);
    }
    fn cancel_repair(&mut self) {
        if let Some(previous) = self.repair.take() {
            previous.cancel();
        }
    }
    fn start_repair(&mut self, request: crate::protocol::Repair, backend: bool) {
        self.cancel_repair();
        self.repair = Some(super::input::prepare(
            self.target.clone(),
            self.id.into(),
            request,
            backend,
            self.cancel,
            self.prepared.clone(),
        ));
    }
    /// Repairs a dictated shell command as the backend's own alternatives request.
    fn repair_dictation(&mut self, text: String, phrases: &Value) {
        let intent = crate::alternatives::Intent::detect(&text, phrases);
        let request = crate::protocol::Repair {
            id: crate::storage::random_hex(16),
            text,
            prompt: self.prompt,
            revision: self.revision,
            intent,
        };
        self.start_repair(request, true);
    }
    async fn facts(&mut self) -> Result<(), String> {
        let next = self
            .client
            .terminal_get(&self.current.address, DEADLINE)
            .await
            .map_err(error)?;
        if next.identity != self.current.identity || !next.is_live() {
            return Err("The terminal ended or was replaced.".into());
        }
        let changed = context(&next) != context(&self.current);
        if changed {
            self.editable = None;
            self.revision += 1;
            if shell(&next).is_some() {
                self.prompt += 1;
            }
        }
        let moved = next.folder() != self.current.folder();
        self.current = next;
        if changed || moved {
            self.send_state().await?;
        }
        Ok(())
    }
    async fn prepared(&mut self, mut prepared: super::input::Prepared) -> Result<(), String> {
        if prepared.cancel.is_cancelled()
            || prepared.prompt != self.prompt
            || prepared.revision != self.revision
        {
            prepared.reply.error = Some("Terminal input changed during repair.".into());
        } else if prepared.reply.error.is_none() {
            let selected = prepared.reply.prepared.selected.clone();
            let result = if self.editable.is_none() {
                Err("Only the latest dictated text can be replaced.".into())
            } else {
                self.replace(&selected).await
            };
            prepared.reply.accepted = result.is_ok();
            prepared.reply.error = result.err();
            if prepared.reply.accepted {
                self.revision += 1;
                self.dictated_text(selected, true);
            }
        }
        prepared.reply.revision = self.revision;
        self.send(ServerMessage::RepairResult(prepared.reply).value())
            .await
    }
    async fn dictated(&mut self, text: Dictated) -> Result<(), String> {
        let current = self.active
            && self.revision == text.revision
            && self
                .recording
                .input
                .lock()
                .unwrap()
                .current(&text.id, text.serial);
        let result = if current {
            paste(&self.stream, &self.parser, &text.text).await
        } else {
            Err("Terminal input changed during dictation.".into())
        };
        if result.is_ok() {
            self.revision += 1;
            let shell = shell(&self.current).is_some();
            if shell {
                self.dictated_text(text.text.clone(), false);
            }
            self.send(json!({"type":"pasted","text":text.text,"replace":false,"source":"dictation","prompt":self.prompt,"revision":self.revision,"repairing":shell}))
                .await?;
            self.send_state().await?;
            if shell {
                self.repair_dictation(text.text, &text.phrases);
            }
        }
        let _ = text.done.send(result);
        Ok(())
    }
    /// Forwards terminal output, returning false once the terminal ends.
    async fn output(&mut self, event: Option<StreamEvent>) -> Result<bool, String> {
        let Some(StreamEvent::Data(bytes)) = event else {
            self.close().await;
            return Ok(false);
        };
        self.parser.process(&bytes);
        if let Some(editable) = &mut self.editable {
            editable.observe(&self.parser);
        }
        let text = self.decoder.push(&bytes);
        let seq = self.credits.sent(bytes.len() as u32);
        self.send(json!({"type":"output","seq":seq,"data":text}))
            .await?;
        Ok(true)
    }
    /// Handles one browser frame, returning false once the browser leaves.
    async fn input(&mut self, input: Option<Result<Message, axum::Error>>) -> Result<bool, String> {
        let Some(Ok(input)) = input else {
            return Ok(false);
        };
        self.last_contact = tokio::time::Instant::now();
        let message = match input {
            Message::Text(text) => serde_json::from_str::<ClientMessage>(&text).map_err(error)?,
            Message::Binary(bytes) => match wire::decode(&bytes).map_err(error)? {
                wire::Incoming::Message(message) => message,
                wire::Incoming::Audio(audio) => {
                    if let Some((_, recording)) = &self.recording.input.lock().unwrap().dictation {
                        recording.audio(audio);
                    }
                    return Ok(true);
                }
            },
            Message::Ping(data) => {
                self.socket.send(Message::Pong(data)).await.map_err(error)?;
                return Ok(true);
            }
            Message::Pong(_) => return Ok(true),
            Message::Close(_) => return Ok(false),
        };
        if message.edits_input() {
            self.cancel_repair();
        }
        self.message(message).await?;
        Ok(true)
    }
    async fn message(&mut self, message: ClientMessage) -> Result<(), String> {
        let active = self.active;
        match message {
            ClientMessage::Ping { .. } => self.send(json!({"type":"pong"})).await?,
            ClientMessage::Ack { seq } => {
                let bytes = self.credits.acknowledge(seq)?;
                if bytes > 0 {
                    self.stream.consumed(bytes).await.map_err(error)?;
                }
            }
            ClientMessage::HerdrActive { active } => {
                self.active = active;
                self.stream.focus(active).await.map_err(error)?;
            }
            ClientMessage::Resize { cols, rows, .. }
                if active
                    && crate::protocol::terminal_dimension(cols)
                    && crate::protocol::terminal_dimension(rows) =>
            {
                self.parser.screen_mut().set_size(rows, cols);
                self.stream.resize(cols, rows).await.map_err(error)?;
            }
            ClientMessage::Input { data, .. } if active => {
                if matches!(data.as_str(), "\x1b[I" | "\x1b[O") {
                    self.stream.focus(data == "\x1b[I").await.map_err(error)?;
                } else {
                    self.stream.input(data.into_bytes()).await.map_err(error)?;
                    self.editable = None;
                    self.revision += 1;
                }
            }
            ClientMessage::Paste { text } if active => {
                paste(&self.stream, &self.parser, &text).await?;
                self.editable = None;
                self.revision += 1;
                self.send_state().await?;
            }
            ClientMessage::Command {
                id,
                command,
                prompt,
            } if active => {
                if command.trim().is_empty()
                    || !crate::protocol::clean(&command, crate::protocol::MAX_TEXT)
                {
                    return Err("Invalid command.".into());
                }
                let result = if prompt.is_some_and(|expected| expected != self.prompt) {
                    Err("The shell prompt changed.".into())
                } else if self.editable.is_some() {
                    match self.replace(&command).await {
                        Ok(()) => self.stream.input(b"\r".to_vec()).await.map_err(error),
                        Err(message) => Err(message),
                    }
                } else {
                    self.stream
                        .input(format!("{command}\r").into_bytes())
                        .await
                        .map_err(error)
                };
                if result.is_ok() {
                    self.revision += 1;
                    self.editable = None;
                }
                self.send(json!({"type":"result","id":id,"accepted":result.is_ok(),"message":result.err()}))
                    .await?;
                self.send_state().await?;
            }
            ClientMessage::Dictation(request) if active => {
                let target = if shell(&self.current).is_some() {
                    DictationTarget::Shell
                } else {
                    DictationTarget::Program
                };
                let line = crate::input_controller::Line {
                    target: Some(target),
                    prompt: self.prompt,
                    revision: self.revision,
                };
                let mut controller = self.recording.input.lock().unwrap();
                if !controller.control_dictation(&request) {
                    match controller.begin_dictation(&request, Some(line)) {
                        Ok(serial) => {
                            let recording = crate::input_coordinator::recording(
                                &self.recording,
                                self.revision,
                                request.id.clone(),
                                serial,
                                request.reading_phrases,
                                self.recording_scope,
                            );
                            controller.dictation = Some((request.id, recording));
                        }
                        Err(message) => {
                            let _ = self
                                .recording
                                .replies
                                .try_send(ServerMessage::dictation_error(&request.id, message));
                        }
                    }
                }
            }
            ClientMessage::Replace {
                id,
                text,
                prompt,
                revision,
            } => {
                let result = if active && prompt == self.prompt && revision == self.revision {
                    self.replace(&text).await
                } else {
                    Err("Terminal input changed.".into())
                };
                if result.is_ok() {
                    self.revision += 1;
                    self.dictated_text(text, false);
                }
                self.send(json!({"type":"edit-result","id":id,"accepted":result.is_ok(),"revision":self.revision}))
                    .await?;
            }
            ClientMessage::Repair(request)
                if active && request.prompt == self.prompt && request.revision == self.revision =>
            {
                self.start_repair(request, false);
            }
            ClientMessage::Repair(request) => {
                let reply = crate::protocol::RepairReply::new(
                    request.id,
                    request.text,
                    self.prompt,
                    self.revision,
                    false,
                );
                self.send(ServerMessage::RepairResult(reply).value())
                    .await?;
            }
            ClientMessage::RepairCancel { id } => {
                if self.repair.as_ref().is_some_and(|pending| pending.id == id) {
                    self.cancel_repair();
                }
            }
            ClientMessage::DictationPaste {
                text,
                applied,
                replace,
                prompt,
                revision,
                reading_phrases,
            } => {
                let result = if !active
                    || prompt != self.prompt
                    || revision != self.revision
                    || shell(&self.current).is_none()
                {
                    Err("Terminal input changed.".to_owned())
                } else if applied {
                    Ok(())
                } else if replace {
                    self.replace(&text).await
                } else {
                    paste(&self.stream, &self.parser, &text).await
                };
                if let Err(message) = result {
                    self.send(json!({"type":"reading-error","message":message}))
                        .await?;
                } else {
                    self.revision += 1;
                    self.dictated_text(text.clone(), applied);
                    self.send(json!({"type":"pasted","text":text,"replace":false,"source":"dictation","prompt":self.prompt,"revision":self.revision,"repairing":true}))
                        .await?;
                    self.repair_dictation(text, &reading_phrases);
                }
            }
            ClientMessage::InputLine { id, .. } => {
                self.send(json!({"type":"input-line","id":id,"prompt":self.prompt,"revision":self.revision}))
                    .await?;
            }
            _ => (),
        }
        Ok(())
    }
}
pub async fn terminal(
    mut socket: WebSocket,
    target: &Target,
    id: &str,
    size: Option<crate::herdr::terminal_stream::Size>,
    recording_scope: &str,
    cancel: CancellationToken,
) {
    let work = async {
        let live = hub::live(target).await?;
        let record = live.record(id)?.clone();
        drop(live);
        let client = connect(target).await?;
        let size = size.unwrap_or(crate::herdr::terminal_stream::Size {
            cols: record.cols.max(1),
            rows: record.rows.max(1),
        });
        let (attached, mut stream) = client
            .attach(
                &AttachParams {
                    terminal: record.address.clone(),
                    cols: size.cols,
                    rows: size.rows,
                    history: 5000,
                    ..Default::default()
                },
                DEADLINE,
            )
            .await
            .map_err(error)?;
        if attached.identity != record.identity {
            return Err("The terminal was replaced; reopen its pane.".into());
        }
        // A shell at its prompt redraws nothing that matters after a resize, so only another program's redraw is awaited.
        let redraw =
            (record.cols, record.rows) != (size.cols, size.rows) && shell(&record).is_none();
        let paint = first_paint(&mut stream, PAINT_DEADLINE, redraw).await?;
        let (prepared, mut preparations) = mpsc::channel(4);
        let (replies, mut receive) = mpsc::channel(32);
        let (dictated, mut texts) = mpsc::channel(4);
        let mut pane = Pane {
            socket: &mut socket,
            target,
            id,
            recording_scope,
            cancel: &cancel,
            client,
            stream,
            parser: vt100::Parser::new(size.rows, size.cols, 0),
            decoder: Decoder::default(),
            credits: Credits::default(),
            current: attached,
            prompt: 1,
            revision: 0,
            editable: None,
            repair: None,
            prepared,
            recording: Arc::new(Recording {
                input: Mutex::new(Default::default()),
                replies,
                dictated,
            }),
            active: true,
            last_contact: tokio::time::Instant::now(),
        };
        pane.parser.process(&paint.bytes);
        // The paint is already credited, so its acknowledgement releases nothing.
        let replay = if paint.bytes.is_empty() {
            0
        } else {
            pane.credits.sent(0)
        };
        pane.send(json!({"type":"hello","engine":"server","reset":true,"truncated":false,"firstSeq":1,"lastSeq":replay,"streamId":id}))
            .await?;
        pane.send_state().await?;
        if replay > 0 {
            let data = pane.decoder.push(&paint.bytes);
            pane.send(json!({"type":"output","seq":replay,"data":data}))
                .await?;
        }
        if paint.ended {
            pane.close().await;
            return Ok(());
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        let mut facts = tokio::time::interval(Duration::from_millis(500));
        loop {
            let open = tokio::select! {
                _ = facts.tick(), if pane.active => pane.facts().await.map(|()| true)?,
                _ = heartbeat.tick() => {
                    if pane.last_contact.elapsed() > Duration::from_secs(45) {
                        return Err("Browser connection timed out.".into());
                    }
                    true
                }
                Some(prepared) = preparations.recv() => pane.prepared(prepared).await.map(|()| true)?,
                Some(reply) = receive.recv() => pane.send(reply.value()).await.map(|()| true)?,
                Some(text) = texts.recv() => pane.dictated(text).await.map(|()| true)?,
                output = pane.stream.next() => pane.output(output.map_err(error)?).await?,
                input = pane.socket.recv() => pane.input(input).await?,
            };
            if !open {
                return Ok(());
            }
        }
    };
    let result: Result<(), String> =
        tokio::select! { _ = cancel.cancelled() => return, result = work => result };
    cancel.cancel();
    if let Err(message) = result {
        eprintln!("Herdr Core terminal connection ended: {message}");
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: 1011,
                reason: "Herdr Core connection ended".into(),
            })))
            .await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_frame_boundaries_preserve_terminal_text() {
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(&[0xf0, 0x9f]), "");
        assert_eq!(decoder.push(&[0x98, 0x80, b'a', 0xff]), "😀a�");
        assert_eq!(decoder.push(b"\x1b[31m"), "\x1b[31m");
    }
    #[derive(Default)]
    struct Frames {
        events: VecDeque<StreamEvent>,
        consumed: u32,
        /// A busy program keeps printing at this interval once the queued events are gone.
        busy: Option<Duration>,
    }
    impl PaintSource for Frames {
        async fn next(&mut self) -> Result<Option<StreamEvent>, String> {
            match self.events.pop_front() {
                Some(event) => Ok(Some(event)),
                None => match self.busy {
                    Some(interval) => {
                        tokio::time::sleep(interval).await;
                        Ok(Some(StreamEvent::Data(b"spinner".to_vec())))
                    }
                    None => std::future::pending().await,
                },
            }
        }
        async fn consumed(&mut self, bytes: u32) -> Result<(), String> {
            self.consumed += bytes;
            Ok(())
        }
    }
    fn frames(events: impl IntoIterator<Item = StreamEvent>) -> Frames {
        Frames {
            events: events.into_iter().collect(),
            ..Default::default()
        }
    }
    #[tokio::test]
    async fn first_paint_collects_every_credit_window_before_live_output() {
        let full = vec![b'a'; HERDR_FRAME];
        let mut source = frames([
            StreamEvent::Data(full.clone()),
            StreamEvent::Data(full.clone()),
            StreamEvent::Data(b"end".to_vec()),
            StreamEvent::Data(b"live".to_vec()),
        ]);
        let paint = first_paint(&mut source, PAINT_DEADLINE, false)
            .await
            .unwrap();
        assert_eq!(paint.bytes.len(), 2 * HERDR_FRAME + 3);
        assert!(paint.bytes.ends_with(b"end") && !paint.ended);
        assert_eq!(source.consumed as usize, paint.bytes.len());
        assert_eq!(source.events.len(), 1);
    }
    #[tokio::test]
    async fn first_paint_follows_larger_herdr_frames() {
        let full = vec![b'a'; 2 * HERDR_FRAME];
        let mut source = frames([
            StreamEvent::Data(full.clone()),
            StreamEvent::Data(full.clone()),
            StreamEvent::Data(vec![b'b'; HERDR_FRAME + 1]),
            StreamEvent::Data(b"live".to_vec()),
        ]);
        let paint = first_paint(&mut source, PAINT_DEADLINE, false)
            .await
            .unwrap();
        assert_eq!(paint.bytes.len(), 5 * HERDR_FRAME + 1);
        assert_eq!(source.events.len(), 1);
    }
    #[tokio::test]
    async fn first_paint_reports_an_ended_terminal_and_a_silent_one() {
        let mut ended = frames([
            StreamEvent::Data(vec![b'a'; HERDR_FRAME]),
            StreamEvent::Closed(Value::Null),
        ]);
        let paint = first_paint(&mut ended, PAINT_DEADLINE, false)
            .await
            .unwrap();
        assert!(paint.ended && paint.bytes.len() == HERDR_FRAME);
        let mut silent = frames([]);
        assert_eq!(
            first_paint(&mut silent, Duration::from_millis(10), false)
                .await
                .unwrap(),
            Paint::default()
        );
    }
    fn data(bytes: &[u8]) -> StreamEvent {
        StreamEvent::Data(bytes.to_vec())
    }
    #[tokio::test]
    async fn a_synchronized_redraw_ends_at_its_closing_marker() {
        // The paint's own reset closes nothing, and the closing marker arrives split across two frames.
        let mut source = frames([
            StreamEvent::Data(vec![b'a'; HERDR_FRAME]),
            data(b"\x18\x1b[?2026lpaint"),
            data(b"\x1b[?2026h\x1b[2J\x1b[3J"),
            StreamEvent::Data(vec![b'r'; HERDR_FRAME]),
            data(b"prompt\x1b[?20"),
            data(b"26l"),
            data(b"\x1b[?2026hcursor\x1b[?2026l"),
        ]);
        let started = tokio::time::Instant::now();
        let paint = first_paint(&mut source, PAINT_DEADLINE, true)
            .await
            .unwrap();
        assert!(paint.bytes.ends_with(b"prompt\x1b[?2026l") && !paint.ended);
        assert_eq!(source.consumed as usize, paint.bytes.len());
        assert_eq!(source.events.len(), 1, "A later frame stays live output");
        assert!(
            started.elapsed() < REDRAW_START,
            "A closed redraw ends without waiting"
        );
    }
    #[tokio::test]
    async fn a_redraw_inside_the_last_paint_frame_needs_no_wait() {
        let mut source = frames([data(b"paint\x1b[?2026hredraw\x1b[?2026l")]);
        let started = tokio::time::Instant::now();
        let paint = first_paint(&mut source, PAINT_DEADLINE, true)
            .await
            .unwrap();
        assert!(paint.bytes.ends_with(b"redraw\x1b[?2026l"));
        assert!(started.elapsed() < REDRAW_START);
    }
    #[tokio::test]
    async fn a_program_that_does_not_redraw_costs_only_the_start_window() {
        let mut source = frames([data(b"paint")]);
        let started = tokio::time::Instant::now();
        let paint = first_paint(&mut source, PAINT_DEADLINE, true)
            .await
            .unwrap();
        assert_eq!(paint.bytes, b"paint");
        assert!(started.elapsed() >= REDRAW_START && started.elapsed() < 4 * REDRAW_START);
    }
    #[tokio::test]
    async fn an_unsynchronized_redraw_ends_when_output_goes_quiet() {
        let mut source = frames([data(b"paint"), data(b"\x1b[2Jredraw"), data(b"prompt")]);
        let paint = first_paint(&mut source, PAINT_DEADLINE, true)
            .await
            .unwrap();
        assert_eq!(paint.bytes, b"paint\x1b[2Jredrawprompt");
    }
    #[tokio::test]
    async fn the_deadline_ends_a_redraw_that_never_finishes() {
        for opening in [&b"\x1b[?2026hframe"[..], b"unsynchronized"] {
            let mut source = frames([data(b"paint"), data(opening)]);
            source.busy = Some(Duration::from_millis(5));
            let started = tokio::time::Instant::now();
            let paint = first_paint(&mut source, Duration::from_millis(100), true)
                .await
                .unwrap();
            assert!(
                started.elapsed() >= Duration::from_millis(100)
                    && started.elapsed() < Duration::from_millis(400)
            );
            assert!(paint.bytes.ends_with(b"spinner"));
        }
    }
    #[test]
    fn acknowledgements_release_each_byte_once() {
        let mut credits = Credits::default();
        assert_eq!(credits.sent(12), 1);
        assert_eq!(credits.sent(9), 2);
        assert_eq!(credits.acknowledge(1).unwrap(), 12);
        assert_eq!(credits.acknowledge(1).unwrap(), 0);
        assert!(credits.acknowledge(3).is_err());
        assert_eq!(credits.acknowledge(2).unwrap(), 9);
    }
}
