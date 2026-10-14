//! Herdr's snapshot boundary and the browser-facing normalized representation.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Default, Deserialize)]
struct Pane {
    terminal_id: Option<String>,
    pane_id: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<String>,
    label: Option<String>,
    title: Option<String>,
    name: Option<String>,
    terminal_title_stripped: Option<String>,
    display_agent: Option<String>,
    agent: Option<String>,
    agent_status: Option<String>,
    #[serde(default)]
    state_change_seq: Value,
    #[serde(default)]
    completion_seq: Value,
    #[serde(default)]
    revision: Value,
    foreground_cwd: Option<String>,
    cwd: Option<String>,
    #[serde(default)]
    focused: bool,
}
#[derive(Deserialize)]
struct Workspace {
    workspace_id: String,
    label: Option<String>,
    #[serde(default)]
    number: Value,
    active_tab_id: Option<String>,
    worktree: Option<Worktree>,
}
#[derive(Deserialize)]
struct Worktree {
    is_linked_worktree: Option<bool>,
    checkout_path: Option<String>,
}
#[derive(Deserialize)]
struct Snapshot {
    agents: Vec<Pane>,
    tabs: Vec<Pane>,
    workspaces: Vec<Workspace>,
    #[serde(default)]
    panes: Vec<Pane>,
    worktree_directory: Option<String>,
    version: Option<Value>,
    protocol: Option<Value>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Terminal {
    terminal_id: String,
    pane_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<String>,
    workspace: String,
    name: String,
    kind: String,
    status: String,
    sequence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    completion: Option<f64>,
    cwd: String,
}
fn first<'a>(values: impl IntoIterator<Item = Option<&'a str>>, fallback: &'a str) -> String {
    values
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .unwrap_or(fallback)
        .into()
}
fn terminal(
    source: &Pane,
    pane: &Pane,
    tab: &Pane,
    names: &HashMap<&str, String>,
    agent: bool,
) -> Option<Terminal> {
    let workspace = source
        .workspace_id
        .as_deref()
        .and_then(|id| names.get(id))
        .cloned()
        .unwrap_or_else(|| "Workspace".into());
    Some(Terminal {
        terminal_id: source.terminal_id.clone()?,
        pane_id: source.pane_id.clone()?,
        workspace_id: source.workspace_id.clone(),
        tab_id: source.tab_id.clone(),
        workspace,
        name: first(
            [
                pane.label.as_deref(),
                source.title.as_deref(),
                pane.title.as_deref(),
                source.name.as_deref(),
                source.terminal_title_stripped.as_deref(),
                pane.terminal_title_stripped.as_deref(),
                tab.label.as_deref(),
                source.display_agent.as_deref(),
                source.agent.as_deref(),
            ],
            if agent { "Agent" } else { "Terminal" },
        ),
        kind: if agent {
            first(
                [source.display_agent.as_deref(), source.agent.as_deref()],
                "Terminal",
            )
        } else {
            "Terminal".into()
        },
        status: if agent {
            source
                .agent_status
                .as_deref()
                .filter(|s| matches!(*s, "idle" | "working" | "blocked" | "done"))
                .unwrap_or("unknown")
        } else {
            "idle"
        }
        .into(),
        sequence: crate::protocol::integer(&source.state_change_seq)
            .filter(|_| agent)
            .or_else(|| crate::protocol::integer(&source.revision))
            .unwrap_or(0.0),
        completion: crate::protocol::integer(&source.completion_seq).filter(|_| agent),
        cwd: first(
            [source.foreground_cwd.as_deref(), source.cwd.as_deref()],
            "",
        ),
    })
}
pub fn normalize(raw: &Value) -> Result<Value, String> {
    let snapshot: Snapshot = serde_json::from_value(raw["snapshot"].clone())
        .map_err(|_| "This Herdr server does not provide a session snapshot.")?;
    let names: HashMap<_, _> = snapshot
        .workspaces
        .iter()
        .map(|w| {
            let number = if w.number.is_null() || w.number == 0 {
                String::new()
            } else {
                w.number
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| w.number.to_string())
            };
            (
                w.workspace_id.as_str(),
                first([w.label.as_deref()], &format!("Workspace {number}")),
            )
        })
        .collect();
    let tabs: HashMap<_, _> = snapshot
        .tabs
        .iter()
        .filter_map(|t| Some((t.tab_id.as_deref()?, t)))
        .collect();
    // Preserve first-seen order while using the last record for duplicate pane IDs.
    let mut order = Vec::new();
    let mut panes = HashMap::new();
    for pane in &snapshot.panes {
        if let Some(id) = pane.pane_id.as_deref() {
            if panes.insert(id, pane).is_none() {
                order.push(id);
            }
        }
    }
    let empty = Pane::default();
    let agents: Vec<_> = snapshot
        .agents
        .iter()
        .filter_map(|agent| {
            terminal(
                agent,
                agent
                    .pane_id
                    .as_deref()
                    .and_then(|id| panes.get(id))
                    .copied()
                    .unwrap_or(&empty),
                agent
                    .tab_id
                    .as_deref()
                    .and_then(|id| tabs.get(id))
                    .copied()
                    .unwrap_or(&empty),
                &names,
                true,
            )
        })
        .take(256)
        .collect();
    let by_terminal: HashMap<_, _> = agents
        .iter()
        .map(|agent| (agent.terminal_id.as_str(), agent))
        .collect();
    let mut terminals: Vec<_> = order
        .iter()
        .filter_map(|id| {
            let pane = panes[id];
            if let Some(agent) = pane
                .terminal_id
                .as_deref()
                .and_then(|id| by_terminal.get(id))
            {
                return Some((*agent).clone());
            }
            terminal(
                pane,
                pane,
                pane.tab_id
                    .as_deref()
                    .and_then(|id| tabs.get(id))
                    .copied()
                    .unwrap_or(&empty),
                &names,
                false,
            )
        })
        .take(256)
        .collect();
    let mut included: HashSet<_> = terminals.iter().map(|t| t.terminal_id.clone()).collect();
    for agent in &agents {
        if included.insert(agent.terminal_id.clone()) {
            terminals.push(agent.clone());
        }
    }
    let mut members: HashMap<&str, Vec<&Terminal>> = HashMap::new();
    for terminal in &terminals {
        if let Some(id) = terminal.workspace_id.as_deref() {
            members.entry(id).or_default().push(terminal);
        }
    }
    let spaces: Vec<_> = snapshot.workspaces.iter().map(|workspace| {
        let members = members.get(workspace.workspace_id.as_str()).map(Vec::as_slice).unwrap_or_default();
        let focused = order.iter().map(|id| panes[id]).find(|p| p.workspace_id.as_deref() == Some(&workspace.workspace_id) && p.tab_id == workspace.active_tab_id && p.focused);
        let selected = focused.and_then(|p| p.terminal_id.as_deref()).filter(|s| !s.is_empty())
            .or_else(|| members.iter().find(|t| t.tab_id == workspace.active_tab_id).map(|t| t.terminal_id.as_str()))
            .or_else(|| members.first().map(|t| t.terminal_id.as_str()));
        let cwd = selected.and_then(|id| members.iter().find(|t| t.terminal_id == id)).map(|t| t.cwd.as_str());
        let mut space = serde_json::json!({"id":workspace.workspace_id,"name":names[workspace.workspace_id.as_str()],"terminalIds":members.iter().map(|t| &t.terminal_id).collect::<Vec<_>>(),"cwd":first([cwd,workspace.worktree.as_ref().and_then(|w| w.checkout_path.as_deref())], "")});
        if let Some(id) = selected { space["selectedTerminalId"] = id.into(); }
        if let Some(worktree) = &workspace.worktree {
            if let Some(linked) = worktree.is_linked_worktree { space["linkedWorktree"] = linked.into(); }
            if let Some(path) = &worktree.checkout_path { space["checkoutPath"] = path.clone().into(); }
        }
        space
    }).collect();
    let mut result = serde_json::json!({"agents":agents,"terminals":terminals,"spaces":spaces});
    if let Some(directory) = snapshot.worktree_directory {
        result["worktreeDirectory"] = directory.into();
    }
    if let Some(version) = snapshot.version {
        result["version"] = version;
    }
    if let Some(protocol) = snapshot.protocol {
        result["protocol"] = protocol;
    }
    Ok(result)
}
