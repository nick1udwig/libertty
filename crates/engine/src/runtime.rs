//! Cooperative executor for native and browser adapters, with request-owned futures.
use crate::{
    Request,
    host::{FactValue, Host},
};
use futures::{future::LocalBoxFuture, task::noop_waker};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, VecDeque, hash_map::Entry},
    rc::Rc,
    sync::Arc,
    task::{Context, Poll},
};
pub enum Call {
    Json(Request),
    Suggest {
        input: String,
        catalog: Arc<crate::types::Catalog>,
        environment: Arc<crate::validation::Environment>,
    },
}

type Slot = Rc<RefCell<Option<Result<FactValue, String>>>>;
#[derive(Deserialize, Hash, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum OperationKey {
    Stat {
        path: String,
        executable: bool,
    },
    Lookup {
        path: String,
    },
    Entries {
        path: String,
        limit: usize,
    },
    Syntax {
        command: String,
    },
    Completion {
        words: Vec<String>,
        #[serde(rename = "timeoutMs", deserialize_with = "timeout_bits")]
        timeout: u64,
    },
    Help {
        command: String,
        route: Vec<String>,
    },
    Describe {
        command: String,
    },
}
fn timeout_bits<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    f64::deserialize(deserializer).map(f64::to_bits)
}
#[derive(Hash, PartialEq, Eq)]
enum FactKey {
    Typed(OperationKey),
    Json(String),
}
#[derive(Default)]
struct RequestHost {
    now: Cell<f64>,
    completion: Cell<bool>,
    queue: RefCell<VecDeque<(Value, Slot)>>,
    cache: RefCell<HashMap<FactKey, Slot>>,
    completions: RefCell<HashMap<Vec<String>, Slot>>,
}
impl Host for RequestHost {
    fn supports_completion(&self) -> bool {
        self.completion.get()
    }
    fn now_ms(&self) -> f64 {
        self.now.get()
    }
    fn request(&self, operation: Value) -> LocalBoxFuture<'_, Result<FactValue, String>> {
        let key = OperationKey::deserialize(&operation)
            .map(FactKey::Typed)
            .unwrap_or_else(|_| FactKey::Json(operation.to_string()));
        // A successful completion is independent of the subscriber's remaining budget.
        // Failed and pending calls retain their original timeout identity.
        let completion = match &key {
            FactKey::Typed(OperationKey::Completion { words, .. }) => Some(words.clone()),
            _ => None,
        };
        let completed = completion
            .as_ref()
            .and_then(|words| self.completions.borrow().get(words).cloned())
            .filter(|slot| matches!(slot.borrow().as_ref(), Some(Ok(_))));
        let slot = if let Some(slot) = completed {
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
    future: LocalBoxFuture<'static, Result<Value, String>>,
    waiting: BTreeMap<u32, Vec<Slot>>,
    directories: BTreeMap<u32, crate::types::SharedList<crate::types::DirectoryEntry>>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct HostRequest {
    pub request: u32,
    pub operations: Vec<Value>,
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
    Entries { entries: u32 },
    Lookup { lookup: DirectoryReference },
}
#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryReference {
    pub directory: u32,
    pub version: String,
    pub complete: bool,
}
#[derive(Debug, Deserialize)]
pub struct DirectoryPin {
    pub directory: u32,
    #[serde(default, deserialize_with = "present_entries")]
    pub entries: Option<crate::types::SharedList<crate::types::DirectoryEntry>>,
}
fn present_entries<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<crate::types::SharedList<crate::types::DirectoryEntry>>, D::Error> {
    crate::types::SharedList::deserialize(deserializer).map(Some)
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Step {
    Pending {
        request: u32,
        callbacks: Vec<HostRequest>,
    },
    Complete {
        request: u32,
        value: Value,
    },
    Error {
        request: u32,
        error: String,
    },
}
#[derive(Default)]
pub struct Runtime {
    tasks: BTreeMap<u32, Task>,
    callback: u32,
    highest_request: u32,
    discovery: Rc<crate::discovery::Discovery>,
    prepared: Option<(
        u32,
        Arc<crate::types::Catalog>,
        Arc<crate::validation::Environment>,
    )>,
    highest_context: u32,
    directories: VecDeque<(u32, crate::types::SharedList<crate::types::DirectoryEntry>)>,
    highest_directory: u32,
}
#[derive(Deserialize)]
struct Start {
    request: u32,
    #[serde(flatten)]
    call: Request,
    now: f64,
}
#[derive(Deserialize)]
struct Resume {
    request: u32,
    replies: Vec<Reply>,
    now: f64,
    #[serde(default, deserialize_with = "present_pins")]
    directories: Option<Vec<DirectoryPin>>,
}
fn present_pins<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<DirectoryPin>>, D::Error> {
    Vec::<DirectoryPin>::deserialize(deserializer).map(Some)
}
pub fn message(runtime: &mut Runtime, bytes: &[u8], resume: bool) -> Step {
    let result = if bytes.len() > crate::INPUT_LIMIT {
        Err("Engine request exceeds 64 MiB.".into())
    } else if resume {
        crate::deserialize_bytes::<Resume>(bytes)
            .map(|message| {
                if let Some(directories) = message.directories
                    && let Err(error) = runtime.pin_directories(message.request, directories)
                {
                    return Step::Error {
                        request: message.request,
                        error,
                    };
                }
                runtime.resume(message.request, message.replies, message.now)
            })
            .map_err(|error| error.to_string())
    } else {
        crate::deserialize_bytes::<Start>(bytes)
            .map(|message| runtime.start(message.request, message.call, message.now))
            .map_err(|error| error.to_string())
    };
    result.unwrap_or_else(|error| Step::Error { request: 0, error })
}
impl Runtime {
    /// Pin immutable arrays immediately before a reply, independently of global cache eviction.
    pub fn pin_directories(
        &mut self,
        request: u32,
        directories: Vec<DirectoryPin>,
    ) -> Result<(), String> {
        if !self.tasks.contains_key(&request) || directories.len() > 32 {
            return Err("Invalid directory snapshot request.".into());
        }
        let mut pins = BTreeMap::new();
        let mut highest = self.highest_directory;
        let mut count = 0usize;
        for pin in directories {
            let entries = match pin.entries {
                Some(entries) if pin.directory > highest => {
                    highest = pin.directory;
                    entries
                }
                None => self
                    .directories
                    .iter()
                    .find(|(id, _)| *id == pin.directory)
                    .map(|(_, entries)| entries.clone())
                    .ok_or("Unknown directory snapshot.")?,
                _ => return Err("Invalid directory snapshot ID.".into()),
            };
            count += entries.len();
            if count > 30000 || pins.insert(pin.directory, entries).is_some() {
                return Err("Invalid or oversized directory snapshots.".into());
            }
        }
        // The whole batch is valid; only now update the global cache and request pins.
        for (id, entries) in &pins {
            self.directories.retain(|(old, _)| old != id);
            self.directories.push_back((*id, entries.clone()));
        }
        while self.directories.len() > 32
            || self
                .directories
                .iter()
                .map(|(_, entries)| entries.len())
                .sum::<usize>()
                > 30000
        {
            self.directories.pop_front();
        }
        self.highest_directory = highest;
        self.tasks
            .get_mut(&request)
            .expect("validated request")
            .directories = pins;
        Ok(())
    }
    pub fn prepare_context(
        &mut self,
        id: u32,
        catalog: crate::types::Catalog,
        environment: crate::validation::Environment,
    ) -> Result<(), String> {
        if id == 0 || id <= self.highest_context {
            return Err("Invalid or exhausted engine context ID.".into());
        }
        self.highest_context = id;
        self.prepared = Some((id, Arc::new(catalog), Arc::new(environment)));
        Ok(())
    }
    pub fn start_prepared(&mut self, id: u32, input: String, context: u32, now: f64) -> Step {
        let Some((current, catalog, environment)) = &self.prepared else {
            return Step::Error {
                request: id,
                error: "Unknown engine context.".into(),
            };
        };
        if *current != context {
            return Step::Error {
                request: id,
                error: "Unknown engine context.".into(),
            };
        }
        self.start_call(
            id,
            Call::Suggest {
                input,
                catalog: catalog.clone(),
                environment: environment.clone(),
            },
            now,
        )
    }
    pub fn start(&mut self, id: u32, request: Request, now: f64) -> Step {
        self.start_call(id, Call::Json(request), now)
    }
    pub fn start_call(&mut self, id: u32, call: Call, now: f64) -> Step {
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
        host.completion.set(match &call {
            Call::Suggest { .. } => true,
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
                    crate::dispatch_with_discovery(&request, adapter.as_ref(), &discovery).await
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
                    serde_json::to_value(candidates).map_err(|e| e.to_string())
                }
            }
        });
        self.tasks.insert(
            id,
            Task {
                host,
                future,
                waiting: BTreeMap::new(),
                directories: BTreeMap::new(),
            },
        );
        self.poll(id)
    }
    pub fn resume(&mut self, id: u32, replies: Vec<Reply>, now: f64) -> Step {
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
            let valid_directories = match reply {
                Reply::Results { results, .. } => results.iter().all(|result| match result {
                    HostResult::Entries { entries } => task.directories.contains_key(entries),
                    HostResult::Lookup { lookup } => {
                        task.directories.contains_key(&lookup.directory)
                    }
                    _ => true,
                }),
                _ => true,
            };
            if !valid || !valid_directories {
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
                            HostResult::Entries { entries } => {
                                Ok(FactValue::Entries(task.directories[&entries].clone()))
                            }
                            HostResult::Lookup { lookup } => {
                                Ok(FactValue::Lookup(Arc::new(crate::types::DirectoryLookup {
                                    info: None,
                                    listing: Some(crate::types::DirectorySnapshot {
                                        version: lookup.version,
                                        complete: lookup.complete,
                                        entries: task.directories[&lookup.directory].clone(),
                                    }),
                                })))
                            }
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
        task.directories.clear();
        self.poll(id)
    }
    pub fn cancel(&mut self, id: u32) {
        self.tasks.remove(&id);
    }
    pub fn reset(&mut self) {
        self.tasks.clear();
        self.discovery.clear();
        self.prepared = None;
        self.directories.clear();
    }
    pub fn active(&self) -> usize {
        self.tasks.len()
    }
    fn poll(&mut self, id: u32) -> Step {
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
