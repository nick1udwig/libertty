//! Shared metadata subscriptions and cached snapshots per target.
use crate::herdr::{
    Connection, Lines, Metadata, Snapshot, Target, normalize, pane_key, read_line, truthy,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, LazyLock, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::watch,
};
use tokio_util::sync::CancellationToken;

type Registry = Mutex<HashMap<crate::herdr::ResourceKey, Weak<Resource>>>;
static RESOURCES: LazyLock<Registry> = LazyLock::new(Default::default);

type HeldResource = Option<(crate::herdr::ResourceKey, Arc<Resource>)>;
#[derive(Clone, Default)]
pub struct Shared(Arc<Mutex<HeldResource>>);
impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shared").finish_non_exhaustive()
    }
}
impl Shared {
    pub(crate) fn resource(&self, target: &Target) -> Result<Arc<Resource>, String> {
        let key = target.key("")?;
        let mut held = self.0.lock().unwrap();
        if let Some((previous, resource)) = &*held
            && previous == &key
        {
            return Ok(resource.clone());
        }
        let mut registry = RESOURCES.lock().unwrap();
        registry.retain(|_, value| value.strong_count() > 0);
        let resource = registry
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let resource = Arc::new(Resource::default());
                registry.insert(key.clone(), Arc::downgrade(&resource));
                resource
            });
        *held = Some((key, resource.clone()));
        Ok(resource)
    }
}

pub(crate) struct Resource {
    generation: AtomicU64,
    /// Advances on every Herdr event and structural mutation; trusted only while events are watched.
    layout: AtomicU64,
    watching: AtomicBool,
    cache: Mutex<Option<(u64, Arc<Snapshot>)>>,
    fetching: tokio::sync::Mutex<()>,
    listeners: Mutex<Option<Listeners>>,
}
struct Listeners {
    count: usize,
    send: watch::Sender<Option<Metadata>>,
    cancel: CancellationToken,
}
impl Default for Resource {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            layout: AtomicU64::new(0),
            watching: AtomicBool::new(false),
            cache: Default::default(),
            fetching: Default::default(),
            listeners: Default::default(),
        }
    }
}
pub(crate) struct Subscription {
    pub receive: watch::Receiver<Option<Metadata>>,
    resource: Arc<Resource>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        let mut listeners = self.resource.listeners.lock().unwrap();
        if let Some(active) = listeners.as_mut() {
            active.count -= 1;
            if active.count == 0 {
                active.cancel.cancel();
                *listeners = None;
                self.resource.unwatch();
            }
        }
    }
}

struct InvalidateOnExit<'a>(&'a Resource);
impl Drop for InvalidateOnExit<'_> {
    fn drop(&mut self) {
        self.0.changed();
    }
}

/// Typing changes terminal contents, which Herdr reports through status events rather than the snapshot's structure.
fn content_only(method: &str) -> bool {
    matches!(method, "pane.send_text" | "pane.send_input")
}
fn read_only(method: &str) -> bool {
    matches!(
        method,
        "session.snapshot"
            | "server.agent_manifests"
            | "pane.get"
            | "pane.read"
            | "pane.process_info"
            | "pane.copy_motion"
            | "worktree.list"
    )
}
impl Resource {
    fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    /// A structural change also ends cached pane validations.
    fn changed(&self) {
        self.invalidate();
        self.layout.fetch_add(1, Ordering::AcqRel);
    }
    fn unwatch(&self) {
        self.watching.store(false, Ordering::Release);
        self.changed();
    }
    /// The current layout epoch while a subscription is watching Herdr events.
    pub(crate) fn layout_epoch(&self) -> Option<u64> {
        self.watching
            .load(Ordering::Acquire)
            .then(|| self.layout.load(Ordering::Acquire))
    }
    pub(crate) async fn request(
        &self,
        target: &Target,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let mutation = !read_only(method) && !content_only(method);
        let _invalidate_on_exit = mutation.then(|| InvalidateOnExit(self));
        if mutation {
            self.changed();
        }
        let work = async {
            // Herdr closes ordinary RPC sockets after one response.
            let mut stream = BufReader::new(target.open().await?);
            let id = crate::storage::random_hex(16);
            let line = format!("{}\n", json!({"id":id,"method":method,"params":params}));
            let reply = exchange(&mut stream, &id, &line).await?;
            if truthy(&reply["error"]) {
                Err(reply["error"]["message"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Herdr rejected the action.")
                    .into())
            } else {
                Ok(reply.get("result").cloned().unwrap_or(Value::Null))
            }
        };
        let seconds = if method.starts_with("worktree.") {
            60
        } else {
            5
        };
        tokio::time::timeout(Duration::from_secs(seconds), work)
            .await
            .map_err(|_| "Herdr did not respond.".to_owned())
            .and_then(|result| result)
    }
    pub(crate) async fn refresh_snapshot(&self, target: &Target) -> Result<Arc<Snapshot>, String> {
        self.changed();
        self.snapshot(target).await
    }
    pub(crate) async fn snapshot(&self, target: &Target) -> Result<Arc<Snapshot>, String> {
        let _fetch = self.fetching.lock().await;
        loop {
            let generation = self.generation.load(Ordering::Acquire);
            let active = self.listeners.lock().unwrap().is_some();
            if active
                && let Some((version, snapshot)) = &*self.cache.lock().unwrap()
                && *version == generation
            {
                return Ok(snapshot.clone());
            }
            let snapshot = Arc::new(normalize(
                &self.request(target, "session.snapshot", json!({})).await?,
            )?);
            if generation == self.generation.load(Ordering::Acquire) {
                *self.cache.lock().unwrap() = Some((generation, snapshot.clone()));
                return Ok(snapshot);
            }
        }
    }
    pub(crate) fn subscribe(self: &Arc<Self>, target: Target) -> Subscription {
        let mut listeners = self.listeners.lock().unwrap();
        let receive = if let Some(active) = listeners.as_mut() {
            active.count += 1;
            active.send.subscribe()
        } else {
            self.invalidate();
            let (send, receive) = watch::channel(None);
            let cancel = CancellationToken::new();
            *listeners = Some(Listeners {
                count: 1,
                send: send.clone(),
                cancel: cancel.clone(),
            });
            tokio::spawn(run(target, self.clone(), send, cancel));
            receive
        };
        Subscription {
            receive,
            resource: self.clone(),
        }
    }
}
async fn exchange(
    stream: &mut BufReader<Connection>,
    id: &str,
    line: &str,
) -> Result<Value, String> {
    stream
        .get_mut()
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    loop {
        let reply = read_line(stream)
            .await?
            .ok_or("Herdr disconnected before responding.")?;
        if reply["id"] == id {
            return Ok(reply);
        }
    }
}
async fn run(
    target: Target,
    resource: Arc<Resource>,
    send: watch::Sender<Option<Metadata>>,
    cancel: CancellationToken,
) {
    let mut previous = None;
    loop {
        let work = async {
            // The subscription acknowledgement triggers a refresh after the initial fetch.
            resource.watching.store(false, Ordering::Release);
            let mut stream = BufReader::new(target.open().await?);
            let mut snapshot = resource.snapshot(&target).await?;
            let mut subscriptions: Vec<Value> = [
                "pane.agent_detected",
                "pane.updated",
                "pane.created",
                "pane.closed",
                "pane.moved",
                "tab.created",
                "tab.closed",
                "tab.renamed",
                "workspace.created",
                "workspace.closed",
                "workspace.renamed",
                "workspace.moved",
                "workspace.reordered",
            ]
            .iter()
            .map(|kind| json!({"type":kind}))
            .collect();
            subscriptions.extend(
                snapshot.agents.iter().map(
                    |agent| json!({"type":"pane.agent_status_changed","pane_id":agent.pane_id}),
                ),
            );
            stream.get_mut().write_all(format!("{}\n", json!({"id":"events","method":"events.subscribe","params":{"subscriptions":subscriptions}})).as_bytes()).await.map_err(|error| error.to_string())?;
            let keys = pane_key(&snapshot);
            let mut lines = Lines::default();
            loop {
                if previous.as_ref() != Some(&snapshot) {
                    send.send_replace(Some(Metadata::Snapshot {
                        snapshot: snapshot.clone(),
                    }));
                    previous = Some(snapshot.clone());
                }
                let reply = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Ok(()),
                    reply = lines.read(&mut stream) => Some(reply?),
                    _ = tokio::time::sleep(Duration::from_secs(10)) => None,
                };
                if let Some(reply) = reply {
                    check_event(reply)?;
                    // Any event may move or replace a pane, so cached input validations end here.
                    resource.layout.fetch_add(1, Ordering::AcqRel);
                    resource.watching.store(true, Ordering::Release);
                }
                let delay = tokio::time::sleep(Duration::from_millis(40));
                tokio::pin!(delay);
                loop {
                    let reply = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Ok(()),
                        _ = &mut delay => break,
                        reply = lines.read(&mut stream) => reply?,
                    };
                    check_event(reply)?;
                    resource.layout.fetch_add(1, Ordering::AcqRel);
                }
                resource.invalidate();
                snapshot = resource.snapshot(&target).await?;
                if keys != pane_key(&snapshot) {
                    break;
                }
            }
            Ok::<_, String>(())
        };
        let result =
            tokio::select! { biased; _ = cancel.cancelled() => break, result = work => result };
        if let Err(message) = result {
            resource.unwatch();
            previous = None;
            send.send_replace(Some(Metadata::Error { message }));
            tokio::select! { biased; _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
        }
    }
}
fn check_event(reply: Option<Value>) -> Result<(), String> {
    let reply = reply.ok_or("Herdr disconnected before responding.")?;
    if truthy(&reply["error"]) {
        Err(reply["error"]["message"]
            .as_str()
            .unwrap_or("Herdr rejected status subscriptions.")
            .into())
    } else {
        Ok(())
    }
}
