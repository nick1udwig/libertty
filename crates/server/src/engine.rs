use crate::{host::NativeHost, probes::ABORTED};
use libertty_engine::{
    Request,
    runtime::{self, Call, Output, Runtime},
    types::Candidate,
};
use serde_json::Value;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

struct Job {
    call: Call,
    host: NativeHost,
    cancel: CancellationToken,
    result: oneshot::Sender<Result<Output, String>>,
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
struct Workers {
    senders: Vec<mpsc::Sender<mpsc::Receiver<Message>>>,
    next: AtomicUsize,
}
impl Workers {
    fn new() -> Result<Self, String> {
        let count = std::thread::available_parallelism()
            .map_or(1, usize::from)
            .min(4);
        let mut senders = Vec::with_capacity(count);
        for index in 0..count {
            let executor = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            let (sender, mut receivers) = mpsc::channel(128);
            std::thread::Builder::new()
                .name(format!("libertty-engine-{index}"))
                .spawn(move || {
                    libertty_engine::initialize();
                    let local = tokio::task::LocalSet::new();
                    executor.block_on(local.run_until(async move {
                        while let Some(receiver) = receivers.recv().await {
                            tokio::task::spawn_local(run_engine(receiver));
                        }
                    }));
                })
                .map_err(|error| error.to_string())?;
            senders.push(sender);
        }
        Ok(Self {
            senders,
            next: AtomicUsize::new(0),
        })
    }
    fn register(&self, receiver: mpsc::Receiver<Message>) -> Result<(), String> {
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.senders.len();
        self.senders[index]
            .try_send(receiver)
            .map_err(|_| "Engine worker queue is full or closed.".into())
    }
}
async fn run_engine(mut receiver: mpsc::Receiver<Message>) {
    let runtime = Rc::new(RefCell::new(Runtime::default()));
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
                    let _ = result.send(Err("Engine request IDs exhausted.".into()));
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
                            host.engine_operations_until(&operations, &cancel, Some(deadline))
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
}
impl NativeEngine {
    pub fn new() -> Result<Self, String> {
        static WORKERS: OnceLock<Result<Workers, String>> = OnceLock::new();
        let workers = WORKERS
            .get_or_init(Workers::new)
            .as_ref()
            .map_err(Clone::clone)?;
        let (sender, receiver) = mpsc::channel(128);
        workers.register(receiver)?;
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
        self.run(Call::Json(request), host, cancel)
            .await?
            .into_json()
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
        match value {
            Output::Candidates(candidates) => Ok(candidates),
            _ => Err("Unexpected suggestion result.".into()),
        }
    }
    pub async fn prewarm_targets(
        &self,
        host: &NativeHost,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        match self
            .run(
                Call::PrewarmTargets {
                    catalog: Arc::new(host.catalog.clone()),
                    environment: host.environment.clone(),
                },
                host,
                cancel,
            )
            .await?
        {
            Output::Targets(targets) => Ok(targets),
            _ => Err("Unexpected prewarm targets.".into()),
        }
    }
    pub async fn warm_command(
        &self,
        command: &str,
        host: &NativeHost,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        match self
            .run(
                Call::WarmCommand {
                    command: command.into(),
                    catalog: Arc::new(host.catalog.clone()),
                    environment: host.environment.clone(),
                },
                host,
                cancel,
            )
            .await?
        {
            Output::Warmed => Ok(()),
            _ => Err("Unexpected warm result.".into()),
        }
    }
    async fn run(
        &self,
        call: Call,
        host: &NativeHost,
        cancel: &CancellationToken,
    ) -> Result<Output, String> {
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
