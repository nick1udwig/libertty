use crate::{
    completion::{COMPLETION_SCRIPT, completion_args, completion_values, valid_completion_words},
    probes::{ABORTED, SharedTask},
    ssh::{SSHHost, bounded},
};
use russh_sftp::{client::RawSftpSession, protocol::StatusCode};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use termai_engine::{
    command_policy::subcommands_for,
    help::{
        commands_from_help, commands_from_manual, flags_from_help, has_command_slot,
        required_from_help,
    },
    path,
    repair::{shell_quote, tokens},
    types::{Catalog, CommandMetadata, DirectoryEntry, DirectorySnapshot, FileInfo, Help},
    validation::Environment,
};
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
    pub async fn paths(
        &self,
        cwd: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        let entries = self.snapshot(cwd, 10000, cancel).await?.entries;
        let mut paths = entries
            .iter()
            .map(|e| format!("{}{}", e.name, if e.directory { "/" } else { "" }))
            .collect::<Vec<_>>();
        for entry in &entries {
            if paths.len() >= 4000 {
                break;
            }
            if !entry.directory
                || entry.name.starts_with('.')
                || ["node_modules", "dist", "venv"].contains(&entry.name.as_str())
            {
                continue;
            }
            for child in &self
                .snapshot(&path::join(&[cwd, &entry.name]), 4000 - paths.len(), cancel)
                .await?
                .entries
            {
                paths.push(format!(
                    "{}/{}{}",
                    entry.name,
                    child.name,
                    if child.directory { "/" } else { "" }
                ));
            }
        }
        Ok(paths)
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
    pub async fn fact(
        self: &Arc<Self>,
        operation: &Value,
        catalog: &Catalog,
        env: &Environment,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let text = |key: &str| {
            operation[key]
                .as_str()
                .ok_or_else(|| format!("Invalid host field {key}."))
        };
        match text("kind")? {
            "version" => Ok(json!(
                self.schema_version(text("command")?, catalog, env, cancel)
                    .await?
            )),
            "stat" => Ok(json!(
                self.stat(
                    text("path")?,
                    operation["executable"].as_bool().unwrap_or(true),
                    cancel
                )
                .await?
            )),
            "entries" => Ok(json!(
                self.snapshot(
                    text("path")?,
                    operation["limit"]
                        .as_u64()
                        .ok_or("Invalid directory limit.")? as usize,
                    cancel
                )
                .await?
                .entries
            )),
            "lookup" => {
                let file = text("path")?;
                Ok(if let Some(info) = self.stat(file, false, cancel).await? {
                    json!({"info":info})
                } else {
                    json!({"listing":self.snapshot(&path::dirname(file),10000,cancel).await?})
                })
            }
            "syntax" => {
                let command = text("command")?;
                let key = serde_json::to_string(&(&catalog.cwd, command)).unwrap();
                if let Some((_, value)) = self
                    .syntax_cache
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(k, _)| k == &key)
                {
                    return Ok(json!(value));
                }
                let result = self.exec(&format!("cd {} && env -i PATH=/usr/bin:/bin BASH_ENV=/dev/null ENV=/dev/null bash --noprofile --norc -n -c {}",shell_quote(&catalog.cwd),shell_quote(command)),cancel).await?.code == 0;
                let mut cache = self.syntax_cache.lock().unwrap();
                if cache.len() >= 1000 {
                    cache.pop_front();
                }
                cache.push_back((key, result));
                Ok(json!(result))
            }
            "completion" => {
                let words: Vec<String> = serde::Deserialize::deserialize(&operation["words"])
                    .map_err(|e| e.to_string())?;
                if !valid_completion_words(&words) {
                    return Ok(json!([]));
                }
                let mut env = env.clone();
                env.extend([
                    ("BASH_ENV".into(), "/dev/null".into()),
                    ("ENV".into(), "/dev/null".into()),
                    ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
                    (
                        "TERMAI_COMPLETIONS_FILE".into(),
                        path::join(&[&self.directory(), "completions"]),
                    ),
                ]);
                let assignments = env
                    .iter()
                    .filter(|(k, _)| valid_env(k))
                    .map(|(k, v)| format!("{k}={}", shell_quote(v)))
                    .collect::<Vec<_>>()
                    .join(" ");
                let args = completion_args(&words)
                    .iter()
                    .map(|s| shell_quote(s))
                    .collect::<Vec<_>>()
                    .join(" ");
                let command = format!(
                    "cd {} && env {assignments} bash --noprofile --norc -c {} termai-completion {args}",
                    shell_quote(&catalog.cwd),
                    shell_quote(COMPLETION_SCRIPT)
                );
                match tokio::time::timeout(Duration::from_millis(1200), self.exec(&command, cancel))
                    .await
                {
                    Ok(Ok(output)) => Ok(json!(completion_values(&output.stdout))),
                    _ if cancel.is_cancelled() => Err(ABORTED.into()),
                    _ => Ok(json!([])),
                }
            }
            "help" => {
                let route: Vec<String> = serde::Deserialize::deserialize(&operation["route"])
                    .map_err(|e| e.to_string())?;
                Ok(json!(
                    self.read_help(text("command")?, &route, catalog, env, true, cancel)
                        .await?
                ))
            }
            "describe" => {
                let args = tokens(text("command")?);
                let script = termai_engine::command_policy::script_operand(
                    &args.iter().map(|w| &w.value).collect::<Vec<_>>(),
                );
                if args.len() < 2
                    || !["python", "python3"].contains(&args[0].value.as_str())
                    || !script.is_some_and(|index| args[index].value.ends_with(".py"))
                {
                    return Ok(Value::Null);
                }
                let file = path::resolve(&[&catalog.cwd, &args[script.unwrap()].value]);
                if !bounded(cancel, async {
                    Ok(self
                        .files
                        .metadata(&file)
                        .await
                        .is_ok_and(|m| m.file_type().is_file() && m.len() <= 1024 * 1024))
                })
                .await?
                {
                    return Ok(Value::Null);
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
                Ok(if output.code == 0 {
                    serde_json::from_str(&output.stdout).unwrap_or(Value::Null)
                } else {
                    Value::Null
                })
            }
            _ => Err("Unknown host operation.".into()),
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
            let allowed = if command == "git" && i == 0 {
                parent
                    .safe_subcommands
                    .clone()
                    .unwrap_or_else(|| subcommands_for("git", &CommandMetadata::default()))
            } else {
                parent
                    .probe_subcommands
                    .clone()
                    .unwrap_or_else(|| parent.subcommands.clone())
            };
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
        let task = {
            let mut cache = self.help_cache.lock().await;
            if let Some((_, _, task)) = cache
                .iter()
                .find(|(k, until, t)| k == &key && *until > Instant::now() && !t.aborted())
            {
                task.clone()
            } else {
                cache.retain(|(k, _, _)| k != &key);
                if cache.len() >= 200 {
                    cache.pop_front();
                }
                let host = Arc::downgrade(self);
                let command = command.to_owned();
                let route = route.to_vec();
                let catalog = catalog.clone();
                let env = env.clone();
                let task = SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        let host = host.upgrade().ok_or("SSH connection closed.")?;
                        tokio::select! { biased; _=host.lifetime.cancelled()=>Err(ABORTED.into()),result=host.probe_help(&command,&route,&catalog,&env,&cancel)=>result.map(|mut help| { help.version = Some(version); help }) }
                    })
                });
                cache.push_back((
                    key.clone(),
                    Instant::now() + Duration::from_secs(600),
                    task.clone(),
                ));
                task
            }
        };
        let result = task.wait(cancel).await;
        if result.is_err() {
            self.help_cache.lock().await.retain(|(k, _, _)| k != &key);
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
        let args = std::iter::once(command)
            .chain(route.iter().map(String::as_str))
            .chain(std::iter::once(if command == "git" && !route.is_empty() {
                "-h"
            } else {
                "--help"
            }))
            .map(shell_quote)
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
        let output = self.exec(&format!("cd {} && env -i HOME={} PATH={} BASH_ENV=/dev/null ENV=/dev/null PAGER=cat GIT_PAGER=cat TERM=dumb LC_ALL=C {args}",shell_quote(&catalog.cwd),shell_quote(home),shell_quote(path)),cancel).await?;
        let text = format!("{}\n{}", output.stdout, output.stderr);
        let scope = std::iter::once(command)
            .chain(route.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        let mut help = Help {
            flags: flags_from_help(&text),
            subcommands: commands_from_help(&text, Some(&scope)),
            required: required_from_help(&text, &scope),
            ..Help::default()
        };
        if command != "git"
            && route.is_empty()
            && help.subcommands.is_empty()
            && has_command_slot(&text)
        {
            let manual = self.exec(&format!("cd {} && env -i PATH=/usr/bin:/bin HOME={} MANWIDTH=100 MANPAGER=cat MANOPT= LC_ALL=C /usr/bin/man -P cat -- {}",shell_quote(&catalog.cwd),shell_quote(home),shell_quote(command)),cancel).await;
            if cancel.is_cancelled() {
                return Err(ABORTED.into());
            }
            if let Ok(manual) = manual
                && manual.code == 0
            {
                help.subcommands = commands_from_manual(&manual.stdout);
                if !help.subcommands.is_empty() {
                    help.probe_subcommands = Some(vec![]);
                }
            }
        }
        if command == "git" {
            help.safe_subcommands = Some(subcommands_for("git", &CommandMetadata::default()));
        }
        Ok(help)
    }
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
}
fn valid_env(value: &str) -> bool {
    !value.is_empty()
        && !value.as_bytes()[0].is_ascii_digit()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
