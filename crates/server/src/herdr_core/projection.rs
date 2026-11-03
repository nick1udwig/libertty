use super::*;
use crate::herdr::{Space, Status, Terminal};
use herdr_client_lib::{
    commands::{qualify, terminal_addresses},
    model, protocol,
    view::Identity,
    worktrees::Git,
};
use serde_json::{Value, json};

pub(super) fn key(machine: &str, id: &str) -> String {
    json!([machine, id]).to_string()
}
pub(super) fn split(key: &str) -> Result<(String, String), String> {
    serde_json::from_str(key).map_err(|_| "Invalid herdr-core identity.".into())
}
pub(super) fn terminal_key(identity: &Identity, record: &protocol::Terminal) -> String {
    json!([identity.core, identity.local, record.identity]).to_string()
}
pub(super) fn record<'a>(session: &'a Session, id: &str) -> Result<&'a protocol::Terminal, String> {
    session
        .terminals
        .iter()
        .find(|(identity, record)| terminal_key(identity, record) == id)
        .map(|(_, record)| record)
        .ok_or("This terminal has ended.".into())
}
pub(super) fn project(session: &Session) -> Result<Snapshot, String> {
    let mut snapshot = Snapshot {
        agents: vec![],
        terminals: vec![],
        spaces: vec![],
        worktree_directory: None,
        version: Some(json!(session.client.hello().version)),
        protocol: None,
    };
    let records: BTreeMap<_, _> = session
        .terminals
        .iter()
        .map(|(identity, record)| (record.address.as_str(), (identity, record)))
        .collect();
    for (machine, slot) in &session.documents {
        let Some(document) = &slot.document else {
            return Err(slot
                .error
                .clone()
                .unwrap_or_else(|| "Workspace document is unavailable.".into()));
        };
        let places = model::places(document, machine);
        for space in document.value()["spaces"].as_array().into_iter().flatten() {
            let id = space["id"].as_str().ok_or("Space identity is missing.")?;
            let name = model::space_name(space, |_| None, "");
            let mut terminal_ids = vec![];
            for address in terminal_addresses(space) {
                let address = qualify(&address, machine);
                let Some((identity, record)) = records.get(address.as_str()) else {
                    continue;
                };
                let Some(place) = places.get(&record.address).filter(|p| p.space == id) else {
                    continue;
                };
                if !record.is_live() {
                    continue;
                }
                let terminal_id = terminal_key(identity, record);
                terminal_ids.push(terminal_id.clone());
                let pane = document.node(&place.pane).unwrap_or(&Value::Null);
                let name = pane["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .or_else(|| {
                        document
                            .node(&place.tab)
                            .and_then(|tab| tab["name"].as_str())
                            .filter(|name| !name.is_empty())
                    })
                    .or(record.name.as_deref())
                    .or_else(|| {
                        record
                            .status
                            .as_ref()
                            .map(|s| s.title.as_str())
                            .filter(|s| !s.is_empty())
                    })
                    .or_else(|| model::program_label(record))
                    .unwrap_or("Terminal")
                    .to_owned();
                let agent = model::is_agent(record);
                let terminal = Terminal {
                    terminal_id,
                    pane_id: key(machine, &place.pane),
                    workspace_id: Some(key(machine, id)),
                    tab_id: Some(key(machine, &place.tab)),
                    workspace: model::space_name(space, |_| None, ""),
                    name,
                    kind: if agent {
                        model::program_label(record).unwrap_or("Agent").into()
                    } else {
                        "Terminal".into()
                    },
                    status: match record.word() {
                        Some("working") => Status::Working,
                        Some("blocked" | "error") => Status::Blocked,
                        Some("done") => Status::Done,
                        _ => Status::Idle,
                    },
                    sequence: record.status_ms.unwrap_or(0) as f64,
                    completion: agent.then_some(record.turn as f64),
                    cwd: record.folder().unwrap_or_default().into(),
                };
                if agent {
                    snapshot.agents.push(terminal.clone());
                }
                snapshot.terminals.push(terminal);
            }
            snapshot.spaces.push(Space {
                id: key(machine, id),
                name,
                selected_terminal_id: terminal_ids.first().cloned(),
                terminal_ids,
                cwd: space["folder"].as_str().unwrap_or_default().into(),
                linked_worktree: None,
                checkout_path: None,
                repo_key: None,
                repo_name: None,
            });
        }
    }
    Ok(snapshot)
}
#[derive(Clone)]
pub(super) struct Repository {
    root: String,
    path: String,
    linked: bool,
    name: String,
}
pub(super) async fn repositories(
    session: &Session,
    snapshot: &mut Snapshot,
    cache: &mut BTreeMap<(String, String), Option<Repository>>,
) {
    for space in &mut snapshot.spaces {
        let Ok((machine, _)) = split(&space.id) else {
            continue;
        };
        let cache_key = (machine.clone(), space.cwd.clone());
        if !cache.contains_key(&cache_key) {
            let git = Git {
                client: session.client.clone(),
                machine: machine.clone(),
                deadline: DEADLINE,
            };
            let found = async {
                let path = git.toplevel(&space.cwd).await.ok()?;
                let checkouts = git.list(&path).await.ok()?;
                let root = checkouts.first()?.path.clone();
                let name = model::folder_name(&root, "");
                Some(Repository {
                    linked: path != root,
                    root,
                    path,
                    name,
                })
            }
            .await;
            if cache.len() >= 256 {
                cache.clear();
            }
            cache.insert(cache_key.clone(), found);
        }
        if let Some(repo) = cache.get(&cache_key).and_then(Option::as_ref) {
            space.repo_key = Some(key(&machine, &repo.root));
            space.repo_name = Some(repo.name.clone());
            space.checkout_path = Some(repo.path.clone());
            space.linked_worktree = Some(repo.linked);
        }
    }
}
