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
        Self {
            cancel: CancellationToken::new(),
            slow: CancellationToken::new(),
            heartbeat: Some(Duration::from_secs(30)),
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
enum Event {
    Slow,
    Cancelled,
    Heartbeat,
    Output(Option<Outgoing>),
    Input(Option<Result<Message, axum::Error>>),
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
    let encoded = match message {
        Transport::Server(message) => wire::encode_server(message, mode),
        Transport::Metadata(message) => wire::encode_json(message, mode),
        Transport::Close(..) => unreachable!("close frames are sent separately"),
    };
    if encoded.binary {
        Message::Binary(encoded.bytes.into())
    } else {
        Message::Text(String::from_utf8(encoded.bytes).expect("wire UTF-8").into())
    }
}

pub(super) async fn pump(socket: WebSocket, input: Input<'_>, mut output: Output, policy: Policy) {
    let mode = wire::Mode::protocol(
        socket
            .protocol()
            .and_then(|protocol| protocol.to_str().ok()),
    );
    let (mut sender, mut receive) = socket.split();
    let mut heartbeat = tokio::time::interval(policy.heartbeat.unwrap_or(Duration::from_secs(30)));
    // A blocked send must not turn missed ticks into an immediate disconnect.
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut alive = true;
    let mut pressure = Pressure::default();
    loop {
        let event = tokio::select! {
            biased;
            _ = policy.slow.cancelled() => Event::Slow,
            _ = policy.cancel.cancelled() => Event::Cancelled,
            item = output.receive() => Event::Output(item),
            _ = heartbeat.tick(), if policy.heartbeat.is_some() => Event::Heartbeat,
            message = receive.next() => Event::Input(message),
        };
        match event {
            Event::Slow => {
                close(
                    &mut sender,
                    1013,
                    "Viewer is too slow; reconnect for a fresh screen.",
                    Some(Duration::from_secs(1)),
                )
                .await;
                break;
            }
            Event::Cancelled => {
                close(&mut sender, 1000, "Connection closed", None).await;
                break;
            }
            Event::Output(Some(item)) => match item.transport() {
                Transport::Close(code, reason) => {
                    close(&mut sender, *code, reason, None).await;
                    break;
                }
                message => {
                    // Keep the queue reservation until the in-flight send completes.
                    let started = std::time::Instant::now();
                    let selected = pressure.mode(mode, output.queued(), started);
                    if !send(&mut sender, encode(message, selected), policy.send_timeout).await {
                        break;
                    }
                    if mode == wire::Mode::GzipFast {
                        pressure.sent(message.sequence(), started, std::time::Instant::now());
                    }
                }
            },
            Event::Heartbeat => {
                if !alive {
                    break;
                }
                alive = false;
                if !send(&mut sender, Message::Ping(Vec::new().into()), None).await {
                    break;
                }
            }
            Event::Input(Some(Ok(message))) => {
                heartbeat.reset();
                // Any client traffic proves the viewer is alive, including queued audio ahead of a pong.
                alive = true;
                let result = match message {
                    Message::Text(text) => input.text(&text, &mut pressure),
                    Message::Binary(bytes) => input.binary(&bytes, &mut pressure),
                    Message::Ping(bytes) => {
                        if !send(&mut sender, Message::Pong(bytes), None).await {
                            break;
                        }
                        Ok(false)
                    }
                    Message::Pong(_) => Ok(false),
                    Message::Close(_) => break,
                };
                if matches!(result, Ok(true))
                    && !send(
                        &mut sender,
                        encode(&Transport::Server(ServerMessage::Pong), mode),
                        policy.send_timeout,
                    )
                    .await
                {
                    break;
                }
                if let Err(reason) = result {
                    close(&mut sender, 1008, reason, None).await;
                    break;
                }
            }
            Event::Output(None) | Event::Input(None | Some(Err(_))) => break,
        }
    }
}
