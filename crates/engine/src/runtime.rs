//! Cooperative executor for native and browser adapters, with request-owned futures.
use crate::{
    Request,
    host::{FactValue, Host, HostOperation},
};
use futures::{future::LocalBoxFuture, task::noop_waker};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, VecDeque, hash_map::Entry},
    future::Future,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll},
};
pub const REPAIR_BUDGET_MS: f64 = 4500.0;
pub enum Call {
    Json(Request),
    Suggest {
        input: String,
        catalog: Arc<crate::types::Catalog>,
        environment: Arc<crate::validation::Environment>,
    },
    PrewarmTargets {
        catalog: Arc<crate::types::Catalog>,
        environment: Arc<crate::validation::Environment>,
    },
    WarmCommand {
        command: String,
        catalog: Arc<crate::types::Catalog>,
        environment: Arc<crate::validation::Environment>,
    },
}

#[derive(Debug)]
pub enum Output {
    Json(Value),
    Candidates(Vec<crate::types::Candidate>),
    Targets(Vec<String>),
    Warmed,
}
impl Output {
    pub fn into_json(self) -> Result<Value, String> {
        match self {
            Self::Json(value) => Ok(value),
            Self::Candidates(value) => serde_json::to_value(value).map_err(|e| e.to_string()),
            Self::Targets(value) => serde_json::to_value(value).map_err(|e| e.to_string()),
            Self::Warmed => Ok(Value::Null),
        }
    }
}

type Slot = Rc<RefCell<Option<Result<FactValue, String>>>>;
#[derive(Default)]
struct RequestHost {
    now: Cell<f64>,
    deadline: Cell<f64>,
    completion: Cell<bool>,
    queue: RefCell<VecDeque<(HostOperation, Slot)>>,
    cache: RefCell<HashMap<HostOperation, Slot>>,
    completions: RefCell<HashMap<Vec<String>, Slot>>,
}
impl Host for RequestHost {
    fn supports_completion(&self) -> bool {
        self.completion.get()
    }
    fn now_ms(&self) -> f64 {
        self.now.get()
    }
    fn deadline_ms(&self) -> f64 {
        self.deadline.get()
    }
    fn request(&self, operation: Value) -> LocalBoxFuture<'_, Result<FactValue, String>> {
        match crate::deserialize(&operation) {
            Ok(operation) => self.fact(operation),
            Err(error) => Box::pin(async move { Err(format!("Invalid host operation: {error}")) }),
        }
    }
    fn fact(&self, operation: HostOperation) -> LocalBoxFuture<'_, Result<FactValue, String>> {
        if self.deadline.get() > 0.0 && self.now.get() >= self.deadline.get() {
            return Box::pin(async { Err("Repair budget exhausted.".into()) });
        }
        let key = operation.clone();
        // A successful completion is independent of the subscriber's remaining budget.
        // Failed and pending calls retain their original timeout identity.
        let completion = match &key {
            HostOperation::Completion { words, .. } => Some(words.clone()),
            _ => None,
        };
        let completed = completion
            .as_ref()
            .and_then(|words| self.completions.borrow().get(words).cloned())
            .filter(|slot| matches!(slot.borrow().as_ref(), Some(Ok(_))));
        let weaker_stat = if let HostOperation::Stat {
            path,
            executable: false,
        } = &key
        {
            let cache = self.cache.borrow();
            cache
                .get(&HostOperation::Stat {
                    path: path.clone(),
                    executable: true,
                })
                .filter(|slot| matches!(slot.borrow().as_ref(), Some(Ok(_))))
                .cloned()
                .or_else(|| {
                    let slot = cache.get(&HostOperation::Lookup { path: path.clone() })?;
                    let result = slot.borrow();
                    let info = match result.as_ref()? {
                        Ok(FactValue::Lookup(lookup)) => lookup.info.clone(),
                        Ok(FactValue::Json(value)) => {
                            crate::deserialize::<crate::types::DirectoryLookup>(value)
                                .ok()?
                                .info
                        }
                        _ => return None,
                    };
                    Some(Rc::new(RefCell::new(Some(Ok(FactValue::Stat(info))))))
                })
        } else {
            None
        };
        let slot = if let Some(slot) = completed.or(weaker_stat) {
            slot
        } else {
            match self.cache.borrow_mut().entry(key) {
                Entry::Occupied(entry) => entry.get().clone(),
                Entry::Vacant(entry) => {
                    let slot = Rc::new(RefCell::new(None));
                    entry.insert(slot.clone());
                    self.queue.borrow_mut().push_back((operation, slot.clone()));
                    slot
                }
            }
        };
        if let Some(words) = completion {
            self.completions.borrow_mut().insert(words, slot.clone());
        }
        Box::pin(futures::future::poll_fn(move |_| {
            match slot.borrow().as_ref() {
                Some(result) => Poll::Ready(result.clone()),
                None => Poll::Pending,
            }
        }))
    }
}
#[cfg(test)]
mod completion_cache_tests {
    use super::*;
    #[test]
    fn stronger_stats_and_successful_lookups_satisfy_operand_checks() {
        let host = RequestHost::default();
        drop(host.fact(HostOperation::Stat {
            path: "/one".into(),
            executable: true,
        }));
        let (_, slot) = host.queue.borrow_mut().pop_front().unwrap();
        *slot.borrow_mut() = Some(Ok(FactValue::Stat(None)));
        drop(host.fact(HostOperation::Stat {
            path: "/one".into(),
            executable: false,
        }));
        assert!(host.queue.borrow().is_empty());
        drop(host.fact(HostOperation::Lookup {
            path: "/two".into(),
        }));
        let (_, slot) = host.queue.borrow_mut().pop_front().unwrap();
        *slot.borrow_mut() = Some(Ok(FactValue::Lookup(Arc::new(
            crate::types::DirectoryLookup::default(),
        ))));
        drop(host.fact(HostOperation::Stat {
            path: "/two".into(),
            executable: false,
        }));
        assert!(host.queue.borrow().is_empty());
        drop(host.fact(HostOperation::Stat {
            path: "/two".into(),
            executable: true,
        }));
        assert_eq!(host.queue.borrow().len(), 1);
    }
    #[test]
    fn successful_completion_reuses_results_across_budgets_but_errors_retry() {
        let host = RequestHost::default();
        let op = |timeout| serde_json::json!({"kind":"completion","words":["tool","x"],"timeoutMs":timeout});
        drop(host.request(op(1000.0)));
        let (_, slot) = host.queue.borrow_mut().pop_front().unwrap();
        *slot.borrow_mut() = Some(Ok(FactValue::Completion(Arc::new(vec!["value".into()]))));
        drop(host.request(op(900.0)));
        assert!(host.queue.borrow().is_empty());
        *slot.borrow_mut() = Some(Err("Timed out".into()));
        drop(host.request(op(800.0)));
        assert_eq!(host.queue.borrow().len(), 1);
    }
}
struct Task {
    host: Rc<RequestHost>,
    future: LocalBoxFuture<'static, Result<Output, String>>,
    waiting: BTreeMap<u32, Vec<Slot>>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct HostRequest {
    pub request: u32,
    pub operations: Vec<HostOperation>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Reply {
    #[serde(skip)]
    Native {
        request: u32,
        results: Vec<Result<FactValue, String>>,
    },
    Results {
        request: u32,
        results: Vec<HostResult>,
    },
    Values {
        request: u32,
        values: Vec<Value>,
    },
    Error {
        request: u32,
        error: String,
    },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HostResult {
    Value { value: Value },
    Error { error: String },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Step<T = Value> {
    Pending {
        request: u32,
        callbacks: Vec<HostRequest>,
    },
    Complete {
        request: u32,
        value: T,
    },
    Error {
        request: u32,
        error: String,
    },
}
impl Step<Output> {
    fn into_json(self) -> Step {
        match self {
            Self::Pending { request, callbacks } => Step::Pending { request, callbacks },
            Self::Error { request, error } => Step::Error { request, error },
            Self::Complete { request, value } => match value.into_json() {
                Ok(value) => Step::Complete { request, value },
                Err(error) => Step::Error { request, error },
            },
        }
    }
}
#[derive(Default)]
pub struct Runtime {
    tasks: BTreeMap<u32, Task>,
    callback: u32,
    highest_request: u32,
    discovery: Rc<crate::discovery::Discovery>,
}
#[derive(Deserialize)]
struct Start {
    request: u32,
    #[serde(flatten)]
    call: Request,
    now: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resume {
    request: u32,
    replies: Vec<Reply>,
    now: f64,
}
/// Run a call to completion, resolving each batch of host operations with `resolve`.
/// The call starts before this returns, so concurrent calls keep their start order; dropping the future cancels it.
pub fn drive<'a, F: Future<Output = Vec<Result<FactValue, String>>> + 'a>(
    runtime: Rc<RefCell<Runtime>>,
    id: u32,
    call: Call,
    now: impl Fn() -> f64 + 'a,
    resolve: impl Fn(Vec<HostOperation>) -> F + 'a,
) -> impl Future<Output = Result<Output, String>> + 'a {
    struct Cancel(Rc<RefCell<Runtime>>, u32);
    impl Drop for Cancel {
        fn drop(&mut self) {
            self.0.borrow_mut().cancel(self.1);
        }
    }
    let mut step = runtime.borrow_mut().start_call(id, call, now());
    let request = Cancel(runtime, id);
    async move {
        loop {
            match step {
                Step::Complete { value, .. } => return Ok(value),
                Step::Error { error, .. } => return Err(error),
                Step::Pending { callbacks, .. } => {
                    let replies =
                        futures::future::join_all(callbacks.into_iter().map(|callback| {
                            let results = resolve(callback.operations);
                            async move {
                                Reply::Native {
                                    request: callback.request,
                                    results: results.await,
                                }
                            }
                        }))
                        .await;
                    step = request.0.borrow_mut().resume_call(id, replies, now());
                }
            }
        }
    }
}
pub fn message(runtime: &mut Runtime, bytes: &[u8], resume: bool) -> Step {
    let result = if bytes.len() > crate::INPUT_LIMIT {
        Err("Engine request exceeds 64 MiB.".into())
    } else if resume {
        crate::deserialize_bytes::<Resume>(bytes)
            .map(|message| runtime.resume(message.request, message.replies, message.now))
            .map_err(|error| error.to_string())
    } else {
        crate::deserialize_bytes::<Start>(bytes)
            .map(|message| runtime.start(message.request, message.call, message.now))
            .map_err(|error| error.to_string())
    };
    result.unwrap_or_else(|error| Step::Error { request: 0, error })
}
impl Runtime {
    pub fn start(&mut self, id: u32, request: Request, now: f64) -> Step {
        self.start_call(id, Call::Json(request), now).into_json()
    }
    pub fn start_call(&mut self, id: u32, call: Call, now: f64) -> Step<Output> {
        if id <= self.highest_request
            || self.tasks.contains_key(&id)
            || self.tasks.len() >= 32
            || !now.is_finite()
            || now < 0.0
        {
            return Step::Error {
                request: id,
                error: "Invalid or exhausted engine request ID.".into(),
            };
        }
        self.highest_request = id;
        let host = Rc::new(RequestHost::default());
        host.now.set(now);
        host.deadline.set(now + REPAIR_BUDGET_MS);
        host.completion.set(match &call {
            Call::Suggest { .. } | Call::PrewarmTargets { .. } | Call::WarmCommand { .. } => true,
            Call::Json(request) => request
                .args
                .get(if request.operation.starts_with("suggest") {
                    3
                } else {
                    4
                })
                .and_then(Value::as_bool)
                .unwrap_or(true),
        });
        let adapter = host.clone();
        let discovery = self.discovery.clone();
        let future = Box::pin(async move {
            match call {
                Call::Json(request) => {
                    crate::dispatch_with_discovery(&request, adapter.as_ref(), &discovery)
                        .await
                        .map(Output::Json)
                }
                Call::PrewarmTargets {
                    catalog,
                    environment,
                } => Ok(Output::Targets(discovery.prewarm_targets(
                    &catalog,
                    &environment,
                    adapter.now_ms(),
                ))),
                Call::WarmCommand {
                    command,
                    catalog,
                    environment,
                } => {
                    discovery
                        .discover(&command, &catalog, &environment, adapter.as_ref())
                        .await?;
                    discovery.mark_warmed(&command, &catalog, &environment, adapter.now_ms());
                    Ok(Output::Warmed)
                }
                Call::Suggest {
                    input,
                    catalog,
                    environment,
                } => {
                    let stage = RefCell::new(None);
                    let candidates = crate::suggestions::suggest(
                        &input,
                        &catalog,
                        &environment,
                        &discovery,
                        adapter.as_ref(),
                        &stage,
                    )
                    .await?;
                    Ok(Output::Candidates(candidates))
                }
            }
        });
        self.tasks.insert(
            id,
            Task {
                host,
                future,
                waiting: BTreeMap::new(),
            },
        );
        self.poll(id)
    }
    pub fn resume(&mut self, id: u32, replies: Vec<Reply>, now: f64) -> Step {
        self.resume_call(id, replies, now).into_json()
    }
    fn resume_call(&mut self, id: u32, replies: Vec<Reply>, now: f64) -> Step<Output> {
        let Some(task) = self.tasks.get_mut(&id) else {
            return Step::Error {
                request: id,
                error: "Unknown or cancelled engine request.".into(),
            };
        };
        if !now.is_finite() || now < task.host.now.get() {
            self.cancel(id);
            return Step::Error {
                request: id,
                error: "Invalid host clock.".into(),
            };
        }
        // Validate the whole reply batch before making any result visible.
        let mut seen = BTreeMap::new();
        for reply in &replies {
            let (callback, length) = match reply {
                Reply::Values { request, values } => (*request, Some(values.len())),
                Reply::Results { request, results } => (*request, Some(results.len())),
                Reply::Native { request, results } => (*request, Some(results.len())),
                Reply::Error { request, .. } => (*request, None),
            };
            let valid = task
                .waiting
                .get(&callback)
                .is_some_and(|slots| length.is_none_or(|length| length == slots.len()))
                && seen.insert(callback, ()).is_none();
            if !valid {
                self.cancel(id);
                return Step::Error {
                    request: id,
                    error: "Invalid or incomplete host reply.".into(),
                };
            }
        }
        task.host.now.set(now);
        for reply in replies {
            match reply {
                Reply::Native { request, results } => {
                    for (slot, result) in task
                        .waiting
                        .remove(&request)
                        .expect("validated callback")
                        .into_iter()
                        .zip(results)
                    {
                        *slot.borrow_mut() = Some(result);
                    }
                }
                Reply::Results { request, results } => {
                    for (slot, result) in task
                        .waiting
                        .remove(&request)
                        .expect("validated callback")
                        .into_iter()
                        .zip(results)
                    {
                        *slot.borrow_mut() = Some(match result {
                            HostResult::Value { value } => Ok(value.into()),
                            HostResult::Error { error } => Err(error),
                        });
                    }
                }
                Reply::Values { request, values } => {
                    for (slot, value) in task
                        .waiting
                        .remove(&request)
                        .expect("validated callback")
                        .into_iter()
                        .zip(values)
                    {
                        *slot.borrow_mut() = Some(Ok(value.into()));
                    }
                }
                Reply::Error { request, error } => {
                    for slot in task.waiting.remove(&request).expect("validated callback") {
                        *slot.borrow_mut() = Some(Err(error.clone()));
                    }
                }
            }
        }
        self.poll(id)
    }
    pub fn cancel(&mut self, id: u32) {
        self.tasks.remove(&id);
    }
    pub fn reset(&mut self) {
        self.tasks.clear();
        self.discovery.clear();
    }
    pub fn active(&self) -> usize {
        self.tasks.len()
    }
    fn poll(&mut self, id: u32) -> Step<Output> {
        let task = self.tasks.get_mut(&id).expect("active task");
        match task
            .future
            .as_mut()
            .poll(&mut Context::from_waker(&noop_waker()))
        {
            Poll::Ready(result) => {
                self.tasks.remove(&id);
                match result {
                    Ok(value) => Step::Complete { request: id, value },
                    Err(error) => Step::Error { request: id, error },
                }
            }
            Poll::Pending => {
                let mut callbacks = Vec::new();
                let mut queue = task.host.queue.borrow_mut();
                while !queue.is_empty() {
                    let Some(callback) = self.callback.checked_add(1) else {
                        drop(queue);
                        self.cancel(id);
                        return Step::Error {
                            request: id,
                            error: "Host callback IDs exhausted.".into(),
                        };
                    };
                    self.callback = callback;
                    let count = queue.len().min(64);
                    let (operations, slots): (Vec<_>, Vec<_>) = queue.drain(..count).unzip();
                    task.waiting.insert(callback, slots);
                    callbacks.push(HostRequest {
                        request: callback,
                        operations,
                    });
                }
                Step::Pending {
                    request: id,
                    callbacks,
                }
            }
        }
    }
}
