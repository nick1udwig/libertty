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
pub async fn terminal(
    mut socket: WebSocket,
    target: &Target,
    id: &str,
    size: Option<crate::herdr_terminal_stream::Size>,
    recording_scope: &str,
    cancel: CancellationToken,
) {
    let work = async {
        let live = hub::live(target).await?;
        let record = live.record(id)?.clone();
        drop(live);
        let client = connect(target).await?;
        let size = size.unwrap_or(crate::herdr_terminal_stream::Size {
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
        let mut parser = vt100::Parser::new(size.rows, size.cols, 0);
        let mut decoder = Decoder::default();
        let mut credits = Credits::default();
        parser.process(&paint.bytes);
        // The paint is already credited, so its acknowledgement releases nothing.
        let replay = if paint.bytes.is_empty() {
            0
        } else {
            credits.sent(0)
        };
        send(&mut socket, json!({"type":"hello","engine":"server","reset":true,"truncated":false,"firstSeq":1,"lastSeq":replay,"streamId":id})).await?;
        let mut current = attached;
        let mut prompt = 1;
        let mut revision = 0;
        let mut editable: Option<super::input::Editable> = None;
        let mut repair: Option<super::input::Pending> = None;
        let (prepared, mut preparations) = mpsc::channel::<super::input::Prepared>(4);
        send(&mut socket, state(&current, revision, prompt)).await?;
        let (replies, mut receive) = mpsc::channel(32);
        let (dictated, mut texts) = mpsc::channel(4);
        let recording = Arc::new(Recording {
            input: Mutex::new(Default::default()),
            replies,
            dictated,
        });
        if replay > 0 {
            send(
                &mut socket,
                json!({"type":"output","seq":replay,"data":decoder.push(&paint.bytes)}),
            )
            .await?;
        }
        if paint.ended {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1000,
                    reason: "Herdr terminal ended".into(),
                })))
                .await;
            return Ok(());
        }
        let mut active = true;
        let mut last_contact = tokio::time::Instant::now();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        let mut facts = tokio::time::interval(Duration::from_millis(500));
        loop {
            tokio::select! {
                _ = facts.tick(), if active => {
                    let next = client.terminal_get(&current.address, DEADLINE).await.map_err(error)?;
                    if next.identity != current.identity || !next.is_live() { return Err("The terminal ended or was replaced.".into()); }
                    let changed = context(&next) != context(&current);
                    if changed { editable = None; revision += 1; if shell(&next).is_some() { prompt += 1; } }
                    if changed || next.folder() != current.folder() {
                        current = next;
                        send(&mut socket, state(&current,revision,prompt)).await?;
                    } else { current = next; }
                }
                _ = heartbeat.tick() => {
                    if last_contact.elapsed() > Duration::from_secs(45) { return Err("Browser connection timed out.".into()); }
                }
                Some(mut prepared) = preparations.recv() => {
                    if !prepared.cancel.is_cancelled() && prepared.prompt == prompt && prepared.revision == revision {
                        if prepared.reply.error.is_none() {
                            let result = match &editable {
                                Some(previous) => previous.replace(&client, &stream, &parser, &current, &prepared.reply.prepared.selected).await,
                                None => Err("Only the latest dictated text can be replaced.".into()),
                            };
                            prepared.reply.accepted = result.is_ok();
                            prepared.reply.error = result.err();
                            if prepared.reply.accepted {
                                revision += 1;
                                editable = Some(super::input::Editable::new(prepared.reply.prepared.selected.clone(), &current));
                                editable.as_mut().unwrap().observe(&parser);
                            }
                        }
                    } else { prepared.reply.error = Some("Terminal input changed during repair.".into()); }
                    prepared.reply.revision = revision;
                    send(&mut socket, ServerMessage::RepairResult(prepared.reply).value()).await?;
                }
                Some(reply) = receive.recv() => send(&mut socket, reply.value()).await?,
                Some(text) = texts.recv() => {
                    let result = if !active || revision != text.revision || !recording.input.lock().unwrap().current(&text.id, text.serial) { Err("Terminal input changed during dictation.".into()) } else { paste(&stream, &parser, &text.text).await };
                    if result.is_ok() {
                        revision += 1;
                        let shell = shell(&current).is_some();
                        if shell { editable = Some(super::input::Editable::new(text.text.clone(), &current)); }
                        send(&mut socket, json!({"type":"pasted","text":text.text,"replace":false,"source":"dictation","prompt":prompt,"revision":revision,"repairing":shell})).await?;
                        send(&mut socket, state(&current, revision, prompt)).await?;
                        if shell {
                            if let Some(previous) = repair.take() { previous.cancel(); }
                            let intent = crate::alternatives::Intent::detect(&text.text, &text.phrases);
                            repair = Some(super::input::prepare(target.clone(), id.into(), crate::protocol::Repair { id:crate::storage::random_hex(16), text:text.text, prompt, revision, intent }, true, &cancel, prepared.clone()));
                        }
                    }
                    let _ = text.done.send(result);
                }
                output = stream.next() => match output.map_err(error)? {
                    Some(StreamEvent::Data(bytes)) => {
                        parser.process(&bytes);
                        if let Some(editable) = &mut editable { editable.observe(&parser); }
                        let text = decoder.push(&bytes);
                        let seq = credits.sent(bytes.len() as u32);
                        send(&mut socket, json!({"type":"output","seq":seq,"data":text})).await?;
                    }
                    Some(StreamEvent::Closed(_)) | None => {
                        let _ = socket.send(Message::Close(Some(CloseFrame { code:1000, reason:"Herdr terminal ended".into() }))).await;
                        return Ok(());
                    }
                },
                input = socket.recv() => {
                    let Some(Ok(input)) = input else { return Ok(()) };
                    last_contact = tokio::time::Instant::now();
                    let message = match input {
                        Message::Text(text) => serde_json::from_str::<ClientMessage>(&text).map_err(error)?,
                        Message::Binary(bytes) => match wire::decode(&bytes).map_err(error)? {
                            wire::Incoming::Message(message) => message,
                            wire::Incoming::Audio(audio) => { if let Some((_, r)) = &recording.input.lock().unwrap().dictation { r.audio(audio); } continue; }
                        },
                        Message::Ping(data) => { socket.send(Message::Pong(data)).await.map_err(error)?; continue; }
                        Message::Pong(_) => continue,
                        Message::Close(_) => return Ok(()),
                    };
                    if message.edits_input() && let Some(previous) = repair.take() { previous.cancel(); }
                    match message {
                        ClientMessage::Ping { .. } => send(&mut socket, json!({"type":"pong"})).await?,
                        ClientMessage::Ack { seq } => { let bytes = credits.acknowledge(seq)?; if bytes > 0 { stream.consumed(bytes).await.map_err(error)?; } }
                        ClientMessage::HerdrActive { active: visible } => { active = visible; stream.focus(active).await.map_err(error)?; }
                        ClientMessage::Resize { cols, rows, .. } if active && (1..=1000).contains(&cols) && (1..=1000).contains(&rows) => { parser.screen_mut().set_size(rows, cols); stream.resize(cols, rows).await.map_err(error)?; }
                        ClientMessage::Input { data, .. } if active => {
                            if matches!(data.as_str(), "\x1b[I" | "\x1b[O") { stream.focus(data == "\x1b[I").await.map_err(error)?; }
                            else { stream.input(data.into_bytes()).await.map_err(error)?; editable = None; revision += 1; }
                        }
                        ClientMessage::Paste { text } if active => { paste(&stream, &parser, &text).await?; editable = None; revision += 1; send(&mut socket, state(&current,revision,prompt)).await?; }
                        ClientMessage::Command { id: request, command, prompt: expected_prompt } if active => {
                            if command.trim().is_empty() || libertty_engine::utf16_len(&command) > crate::protocol::MAX_TEXT || crate::protocol::controls(&command) { return Err("Invalid command.".into()); }
                            let result = async {
                                if expected_prompt.is_some_and(|expected| expected != prompt) { return Err("The shell prompt changed.".into()); }
                                if let Some(previous) = &editable { previous.replace(&client, &stream, &parser, &current, &command).await?; stream.input(b"\r".to_vec()).await.map_err(error) }
                                else { stream.input(format!("{command}\r").into_bytes()).await.map_err(error) }
                            }.await;
                            if result.is_ok() { revision += 1; editable = None; }
                            send(&mut socket, json!({"type":"result","id":request,"accepted":result.is_ok(),"message":result.err()})).await?;
                            send(&mut socket, state(&current,revision,prompt)).await?;
                        }
                        ClientMessage::Dictation(request) if active => {
                            let mut controller = recording.input.lock().unwrap();
                            if !controller.control_dictation(&request) {
                                let line = crate::input_controller::Line { target:Some(if shell(&current).is_some() { DictationTarget::Shell } else { DictationTarget::Program }), prompt, revision };
                                match controller.begin_dictation(&request, Some(line)) {
                                    Ok(serial) => {
                                        let id = request.id;
                                        let r = crate::input_coordinator::recording(&recording, revision, id.clone(), serial, request.reading_phrases, recording_scope);
                                        controller.dictation = Some((id,r));
                                    }
                                    Err(message) => { let _ = recording.replies.try_send(ServerMessage::dictation_error(&request.id,message)); }
                                }
                            }
                        }
                        ClientMessage::Replace { id, text, prompt: expected_prompt, revision: expected_revision } => {
                            let result = if active && expected_prompt == prompt && expected_revision == revision {
                                match &editable { Some(previous) => previous.replace(&client,&stream,&parser,&current,&text).await, None => Err("Only dictated text can be replaced.".into()) }
                            } else { Err("Terminal input changed.".into()) };
                            if result.is_ok() { revision += 1; editable = Some(super::input::Editable::new(text, &current)); }
                            send(&mut socket,json!({"type":"edit-result","id":id,"accepted":result.is_ok(),"revision":revision})).await?;
                        }
                        ClientMessage::Repair(request) if active && request.prompt == prompt && request.revision == revision => {
                            if let Some(previous) = repair.take() { previous.cancel(); }
                            repair = Some(super::input::prepare(target.clone(),id.into(),request,false,&cancel,prepared.clone()));
                        }
                        ClientMessage::Repair(request) => send(&mut socket, ServerMessage::RepairResult(crate::protocol::RepairReply::new(request.id,request.text,prompt,revision,false)).value()).await?,
                        ClientMessage::RepairCancel { id } => { if repair.as_ref().is_some_and(|pending| pending.id == id) && let Some(previous) = repair.take() { previous.cancel(); } }
                        ClientMessage::DictationPaste { text, applied, replace, prompt: expected_prompt, revision: expected_revision, reading_phrases } => {
                            let result = async {
                                if !active || prompt != expected_prompt || revision != expected_revision || shell(&current).is_none() { return Err("Terminal input changed.".to_owned()); }
                                if !applied {
                                    if replace { editable.as_ref().ok_or("Only dictated text can be replaced.")?.replace(&client,&stream,&parser,&current,&text).await?; }
                                    else { paste(&stream,&parser,&text).await?; }
                                }
                                Ok(())
                            }.await;
                            if let Err(message) = result { send(&mut socket,json!({"type":"reading-error","message":message})).await?; }
                            else {
                                revision += 1;
                                editable = Some(super::input::Editable::new(text.clone(), &current));
                                if applied { editable.as_mut().unwrap().observe(&parser); }
                                send(&mut socket,json!({"type":"pasted","text":text,"replace":false,"source":"dictation","prompt":prompt,"revision":revision,"repairing":true})).await?;
                                let intent = crate::alternatives::Intent::detect(&text,&reading_phrases);
                                if let Some(previous) = repair.take() { previous.cancel(); }
                                repair = Some(super::input::prepare(target.clone(),id.into(),crate::protocol::Repair { id:crate::storage::random_hex(16),text,prompt,revision,intent },true,&cancel,prepared.clone()));
                            }
                        }
                        ClientMessage::InputLine { id, .. } => send(&mut socket,json!({"type":"input-line","id":id,"prompt":prompt,"revision":revision})).await?,
                        _ => (),
                    }
                }
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
