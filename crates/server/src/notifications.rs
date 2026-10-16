use crate::{
    herdr::{self, Target},
    herdr_state::Tracker,
    storage,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use libertty_engine::utf16_len;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use web_push::{
    ContentEncoding, SubscriptionInfo, Urgency, VapidSignatureBuilder, WebPushMessage,
    WebPushMessageBuilder,
};

pub fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn decode(value: &Value) -> Option<Vec<u8>> {
    let text = value.as_str()?;
    let body = text.trim_end_matches('=');
    if body.is_empty()
        || text.len() - body.len() > 2
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    // Node accepts noncanonical unused bits at the end of a base64url value.
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(text)
    .ok()
}
pub fn subscription(value: &Value) -> Result<Value, String> {
    let endpoint = value["endpoint"]
        .as_str()
        .filter(|s| utf16_len(s) <= 4096)
        .ok_or("Invalid push subscription.")?;
    let url = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or("");
    let provider = host == "fcm.googleapis.com"
        || host == "updates.push.services.mozilla.com"
        || host.ends_with(".push.services.mozilla.com")
        || host == "web.push.apple.com"
        || host.ends_with(".push.apple.com")
        || host.ends_with(".notify.windows.com");
    if !provider
        || url.scheme() != "https"
        || url.port().is_some_and(|p| p != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Unsupported browser push service.".into());
    }
    let public = decode(&value["keys"]["p256dh"]);
    let auth = decode(&value["keys"]["auth"]);
    if public.as_ref().is_none_or(|k| k.len() != 65 || k[0] != 4)
        || auth.as_ref().is_none_or(|k| k.len() != 16)
    {
        return Err("Invalid push encryption keys.".into());
    }
    if p256::PublicKey::from_sec1_bytes(public.as_ref().unwrap()).is_err() {
        return Err("Invalid push encryption key.".into());
    }
    Ok(
        json!({"endpoint":url.as_str(),"keys":{"p256dh":value["keys"]["p256dh"],"auth":value["keys"]["auth"]}}),
    )
}
pub struct Push {
    private: String,
    pub public: String,
    contact: String,
    client: reqwest::Client,
}
impl Push {
    pub fn open(directory: &Path, contact: &str) -> Result<Self, String> {
        storage::private_directory(directory).map_err(|e| e.to_string())?;
        let path = directory.join("push-keys.json");
        let keys: Value = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
                let keys = json!({"publicKey":URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes()),"privateKey":URL_SAFE_NO_PAD.encode(secret.to_bytes())});
                storage::atomic_write(&path, keys.to_string().as_bytes())
                    .map_err(|e| e.to_string())?;
                keys
            }
            Err(error) => return Err(error.to_string()),
        };
        let private = keys["privateKey"]
            .as_str()
            .ok_or("Invalid VAPID private key.")?
            .to_owned();
        let public = keys["publicKey"]
            .as_str()
            .ok_or("Invalid VAPID public key.")?
            .to_owned();
        VapidSignatureBuilder::from_base64_no_sub(&private).map_err(|e| e.to_string())?;
        if decode(&json!(public)).is_none_or(|k| k.len() != 65) {
            return Err("Invalid VAPID public key.".into());
        }
        let contact = url::Url::parse(contact).map_err(|_| "Invalid VAPID subject.")?;
        if !["https", "mailto"].contains(&contact.scheme()) {
            return Err("Invalid VAPID subject.".into());
        }
        Ok(Self {
            private,
            public,
            contact: contact.to_string(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?,
        })
    }
    pub fn message(&self, value: &Value, text: &str) -> Result<WebPushMessage, String> {
        let checked = subscription(value)?;
        let info = SubscriptionInfo::new(
            checked["endpoint"].as_str().unwrap().to_owned(),
            URL_SAFE_NO_PAD.encode(decode(&checked["keys"]["p256dh"]).unwrap()),
            URL_SAFE_NO_PAD.encode(decode(&checked["keys"]["auth"]).unwrap()),
        );
        let mut signature =
            VapidSignatureBuilder::from_base64(&self.private, &info).map_err(|e| e.to_string())?;
        signature.add_claim("sub", self.contact.clone());
        let signature = signature.build().map_err(|e| e.to_string())?;
        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_vapid_signature(signature);
        builder.set_ttl(3600);
        builder.set_urgency(Urgency::High);
        builder.set_payload(ContentEncoding::Aes128Gcm, text.as_bytes());
        builder.build().map_err(|e| e.to_string())
    }
    async fn send(&self, value: Value, text: String) -> Result<(), DeliveryError> {
        let message = self
            .message(&value, &text)
            .map_err(|message| DeliveryError {
                status: Some(400),
                message,
            })?;
        let mut request = self
            .client
            .post(message.endpoint.to_string())
            .header("TTL", message.ttl.to_string())
            .header("Urgency", "high");
        if let Some(payload) = message.payload {
            request = request
                .header("Content-Encoding", payload.content_encoding.to_str())
                .header("Content-Type", "application/octet-stream");
            for (key, value) in payload.crypto_headers {
                request = request.header(key, value);
            }
            request = request.body(payload.content);
        }
        let response = request.send().await.map_err(|e| DeliveryError {
            status: None,
            message: e.to_string(),
        })?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(DeliveryError {
                status: Some(response.status().as_u16()),
                message: "Push service rejected the notification.".into(),
            })
        }
    }
}
#[derive(Debug)]
pub struct DeliveryError {
    pub status: Option<u16>,
    pub message: String,
}
pub type Sender = Arc<
    dyn Fn(Value, String) -> futures::future::BoxFuture<'static, Result<(), DeliveryError>>
        + Send
        + Sync,
>;
pub type OwnerCheck = Arc<dyn Fn(&str) -> bool + Send + Sync>;
struct Presence {
    owner: String,
    device: String,
    focused: bool,
    until: Instant,
}
struct Watch {
    cancel: CancellationToken,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchView {
    id: String,
    source: String,
    session: String,
    #[serde(default)]
    remote: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    socket_path: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Device {
    id: String,
    owner: String,
    subscription: Value,
    views: Vec<WatchView>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}
struct State {
    devices: Vec<Device>,
    checkpoints: Map<String, Value>,
    watches: HashMap<String, Watch>,
    presence: HashMap<String, Presence>,
    acknowledgements: HashMap<String, Instant>,
}
pub struct Notifications {
    pub public_key: String,
    directory: PathBuf,
    state: Mutex<State>,
    owner: OwnerCheck,
    send: Sender,
    cancel: CancellationToken,
    saving: AtomicBool,
    pending: Arc<Semaphore>,
}
fn key(owner: &str, view: &WatchView) -> String {
    json!([
        owner,
        view.source,
        view.session,
        view.socket_path.as_deref().unwrap_or("")
    ])
    .to_string()
}
fn receipt(device: &str, key: &str, event: &Value) -> String {
    json!([
        device,
        key,
        event["terminalId"],
        event["kind"],
        event["sequence"]
    ])
    .to_string()
}
fn views(device: &Device) -> &[WatchView] {
    &device.views
}
impl Notifications {
    pub fn open(
        directory: &Path,
        owner: OwnerCheck,
        send: Option<Sender>,
        contact: &str,
    ) -> Result<Arc<Self>, String> {
        let push = Arc::new(Push::open(directory, contact)?);
        let public_key = push.public.clone();
        let send = send.unwrap_or_else(|| {
            Arc::new(move |subscription, text| {
                let push = push.clone();
                Box::pin(async move { push.send(subscription, text).await })
            })
        });
        let stored: Value = match std::fs::read(directory.join("herdr-push.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
            Err(e) => return Err(e.to_string()),
        };
        let mut devices = Vec::new();
        if !stored.is_null() {
            if stored["version"].as_f64() != Some(1.0)
                || stored["devices"].as_array().is_none_or(|d| d.len() > 256)
            {
                return Err("Invalid herdr-push.json.".into());
            }
            for device in stored["devices"].as_array().unwrap() {
                if !device["owner"].as_str().is_some_and(|s| owner(s)) {
                    continue;
                }
                let mut device = Device::deserialize(device)
                    .map_err(|_| "Invalid saved Herdr notification device.")?;
                device.subscription = subscription(&device.subscription)?;
                if device.views.len() > 16 {
                    return Err("Invalid saved Herdr notification watches.".into());
                }
                devices.retain(|old: &Device| old.id != device.id);
                devices.push(device);
            }
        }
        let manager = Arc::new(Self {
            public_key,
            directory: directory.into(),
            state: Mutex::new(State {
                devices,
                checkpoints: stored["checkpoints"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                watches: HashMap::new(),
                presence: HashMap::new(),
                acknowledgements: HashMap::new(),
            }),
            owner,
            send,
            cancel: CancellationToken::new(),
            saving: AtomicBool::new(false),
            pending: Arc::new(Semaphore::new(128)),
        });
        let devices = manager.state.lock().unwrap().devices.clone();
        for device in devices {
            for view in views(&device) {
                if !view.remote {
                    let mut target = Target::local(&view.session)?;
                    target.socket_path = view.socket_path.clone();
                    manager.watch(&device.owner, view, &target)?;
                }
            }
        }
        manager.prune();
        Ok(manager)
    }
    fn save(self: &Arc<Self>) {
        if self.cancel.is_cancelled() || self.saving.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            tokio::select! {biased;_=cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(100))=>{}}
            if let Some(manager) = weak.upgrade() {
                manager.saving.store(false, Ordering::SeqCst);
                let _ = manager.flush();
            }
        });
    }
    fn flush(&self) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        storage::atomic_write(
            &self.directory.join("herdr-push.json"),
            json!({"version":1,"devices":state.devices,"checkpoints":state.checkpoints})
                .to_string()
                .as_bytes(),
        )
        .map_err(|e| e.to_string())
    }
    fn device<'a>(state: &'a mut State, owner: &str, id: &Value) -> Result<&'a mut Device, String> {
        let owner = hash(owner);
        state
            .devices
            .iter_mut()
            .find(|d| Some(d.id.as_str()) == id.as_str() && d.owner == owner)
            .ok_or("Enable notifications on this device first.".into())
    }
    pub fn subscribe(self: &Arc<Self>, owner: &str, input: &Value) -> Result<String, String> {
        let subscription = subscription(input)?;
        let owner = hash(owner);
        let mut state = self.state.lock().unwrap();
        let id =
            if let Some(device) = state.devices.iter_mut().find(|d| {
                d.owner == owner && d.subscription["endpoint"] == subscription["endpoint"]
            }) {
                device.subscription = subscription;
                device.id.clone()
            } else {
                if state.devices.len() >= 256 {
                    return Err("The notification device limit has been reached.".into());
                }
                let id = storage::random_uuid();
                state.devices.push(Device {
                    id: id.clone(),
                    owner,
                    subscription,
                    views: vec![],
                    extra: Map::new(),
                });
                id
            };
        drop(state);
        self.save();
        Ok(id)
    }
    pub fn add_view(
        self: &Arc<Self>,
        owner: &str,
        id: &Value,
        tab: &Value,
        source: &str,
        target: &Target,
    ) -> Result<(), String> {
        let tab = tab
            .as_str()
            .filter(|s| {
                s.len() == 36
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
            })
            .ok_or("Invalid notification tab.")?;
        let view = WatchView {
            id: tab.into(),
            source: source.into(),
            session: target.session.clone(),
            remote: false,
            socket_path: target.socket_path.clone(),
            extra: Map::new(),
        };
        {
            let mut state = self.state.lock().unwrap();
            let device = Self::device(&mut state, owner, id)?;
            if !views(device).iter().any(|v| v.id == tab) && views(device).len() >= 16 {
                return Err("At most 16 Herdr tabs can send notifications per device.".into());
            }
        }
        self.watch(&hash(owner), &view, target)?;
        {
            let mut state = self.state.lock().unwrap();
            let device = Self::device(&mut state, owner, id)?;
            let mut new_views: Vec<_> = views(device)
                .iter()
                .filter(|v| v.id != tab)
                .cloned()
                .collect();
            new_views.push(view);
            device.views = new_views;
        }
        self.prune();
        self.save();
        Ok(())
    }
    pub fn remove_view(
        self: &Arc<Self>,
        owner: &str,
        id: &Value,
        tab: &Value,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap();
            let device = Self::device(&mut state, owner, id)?;
            device
                .views
                .retain(|view| Some(view.id.as_str()) != tab.as_str());
        }
        self.prune();
        self.save();
        Ok(())
    }
    pub fn remove_source(self: &Arc<Self>, owner: &str, source: &str) {
        {
            let mut state = self.state.lock().unwrap();
            for device in &mut state.devices {
                if device.owner == hash(owner) {
                    device.views.retain(|view| view.source != source);
                }
            }
        }
        self.prune();
        self.save();
    }
    pub fn unsubscribe(self: &Arc<Self>, owner: &str, id: &Value) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap();
            Self::device(&mut state, owner, id)?;
            state
                .devices
                .retain(|device| Some(device.id.as_str()) != id.as_str());
        }
        self.prune();
        self.save();
        Ok(())
    }
    pub fn presence(
        &self,
        socket: &str,
        owner: &str,
        id: &Value,
        focused: bool,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let device = Self::device(&mut state, owner, id)?;
        let presence = Presence {
            owner: device.owner.clone(),
            device: device.id.clone(),
            focused,
            until: Instant::now() + Duration::from_secs(45),
        };
        state.presence.insert(socket.into(), presence);
        Ok(())
    }
    pub fn disconnected(&self, socket: &str) {
        self.state.lock().unwrap().presence.remove(socket);
    }
    pub fn acknowledge(
        &self,
        owner: &str,
        id: &Value,
        source: &str,
        target: &Target,
        event: &Value,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let device = Self::device(&mut state, owner, id)?;
        if !event["terminalId"]
            .as_str()
            .is_some_and(|s| utf16_len(s) <= 256)
            || !["done", "request"].iter().any(|s| event["kind"] == *s)
            || !event["sequence"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0)
        {
            return Ok(());
        }
        let watch_key = key(
            &device.owner,
            &WatchView {
                id: String::new(),
                source: source.into(),
                session: target.session.clone(),
                socket_path: target.socket_path.clone(),
                remote: false,
                extra: Map::new(),
            },
        );
        let receipt = receipt(&device.id, &watch_key, event);
        state
            .acknowledgements
            .retain(|_, until| *until >= Instant::now());
        if state.acknowledgements.len() >= 1024
            && let Some(key) = state
                .acknowledgements
                .iter()
                .min_by_key(|(_, v)| **v)
                .map(|(k, _)| k.clone())
        {
            state.acknowledgements.remove(&key);
        }
        state
            .acknowledgements
            .insert(receipt, Instant::now() + Duration::from_secs(60));
        Ok(())
    }
    fn watch(
        self: &Arc<Self>,
        owner: &str,
        view: &WatchView,
        target: &Target,
    ) -> Result<(), String> {
        let key = key(owner, view);
        let mut state = self.state.lock().unwrap();
        if state.watches.contains_key(&key) {
            return Ok(());
        }
        if state.watches.len() >= 64 {
            return Err("The notification connection limit has been reached.".into());
        }
        let mut tracker = Tracker::new(state.checkpoints.get(&key));
        let cancel = self.cancel.child_token();
        state.watches.insert(
            key.clone(),
            Watch {
                cancel: cancel.clone(),
            },
        );
        drop(state);
        let target = target.clone();
        let weak = Arc::downgrade(self);
        let (send, mut receive) = tokio::sync::mpsc::channel(16);
        tokio::spawn(herdr::metadata(target.clone(), send, cancel.clone()));
        tokio::spawn(async move {
            loop {
                let message = tokio::select! {biased;_=cancel.cancelled()=>break,message=receive.recv()=>message};
                let Some(message) = message else { break };
                let herdr::Metadata::Snapshot { snapshot } = message else {
                    continue;
                };
                let Some(manager) = weak.upgrade() else { break };
                for event in tracker.update(&snapshot) {
                    manager.notify(&key, &event, &snapshot, &target);
                }
                let checkpoint = tracker.checkpoint();
                let changed = {
                    let mut state = manager.state.lock().unwrap();
                    if state.checkpoints.get(&key) != Some(&checkpoint) {
                        state.checkpoints.insert(key.clone(), checkpoint);
                        true
                    } else {
                        false
                    }
                };
                if changed {
                    manager.save();
                }
            }
        });
        Ok(())
    }
    fn notify(
        self: &Arc<Self>,
        key: &str,
        event: &Value,
        snapshot: &herdr::Snapshot,
        target: &Target,
    ) {
        let Some(agent) = snapshot
            .agents
            .iter()
            .find(|agent| Some(agent.terminal_id.as_str()) == event["terminalId"].as_str())
        else {
            return;
        };
        let devices = self.state.lock().unwrap().devices.clone();
        let preview = Arc::new(tokio::sync::OnceCell::<String>::new());
        for device in devices {
            let view = views(&device)
                .iter()
                .find(|v| self::key(&device.owner, v) == key)
                .cloned();
            let Some(view) = view else { continue };
            if !(self.owner)(&device.owner) {
                continue;
            }
            let Ok(permit) = self.pending.clone().try_acquire_owned() else {
                continue;
            };
            let manager = self.clone();
            let key = key.to_owned();
            let agent = agent.clone();
            let target = target.clone();
            let preview = preview.clone();
            let event = event.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let receipt = receipt(&device.id, &key, &event);
                let payload = async {
                    let preview = preview.get_or_init(|| target.preview(&agent)).await;
                    json!({"title":agent.name,"body":herdr::notification_body(&agent.cwd,preview),"tag":format!("herdr-{}",&hash(&(key.clone()+event["terminalId"].as_str().unwrap_or("")+event["kind"].as_str().unwrap_or("")))[..32]),"tabId":view.id,"terminalId":event["terminalId"]}).to_string()
                };
                manager.deliver(device, &key, &receipt, payload).await;
            });
        }
    }
    fn live(&self, device: &Device, key: &str, receipt: &str) -> bool {
        if self.cancel.is_cancelled() || !(self.owner)(&device.owner) {
            return false;
        }
        let state = self.state.lock().unwrap();
        !state
            .acknowledgements
            .get(receipt)
            .is_some_and(|until| *until > Instant::now())
            && state.devices.iter().any(|d| {
                d.id == device.id && views(d).iter().any(|v| self::key(&d.owner, v) == key)
            })
    }
    fn focused(&self, device: &Device) -> bool {
        self.state.lock().unwrap().presence.values().any(|p| {
            device.owner == p.owner
                && device.id == p.device
                && p.focused
                && p.until > Instant::now()
        })
    }
    async fn delay(&self, duration: Duration) -> bool {
        tokio::select! {biased;_=self.cancel.cancelled()=>false,_=tokio::time::sleep(duration)=>true}
    }
    async fn deliver(
        &self,
        device: Device,
        key: &str,
        receipt: &str,
        payload: impl std::future::Future<Output = String>,
    ) {
        if !self.delay(Duration::from_millis(300)).await {
            return;
        }
        while self.live(&device, key, receipt) && self.focused(&device) {
            if !self.delay(Duration::from_secs(1)).await {
                return;
            }
        }
        if !self.live(&device, key, receipt) {
            return;
        }
        let message =
            tokio::select! {biased;_=self.cancel.cancelled()=>return,message=payload=>message};
        while self.live(&device, key, receipt) && self.focused(&device) {
            if !self.delay(Duration::from_secs(1)).await {
                return;
            }
        }
        for attempt in 0..3 {
            if !self.live(&device, key, receipt) || self.focused(&device) {
                return;
            }
            let send = (self.send)(device.subscription.clone(), message.clone());
            let result =
                tokio::select! {biased;_=self.cancel.cancelled()=>return,result=send=>result};
            match result {
                Ok(()) => return,
                Err(error) if matches!(error.status, Some(404 | 410)) => {
                    self.state
                        .lock()
                        .unwrap()
                        .devices
                        .retain(|d| d.id != device.id);
                    self.prune();
                    let _ = self.flush();
                    return;
                }
                Err(error) if error.status.is_some_and(|s| s < 500 && s != 429) => return,
                Err(_) => {
                    if attempt < 2 && !self.delay(Duration::from_secs((attempt + 1) * 15)).await {
                        return;
                    }
                }
            }
        }
    }
    fn prune(&self) {
        let mut state = self.state.lock().unwrap();
        let live: std::collections::HashSet<_> = state
            .devices
            .iter()
            .flat_map(|d| views(d).iter().map(|v| key(&d.owner, v)))
            .collect();
        state.watches.retain(|key, watch| {
            if !live.contains(key) {
                watch.cancel.cancel();
                false
            } else {
                true
            }
        });
        state.checkpoints.retain(|key, _| live.contains(key));
    }
    pub fn dispose(&self) {
        if self.cancel.is_cancelled() {
            return;
        }
        self.cancel.cancel();
        let _ = self.flush();
    }
}
impl Drop for Notifications {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = self.flush();
    }
}
