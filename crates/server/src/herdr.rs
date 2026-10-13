use crate::{reading, storage};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::Duration,
};
use termai_engine::{repair::shell_quote, validation::Environment};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::UnixStream,
};
use tokio_util::sync::CancellationToken;

pub const MAX_LINE: usize = 8 * 1024 * 1024;
pub fn session(value: Option<&Value>) -> Result<String, String> {
    if value.is_none_or(Value::is_null)
        || value
            .and_then(Value::as_str)
            .is_some_and(|s| s.is_empty() || s == "default")
    {
        return Ok(String::new());
    }
    let value = value
        .and_then(Value::as_str)
        .ok_or("Use a Herdr session name containing letters, numbers, hyphens or underscores.")?;
    if value.is_empty()
        || value.len() > 64
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(
            "Use a Herdr session name containing letters, numbers, hyphens or underscores.".into(),
        );
    }
    Ok(value.into())
}
pub fn name(value: &Value) -> Result<String, String> {
    let value = value.as_str().ok_or("Enter a name of 1–100 characters.")?;
    if value.trim().is_empty()
        || value.encode_utf16().count() > 100
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err("Enter a name of 1–100 characters.".into());
    }
    Ok(value.trim().into())
}
pub fn socket(session_name: &str, env: &Environment) -> Result<String, String> {
    let session = session(Some(&json!(session_name)))?;
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
            .map(|m| json!(m.as_str()))
            .or_else(|| env.get("HERDR_SESSION").map(|s| json!(s)))
            .as_ref(),
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
}
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type Connection = Box<dyn Stream>;
impl Target {
    pub fn local(session_name: &str) -> Result<Self, String> {
        Ok(Self {
            session: session(Some(&json!(session_name)))?,
            socket_path: None,
            binary: "herdr".into(),
            env: std::env::vars().collect(),
            remote: None,
        })
    }
    pub fn path(&self) -> Result<String, String> {
        self.socket_path
            .clone()
            .map(Ok)
            .unwrap_or_else(|| socket(&self.session, &self.env))
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
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let work = async {
            let mut stream = self.open().await?;
            let id = storage::random_hex(16);
            stream
                .write_all(
                    format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes(),
                )
                .await
                .map_err(|_| {
                    "Cannot connect to Herdr. Start its server on this backend first.".to_owned()
                })?;
            let mut input = BufReader::new(stream);
            loop {
                let reply = read_line(&mut input)
                    .await?
                    .ok_or("Herdr disconnected before responding.")?;
                if reply["id"] != id {
                    continue;
                }
                if truthy(&reply["error"]) {
                    return Err(reply["error"]["message"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Herdr rejected the action.")
                        .into());
                }
                return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
            }
        };
        let timeout = if method.starts_with("worktree.") {
            60
        } else {
            5
        };
        tokio::time::timeout(Duration::from_secs(timeout), work)
            .await
            .map_err(|_| "Herdr did not respond.".to_owned())?
    }
    pub async fn snapshot(&self) -> Result<Value, String> {
        normalize(&self.request("session.snapshot", json!({})).await?)
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
        Ok(json!({"kinds":kinds}))
    }
    pub async fn action(&self, input: &Value) -> Result<Value, String> {
        let snapshot = self.snapshot().await?;
        let spaces = array(&snapshot, "spaces");
        let terminals = array(&snapshot, "terminals");
        let space = spaces
            .iter()
            .find(|s| s.get("id") == input.get("workspaceId"));
        match input["action"].as_str().unwrap_or("") {
            "list-worktrees" | "new-worktree" | "open-worktree" => {
                let space = space.ok_or("This space has closed.")?;
                if space["linkedWorktree"] == true {
                    return Err(
                        "New and open worktree actions start from the repo parent space.".into(),
                    );
                }
                let params = json!({"workspace_id":space["id"],"trust_repository":false});
                let mut listing = self.space_request("worktree.list", params.clone()).await?;
                if !listing["worktrees"].is_array() || !listing["source"]["repo_name"].is_string() {
                    return Err("This Herdr server does not provide worktree discovery. Update Herdr on this host.".into());
                }
                if input["action"] == "list-worktrees" {
                    if let Some(directory) = snapshot.get("worktreeDirectory") {
                        listing["directory"] = directory.clone();
                    }
                    return Ok(listing);
                }
                let mut params = params;
                params["focus"] = json!(false);
                let method = if input["action"] == "new-worktree" {
                    params["branch"] = json!(name(&input["branch"])?);
                    params["base"] = json!("HEAD");
                    "worktree.create"
                } else {
                    let path = input["path"]
                        .as_str()
                        .ok_or("Choose an existing worktree.")?;
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
                };
                let created = self.space_request(method, params).await?;
                if !created["workspace"]["workspace_id"].is_string() {
                    return Err("Herdr changed the worktree but did not return its identity. Refresh spaces before retrying.".into());
                }
                Ok(
                    json!({"workspaceId":created["workspace"]["workspace_id"],"terminalId":created["root_pane"]["terminal_id"]}),
                )
            }
            "split" => {
                let space = space.ok_or("This space has closed.")?;
                let terminal = terminals
                    .iter()
                    .find(|t| {
                        t.get("terminalId") == input.get("terminalId")
                            && t.get("workspaceId") == space.get("id")
                    })
                    .ok_or("Choose a running terminal in this space.")?;
                if !matches!(input["direction"].as_str(), Some("right" | "down")) {
                    return Err("Choose a right or down split.".into());
                }
                let created = self.space_request("pane.split", json!({"workspace_id":space["id"],"target_pane_id":terminal["paneId"],"direction":input["direction"],"focus":false})).await?;
                Ok(json!({"workspaceId":space["id"],"terminalId":created["pane"]["terminal_id"]}))
            }
            "create-space" => {
                if input.get("workspaceId").is_some() && space.is_none() {
                    return Err("This space has closed.".into());
                }
                let terminal = terminals.iter().find(|t| {
                    t.get("terminalId") == input.get("terminalId")
                        && t.get("workspaceId") == space.and_then(|s| s.get("id"))
                });
                let cwd = terminal
                    .and_then(|t| t["cwd"].as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        space
                            .and_then(|s| s["cwd"].as_str())
                            .filter(|s| !s.is_empty())
                    });
                let mut params = json!({"focus":false});
                if let Some(space) = space {
                    params["source_workspace_id"] = space["id"].clone();
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
            "move-space" => {
                if space.is_none() {
                    return Err("This space has closed.".into());
                }
                if let Some(before) = input.get("beforeWorkspaceId")
                    && (Some(before) == input.get("workspaceId")
                        || !spaces.iter().any(|s| s.get("id") == Some(before)))
                {
                    return Err("Choose another existing space.".into());
                }
                let mut params = json!({"workspace_ids":[input["workspaceId"]]});
                if let Some(before) = input.get("beforeWorkspaceId") {
                    params["before_workspace_id"] = before.clone();
                }
                self.request("workspace.move_block", params).await
            }
            "create" => {
                let label = name(&input["name"])?;
                if !input["kind"].is_string()
                    || !array(&self.options().await?, "kinds").contains(&input["kind"])
                {
                    return Err("Choose a supported agent type.".into());
                }
                let space = space.ok_or("Choose an existing space.")?;
                if let Some(cwd) = input.get("cwd")
                    && !cwd.as_str().is_some_and(|s| {
                        s.starts_with('/')
                            && s.encode_utf16().count() <= 4096
                            && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                    })
                {
                    return Err("Enter an absolute working directory.".into());
                }
                let mut params = json!({"workspace_id":space["id"],"label":label,"focus":false});
                if truthy(&input["cwd"]) {
                    params["cwd"] = input["cwd"].clone();
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
                    self.request("agent.start", json!({"pane_id":pane["pane_id"],"name":format!("agent-{}",storage::random_hex(10)),"kind":input["kind"],"args":[]})).await?;
                    Ok::<_, String>(())
                }.await;
                let mut result = json!({"terminalId":pane["terminal_id"]});
                if let Err(error) = work {
                    result["error"] = json!(error);
                }
                Ok(result)
            }
            "rename-space" | "close-space" => {
                let space = space.ok_or("This space has closed.")?;
                if input["action"] == "close-space" {
                    self.request(
                        "workspace.close",
                        json!({"workspace_id":space["id"],"close_group":false}),
                    )
                    .await
                } else {
                    self.request(
                        "workspace.rename",
                        json!({"workspace_id":space["id"],"label":name(&input["name"])?}),
                    )
                    .await
                }
            }
            _ => {
                if !input["terminalId"].is_string() {
                    return Err("Choose an agent.".into());
                }
                let agent = terminals
                    .iter()
                    .find(|t| t["terminalId"] == input["terminalId"])
                    .ok_or("This agent has ended.")?;
                match input["action"].as_str() {
                    Some("rename") => {
                        self.request(
                            "pane.rename",
                            json!({"pane_id":agent["paneId"],"label":name(&input["name"])?}),
                        )
                        .await
                    }
                    Some("close") => {
                        self.request("pane.close", json!({"pane_id":agent["paneId"]}))
                            .await
                    }
                    _ => Err("Unknown Herdr action.".into()),
                }
            }
        }
    }
    async fn space_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request(method, params).await.map_err(|error| {
            if error.to_lowercase().contains("unknown method") || error.to_lowercase().contains("unsupported") {
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
                !key.starts_with("TERMAI_")
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
        })
    }
    pub async fn preview(&self, agent: &Value) -> String {
        let work = async {
            let current = self.request("pane.get", json!({"pane_id":agent["paneId"]})).await?;
            if current["pane"]["terminal_id"] != agent["terminalId"] { return Ok::<_, String>(String::new()); }
            let response = self.request("pane.read", json!({"pane_id":agent["paneId"],"source":"recent_unwrapped","format":"ansi","lines":40,"strip_ansi":false})).await?;
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
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn first(values: &[&Value], fallback: Value) -> Value {
    values
        .iter()
        .find(|v| truthy(v))
        .map(|v| (*v).clone())
        .unwrap_or(fallback)
}
fn safe_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0)
}
fn copy_fields(object: &mut Map<String, Value>, source: &Value, fields: &[(&str, &str)]) {
    for (to, from) in fields {
        if let Some(value) = source.get(from) {
            object.insert((*to).into(), value.clone());
        }
    }
}
pub fn normalize(raw: &Value) -> Result<Value, String> {
    let snapshot = &raw["snapshot"];
    if !["agents", "tabs", "workspaces"]
        .iter()
        .all(|field| snapshot[field].is_array())
    {
        return Err("This Herdr server does not provide a session snapshot.".into());
    }
    let workspaces: HashMap<_, _> = array(snapshot, "workspaces")
        .iter()
        .map(|w| {
            (
                w["workspace_id"].clone(),
                first(
                    &[&w["label"]],
                    json!(format!(
                        "Workspace {}",
                        w.get("number")
                            .filter(|v| truthy(v))
                            .map(|v| v
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| v.to_string()))
                            .unwrap_or_default()
                    )),
                ),
            )
        })
        .collect();
    let tabs: HashMap<_, _> = array(snapshot, "tabs")
        .iter()
        .map(|t| (t["tab_id"].clone(), t))
        .collect();
    let mut panes = Vec::<&Value>::new();
    for pane in array(snapshot, "panes") {
        if let Some(previous) = panes.iter_mut().find(|p| p["pane_id"] == pane["pane_id"]) {
            *previous = pane;
        } else {
            panes.push(pane);
        }
    }
    let mut agents = Vec::new();
    for agent in array(snapshot, "agents")
        .iter()
        .filter(|a| a["terminal_id"].is_string() && a["pane_id"].is_string())
        .take(256)
    {
        let pane = panes
            .iter()
            .find(|p| p["pane_id"] == agent["pane_id"])
            .copied()
            .unwrap_or(&Value::Null);
        let tab = tabs.get(&agent["tab_id"]).copied().unwrap_or(&Value::Null);
        let mut value = Map::new();
        copy_fields(
            &mut value,
            agent,
            &[
                ("terminalId", "terminal_id"),
                ("paneId", "pane_id"),
                ("workspaceId", "workspace_id"),
                ("tabId", "tab_id"),
            ],
        );
        value.insert(
            "workspace".into(),
            workspaces
                .get(&agent["workspace_id"])
                .cloned()
                .unwrap_or(json!("Workspace")),
        );
        value.insert(
            "name".into(),
            first(
                &[
                    &pane["label"],
                    &agent["title"],
                    &pane["title"],
                    &agent["name"],
                    &agent["terminal_title_stripped"],
                    &pane["terminal_title_stripped"],
                    &tab["label"],
                    &agent["display_agent"],
                    &agent["agent"],
                ],
                json!("Agent"),
            ),
        );
        value.insert(
            "kind".into(),
            first(
                &[&agent["display_agent"], &agent["agent"]],
                json!("Terminal"),
            ),
        );
        value.insert(
            "status".into(),
            if ["idle", "working", "blocked", "done"]
                .iter()
                .any(|s| agent["agent_status"] == *s)
            {
                agent["agent_status"].clone()
            } else {
                json!("unknown")
            },
        );
        value.insert(
            "sequence".into(),
            if safe_integer(&agent["state_change_seq"]) {
                agent["state_change_seq"].clone()
            } else {
                first(&[&agent["revision"]], json!(0))
            },
        );
        if safe_integer(&agent["completion_seq"]) {
            value.insert("completion".into(), agent["completion_seq"].clone());
        }
        value.insert(
            "cwd".into(),
            first(&[&agent["foreground_cwd"], &agent["cwd"]], json!("")),
        );
        agents.push(Value::Object(value));
    }
    let mut terminals = Vec::new();
    for pane in panes
        .iter()
        .filter(|p| p["terminal_id"].is_string())
        .take(256)
    {
        if let Some(agent) = agents
            .iter()
            .find(|a| a["terminalId"] == pane["terminal_id"])
        {
            terminals.push(agent.clone());
            continue;
        }
        let tab = tabs.get(&pane["tab_id"]).copied().unwrap_or(&Value::Null);
        let mut value = Map::new();
        copy_fields(
            &mut value,
            pane,
            &[
                ("terminalId", "terminal_id"),
                ("paneId", "pane_id"),
                ("workspaceId", "workspace_id"),
                ("tabId", "tab_id"),
            ],
        );
        value.insert(
            "workspace".into(),
            workspaces
                .get(&pane["workspace_id"])
                .cloned()
                .unwrap_or(json!("Workspace")),
        );
        value.insert(
            "name".into(),
            first(
                &[
                    &pane["label"],
                    &pane["title"],
                    &pane["terminal_title_stripped"],
                    &tab["label"],
                ],
                json!("Terminal"),
            ),
        );
        value.insert("kind".into(), json!("Terminal"));
        value.insert("status".into(), json!("idle"));
        value.insert("sequence".into(), first(&[&pane["revision"]], json!(0)));
        value.insert(
            "cwd".into(),
            first(&[&pane["foreground_cwd"], &pane["cwd"]], json!("")),
        );
        terminals.push(Value::Object(value));
    }
    for agent in &agents {
        if !terminals
            .iter()
            .any(|t| t["terminalId"] == agent["terminalId"])
        {
            terminals.push(agent.clone());
        }
    }
    let mut spaces = Vec::new();
    for workspace in array(snapshot, "workspaces") {
        let members: Vec<_> = terminals
            .iter()
            .filter(|t| t.get("workspaceId") == workspace.get("workspace_id"))
            .collect();
        let focused = panes.iter().find(|p| {
            p.get("workspace_id") == workspace.get("workspace_id")
                && p.get("tab_id") == workspace.get("active_tab_id")
                && truthy(&p["focused"])
        });
        let selected = focused
            .and_then(|p| p.get("terminal_id"))
            .filter(|v| truthy(v))
            .or_else(|| {
                members
                    .iter()
                    .find(|t| t.get("tabId") == workspace.get("active_tab_id"))
                    .and_then(|t| t.get("terminalId"))
                    .filter(|v| truthy(v))
            })
            .or_else(|| members.first().and_then(|t| t.get("terminalId")));
        let cwd = selected
            .and_then(|id| members.iter().find(|t| t.get("terminalId") == Some(id)))
            .map(|t| &t["cwd"])
            .filter(|v| truthy(v));
        let mut space = json!({"id":workspace["workspace_id"],"name":workspaces[&workspace["workspace_id"]],"terminalIds":members.iter().map(|t| &t["terminalId"]).collect::<Vec<_>>(),"cwd":first(&[cwd.unwrap_or(&Value::Null), &workspace["worktree"]["checkout_path"]], json!(""))});
        if let Some(id) = selected {
            space["selectedTerminalId"] = id.clone();
        }
        if let Some(linked) = workspace["worktree"].get("is_linked_worktree") {
            space["linkedWorktree"] = linked.clone();
        }
        spaces.push(space);
    }
    let mut result = json!({"agents":agents,"terminals":terminals,"spaces":spaces});
    if let Some(directory) = snapshot.get("worktree_directory") {
        result["worktreeDirectory"] = directory.clone();
    }
    for field in ["version", "protocol"] {
        if let Some(value) = snapshot.get(field) {
            result[field] = value.clone();
        }
    }
    Ok(result)
}

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

pub async fn metadata(
    target: Target,
    send: tokio::sync::mpsc::Sender<Value>,
    cancel: CancellationToken,
) {
    let mut previous = None;
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let work = async {
            let snapshot = target.snapshot().await?;
            if previous.as_ref() != Some(&snapshot) {
                send.send(json!({"type":"snapshot","snapshot":snapshot}))
                    .await
                    .map_err(|_| "Viewer closed".to_owned())?;
                previous = Some(snapshot.clone());
            }
            let stream = target.open().await?;
            let mut stream = BufReader::new(stream);
            let mut subscriptions: Vec<Value> = [
                "pane.agent_detected",
                "pane.updated",
                "pane.created",
                "pane.closed",
                "pane.moved",
                "tab.created",
                "tab.closed",
                "tab.renamed",
                "workspace.created",
                "workspace.closed",
                "workspace.renamed",
                "workspace.moved",
                "workspace.reordered",
            ]
            .iter()
            .map(|kind| json!({"type":kind}))
            .collect();
            subscriptions.extend(
                array(&snapshot, "agents")
                    .iter()
                    .map(|a| json!({"type":"pane.agent_status_changed","pane_id":a["paneId"]})),
            );
            stream.get_mut().write_all(format!("{}\n",json!({"id":"events","method":"events.subscribe","params":{"subscriptions":subscriptions}})).as_bytes()).await.map_err(|e| e.to_string())?;
            let mut pane_key = pane_key(&snapshot);
            let mut lines = Lines::default();
            loop {
                let reply = tokio::select! { _=cancel.cancelled()=>return Ok(()), reply=lines.read(&mut stream)=>reply?, _=tokio::time::sleep(Duration::from_secs(10))=>Some(json!({})) };
                let reply = reply.ok_or("Herdr disconnected before responding.")?;
                if truthy(&reply["error"]) {
                    return Err(reply["error"]["message"]
                        .as_str()
                        .unwrap_or("Herdr rejected status subscriptions.")
                        .into());
                }
                let delay = tokio::time::sleep(Duration::from_millis(40));
                tokio::pin!(delay);
                loop {
                    let reply = tokio::select! { biased; _=cancel.cancelled()=>return Ok(()), _=&mut delay=>break, reply=lines.read(&mut stream)=>reply? };
                    let reply = reply.ok_or("Herdr disconnected before responding.")?;
                    if truthy(&reply["error"]) {
                        return Err(reply["error"]["message"]
                            .as_str()
                            .unwrap_or("Herdr rejected status subscriptions.")
                            .into());
                    }
                }
                let snapshot = target.snapshot().await?;
                let changed = pane_key != self::pane_key(&snapshot);
                pane_key = self::pane_key(&snapshot);
                if previous.as_ref() != Some(&snapshot) {
                    send.send(json!({"type":"snapshot","snapshot":snapshot}))
                        .await
                        .map_err(|_| "Viewer closed".to_owned())?;
                    previous = Some(snapshot);
                }
                if changed {
                    break;
                }
            }
            Ok::<_, String>(())
        };
        let result = tokio::select! { biased; _=cancel.cancelled()=>break, result=work=>result };
        if let Err(message) = result {
            if send
                .send(json!({"type":"error","message":message}))
                .await
                .is_err()
            {
                break;
            }
            tokio::select! { biased; _=cancel.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(2))=>{} }
        }
    }
}
fn pane_key(snapshot: &Value) -> Vec<String> {
    let mut result: Vec<_> = array(snapshot, "agents")
        .iter()
        .filter_map(|a| a["paneId"].as_str().map(str::to_owned))
        .collect();
    result.sort();
    result
}
