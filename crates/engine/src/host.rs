use crate::types::{DirectoryEntry, DirectoryLookup, FileInfo, Flag, Help, SharedList};
use futures::future::LocalBoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum FactValue {
    Json(Arc<Value>),
    Lookup(Arc<DirectoryLookup>),
    Entries(SharedList<DirectoryEntry>),
    Stat(Option<FileInfo>),
    Syntax(bool),
    Completion(Arc<Vec<String>>),
    Help(Arc<Help>),
    Describe(Arc<Option<Vec<Flag>>>),
}
impl From<Value> for FactValue {
    fn from(value: Value) -> Self {
        Self::Json(Arc::new(value))
    }
}

/// Facts are supplied by an adapter; the engine never opens files or executes commands.
pub trait Host {
    fn request(&self, operation: Value) -> LocalBoxFuture<'_, Result<FactValue, String>>;
    fn now_ms(&self) -> f64;
    fn supports_completion(&self) -> bool {
        true
    }
}

pub async fn stat(
    host: &dyn Host,
    path: &str,
    executable: bool,
) -> Result<Option<FileInfo>, String> {
    match host
        .request(json!({"kind":"stat","path":path,"executable":executable}))
        .await?
    {
        FactValue::Stat(value) => Ok(value),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
pub async fn lookup(host: &dyn Host, path: &str) -> Result<DirectoryLookup, String> {
    match host.request(json!({"kind":"lookup","path":path})).await? {
        FactValue::Lookup(value) => Ok(value.as_ref().clone()),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
pub async fn entries(
    host: &dyn Host,
    path: &str,
    limit: usize,
) -> Result<SharedList<DirectoryEntry>, String> {
    match host
        .request(json!({"kind":"entries","path":path,"limit":limit}))
        .await?
    {
        FactValue::Entries(value) => Ok(value),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
pub async fn syntax(host: &dyn Host, command: &str) -> Result<bool, String> {
    match host
        .request(json!({"kind":"syntax","command":command}))
        .await?
    {
        FactValue::Syntax(value) => Ok(value),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
pub async fn complete(
    host: &dyn Host,
    words: &[String],
    timeout_ms: f64,
) -> Result<Vec<String>, String> {
    match host
        .request(json!({"kind":"completion","words":words,"timeoutMs":timeout_ms}))
        .await?
    {
        FactValue::Completion(value) => Ok(value.as_ref().clone()),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
pub async fn help(host: &dyn Host, command: &str, route: &[String]) -> Result<Help, String> {
    match host
        .request(json!({"kind":"help","command":command,"route":route}))
        .await?
    {
        FactValue::Help(value) => Ok(value.as_ref().clone()),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
pub async fn describe(host: &dyn Host, command: &str) -> Result<Option<Vec<Flag>>, String> {
    match host
        .request(json!({"kind":"describe","command":command}))
        .await?
    {
        FactValue::Describe(value) => Ok(value.as_ref().clone()),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
