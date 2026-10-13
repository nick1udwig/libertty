use crate::types::{DirectoryEntry, DirectoryLookup, FileInfo, Flag, Help, SharedList};
use futures::future::LocalBoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Hash, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum HostOperation {
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
        #[serde(
            rename = "timeoutMs",
            serialize_with = "serialize_timeout",
            deserialize_with = "deserialize_timeout"
        )]
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
fn serialize_timeout<S: serde::Serializer>(bits: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_f64(f64::from_bits(*bits))
}
fn deserialize_timeout<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    f64::deserialize(deserializer).map(f64::to_bits)
}

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
    fn fact(&self, operation: HostOperation) -> LocalBoxFuture<'_, Result<FactValue, String>> {
        self.request(serde_json::to_value(operation).expect("host operation"))
    }
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
        .fact(HostOperation::Stat {
            path: path.into(),
            executable,
        })
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
    match host
        .fact(HostOperation::Lookup { path: path.into() })
        .await?
    {
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
        .fact(HostOperation::Entries {
            path: path.into(),
            limit,
        })
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
        .fact(HostOperation::Syntax {
            command: command.into(),
        })
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
        .fact(HostOperation::Completion {
            words: words.to_vec(),
            timeout: timeout_ms.to_bits(),
        })
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
        .fact(HostOperation::Help {
            command: command.into(),
            route: route.to_vec(),
        })
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
        .fact(HostOperation::Describe {
            command: command.into(),
        })
        .await?
    {
        FactValue::Describe(value) => Ok(value.as_ref().clone()),
        FactValue::Json(value) => {
            crate::deserialize(value.as_ref()).map_err(|e| format!("Invalid host fact: {e}"))
        }
        _ => Err("Invalid host fact type.".into()),
    }
}
