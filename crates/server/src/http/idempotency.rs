//! Replays the reply to a request retried with the same `Idempotency-Key` instead of performing it twice.
use super::{App, error};
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};

/// How long a finished reply stays available to retries.
const RETAINED: Duration = Duration::from_secs(600);
const ENTRIES: usize = 128;
/// Larger replies are delivered once and never repeated.
const REPLY_BYTES: u64 = 256 * 1024;

#[derive(Clone)]
struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Option<Bytes>,
}
impl Reply {
    /// Keep a copy of a small reply for retries, and return the reply for the original request.
    async fn keep(response: Response<Body>) -> (Self, Response<Body>) {
        let (parts, body) = response.into_parts();
        let small = body
            .size_hint()
            .exact()
            .is_some_and(|size| size <= REPLY_BYTES);
        let (body, original) = if small {
            match axum::body::to_bytes(body, REPLY_BYTES as usize).await {
                Ok(bytes) => (Some(bytes.clone()), Body::from(bytes)),
                Err(_) => (None, Body::empty()),
            }
        } else {
            (None, body)
        };
        let reply = Self {
            status: parts.status,
            headers: parts.headers.clone(),
            body,
        };
        (reply, Response::from_parts(parts, original))
    }
    fn response(self) -> Response<Body> {
        let Some(body) = self.body else {
            return error(
                StatusCode::CONFLICT,
                "This request already finished. Reload to see its result.",
            );
        };
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = self.status;
        *response.headers_mut() = self.headers;
        response
    }
}
/// A reply that is pending until its request finishes.
type Slot = watch::Receiver<Option<Reply>>;
#[derive(Default)]
pub(crate) struct Replies(Mutex<HashMap<String, (Slot, Instant)>>);
impl Replies {
    /// The reply slot for a key, and the publisher when this request is the first to use it.
    fn slot(&self, scope: String) -> Option<(Slot, Option<watch::Sender<Option<Reply>>>)> {
        let mut replies = self.0.lock().unwrap();
        let now = Instant::now();
        // A reply that finished, or whose request ended without one, no longer coalesces retries.
        let finished = |slot: &Slot| slot.borrow().is_some() || slot.has_changed().is_err();
        replies
            .retain(|_, (slot, opened)| !finished(slot) || now.duration_since(*opened) < RETAINED);
        if let Some((slot, _)) = replies.get(&scope) {
            return Some((slot.clone(), None));
        }
        if replies.len() >= ENTRIES {
            let oldest = replies
                .iter()
                .filter(|(_, (slot, _))| finished(slot))
                .min_by_key(|(_, (_, opened))| *opened)
                .map(|(scope, _)| scope.clone())?;
            replies.remove(&oldest);
        }
        let (publish, slot) = watch::channel(None);
        replies.insert(scope, (slot.clone(), now));
        Some((slot, Some(publish)))
    }
}
fn key<B>(req: &Request<B>) -> Option<&str> {
    [Method::POST, Method::DELETE]
        .contains(req.method())
        .then(|| req.headers().get("idempotency-key")?.to_str().ok())
        .flatten()
        .filter(|key| {
            (1..=64).contains(&key.len())
                && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
pub(super) async fn idempotent(
    State(app): State<Arc<App>>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let Some(key) = key(&req) else {
        return next.run(req).await;
    };
    let scope = format!(
        "{}\n{} {}\n{key}",
        app.owner(req.headers()).unwrap_or_default(),
        req.method(),
        req.uri().path()
    );
    let Some((mut slot, first)) = app.replies.slot(scope) else {
        return next.run(req).await;
    };
    if let Some(publish) = first {
        // The request finishes even if the browser abandons this connection, so its retry collects the reply.
        let (deliver, delivered) = oneshot::channel();
        tokio::spawn(async move {
            let (reply, response) = Reply::keep(next.run(req).await).await;
            let _ = publish.send(Some(reply));
            let _ = deliver.send(response);
        });
        return delivered
            .await
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Request failed."));
    }
    match slot.wait_for(Option::is_some).await {
        Ok(reply) => reply.clone().unwrap().response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Request failed."),
    }
}
