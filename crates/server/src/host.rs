use crate::{
    catalog::CatalogHost,
    completion::{CompletionProvider, completion_timeout},
    directories::Directories,
    help::HelpProvider,
    probes::{ABORTED, ProbePool},
    syntax::Syntax,
};
use libertty_engine::types::Catalog;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
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
            catalog: CatalogHost::new(pool.clone()),
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
        snapshot: &libertty_engine::types::DirectorySnapshot,
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
        operation: &libertty_engine::host::HostOperation,
        value: &libertty_engine::host::FactValue,
    ) {
        use libertty_engine::host::{FactValue, HostOperation};
        if let HostOperation::Lookup { path } = operation
            && let FactValue::Lookup(value) = value
            && let Some(listing) = &value.listing
        {
            self.remember_listing(
                std::path::Path::new(path)
                    .parent()
                    .and_then(|path| path.to_str())
                    .unwrap_or("."),
                10000,
                listing,
            );
        }
    }
    pub async fn engine_operations(
        &self,
        operations: &[libertty_engine::host::HostOperation],
        cancel: &CancellationToken,
    ) -> Vec<Result<libertty_engine::host::FactValue, String>> {
        self.engine_operations_until(operations, cancel, None).await
    }
    pub async fn engine_operations_until(
        &self,
        operations: &[libertty_engine::host::HostOperation],
        cancel: &CancellationToken,
        deadline: Option<tokio::time::Instant>,
    ) -> Vec<Result<libertty_engine::host::FactValue, String>> {
        use libertty_engine::host::{FactValue, HostOperation};
        async fn bounded<T>(
            deadline: Option<tokio::time::Instant>,
            work: impl std::future::Future<Output = Result<T, String>>,
        ) -> Result<T, String> {
            match deadline {
                Some(deadline) => tokio::time::timeout_at(deadline, work)
                    .await
                    .map_err(|_| "Repair budget exhausted.".to_owned())?,
                None => work.await,
            }
        }
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
                    .map(|op| bounded(deadline, self.engine_operation(op, cancel))),
            )
            .await;
        }
        let (stat_results, others) = futures::join!(
            bounded(
                deadline,
                self.services
                    .directories
                    .stat_many(stats.iter().map(|(_, file)| file.clone()).collect(), cancel)
            ),
            futures::future::join_all(
                operations
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| !stats.iter().any(|(at, _)| at == i))
                    .map(|(i, op)| async move {
                        (
                            i,
                            bounded(deadline, self.engine_operation(op, cancel)).await,
                        )
                    })
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
    ) -> Result<libertty_engine::host::FactValue, String> {
        self.engine_operation(
            &serde::Deserialize::deserialize(operation).map_err(|e| e.to_string())?,
            cancel,
        )
        .await
    }
    pub async fn engine_operation(
        &self,
        operation: &libertty_engine::host::HostOperation,
        cancel: &CancellationToken,
    ) -> Result<libertty_engine::host::FactValue, String> {
        use libertty_engine::host::{FactValue, HostOperation};
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
        if let Some(remote) = &self.remote {
            let result = remote
                .engine_operation(operation, &self.catalog, &self.environment, cancel)
                .await?;
            self.remember_lookup(operation, &result);
            return Ok(result);
        }
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let value = match operation {
            HostOperation::Scoped { .. } => unreachable!("Scoped operations are handled above"),
            HostOperation::Version { command } => FactValue::from(json!(
                self.help
                    .version(command, &self.catalog, &self.environment)
                    .await?
            )),
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
    async fn complete_words(
        &self,
        words: &[String],
        timeout: f64,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        tokio::time::timeout(
            completion_timeout(timeout)?,
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
        serde_json::to_value(self.engine_fact(operation, cancel).await?).map_err(|e| e.to_string())
    }
    pub async fn snapshot(
        &self,
        directory: &str,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<libertty_engine::types::DirectorySnapshot, String> {
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
    ) -> Result<libertty_engine::types::Help, String> {
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
