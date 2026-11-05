//! One live Herdr Core session per target, shared by metadata streams, lookups and input checks.
use super::*;
use crate::herdr::ResourceKey;
use herdr_client_lib::protocol;
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{LazyLock, Mutex, Weak},
};
use tokio::sync::{Notify, watch};

/// Keeps a session open after it starts, so a burst of lookups without a metadata stream shares one connection.
const LINGER: Duration = Duration::from_secs(30);

pub(super) struct Live {
    pub client: Client,
    pub snapshot: Arc<Snapshot>,
    /// Advances whenever the session subscribes afresh, so a caller can wait for a complete view.
    generation: u64,
    records: BTreeMap<String, protocol::Terminal>,
}
impl Live {
    pub fn record(&self, terminal: &str) -> Result<&protocol::Terminal, String> {
        self.records
            .get(terminal)
            .ok_or_else(|| "This terminal has ended.".into())
    }
}
type State = Option<Result<Arc<Live>, String>>;
use projection::Repositories;
struct Hub {
    state: watch::Receiver<State>,
    refresh: Arc<Notify>,
    cancel: CancellationToken,
}
impl Drop for Hub {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
static HUBS: LazyLock<Mutex<HashMap<ResourceKey, Weak<Hub>>>> = LazyLock::new(Default::default);

fn hub(target: &Target) -> Result<Arc<Hub>, String> {
    let key = target.key("")?;
    let mut hubs = HUBS.lock().unwrap();
    hubs.retain(|_, hub| hub.strong_count() > 0);
    if let Some(hub) = hubs.get(&key).and_then(Weak::upgrade) {
        return Ok(hub);
    }
    let (send, state) = watch::channel(None);
    let hub = Arc::new(Hub {
        state,
        refresh: Arc::default(),
        cancel: CancellationToken::new(),
    });
    let run = run(
        target.clone(),
        send,
        hub.refresh.clone(),
        hub.cancel.clone(),
    );
    tokio::spawn(run);
    hubs.insert(key, Arc::downgrade(&hub));
    let linger = hub.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LINGER).await;
        drop(linger);
    });
    Ok(hub)
}

/// The shared session, reconnecting at once if the previous connection failed.
pub(super) async fn live(target: &Target) -> Result<Arc<Live>, String> {
    let hub = hub(target)?;
    let mut state = hub.state.clone();
    let retry = matches!(&*state.borrow_and_update(), Some(Err(_)));
    if retry {
        hub.refresh.notify_one();
    }
    let published = async {
        if retry {
            state.changed().await?;
        }
        state
            .wait_for(Option::is_some)
            .await
            .map(|state| state.clone())
    };
    match tokio::time::timeout(DEADLINE, published).await {
        Ok(Ok(Some(result))) => result,
        Ok(_) => Err("Herdr Core session closed.".into()),
        Err(_) => Err("Herdr Core did not respond.".into()),
    }
}
/// Resubscribes the shared session after another connection changed the workspace, so later reads include it.
pub(super) async fn refresh(target: &Target) -> Result<(), String> {
    let hub = hub(target)?;
    let mut state = hub.state.clone();
    let since = match &*state.borrow_and_update() {
        Some(Ok(live)) => live.generation,
        _ => 0,
    };
    hub.refresh.notify_one();
    let fresh = state.wait_for(|state| matches!(state, Some(Ok(live)) if live.generation > since));
    match tokio::time::timeout(DEADLINE, fresh).await {
        Ok(Ok(_)) => Ok(()),
        _ => Err("Herdr Core did not refresh.".into()),
    }
}

pub async fn metadata(
    target: &Target,
    send: tokio::sync::mpsc::Sender<Metadata>,
    cancel: CancellationToken,
) {
    let hub = match hub(target) {
        Ok(hub) => hub,
        Err(message) => {
            let _ = send.send(Metadata::Error { message }).await;
            return;
        }
    };
    let mut state = hub.state.clone();
    let mut previous: Option<Arc<Snapshot>> = None;
    loop {
        let update = match &*state.borrow_and_update() {
            Some(Ok(live)) if previous.as_ref() != Some(&live.snapshot) => {
                previous = Some(live.snapshot.clone());
                Some(Metadata::Snapshot {
                    snapshot: live.snapshot.clone(),
                })
            }
            Some(Err(message)) => {
                previous = None;
                Some(Metadata::Error {
                    message: message.clone(),
                })
            }
            _ => None,
        };
        if let Some(update) = update {
            tokio::select! {
                _ = cancel.cancelled() => break,
                result = send.send(update) => if result.is_err() { break; }
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            result = state.changed() => if result.is_err() { break; }
        }
    }
}

async fn run(
    target: Target,
    send: watch::Sender<State>,
    refresh: Arc<Notify>,
    cancel: CancellationToken,
) {
    let work = async {
        let mut repositories = Repositories::new();
        let mut generation = 0;
        loop {
            let Err(message) =
                serve(&target, &send, &refresh, &mut repositories, &mut generation).await;
            send.send_replace(Some(Err(message)));
            tokio::select! { _ = refresh.notified() => (), _ = tokio::time::sleep(Duration::from_secs(2)) => () }
        }
    };
    tokio::select! { _ = cancel.cancelled() => (), _ = work => () }
}
async fn serve(
    target: &Target,
    send: &watch::Sender<State>,
    refresh: &Notify,
    repositories: &mut Repositories,
    generation: &mut u64,
) -> Result<Infallible, String> {
    let mut session = session(target).await?;
    let mut initial = projection::project(&session)?;
    let requests = projection::repositories(&session, &mut initial, repositories);
    *repositories =
        projection::refresh_repositories(session.client.clone(), repositories.clone(), requests)
            .await;
    *generation += 1;
    let mut checking: Option<futures::future::BoxFuture<'static, Repositories>> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let mut snapshot = projection::project(&session)?;
        let requests = projection::repositories(&session, &mut snapshot, repositories);
        if checking.is_none() && !requests.is_empty() {
            checking = Some(Box::pin(projection::refresh_repositories(
                session.client.clone(),
                repositories.clone(),
                requests,
            )));
        }
        let records = session
            .terminals
            .iter()
            .map(|(identity, record)| (projection::terminal_key(identity, record), record.clone()))
            .collect();
        send.send_replace(Some(Ok(Arc::new(Live {
            client: session.client.clone(),
            snapshot: Arc::new(snapshot),
            generation: *generation,
            records,
        }))));
        tokio::select! {
            event = session.next() => { event.map_err(error)?; reconcile(&mut session).await?; }
            result = async { checking.as_mut().unwrap().await }, if checking.is_some() => {
                *repositories = result;
                checking = None;
            }
            _ = tick.tick() => (),
            _ = refresh.notified() => {
                session.reconnect(session.client.clone()).await.map_err(error)?;
                reconcile(&mut session).await?;
                checking = None;
                repositories.clear();
                let mut snapshot = projection::project(&session)?;
                let requests = projection::repositories(&session, &mut snapshot, repositories);
                *repositories = projection::refresh_repositories(session.client.clone(), repositories.clone(), requests).await;
                *generation += 1;
            }
        }
    }
}
