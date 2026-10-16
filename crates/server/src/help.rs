use crate::{
    directories::executable,
    probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe},
    shell::local_bash,
};
use libertty_engine::{
    command_policy::subcommands_for,
    help::{
        commands_from_help, commands_from_manual, flags_from_help, has_command_slot,
        required_from_help,
    },
    path,
    types::{Catalog, CommandMetadata, Help},
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const BUILTINS: &[&str] = &[
    "cd", "echo", "printf", "export", "alias", "history", "source", "jobs", "fg", "bg", "type",
    "read", "pwd", "set", "unset", "umask", "ulimit", "pushd", "popd",
];
type Entry = (String, Instant, SharedTask<Help>);
#[derive(Clone)]
pub struct HelpProvider {
    pool: ProbePool,
    cache: Arc<Mutex<VecDeque<Entry>>>,
    lifetime: CancellationToken,
    probes: Arc<AtomicUsize>,
}
impl HelpProvider {
    pub fn new(pool: ProbePool) -> Self {
        Self {
            pool,
            cache: Arc::new(Mutex::new(VecDeque::new())),
            lifetime: CancellationToken::new(),
            probes: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn dispose(&self) {
        self.lifetime.cancel();
    }
    pub fn help_probes(&self) -> usize {
        self.probes.load(Ordering::SeqCst)
    }
    async fn resolve(
        &self,
        command: &str,
        catalog: &Catalog,
        env: &BTreeMap<String, String>,
    ) -> Result<Option<(String, String)>, String> {
        use std::os::unix::fs::MetadataExt;
        if !valid_name(command)
            || !catalog.commands.iter().any(|name| name == command)
            || catalog
                .functions
                .iter()
                .flatten()
                .any(|name| name == command)
        {
            return Ok(None);
        }
        let paths = if BUILTINS.contains(&command) {
            vec![local_bash(&crate::environment::vars().collect())?]
        } else {
            env.get("PATH")
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
                .collect()
        };
        let facts = futures::future::join_all(paths.iter().map(tokio::fs::metadata)).await;
        let Some((file, info)) = paths.into_iter().zip(facts).find_map(|(file, info)| {
            info.ok()
                .filter(|info| info.is_file() && executable(&file))
                .map(|info| (file, info))
        }) else {
            return Ok(None);
        };
        let mut stamp = format!(
            "{file}:{}:{}:{}:{}:{}:{}:{}:{}",
            info.dev(),
            info.ino(),
            info.mtime(),
            info.mtime_nsec(),
            info.ctime(),
            info.ctime_nsec(),
            info.mode(),
            info.len()
        );
        if command == "git" {
            let home = env.get("HOME").map(String::as_str).unwrap_or("");
            for config in [
                path::join(&[home, ".gitconfig"]),
                path::join(&[&catalog.cwd, ".git/config"]),
            ] {
                if let Ok(info) = tokio::fs::metadata(&config).await {
                    stamp.push_str(&format!(
                        ":{config}:{}:{}:{}:{}",
                        info.ino(),
                        info.mtime_nsec(),
                        info.mtime(),
                        info.len()
                    ));
                }
            }
        }
        Ok(Some((file, stamp)))
    }
    pub async fn version(
        &self,
        command: &str,
        catalog: &Catalog,
        env: &BTreeMap<String, String>,
    ) -> Result<String, String> {
        Ok(self
            .resolve(command, catalog, env)
            .await?
            .map(|(_, stamp)| stamp)
            .unwrap_or_else(|| format!("unavailable:{command}")))
    }
    pub async fn read(
        &self,
        command: &str,
        route: &[String],
        catalog: &Catalog,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        if route.len() > 3 || route.iter().any(|r| !valid_name(r)) {
            return Err("Invalid help route.".into());
        }
        let mut parent = self
            .read_verified_route(command, &[], catalog, env, cancel)
            .await?;
        for i in 0..route.len() {
            let scope = std::iter::once(command)
                .chain(route[..i].iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ");
            let allowed = if command == "git" && i == 0 {
                parent
                    .safe_subcommands
                    .clone()
                    .unwrap_or_else(|| subcommands_for("git", &CommandMetadata::default()))
            } else if let Some(probes) = &parent.probe_subcommands {
                probes.clone()
            } else {
                parent
                    .subcommands
                    .iter()
                    .cloned()
                    .chain(subcommands_for(&scope, &CommandMetadata::default()))
                    .collect()
            };
            if !allowed.contains(&route[i]) {
                return Err("Unverified help route.".into());
            }
            parent = self
                .read_verified_route(command, &route[..i + 1], catalog, env, cancel)
                .await?;
        }
        Ok(parent)
    }
    pub async fn read_verified_route(
        &self,
        command: &str,
        route: &[String],
        catalog: &Catalog,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        if cancel.is_cancelled() || self.lifetime.is_cancelled() {
            return Err(ABORTED.into());
        }
        if !catalog.commands.iter().any(|c| c == command)
            || command.is_empty()
            || !command
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
        {
            return Ok(Help::default());
        }
        let Some((file, stamp)) = self.resolve(command, catalog, env).await? else {
            return Ok(Help::default());
        };
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let stable: BTreeMap<_, _> = env
            .iter()
            .filter(|(k, _)| {
                !["_", "PWD", "OLDPWD", "SHLVL", "LINES", "COLUMNS"].contains(&k.as_str())
                    && !k.starts_with("LIBERTTY_")
            })
            .collect();
        let key =
            serde_json::to_string(&(&file, command, route, &stamp, &catalog.cwd, stable)).unwrap();
        let task = {
            let mut cache = self.cache.lock().await;
            if let Some((_, _, task)) = cache.iter().find(|(old, until, task)| {
                old == &key && *until > Instant::now() && !task.aborted()
            }) {
                task.clone()
            } else {
                cache.retain(|(old, _, _)| old != &key);
                if cache.len() >= 200 {
                    cache.pop_front();
                }
                let provider = self.clone();
                let command = command.to_owned();
                let route = route.to_vec();
                let catalog = catalog.clone();
                let env = env.clone();
                let version = stamp.clone();
                let task = SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        provider.probes.fetch_add(1, Ordering::SeqCst);
                        tokio::select! { biased; _ = provider.lifetime.cancelled() => Err(ABORTED.into()), result = provider.collect(&file, &command, &route, &catalog, &env, &cancel) => result.map(|mut help| { help.version = Some(version); help }) }
                    })
                });
                cache.push_back((key, Instant::now() + Duration::from_secs(600), task.clone()));
                task
            }
        };
        tokio::select! { biased; _ = self.lifetime.cancelled() => Err(ABORTED.into()), result = task.wait(cancel) => result }
    }
    async fn collect(
        &self,
        executable: &str,
        command: &str,
        route: &[String],
        catalog: &Catalog,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> Result<Help, String> {
        let mut safe_env = env.clone();
        safe_env.extend(
            [
                ("BASH_ENV", "/dev/null"),
                ("ENV", "/dev/null"),
                ("NO_COLOR", "1"),
                ("PAGER", "cat"),
                ("GIT_PAGER", "cat"),
                ("TERM", "dumb"),
                ("LC_ALL", "C"),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into())),
        );
        let mut options = ProbeOptions {
            cwd: catalog.cwd.clone(),
            env: safe_env,
            timeout: Duration::from_millis(1500),
            max_buffer: 128 * 1024,
        };
        let args: Vec<String> = if BUILTINS.contains(&command) {
            [
                "--noprofile",
                "--norc",
                "-c",
                "builtin help \"$1\"",
                "libertty-help",
                command,
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        } else {
            route
                .iter()
                .cloned()
                .chain(std::iter::once(
                    if command == "git" && !route.is_empty() {
                        "-h"
                    } else {
                        "--help"
                    }
                    .into(),
                ))
                .collect()
        };
        let result = probe(&self.pool, executable, &args, &options, cancel).await;
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let text = result
            .map(|r| {
                format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&r.stdout),
                    String::from_utf8_lossy(&r.stderr)
                )
            })
            .unwrap_or_default();
        let scope = std::iter::once(command)
            .chain(route.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        let mut found = Help {
            flags: flags_from_help(&text),
            subcommands: commands_from_help(&text, Some(&scope)),
            required: required_from_help(&text, &scope),
            ..Help::default()
        };
        if command != "git"
            && route.is_empty()
            && found.subcommands.is_empty()
            && has_command_slot(&text)
        {
            let manual_options = ProbeOptions {
                cwd: catalog.cwd.clone(),
                env: [
                    ("PATH", "/usr/bin:/bin"),
                    (
                        "HOME",
                        env.get("HOME")
                            .map(String::as_str)
                            .filter(|v| !v.is_empty())
                            .unwrap_or(&catalog.cwd),
                    ),
                    ("MANWIDTH", "100"),
                    ("MANPAGER", "cat"),
                    ("MANOPT", ""),
                    ("LC_ALL", "C"),
                ]
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
                timeout: Duration::from_millis(3500),
                max_buffer: 512 * 1024,
            };
            if let Ok(manual) = probe(
                &self.pool,
                "/usr/bin/man",
                &["-P".into(), "cat".into(), "--".into(), command.into()],
                &manual_options,
                cancel,
            )
            .await
                && manual.success
            {
                found.subcommands = commands_from_manual(&String::from_utf8_lossy(&manual.stdout));
                if !found.subcommands.is_empty() {
                    found.probe_subcommands = Some(vec![]);
                }
            }
        }
        if command == "git" && route.is_empty() {
            options.env = env.clone();
            options.env.insert("GIT_PAGER".into(), "cat".into());
            options.env.insert("LC_ALL".into(), "C".into());
            if let Ok(all) = probe(
                &self.pool,
                executable,
                &["--list-cmds=main,others,alias".into()],
                &options,
                cancel,
            )
            .await
                && all.success
                && let Ok(main) = probe(
                    &self.pool,
                    executable,
                    &["--list-cmds=main".into()],
                    &options,
                    cancel,
                )
                .await
                && main.success
            {
                found.subcommands = String::from_utf8_lossy(&all.stdout)
                    .split('\n')
                    .filter(|n| {
                        !n.is_empty()
                            && n.chars()
                                .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
                    })
                    .map(str::to_owned)
                    .collect();
                found.safe_subcommands = Some(
                    String::from_utf8_lossy(&main.stdout)
                        .split('\n')
                        .filter(|n| !n.is_empty())
                        .map(str::to_owned)
                        .collect(),
                );
                if let Ok(config) = probe(
                    &self.pool,
                    executable,
                    &["config".into(), "--get-regexp".into(), "^alias\\.".into()],
                    &options,
                    cancel,
                )
                .await
                    && config.success
                {
                    let mut aliases = BTreeMap::new();
                    for line in String::from_utf8_lossy(&config.stdout).split('\n') {
                        let parts: Vec<_> = line.split_whitespace().collect();
                        if parts.len() == 2
                            && let Some(alias) = parts[0].strip_prefix("alias.")
                            && !alias.is_empty()
                            && alias
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
                            && valid_name(parts[1])
                            && found
                                .safe_subcommands
                                .as_ref()
                                .unwrap()
                                .iter()
                                .any(|c| c == parts[1])
                        {
                            aliases.insert(alias.into(), parts[1].into());
                        }
                    }
                    found.aliases = Some(aliases);
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        Ok(found)
    }
}
fn valid_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
}
