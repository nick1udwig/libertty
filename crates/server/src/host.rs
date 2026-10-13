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
type ListingVersions = Arc<std::sync::Mutex<BTreeMap<(String, usize), String>>>;
#[derive(Clone)]
pub struct NativeHost {
    pub services: HostServices,
    pub help: HelpProvider,
    pub catalog: Catalog,
    pub environment: Arc<BTreeMap<String, String>>,
    pub remote: Option<Arc<crate::ssh::SSHHost>>,
    verification: Option<ListingVersions>,
}
impl NativeHost {
    pub fn verify_listings(&mut self) {
        self.verification = Some(Default::default());
    }
    fn remember_listing(
        &self,
        path: &str,
        limit: usize,
        snapshot: &termai_engine::types::DirectorySnapshot,
    ) {
        if let Some(versions) = &self.verification {
            versions
                .lock()
                .unwrap()
                .insert((path.into(), limit), snapshot.version.clone());
        }
    }
    pub async fn listings_unchanged(&self, cancel: &CancellationToken) -> Result<bool, String> {
        let versions = self
            .verification
            .as_ref()
            .map(|versions| versions.lock().unwrap().clone())
            .unwrap_or_default();
        let checked = futures::future::join_all(versions.into_iter().map(
            |((path, limit), version)| async move {
                Ok(self.snapshot(&path, limit, cancel).await?.version == version)
            },
        ))
        .await;
        Ok(checked
            .into_iter()
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .all(|same| same))
    }
    fn remember_lookup(
        &self,
        operation: &termai_engine::host::HostOperation,
        value: &termai_engine::host::FactValue,
    ) {
        use termai_engine::host::{FactValue, HostOperation};
        if let HostOperation::Lookup { path } = operation {
            let listing = match value {
                FactValue::Lookup(value) => value.listing.clone(),
                FactValue::Json(value) => serde_json::from_value::<
                    termai_engine::types::DirectoryLookup,
                >(value.as_ref().clone())
                .ok()
                .and_then(|value| value.listing),
                _ => None,
            };
            if let Some(listing) = listing {
                self.remember_listing(
                    std::path::Path::new(path)
                        .parent()
                        .and_then(|path| path.to_str())
                        .unwrap_or("."),
                    10000,
                    &listing,
                );
            }
        }
    }
    pub async fn engine_operations(
        &self,
        operations: &[termai_engine::host::HostOperation],
        cancel: &CancellationToken,
    ) -> Vec<Result<termai_engine::host::FactValue, String>> {
        use termai_engine::host::{FactValue, HostOperation};
        let stats: Vec<_> = operations
            .iter()
            .enumerate()
            .filter_map(|(i, op)| match op {
                HostOperation::Stat { path, executable } if self.remote.is_none() => {
                    Some((i, (path.clone(), *executable)))
                }
                _ => None,
            })
            .collect();
        if stats.len() < 2 {
            return futures::future::join_all(
                operations
                    .iter()
                    .map(|op| self.engine_operation(op, cancel)),
            )
            .await;
        }
        let (stat_results, others) = futures::join!(
            self.services
                .directories
                .stat_many(stats.iter().map(|(_, file)| file.clone()).collect(), cancel),
            futures::future::join_all(
                operations
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| !stats.iter().any(|(at, _)| at == i))
                    .map(|(i, op)| async move { (i, self.engine_operation(op, cancel).await) })
            )
        );
        let mut results = vec![Err(ABORTED.into()); operations.len()];
        for (i, value) in others {
            results[i] = value;
        }
        match stat_results {
            Ok(values) => {
                for ((i, _), value) in stats.into_iter().zip(values) {
                    results[i] = Ok(FactValue::Stat(value));
                }
            }
            Err(error) => {
                for (i, _) in stats {
                    results[i] = Err(error.clone());
                }
            }
        }
        results
    }
    pub async fn engine_fact(
        &self,
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<termai_engine::host::FactValue, String> {
        self.engine_operation(
            &serde_json::from_value(operation.clone()).map_err(|e| e.to_string())?,
            cancel,
        )
        .await
    }
    pub async fn engine_operation(
        &self,
        operation: &termai_engine::host::HostOperation,
        cancel: &CancellationToken,
    ) -> Result<termai_engine::host::FactValue, String> {
        use termai_engine::host::{FactValue, HostOperation};
        if let HostOperation::Scoped { cwd, operation } = operation {
            let mut scoped = self.clone();
            scoped.catalog.cwd = cwd.clone();
            Arc::make_mut(&mut scoped.environment).insert("PWD".into(), cwd.clone());
            return Box::pin(scoped.engine_operation(operation, cancel)).await;
        }
        if self.verification.is_some()
            && let HostOperation::Entries { path, limit } = operation
        {
            let listing = self.snapshot(path, *limit, cancel).await?;
            self.remember_listing(path, *limit, &listing);
            return Ok(FactValue::Entries(listing.entries));
        }
        if self.remote.is_some() {
            let result = self
                .fact(
                    &serde_json::to_value(operation).map_err(|e| e.to_string())?,
                    cancel,
                )
                .await
                .map(Into::into)?;
            self.remember_lookup(operation, &result);
            return Ok(result);
        }
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let value = match operation {
            HostOperation::Scoped { .. } => unreachable!("Scoped operations are handled above"),
            HostOperation::Lookup { path } => FactValue::Lookup(Arc::new(
                self.services.directories.lookup(path, cancel).await?,
            )),
            HostOperation::Entries { path, limit } => FactValue::Entries(
                self.services
                    .directories
                    .entries(path, *limit, cancel)
                    .await?,
            ),
            HostOperation::Stat { path, executable } => FactValue::Stat(
                self.services
                    .directories
                    .stat(path, *executable, cancel)
                    .await?,
            ),
            HostOperation::Syntax { command } => FactValue::Syntax(
                self.services
                    .syntax
                    .valid(command, &self.catalog.cwd, cancel)
                    .await?,
            ),
            HostOperation::Completion { words, timeout } => FactValue::Completion(Arc::new(
                self.complete_words(words, f64::from_bits(*timeout), cancel)
                    .await?,
            )),
            HostOperation::Help { command, route } => FactValue::Help(Arc::new(
                self.read_help(command, route, true, cancel).await?,
            )),
            HostOperation::Describe { command } => FactValue::Describe(Arc::new(
                self.services
                    .catalog
                    .describe(command, &self.catalog.cwd, cancel)
                    .await?,
            )),
        };
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        self.remember_lookup(operation, &value);
        Ok(value)
    }
    async fn complete(
        &self,
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
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
        self.complete_words(&words, timeout, cancel).await
    }
    async fn complete_words(
        &self,
        words: &[String],
        timeout: f64,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        if !timeout.is_finite() || timeout < 0.0 {
            return Err("Invalid completion timeout.".into());
        }
        tokio::time::timeout(
            Duration::from_secs_f64(timeout.min(1500.0) / 1000.0),
            self.services.completion.complete(
                &self.services.pool,
                words,
                &self.catalog.cwd,
                &self.environment,
                cancel,
            ),
        )
        .await
        .map_err(|_| "Completion timed out.".to_owned())?
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
            verification: None,
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
            "completion" => json!(self.complete(operation, cancel).await?),
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
