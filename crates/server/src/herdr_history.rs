//! One history request per target/pane, with replay and bounded latest-value delivery.
use crate::herdr::Target;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

type Update = Option<Result<Arc<Value>, Arc<str>>>;
struct Resource {
    send: watch::Sender<Update>,
    users: Mutex<usize>,
    cancel: CancellationToken,
}
#[derive(Default)]
pub struct Hub {
    resources: Mutex<HashMap<String, Arc<Resource>>>,
}
pub struct Subscription {
    pub receive: watch::Receiver<Update>,
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
impl Hub {
    pub fn subscribe(&self, target: Target, pane: Value) -> Result<Subscription, String> {
        let transport = target
            .remote
            .as_ref()
            .map(|host| format!("{:p}", Arc::as_ptr(host)));
        let key = json!([transport, target.path()?, pane]).to_string();
        let mut resources = self.resources.lock().unwrap();
        resources.retain(|_, resource| !resource.cancel.is_cancelled());
        if let Some(resource) = resources.get(&key) {
            let mut users = resource.users.lock().unwrap();
            if !resource.cancel.is_cancelled() {
                *users += 1;
                return Ok(Subscription {
                    receive: resource.send.subscribe(),
                    resource: resource.clone(),
                });
            }
        }
        let (send, receive) = watch::channel(None);
        let resource = Arc::new(Resource {
            send,
            users: Mutex::new(1),
            cancel: CancellationToken::new(),
        });
        resources.insert(key, resource.clone());
        tokio::spawn(run(target, pane, resource.clone()));
        Ok(Subscription { receive, resource })
    }
}
async fn run(target: Target, pane: Value, resource: Arc<Resource>) {
    let mut previous = None;
    loop {
        let request = target.request("pane.read", json!({"pane_id":pane,"source":"recent_unwrapped","lines":1000,"format":"ansi","strip_ansi":false}));
        let result =
            tokio::select! { biased; _=resource.cancel.cancelled()=>break, result=request=>result };
        match result.and_then(|value| value["read"]["text"].as_str().map(str::to_owned).ok_or("Herdr did not return terminal history. Update Herdr to a version supporting recent-unwrapped reads.".into())) {
            Ok(text) => if previous.as_ref() != Some(&text) {
                let message = Arc::new(json!({"type":"screen","text":text}));
                previous = Some(text); resource.send.send_replace(Some(Ok(message)));
            },
            Err(error) => { resource.send.send_replace(Some(Err(error.into()))); break; }
        }
        tokio::select! { biased; _=resource.cancel.cancelled()=>break, _=tokio::time::sleep(Duration::from_millis(150))=>{} }
    }
}
