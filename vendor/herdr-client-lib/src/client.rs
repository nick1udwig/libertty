//! Framed core connection with bounded channels and explicit request deadlines.
use crate::protocol::{
    AttachParams, DocGetResult, ExecParams, ExecResult, Hello, ListParams, MachineList, ReadResult,
    RunParams, Snapshot, Terminal, TerminalList,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter},
    sync::{mpsc, oneshot},
    task::AbortHandle,
};
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
static GENERATION: AtomicU64 = AtomicU64::new(1);
const CREDIT: usize = 256 * 1024;
#[derive(Clone, Debug)]
pub enum Error {
    Io(String),
    Protocol(String),
    Rpc(Value),
    Timeout,
    Disconnected,
    SlowConsumer,
    /// A workspace edit was rejected; nothing was sent to core.
    Document(crate::document::Error),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(text) | Self::Protocol(text) => f.write_str(text),
            Self::Rpc(value) => match value["message"].as_str() {
                Some(message) => f.write_str(message),
                None => write!(f, "core error: {value}"),
            },
            Self::Timeout => f.write_str("core did not answer in time"),
            Self::Disconnected => f.write_str("disconnected from core"),
            Self::SlowConsumer => f.write_str("terminal output fell behind"),
            Self::Document(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
impl From<crate::document::Error> for Error {
    fn from(e: crate::document::Error) -> Self {
        Self::Document(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Protocol(format!("unexpected core reply: {e}"))
    }
}
impl Error {
    pub fn kind(&self) -> Option<&str> {
        match self {
            Self::Rpc(v) => v["data"]["kind"].as_str(),
            _ => None,
        }
    }
}
#[derive(Debug)]
struct Frame {
    channel: u32,
    kind: u8,
    data: Vec<u8>,
}
struct Route {
    tx: mpsc::Sender<Result<Frame, Error>>,
    rx: Option<mpsc::Receiver<Result<Frame, Error>>>,
    queued: usize,
    failure: Arc<Mutex<Option<Error>>>,
}
struct State {
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    routes: HashMap<u32, Route>,
    retired: HashSet<u32>,
    dead: bool,
}
struct Inner {
    state: Mutex<State>,
    output: mpsc::Sender<Frame>,
    control: mpsc::Sender<Frame>,
    sequence: AtomicU64,
    tasks: Mutex<Vec<AbortHandle>>,
    hello: Value,
    typed_hello: Hello,
    generation: u64,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}
#[derive(Clone)]
pub struct Client(Arc<Inner>);
struct Reply {
    value: Option<Result<Value, Error>>,
    channel: Option<(Weak<Inner>, u32)>,
}
impl Reply {
    fn accept(mut self) -> Result<Value, Error> {
        self.channel = None;
        self.value.take().unwrap()
    }
}
impl Drop for Reply {
    fn drop(&mut self) {
        if let Some((inner, channel)) = self
            .channel
            .take()
            .and_then(|(weak, channel)| weak.upgrade().map(|inner| (inner, channel)))
        {
            let _ = retire(&inner, &mut inner.state.lock().unwrap(), channel);
        }
    }
}
struct Pending {
    inner: Weak<Inner>,
    id: u64,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(i) = self.inner.upgrade() {
            i.state.lock().unwrap().pending.remove(&self.id);
        }
    }
}
impl Client {
    pub async fn connect<T: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        mut transport: T,
        deadline: Duration,
    ) -> Result<Self, Error> {
        let hello=tokio::time::timeout(deadline,async {
            transport.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"hello\",\"params\":{\"framed\":true,\"generation\":1}}\n").await?;
            transport.flush().await?;
            let mut bytes=Vec::new();
            loop { let byte=transport.read_u8().await?; if byte==b'\n' { break; }
            if bytes.len()>=MAX_FRAME {return Err(Error::Protocol("hello too large".into()));} bytes.push(byte); }
            let v:Value=serde_json::from_slice(&bytes).map_err(|e|Error::Protocol(e.to_string()))?;
            if let Some(e)=v.get("error") { return Err(Error::Rpc(e.clone())); }
            v.get("result").cloned().ok_or_else(||Error::Protocol("hello has no result".into()))
        }).await.map_err(|_|Error::Timeout)??;
        if hello["generation"] != 1 || hello["framed"] != true {
            return Err(Error::Protocol("unsupported handshake".into()));
        }
        let (read, write) = tokio::io::split(transport);
        let mut read = BufReader::with_capacity(64 * 1024, read);
        let mut write = BufWriter::with_capacity(64 * 1024, write);
        let (tx, mut rx) = mpsc::channel::<Frame>(64);
        let (control, mut controls) = mpsc::channel::<Frame>(256);
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                pending: HashMap::new(),
                routes: HashMap::new(),
                retired: HashSet::new(),
                dead: false,
            }),
            output: tx,
            control,
            sequence: AtomicU64::new(1),
            tasks: Mutex::new(Vec::new()),
            typed_hello: serde_json::from_value(hello.clone())?,
            hello,
            generation: GENERATION.fetch_add(1, Ordering::Relaxed),
        });
        let weak = Arc::downgrade(&inner);
        let writer = tokio::spawn(async move {
            loop {
                let frame =
                    tokio::select! { biased; frame=controls.recv()=>frame, frame=rx.recv()=>frame };
                let Some(frame) = frame else {
                    break;
                };
                let result = write_batch(&mut write, frame, &mut controls, &mut rx).await;
                if let Err(e) = result {
                    fail(&weak, e.into());
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&inner);
        let reader = tokio::spawn(async move {
            loop {
                match read_frame(&mut read).await {
                    Ok(frame) => {
                        if let Some(inner) = weak.upgrade() {
                            if let Err(e) = route(&inner, frame) {
                                fail(&weak, e);
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    Err(e) => {
                        fail(&weak, e);
                        break;
                    }
                }
            }
        });
        inner
            .tasks
            .lock()
            .unwrap()
            .extend([writer.abort_handle(), reader.abort_handle()]);
        Ok(Self(inner))
    }
    pub fn generation(&self) -> u64 {
        self.0.generation
    }
    pub fn supports(&self, method: &str) -> bool {
        self.0.hello["methods"]
            .as_array()
            .is_some_and(|methods| methods.iter().any(|m| m == method))
    }
    /// The handshake reply as received, including fields newer cores add.
    pub fn capabilities(&self) -> &Value {
        &self.0.hello
    }
    pub fn hello(&self) -> &Hello {
        &self.0.typed_hello
    }
    /// The permanent id of the core this connection reaches.
    pub fn core_id(&self) -> &str {
        &self.0.typed_hello.core.id
    }
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, Error> {
        let id = self.0.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.0.state.lock().unwrap();
            if state.dead {
                return Err(Error::Disconnected);
            }
            state.pending.insert(id, tx);
        }
        let _pending = Pending {
            inner: Arc::downgrade(&self.0),
            id,
        };
        let data =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .unwrap();
        if data.len() > MAX_FRAME {
            return Err(Error::Protocol("request too large".into()));
        }
        tokio::time::timeout(deadline, async {
            self.0
                .output
                .send(Frame {
                    channel: 0,
                    kind: 0,
                    data,
                })
                .await
                .map_err(|_| Error::Disconnected)?;
            rx.await.map_err(|_| Error::Disconnected)?.accept()
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
    /// A typed call; use `call` for methods this library does not wrap.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: &P,
        deadline: Duration,
    ) -> Result<R, Error> {
        let result = self
            .call(method, serde_json::to_value(params)?, deadline)
            .await?;
        Ok(serde_json::from_value(result)?)
    }
    pub async fn attach(
        &self,
        params: &AttachParams,
        deadline: Duration,
    ) -> Result<(Terminal, Stream), Error> {
        let result = self
            .call("terminal.attach", serde_json::to_value(params)?, deadline)
            .await?;
        let stream = self.stream(&result)?;
        Ok((serde_json::from_value(result["terminal"].clone())?, stream))
    }
    pub async fn subscribe(&self, deadline: Duration) -> Result<(Snapshot, Stream), Error> {
        let result = self.call("events.subscribe", json!({}), deadline).await?;
        let stream = self.stream(&result)?;
        Ok((serde_json::from_value(result)?, stream))
    }
    pub async fn terminal_list(
        &self,
        params: &ListParams,
        deadline: Duration,
    ) -> Result<TerminalList, Error> {
        self.request("terminal.list", params, deadline).await
    }
    pub async fn terminal_get(
        &self,
        terminal: &str,
        deadline: Duration,
    ) -> Result<Terminal, Error> {
        self.request("terminal.get", &json!({"terminal":terminal}), deadline)
            .await
    }
    /// Starts one program. Never retry it after an uncertain outcome; look it up by label.
    pub async fn terminal_run(
        &self,
        params: &RunParams,
        deadline: Duration,
    ) -> Result<Terminal, Error> {
        self.request("terminal.run", params, deadline).await
    }
    pub async fn terminal_kill(
        &self,
        terminal: &str,
        deadline: Duration,
    ) -> Result<Terminal, Error> {
        self.request("terminal.kill", &json!({"terminal":terminal}), deadline)
            .await
    }
    pub async fn terminal_keep(
        &self,
        terminal: &str,
        keep: bool,
        deadline: Duration,
    ) -> Result<Terminal, Error> {
        self.request(
            "terminal.keep",
            &json!({"terminal":terminal,"keep":keep}),
            deadline,
        )
        .await
    }
    /// Sets labels; an empty value removes one.
    pub async fn terminal_label(
        &self,
        terminal: &str,
        labels: &std::collections::BTreeMap<String, String>,
        deadline: Duration,
    ) -> Result<Terminal, Error> {
        self.request(
            "terminal.label",
            &json!({"terminal":terminal,"labels":labels}),
            deadline,
        )
        .await
    }
    pub async fn terminal_read(
        &self,
        terminal: &str,
        lines: usize,
        deadline: Duration,
    ) -> Result<ReadResult, Error> {
        self.request(
            "terminal.read",
            &json!({"terminal":terminal,"lines":lines}),
            deadline,
        )
        .await
    }
    pub async fn doc_get(
        &self,
        name: &str,
        on: Option<&str>,
        deadline: Duration,
    ) -> Result<DocGetResult, Error> {
        self.request("doc.get", &json!({"name":name,"on":on}), deadline)
            .await
    }
    /// Writes only if `version` is current; returns the new version.
    pub async fn doc_set(
        &self,
        name: &str,
        on: Option<&str>,
        value: &Value,
        version: u64,
        deadline: Duration,
    ) -> Result<u64, Error> {
        let result = self
            .call(
                "doc.set",
                json!({"name":name,"on":on,"value":value,"version":version}),
                deadline,
            )
            .await?;
        result["version"]
            .as_u64()
            .ok_or_else(|| Error::Protocol("write outcome uncertain".into()))
    }
    pub async fn machine_list(&self, deadline: Duration) -> Result<MachineList, Error> {
        self.request("machine.list", &json!({}), deadline).await
    }
    pub async fn machine_exec(
        &self,
        params: &ExecParams,
        deadline: Duration,
    ) -> Result<ExecResult, Error> {
        self.request("machine.exec", params, deadline).await
    }
    fn stream(&self, result: &Value) -> Result<Stream, Error> {
        let channel = result["channel"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n != 0)
            .ok_or_else(|| Error::Protocol("missing channel".into()))?;
        let mut state = self.0.state.lock().unwrap();
        if state.retired.contains(&channel) {
            return Err(Error::SlowConsumer);
        }
        if !state.routes.contains_key(&channel) && state.routes.len() + state.retired.len() >= 256 {
            return Err(Error::Protocol("channel limit".into()));
        }
        let route = state.routes.entry(channel).or_insert_with(new_route);
        let rx = route
            .rx
            .take()
            .ok_or_else(|| Error::Protocol("channel reused".into()))?;
        Ok(Stream {
            client: self.clone(),
            channel,
            rx,
            failure: route.failure.clone(),
            closed: false,
        })
    }
}
fn new_route() -> Route {
    let (tx, rx) = mpsc::channel(64);
    Route {
        tx,
        rx: Some(rx),
        queued: 0,
        failure: Arc::new(Mutex::new(None)),
    }
}
fn fail(weak: &Weak<Inner>, error: Error) {
    if let Some(inner) = weak.upgrade() {
        let mut state = inner.state.lock().unwrap();
        state.dead = true;
        for (_, tx) in state.pending.drain() {
            let _ = tx.send(Reply {
                value: Some(Err(error.clone())),
                channel: None,
            });
        }
        for (_, route) in state.routes.drain() {
            let _ = route.tx.try_send(Err(error.clone()));
        }
    }
}
async fn write_frame<W: AsyncWrite + Unpin>(write: &mut W, frame: &Frame) -> std::io::Result<()> {
    let mut header = [0; 9];
    header[..4].copy_from_slice(&frame.channel.to_le_bytes());
    header[4] = frame.kind;
    header[5..].copy_from_slice(&(frame.data.len() as u32).to_le_bytes());
    write.write_all(&header).await?;
    write.write_all(&frame.data).await
}

fn merge_credit(frame: &mut Frame, next: &Frame) -> bool {
    if frame.kind != 1 || next.kind != 1 || frame.channel != next.channel {
        return false;
    }
    let (Ok(a), Ok(b)) = (
        frame.data.as_slice().try_into(),
        next.data.as_slice().try_into(),
    ) else {
        return false;
    };
    let Some(total) = u32::from_le_bytes(a).checked_add(u32::from_le_bytes(b)) else {
        return false;
    };
    frame.data.copy_from_slice(&total.to_le_bytes());
    true
}

async fn write_batch<W: AsyncWrite + Unpin>(
    write: &mut W,
    mut frame: Frame,
    controls: &mut mpsc::Receiver<Frame>,
    queued: &mut mpsc::Receiver<Frame>,
) -> std::io::Result<()> {
    let mut bytes = frame.data.len();
    for _ in 1..64 {
        if bytes >= CREDIT {
            break;
        }
        let Some(next) = controls.try_recv().ok().or_else(|| queued.try_recv().ok()) else {
            break;
        };
        bytes += next.data.len();
        if !merge_credit(&mut frame, &next) {
            write_frame(write, &frame).await?;
            frame = next;
        }
    }
    write_frame(write, &frame).await?;
    write.flush().await
}

async fn read_frame<R: AsyncRead + Unpin>(read: &mut R) -> Result<Frame, Error> {
    let mut header = [0; 9];
    read.read_exact(&mut header).await?;
    let channel = u32::from_le_bytes(header[..4].try_into().unwrap());
    let kind = header[4];
    let size = u32::from_le_bytes(header[5..].try_into().unwrap()) as usize;
    if size > MAX_FRAME || kind > 5 {
        return Err(Error::Protocol("invalid frame header".into()));
    }
    let mut data = vec![0; size];
    read.read_exact(&mut data).await?;
    Ok(Frame {
        channel,
        kind,
        data,
    })
}
fn route(inner: &Arc<Inner>, frame: Frame) -> Result<(), Error> {
    let mut state = inner.state.lock().unwrap();
    if frame.channel == 0 {
        if frame.kind != 0 {
            return Err(Error::Protocol("invalid RPC frame".into()));
        }
        let v: Value =
            serde_json::from_slice(&frame.data).map_err(|e| Error::Protocol(e.to_string()))?;
        let channel = v["result"]["channel"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n != 0);
        let tx = v["id"].as_u64().and_then(|id| state.pending.remove(&id));
        let result = if let Some(error) = v.get("error") {
            Err(Error::Rpc(error.clone()))
        } else {
            v.get("result")
                .cloned()
                .ok_or_else(|| Error::Protocol("missing result".into()))
        };
        let reply = Reply {
            value: Some(result),
            channel: channel.map(|channel| (Arc::downgrade(inner), channel)),
        };
        drop(state);
        if let Some(tx) = tx {
            let _ = tx.send(reply);
        }
        return Ok(());
    }
    if state.retired.contains(&frame.channel) {
        if frame.kind == 2 {
            state.retired.remove(&frame.channel);
        }
        return Ok(());
    }
    if frame.kind == 2 && !state.routes.contains_key(&frame.channel) && frame.data.is_empty() {
        return Ok(());
    }
    if !state.routes.contains_key(&frame.channel) && state.routes.len() + state.retired.len() >= 256
    {
        return Err(Error::Protocol("too many unclaimed channels".into()));
    }
    let channel = frame.channel;
    let route = state.routes.entry(channel).or_insert_with(new_route);
    if frame.kind != 0 && frame.kind != 2 {
        return Err(Error::Protocol("invalid server stream frame".into()));
    }
    route.queued += frame.data.len();
    if route.queued > CREDIT || route.tx.try_send(Ok(frame)).is_err() {
        if let Some(route) = state.routes.get(&channel) {
            *route.failure.lock().unwrap() = Some(Error::SlowConsumer);
        }
        retire(inner, &mut state, channel)?;
    }
    Ok(())
}
fn retire(inner: &Inner, state: &mut State, channel: u32) -> Result<(), Error> {
    state.routes.remove(&channel);
    if state.retired.insert(channel) {
        inner
            .control
            .try_send(Frame {
                channel,
                kind: 2,
                data: Vec::new(),
            })
            .map_err(|_| Error::Disconnected)?;
    }
    Ok(())
}
pub struct Stream {
    client: Client,
    channel: u32,
    rx: mpsc::Receiver<Result<Frame, Error>>,
    failure: Arc<Mutex<Option<Error>>>,
    closed: bool,
}
#[derive(Debug)]
pub enum StreamEvent {
    Data(Vec<u8>),
    Closed(Value),
}
impl Stream {
    pub async fn next(&mut self) -> Result<Option<StreamEvent>, Error> {
        std::future::poll_fn(|cx| self.poll_next(cx)).await
    }
    /// Poll without allocating a future for each stream in a multiplexed client.
    pub fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Result<Option<StreamEvent>, Error>> {
        if self.closed {
            return Poll::Ready(Ok(None));
        }
        if let Some(error) = self.failure.lock().unwrap().take() {
            self.closed = true;
            return Poll::Ready(Err(error));
        }
        let received = std::task::ready!(self.rx.poll_recv(cx));
        if let Some(error) = self.failure.lock().unwrap().take() {
            self.closed = true;
            return Poll::Ready(Err(error));
        }
        Poll::Ready(self.receive(received))
    }
    fn receive(
        &mut self,
        received: Option<Result<Frame, Error>>,
    ) -> Result<Option<StreamEvent>, Error> {
        let frame = received.ok_or(Error::Disconnected)??;
        {
            if let Some(route) = self
                .client
                .0
                .state
                .lock()
                .unwrap()
                .routes
                .get_mut(&self.channel)
            {
                route.queued = route.queued.saturating_sub(frame.data.len());
            }
        }
        if frame.kind == 2 {
            self.closed = true;
            return Ok(Some(StreamEvent::Closed(if frame.data.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&frame.data).map_err(|e| Error::Protocol(e.to_string()))?
            })));
        }
        Ok(Some(StreamEvent::Data(frame.data)))
    }
    /// Return credit only after the caller has processed these bytes.
    pub async fn consumed(&self, bytes: u32) -> Result<(), Error> {
        self.send(1, bytes.to_le_bytes().to_vec()).await
    }
    pub async fn input(&self, bytes: Vec<u8>) -> Result<(), Error> {
        for chunk in bytes.chunks(CREDIT) {
            self.send(0, chunk.to_vec()).await?;
        }
        Ok(())
    }
    /// Queue input without waiting. Queue pressure rejects the entire input.
    pub fn try_input(&self, bytes: Vec<u8>) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Disconnected);
        }
        let permits = self
            .client
            .0
            .output
            .try_reserve_many(bytes.len().div_ceil(CREDIT))
            .map_err(|e| Error::Protocol(format!("input queue unavailable: {e}")))?;
        for (permit, chunk) in permits.zip(bytes.chunks(CREDIT)) {
            permit.send(Frame {
                channel: self.channel,
                kind: 0,
                data: chunk.to_vec(),
            });
        }
        Ok(())
    }
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), Error> {
        self.send(3, [cols.to_le_bytes(), rows.to_le_bytes()].concat())
            .await
    }
    pub async fn focus(&self, focused: bool) -> Result<(), Error> {
        self.send(4, vec![u8::from(focused)]).await
    }
    pub async fn display(&self, facts: Value) -> Result<(), Error> {
        self.send(5, serde_json::to_vec(&facts).unwrap()).await
    }
    pub async fn detach(mut self) -> Result<(), Error> {
        retire(
            &self.client.0,
            &mut self.client.0.state.lock().unwrap(),
            self.channel,
        )?;
        self.closed = true;
        Ok(())
    }
    async fn send(&self, kind: u8, data: Vec<u8>) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Disconnected);
        }
        if data.len() > MAX_FRAME {
            return Err(Error::Protocol("frame too large".into()));
        }
        self.client
            .0
            .output
            .send(Frame {
                channel: self.channel,
                kind,
                data,
            })
            .await
            .map_err(|_| Error::Disconnected)
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        let mut state = self.client.0.state.lock().unwrap();
        if !self.closed {
            let _ = retire(&self.client.0, &mut state, self.channel);
        } else {
            state.routes.remove(&self.channel);
        }
    }
}

/// Decode event JSON independently of stream frame boundaries.
/// Credit is returned after bytes enter the bounded decoder buffer.
pub struct Notifications {
    stream: Stream,
    buffer: Vec<u8>,
    credit: u32,
}
impl Notifications {
    pub fn new(stream: Stream) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
            credit: 0,
        }
    }
    /// Cancellation preserves buffered bytes and pending credit.
    pub async fn next(&mut self) -> Result<Option<Value>, Error> {
        loop {
            if self.credit != 0 {
                self.stream.consumed(self.credit).await?;
                self.credit = 0;
            }
            let mut decoder =
                serde_json::Deserializer::from_slice(&self.buffer).into_iter::<Value>();
            match decoder.next() {
                Some(Ok(value)) => {
                    let consumed = decoder.byte_offset();
                    self.buffer.drain(..consumed);
                    return Ok(Some(value));
                }
                Some(Err(error)) if !error.is_eof() => {
                    return Err(Error::Protocol(error.to_string()));
                }
                None => self.buffer.clear(),
                _ => (),
            }
            match self.stream.next().await? {
                Some(StreamEvent::Data(bytes)) => {
                    if self.buffer.len().saturating_add(bytes.len()) > MAX_FRAME {
                        return Err(Error::Protocol("notification exceeds frame limit".into()));
                    }
                    self.credit = bytes.len() as u32;
                    self.buffer.extend_from_slice(&bytes);
                }
                _ if self.buffer.iter().all(u8::is_ascii_whitespace) => return Ok(None),
                _ => return Err(Error::Protocol("truncated notification".into())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    #[derive(Default)]
    struct Writer {
        bytes: Vec<u8>,
        writes: usize,
        flushes: usize,
    }
    impl AsyncWrite for Writer {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.writes += 1;
            self.bytes.extend_from_slice(bytes);
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            self.flushes += 1;
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }
    fn credit(channel: u32, bytes: u32) -> Frame {
        Frame {
            channel,
            kind: 1,
            data: bytes.to_le_bytes().to_vec(),
        }
    }
    #[tokio::test]
    async fn queued_frames_share_one_write_without_delaying_sparse_credit() {
        let (_control, mut controls) = mpsc::channel(4);
        let (tx, mut rx) = mpsc::channel(4);
        tx.send(credit(1, 7)).await.unwrap();
        tx.send(Frame {
            channel: 1,
            kind: 0,
            data: b"input".to_vec(),
        })
        .await
        .unwrap();
        tx.send(credit(2, 11)).await.unwrap();
        let mut writer = BufWriter::new(Writer::default());
        write_batch(&mut writer, credit(1, 5), &mut controls, &mut rx)
            .await
            .unwrap();
        assert_eq!(writer.get_ref().writes, 1);
        assert_eq!(writer.get_ref().flushes, 1);
        let mut bytes = writer.get_ref().bytes.as_slice();
        let first = read_frame(&mut bytes).await.unwrap();
        assert_eq!(
            (first.channel, first.kind, first.data),
            (1, 1, 12u32.to_le_bytes().to_vec())
        );
        assert_eq!(read_frame(&mut bytes).await.unwrap().data, b"input");
        let last = read_frame(&mut bytes).await.unwrap();
        assert_eq!((last.channel, last.data), (2, 11u32.to_le_bytes().to_vec()));
        assert!(bytes.is_empty());
        write_batch(&mut writer, credit(1, 1), &mut controls, &mut rx)
            .await
            .unwrap();
        assert_eq!(writer.get_ref().writes, 2);
        assert_eq!(writer.get_ref().flushes, 2);
    }
    #[tokio::test]
    async fn batches_preserve_control_priority_and_leave_excess_frames_queued() {
        let (control, mut controls) = mpsc::channel(128);
        let (tx, mut rx) = mpsc::channel(128);
        control
            .send(Frame {
                channel: 9,
                kind: 2,
                data: vec![],
            })
            .await
            .unwrap();
        for _ in 0..100 {
            tx.send(credit(1, 1)).await.unwrap();
        }
        let mut writer = BufWriter::new(Writer::default());
        write_batch(&mut writer, credit(1, 1), &mut controls, &mut rx)
            .await
            .unwrap();
        assert_eq!(rx.len(), 38);
        let mut bytes = writer.get_ref().bytes.as_slice();
        assert_eq!(
            read_frame(&mut bytes).await.unwrap().data,
            1u32.to_le_bytes()
        );
        let close = read_frame(&mut bytes).await.unwrap();
        assert_eq!((close.channel, close.kind), (9, 2));
        assert_eq!(
            read_frame(&mut bytes).await.unwrap().data,
            62u32.to_le_bytes()
        );
        assert!(bytes.is_empty());
        assert!(!merge_credit(&mut credit(1, u32::MAX), &credit(1, 1)));
    }
}
