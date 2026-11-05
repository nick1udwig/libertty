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
    types::{
        Catalog, CommandMetadata, DirectoryEntry, DirectoryLookup, DirectorySnapshot, FileInfo,
        Help,
    },
    validation::Environment,
};
use russh_sftp::{client::RawSftpSession, protocol::StatusCode};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

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
        catalog: &Catalog,
        env: &Environment,
        cancel: &CancellationToken,
    ) -> Result<FactValue, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        match operation {
            HostOperation::Scoped { .. } => {
                unreachable!("Scoped operations are handled by NativeHost")
            }
            HostOperation::Version { command } => Ok(FactValue::from(json!(
                self.schema_version(command, catalog, env, cancel).await?
            ))),
            HostOperation::Stat { path, executable } => {
                Ok(FactValue::Stat(self.stat(path, *executable, cancel).await?))
            }
            HostOperation::Entries { path, limit } => Ok(FactValue::Entries(
                self.snapshot(path, *limit, cancel).await?.entries,
            )),
            HostOperation::Lookup { path: file } => Ok(FactValue::Lookup(Arc::new(
                if let Some(info) = self.stat(file, false, cancel).await? {
                    DirectoryLookup {
                        info: Some(info),
                        listing: None,
                    }
                } else {
                    DirectoryLookup {
                        info: None,
                        listing: Some(self.snapshot(&path::dirname(file), 10000, cancel).await?),
                    }
                },
            ))),
            HostOperation::Syntax { command } => {
                let key = serde_json::to_string(&(&catalog.cwd, command)).unwrap();
                if let Some((_, value)) = self
                    .syntax_cache
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(k, _)| k == &key)
                {
                    return Ok(FactValue::Syntax(*value));
                }
                let result = self.exec(&format!("cd {} && env -i PATH=/usr/bin:/bin BASH_ENV=/dev/null ENV=/dev/null bash --noprofile --norc -n -c {}",shell_quote(&catalog.cwd),shell_quote(command)),cancel).await?.code == 0;
                let mut cache = self.syntax_cache.lock().unwrap();
                if cache.len() >= 1000 {
                    cache.pop_front();
                }
                cache.push_back((key, result));
                Ok(FactValue::Syntax(result))
            }
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
                match tokio::time::timeout(timeout, self.exec(&command, cancel)).await {
                    Ok(Ok(output)) => Ok(FactValue::Completion(Arc::new(completion_values(
                        &output.stdout,
                    )))),
                    _ if cancel.is_cancelled() => Err(ABORTED.into()),
                    _ => Ok(FactValue::Completion(Arc::default())),
                }
            }
            HostOperation::Help { command, route } => Ok(FactValue::Help(Arc::new(
                self.read_help(command, route, catalog, env, true, cancel)
                    .await?,
            ))),
            HostOperation::Describe { command } => {
                let Some(file) = probe_policy::python_script(command, &catalog.cwd) else {
                    return Ok(FactValue::Describe(Arc::new(None)));
                };
                if !bounded(cancel, async {
                    Ok(self
                        .files
                        .metadata(&file)
                        .await
                        .is_ok_and(|m| m.file_type().is_file() && m.len() <= 1024 * 1024))
                })
                .await?
                {
                    return Ok(FactValue::Describe(Arc::new(None)));
                }
                let output = self
                    .exec(
                        &format!(
                            "python3 -I -c {} {}",
                            shell_quote(crate::catalog::AST_SCRIPT),
                            shell_quote(&file)
                        ),
                        cancel,
                    )
                    .await?;
                Ok(FactValue::Describe(Arc::new(if output.code == 0 {
                    serde_json::from_str(&output.stdout).unwrap_or(None)
                } else {
                    None
                })))
            }
        }
    }
    pub async fn read_help(
        self: &Arc<Self>,
        command: &str,
        route: &[String],
        catalog: &Catalog,
        env: &Environment,
        verified: bool,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        if !catalog.commands.iter().any(|c| c == command)
            || !valid_name(command)
            || route.len() > 3
            || route.iter().any(|r| !valid_name(r))
        {
            return Ok(Help::default());
        }
        if verified {
            return self.cached_help(command, route, catalog, env, cancel).await;
        }
        let mut parent = self.cached_help(command, &[], catalog, env, cancel).await?;
        for i in 0..route.len() {
            let allowed = probe_policy::help_children(command, &route[..i], &parent);
            if !allowed.contains(&route[i]) {
                return Err("Unverified help route.".into());
            }
            parent = self
                .cached_help(command, &route[..i + 1], catalog, env, cancel)
                .await?;
        }
        Ok(parent)
    }
    async fn cached_help(
        self: &Arc<Self>,
        command: &str,
        route: &[String],
        catalog: &Catalog,
        env: &Environment,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        if catalog
            .functions
            .iter()
            .flatten()
            .any(|name| name == command)
        {
            return Ok(Help::default());
        }
        let version = self.schema_version(command, catalog, env, cancel).await?;
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
        let result = task.wait(cancel).await;
        if result.is_err() {
            self.help_cache.lock().await.remove(&key);
        }
        result
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
