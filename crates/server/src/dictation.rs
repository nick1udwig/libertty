use crate::storage;
use futures::{SinkExt, StreamExt};
use libertty_engine::repair::shell_quote_literal;
use libertty_engine::utf16_len;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;
pub const MAX_OPUS_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_OPUS_FRAMES: u64 = 15002;
pub const MAX_AUDIO_SAMPLES: u32 = 16000 * 300;
pub struct OpusFrame {
    pub sequence: u64,
    pub first: bool,
    pub final_frame: bool,
    pub pre_skip: u16,
    pub total_samples: u32,
    pub packets: Vec<Vec<u8>>,
}
pub fn parse_opus_frame(bytes: &[u8]) -> Result<OpusFrame, String> {
    if !(17..=6402).contains(&bytes.len()) {
        return Err("Invalid Opus frame size.".into());
    }
    let sequence = u64::from_be_bytes(bytes[0..8].try_into().unwrap());
    let flags = bytes[9];
    let pre_skip = u16::from_be_bytes(bytes[10..12].try_into().unwrap());
    let total_samples = u32::from_be_bytes(bytes[12..16].try_into().unwrap());
    let count = bytes[16];
    let first = flags & 1 != 0;
    let final_frame = flags & 2 != 0;
    if sequence >= MAX_OPUS_FRAMES
        || bytes[8] != 1
        || flags > 3
        || first != (sequence == 0)
        || pre_skip > 3840
        || !pre_skip.is_multiple_of(3)
        || (!first && pre_skip != 0)
        || (!final_frame && total_samples != 0)
        || total_samples > MAX_AUDIO_SAMPLES
        || count > 5
        || (count == 0 && !final_frame)
    {
        return Err("Invalid Opus frame header.".into());
    }
    let mut packets = vec![];
    let mut offset = 17;
    for _ in 0..count {
        if offset + 2 > bytes.len() {
            return Err("Truncated Opus packet.".into());
        }
        let length = u16::from_be_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;
        if !(1..=1275).contains(&length) || offset + length > bytes.len() {
            return Err("Invalid Opus packet size.".into());
        }
        packets.push(bytes[offset..offset + length].to_vec());
        offset += length;
    }
    if offset != bytes.len() {
        return Err("Trailing Opus frame bytes.".into());
    }
    Ok(OpusFrame {
        sequence,
        first,
        final_frame,
        pre_skip,
        total_samples,
        packets,
    })
}
fn directory(env: &BTreeMap<String, String>) -> String {
    format!(
        "{}/voxtype-mobile",
        env.get("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| format!(
                "{}/.local/share",
                env.get("HOME").map(String::as_str).unwrap_or("")
            ))
    )
}
async fn configuration(env: &BTreeMap<String, String>) -> Result<(url::Url, String), String> {
    let file = env
        .get("LIBERTTY_VOXTYPE_TOKEN_FILE")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("{}/token", directory(env)));
    let info = tokio::fs::metadata(&file)
        .await
        .map_err(|e| e.to_string())?;
    if info.permissions().mode() & 0o077 != 0 {
        return Err("Voxtype token must be private (chmod 600).".into());
    }
    let raw = tokio::fs::read_to_string(file)
        .await
        .map_err(|e| e.to_string())?;
    let token = raw.trim();
    if utf16_len(token) < 32 || token.contains(['\r', '\n']) {
        return Err("Invalid Voxtype token.".into());
    }
    let url = url::Url::parse(
        env.get("LIBERTTY_VOXTYPE_URL")
            .filter(|v| !v.is_empty())
            .map(String::as_str)
            .unwrap_or("ws://127.0.0.1:8765/v1/dictate"),
    )
    .map_err(|e| e.to_string())?;
    if url.scheme() != "ws"
        || !["127.0.0.1", "[::1]", "localhost"].contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Voxtype must use a local WebSocket endpoint.".into());
    }
    Ok((url, token.into()))
}
pub fn compatible(value: &Value) -> bool {
    value["type"] == "capabilities"
        && value["protocol"].as_f64() == Some(2.0)
        && value["dictation"] == true
        && value["sample_rate"].as_f64() == Some(16000.0)
        && value["channels"].as_f64() == Some(1.0)
        && value["format"] == "opus"
        && value["framing"] == "sequence_opus_v1"
        && value["audio_encodings"]
            .as_array()
            .is_some_and(|a| a.contains(&json!("opus_v1")))
        && value["results"]
            .as_array()
            .is_some_and(|a| a.contains(&json!("final")))
}
async fn connect(
    url: &url::Url,
    token: &str,
    recording: Option<&str>,
    timeout: Duration,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "Invalid Voxtype token.")?,
    );
    if let Some(session) = recording {
        for (name, value) in [("X-Voxtype-Protocol", "2"), ("X-Voxtype-Audio", "opus_v1")] {
            request.headers_mut().insert(name, value.parse().unwrap());
        }
        request.headers_mut().insert(
            "X-Voxtype-Session",
            session.parse().map_err(|_| "Invalid recording session.")?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(if recording.is_some() { 65536 } else { 16384 }))
        .max_frame_size(Some(if recording.is_some() { 65536 } else { 16384 }));
    tokio::time::timeout(
        timeout,
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| "Could not connect to Voxtype.".to_owned())?
    .map(|(socket, _)| socket)
    .map_err(|_| "Could not connect to Voxtype.".into())
}
pub async fn detect(env: &BTreeMap<String, String>) -> Value {
    let file = env
        .get("LIBERTTY_VOXTYPE_TOKEN_FILE")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("{}/token", directory(env)));
    let installed = tokio::fs::metadata(file).await.is_ok()
        || tokio::fs::metadata(format!("{}/voxtype", directory(env)))
            .await
            .is_ok();
    let Ok((mut url, token)) = configuration(env).await else {
        return json!({"installed":installed,"available":false});
    };
    let pathname = url
        .path()
        .strip_suffix("/dictate")
        .map(|prefix| format!("{prefix}/capabilities"))
        .unwrap_or_else(|| url.path().to_owned());
    url.set_path(&pathname);
    let available = tokio::time::timeout(Duration::from_secs(2), async {
        let mut socket = connect(&url, &token, None, Duration::from_millis(1500))
            .await
            .ok()?;
        let event = socket.next().await?;
        let available = event
            .ok()
            .and_then(|message| serde_json::from_slice::<Value>(&message.into_data()).ok())
            .is_some_and(|value| compatible(&value));
        let _ = socket.close(None).await;
        Some(available)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or(false);
    if available {
        json!({"installed":true,"available":true})
    } else {
        json!({"installed":true,"available":false,"reason":"Voxtype is installed but its dictation API is unavailable or needs updating."})
    }
}
pub async fn install_command(env: &BTreeMap<String, String>) -> Result<String, String> {
    let local = env
        .get("LIBERTTY_VOXTYPE_SOURCE")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            format!(
                "{}/git/voxtype-mobile",
                env.get("HOME").map(String::as_str).unwrap_or("")
            )
        });
    let script = format!("{local}/scripts/install");
    if tokio::fs::metadata(&script).await.is_ok() {
        return Ok(format!("bash {}", shell_quote_literal(&script)));
    }
    let address=env.get("LIBERTTY_VOXTYPE_INSTALL_URL").filter(|v|!v.is_empty()).ok_or("Set LIBERTTY_VOXTYPE_INSTALL_URL to the published voxtype-mobile install script, or LIBERTTY_VOXTYPE_SOURCE to its checkout.")?;
    let url = url::Url::parse(address).map_err(|e| e.to_string())?;
    if url.scheme() != "https" {
        return Err("The installer URL must use HTTPS.".into());
    }
    let parts = url
        .path()
        .split('/')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let repository = env
        .get("LIBERTTY_VOXTYPE_REPO")
        .filter(|v| !v.is_empty())
        .cloned()
        .or_else(|| {
            if url.host_str() == Some("raw.githubusercontent.com") && parts.len() >= 4 {
                Some(format!("https://github.com/{}/{}.git", parts[0], parts[1]))
            } else {
                None
            }
        })
        .ok_or("Set LIBERTTY_VOXTYPE_REPO to the repository used by the downloaded installer.")?;
    Ok(format!(
        "(libertty_voxtype_installer=$(mktemp) && trap 'rm -f \"$libertty_voxtype_installer\"' EXIT && curl -fsSL {} -o \"$libertty_voxtype_installer\" && VOXTYPE_MOBILE_REPO={} bash \"$libertty_voxtype_installer\")",
        shell_quote_literal(url.as_str()),
        shell_quote_literal(&repository)
    ))
}
enum Control {
    Audio(Vec<u8>),
    Finish,
}
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub accepted_frames: u64,
    pub finished: bool,
}
pub type ReadyCallback = Arc<dyn Fn(Checkpoint) + Send + Sync>;
struct Resume {
    session: String,
    ready: Option<ReadyCallback>,
    detached: Arc<AtomicBool>,
}
pub struct Recording {
    control: mpsc::Sender<Control>,
    cancel: CancellationToken,
    failure: Arc<Mutex<Option<String>>>,
    done: Arc<AtomicBool>,
    detached: Arc<AtomicBool>,
}
pub type ResultCallback = Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>;
pub type AsyncResultCallback =
    Arc<dyn Fn(String) -> futures::future::BoxFuture<'static, Result<(), String>> + Send + Sync>;
pub type StatusCallback = Arc<dyn Fn(&str, Option<String>) + Send + Sync>;
impl Recording {
    #[cfg(test)]
    pub(crate) fn dormant() -> Self {
        let (control, _) = mpsc::channel(4);
        Self {
            control,
            cancel: CancellationToken::new(),
            failure: Arc::new(Mutex::new(None)),
            done: Arc::new(AtomicBool::new(false)),
            detached: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn start(
        env: BTreeMap<String, String>,
        result: ResultCallback,
        status: StatusCallback,
    ) -> Self {
        Self::start_async(
            env,
            Arc::new(move |text| {
                let result = result.clone();
                Box::pin(async move { result(text) })
            }),
            status,
        )
    }
    pub fn start_async(
        env: BTreeMap<String, String>,
        result: AsyncResultCallback,
        status: StatusCallback,
    ) -> Self {
        Self::start_config(env, result, status, storage::random_hex(16), None)
    }
    pub fn start_resumable(
        env: BTreeMap<String, String>,
        session: String,
        result: AsyncResultCallback,
        status: StatusCallback,
        ready: ReadyCallback,
    ) -> Self {
        Self::start_config(env, result, status, session, Some(ready))
    }
    fn start_config(
        env: BTreeMap<String, String>,
        result: AsyncResultCallback,
        status: StatusCallback,
        session: String,
        ready: Option<ReadyCallback>,
    ) -> Self {
        let (control, receive) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        let failure = Arc::new(Mutex::new(None));
        let done = Arc::new(AtomicBool::new(false));
        let detached = Arc::new(AtomicBool::new(false));
        let resume = Resume {
            session,
            ready,
            detached: detached.clone(),
        };
        let recording = Self {
            control,
            cancel: cancel.clone(),
            failure: failure.clone(),
            done: done.clone(),
            detached,
        };
        tokio::spawn(async move {
            let outcome = run(env, receive, &cancel, &failure, &result, &status, &resume).await;
            done.store(true, Ordering::SeqCst);
            if let Err(error) = outcome {
                status("error", Some(error));
            }
        });
        recording
    }
    pub fn audio(&self, bytes: Vec<u8>) {
        if self.done() {
            return;
        }
        if self.control.try_send(Control::Audio(bytes)).is_err() {
            self.fail(
                "Recording exceeded the audio limit or connection capacity. Please try again.",
            )
        }
    }
    pub fn finish(&self) {
        if !self.done() && self.control.try_send(Control::Finish).is_err() {
            self.fail(
                "Recording exceeded the audio limit or connection capacity. Please try again.",
            )
        }
    }
    pub fn suspend(&self) {
        self.detached.store(true, Ordering::SeqCst);
        self.cancel.cancel();
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
    pub fn done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
    fn fail(&self, message: &str) {
        *self.failure.lock().unwrap() = Some(message.into());
        self.cancel.cancel();
    }
}
impl Drop for Recording {
    fn drop(&mut self) {
        self.cancel();
    }
}
async fn close(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    kind: &str,
) {
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        socket
            .send(Message::Text(json!({"type":kind}).to_string().into()))
            .await?;
        socket.close(None).await
    })
    .await;
}
async fn run(
    env: BTreeMap<String, String>,
    mut control: mpsc::Receiver<Control>,
    cancel: &CancellationToken,
    failure: &Mutex<Option<String>>,
    result: &AsyncResultCallback,
    status: &StatusCallback,
    resume: &Resume,
) -> Result<(), String> {
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let socket = tokio::select! { biased;_=cancel.cancelled()=>return failure.lock().unwrap().clone().map_or(Ok(()),Err),socket=tokio::time::timeout_at(deadline,async {let (url,token)=configuration(&env).await.map_err(|_|"Voxtype is unavailable.")?;connect(&url,&token,Some(&resume.session),Duration::from_secs(3)).await})=>socket.map_err(|_|"Dictation timed out.")?};
    let mut socket = socket?;
    let mut ready = false;
    let mut finishing = false;
    let mut audio_final = false;
    let mut frames = 0;
    let mut accepted_frames = 0;
    let mut bytes = 0;
    let mut max_bytes = MAX_OPUS_BYTES;
    let mut max_samples = MAX_AUDIO_SAMPLES;
    let breaks = regex::Regex::new(r"[\r\n\t]+").unwrap();
    let work = async {
        loop {
            tokio::select! {
                biased;
                _=cancel.cancelled()=>return failure.lock().unwrap().clone().map_or(Ok(false),Err),
                _=tokio::time::sleep_until(deadline)=>return Err("Dictation timed out.".into()),
                command=control.recv()=>match command {
                    Some(Control::Audio(encoded))=>{
                        let frame=parse_opus_frame(&encoded)?;
                        if !ready||finishing||audio_final||frame.sequence!=frames||frame.total_samples>max_samples||bytes+encoded.len()>max_bytes{return Err("Recording exceeded the audio limit or connection capacity. Please try again.".into())}
                        bytes+=encoded.len();frames+=1;audio_final=frame.final_frame;
                        socket.send(Message::Binary(encoded.into())).await.map_err(|_|"Could not connect to Voxtype.")?;
                    },
                    Some(Control::Finish)=>{
                        if !ready||finishing{continue}
                        if !audio_final && (accepted_frames == 0 || frames != accepted_frames) {return Err("Recording ended without complete Opus audio.".into())}
                        finishing=true;
                        socket.send(Message::Text(json!({"type":"finish"}).to_string().into())).await.map_err(|_|"Could not connect to Voxtype.")?;
                    },
                    None=>return Ok(false),
                },
                message=socket.next()=> {
                    let message=message.ok_or("Voxtype disconnected. Please try again.")?.map_err(|_|"Could not connect to Voxtype.")?;
                    if let Message::Ping(bytes)=message {socket.send(Message::Pong(bytes)).await.map_err(|_|"Could not connect to Voxtype.")?;continue}
                    if matches!(message,Message::Close(_)){return Err("Voxtype disconnected. Please try again.".into())}
                    if matches!(message,Message::Pong(_)){continue}
                    let event: Value=serde_json::from_slice(&message.into_data()).map_err(|_|"Invalid Voxtype response.")?;
                    if event["type"]=="ready"&&!ready {
                        if event["protocol"].as_f64()!=Some(2.0)||event["sample_rate"].as_f64()!=Some(16000.0)||event["channels"].as_f64()!=Some(1.0)||event["format"]!="opus"||event["audio_encoding"]!="opus_v1"||event["framing"]!="sequence_opus_v1"||event["resume"]!=true{return Err(concat!(
                            "Unsupported Voxtype audio format. ",
                            "Update libertty and Voxtype together."
                        ).into())}
                        let accepted = crate::protocol::unsigned(&event["accepted_frames"]).filter(|frames| *frames <= MAX_OPUS_FRAMES).ok_or("Invalid Voxtype audio checkpoint.")?;
                        let finished = event["finished"].as_bool().ok_or("Invalid Voxtype audio checkpoint.")?;
                        if resume.ready.is_none() && (accepted != 0 || finished) { return Err(concat!(
                            "Unsupported Voxtype audio format. ",
                            "Update libertty and Voxtype together."
                        ).into()); }
                        frames = accepted; accepted_frames = accepted; finishing = finished; audio_final = finished;
                        max_samples=(event["max_seconds"].as_f64().filter(|n|*n!=0.0).unwrap_or(300.0).clamp(1.0,300.0)*16000.0) as u32;
                        max_bytes=event["max_encoded_bytes"].as_f64().filter(|n|*n!=0.0).unwrap_or(MAX_OPUS_BYTES as f64).clamp(17.0,MAX_OPUS_BYTES as f64) as usize;
                        ready=true;deadline=tokio::time::Instant::now()+Duration::from_secs(480);
                        if let Some(callback) = &resume.ready { callback(Checkpoint { accepted_frames: accepted, finished }); } else { status("ready",None); }
                    } else if event["type"]=="final" {
                        let text=event["text"].as_str().filter(|s|utf16_len(s)<=16000).filter(|_|finishing).ok_or("Invalid Voxtype result.")?;
                        let text=breaks.replace_all(text," ").into_owned();
                        if text.chars().any(|c|c<'\x20'||('\x7f'..='\u{9f}').contains(&c)){return Err("Voxtype returned terminal control characters.".into())}
                        result(text).await?;
                        if cancel.is_cancelled(){return Ok(false)}
                        return Ok(true)
                    } else if event["type"]=="error" {return Err(if event["code"]=="busy"{"Voxtype is busy. Try again after the current dictation."}else{"Voxtype could not transcribe this recording."}.into())}
                }
            }
        }
    };
    let outcome = tokio::select! {biased;_=cancel.cancelled()=>failure.lock().unwrap().clone().map_or(Ok(false),Err),result=work=>result};
    if resume.detached.load(Ordering::SeqCst) {
        let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
        return outcome.map(|_| ());
    }
    close(
        &mut socket,
        if matches!(outcome, Ok(true)) {
            "ack"
        } else {
            "cancel"
        },
    )
    .await;
    if matches!(outcome, Ok(true)) {
        status("done", None);
    }
    outcome.map(|_| ())
}
