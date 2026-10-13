use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Semaphore, watch},
};
use tokio_util::sync::CancellationToken;

pub const ABORTED: &str = "Operation aborted";
#[derive(Clone)]
pub struct ProbePool {
    slots: Arc<Semaphore>,
    queued: Arc<AtomicUsize>,
    limit: usize,
}
impl Default for ProbePool {
    fn default() -> Self {
        Self::new(2)
    }
}
struct Queued(Arc<AtomicUsize>);
impl Drop for Queued {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl ProbePool {
    pub fn new(limit: usize) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(limit)),
            queued: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }
    pub fn busy(&self) -> bool {
        self.slots.available_permits() < self.limit || self.queued.load(Ordering::SeqCst) > 0
    }
    pub async fn run<T>(
        &self,
        cancel: &CancellationToken,
        work: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let permit = match self.slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                if self.queued.fetch_add(1, Ordering::SeqCst) >= 64 {
                    self.queued.fetch_sub(1, Ordering::SeqCst);
                    return Err("Probe queue is full".into());
                }
                let queued = Queued(self.queued.clone());
                let permit = tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), permit = self.slots.clone().acquire_owned() => permit.map_err(|e| e.to_string())? };
                drop(queued);
                permit
            }
        };
        let result = tokio::select! { biased; _ = cancel.cancelled() => Err(ABORTED.into()), result = work => result };
        drop(permit);
        result
    }
}
#[derive(Clone)]
pub struct ProbeOptions {
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub max_buffer: usize,
}
pub struct ProbeOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
}
pub(crate) struct ProcessGroup(pub(crate) Option<u32>);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
pub async fn probe(
    pool: &ProbePool,
    executable: &str,
    args: &[String],
    options: &ProbeOptions,
    cancel: &CancellationToken,
) -> Result<ProbeOutput, String> {
    pool.run(cancel, async {
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(&options.cwd)
            .env_clear()
            .envs(&options.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let mut group = ProcessGroup(child.id());
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let collect = async {
            let read = |stream: Box<dyn tokio::io::AsyncRead + Send + Unpin>| async move {
                let mut bytes = Vec::new();
                stream
                    .take(options.max_buffer as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                if bytes.len() > options.max_buffer {
                    return Err("Probe output exceeds its buffer limit.".into());
                }
                Ok(bytes)
            };
            let (stdout, stderr, status) =
                tokio::try_join!(read(Box::new(stdout)), read(Box::new(stderr)), async {
                    child.wait().await.map_err(|e| e.to_string())
                })?;
            Ok(ProbeOutput {
                stdout,
                stderr,
                success: status.success(),
            })
        };
        let result = tokio::time::timeout(options.timeout, collect)
            .await
            .map_err(|_| "Probe timed out.".to_owned())?;
        if result.is_ok() {
            group.0 = None;
        }
        result
    })
    .await
}

pub struct SharedTask<T: Clone> {
    receiver: watch::Receiver<Option<Result<T, String>>>,
    consumers: Arc<AtomicUsize>,
    cancel: CancellationToken,
}
impl<T: Clone> Clone for SharedTask<T> {
    fn clone(&self) -> Self {
        Self {
            receiver: self.receiver.clone(),
            consumers: self.consumers.clone(),
            cancel: self.cancel.clone(),
        }
    }
}
struct Subscriber<T: Clone> {
    task: SharedTask<T>,
}
impl<T: Clone> Drop for Subscriber<T> {
    fn drop(&mut self) {
        if self.task.consumers.fetch_sub(1, Ordering::SeqCst) == 1
            && self.task.receiver.borrow().is_none()
        {
            self.task.cancel.cancel();
        }
    }
}
impl<T: Clone + Send + Sync + 'static> SharedTask<T> {
    pub fn new(
        work: impl FnOnce(
            CancellationToken,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<T, String>> + Send>,
        > + Send
        + 'static,
    ) -> Self {
        let cancel = CancellationToken::new();
        let worker_cancel = cancel.clone();
        let (sender, receiver) = watch::channel(None);
        tokio::spawn(async move {
            let result = tokio::select! { biased; _ = worker_cancel.cancelled() => Err(ABORTED.into()), result = work(worker_cancel.clone()) => result };
            sender.send_replace(Some(result));
        });
        Self {
            receiver,
            consumers: Arc::new(AtomicUsize::new(0)),
            cancel,
        }
    }
    pub fn aborted(&self) -> bool {
        self.cancel.is_cancelled()
    }
    pub async fn wait(&self, cancel: &CancellationToken) -> Result<T, String> {
        if cancel.is_cancelled() {
            if self.consumers.load(Ordering::SeqCst) == 0 && self.receiver.borrow().is_none() {
                self.cancel.cancel();
            }
            return Err(ABORTED.into());
        }
        self.consumers.fetch_add(1, Ordering::SeqCst);
        let _subscriber = Subscriber { task: self.clone() };
        let mut receiver = self.receiver.clone();
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }
            tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), changed = receiver.changed() => changed.map_err(|_| "Probe task closed.".to_owned())? }
        }
    }
}
