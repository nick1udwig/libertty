//! One history request per target/pane, with replay and bounded latest-value delivery.
use crate::herdr::Target;
use crate::protocol::ServerMessage;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

type Update = Option<Result<Arc<ServerMessage>, Arc<str>>>;
/// Reads at most this often, and continuously while no frame stream reports changes.
const INTERVAL: Duration = Duration::from_millis(150);
/// A pane with a live frame stream only rechecks its history this often without new frames.
const IDLE: Duration = Duration::from_secs(10);
struct Resource {
    send: watch::Sender<Update>,
    users: Mutex<usize>,
    cancel: CancellationToken,
    refresh: Arc<tokio::sync::Notify>,
    activity: tokio::sync::Notify,
    streaming: AtomicBool,
}
#[derive(Default, Clone)]
pub struct Hub {
    resources: Arc<Mutex<HashMap<String, Arc<Resource>>>>,
}
pub struct Subscription {
    pub receive: watch::Receiver<Update>,
    pub refresh: Arc<tokio::sync::Notify>,
    resource: Arc<Resource>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        let mut users = self.resource.users.lock().unwrap();
        *users -= 1;
        if *users == 0 {
            self.resource.cancel.cancel();
        }
    }
}
fn key(target: &Target, pane: &str) -> Result<String, String> {
    let transport = target
        .remote
        .as_ref()
        .map(|host| format!("{:p}", Arc::as_ptr(host)));
    Ok(json!([transport, target.path()?, pane]).to_string())
}
impl Hub {
    /// A terminal frame means the pane's history may have changed; an empty reset frame means its stream stopped.
    pub fn activity(&self, target: &Target, pane: &str, streaming: bool) {
        let Ok(key) = key(target, pane) else { return };
        if let Some(resource) = self.resources.lock().unwrap().get(&key) {
            resource.streaming.store(streaming, Ordering::Release);
            resource.activity.notify_one();
        }
    }
    pub fn subscribe(&self, target: Target, pane: String) -> Result<Subscription, String> {
        let key = key(&target, &pane)?;
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
            refresh: Arc::new(tokio::sync::Notify::new()),
            activity: tokio::sync::Notify::new(),
            streaming: AtomicBool::new(false),
        });
        resources.insert(key, resource.clone());
        tokio::spawn(run(target, pane, resource.clone()));
        Ok(Subscription {
            receive,
            refresh: resource.refresh.clone(),
            resource,
        })
    }
}
async fn run(target: Target, pane: String, resource: Arc<Resource>) {
    let mut previous = None;
    let mut force = false;
    loop {
        let started = tokio::time::Instant::now();
        let request = target.request("pane.read", json!({"pane_id":pane,"source":"recent_unwrapped","lines":1000,"format":"ansi","strip_ansi":false}));
        let result = tokio::select! {
            biased;
            _=resource.cancel.cancelled()=>break,
            _=resource.refresh.notified()=>{force=true;continue;},
            result=request=>result
        };
        match result.and_then(|value| value["read"]["text"].as_str().map(str::to_owned).ok_or("Herdr did not return terminal history. Update Herdr to a version supporting recent-unwrapped reads.".into())) {
            Ok(text) => if force || previous.as_ref() != Some(&text) {
                let message = Arc::new(ServerMessage::Screen { version: None, text: Arc::from(text.as_str()) });
                force = false;
                previous = Some(text); resource.send.send_replace(Some(Ok(message)));
            },
            Err(error) => { resource.send.send_replace(Some(Err(error.into()))); break; }
        }
        // Frames announce new output, so a quiet pane with a live stream is not reread every interval.
        let idle = if resource.streaming.load(Ordering::Acquire) {
            IDLE
        } else {
            INTERVAL
        };
        tokio::select! { biased; _=resource.cancel.cancelled()=>break, _=resource.refresh.notified()=>{force=true;}, _=resource.activity.notified()=>{}, _=tokio::time::sleep(idle)=>{} }
        // A burst of frames still yields at most one read per interval.
        tokio::select! { biased; _=resource.cancel.cancelled()=>break, _=resource.refresh.notified()=>{force=true;}, _=tokio::time::sleep_until(started + INTERVAL)=>{} }
    }
}
