use crate::{reading, storage};
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
    pub session: String,
    pub socket_path: Option<String>,
    pub binary: String,
    pub env: Environment,
    pub remote: Option<Arc<crate::ssh::SSHHost>>,
    pub repairs: RepairSessions,
    pub shared: crate::herdr_metadata::Shared,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ResourceKey {
    transport: Option<usize>,
    socket: String,
    item: String,
}
#[derive(Clone, Default)]
pub struct RepairSessions(Arc<tokio::sync::Mutex<HashMap<String, RepairContext>>>);
struct RepairContext {
    identity: String,
    engine: crate::engine::NativeEngine,
    help: crate::help::HelpProvider,
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
    ) -> Result<(crate::engine::NativeEngine, crate::help::HelpProvider), String> {
        let mut contexts = self.0.lock().await;
        if let Some(context) = contexts.get(terminal).filter(|c| c.identity == identity) {
            return Ok((context.engine.clone(), context.help.clone()));
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
        };
        let result = (context.engine.clone(), context.help.clone());
        contexts.insert(terminal.into(), context);
        Ok(result)
    }
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
    pub(crate) async fn validate_terminal(&self, terminal: &Terminal) -> Result<(), String> {
        let response = self
            .request("pane.get", json!({"pane_id":terminal.pane_id}))
            .await?;
        if response["pane"]["terminal_id"] != terminal.terminal_id {
            return Err("This agent ended or moved. Reopen its tab. No input was sent.".into());
        }
        Ok(())
    }
    pub async fn shell_input(&self, pane: &str) -> Result<Option<ShellInput>, String> {
        self.input_state(pane).await.map(|(shell, _)| shell)
    }
    pub async fn input_state(&self, pane: &str) -> Result<(Option<ShellInput>, String), String> {
        let response = self
            .request("pane.process_info", json!({"pane_id":pane}))
            .await?;
        let info = &response["process_info"];
        let context = info["shell_pid"]
            .as_u64()
            .filter(|pid| *pid > 0)
            .zip(
                info["foreground_process_group_id"]
                    .as_u64()
                    .filter(|pid| *pid > 0),
            )
            .map(|(shell, group)| format!("{shell}:{group}"))
            .unwrap_or_default();
        let shell = (|| {
            let pid = info["shell_pid"].as_u64().filter(|pid| *pid > 0)?;
            if info["foreground_process_group_id"].as_u64() != Some(pid) {
                return None;
            }
            let process = info["foreground_processes"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["pid"] == pid));
            let process = process?;
            if !matches!(
                process["name"].as_str(),
                Some("bash" | "zsh" | "fish" | "sh" | "dash" | "ksh")
            ) {
                return None;
            }
            let cwd = process["cwd"].as_str().filter(|cwd| cwd.starts_with('/'))?;
            Some(ShellInput {
                pid,
                cwd: cwd.into(),
            })
        })();
        Ok((shell, context))
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
        let commands = if let Some(remote) = &self.remote {
            let result = remote.exec("bash -c 'compgen -c'", cancel).await?;
            result.stdout.lines().map(str::to_owned).collect::<Vec<_>>()
        } else {
            services.catalog.executable_names(&env, cancel).await?
        };
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
        let identity = crate::facts::digest(&json!([shell.pid, shell.cwd, env]));
        let (engine, help) = self.repairs.get(terminal, identity, &services).await?;
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
    pub async fn snapshot(&self) -> Result<Snapshot, String> {
        self.shared
            .resource(self)?
            .snapshot(self)
            .await
            .map(|snapshot| (*snapshot).clone())
    }
    pub async fn options(&self) -> Result<Value, String> {
        static KIND: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{0,63}$").unwrap());
        let response = self.request("server.agent_manifests", json!({})).await?;
        let mut kinds = Vec::<String>::new();
        for manifest in array(&response, "manifests") {
            if let Some(kind) = manifest["agent"].as_str().filter(|s| KIND.is_match(s))
                && !kinds.iter().any(|s| s == kind)
            {
                kinds.push(kind.into());
            }
        }
        Ok(
            json!({"kinds":kinds,"actions":["list-worktrees","new-worktree","open-worktree","delete-worktree","split","create-space","move-space","create","rename-space","close-space","rename","close"]}),
        )
    }
    pub async fn action<M: TryInto<crate::herdr_action::Action>>(
        &self,
        input: M,
    ) -> Result<Value, String>
    where
        M::Error: std::fmt::Display,
    {
        use crate::herdr_action::Action;
        let input: Action = input
            .try_into()
            .map_err(|error| format!("Invalid Herdr action: {error}"))?;
        // Directory choices and checkout confirmations must reflect current metadata.
        let resource = self.shared.resource(self)?;
        let snapshot = if matches!(
            &input,
            Action::DeleteWorktree { .. }
                | Action::ListWorktrees { .. }
                | Action::NewWorktree { .. }
                | Action::OpenWorktree { .. }
                | Action::CreateSpace { .. }
                | Action::Create { .. }
        ) {
            resource.refresh_snapshot(self).await?
        } else {
            resource.snapshot(self).await?
        };
        let spaces = &snapshot.spaces;
        let terminals = &snapshot.terminals;
        let space = input
            .workspace()
            .and_then(|id| spaces.iter().find(|space| space.id == id));
        match input {
            Action::DeleteWorktree { path, force, .. } => {
                let space = space.ok_or("This space has closed.")?;
                if space.linked_worktree != Some(true) {
                    return Err("Only a linked worktree checkout can be deleted.".into());
                }
                let checkout = space
                    .checkout_path
                    .as_deref()
                    .filter(|p| !p.is_empty())
                    .ok_or(
                        "Herdr did not provide the checkout folder. Update Herdr on this host.",
                    )?;
                if path.as_deref() != Some(checkout) {
                    return Err(
                        "The checkout folder changed. Reopen the confirmation before deleting."
                            .into(),
                    );
                }
                self.space_request(
                    "worktree.remove",
                    json!({"workspace_id":space.id,"force":force,"trust_repository":false}),
                )
                .await
            }
            action @ (Action::ListWorktrees { .. }
            | Action::NewWorktree { .. }
            | Action::OpenWorktree { .. }) => {
                let space = space.ok_or("This space has closed.")?;
                if space.linked_worktree == Some(true) {
                    return Err(
                        "New and open worktree actions start from the repo parent space.".into(),
                    );
                }
                let mut params = json!({"workspace_id":space.id,"trust_repository":false});
                let mut listing = self.space_request("worktree.list", params.clone()).await?;
                if !listing["worktrees"].is_array() || !listing["source"]["repo_name"].is_string() {
                    return Err("This Herdr server does not provide worktree discovery. Update Herdr on this host.".into());
                }
                let method = match action {
                    Action::ListWorktrees { .. } => {
                        if let Some(root) = listing["source"]["repo_root"].as_str() {
                            listing["branches"] =
                                json!(self.branch_names(root).await.unwrap_or_default());
                        }
                        if let Some(directory) = snapshot.worktree_directory.as_ref() {
                            listing["directory"] = json!(directory);
                        }
                        return Ok(listing);
                    }
                    Action::NewWorktree { branch, .. } => {
                        params["branch"] = json!(name(&branch)?);
                        params["base"] = json!("HEAD");
                        "worktree.create"
                    }
                    Action::OpenWorktree { path, .. } => {
                        if !array(&listing, "worktrees").iter().any(|entry| {
                            entry["path"] == path
                                && entry["is_bare"] != true
                                && entry["is_prunable"] != true
                        }) {
                            return Err(
                                "This worktree is no longer available. Reopen the worktree picker."
                                    .into(),
                            );
                        }
                        params["path"] = json!(path);
                        "worktree.open"
                    }
                    _ => unreachable!(),
                };
                params["focus"] = json!(false);
                let created = self.space_request(method, params).await?;
                if !created["workspace"]["workspace_id"].is_string() {
                    return Err("Herdr changed the worktree but did not return its identity. Refresh spaces before retrying.".into());
                }
                Ok(
                    json!({"workspaceId":created["workspace"]["workspace_id"],"terminalId":created["root_pane"]["terminal_id"]}),
                )
            }
            Action::Split {
                terminal_id,
                direction,
                ..
            } => {
                let space = space.ok_or("This space has closed.")?;
                let terminal = terminals
                    .iter()
                    .find(|t| {
                        t.terminal_id == terminal_id
                            && t.workspace_id.as_deref() == Some(space.id.as_str())
                    })
                    .ok_or("Choose a running terminal in this space.")?;
                self.validate_terminal(terminal).await?;
                let created = self.space_request("pane.split", json!({"workspace_id":space.id,"target_pane_id":terminal.pane_id,"direction":direction,"focus":false})).await?;
                Ok(json!({"workspaceId":space.id,"terminalId":created["pane"]["terminal_id"]}))
            }
            Action::CreateSpace {
                workspace_id,
                terminal_id,
            } => {
                if workspace_id.is_some() && space.is_none() {
                    return Err("This space has closed.".into());
                }
                let terminal = terminals.iter().find(|t| {
                    Some(t.terminal_id.as_str()) == terminal_id.as_deref()
                        && t.workspace_id.as_deref() == space.map(|space| space.id.as_str())
                });
                let cwd = terminal
                    .map(|t| t.cwd.as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| space.map(|s| s.cwd.as_str()).filter(|s| !s.is_empty()));
                let mut params = json!({"focus":false});
                if let Some(space) = space {
                    params["source_workspace_id"] = json!(space.id);
                }
                if let Some(cwd) = cwd {
                    params["cwd"] = json!(cwd);
                }
                let created = self.request("workspace.create", params).await?;
                if !created["workspace"]["workspace_id"].is_string() {
                    return Err("Herdr created a space but did not return its identity.".into());
                }
                let mut result = json!({"workspaceId":created["workspace"]["workspace_id"]});
                if let Some(id) = created["root_pane"].get("terminal_id") {
                    result["terminalId"] = id.clone();
                }
                Ok(result)
            }
            Action::MoveSpace {
                workspace_id,
                before_workspace_id,
            } => {
                if space.is_none() {
                    return Err("This space has closed.".into());
                }
                if let Some(before) = &before_workspace_id
                    && (before == &workspace_id || !spaces.iter().any(|s| s.id == *before))
                {
                    return Err("Choose another existing space.".into());
                }
                let mut params = json!({"workspace_ids":[workspace_id]});
                if let Some(before) = before_workspace_id {
                    params["before_workspace_id"] = json!(before);
                }
                self.request("workspace.move_block", params).await
            }
            Action::Create {
                name: label,
                kind,
                cwd,
                ..
            } => {
                let label = name(&label)?;
                if !array(&self.options().await?, "kinds").contains(&json!(kind)) {
                    return Err("Choose a supported agent type.".into());
                }
                let space = space.ok_or("Choose an existing space.")?;
                if cwd.as_ref().is_some_and(|s| {
                    !s.starts_with('/') || utf16_len(s) > 4096 || crate::protocol::controls(s)
                }) {
                    return Err("Enter an absolute working directory.".into());
                }
                let mut params = json!({"workspace_id":space.id,"label":label,"focus":false});
                if let Some(cwd) = cwd {
                    params["cwd"] = json!(cwd);
                }
                let created = self.request("tab.create", params).await?;
                let pane = &created["root_pane"];
                if !pane["pane_id"].is_string() || !pane["terminal_id"].is_string() {
                    return Err(
                        "Herdr created a tab but did not return its terminal. Open it from spaces."
                            .into(),
                    );
                }
                let work = async {
                    self.request("pane.rename", json!({"pane_id":pane["pane_id"],"label":label})).await?;
                    self.request("agent.start", json!({"pane_id":pane["pane_id"],"name":format!("agent-{}",storage::random_hex(10)),"kind":kind,"args":[]})).await?;
                    Ok::<_, String>(())
                }.await;
                let mut result = json!({"terminalId":pane["terminal_id"]});
                if let Err(error) = work {
                    result["error"] = json!(error);
                }
                Ok(result)
            }
            Action::RenameSpace { name: label, .. } => {
                let space = space.ok_or("This space has closed.")?;
                self.request(
                    "workspace.rename",
                    json!({"workspace_id":space.id,"label":name(&label)?}),
                )
                .await
            }
            Action::CloseSpace { .. } => {
                let space = space.ok_or("This space has closed.")?;
                self.request(
                    "workspace.close",
                    json!({"workspace_id":space.id,"close_group":false}),
                )
                .await
            }
            action @ (Action::Rename { .. } | Action::Close { .. }) => {
                let id = match &action {
                    Action::Rename { terminal_id, .. } | Action::Close { terminal_id } => {
                        terminal_id
                    }
                    _ => unreachable!(),
                };
                let agent = terminals
                    .iter()
                    .find(|t| t.terminal_id == *id)
                    .ok_or("This agent has ended.")?;
                self.validate_terminal(agent).await?;
                match action {
                    Action::Rename { name: label, .. } => {
                        self.request(
                            "pane.rename",
                            json!({"pane_id":agent.pane_id,"label":name(&label)?}),
                        )
                        .await
                    }
                    _ => {
                        self.request("pane.close", json!({"pane_id":agent.pane_id}))
                            .await
                    }
                }
            }
        }
    }
    async fn branch_names(&self, root: &str) -> Result<Vec<String>, String> {
        let args: Vec<String> = vec![
            "-C".into(),
            root.into(),
            "for-each-ref".into(),
            "--sort=refname".into(),
            "--format=%(refname:strip=2)".into(),
            "refs/heads/".into(),
        ];
        let cancel = CancellationToken::new();
        let output = if let Some(remote) = &self.remote {
            let command = format!(
                "git {}",
                args.iter()
                    .map(|arg| shell_quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let result = remote.exec(&command, &cancel).await?;
            if result.code != 0 {
                return Err(result.stderr);
            }
            result.stdout
        } else {
            let options = crate::probes::ProbeOptions {
                cwd: root.into(),
                env: self.env.clone(),
                timeout: Duration::from_secs(5),
                max_buffer: 1024 * 1024,
            };
            let result = crate::probes::probe(
                &crate::probes::ProbePool::default(),
                "git",
                &args,
                &options,
                &cancel,
            )
            .await?;
            if !result.success {
                return Err(String::from_utf8_lossy(&result.stderr).into());
            }
            String::from_utf8(result.stdout).map_err(|error| error.to_string())?
        };
        Ok(output
            .lines()
            .filter(|branch| name(branch).is_ok())
            .map(str::to_owned)
            .collect())
    }
    async fn space_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request(method, params).await.map_err(|error| {
            if ["unknown method", "unknown action", "method not found", "unsupported"].iter().any(|reason| error.to_lowercase().contains(reason)) {
                format!("This Herdr server does not support {method}. Update Herdr on this host. ({error})")
            } else { error }
        })
    }
    pub async fn ensure(&self, cwd: &str) -> Result<(), String> {
        if self.request("session.snapshot", json!({})).await.is_ok() {
            return Ok(());
        }
        if let Some(remote) = &self.remote {
            let args = if self.session.is_empty() {
                vec![self.binary.as_str(), "server"]
            } else {
                vec![self.binary.as_str(), "--session", &self.session, "server"]
            };
            let command = format!(
                "cd {} && nohup env {} {} </dev/null >/dev/null 2>&1 &",
                shell_quote(cwd),
                self.assignments(false)?,
                args.into_iter()
                    .map(shell_quote)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            remote.exec(&command, &CancellationToken::new()).await?;
        } else {
            let mut command = tokio::process::Command::new(&self.binary);
            if !self.session.is_empty() {
                command.args(["--session", &self.session]);
            }
            command
                .arg("server")
                .current_dir(cwd)
                .env_clear()
                .envs(&self.env)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            // A Herdr server outlives the shell that requested it.
            #[cfg(unix)]
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if self.request("session.snapshot", json!({})).await.is_ok() {
                return Ok(());
            }
        }
        Err("Herdr did not start. Run herdr server on this machine and try again.".into())
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
        let work = async {
            let current = self.request("pane.get", json!({"pane_id":agent.pane_id})).await?;
            if current["pane"]["terminal_id"] != agent.terminal_id { return Ok::<_, String>(String::new()); }
            let response = self.request("pane.read", json!({"pane_id":agent.pane_id,"source":"recent_unwrapped","format":"ansi","lines":40,"strip_ansi":false})).await?;
            Ok(response["read"]["text"].as_str().map(response_preview).unwrap_or_default())
        }.await;
        work.unwrap_or_default()
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
fn array<'a>(object: &'a Value, field: &str) -> &'a [Value] {
    object[field].as_array().map(Vec::as_slice).unwrap_or(&[])
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
pub use crate::herdr_snapshot::{Snapshot, Space, Status, Terminal, normalize};

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
    let plain = reading::strip_vt(screen).replace('\r', "");
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
    let resource = match target.shared.resource(&target) {
        Ok(resource) => resource,
        Err(message) => {
            let _ = send.send(Metadata::Error { message }).await;
            return;
        }
    };
    let mut subscription = resource.subscribe(target);
    loop {
        let update = subscription.receive.borrow_and_update().clone();
        if let Some(update) = update {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = send.send(update) => if result.is_err() { break; }
            }
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            result = subscription.receive.changed() => if result.is_err() { break; }
        }
    }
}

pub(crate) fn pane_key(snapshot: &Snapshot) -> Vec<String> {
    let mut result: Vec<_> = snapshot
        .agents
        .iter()
        .map(|agent| agent.pane_id.clone())
        .collect();
    result.sort();
    result
}

#[cfg(test)]
mod repair_cache_tests {
    use super::*;
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
        let (engine, help) = cache.get("one", "shell-a".into(), &services).await.unwrap();
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
            let (engine, _) = cache
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
