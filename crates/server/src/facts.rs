use crate::{completion::valid_completion_words, host::NativeHost};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use termai_engine::types::Catalog;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Facts {
    catalogs: VecDeque<PreparedCatalog>,
    environment: Option<(BTreeMap<String, String>, String)>,
    context: Option<(u64, String, String)>,
}
struct PreparedCatalog {
    catalog: Catalog,
    key: String,
    wire: Value,
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
    pub fn repair_catalog(&self, context: &str, catalog: &str) -> Option<Catalog> {
        if self.context.as_ref()?.2 != context {
            return None;
        }
        self.catalogs
            .iter()
            .find(|entry| entry.key == catalog)
            .map(|entry| entry.catalog.clone())
    }
    pub fn context(
        &mut self,
        prompt: u64,
        mut catalog: Catalog,
        environment: &std::collections::BTreeMap<String, String>,
        known: Option<&str>,
        include_paths: bool,
    ) -> Value {
        if self
            .environment
            .as_ref()
            .is_none_or(|(old, _)| old != environment)
        {
            let discovery = digest(&json!(
                environment
                    .iter()
                    .filter(
                        |(k, _)| !["_", "PWD", "OLDPWD", "SHLVL", "LINES", "COLUMNS"]
                            .contains(&k.as_str())
                            && !k.starts_with("TERMAI_")
                    )
                    .collect::<Vec<_>>()
            ));
            self.environment = Some((environment.clone(), discovery));
            self.context = None;
        }
        if self
            .context
            .as_ref()
            .is_none_or(|(old_prompt, cwd, _)| *old_prompt != prompt || *cwd != catalog.cwd)
        {
            self.context = Some((
                prompt,
                catalog.cwd.clone(),
                context_key(prompt, &catalog, environment),
            ));
        }
        let key = &self.context.as_ref().unwrap().2;
        catalog.functions.get_or_insert_with(Default::default);
        catalog.history_cwds.get_or_insert_with(Default::default);
        if !self.catalogs.iter().any(|old| old.catalog == catalog) {
            let wire = json!(catalog);
            self.catalogs.push_back(PreparedCatalog {
                key: digest(&wire),
                wire,
                catalog: catalog.clone(),
            });
            if self.catalogs.len() > 8 {
                self.catalogs.pop_front();
            }
        }
        let prepared = self
            .catalogs
            .iter()
            .find(|old| old.catalog == catalog)
            .unwrap();
        let mut reply = json!({"key":key,"catalogKey":prepared.key,"prompt":prompt,"pathsIncluded":include_paths,"home":environment.get("HOME").cloned().unwrap_or_default(),"discoveryKey":self.environment.as_ref().unwrap().1,"compoundRepair":true});
        if known != Some(prepared.key.as_str()) {
            if let Some(old) = self
                .catalogs
                .iter()
                .find(|old| Some(old.key.as_str()) == known)
            {
                reply["base"] = json!(known);
                reply["patch"] = json!(
                    prepared
                        .wire
                        .as_object()
                        .unwrap()
                        .iter()
                        .filter(|(k, v)| old.wire.get(*k) != Some(*v))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<serde_json::Map<_, _>>()
                );
            } else {
                reply["catalog"] = prepared.wire.clone();
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
    for supplied in operations {
        let op = if supplied["kind"] == "scoped" {
            if !supplied["cwd"].as_str().is_some_and(|cwd| {
                cwd.starts_with('/') && cwd.encode_utf16().count() <= 4096 && !cwd.contains('\0')
            }) || supplied["operation"]["kind"] == "scoped"
            {
                return Err("Invalid fact scope.".into());
            }
            &supplied["operation"]
        } else {
            supplied
        };
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
            Some("syntax" | "help" | "describe" | "version") => {
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
                } else if op["kind"] == "describe" || op["kind"] == "version" {
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
        if op["kind"] == "scoped" {
            let mut scoped = host.clone();
            scoped.catalog.cwd = op["cwd"].as_str().unwrap().into();
            std::sync::Arc::make_mut(&mut scoped.environment)
                .insert("PWD".into(), scoped.catalog.cwd.clone());
            let operations = vec![op["operation"].clone()];
            return Box::pin(read(&scoped, &operations, cancel))
                .await
                .map(|mut values| values.remove(0));
        }
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
