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
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};

/// How long a finished reply stays available to retries.
const RETAINED: Duration = Duration::from_secs(600);
const ENTRIES: usize = 4096;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
/// Replies beyond the per-response or cache byte limit are delivered once and never repeated.
const REPLY_BYTES: u64 = 256 * 1024;

struct StoredBody {
    bytes: Bytes,
    _reservation: OwnedSemaphorePermit,
}
#[derive(Clone)]
struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Option<Arc<StoredBody>>,
    completed: Instant,
}
impl Reply {
    /// Keep a copy of a small reply for retries, and return the reply for the original request.
    async fn keep(response: Response<Body>, capacity: &Arc<Semaphore>) -> (Self, Response<Body>) {
        let (parts, body) = response.into_parts();
        let small = body
            .size_hint()
            .exact()
            .is_some_and(|size| size <= REPLY_BYTES);
        let (body, original) = if small {
            match axum::body::to_bytes(body, REPLY_BYTES as usize).await {
                Ok(bytes) => {
                    let stored = capacity
                        .clone()
                        .try_acquire_many_owned(bytes.len() as u32)
                        .ok()
                        .map(|reservation| {
                            Arc::new(StoredBody {
                                bytes: bytes.clone(),
                                _reservation: reservation,
                            })
                        });
                    (stored, Body::from(bytes))
                }
                Err(_) => (None, Body::empty()),
            }
        } else {
            (None, body)
        };
        let reply = Self {
            status: parts.status,
            headers: parts.headers.clone(),
            body,
            completed: Instant::now(),
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
        let mut response = Response::new(Body::from(body.bytes.clone()));
        *response.status_mut() = self.status;
        *response.headers_mut() = self.headers;
        response
    }
}
/// A reply that is pending until its request finishes.
type Slot = watch::Receiver<Option<Reply>>;
pub(crate) struct Replies {
    slots: Mutex<HashMap<String, (Slot, Instant)>>,
    capacity: Arc<Semaphore>,
}
impl Default for Replies {
    fn default() -> Self {
        Self {
            slots: Mutex::default(),
            capacity: Arc::new(Semaphore::new(CACHE_BYTES)),
        }
    }
}
impl Replies {
    /// The reply slot for a key, and the publisher when this request is the first to use it.
    fn slot(&self, scope: String) -> Option<(Slot, Option<watch::Sender<Option<Reply>>>)> {
        let mut replies = self.slots.lock().unwrap();
        let now = Instant::now();
        replies.retain(|_, (slot, opened)| match slot.borrow().as_ref() {
            Some(reply) => now.duration_since(reply.completed) < RETAINED,
            None => slot.has_changed().is_ok() || now.duration_since(*opened) < RETAINED,
        });
        if let Some((slot, _)) = replies.get(&scope) {
            return Some((slot.clone(), None));
        }
        if replies.len() >= ENTRIES {
            return None;
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
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The request limit has been reached. Try again shortly.",
        );
    };
    if let Some(publish) = first {
        // The request finishes even if the browser abandons this connection, so its retry collects the reply.
        let (deliver, delivered) = oneshot::channel();
        tokio::spawn(async move {
            let (reply, response) = Reply::keep(next.run(req).await, &app.replies.capacity).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saturation_preserves_pending_and_completed_keys_until_retention_expires() {
        let replies = Replies::default();
        let mut publishers = Vec::new();
        for index in 0..ENTRIES {
            let (_, publish) = replies.slot(index.to_string()).unwrap();
            publishers.push(publish.unwrap());
        }
        assert!(replies.slot("overflow".into()).is_none());
        assert!(replies.slot("0".into()).unwrap().1.is_none());
        let (reply, _) = Reply::keep(Response::new(Body::from("done")), &replies.capacity).await;
        let old = Instant::now() - RETAINED - Duration::from_secs(1);
        replies.slots.lock().unwrap().get_mut("0").unwrap().1 = old;
        publishers[0].send_replace(Some(reply.clone()));
        assert!(
            replies.slot("overflow".into()).is_none(),
            "Retention starts when work completes"
        );
        let (slot, publish) = replies.slot("0".into()).unwrap();
        assert!(publish.is_none());
        assert_eq!(
            slot.borrow().clone().unwrap().response().status(),
            StatusCode::OK
        );
        publishers[0].send_replace(Some(Reply {
            completed: old,
            ..reply
        }));
        assert!(replies.slot("overflow".into()).unwrap().1.is_some());
        assert_eq!(replies.slots.lock().unwrap().len(), ENTRIES);
    }

    #[tokio::test]
    async fn reply_bytes_are_bounded_and_exhaustion_keeps_a_non_repeating_record() {
        let capacity = Arc::new(Semaphore::new(3));
        let (first, original) = Reply::keep(Response::new(Body::from("abc")), &capacity).await;
        assert_eq!(capacity.available_permits(), 0);
        assert_eq!(
            axum::body::to_bytes(original.into_body(), 3).await.unwrap(),
            "abc"
        );
        let (second, original) = Reply::keep(Response::new(Body::from("def")), &capacity).await;
        assert_eq!(
            axum::body::to_bytes(original.into_body(), 3).await.unwrap(),
            "def"
        );
        assert_eq!(second.response().status(), StatusCode::CONFLICT);
        assert_eq!(first.clone().response().status(), StatusCode::OK);
        drop(first);
        assert_eq!(capacity.available_permits(), 3);
    }
}
