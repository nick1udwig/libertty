use crate::{host::NativeHost, probes::ABORTED};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{RecvTimeoutError, SyncSender, sync_channel},
    },
    time::{Duration, Instant},
};
use termai_engine::{
    Request,
    runtime::{Call, Reply, Runtime, Step},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

enum Message {
    Start {
        job: u64,
        call: Call,
        result: oneshot::Sender<Step>,
        cancelled: Arc<AtomicBool>,
    },
    Resume {
        job: u64,
        replies: Vec<Reply>,
        result: oneshot::Sender<Step>,
    },
    Cancel(u64),
    Reset,
}
#[derive(Clone)]
pub struct NativeEngine {
    sender: SyncSender<Message>,
    jobs: Arc<AtomicU64>,
}
struct Pending {
    sender: SyncSender<Message>,
    job: u64,
    cancelled: Arc<AtomicBool>,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.sender.try_send(Message::Cancel(self.job));
    }
}
impl NativeEngine {
    pub fn new() -> Result<Self, String> {
        let (sender, receiver) = sync_channel(128);
        std::thread::Builder::new()
            .name("termai-engine".into())
            .spawn(move || {
                termai_engine::initialize();
                let mut runtime = Runtime::default();
                let mut jobs: BTreeMap<u64, (u32, Arc<AtomicBool>)> = BTreeMap::new();
                let mut next = 0u32;
                let clock = Instant::now();
                loop {
                    jobs.retain(|_, (id, cancelled)| {
                        if cancelled.load(Ordering::SeqCst) {
                            runtime.cancel(*id);
                            false
                        } else {
                            true
                        }
                    });
                    let message = if jobs.is_empty() {
                        match receiver.recv() {
                            Ok(message) => message,
                            Err(_) => break,
                        }
                    } else {
                        match receiver.recv_timeout(Duration::from_millis(100)) {
                            Ok(message) => message,
                            Err(RecvTimeoutError::Timeout) => continue,
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    };
                    let now = clock.elapsed().as_secs_f64() * 1000.0;
                    match message {
                        Message::Start {
                            job,
                            call,
                            result,
                            cancelled,
                        } => {
                            if cancelled.load(Ordering::SeqCst) {
                                let _ = result.send(Step::Error {
                                    request: 0,
                                    error: ABORTED.into(),
                                });
                                continue;
                            }
                            let Some(id) = next.checked_add(1) else {
                                let _ = result.send(Step::Error {
                                    request: 0,
                                    error: "Engine request IDs exhausted.".into(),
                                });
                                continue;
                            };
                            next = id;
                            jobs.insert(job, (id, cancelled));
                            let step = runtime.start_call(id, call, now);
                            if !matches!(step, Step::Pending { .. }) {
                                jobs.remove(&job);
                            }
                            if result.send(step).is_err() {
                                runtime.cancel(id);
                                jobs.remove(&job);
                            }
                        }
                        Message::Resume {
                            job,
                            replies,
                            result,
                        } => {
                            if let Some(id) = jobs.get(&job).map(|(id, _)| *id) {
                                let step = runtime.resume(id, replies, now);
                                if !matches!(step, Step::Pending { .. }) {
                                    jobs.remove(&job);
                                }
                                if result.send(step).is_err() {
                                    runtime.cancel(id);
                                    jobs.remove(&job);
                                }
                            } else {
                                let _ = result.send(Step::Error {
                                    request: 0,
                                    error: "Unknown or cancelled engine request.".into(),
                                });
                            }
                        }
                        Message::Cancel(job) => {
                            if let Some((id, _)) = jobs.remove(&job) {
                                runtime.cancel(id);
                            }
                        }
                        Message::Reset => {
                            runtime.reset();
                            jobs.clear();
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            sender,
            jobs: Arc::new(AtomicU64::new(0)),
        })
    }
    pub fn reset(&self) -> Result<(), String> {
        self.sender
            .try_send(Message::Reset)
            .map_err(|_| "Engine queue is full.".into())
    }
    pub async fn invoke(
        &self,
        request: Request,
        host: &NativeHost,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.run(Call::Json(request), host, cancel).await
    }
    pub async fn suggest(
        &self,
        input: &str,
        host: &NativeHost,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.run(
            Call::Suggest {
                input: input.into(),
                catalog: Arc::new(host.catalog.clone()),
                environment: Arc::new(host.environment.clone()),
            },
            host,
            cancel,
        )
        .await
    }
    async fn run(
        &self,
        call: Call,
        host: &NativeHost,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let job = self.jobs.fetch_add(1, Ordering::SeqCst);
        let cancelled = Arc::new(AtomicBool::new(false));
        let _pending = Pending {
            sender: self.sender.clone(),
            job,
            cancelled: cancelled.clone(),
        };
        let (result, receiver) = oneshot::channel();
        self.sender
            .try_send(Message::Start {
                job,
                call,
                result,
                cancelled,
            })
            .map_err(|_| "Engine queue is full.".to_owned())?;
        let mut step = tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), result = receiver => result.map_err(|_| "Engine closed.".to_owned())? };
        loop {
            match step {
                Step::Complete { value, .. } => return Ok(value),
                Step::Error { error, .. } => return Err(error),
                Step::Pending { callbacks, .. } => {
                    let replies = futures::future::join_all(callbacks.into_iter().map(
                        |callback| async move {
                            let results = futures::future::join_all(
                                callback.operations.iter().map(|operation| async move {
                                    host.engine_fact(operation, cancel).await
                                }),
                            )
                            .await;
                            Reply::Native {
                                request: callback.request,
                                results,
                            }
                        },
                    ));
                    let replies = tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), replies = replies => replies };
                    let (result, receiver) = oneshot::channel();
                    self.sender
                        .try_send(Message::Resume {
                            job,
                            replies,
                            result,
                        })
                        .map_err(|_| "Engine queue is full.".to_owned())?;
                    step = tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), result = receiver => result.map_err(|_| "Engine closed.".to_owned())? };
                }
            }
        }
    }
}
