pub mod action;
mod cli;
pub mod hc;
pub mod metadata;
pub mod poll;
pub mod reading;
pub mod redraw;
mod snapshot;
pub mod state;
pub mod terminal_stream;
pub mod view;
use crate::storage;
use libertty_engine::utf16_len;
use libertty_engine::{repair::shell_quote, validation::Environment};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite},
    net::UnixStream,
};
use tokio_util::sync::CancellationToken;

pub const MAX_LINE: usize = 8 * 1024 * 1024;
pub fn session(value: Option<&str>) -> Result<String, String> {
    match value {
        None | Some("" | "default") => Ok(String::new()),
        Some(value)
            if value.len() <= 64
                && value.as_bytes()[0].is_ascii_alphanumeric()
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') =>
        {
            Ok(value.into())
        }
        Some(_) => Err(
            "Use a Herdr session name containing letters, numbers, hyphens or underscores.".into(),
        ),
    }
}
pub fn name(value: &str) -> Result<String, String> {
    if value.trim().is_empty()
        || utf16_len(value) > 100
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err("Enter a name of 1–100 characters.".into());
    }
    Ok(value.trim().into())
}
pub fn socket(session_name: &str, env: &Environment) -> Result<String, String> {
    let session = session(Some(session_name))?;
    let setting = |key: &str| env.get(key).filter(|s| !s.is_empty()).cloned();
    if session.is_empty()
        && let Some(path) = setting("HERDR_SOCKET_PATH")
    {
        return Ok(path);
    }
    let home = setting("HOME")
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    let config = setting("XDG_CONFIG_HOME").unwrap_or_else(|| format!("{home}/.config"));
    Ok(if session.is_empty() {
        format!("{config}/herdr/herdr.sock")
    } else {
        format!("{config}/herdr/sessions/{session}/herdr.sock")
    })
}
pub fn parse_command(command: &str, env: &Environment) -> Result<(String, String), String> {
    static COMMAND: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\s*((?:/[^\s]*/)?herdr)(?:\s+(?:--session|session\s+attach)\s+([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}))?\s*$").unwrap()
    });
    let captures = COMMAND
        .captures(command)
        .ok_or("Use herdr or herdr --session <name>.")?;
    let session_name = session(
        captures
            .get(2)
            .map(|m| m.as_str())
            .or_else(|| env.get("HERDR_SESSION").map(String::as_str)),
    )?;
    Ok((captures[1].into(), session_name))
}

#[derive(Clone, Debug)]
pub struct Target {
    pub core: bool,
    pub session: String,
    pub socket_path: Option<String>,
    pub binary: String,
    pub env: Environment,
    pub remote: Option<Arc<crate::ssh::SSHHost>>,
    pub repairs: RepairSessions,
    pub shared: crate::herdr::metadata::Shared,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ResourceKey {
    transport: Option<usize>,
    socket: String,
    item: String,
}
#[derive(Clone, Default)]
pub struct RepairSessions(Arc<tokio::sync::Mutex<HashMap<String, RepairContext>>>);
#[derive(Clone)]
struct RepairContext {
    identity: String,
    engine: crate::engine::NativeEngine,
    help: crate::help::HelpProvider,
    commands: Arc<CommandCatalog>,
}
type CachedCommands = Option<(std::time::Instant, Arc<Vec<String>>)>;
#[derive(Default)]
struct CommandCatalog(tokio::sync::Mutex<CachedCommands>);
impl CommandCatalog {
    async fn get(
        &self,
        cancel: &CancellationToken,
        discover: impl std::future::Future<Output = Result<Vec<String>, String>>,
    ) -> Result<Arc<Vec<String>>, String> {
        let work = async {
            let mut cached = self.0.lock().await;
            if let Some((at, names)) = &*cached
                && at.elapsed() < Duration::from_secs(2)
            {
                return Ok(names.clone());
            }
            let names = Arc::new(discover.await?);
            *cached = Some((std::time::Instant::now(), names.clone()));
            Ok(names)
        };
        tokio::select! { biased; _ = cancel.cancelled() => Err(crate::probes::ABORTED.into()), result = work => result }
    }
}
impl std::fmt::Debug for RepairSessions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RepairSessions").finish_non_exhaustive()
    }
}
impl RepairSessions {
    async fn get(
        &self,
        terminal: &str,
        identity: String,
        services: &crate::host::HostServices,
    ) -> Result<RepairContext, String> {
        let mut contexts = self.0.lock().await;
        if let Some(context) = contexts.get(terminal).filter(|c| c.identity == identity) {
            return Ok(context.clone());
        }
        if let Some(previous) = contexts.remove(terminal) {
            previous.help.dispose();
            let _ = previous.engine.reset();
        }
        if contexts.len() >= 32
            && let Some(key) = contexts.keys().next().cloned()
        {
            contexts.remove(&key);
        }
        let context = RepairContext {
            identity,
            engine: crate::engine::NativeEngine::new()?,
            help: crate::help::HelpProvider::new(services.pool.clone()),
            commands: Arc::default(),
        };
        let result = context.clone();
        contexts.insert(terminal.into(), context);
        Ok(result)
    }
}
/// Whether a foreground process name is an interactive shell that accepts command alternatives.
pub(crate) fn is_shell(name: &str) -> bool {
    matches!(name, "bash" | "zsh" | "fish" | "sh" | "dash" | "ksh")
}
#[derive(Clone, Debug, PartialEq)]
pub struct ShellInput {
    pub pid: u64,
    pub cwd: String,
}
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type Connection = Box<dyn Stream>;
impl Target {
    pub fn storage_key(&self) -> String {
        if self.core {
            format!("core:{}", self.session)
        } else {
            self.session.clone()
        }
    }
    pub(crate) async fn validate_terminal(&self, terminal: &Terminal) -> Result<(), String> {
        if self.core {
            hc::validate_terminal(self, terminal).await
        } else {
            cli::validate_terminal(self, terminal).await
        }
    }
    pub async fn shell_input(&self, pane: &str) -> Result<Option<ShellInput>, String> {
        self.input_state(pane).await.map(|(shell, _)| shell)
    }
    pub async fn input_state(&self, pane: &str) -> Result<(Option<ShellInput>, String), String> {
        if self.core {
            hc::input_state(self, pane).await
        } else {
            cli::input_state(self, pane).await
        }
    }
    pub async fn suggest(
        &self,
        terminal: &str,
        text: &str,
        services: crate::host::HostServices,
        cancel: &CancellationToken,
    ) -> Result<Vec<libertty_engine::types::Candidate>, String> {
        let snapshot = self.snapshot().await?;
        let pane = snapshot
            .terminal(terminal)
            .ok_or("This terminal has ended.")?;
        self.validate_terminal(pane).await?;
        let shell = self
            .shell_input(&pane.pane_id)
            .await?
            .ok_or("Command alternatives require a shell prompt.")?;
        let mut env = self.env.clone();
        if self.remote.is_none()
            && let Ok(bytes) = tokio::fs::read(format!("/proc/{}/environ", shell.pid)).await
        {
            for entry in String::from_utf8_lossy(&bytes).split('\0') {
                if let Some((key, value)) = entry.split_once('=') {
                    env.insert(key.into(), value.into());
                }
            }
        }
        env.insert("PWD".into(), shell.cwd.clone());
        let identity = crate::facts::digest(&json!([shell.pid, shell.cwd, env]));
        let RepairContext {
            engine,
            help,
            commands,
            ..
        } = self.repairs.get(terminal, identity, &services).await?;
        let commands = commands
            .get(cancel, async {
                if let Some(remote) = &self.remote {
                    let result = remote.exec("bash -c 'compgen -c'", cancel).await?;
                    if result.code != 0 {
                        return Err("Cannot discover remote commands.".into());
                    }
                    Ok(result.stdout.lines().map(str::to_owned).collect())
                } else {
                    services.catalog.executable_names(&env, cancel).await
                }
            })
            .await?;
        let paths = Default::default();
        let history = if self.remote.is_none() {
            crate::history::history_sources(&env).await.into()
        } else {
            Default::default()
        };
        let catalog = libertty_engine::types::Catalog {
            cwd: shell.cwd.clone(),
            commands: commands.into(),
            paths,
            history,
            ..Default::default()
        };
        let mut host = crate::host::NativeHost::new(services, catalog, env, help);
        host.remote = self.remote.clone();
        let candidates = engine.suggest(text, &host, cancel).await?;
        if self.shell_input(&pane.pane_id).await?.as_ref() != Some(&shell) {
            return Err("Terminal input changed. Try again.".into());
        }
        Ok(candidates)
    }
    pub fn local(session_name: &str) -> Result<Self, String> {
        Ok(Self {
            core: false,
            session: session(Some(session_name))?,
            socket_path: None,
            binary: "herdr".into(),
            env: std::env::vars().collect(),
            remote: None,
            repairs: Default::default(),
            shared: Default::default(),
        })
    }
    pub fn path(&self) -> Result<String, String> {
        if self.core {
            return Ok(format!("herdr-core:{}", self.session));
        }
        self.socket_path
            .clone()
            .map(Ok)
            .unwrap_or_else(|| socket(&self.session, &self.env))
    }
    /// Identifies this Herdr server, and one of its panes or terminals when `item` is set, for shared hubs.
    pub(crate) fn key(&self, item: &str) -> Result<ResourceKey, String> {
        Ok(ResourceKey {
            transport: self.remote.as_ref().map(|host| Arc::as_ptr(host) as usize),
            socket: self.path()?,
            item: item.into(),
        })
    }
    pub async fn open(&self) -> Result<Connection, String> {
        if let Some(remote) = &self.remote {
            return remote
                .open_unix(&self.path()?, &tokio_util::sync::CancellationToken::new())
                .await
                .map(|stream| Box::new(stream) as Connection);
        }
        UnixStream::connect(self.path()?)
            .await
            .map(|stream| Box::new(stream) as Connection)
            .map_err(|_| "Cannot connect to Herdr. Start its server on this machine first.".into())
    }
    /// A counter that changes whenever Herdr may have moved or replaced a pane, while metadata events are watched.
    pub fn layout_epoch(&self) -> Option<u64> {
        self.shared.resource(self).ok()?.layout_epoch()
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.shared
            .resource(self)?
            .request(self, method, params)
            .await
    }
    pub async fn snapshot(&self) -> Result<Arc<Snapshot>, String> {
        if self.core {
            hc::snapshot(self).await
        } else {
            cli::snapshot(self).await
        }
    }
    pub async fn options(&self) -> Result<Value, String> {
        if self.core {
            hc::options(self).await
        } else {
            cli::options(self).await
        }
    }
    pub async fn action<M: TryInto<crate::herdr::action::Action>>(
        &self,
        input: M,
    ) -> Result<Value, String>
    where
        M::Error: std::fmt::Display,
    {
        use crate::herdr::action::Action;
        let input: Action = input
            .try_into()
            .map_err(|error| format!("Invalid Herdr action: {error}"))?;
        if self.core {
            hc::action(self, input).await
        } else {
            cli::action(self, input).await
        }
    }
    pub async fn ensure(&self, cwd: &str) -> Result<(), String> {
        if self.core {
            hc::snapshot(self).await.map(|_| ())
        } else {
            cli::ensure(self, cwd).await
        }
    }
    pub fn assignments(&self, terminal: bool) -> Result<String, String> {
        let mut env = self.env.clone();
        if terminal {
            env.insert("HERDR_SOCKET_PATH".into(), self.path()?);
            env.insert("HERDR_SESSION".into(), String::new());
        }
        Ok(env
            .iter()
            .filter(|(key, _)| {
                !key.starts_with("LIBERTTY_")
                    && !key.is_empty()
                    && !key.as_bytes()[0].is_ascii_digit()
                    && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            })
            .map(|(key, value)| format!("{key}={}", shell_quote(value)))
            .collect::<Vec<_>>()
            .join(" "))
    }
    pub async fn from_source(
        source: &crate::session::Session,
        session_name: &str,
    ) -> Result<Self, String> {
        let Some(remote) = &source.remote else {
            return Self::local(session_name);
        };
        let dollar = char::from(b'$');
        let command = format!(
            "printf '%s\\0' \"{dollar}HOME\" \"{dollar}{{XDG_CONFIG_HOME-}}\" \"{dollar}{{HERDR_SOCKET_PATH-}}\" \"{dollar}PATH\""
        );
        let output = remote.exec(&command, &CancellationToken::new()).await?;
        if output.code != 0 {
            return Err("Could not discover Herdr on this SSH host.".into());
        }
        let values = output.stdout.split('\0').collect::<Vec<_>>();
        if !values.first().is_some_and(|home| home.starts_with('/')) {
            return Err("The SSH host did not provide its home directory.".into());
        }
        let env = ["HOME", "XDG_CONFIG_HOME", "HERDR_SOCKET_PATH", "PATH"]
            .into_iter()
            .zip(values)
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        Ok(Self {
            core: false,
            session: session_name.into(),
            socket_path: Some(socket(session_name, &env)?),
            binary: "herdr".into(),
            env,
            remote: Some(remote.clone()),
            repairs: Default::default(),
            shared: Default::default(),
        })
    }
    pub async fn preview(&self, agent: &Terminal) -> String {
        if self.core {
            hc::preview(self, &agent.terminal_id)
                .await
                .unwrap_or_default()
        } else {
            cli::preview(self, agent).await
        }
    }
}

pub async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Value>, String> {
    Lines::default().read(reader).await
}
#[derive(Default)]
pub struct Lines {
    pending: Vec<u8>,
}
impl Lines {
    pub async fn read<R: AsyncBufRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> Result<Option<Value>, String> {
        loop {
            let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
            if available.is_empty() {
                return Ok(None);
            }
            let end = available.iter().position(|b| *b == b'\n');
            let count = end.map_or(available.len(), |n| n + 1);
            if self.pending.len() + count > MAX_LINE {
                return Err("Herdr response exceeded its limit.".into());
            }
            self.pending.extend_from_slice(&available[..count]);
            reader.consume(count);
            if end.is_some() {
                if self.pending.iter().all(u8::is_ascii_whitespace) {
                    self.pending.clear();
                    continue;
                }
                let line = std::mem::take(&mut self.pending);
                return serde_json::from_str(&String::from_utf8_lossy(&line))
                    .map(Some)
                    .map_err(|_| "Invalid Herdr response.".into());
            }
        }
    }
}
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub use crate::herdr::snapshot::{Snapshot, Space, Status, Terminal, normalize};

pub fn response_preview(screen: &str) -> String {
    static COMPOSER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*[│┃║]?\s*[›❯]\s").unwrap());
    static LEFT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[│┃║]\s?").unwrap());
    static RIGHT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[│┃║]\s*$").unwrap());
    static BORDER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[\s─━═┌┐└┘├┤┬┴┼╭╮╰╯│┃║]+$").unwrap());
    static WORK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[✻*]\s*)?(?:Worked|Working|Thinking)\s+for\s+\d").unwrap()
    });
    static PARAGRAPH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[•●✦]\s*").unwrap());
    let plain = crate::reading::strip_vt(screen).replace('\r', "");
    let lines: Vec<_> = plain.split('\n').collect();
    let end = lines
        .iter()
        .rposition(|line| COMPOSER.is_match(line))
        .unwrap_or(lines.len());
    let output = lines[..end]
        .iter()
        .map(|line| RIGHT.replace(&LEFT.replace(line, ""), "").trim().to_owned())
        .filter(|line| !BORDER.is_match(line) && !WORK.is_match(line))
        .collect::<Vec<_>>()
        .join("\n");
    let last = PARAGRAPH.split(output.trim()).last().unwrap_or("");
    let spaced = SPACE.replace_all(last, " ");
    let text = BULLET.replace(&spaced, "");
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() > 280 {
        chars[..279].iter().collect::<String>() + "…"
    } else {
        text.into_owned()
    }
}
pub fn notification_body(cwd: &str, preview: &str) -> String {
    let directory: String = cwd
        .chars()
        .filter(|c| *c > '\u{1f}' && *c != '\u{7f}')
        .take(240)
        .collect();
    [preview, &directory]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "HerdrMessage"))]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Metadata {
    Snapshot { snapshot: Arc<Snapshot> },
    Error { message: String },
}
impl Metadata {
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("metadata message")
    }
}

pub async fn metadata(
    target: Target,
    send: tokio::sync::mpsc::Sender<Metadata>,
    cancel: CancellationToken,
) {
    if target.core {
        hc::metadata(&target, send, cancel).await
    } else {
        cli::metadata(target, send, cancel).await
    }
}

#[cfg(test)]
mod repair_cache_tests {
    use super::*;
    #[tokio::test]
    async fn command_catalog_shares_success_and_refreshes_after_expiry() {
        let cache = CommandCatalog::default();
        let cancel = CancellationToken::new();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let scan = || async {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(vec!["tool".into()])
        };
        let (first, second) = tokio::join!(cache.get(&cancel, scan()), cache.get(&cancel, scan()));
        assert!(Arc::ptr_eq(&first.unwrap(), &second.unwrap()));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(2010)).await;
        cache.get(&cancel, scan()).await.unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn command_catalog_retries_errors_and_cancelled_scans() {
        let cache = CommandCatalog::default();
        let cancel = CancellationToken::new();
        assert!(
            cache
                .get(&cancel, async { Err("failed".into()) })
                .await
                .is_err()
        );
        let stopped = CancellationToken::new();
        let pending = cache.get(&stopped, std::future::pending());
        let stop = async {
            tokio::task::yield_now().await;
            stopped.cancel();
        };
        let (result, _) = tokio::join!(pending, stop);
        assert!(result.is_err());
        assert_eq!(
            cache
                .get(&cancel, async { Ok(vec!["new".into()]) })
                .await
                .unwrap()
                .as_slice(),
            ["new"]
        );
    }
    #[tokio::test]
    async fn learned_metadata_survives_requests_but_not_terminal_or_shell_changes() {
        let services = crate::host::HostServices::new();
        let cache = RepairSessions::default();
        let catalog = libertty_engine::types::Catalog {
            cwd: "/fixture".into(),
            commands: vec!["fixture".into()].into(),
            ..Default::default()
        };
        let environment = Environment::new();
        let RepairContext { engine, help, .. } =
            cache.get("one", "shell-a".into(), &services).await.unwrap();
        let host = crate::host::NativeHost::new(
            services.clone(),
            catalog.clone(),
            environment.clone(),
            help,
        );
        let cancel = CancellationToken::new();
        engine.invoke(libertty_engine::Request { operation: "seedMetadata".into(), args: vec![json!(catalog), json!(environment), json!({"flags":{"fixture":[{"name":"--learned","takesValue":false}]},"subcommands":{}})] }, &host, &cancel).await.unwrap();
        for (terminal, identity, expected) in [
            ("one", "shell-a", true),
            ("two", "shell-a", false),
            ("one", "shell-b", false),
        ] {
            let RepairContext { engine, .. } = cache
                .get(terminal, identity.into(), &services)
                .await
                .unwrap();
            let metadata = engine
                .invoke(
                    libertty_engine::Request {
                        operation: "cachedMetadata".into(),
                        args: vec![json!(catalog), json!(environment)],
                    },
                    &host,
                    &cancel,
                )
                .await
                .unwrap();
            assert_eq!(metadata["flags"].get("fixture").is_some(), expected);
        }
    }
}
