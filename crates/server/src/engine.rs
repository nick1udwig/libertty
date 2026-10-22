use crate::{host::NativeHost, probes::ABORTED};
use libertty_engine::{
    Request,
    runtime::{self, Call, Runtime},
    types::Candidate,
};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc, sync::Arc, time::Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

struct Job {
    call: Call,
    host: NativeHost,
    cancel: CancellationToken,
    result: oneshot::Sender<Result<Value, String>>,
}
enum Message {
    Start(Box<Job>),
    Reset,
}
#[derive(Clone)]
pub struct NativeEngine {
    sender: mpsc::Sender<Message>,
}
struct Pending(CancellationToken);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
enum Executor {
    Shared(tokio::runtime::Handle),
    Owned(tokio::runtime::Runtime),
}
impl NativeEngine {
    pub fn new() -> Result<Self, String> {
        let (sender, mut receiver) = mpsc::channel::<Message>(128);
        let executor = match tokio::runtime::Handle::try_current() {
            Ok(handle) => Executor::Shared(handle),
            Err(_) => Executor::Owned(
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| e.to_string())?,
            ),
        };
        std::thread::Builder::new()
            .name("libertty-engine".into())
            .spawn(move || {
                libertty_engine::initialize();
                let runtime = Rc::new(RefCell::new(Runtime::default()));
                let local = tokio::task::LocalSet::new();
                let work = local.run_until(async move {
                    let mut next = 0u32;
                    let clock = Instant::now();
                    let mut generation = CancellationToken::new();
                    while let Some(message) = receiver.recv().await {
                        match message {
                            Message::Reset => {
                                generation.cancel();
                                generation = CancellationToken::new();
                                runtime.borrow_mut().reset();
                            }
                            Message::Start(job) => {
                                let Job {
                                    call,
                                    host,
                                    cancel,
                                    result,
                                } = *job;
                                let Some(id) = next.checked_add(1) else {
                                    let _ =
                                        result.send(Err("Engine request IDs exhausted.".into()));
                                    continue;
                                };
                                next = id;
                                if cancel.is_cancelled() {
                                    let _ = result.send(Err(ABORTED.into()));
                                    continue;
                                }
                                // Assign and start IDs in receiver order, before tasks can yield.
                                let deadline = tokio::time::Instant::now()
                                    + std::time::Duration::from_millis(
                                        libertty_engine::runtime::REPAIR_BUDGET_MS as u64,
                                    );
                                let (host, facts) = (Rc::new(host), cancel.clone());
                                let work = runtime::drive(
                                    runtime.clone(),
                                    id,
                                    call,
                                    move || clock.elapsed().as_secs_f64() * 1000.0,
                                    move |operations| {
                                        let (host, cancel) = (host.clone(), facts.clone());
                                        async move {
                                            host.engine_operations_until(
                                                &operations,
                                                &cancel,
                                                Some(deadline),
                                            )
                                            .await
                                        }
                                    },
                                );
                                let reset = generation.clone();
                                tokio::task::spawn_local(async move {
                                    let value = tokio::select! { biased;
                                        _ = cancel.cancelled() => Err(ABORTED.into()),
                                        _ = reset.cancelled() => Err(ABORTED.into()),
                                        value = work => value,
                                    };
                                    let _ = result.send(value);
                                });
                            }
                        }
                    }
                    generation.cancel();
                });
                match executor {
                    Executor::Shared(handle) => handle.block_on(work),
                    Executor::Owned(runtime) => runtime.block_on(work),
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { sender })
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
    ) -> Result<Vec<Candidate>, String> {
        let value = self
            .run(
                Call::Suggest {
                    input: input.into(),
                    catalog: Arc::new(host.catalog.clone()),
                    environment: host.environment.clone(),
                },
                host,
                cancel,
            )
            .await?;
        serde_json::from_value(value).map_err(|error| error.to_string())
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
        let pending = Pending(CancellationToken::new());
        let (result, receiver) = oneshot::channel();
        self.sender
            .try_send(Message::Start(Box::new(Job {
                call,
                host: host.clone(),
                cancel: pending.0.clone(),
                result,
            })))
            .map_err(|_| "Engine queue is full.".to_owned())?;
        tokio::select! { biased;
            _ = cancel.cancelled() => Err(ABORTED.into()),
            result = receiver => result.map_err(|_| "Engine closed.".to_owned())?,
        }
    }
}
