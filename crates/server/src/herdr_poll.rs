//! One shared poll per Herdr pane, with replay and bounded latest-value delivery to every viewer of it.
use crate::herdr::{ResourceKey, ShellInput, Target};
use serde_json::json;
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

/// What a pane poll reads, and how often.
pub trait Poll: Send + Sync + 'static {
    type Value: Clone + PartialEq + Send + Sync + 'static;
    /// Reads happen at most this often, and continuously while no frame stream reports changes.
    const INTERVAL: Duration;
    /// A pane with a live frame stream rereads only this often without new frames.
    const IDLE: Duration;
    fn read(
        target: &Target,
        pane: &str,
    ) -> impl Future<Output = Result<Self::Value, String>> + Send;
}
/// The pane's recent unwrapped ANSI history, which an error ends.
pub struct History;
impl Poll for History {
    type Value = Arc<str>;
    const INTERVAL: Duration = Duration::from_millis(150);
    const IDLE: Duration = Duration::from_secs(10);
    async fn read(target: &Target, pane: &str) -> Result<Arc<str>, String> {
        let reply = target.request("pane.read", json!({"pane_id":pane,"source":"recent_unwrapped","lines":1000,"format":"ansi","strip_ansi":false})).await?;
        reply["read"]["text"].as_str().map(Arc::from).ok_or_else(|| {
            "Herdr did not return terminal history. Update Herdr to a version supporting recent-unwrapped reads.".into()
        })
    }
}
/// Whether the pane's foreground process is its shell, and the process context that changes when it is not.
pub struct InputState;
impl Poll for InputState {
    type Value = (Option<ShellInput>, String);
    // Starting or finishing a program redraws the pane, so a quiet live stream needs only occasional checks.
    const INTERVAL: Duration = Duration::from_millis(300);
    const IDLE: Duration = Duration::from_secs(2);
    async fn read(target: &Target, pane: &str) -> Result<Self::Value, String> {
        Ok(target.input_state(pane).await.unwrap_or_default())
    }
}
pub type HistoryHub = Hub<History>;
pub type InputHub = Hub<InputState>;

type Update<T> = Option<Result<T, Arc<str>>>;
struct Resource<T> {
    send: watch::Sender<Update<T>>,
    users: Mutex<usize>,
    cancel: CancellationToken,
    refresh: Arc<Notify>,
    activity: Notify,
    streaming: AtomicBool,
}
type Resources<T> = Arc<Mutex<HashMap<ResourceKey, Arc<Resource<T>>>>>;
pub struct Hub<P: Poll> {
    resources: Resources<P::Value>,
}
impl<P: Poll> Default for Hub<P> {
    fn default() -> Self {
        Self {
            resources: Default::default(),
        }
    }
}
impl<P: Poll> Clone for Hub<P> {
    fn clone(&self) -> Self {
        Self {
            resources: self.resources.clone(),
        }
    }
}
pub struct Subscription<T> {
    pub receive: watch::Receiver<Update<T>>,
    /// Forces the next read to deliver its value even when it is unchanged.
    pub refresh: Arc<Notify>,
    resource: Arc<Resource<T>>,
}
impl<T> Drop for Subscription<T> {
    fn drop(&mut self) {
        let mut users = self.resource.users.lock().unwrap();
        *users -= 1;
        if *users == 0 {
            self.resource.cancel.cancel();
        }
    }
}
impl<P: Poll> Hub<P> {
    /// A terminal frame means the pane may have changed; an empty reset frame means its stream stopped.
    pub fn activity(&self, target: &Target, pane: &str, streaming: bool) {
        let Ok(key) = target.key(pane) else { return };
        if let Some(resource) = self.resources.lock().unwrap().get(&key) {
            resource.streaming.store(streaming, Ordering::Release);
            resource.activity.notify_one();
        }
    }
    pub fn subscribe(
        &self,
        target: Target,
        pane: String,
    ) -> Result<Subscription<P::Value>, String> {
        let key = target.key(&pane)?;
        let mut resources = self.resources.lock().unwrap();
        resources.retain(|_, resource| !resource.cancel.is_cancelled());
        if let Some(resource) = resources.get(&key) {
            let mut users = resource.users.lock().unwrap();
            if !resource.cancel.is_cancelled() {
                *users += 1;
                return Ok(Subscription {
                    receive: resource.send.subscribe(),
                    refresh: resource.refresh.clone(),
                    resource: resource.clone(),
                });
            }
        }
        let (send, receive) = watch::channel(None);
        let resource = Arc::new(Resource {
            send,
            users: Mutex::new(1),
            cancel: CancellationToken::new(),
            refresh: Arc::new(Notify::new()),
            activity: Notify::new(),
            streaming: AtomicBool::new(false),
        });
        resources.insert(key, resource.clone());
        tokio::spawn(run::<P>(target, pane, resource.clone()));
        Ok(Subscription {
            receive,
            refresh: resource.refresh.clone(),
            resource,
        })
    }
}
async fn run<P: Poll>(target: Target, pane: String, resource: Arc<Resource<P::Value>>) {
    let mut previous = None;
    let mut force = false;
    loop {
        let started = tokio::time::Instant::now();
        let result = tokio::select! {
            biased;
            _=resource.cancel.cancelled()=>break,
            _=resource.refresh.notified()=>{force=true;continue;},
            result=P::read(&target, &pane)=>result
        };
        match result {
            Ok(value) => {
                if force || previous.as_ref() != Some(&value) {
                    force = false;
                    previous = Some(value.clone());
                    resource.send.send_replace(Some(Ok(value)));
                }
            }
            Err(error) => {
                resource.send.send_replace(Some(Err(error.into())));
                break;
            }
        }
        // Frames announce new output, so a quiet pane with a live stream is not reread every interval.
        let idle = if resource.streaming.load(Ordering::Acquire) {
            P::IDLE
        } else {
            P::INTERVAL
        };
        tokio::select! { biased; _=resource.cancel.cancelled()=>break, _=resource.refresh.notified()=>{force=true;}, _=resource.activity.notified()=>{}, _=tokio::time::sleep(idle)=>{} }
        // A burst of frames still yields at most one read per interval.
        tokio::select! { biased; _=resource.cancel.cancelled()=>break, _=resource.refresh.notified()=>{force=true;}, _=tokio::time::sleep_until(started + P::INTERVAL)=>{} }
    }
}
/// The shared pane polls a Herdr viewer follows.
#[derive(Clone, Default)]
pub struct Polls {
    pub history: HistoryHub,
    pub inputs: InputHub,
}
impl Polls {
    pub fn activity(&self, target: &Target, pane: &str, streaming: bool) {
        self.history.activity(target, pane, streaming);
        self.inputs.activity(target, pane, streaming);
    }
}
