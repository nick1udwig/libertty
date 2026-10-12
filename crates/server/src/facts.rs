use crate::{completion::valid_completion_words, host::NativeHost};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use termai_engine::types::Catalog;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Facts {
    catalogs: VecDeque<(String, Value)>,
}
pub fn digest(value: &Value) -> String {
    Sha256::digest(serde_json::to_vec(value).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn context_key(
    prompt: u64,
    catalog: &Catalog,
    environment: &std::collections::BTreeMap<String, String>,
) -> String {
    digest(&json!([prompt, catalog.cwd, environment]))
}
impl Facts {
    pub fn context(
        &mut self,
        prompt: u64,
        mut catalog: Catalog,
        environment: &std::collections::BTreeMap<String, String>,
        known: Option<&str>,
        include_paths: bool,
    ) -> Value {
        let key = context_key(prompt, &catalog, environment);
        catalog.functions.get_or_insert_with(Vec::new);
        catalog.history_cwds.get_or_insert_with(Default::default);
        let catalog = json!(catalog);
        let catalog_key = digest(&catalog);
        let mut reply = json!({"key":key,"catalogKey":catalog_key,"prompt":prompt,"pathsIncluded":include_paths,"home":environment.get("HOME").cloned().unwrap_or_default(),"discoveryKey":digest(&json!(environment.iter().filter(|(k,_)| !["_","PWD","OLDPWD","SHLVL","LINES","COLUMNS"].contains(&k.as_str()) && !k.starts_with("TERMAI_")).collect::<Vec<_>>()))});
        if known != Some(catalog_key.as_str()) {
            if let Some((_, old)) = self
                .catalogs
                .iter()
                .find(|(key, _)| Some(key.as_str()) == known)
            {
                reply["base"] = json!(known);
                reply["patch"] = json!(
                    catalog
                        .as_object()
                        .unwrap()
                        .iter()
                        .filter(|(k, v)| old.get(*k) != Some(*v))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<serde_json::Map<_, _>>()
                );
            } else {
                reply["catalog"] = catalog.clone();
            }
        }
        if !self.catalogs.iter().any(|(key, _)| key == &catalog_key) {
            self.catalogs.push_back((catalog_key, catalog));
            if self.catalogs.len() > 8 {
                self.catalogs.pop_front();
            }
        }
        reply
    }
}
pub fn validate(operations: &Value) -> Result<&[Value], String> {
    let operations = operations
        .as_array()
        .filter(|ops| (1..=64).contains(&ops.len()))
        .ok_or("Use 1–64 fact operations.")?;
    let mut expensive = 0;
    let mut directories = 0;
    for op in operations {
        if !op.is_object() {
            return Err("Invalid fact operation.".into());
        }
        match op["kind"].as_str() {
            Some("directory" | "stat" | "lookup" | "entries") => {
                if !op["path"].as_str().is_some_and(|p| {
                    p.starts_with('/') && p.encode_utf16().count() <= 4096 && !p.contains('\0')
                }) {
                    return Err("Invalid path.".into());
                }
                if op["kind"] == "directory"
                    && op.get("version").is_some_and(|v| {
                        !v.as_str().is_some_and(|v| v.encode_utf16().count() <= 256)
                    })
                {
                    return Err("Invalid directory version.".into());
                }
                if op["kind"] == "entries"
                    && !op["limit"]
                        .as_f64()
                        .is_some_and(|n| n.fract() == 0.0 && (1.0..=10000.0).contains(&n))
                {
                    return Err("Invalid directory limit.".into());
                }
                if op["kind"] == "entries" || op["kind"] == "lookup" {
                    directories += 1;
                }
            }
            Some("completion") => {
                let words: Vec<String> = serde_json::from_value(op["words"].clone())
                    .map_err(|_| "Invalid completion words.")?;
                if !valid_completion_words(&words) {
                    return Err("Invalid completion words.".into());
                }
                expensive += 1;
            }
            Some("syntax" | "help" | "describe") => {
                if !op["command"].as_str().is_some_and(|c| {
                    c.encode_utf16().count() <= 4000
                        && !c.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                }) {
                    return Err("Invalid command.".into());
                }
                if op["kind"] == "help" {
                    if !op["route"].as_array().is_some_and(|route| {
                        route.len() <= 3
                            && route.iter().all(|name| {
                                name.as_str().is_some_and(|name| {
                                    name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                                        && name
                                            .chars()
                                            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
                                })
                            })
                    }) {
                        return Err("Invalid help route.".into());
                    }
                    expensive += 1;
                } else if op["kind"] == "describe" {
                    expensive += 1;
                }
            }
            _ => return Err("Unknown fact operation.".into()),
        }
    }
    if expensive > 8 || directories > 8 {
        return Err("Too many expensive operations.".into());
    }
    Ok(operations)
}
pub async fn read(
    host: &NativeHost,
    operations: &[Value],
    cancel: &CancellationToken,
) -> Result<Vec<Value>, String> {
    for op in operations {
        if op["kind"] == "completion"
            && !host
                .catalog
                .commands
                .iter()
                .any(|command| op["words"][0].as_str() == Some(command))
        {
            return Err("Unknown completion command.".into());
        }
    }
    futures::future::join_all(operations.iter().map(|op| async move {
        if op["kind"] == "directory" {
            let snapshot = host
                .snapshot(op["path"].as_str().unwrap(), 10000, cancel)
                .await?;
            return Ok(
                if !snapshot.version.is_empty() && op["version"].as_str() == Some(&snapshot.version)
                {
                    json!({"version":snapshot.version,"complete":snapshot.complete})
                } else {
                    json!(snapshot)
                },
            );
        }
        if op["kind"] == "help" {
            let route: Vec<String> =
                serde_json::from_value(op["route"].clone()).map_err(|e| e.to_string())?;
            return Ok(json!(
                host.read_help(op["command"].as_str().unwrap(), &route, false, cancel)
                    .await?
            ));
        }
        let mut op = op.clone();
        if op["kind"] == "entries" {
            op["limit"] = json!(op["limit"].as_f64().unwrap() as u64);
        }
        host.fact(&op, cancel).await
    }))
    .await
    .into_iter()
    .collect()
}
