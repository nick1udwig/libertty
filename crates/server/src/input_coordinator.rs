//! Shared repair and microphone lifecycle; adapters own terminal effects and guards.
use crate::{
    alternatives::{self, Prepared},
    dictation::Recording,
    protocol::Repair,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
#[serde(tag = "type", rename = "repair-result")]
pub(crate) struct RepairReply {
    pub id: String,
    pub prompt: u64,
    pub revision: u64,
    pub accepted: bool,
    #[serde(flatten)]
    pub prepared: Prepared,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'static str>,
}
impl RepairReply {
    pub fn new(id: String, text: String, prompt: u64, revision: u64, backend: bool) -> Self {
        Self {
            id,
            prompt,
            revision,
            accepted: false,
            prepared: Prepared {
                original: text.clone(),
                selected: text,
                candidates: vec![],
            },
            error: None,
            source: backend.then_some("dictation"),
        }
    }
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("repair reply")
    }
    pub fn backend(&self) -> bool {
        self.source.is_some()
    }
}

pub(crate) trait RepairTarget: Send + Sync + 'static {
    type Guard: Send + 'static;
    fn lifetime(&self) -> &CancellationToken;
    fn begin_repair(
        &self,
        guard: &Self::Guard,
        reply: &mut RepairReply,
        cancel: CancellationToken,
    ) -> bool;
    fn suggest(
        &self,
        text: &str,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Value, String>> + Send;
    // Applying text and sending its acknowledgement stay atomic where the adapter permits it.
    fn complete_repair(
        &self,
        guard: Self::Guard,
        reply: RepairReply,
        cancel: CancellationToken,
    ) -> impl Future<Output = ()> + Send;
}
pub(crate) fn repair<T: RepairTarget>(
    target: Arc<T>,
    guard: T::Guard,
    request: Repair,
    backend: bool,
) {
    let cancel = target.lifetime().child_token();
    let mut reply = RepairReply::new(
        request.id,
        request.text,
        request.prompt,
        request.revision,
        backend,
    );
    if !target.begin_repair(&guard, &mut reply, cancel.clone()) {
        return;
    }
    tokio::spawn(async move {
        let provider = &target;
        let token = &cancel;
        let result = prepare(
            &reply.prepared.original,
            &request.intent,
            &cancel,
            Duration::from_secs(10),
            |text| Box::pin(async move { provider.suggest(&text, token).await }),
        )
        .await;
        match result {
            Ok(prepared) => reply.prepared = prepared,
            Err(error) => reply.error = Some(error),
        }
        target.complete_repair(guard, reply, cancel).await;
    });
}

async fn prepare<'a>(
    text: &str,
    intent: &alternatives::Intent,
    cancel: &CancellationToken,
    timeout: Duration,
    suggest: impl FnMut(String) -> futures::future::BoxFuture<'a, Result<Value, String>>,
) -> Result<Prepared, String> {
    let prepared = alternatives::prepare(text, intent, suggest);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Repair cancelled.".to_owned()),
        result = tokio::time::timeout(timeout, prepared) => {
            result.unwrap_or_else(|_| {
                cancel.cancel();
                Err("Repair timed out.".into())
            })
        }
    }
}

pub(crate) trait RecordingTarget: Send + Sync + 'static {
    type Guard: Clone + Send + Sync + 'static;
    const CHANGED: &'static str;
    fn dictated(
        self: &Arc<Self>,
        guard: Self::Guard,
        id: String,
        serial: u64,
        text: String,
        phrases: Value,
    ) -> impl Future<Output = Result<(), String>> + Send;
    fn recording_status(
        &self,
        guard: &Self::Guard,
        id: &str,
        serial: u64,
        state: &str,
        reply: Value,
    );
}
pub(crate) fn recording<T: RecordingTarget>(
    target: &Arc<T>,
    guard: T::Guard,
    id: String,
    serial: u64,
    phrases: Value,
) -> Recording {
    let weak = Arc::downgrade(target);
    let result_guard = guard.clone();
    let result_id = id.clone();
    let result = Arc::new(move |text: String| {
        let (weak, guard, id, phrases) = (
            weak.clone(),
            result_guard.clone(),
            result_id.clone(),
            phrases.clone(),
        );
        Box::pin(async move {
            let target = weak.upgrade().ok_or(T::CHANGED)?;
            target.dictated(guard, id, serial, text, phrases).await
        }) as futures::future::BoxFuture<'static, Result<(), String>>
    });
    let weak = Arc::downgrade(target);
    let status = Arc::new(move |state: &str, message: Option<String>| {
        if let Some(target) = weak.upgrade() {
            let mut reply = json!({"type":"dictation","id":id,"state":state});
            if let Some(message) = message {
                reply["message"] = json!(message);
            }
            target.recording_status(&guard, &id, serial, state, reply);
        }
    });
    Recording::start_async(std::env::vars().collect(), result, status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn cancellation_wins_over_a_ready_fact_reply() {
        let token = CancellationToken::new();
        token.cancel();
        let result = prepare(
            "echo words",
            &alternatives::Intent::Shell,
            &token,
            Duration::from_secs(10),
            |_| {
                Box::pin(async {
                    panic!("Cancelled repairs must not fetch facts");
                })
            },
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("Repair cancelled."));
    }
    #[tokio::test]
    async fn deadline_drops_pending_facts_and_cancels_child_work() {
        let token = CancellationToken::new();
        let child = token.child_token();
        let dropped = Arc::new(AtomicBool::new(false));
        let result = prepare(
            "echo words",
            &alternatives::Intent::Shell,
            &token,
            Duration::from_millis(20),
            |_| {
                let guard = Dropped(dropped.clone());
                Box::pin(async move {
                    let _guard = guard;
                    std::future::pending().await
                })
            },
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("Repair timed out."));
        assert!(child.is_cancelled());
        assert!(dropped.load(Ordering::SeqCst));
    }
    #[test]
    fn rejected_and_backend_replies_match_the_terminal_contract() {
        let reply = RepairReply::new("one".into(), "echo words".into(), 3, 4, false).value();
        assert_eq!(
            reply,
            json!({"type":"repair-result","id":"one","prompt":3,"revision":4,"accepted":false,"original":"echo words","selected":"echo words","candidates":[]})
        );
        let mut reply = RepairReply::new("two".into(), "echo words".into(), 3, 4, true);
        reply.error = Some("Repair timed out.".into());
        assert_eq!(reply.value()["source"], "dictation");
        assert_eq!(reply.value()["error"], "Repair timed out.");
    }
}
