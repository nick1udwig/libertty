use crate::probe_policy::{self, valid_name};
use crate::{
    completion::{
        COMPLETION_SCRIPT, completion_args, completion_timeout, completion_values,
        valid_completion_words,
    },
    probes::{ABORTED, SharedTask},
    ssh::{SSHHost, bounded},
};
use libertty_engine::{
    command_policy::subcommands_for,
    help::{apply_manual, needs_manual, parse_help},
    host::{FactValue, HostOperation},
    path,
    repair::shell_quote,
    types::{Catalog, CommandMetadata, DirectoryEntry, DirectorySnapshot, FileInfo, Help},
    validation::Environment,
};
use russh_sftp::{client::RawSftpSession, protocol::StatusCode};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) type RequestVersions =
    Arc<std::sync::Mutex<std::collections::BTreeMap<String, SharedTask<String>>>>;
pub(crate) type Descriptions = std::collections::VecDeque<(
    String,
    String,
    SharedTask<Arc<Option<Vec<libertty_engine::types::Flag>>>>,
)>;
#[derive(Clone, Copy)]
pub(crate) struct FactContext<'a> {
    pub catalog: &'a Catalog,
    pub env: &'a Environment,
    pub versions: Option<&'a RequestVersions>,
}

struct DirectoryGuard {
    raw: Arc<RawSftpSession>,
    handle: String,
}
impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        let raw = self.raw.clone();
        let handle = self.handle.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = raw.close(handle).await;
            });
        }
    }
}
impl SSHHost {
    async fn schema_version(
        self: &Arc<Self>,
        command: &str,
        context: FactContext<'_>,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        let FactContext {
            catalog,
            env,
            versions,
        } = context;
        let Some(versions) = versions else {
            return self
                .probe_schema_version(command, catalog, env, cancel)
                .await;
        };
        let key = serde_json::to_string(&(
            command,
            &catalog.cwd,
            env.get("HOME"),
            env.get("PATH"),
            catalog.commands.iter().any(|name| name == command),
            catalog
                .functions
                .iter()
                .flatten()
                .any(|name| name == command),
        ))
        .unwrap();
        let task = {
            let mut versions = versions.lock().unwrap();
            versions.retain(|_, task| task.reusable());
            if let Some(task) = versions.get(&key) {
                task.clone()
            } else {
                if versions.len() >= 64 {
                    versions.pop_first();
                }
                let host = self.clone();
                let command = command.to_owned();
                let catalog = catalog.clone();
                let env = env.clone();
                let task = SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        tokio::select! { biased; _ = host.lifetime.cancelled() => Err(ABORTED.into()), result = host.probe_schema_version(&command, &catalog, &env, &cancel) => result }
                    })
                });
                versions.insert(key, task.clone());
                task
            }
        };
        task.wait(cancel).await
    }
    async fn probe_schema_version(
        &self,
        command: &str,
        catalog: &Catalog,
        env: &Environment,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        if !valid_name(command)
            || !catalog.commands.iter().any(|name| name == command)
            || catalog
                .functions
                .iter()
                .flatten()
                .any(|name| name == command)
        {
            return Ok(format!("unavailable:{command}"));
        }
        let paths: Vec<_> = env
            .get("PATH")
            .map(String::as_str)
            .unwrap_or("")
            .split(':')
            .map(|dir| {
                path::resolve(&[
                    &catalog.cwd,
                    if dir.is_empty() { "." } else { dir },
                    command,
                ])
            })
            .collect();
        let facts = bounded(cancel, async {
            Ok(futures::future::join_all(paths.iter().map(|file| self.files.metadata(file))).await)
        })
        .await?;
        let mut version = paths
            .into_iter()
            .zip(facts)
            .find_map(|(file, info)| {
                info.ok()
                    .filter(|info| {
                        info.file_type().is_file()
                            && info.permissions.unwrap_or_default() & 0o111 != 0
                    })
                    .map(|info| {
                        format!(
                            "{file}:{}:{}:{}",
                            info.mtime.unwrap_or_default(),
                            info.len(),
                            info.permissions.unwrap_or_default()
                        )
                    })
            })
            .unwrap_or_else(|| format!("builtin:{command}"));
        if command == "git" {
            let home = env.get("HOME").map(String::as_str).unwrap_or(&self.home);
            let paths = [
                path::join(&[home, ".gitconfig"]),
                path::join(&[&catalog.cwd, ".git/config"]),
            ];
            let facts = bounded(cancel, async {
                Ok(
                    futures::future::join_all(paths.iter().map(|file| self.files.metadata(file)))
                        .await,
                )
            })
            .await?;
            for (file, info) in paths.iter().zip(facts) {
                if let Ok(info) = info {
                    version.push_str(&format!(
                        ":{file}:{}:{}",
                        info.mtime.unwrap_or_default(),
                        info.len()
                    ));
                }
            }
        }
        Ok(version)
    }
    pub async fn snapshot(
        &self,
        directory: &str,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<DirectorySnapshot, String> {
        bounded(cancel, async {
            let empty = || DirectorySnapshot {
                entries: Default::default(),
                complete: false,
                version: String::new(),
            };
            let Ok(handle) = self.raw.opendir(directory).await else {
                return Ok(empty());
            };
            let guard = DirectoryGuard {
                raw: self.raw.clone(),
                handle: handle.handle,
            };
            let mut entries = Vec::new();
            let mut complete = false;
            while entries.len() < limit {
                let batch = match self.raw.readdir(&guard.handle).await {
                    Ok(batch) => batch.files,
                    Err(russh_sftp::client::error::Error::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        complete = true;
                        break;
                    }
                    Err(error) => return Err(error.to_string()),
                };
                if batch.is_empty() {
                    complete = true;
                    break;
                }
                for entry in batch {
                    if entry.filename == "." || entry.filename == ".." {
                        continue;
                    }
                    if entries.len() >= limit {
                        break;
                    }
                    entries.push(DirectoryEntry {
                        name: entry.filename,
                        directory: entry.attrs.file_type().is_dir(),
                        symlink: entry.attrs.file_type().is_symlink(),
                    });
                }
            }
            let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled Unicode collation");
            entries.sort_by(|a, b| collator.compare(&a.name, &b.name));
            let version = crate::facts::digest(&json!(entries));
            Ok(DirectorySnapshot {
                entries: entries.into(),
                complete,
                version,
            })
        })
        .await
    }
    pub async fn stat(
        &self,
        file: &str,
        executable: bool,
        cancel: &CancellationToken,
    ) -> Result<Option<FileInfo>, String> {
        let info = bounded(cancel, async { Ok(self.files.metadata(file).await.ok()) }).await?;
        let Some(info) = info else {
            return Ok(None);
        };
        Ok(Some(FileInfo {
            file: info.file_type().is_file(),
            directory: info.file_type().is_dir(),
            executable: executable
                && info.file_type().is_file()
                && self
                    .exec(&format!("test -x {}", shell_quote(file)), cancel)
                    .await?
                    .code
                    == 0,
            spelling: None,
        }))
    }
    pub(crate) async fn engine_operation(
        self: &Arc<Self>,
        operation: &HostOperation,
        context: FactContext<'_>,
        cancel: &CancellationToken,
    ) -> Result<FactValue, String> {
        let FactContext { catalog, env, .. } = context;
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        match operation {
            HostOperation::Scoped { .. } => {
                unreachable!("Scoped operations are handled by NativeHost")
            }
            HostOperation::Version { command } => Ok(FactValue::Version(
                self.schema_version(command, context, cancel).await?.into(),
            )),
            HostOperation::Stat { path, executable } => {
                Ok(FactValue::Stat(self.stat(path, *executable, cancel).await?))
            }
            HostOperation::Entries { path, limit } => Ok(FactValue::Entries(
                self.snapshot(path, *limit, cancel).await?.entries,
            )),
            HostOperation::Lookup { .. } => unreachable!("Lookups are handled by NativeHost"),
            HostOperation::Syntax { command } => Ok(FactValue::Syntax(
                self.syntax_many(&[(&catalog.cwd, command)], cancel)
                    .await?
                    .pop()
                    .unwrap()?,
            )),
            HostOperation::Completion { words, timeout } => {
                let timeout = completion_timeout(f64::from_bits(*timeout))?;
                if !valid_completion_words(words) {
                    return Ok(FactValue::Completion(Arc::default()));
                }
                let mut env = env.clone();
                env.extend([
                    ("BASH_ENV".into(), "/dev/null".into()),
                    ("ENV".into(), "/dev/null".into()),
                    ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
                    (
                        "LIBERTTY_COMPLETIONS_FILE".into(),
                        path::join(&[&self.directory(), "completions"]),
                    ),
                ]);
                let assignments = env
                    .iter()
                    .filter(|(k, _)| valid_env(k))
                    .map(|(k, v)| format!("{k}={}", shell_quote(v)))
                    .collect::<Vec<_>>()
                    .join(" ");
                let args = completion_args(words)
                    .iter()
                    .map(|s| shell_quote(s))
                    .collect::<Vec<_>>()
                    .join(" ");
                let command = format!(
                    "cd {} && env {assignments} bash --noprofile --norc -c {} libertty-completion {args}",
                    shell_quote(&catalog.cwd),
                    shell_quote(COMPLETION_SCRIPT)
                );
                let output = tokio::time::timeout(timeout, self.exec(&command, cancel))
                    .await
                    .map_err(|_| "Completion timed out.".to_owned())??;
                if cancel.is_cancelled() {
                    return Err(ABORTED.into());
                }
                if output.code != 0 {
                    return Err("Completion probe failed.".into());
                }
                Ok(FactValue::Completion(Arc::new(completion_values(
                    &output.stdout,
                ))))
            }
            HostOperation::Help { command, route } => Ok(FactValue::Help(Arc::new(
                self.read_help(command, route, context, true, cancel)
                    .await?,
            ))),
            HostOperation::Describe { command } => self
                .describe(command, &catalog.cwd, cancel)
                .await
                .map(FactValue::Describe),
        }
    }
    async fn describe(
        self: &Arc<Self>,
        command: &str,
        cwd: &str,
        cancel: &CancellationToken,
    ) -> Result<Arc<Option<Vec<libertty_engine::types::Flag>>>, String> {
        let Some(file) = probe_policy::python_script(command, cwd) else {
            return Ok(Arc::new(None));
        };
        let info = bounded(cancel, async { Ok(self.files.metadata(&file).await.ok()) }).await?;
        let Some(info) =
            info.filter(|info| info.file_type().is_file() && info.len() <= 1024 * 1024)
        else {
            return Ok(Arc::new(None));
        };
        let stamp = format!(
            "{}:{}:{}",
            info.mtime.unwrap_or_default(),
            info.len(),
            info.permissions.unwrap_or_default()
        );
        let task = {
            let mut cache = self.descriptions.lock().unwrap();
            if let Some((_, _, task)) = cache
                .iter()
                .find(|(old, version, task)| old == &file && version == &stamp && task.reusable())
            {
                task.clone()
            } else {
                cache.retain(|(old, _, task)| old != &file && task.reusable());
                if cache.len() >= 200 {
                    cache.pop_front();
                }
                let host = Arc::downgrade(self);
                let target = file.clone();
                let task = SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        let host = host.upgrade().ok_or("SSH connection closed.")?;
                        let work = async {
                            let output = host
                                .exec(
                                    &format!(
                                        "python3 -I -c {} {}",
                                        shell_quote(crate::catalog::AST_SCRIPT),
                                        shell_quote(&target)
                                    ),
                                    &cancel,
                                )
                                .await?;
                            if output.code != 0 {
                                return Err("Script description probe failed.".into());
                            }
                            serde_json::from_str(&output.stdout)
                                .map(Arc::new)
                                .map_err(|error| error.to_string())
                        };
                        tokio::select! { biased; _ = host.lifetime.cancelled() => Err(ABORTED.into()), result = work => result }
                    })
                });
                cache.push_back((file, stamp, task.clone()));
                task
            }
        };
        task.wait(cancel).await
    }
    pub(crate) async fn syntax_many(
        &self,
        requests: &[(&str, &str)],
        cancel: &CancellationToken,
    ) -> Result<Vec<Result<bool, String>>, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let mut results = vec![Err(ABORTED.into()); requests.len()];
        let mut missing = std::collections::BTreeMap::<(String, String), Vec<usize>>::new();
        {
            let cache = self.syntax_cache.lock().unwrap();
            for (index, &(cwd, command)) in requests.iter().enumerate() {
                let key = (cwd.to_owned(), command.to_owned());
                if let Some((_, value)) = cache.iter().find(|(old, _)| old == &key) {
                    results[index] = Ok(*value);
                } else {
                    missing.entry(key).or_default().push(index);
                }
            }
        }
        let missing: Vec<_> = missing.into_iter().collect();
        for chunk in missing.chunks(32) {
            let requests: Vec<_> = chunk
                .iter()
                .map(|((cwd, command), _)| (cwd.as_str(), command.as_str()))
                .collect();
            let probe = async {
                let output = self.exec(&syntax_script(&requests), cancel).await?;
                if output.code != 0 {
                    return Err("SSH syntax batch failed.".into());
                }
                syntax_results(&output.stdout, chunk.len())
            };
            let values = probe
                .await
                .unwrap_or_else(|error| vec![Err(error); chunk.len()]);
            let mut cache = self.syntax_cache.lock().unwrap();
            for ((key, indices), value) in chunk.iter().zip(values) {
                if let Ok(valid) = value {
                    cache.retain(|(old, _)| old != key);
                    if cache.len() >= 1000 {
                        cache.pop_front();
                    }
                    cache.push_back((key.clone(), valid));
                }
                for &index in indices {
                    results[index] = value.clone();
                }
            }
        }
        Ok(results)
    }
    pub(crate) async fn read_help(
        self: &Arc<Self>,
        command: &str,
        route: &[String],
        context: FactContext<'_>,
        verified: bool,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        let catalog = context.catalog;
        if !catalog.commands.iter().any(|c| c == command)
            || !valid_name(command)
            || route.len() > 3
            || route.iter().any(|r| !valid_name(r))
        {
            return Ok(Help::default());
        }
        let version = self.schema_version(command, context, cancel).await?;
        if verified {
            return self
                .cached_help(command, route, context, &version, cancel)
                .await;
        }
        let mut parent = self
            .cached_help(command, &[], context, &version, cancel)
            .await?;
        for i in 0..route.len() {
            let allowed = probe_policy::help_children(command, &route[..i], &parent);
            if !allowed.contains(&route[i]) {
                return Err("Unverified help route.".into());
            }
            parent = self
                .cached_help(command, &route[..i + 1], context, &version, cancel)
                .await?;
        }
        Ok(parent)
    }
    async fn cached_help(
        self: &Arc<Self>,
        command: &str,
        route: &[String],
        context: FactContext<'_>,
        version: &str,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        let FactContext { catalog, env, .. } = context;
        if catalog
            .functions
            .iter()
            .flatten()
            .any(|name| name == command)
        {
            return Ok(Help::default());
        }

        let key = serde_json::to_string(&(
            command,
            route,
            &catalog.cwd,
            env.get("HOME"),
            env.get("PATH"),
            &catalog.functions,
            &version,
        ))
        .unwrap();
        let version = version.to_owned();
        let task = self.help_cache.lock().await.get_or_insert_with(&key, || {
            let host = Arc::downgrade(self);
            let command = command.to_owned();
            let route = route.to_vec();
            let catalog = catalog.clone();
            let env = env.clone();
            SharedTask::new(move |cancel| {
                Box::pin(async move {
                    let host = host.upgrade().ok_or("SSH connection closed.")?;
                    tokio::select! { biased; _=host.lifetime.cancelled()=>Err(ABORTED.into()),result=host.probe_help(&command,&route,&catalog,&env,&cancel)=>result.map(|mut help| { help.version = Some(version); help }) }
                })
            })
        });
        task.wait(cancel).await
    }
    async fn probe_help(
        &self,
        command: &str,
        route: &[String],
        catalog: &Catalog,
        env: &Environment,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        let executable = if probe_policy::BUILTINS.contains(&command) {
            "bash"
        } else {
            command
        };
        let args = std::iter::once(executable.to_owned())
            .chain(probe_policy::help_args(command, route))
            .map(|arg| shell_quote(&arg))
            .collect::<Vec<_>>()
            .join(" ");
        let home = env
            .get("HOME")
            .filter(|v| !v.is_empty())
            .unwrap_or(&self.home);
        let path = env
            .get("PATH")
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("/usr/bin:/bin");
        let environment = probe_policy::help_environment(std::collections::BTreeMap::from([
            ("HOME".into(), home.clone()),
            ("PATH".into(), path.into()),
        ]));
        let assignments = environment
            .iter()
            .map(|(key, value)| format!("{key}={}", shell_quote(value)))
            .collect::<Vec<_>>()
            .join(" ");
        let output = self
            .exec(
                &format!(
                    "cd {} && env -i {assignments} {args}",
                    shell_quote(&catalog.cwd)
                ),
                cancel,
            )
            .await?;
        let text = format!("{}\n{}", output.stdout, output.stderr);
        let mut help = parse_help(command, route, &text);
        if needs_manual(command, route, &text, &help) {
            let assignments = probe_policy::manual_environment(home)
                .iter()
                .map(|(key, value)| format!("{key}={}", shell_quote(value)))
                .collect::<Vec<_>>()
                .join(" ");
            let manual = self
                .exec(
                    &format!(
                        "cd {} && env -i {assignments} /usr/bin/man -P cat -- {}",
                        shell_quote(&catalog.cwd),
                        shell_quote(command)
                    ),
                    cancel,
                )
                .await;
            if cancel.is_cancelled() {
                return Err(ABORTED.into());
            }
            if let Ok(manual) = manual
                && manual.code == 0
            {
                apply_manual(&mut help, &manual.stdout);
            }
        }
        if command == "git" {
            help.safe_subcommands = Some(subcommands_for("git", &CommandMetadata::default()));
        }
        Ok(help)
    }
}

fn valid_env(value: &str) -> bool {
    !value.is_empty()
        && !value.as_bytes()[0].is_ascii_digit()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn syntax_script(requests: &[(&str, &str)]) -> String {
    requests.iter().enumerate().map(|(index, (cwd, command))| format!(
        "(cd {} || exit 125; env -i PATH=/usr/bin:/bin BASH_ENV=/dev/null ENV=/dev/null bash --noprofile --norc -n -c {} >/dev/null 2>&1); printf 'LIBERTTY_SYNTAX {index} %s\\n' \"$?\";\n",
        shell_quote(cwd), shell_quote(command)
    )).collect()
}
fn syntax_results(output: &str, count: usize) -> Result<Vec<Result<bool, String>>, String> {
    let records: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix("LIBERTTY_SYNTAX "))
        .collect();
    if records.len() != count {
        return Err("Incomplete SSH syntax batch.".into());
    }
    records
        .into_iter()
        .enumerate()
        .map(|(index, record)| {
            let (position, status) = record.split_once(' ').ok_or("Invalid SSH syntax result.")?;
            if position.parse::<usize>().ok() != Some(index) {
                return Err("Unordered SSH syntax results.".into());
            }
            Ok(match status {
                "0" => Ok(true),
                "2" => Ok(false),
                "125" => Err("Syntax probe directory is unavailable.".into()),
                _ => Err("Syntax probe failed.".into()),
            })
        })
        .collect()
}

#[cfg(test)]
mod syntax_tests {
    use super::*;
    #[test]
    fn batch_rejects_incomplete_or_unordered_results() {
        assert!(syntax_results("LIBERTTY_SYNTAX 0 0\n", 2).is_err());
        assert!(syntax_results("LIBERTTY_SYNTAX 1 0\nLIBERTTY_SYNTAX 0 0\n", 2).is_err());
        let values = syntax_results("LIBERTTY_SYNTAX 0 0\nLIBERTTY_SYNTAX 1 2\nLIBERTTY_SYNTAX 2 125\nLIBERTTY_SYNTAX 3 127\n", 4).unwrap();
        assert_eq!(values[0], Ok(true));
        assert_eq!(values[1], Ok(false));
        assert!(values[2].is_err());
        assert!(values[3].is_err());
    }
}
