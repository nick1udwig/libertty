use super::*;
use crate::protocol::{ClientMessage, ServerMessage, ViewerMessage};
use futures::stream::SplitSink;
use tokio::sync::mpsc;
mod pressure;
use pressure::Pressure;

pub(super) async fn upgrade(req: Request<Body>) -> Result<WebSocketUpgrade, Failure> {
    let (mut parts, _) = req.into_parts();
    Ok(WebSocketUpgrade::from_request_parts(&mut parts, &())
        .await
        .map_err(|_| Failure(StatusCode::FORBIDDEN, "Forbidden".into()))?
        .protocols([wire::GZIP, wire::GZIP_FAST, wire::BINARY])
        .max_message_size(128 * 1024)
        .max_frame_size(128 * 1024))
}

pub(super) enum Input<'a> {
    Native {
        session: &'a Arc<Session>,
        attachment: u64,
    },
    Herdr(&'a Arc<herdr_view::View>),
    Metadata {
        app: &'a App,
        connection: &'a str,
        owner: &'a str,
        source: &'a str,
        target: &'a herdr::Target,
    },
}
impl Input<'_> {
    fn invalid_text(&self) -> &'static str {
        if matches!(self, Self::Native { .. }) {
            "Invalid message"
        } else {
            "Invalid terminal message"
        }
    }
    fn message(
        &self,
        message: ClientMessage,
        pressure: &mut Pressure,
    ) -> Result<bool, &'static str> {
        if let ClientMessage::Ack { seq } = &message {
            pressure.acknowledge(*seq, std::time::Instant::now());
        }
        if let ClientMessage::Ping { checkpoint } = &message {
            if *checkpoint {
                match self {
                    Self::Native {
                        session,
                        attachment,
                    } => session.checkpoint(*attachment),
                    Self::Herdr(view) => view.checkpoint(),
                    Self::Metadata { .. } => {}
                }
            }
            return Ok(true);
        }
        match self {
            Self::Native {
                session,
                attachment,
            } => {
                session.receive(*attachment, message);
                Ok(false)
            }
            Self::Herdr(view) => view
                .receive(message)
                .map(|_| false)
                .map_err(|_| self.invalid_text()),
            Self::Metadata { .. } => Ok(false),
        }
    }
    fn text(&self, text: &str, pressure: &mut Pressure) -> Result<bool, &'static str> {
        if let Self::Metadata {
            app,
            connection,
            owner,
            source,
            target,
        } = self
        {
            if text.len() <= 2048
                && let Ok(message) = serde_json::from_str::<ViewerMessage>(text)
            {
                match message {
                    ViewerMessage::Ping => return Ok(true),
                    ViewerMessage::NotificationPresence { device, focused } => {
                        let _ = app
                            .notifications
                            .presence(connection, owner, &device, focused);
                    }
                    ViewerMessage::NotificationAck { device, event } => {
                        let _ = app
                            .notifications
                            .acknowledge(owner, &device, source, target, &event);
                    }
                }
            }
            return Ok(false);
        }
        let message =
            serde_json::from_str::<ClientMessage>(text).map_err(|_| self.invalid_text())?;
        self.message(message, pressure)
    }
    fn audio(&self, bytes: Vec<u8>) {
        match self {
            Self::Native {
                session,
                attachment,
            } => session.receive_binary(*attachment, bytes),
            Self::Herdr(view) => view.audio(bytes),
            Self::Metadata { .. } => {}
        }
    }
    fn binary(&self, bytes: &[u8], pressure: &mut Pressure) -> Result<bool, &'static str> {
        if matches!(self, Self::Metadata { .. }) {
            return Ok(false);
        }
        match wire::decode(bytes).map_err(|_| "Invalid wire message")? {
            wire::Incoming::Audio(audio) => {
                self.audio(audio);
                Ok(false)
            }
            wire::Incoming::Message(message) => self.message(message, pressure),
        }
    }
}

pub(super) enum Output {
    Native(mpsc::UnboundedReceiver<Transport>),
    Herdr(mpsc::Receiver<crate::viewer_queue::Item>),
}
enum Outgoing {
    Native(Transport),
    Herdr(crate::viewer_queue::Item),
}
impl Outgoing {
    fn transport(&self) -> &Transport {
        match self {
            Self::Native(message) => message,
            Self::Herdr(item) => &item.message,
        }
    }
}
impl Output {
    fn queued(&self) -> bool {
        match self {
            Self::Native(receive) => !receive.is_empty(),
            Self::Herdr(receive) => !receive.is_empty(),
        }
    }
    async fn receive(&mut self) -> Option<Outgoing> {
        match self {
            Self::Native(receive) => receive.recv().await.map(Outgoing::Native),
            Self::Herdr(receive) => receive.recv().await.map(Outgoing::Herdr),
        }
    }
}

pub(super) struct Policy {
    cancel: CancellationToken,
    slow: CancellationToken,
    heartbeat: Option<Duration>,
    send_timeout: Option<Duration>,
}
impl Policy {
    /// A vanished viewer must not hold the shell's output window closed.
    pub fn native() -> Self {
        static HEARTBEAT: std::sync::LazyLock<Duration> = std::sync::LazyLock::new(|| {
            #[cfg(debug_assertions)]
            if let Some(milliseconds) = std::env::var("LIBERTTY_TEST_HEARTBEAT_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
            {
                return Duration::from_millis(milliseconds);
            }
            Duration::from_secs(30)
        });
        Self {
            cancel: CancellationToken::new(),
            slow: CancellationToken::new(),
            heartbeat: Some(*HEARTBEAT),
            send_timeout: Some(Duration::from_secs(20)),
        }
    }
    pub fn herdr(cancel: CancellationToken, slow: CancellationToken, heartbeat: bool) -> Self {
        Self {
            cancel,
            slow,
            heartbeat: heartbeat.then_some(Duration::from_secs(30)),
            send_timeout: Some(Duration::from_secs(5)),
        }
    }
}
type Sender = SplitSink<WebSocket, Message>;

async fn send(sender: &mut Sender, message: Message, deadline: Option<Duration>) -> bool {
    let work = sender.send(message);
    if let Some(deadline) = deadline {
        matches!(tokio::time::timeout(deadline, work).await, Ok(Ok(())))
    } else {
        work.await.is_ok()
    }
}
async fn close(sender: &mut Sender, code: u16, reason: &str, deadline: Option<Duration>) {
    send(
        sender,
        Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })),
        deadline,
    )
    .await;
}
fn encode(message: &Transport, mode: wire::Mode) -> Message {
    Message::Binary(
        match message {
            Transport::Server(message) => wire::encode_server(message, mode),
            Transport::Metadata(message) => wire::encode_json(message, mode),
            Transport::Close(..) => unreachable!("close frames are sent separately"),
        }
        .into(),
    )
}

pub(super) async fn pump(socket: WebSocket, input: Input<'_>, mut output: Output, policy: Policy) {
    let mode = wire::Mode::protocol(
        socket
            .protocol()
            .and_then(|protocol| protocol.to_str().ok()),
    );
    let (mut sender, mut receive) = socket.split();
    let pressure = std::sync::Mutex::new(Pressure::default());
    let (control, mut controls) = mpsc::channel(32);
    let reason = {
        let writer = async {
            loop {
                tokio::select! {
                    message = controls.recv() => {
                        let message = message?;
                        if !send(&mut sender, message, policy.send_timeout).await { return None; }
                    }
                    item = output.receive() => {
                        let item = item?;
                        let message = item.transport();
                        if let Transport::Close(code, reason) = message { return Some((*code, reason.clone())); }
                        let started = std::time::Instant::now();
                        let selected = pressure.lock().unwrap().mode(mode, output.queued(), started);
                        let encoded = encode(message, selected);
                        // Acknowledgements can arrive while the writer is flushing.
                        if mode == wire::Mode::GzipFast { pressure.lock().unwrap().sent(message.sequence(), started, started); }
                        // The item retains its byte reservation through the complete send.
                        if !send(&mut sender, encoded, policy.send_timeout).await { return None; }
                        if mode == wire::Mode::GzipFast { pressure.lock().unwrap().sent(None, started, std::time::Instant::now()); }
                    }
                }
            }
        };
        let reader = async {
            let mut heartbeat =
                tokio::time::interval(policy.heartbeat.unwrap_or(Duration::from_secs(30)));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            heartbeat.tick().await;
            let mut alive = true;
            loop {
                let reply = tokio::select! {
                    _ = heartbeat.tick(), if policy.heartbeat.is_some() => {
                        if !alive { return None; }
                        alive = false;
                        Some(Message::Ping(Vec::new().into()))
                    }
                    message = receive.next() => {
                        let Some(Ok(message)) = message else { return None };
                        heartbeat.reset();
                        alive = true;
                        let result = match message {
                            Message::Text(text) => input.text(&text, &mut pressure.lock().unwrap()),
                            Message::Binary(bytes) => input.binary(&bytes, &mut pressure.lock().unwrap()),
                            Message::Ping(bytes) => {
                                if control.try_send(Message::Pong(bytes)).is_err() { return Some((1013, "Control queue is full".into())); }
                                Ok(false)
                            }
                            Message::Pong(_) => Ok(false),
                            Message::Close(_) => return None,
                        };
                        match result {
                            Ok(true) => Some(encode(&Transport::Server(ServerMessage::Pong), mode)),
                            Ok(false) => None,
                            Err(reason) => return Some((1008, reason.into())),
                        }
                    }
                };
                if let Some(reply) = reply
                    && control.try_send(reply).is_err()
                {
                    return Some((1013, "Control queue is full".into()));
                }
            }
        };
        tokio::select! {
            biased;
            _ = policy.slow.cancelled() => Some((1013, "Viewer is too slow; reconnect for a fresh screen.".into())),
            _ = policy.cancel.cancelled() => Some((1000, "Connection closed".into())),
            reason = reader => reason,
            reason = writer => reason,
        }
    };
    if let Some((code, reason)) = reason {
        close(&mut sender, code, &reason, Some(Duration::from_secs(1))).await;
    }
}
