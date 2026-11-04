use super::*;
use crate::herdr::action::{Action, Direction};
use herdr_client_lib::{
    commands::{Creation, Launch, Placement},
    document::{Axis, Document},
    sync::WriteOutcome,
    worktrees::{CreatePlan, Git},
};
use serde_json::{Value, json};

pub(super) fn written(outcome: WriteOutcome) -> Result<(), String> {
    match outcome {
        WriteOutcome::Written => Ok(()),
        WriteOutcome::Conflict => {
            Err("The workspace changed on another client; refresh before trying again.".into())
        }
        WriteOutcome::Unavailable(message) => Err(message),
    }
}
async fn close(session: &mut Session, machine: &str, id: &str) -> Result<(), String> {
    let assessment = session.assess_close(machine, id).await.map_err(error)?;
    let result = session.close(assessment).await.map_err(error)?;
    if matches!(result.layout, WriteOutcome::Conflict) && !result.observed.is_empty() {
        session.refresh(machine).await;
        if !session.document_ref(machine).map_err(error)?.contains(id) {
            return Ok(());
        }
    }
    written(result.layout)
}
fn new_id() -> String {
    crate::storage::random_hex(16)
}
fn placement(name: String) -> Placement {
    Placement::Space {
        id: new_id(),
        name,
        tab: new_id(),
        pane: new_id(),
    }
}
fn launch(cwd: Option<String>) -> Launch {
    Launch {
        argv: vec![],
        line: None,
        cwd,
        env: BTreeMap::new(),
    }
}
async fn created(
    session: &Session,
    machine: &str,
    space: &str,
    creation: Creation,
) -> Result<Value, String> {
    if let Err(message) = written(creation.layout) {
        return Err(format!(
            "{message} Creation {} may have started a terminal; refresh before creating another.",
            creation.correlation
        ));
    }
    let record = creation
        .terminal
        .ok_or("Core did not return the created terminal.")?;
    let core = if machine.is_empty() {
        session.client.core_id().to_owned()
    } else {
        session
            .client
            .machine_list(DEADLINE)
            .await
            .map_err(error)?
            .machines
            .into_iter()
            .find(|entry| entry.name == machine)
            .map(|entry| entry.id)
            .ok_or("The remote terminal was created; refresh to locate it.")?
    };
    let local = record.address.rsplit('/').next().unwrap_or(&record.address);
    Ok(
        json!({"workspaceId":projection::key(machine, space), "terminalId":json!([core, local, record.identity]).to_string()}),
    )
}
async fn kinds(client: &Client) -> Result<Vec<String>, String> {
    let mut kinds = vec!["shell".into()];
    if client.supports("templates.list") {
        let reply = client
            .call("templates.list", json!({}), DEADLINE)
            .await
            .map_err(error)?;
        kinds.extend(
            reply["templates"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|t| t["error"].is_null())
                .filter_map(|t| t["name"].as_str().map(str::to_owned)),
        );
    }
    Ok(kinds)
}
pub async fn options(target: &Target) -> Result<Value, String> {
    Ok(
        json!({"kinds":kinds(&hub::live(target).await?.client).await?,"actions":crate::herdr::action::NAMES}),
    )
}
pub async fn action(target: &Target, action: Action) -> Result<Value, String> {
    let mut session = session(target).await?;
    let snapshot = projection::project(&session)?;
    let workspace = action.workspace().map(projection::split).transpose()?;
    let (machine, space_id) = workspace.clone().unwrap_or_default();
    let document = session.document(&machine).map_err(error)?;
    let space = if workspace.is_some() {
        Some(
            document
                .node(&space_id)
                .filter(|n| n["tabs"].is_array())
                .ok_or("This space has closed.")?,
        )
    } else {
        None
    };
    let cwd = space
        .and_then(|s| s["folder"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    match action {
        Action::RenameSpace { name, .. } => {
            written(
                session
                    .edit(&machine, |d| {
                        d.rename(
                            &space_id,
                            &crate::herdr::name(&name)
                                .map_err(herdr_client_lib::document::Error::Malformed)?,
                        )
                    })
                    .await
                    .map_err(error)?,
            )?;
        }
        Action::MoveSpace {
            before_workspace_id,
            ..
        } => {
            let before = before_workspace_id
                .map(|id| projection::split(&id))
                .transpose()?;
            if before
                .as_ref()
                .is_some_and(|(m, id)| *m != machine || *id == space_id)
            {
                return Err("Choose another space on the same machine.".into());
            }
            let mut value = document.value().clone();
            let spaces = value["spaces"].as_array_mut().ok_or("Invalid spaces.")?;
            let from = spaces
                .iter()
                .position(|s| s["id"] == space_id)
                .ok_or("This space has closed.")?;
            let moved = spaces.remove(from);
            let at = match before {
                Some((_, id)) => spaces
                    .iter()
                    .position(|s| s["id"] == id)
                    .ok_or("The destination space has closed.")?,
                None => spaces.len(),
            };
            spaces.insert(at, moved);
            written(
                session
                    .write(&machine, Document::decode(value).map_err(error)?)
                    .await,
            )?;
        }
        Action::CloseSpace { .. } => {
            close(&mut session, &machine, &space_id).await?;
        }
        action @ (Action::Rename { .. } | Action::Close { .. }) => {
            let id = match &action {
                Action::Rename { terminal_id, .. } | Action::Close { terminal_id } => terminal_id,
                _ => unreachable!(),
            };
            let terminal = snapshot.terminal(id).ok_or("This terminal has ended.")?;
            let (machine, pane) = projection::split(&terminal.pane_id)?;
            match action {
                Action::Rename { name, .. } => {
                    let name = crate::herdr::name(&name)?;
                    written(
                        session
                            .edit(&machine, |d| d.rename(&pane, &name))
                            .await
                            .map_err(error)?,
                    )?;
                }
                _ => {
                    close(&mut session, &machine, &pane).await?;
                }
            }
        }
        Action::CreateSpace { terminal_id, .. } => {
            let cwd = terminal_id
                .as_ref()
                .and_then(|id| snapshot.terminal(id))
                .filter(|t| {
                    t.workspace_id == workspace.as_ref().map(|(m, s)| projection::key(m, s))
                })
                .map(|t| t.cwd.clone())
                .filter(|c| !c.is_empty())
                .or(cwd);
            let placement = placement(String::new());
            let Placement::Space { id, .. } = &placement else {
                unreachable!()
            };
            let id = id.clone();
            let creation = session
                .create(
                    &machine,
                    placement,
                    launch(cwd.or_else(|| {
                        target
                            .env
                            .get("LIBERTTY_CWD")
                            .or_else(|| target.env.get("PWD"))
                            .cloned()
                    })),
                    new_id(),
                )
                .await
                .map_err(error)?;
            return created(&session, &machine, &id, creation).await;
        }
        Action::Split {
            terminal_id,
            direction,
            ..
        } => {
            let terminal = snapshot
                .terminal(&terminal_id)
                .filter(|t| {
                    t.workspace_id.as_deref() == Some(projection::key(&machine, &space_id).as_str())
                })
                .ok_or("Choose a terminal in this space.")?;
            let (_, pane) = projection::split(&terminal.pane_id)?;
            let (_, tab) = projection::split(terminal.tab_id.as_deref().ok_or("Missing tab.")?)?;
            let placement = Placement::Split {
                space: space_id.clone(),
                tab,
                target: pane,
                container: new_id(),
                pane: new_id(),
                axis: match direction {
                    Direction::Right => Axis::Row,
                    Direction::Down => Axis::Column,
                },
            };
            let cwd = Some(terminal.cwd.clone()).filter(|s| !s.is_empty()).or(cwd);
            let creation = session
                .create(
                    &machine,
                    placement,
                    launch(cwd.or_else(|| {
                        target
                            .env
                            .get("LIBERTTY_CWD")
                            .or_else(|| target.env.get("PWD"))
                            .cloned()
                    })),
                    new_id(),
                )
                .await
                .map_err(error)?;
            return created(&session, &machine, &space_id, creation).await;
        }
        Action::Create {
            name,
            kind,
            cwd: requested,
            ..
        } => {
            let name = crate::herdr::name(&name)?;
            if !kinds(&session.client).await?.contains(&kind) {
                return Err("Choose a supported agent type.".into());
            }
            if requested
                .as_ref()
                .is_some_and(|s| !crate::protocol::absolute_path(s))
            {
                return Err("Enter an absolute working directory.".into());
            }
            let mut launch = launch(requested.or(cwd));
            if kind != "shell" {
                launch.argv.push(kind);
            }
            let placement = Placement::Tab {
                space: space_id.clone(),
                after: None,
                id: new_id(),
                name,
                pane: new_id(),
            };
            let creation = session
                .create(&machine, placement, launch, new_id())
                .await
                .map_err(error)?;
            return created(&session, &machine, &space_id, creation).await;
        }
        action => {
            let git = Git {
                client: session.client.clone(),
                machine: machine.clone(),
                deadline: DEADLINE,
            };
            let cwd = match &action {
                Action::ListWorktrees { terminal_id, .. }
                | Action::NewWorktree { terminal_id, .. }
                | Action::OpenWorktree { terminal_id, .. } => {
                    let workspace_id = projection::key(&machine, &space_id);
                    let terminal = match terminal_id {
                        Some(id) => snapshot.terminal(id),
                        None => snapshot.terminals.iter().find(|terminal| {
                            terminal.workspace_id.as_deref() == Some(workspace_id.as_str())
                        }),
                    }
                    .filter(|terminal| {
                        terminal.workspace_id.as_deref() == Some(workspace_id.as_str())
                    })
                    .ok_or("Choose a live terminal in this space.")?;
                    let record = projection::record(&session, &terminal.terminal_id)?;
                    let record = session
                        .client
                        .terminal_get(&record.address, DEADLINE)
                        .await
                        .map_err(error)?;
                    if !record.is_live() {
                        return Err("This terminal has ended.".into());
                    }
                    record
                        .folder()
                        .ok_or("This terminal has no working directory.")?
                        .to_owned()
                }
                _ => cwd.ok_or("This space has no working directory.")?,
            };
            let checkouts = git.list(&cwd).await.map_err(error)?;
            let root = &checkouts.first().ok_or("No repository found.")?.path;
            match action {
                Action::ListWorktrees { .. } => {
                    let worktrees: Vec<_> = checkouts.iter().map(|checkout| {
                        let open = document.value()["spaces"].as_array().into_iter().flatten().find(|s| s["folder"] == checkout.path).and_then(|s| s["id"].as_str()).map(|id| projection::key(&machine, id));
                        json!({"path":checkout.path,"branch":checkout.branch,"label":checkout.branch.as_deref().unwrap_or(&checkout.path),"is_bare":checkout.bare,"is_prunable":checkout.prunable,"open_workspace_id":open})
                    }).collect();
                    return Ok(
                        json!({"source":{"repo_name":herdr_client_lib::model::folder_name(root,""),"repo_root":root},"worktrees":worktrees,"branches":git.branches(root).await.map_err(error)?,"directory":git.worktree_root(None).await.map_err(error)?}),
                    );
                }
                Action::NewWorktree { branch, .. } => {
                    let branch = crate::herdr::name(&branch)?;
                    let path = git.default_path(root, &branch).await.map_err(error)?;
                    let placement = placement(branch.clone());
                    let Placement::Space { id, .. } = &placement else {
                        unreachable!()
                    };
                    let id = id.clone();
                    let new_branch = !git.branches(root).await.map_err(error)?.contains(&branch);
                    let result = git
                        .create_space(
                            &mut session,
                            CreatePlan {
                                repository: root.clone(),
                                path,
                                branch,
                                new_branch,
                                placement,
                                correlation: new_id(),
                            },
                        )
                        .await
                        .map_err(error)?;
                    if result.git.code != Some(0) {
                        return Err(String::from_utf8_lossy(&result.git.stderr).into());
                    }
                    return created(&session, &machine, &id, result.workspace.map_err(error)?)
                        .await;
                }
                Action::OpenWorktree { path, .. } => {
                    if !checkouts
                        .iter()
                        .any(|c| c.path == path && !c.bare && !c.prunable)
                    {
                        return Err("This checkout is unavailable.".into());
                    }
                    if let Some(id) = document.value()["spaces"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|s| s["folder"] == path)
                        .and_then(|s| s["id"].as_str())
                    {
                        return Ok(json!({"workspaceId":projection::key(&machine,id)}));
                    }
                    let placement = placement(String::new());
                    let Placement::Space { id, .. } = &placement else {
                        unreachable!()
                    };
                    let id = id.clone();
                    let result = git
                        .open(&mut session, &path, placement, new_id())
                        .await
                        .map_err(error)?;
                    return created(&session, &machine, &id, result).await;
                }
                Action::DeleteWorktree {
                    path: confirmed,
                    force,
                    ..
                } => {
                    let path = git.toplevel(&cwd).await.map_err(error)?;
                    if path == *root || confirmed.as_deref() != Some(&path) {
                        return Err("The linked checkout changed; reopen its confirmation.".into());
                    }
                    let removal = git.assess_remove(root, &path).await.map_err(error)?;
                    if !removal.allowed(force) {
                        return Err("Checkout has local changes or unreferenced commits; --force is required for an assessed removal.".into());
                    }
                    close(&mut session, &machine, &space_id).await?;
                    let output = git.remove(&removal, force).await.map_err(error)?;
                    if output.code != Some(0) {
                        return Err(String::from_utf8_lossy(&output.stderr).into());
                    }
                }
                _ => unreachable!(),
            }
        }
    }
    Ok(json!({"ok":true}))
}
