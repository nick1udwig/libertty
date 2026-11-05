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
                let label = pane["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .or_else(|| {
                        document
                            .node(&place.tab)
                            .and_then(|tab| tab["name"].as_str())
                            .filter(|name| !name.is_empty())
                    });
                let name = label
                    .or_else(|| {
                        record
                            .status
                            .as_ref()
                            .map(|s| s.title.as_str())
                            .filter(|s| !s.is_empty())
                    })
                    .or_else(|| (!record.title.is_empty()).then_some(record.title.as_str()))
                    .or(record.name.as_deref().filter(|name| !name.is_empty()))
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
                    label: label.map(str::to_owned),
                    kind: if agent {
                        model::program_label(record).unwrap_or("Agent").into()
                    } else {
                        record
                            .foreground
                            .as_ref()
                            .map(|f| f.name.as_str())
                            .filter(|name| !name.is_empty())
                            .or_else(|| model::program_label(record))
                            .unwrap_or("Terminal")
                            .into()
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
    checkout: String,
}
pub(super) type Repositories = BTreeMap<(String, String), (std::time::Instant, Option<Repository>)>;

pub(super) fn repositories(
    session: &Session,
    snapshot: &mut Snapshot,
    cache: &Repositories,
) -> Vec<(String, String)> {
    let mut requests = std::collections::BTreeSet::new();
    for space in &mut snapshot.spaces {
        let Ok((machine, id)) = split(&space.id) else {
            continue;
        };
        let cwd = space
            .terminal_ids
            .iter()
            .find_map(|id| {
                snapshot
                    .terminals
                    .iter()
                    .find(|t| &t.terminal_id == id)
                    .map(|t| t.cwd.as_str())
                    .filter(|cwd| !cwd.is_empty())
            })
            .unwrap_or(&space.cwd);
        let named = session
            .document_ref(&machine)
            .ok()
            .and_then(|d| d.node(&id))
            .and_then(|space| space["name"].as_str())
            .is_some_and(|name| !name.is_empty());
        if !named {
            space.name = model::folder_name(cwd, "");
        }
        let cache_key = (machine.clone(), cwd.to_owned());
        let now = std::time::Instant::now();
        if !cache
            .get(&cache_key)
            .is_some_and(|(checked, _)| now.duration_since(*checked) < Duration::from_secs(5))
        {
            requests.insert(cache_key.clone());
        }
        if let Some(repo) = cache.get(&cache_key).and_then(|(_, value)| value.as_ref()) {
            if !named {
                space.name = repo.checkout.clone();
            }
            space.repo_key = Some(key(&machine, &repo.root));
            space.repo_name = Some(repo.name.clone());
            space.checkout_path = Some(repo.path.clone());
            space.linked_worktree = Some(repo.linked);
        }
    }
    requests.into_iter().collect()
}

pub(super) async fn refresh_repositories(
    client: Client,
    mut cache: Repositories,
    requests: Vec<(String, String)>,
) -> Repositories {
    let mut listings = BTreeMap::new();
    for (machine, cwd) in requests {
        let git = Git {
            client: client.clone(),
            machine: machine.clone(),
            deadline: DEADLINE,
        };
        let found = async {
            let path = git.toplevel(&cwd).await.ok()?;
            let list_key = (machine.clone(), path.clone());
            if !listings.contains_key(&list_key) {
                let checkouts = Arc::new(git.list(&path).await.ok()?);
                for checkout in checkouts.iter() {
                    listings.insert((machine.clone(), checkout.path.clone()), checkouts.clone());
                }
            }
            let checkouts = listings.get(&list_key)?;
            let root = checkouts.first()?.path.clone();
            let entry = checkouts.iter().find(|c| c.path == path)?;
            let checkout = entry.branch.clone().unwrap_or_else(|| {
                if entry.head.is_empty() {
                    model::folder_name(&path, "")
                } else {
                    format!("detached {}", &entry.head[..entry.head.len().min(7)])
                }
            });
            Some(Repository {
                checkout,
                linked: path != root,
                name: model::folder_name(&root, ""),
                root,
                path,
            })
        }
        .await;
        if cache.len() >= 256
            && !cache.contains_key(&(machine.clone(), cwd.clone()))
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (checked, _))| checked)
                .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
        cache.insert((machine, cwd), (std::time::Instant::now(), found));
    }
    cache
}
