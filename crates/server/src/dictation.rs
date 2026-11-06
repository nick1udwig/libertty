pub use crate::voxtype::{compatible, detect, install_command};
use crate::{dictation_profile as profile, protocol::DictationState, storage, voxtype};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
pub(crate) const UPLOAD_WINDOW: u32 = 16;
pub const MAX_OPUS_BYTES: usize = profile::MAX_ENCODED_BYTES as usize;
pub const MAX_OPUS_FRAMES: u64 = profile::MAX_FRAMES as u64;
pub const MAX_AUDIO_SAMPLES: u32 = profile::SAMPLE_RATE * profile::MAX_SECONDS;
pub struct OpusFrame<'a> {
    pub sequence: u64,
    pub first: bool,
    pub final_frame: bool,
    pub pre_skip: u16,
    pub total_samples: u32,
    packets: [&'a [u8]; profile::BATCH_PACKETS as usize],
    packet_count: u8,
}
impl<'a> OpusFrame<'a> {
    pub fn packets(&self) -> &[&'a [u8]] {
        &self.packets[..self.packet_count as usize]
    }
}
const _: () = assert!(profile::MAX_FRAMES == MAX_AUDIO_SAMPLES / profile::FRAME_SAMPLES + 2);
pub fn parse_opus_frame(bytes: &[u8]) -> Result<OpusFrame<'_>, String> {
    if !(17..=17 + profile::BATCH_PACKETS as usize * 1277).contains(&bytes.len()) {
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
        || u32::from(count) > profile::BATCH_PACKETS
        || (count == 0 && !final_frame)
    {
        return Err("Invalid Opus frame header.".into());
    }
    let mut packets: [&[u8]; profile::BATCH_PACKETS as usize] =
        [&[]; profile::BATCH_PACKETS as usize];
    let mut offset = 17;
    for packet in packets.iter_mut().take(count as usize) {
        if offset + 2 > bytes.len() {
            return Err("Truncated Opus packet.".into());
        }
        let length = u16::from_be_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;
        if !(1..=1275).contains(&length) || offset + length > bytes.len() {
            return Err("Invalid Opus packet size.".into());
        }
        *packet = &bytes[offset..offset + length];
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
        packet_count: count,
    })
}
enum Control {
    Audio(Vec<u8>),
    Finish,
}
#[derive(Clone, Copy, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "DictationCheckpoint"))]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub accepted_frames: u64,
    pub finished: bool,
    pub upload_window: u32,
    pub max_samples: u32,
    pub max_encoded_bytes: usize,
}
pub type ProgressCallback = Arc<dyn Fn(u64) + Send + Sync>;
pub type ReadyCallback = Arc<dyn Fn(Checkpoint) + Send + Sync>;
struct Resume {
    session: String,
    ready: Option<ReadyCallback>,
    progress: Option<ProgressCallback>,
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
pub type StatusCallback = Arc<dyn Fn(DictationState, Option<String>) + Send + Sync>;
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
        Self::start_config(env, result, status, storage::random_hex(16), None, None)
    }
    pub fn start_resumable(
        env: BTreeMap<String, String>,
        session: String,
        result: AsyncResultCallback,
        status: StatusCallback,
        ready: ReadyCallback,
        progress: ProgressCallback,
    ) -> Self {
        Self::start_config(env, result, status, session, Some(ready), Some(progress))
    }
    fn start_config(
        env: BTreeMap<String, String>,
        result: AsyncResultCallback,
        status: StatusCallback,
        session: String,
        ready: Option<ReadyCallback>,
        progress: Option<ProgressCallback>,
    ) -> Self {
        let (control, receive) = mpsc::channel(UPLOAD_WINDOW as usize + 1);
        let cancel = CancellationToken::new();
        let failure = Arc::new(Mutex::new(None));
        let done = Arc::new(AtomicBool::new(false));
        let detached = Arc::new(AtomicBool::new(false));
        let resume = Resume {
            session,
            ready,
            progress,
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
                status(DictationState::Error, Some(error));
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
async fn close(socket: &mut voxtype::Socket, kind: &str) {
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        socket
            .send(Message::Text(json!({"type":kind}).to_string().into()))
            .await?;
        socket.close(None).await
    })
    .await;
}
async fn send<S: futures::Sink<Message> + Unpin>(
    socket: &mut S,
    message: Message,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(10));
    tokio::time::timeout_at(deadline, socket.send(message))
        .await
        .map_err(|_| "Dictation upload timed out.")?
        .map_err(|_| "Could not connect to Voxtype.".into())
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
    let socket = tokio::select! {
        biased;
        _ = cancel.cancelled() => return failure.lock().unwrap().clone().map_or(Ok(()), Err),
        socket = tokio::time::timeout_at(deadline, voxtype::recording(&env, &resume.session)) =>
            socket.map_err(|_| "Dictation timed out.")?,
    };
    let mut socket = socket?;
    let mut ready = false;
    let mut finishing = false;
    let mut audio_final = false;
    let mut frames = 0;
    let mut accepted_frames = 0;
    let mut bytes = 0;
    let mut max_bytes = MAX_OPUS_BYTES;
    let mut max_samples = MAX_AUDIO_SAMPLES;
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
                        send(&mut socket, Message::Binary(encoded.into()), deadline).await?;
                        if let Some(progress) = &resume.progress { progress(frames); }
                    },
                    Some(Control::Finish)=>{
                        if !ready||finishing{continue}
                        if !audio_final && (accepted_frames == 0 || frames != accepted_frames) {return Err("Recording ended without complete Opus audio.".into())}
                        finishing=true;
                        send(&mut socket, Message::Text(json!({"type":"finish"}).to_string().into()), deadline).await?;
                    },
                    None=>return Ok(false),
                },
                message=socket.next()=> {
                    let message=message.ok_or("Voxtype disconnected. Please try again.")?.map_err(|_|"Could not connect to Voxtype.")?;
                    if let Message::Ping(bytes)=message {send(&mut socket, Message::Pong(bytes), deadline).await?;continue}
                    if matches!(message,Message::Close(_)){return Err("Voxtype disconnected. Please try again.".into())}
                    if matches!(message,Message::Pong(_)){continue}
                    match voxtype::event(&message.into_data())? {
                        voxtype::Event::Ready(checkpoint) if !ready => {
                            if resume.ready.is_none() && (checkpoint.accepted_frames != 0 || checkpoint.finished) {
                                return Err("Unsupported Voxtype audio format. Update libertty and Voxtype together.".into());
                            }
                            frames = checkpoint.accepted_frames;
                            accepted_frames = frames;
                            finishing = checkpoint.finished;
                            audio_final = finishing;
                            max_samples = checkpoint.max_samples;
                            max_bytes = checkpoint.max_encoded_bytes;
                            ready = true;
                            deadline = tokio::time::Instant::now() + Duration::from_secs(480);
                            if let Some(callback) = &resume.ready { callback(checkpoint); }
                            else { status(DictationState::Ready, None); }
                        }
                        voxtype::Event::Final(text) => {
                            if !finishing { return Err("Invalid Voxtype result.".into()); }
                            result(text).await?;
                            if cancel.is_cancelled() { return Ok(false); }
                            return Ok(true);
                        }
                        _ => {}
                    }
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
        status(DictationState::Done, None);
    }
    outcome.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_blocked_daemon_write_obeys_the_recording_deadline() {
        let mut socket = Box::pin(futures::sink::unfold((), |(), _: Message| async {
            std::future::pending::<Result<(), std::io::Error>>().await
        }));
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5);
        assert_eq!(
            send(&mut socket, Message::Binary(vec![1].into()), deadline).await,
            Err("Dictation upload timed out.".into())
        );
    }
}
