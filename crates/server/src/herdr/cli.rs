//! The Herdr CLI backend, which speaks Herdr's JSON socket protocol.
use super::*;
use crate::herdr::action::Action;

pub(super) async fn validate_terminal(target: &Target, terminal: &Terminal) -> Result<(), String> {
    let response = target
        .request("pane.get", json!({"pane_id":terminal.pane_id}))
        .await?;
    if response["pane"]["terminal_id"] != terminal.terminal_id {
        return Err("This agent ended or moved. Reopen its tab. No input was sent.".into());
    }
    Ok(())
}

pub(super) async fn input_state(
    target: &Target,
    pane: &str,
) -> Result<(Option<ShellInput>, String), String> {
    let response = target
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
        if !process["name"].as_str().is_some_and(is_shell) {
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

pub(super) async fn snapshot(target: &Target) -> Result<Arc<Snapshot>, String> {
    target.shared.resource(target)?.snapshot(target).await
}

pub(super) async fn options(target: &Target) -> Result<Value, String> {
    static KIND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{0,63}$").unwrap());
    let response = target.request("server.agent_manifests", json!({})).await?;
    let mut kinds = Vec::<String>::new();
    for manifest in array(&response, "manifests") {
        if let Some(kind) = manifest["agent"].as_str().filter(|s| KIND.is_match(s))
            && !kinds.iter().any(|s| s == kind)
        {
            kinds.push(kind.into());
        }
    }
    Ok(json!({"kinds":kinds,"actions":crate::herdr::action::NAMES}))
}

pub(super) async fn ensure(target: &Target, cwd: &str) -> Result<(), String> {
    if target.request("session.snapshot", json!({})).await.is_ok() {
        return Ok(());
    }
    if let Some(remote) = &target.remote {
        let args = if target.session.is_empty() {
            vec![target.binary.as_str(), "server"]
        } else {
            vec![
                target.binary.as_str(),
                "--session",
                &target.session,
                "server",
            ]
        };
        let command = format!(
            "cd {} && nohup env {} {} </dev/null >/dev/null 2>&1 &",
            shell_quote(cwd),
            target.assignments(false)?,
            args.into_iter()
                .map(shell_quote)
                .collect::<Vec<_>>()
                .join(" ")
        );
        remote.exec(&command, &CancellationToken::new()).await?;
    } else {
        let mut command = tokio::process::Command::new(&target.binary);
        if !target.session.is_empty() {
            command.args(["--session", &target.session]);
        }
        command
            .arg("server")
            .current_dir(cwd)
            .env_clear()
            .envs(&target.env)
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
        if target.request("session.snapshot", json!({})).await.is_ok() {
            return Ok(());
        }
    }
    Err("Herdr did not start. Run herdr server on this machine and try again.".into())
}

pub(super) async fn preview(target: &Target, agent: &Terminal) -> String {
    let work = async {
            let current = target.request("pane.get", json!({"pane_id":agent.pane_id})).await?;
            if current["pane"]["terminal_id"] != agent.terminal_id { return Ok::<_, String>(String::new()); }
            let response = target.request("pane.read", json!({"pane_id":agent.pane_id,"source":"recent_unwrapped","format":"ansi","lines":40,"strip_ansi":false})).await?;
            Ok(response["read"]["text"].as_str().map(response_preview).unwrap_or_default())
        }.await;
    work.unwrap_or_default()
}
pub(super) async fn action(target: &Target, input: Action) -> Result<Value, String> {
    // Directory choices and checkout confirmations must reflect current metadata.
    let resource = target.shared.resource(target)?;
    let snapshot = if matches!(
        &input,
        Action::DeleteWorktree { .. }
            | Action::ListWorktrees { .. }
            | Action::NewWorktree { .. }
            | Action::OpenWorktree { .. }
            | Action::CreateSpace { .. }
            | Action::Create { .. }
    ) {
        resource.refresh_snapshot(target).await?
    } else {
        resource.snapshot(target).await?
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
                .ok_or("Herdr did not provide the checkout folder. Update Herdr on this host.")?;
            if path.as_deref() != Some(checkout) {
                return Err(
                    "The checkout folder changed. Reopen the confirmation before deleting.".into(),
                );
            }
            space_request(
                target,
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
            let mut listing = space_request(target, "worktree.list", params.clone()).await?;
            if !listing["worktrees"].is_array() || !listing["source"]["repo_name"].is_string() {
                return Err("This Herdr server does not provide worktree discovery. Update Herdr on this host.".into());
            }
            let method = match action {
                Action::ListWorktrees { .. } => {
                    if let Some(root) = listing["source"]["repo_root"].as_str() {
                        listing["branches"] =
                            json!(branch_names(target, root).await.unwrap_or_default());
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
            let created = space_request(target, method, params).await?;
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
            target.validate_terminal(terminal).await?;
            let created = space_request(target, "pane.split", json!({"workspace_id":space.id,"target_pane_id":terminal.pane_id,"direction":direction,"focus":false})).await?;
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
            let created = target.request("workspace.create", params).await?;
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
            target.request("workspace.move_block", params).await
        }
        Action::Create {
            name: label,
            kind,
            cwd,
            ..
        } => {
            let label = name(&label)?;
            if !array(&target.options().await?, "kinds").contains(&json!(kind)) {
                return Err("Choose a supported agent type.".into());
            }
            let space = space.ok_or("Choose an existing space.")?;
            if cwd
                .as_ref()
                .is_some_and(|s| !crate::protocol::absolute_path(s))
            {
                return Err("Enter an absolute working directory.".into());
            }
            let mut params = json!({"workspace_id":space.id,"label":label,"focus":false});
            if let Some(cwd) = cwd {
                params["cwd"] = json!(cwd);
            }
            let created = target.request("tab.create", params).await?;
            let pane = &created["root_pane"];
            if !pane["pane_id"].is_string() || !pane["terminal_id"].is_string() {
                return Err(
                    "Herdr created a tab but did not return its terminal. Open it from spaces."
                        .into(),
                );
            }
            let work = async {
                    target.request("pane.rename", json!({"pane_id":pane["pane_id"],"label":label})).await?;
                    target.request("agent.start", json!({"pane_id":pane["pane_id"],"name":format!("agent-{}",storage::random_hex(10)),"kind":kind,"args":[]})).await?;
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
            target
                .request(
                    "workspace.rename",
                    json!({"workspace_id":space.id,"label":name(&label)?}),
                )
                .await
        }
        Action::CloseSpace { .. } => {
            let space = space.ok_or("This space has closed.")?;
            target
                .request(
                    "workspace.close",
                    json!({"workspace_id":space.id,"close_group":false}),
                )
                .await
        }
        action @ (Action::Rename { .. } | Action::Close { .. }) => {
            let id = match &action {
                Action::Rename { terminal_id, .. } | Action::Close { terminal_id } => terminal_id,
                _ => unreachable!(),
            };
            let agent = terminals
                .iter()
                .find(|t| t.terminal_id == *id)
                .ok_or("This agent has ended.")?;
            target.validate_terminal(agent).await?;
            match action {
                Action::Rename { name: label, .. } => {
                    target
                        .request(
                            "pane.rename",
                            json!({"pane_id":agent.pane_id,"label":name(&label)?}),
                        )
                        .await
                }
                _ => {
                    target
                        .request("pane.close", json!({"pane_id":agent.pane_id}))
                        .await
                }
            }
        }
    }
}

pub(super) async fn branch_names(target: &Target, root: &str) -> Result<Vec<String>, String> {
    let args: Vec<String> = vec![
        "-C".into(),
        root.into(),
        "for-each-ref".into(),
        "--sort=refname".into(),
        "--format=%(refname:strip=2)".into(),
        "refs/heads/".into(),
    ];
    let cancel = CancellationToken::new();
    let output = if let Some(remote) = &target.remote {
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
            env: target.env.clone(),
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

pub(super) async fn space_request(
    target: &Target,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    target.request(method, params).await.map_err(|error| {
        if [
            "unknown method",
            "unknown action",
            "method not found",
            "unsupported",
        ]
        .iter()
        .any(|reason| error.to_lowercase().contains(reason))
        {
            format!(
                "This Herdr server does not support {method}. Update Herdr on this host. ({error})"
            )
        } else {
            error
        }
    })
}

pub(super) async fn metadata(
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

fn array<'a>(object: &'a Value, field: &str) -> &'a [Value] {
    object[field].as_array().map(Vec::as_slice).unwrap_or(&[])
}
