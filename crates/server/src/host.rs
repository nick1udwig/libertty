use crate::{
    catalog::CatalogHost,
    completion::CompletionProvider,
    directories::Directories,
    help::HelpProvider,
    probes::{ABORTED, ProbePool},
    syntax::Syntax,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use termai_engine::types::Catalog;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct HostServices {
    pub pool: ProbePool,
    pub directories: Directories,
    pub syntax: Syntax,
    pub catalog: CatalogHost,
    pub completion: CompletionProvider,
}
impl Default for HostServices {
    fn default() -> Self {
        Self::new()
    }
}
impl HostServices {
    pub fn new() -> Self {
        let pool = ProbePool::default();
        let directories = Directories::default();
        Self {
            syntax: Syntax::new(pool.clone()),
            catalog: CatalogHost::new(directories.clone(), pool.clone()),
            completion: CompletionProvider::default(),
            pool,
            directories,
        }
    }
}
#[derive(Clone)]
pub struct NativeHost {
    pub services: HostServices,
    pub help: HelpProvider,
    pub catalog: Catalog,
    pub environment: Arc<BTreeMap<String, String>>,
    pub remote: Option<Arc<crate::ssh::SSHHost>>,
}
impl NativeHost {
    pub async fn engine_fact(
        &self,
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<termai_engine::host::FactValue, String> {
        use termai_engine::host::FactValue;
        if self.remote.is_none() && matches!(operation["kind"].as_str(), Some("lookup" | "entries"))
        {
            if cancel.is_cancelled() {
                return Err(ABORTED.into());
            }
            let path = operation["path"]
                .as_str()
                .ok_or("Invalid host field path.")?;
            let value = if operation["kind"] == "lookup" {
                FactValue::Lookup(Arc::new(
                    self.services.directories.lookup(path, cancel).await?,
                ))
            } else {
                let limit = operation["limit"]
                    .as_u64()
                    .ok_or("Invalid directory limit.")? as usize;
                FactValue::Entries(
                    self.services
                        .directories
                        .entries(path, limit, cancel)
                        .await?,
                )
            };
            if cancel.is_cancelled() {
                return Err(ABORTED.into());
            }
            return Ok(value);
        }
        self.fact(operation, cancel).await.map(Into::into)
    }
    pub fn new(
        services: HostServices,
        catalog: Catalog,
        environment: impl Into<Arc<BTreeMap<String, String>>>,
        help: HelpProvider,
    ) -> Self {
        Self {
            services,
            catalog,
            environment: environment.into(),
            help,
            remote: None,
        }
    }
    pub async fn fact(
        &self,
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        if let Some(remote) = &self.remote {
            return remote
                .fact(operation, &self.catalog, &self.environment, cancel)
                .await;
        }
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let text = |field: &str| {
            operation
                .get(field)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Invalid host field {field}."))
        };
        let value = match text("kind")? {
            "stat" => json!(
                self.services
                    .directories
                    .stat(
                        text("path")?,
                        operation
                            .get("executable")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                        cancel
                    )
                    .await?
            ),
            "lookup" => json!(
                self.services
                    .directories
                    .lookup(text("path")?, cancel)
                    .await?
            ),
            "entries" => json!(
                self.services
                    .directories
                    .entries(
                        text("path")?,
                        operation
                            .get("limit")
                            .and_then(Value::as_u64)
                            .ok_or("Invalid directory limit.")? as usize,
                        cancel
                    )
                    .await?
            ),
            "syntax" => json!(
                self.services
                    .syntax
                    .valid(text("command")?, &self.catalog.cwd, cancel)
                    .await?
            ),
            "completion" => {
                let words: Vec<String> = serde_json::from_value(
                    operation
                        .get("words")
                        .cloned()
                        .ok_or("Invalid completion words.")?,
                )
                .map_err(|e| e.to_string())?;
                let timeout = operation
                    .get("timeoutMs")
                    .and_then(Value::as_f64)
                    .unwrap_or(1500.0);
                if !timeout.is_finite() || timeout < 0.0 {
                    return Err("Invalid completion timeout.".into());
                }
                json!(
                    tokio::time::timeout(
                        Duration::from_secs_f64(timeout.min(1500.0) / 1000.0),
                        self.services.completion.complete(
                            &self.services.pool,
                            &words,
                            &self.catalog.cwd,
                            &self.environment,
                            cancel
                        )
                    )
                    .await
                    .map_err(|_| "Completion timed out.".to_owned())??
                )
            }
            "help" => {
                let route: Vec<String> = serde_json::from_value(
                    operation
                        .get("route")
                        .cloned()
                        .ok_or("Invalid help route.")?,
                )
                .map_err(|e| e.to_string())?;
                json!(
                    self.help
                        .read_verified_route(
                            text("command")?,
                            &route,
                            &self.catalog,
                            &self.environment,
                            cancel
                        )
                        .await?
                )
            }
            "describe" => json!(
                self.services
                    .catalog
                    .describe(text("command")?, &self.catalog.cwd, cancel)
                    .await?
            ),
            _ => return Err("Unknown host operation.".into()),
        };
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        Ok(value)
    }
    pub async fn snapshot(
        &self,
        directory: &str,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<termai_engine::types::DirectorySnapshot, String> {
        if let Some(remote) = &self.remote {
            remote.snapshot(directory, limit, cancel).await
        } else {
            self.services
                .directories
                .snapshot(directory, limit, cancel)
                .await
        }
    }
    pub async fn read_help(
        &self,
        command: &str,
        route: &[String],
        verified: bool,
        cancel: &CancellationToken,
    ) -> Result<termai_engine::types::Help, String> {
        if let Some(remote) = &self.remote {
            remote
                .read_help(
                    command,
                    route,
                    &self.catalog,
                    &self.environment,
                    verified,
                    cancel,
                )
                .await
        } else if verified {
            self.help
                .read_verified_route(command, route, &self.catalog, &self.environment, cancel)
                .await
        } else {
            self.help
                .read(command, route, &self.catalog, &self.environment, cancel)
                .await
        }
    }
}
