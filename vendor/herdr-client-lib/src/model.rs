//! Workspace rules every client shares: naming, attention status, and agent navigation.
//!
//! Adapted from herdr-app `src/model.rs` at af2bd72c176df7b852df84a026c684dd6586f010
//! (Apache-2.0). The rules read the shared JSON document instead of the app's typed tree.
use crate::{
    commands::{SPACE_LABEL, qualify, terminal_addresses},
    document::Document,
    protocol::Terminal,
    view::{Attention, Identity},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// What a client shows for a terminal: working, blocked, done (finished, unseen), or idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Working,
    Done,
    Blocked,
}

impl Status {
    /// Herdr's seen rules: blocked and error need the person; an unseen finish is done.
    pub fn from_word(word: Option<&str>, seen: bool) -> Option<Self> {
        Some(match word? {
            "working" => Self::Working,
            "blocked" | "error" => Self::Blocked,
            _ if !seen => Self::Done,
            _ => Self::Idle,
        })
    }
    pub fn word(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Done => "done",
            Self::Blocked => "blocked",
        }
    }
}

/// Herdr's attention priority: blocked > done > working > idle > nothing.
pub fn priority(status: Option<Status>) -> u8 {
    match status {
        Some(Status::Blocked) => 4,
        Some(Status::Done) => 3,
        Some(Status::Working) => 2,
        Some(Status::Idle) => 1,
        None => 0,
    }
}

/// The most urgent status among some terminals.
pub fn rollup(statuses: impl IntoIterator<Item = Option<Status>>) -> Option<Status> {
    statuses
        .into_iter()
        .flatten()
        .max_by_key(|s| priority(Some(*s)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alert {
    /// Needs the person (blocked or error).
    Blocked,
    /// Finished while the person wasn't looking.
    Done,
}

/// Herdr's attention rule for a change of 7501 word: needing you always
/// alerts; finishing alerts only if the person wasn't looking.
pub fn alert(prev: Option<&str>, new: Option<&str>, looking: bool) -> Option<Alert> {
    let blocked = |w: Option<&str>| matches!(w, Some("blocked" | "error"));
    let busy = |w: Option<&str>| matches!(w, Some("working" | "blocked" | "error"));
    if blocked(new) && !blocked(prev) {
        Some(Alert::Blocked)
    } else if busy(prev) && new.is_some() && !busy(new) && !looking {
        Some(Alert::Done)
    } else {
        None
    }
}

/// A closed space, so opening it again doesn't ask for its name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recent {
    pub name: String,
    pub folder: String,
}

/// A folder as a name: its last part, `~` for the home folder (`/` and `\` both).
/// An empty `home` means the home folder is unknown.
pub fn folder_name(path: &str, home: &str) -> String {
    let full = path;
    let path = path.trim_end_matches(['/', '\\']);
    let home = home.trim_end_matches(['/', '\\']);
    let same = if home.is_empty() {
        false
    } else if cfg!(windows) {
        path.eq_ignore_ascii_case(home)
    } else {
        path == home
    };
    if full.is_empty() || same {
        return "~".into();
    }
    if path.is_empty() {
        return full[..1].to_owned();
    }
    path.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// What a space is called: its name, else its first terminal's checkout
/// (`checkout` maps a local address to its top folder), else its folder.
pub fn space_name(space: &Value, checkout: impl Fn(&str) -> Option<String>, home: &str) -> String {
    if let Some(name) = space["name"].as_str().filter(|s| !s.is_empty()) {
        return name.to_owned();
    }
    let folder = terminal_addresses(space)
        .first()
        .and_then(|address| checkout(address))
        .unwrap_or_else(|| space["folder"].as_str().unwrap_or_default().to_owned());
    folder_name(&folder, home)
}

/// What a tab is called: its name, else its place in its space (1, 2, ...).
pub fn tab_name(space: &Value, tab: &Value) -> String {
    if let Some(name) = tab["name"].as_str().filter(|s| !s.is_empty()) {
        return name.to_owned();
    }
    let index = space["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().position(|t| t["id"] == tab["id"]))
        .unwrap_or(0);
    (index + 1).to_string()
}

/// Where a terminal is shown: its space, tab, and pane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub space: String,
    pub tab: String,
    pub pane: String,
}

/// Every placed terminal on one machine, by connection-relative address.
pub fn places(document: &Document, machine: &str) -> BTreeMap<String, Place> {
    fn walk(
        node: &Value,
        space: &str,
        tab: &str,
        machine: &str,
        out: &mut BTreeMap<String, Place>,
    ) {
        if node["type"] == "block"
            && let (Some(address), Some(pane)) =
                (node["content"]["terminal"].as_str(), node["id"].as_str())
        {
            out.entry(qualify(address, machine)).or_insert(Place {
                space: space.into(),
                tab: tab.into(),
                pane: pane.into(),
            });
        }
        for float in node["floating"].as_array().into_iter().flatten() {
            if let (Some(address), Some(pane)) =
                (float["content"]["terminal"].as_str(), float["id"].as_str())
            {
                out.entry(qualify(address, machine)).or_insert(Place {
                    space: space.into(),
                    tab: tab.into(),
                    pane: pane.into(),
                });
            }
        }
        for child in node["children"].as_array().into_iter().flatten() {
            walk(child, space, tab, machine, out);
        }
    }
    let mut out = BTreeMap::new();
    for space in document.value()["spaces"].as_array().into_iter().flatten() {
        for tab in space["tabs"].as_array().into_iter().flatten() {
            if let (Some(s), Some(t)) = (space["id"].as_str(), tab["id"].as_str()) {
                walk(&tab["root"], s, t, machine, &mut out);
            }
        }
    }
    out
}

/// What a terminal's program calls itself: its reported app, name, or program.
pub fn program_label(record: &Terminal) -> Option<&str> {
    record
        .status
        .as_ref()
        .map(|s| s.app.as_str())
        .filter(|s| !s.is_empty())
        .or(record.name.as_deref())
        .or_else(|| {
            record
                .argv
                .first()
                .map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p))
        })
        .filter(|s| !s.is_empty())
}

/// Whether a terminal belongs in an agents list: it runs and reports status through OSC 7501.
pub fn is_agent(record: &Terminal) -> bool {
    record.state != "finished" && (record.reported || record.status.is_some())
}

/// One agent for navigation: its record, where it is shown, and what to call it.
#[derive(Clone, Debug)]
pub struct AgentEntry<'a> {
    pub identity: &'a Identity,
    pub terminal: &'a Terminal,
    /// None: a terminal without a pane.
    pub place: Option<&'a Place>,
    /// The space its labels name, when it has no pane.
    pub labeled_space: Option<&'a str>,
    pub status: Option<Status>,
    pub label: Option<&'a str>,
    pub title: Option<&'a str>,
    /// Bumped each time its status changes, for "most recent" ordering.
    pub seq: u64,
}

/// Every agent among `terminals`, in record order, with this viewer's attention status.
pub fn agents<'a>(
    terminals: &'a BTreeMap<Identity, Terminal>,
    places: &'a BTreeMap<String, Place>,
    attention: &Attention,
) -> Vec<AgentEntry<'a>> {
    terminals
        .iter()
        .filter(|(_, record)| is_agent(record))
        .map(|(identity, record)| AgentEntry {
            identity,
            terminal: record,
            place: places.get(&record.address),
            labeled_space: record.label(SPACE_LABEL),
            status: attention.status(identity, record.word()),
            label: program_label(record),
            title: record
                .status
                .as_ref()
                .map(|s| s.title.as_str())
                .filter(|s| !s.is_empty()),
            seq: attention.seq(identity),
        })
        .collect()
}
