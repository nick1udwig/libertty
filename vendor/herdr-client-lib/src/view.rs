//! Caller-owned view state; never stored in the shared app document.
//!
//! Focus memory, tab selection, settling, recent spaces, and seen rules follow
//! herdr-app `src/model.rs` and `src/mirror.rs` at af2bd72c176df7b852df84a026c684dd6586f010
//! (Apache-2.0).
use crate::{
    document::Document,
    model::{Alert, Recent, Status, alert},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Identity {
    pub core: String,
    pub local: String,
}
/// Panes a tab remembers beyond the focused one.
const BEFORE_LIMIT: usize = 32;
/// Closed spaces remembered for reopening.
const RECENT_LIMIT: usize = 20;
/// One tab's private choices.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TabView {
    pub focused: Option<String>,
    /// Panes focused before, most recent last: closing the focused pane goes back.
    pub before: Vec<String>,
    pub zoomed: Option<String>,
    /// Put away (ms since the epoch): out of the lists, still running.
    pub settled: Option<u64>,
}
impl TabView {
    /// Focuses a pane and remembers the one it leaves.
    fn focus(&mut self, pane: &str) {
        if let Some(old) = self.focused.take().filter(|o| o != pane) {
            self.before.retain(|p| *p != old && p != pane);
            self.before.push(old);
            if self.before.len() > BEFORE_LIMIT {
                self.before.remove(0);
            }
        }
        self.focused = Some(pane.to_owned());
    }
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct View {
    pub active_space: Option<String>,
    pub active_tab: Option<String>,
    /// The active tab's focused pane.
    pub focused: Option<String>,
    /// The active tab's zoomed pane.
    pub zoomed: Option<String>,
    /// Each space's selected tab.
    pub spaces: BTreeMap<String, String>,
    pub tabs: BTreeMap<String, TabView>,
    pub recent: Vec<Recent>,
    /// The active space and tab positions, for falling back when they close.
    #[serde(skip)]
    position: Option<(usize, usize)>,
    /// Names and folders of spaces seen at the last reconcile, for `recent`.
    #[serde(skip)]
    known: BTreeMap<String, Recent>,
}
impl View {
    /// Focuses a pane anywhere: selects its space and tab.
    pub fn focus(&mut self, document: &Document, id: &str) -> bool {
        let Some((space, tab)) = owners(document, id) else {
            return false;
        };
        self.tabs.entry(tab.clone()).or_default().focus(id);
        self.select(document, &space, &tab);
        true
    }
    /// Selects a tab and its space. Shown again, a settled tab is back.
    pub fn select_tab(&mut self, document: &Document, tab: &str) -> bool {
        let Some(space) = space_of_tab(document, tab) else {
            return false;
        };
        self.select(document, &space, tab);
        true
    }
    /// Selects a space and the tab it last showed, else its first.
    pub fn select_space(&mut self, document: &Document, space: &str) -> bool {
        let Some(node) = space_node(document, space) else {
            return false;
        };
        match self.space_tab(node) {
            Some(tab) => self.select(document, space, &tab),
            None => {
                self.active_space = Some(space.into());
                self.active_tab = None;
                self.focused = None;
                self.zoomed = None;
                self.position = position(document, space, None);
            }
        }
        true
    }
    /// The pane selecting `target` (a space, tab, or pane) would focus.
    pub fn remembered(&self, document: &Document, target: &str) -> Option<String> {
        if owners(document, target).is_some() {
            return Some(target.into());
        }
        let tab = match space_node(document, target) {
            Some(space) => self.space_tab(space)?,
            None => target.to_owned(),
        };
        self.tab_focus(document, &tab)
    }
    /// Zooms the active tab's pane, or unzooms with `None`.
    pub fn zoom(&mut self, pane: Option<&str>) {
        if let Some(tab) = &self.active_tab {
            self.tabs.entry(tab.clone()).or_default().zoomed = pane.map(str::to_owned);
        }
        self.zoomed = pane.map(str::to_owned);
    }
    /// Puts a tab away. The shown one hands over to the next unsettled tab of its space.
    pub fn settle(&mut self, document: &Document, tab: &str, now: u64) -> bool {
        let Some(space) = space_of_tab(document, tab) else {
            return false;
        };
        self.tabs.entry(tab.into()).or_default().settled = Some(now);
        if self.active_tab.as_deref() == Some(tab) {
            let ids = tab_ids(space_node(document, &space).unwrap());
            let i = ids.iter().position(|t| t == tab).unwrap_or(0);
            let n = ids.len();
            if let Some(next) = (1..n)
                .map(|k| &ids[(i + k) % n])
                .find(|t| !self.settled(t))
                .cloned()
            {
                self.select(document, &space, &next);
            }
        }
        true
    }
    pub fn unsettle(&mut self, tab: &str) -> bool {
        self.tabs
            .get_mut(tab)
            .is_some_and(|t| t.settled.take().is_some())
    }
    pub fn settled(&self, tab: &str) -> bool {
        self.tabs.get(tab).is_some_and(|t| t.settled.is_some())
    }
    /// Remembers a closed space so reopening it can reuse its name.
    pub fn remember(&mut self, recent: Recent) {
        self.recent.retain(|r| r.name != recent.name);
        self.recent.insert(0, recent);
        self.recent.truncate(RECENT_LIMIT);
    }
    /// Applies a replacement document: keeps valid choices and falls back as the app does.
    pub fn reconcile(&mut self, document: &Document) {
        let spaces = document.value()["spaces"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let known = std::mem::take(&mut self.known);
        for (id, recent) in &known {
            if !spaces.iter().any(|s| s["id"] == id.as_str()) {
                self.remember(recent.clone());
            }
        }
        // Opening a space again takes it off the recent list.
        for space in &spaces {
            if space["id"]
                .as_str()
                .is_some_and(|id| !known.contains_key(id))
            {
                let name = space["name"].as_str().unwrap_or_default();
                self.recent.retain(|r| r.name != name);
            }
        }
        self.known = spaces
            .iter()
            .filter_map(|s| {
                Some((
                    s["id"].as_str()?.to_owned(),
                    Recent {
                        name: s["name"].as_str().unwrap_or_default().into(),
                        folder: s["folder"].as_str().unwrap_or_default().into(),
                    },
                ))
            })
            .collect();
        self.tabs.retain(|id, view| {
            let Some(tab) = tab_node(document, id) else {
                return false;
            };
            let here = panes(&tab["root"]);
            view.before.retain(|p| here.contains(p));
            if view.focused.as_ref().is_some_and(|p| !here.contains(p)) {
                view.focused = view.before.pop().or_else(|| here.first().cloned());
            }
            if view.zoomed.as_ref().is_some_and(|p| !here.contains(p)) {
                view.zoomed = None;
            }
            true
        });
        self.spaces
            .retain(|space, tab| space_of_tab(document, tab).is_some_and(|owner| &owner == space));
        let target = match (&self.active_space, &self.active_tab) {
            (Some(space), Some(tab)) if space_of_tab(document, tab).as_ref() == Some(space) => {
                Some((space.clone(), Some(tab.clone())))
            }
            _ => self.fallback(&spaces),
        };
        match target {
            Some((space, Some(tab))) => self.select(document, &space, &tab),
            Some((space, None)) => {
                self.active_space = Some(space.clone());
                self.active_tab = None;
                self.focused = None;
                self.zoomed = None;
                self.position = position(document, &space, None);
            }
            None => {
                self.active_space = None;
                self.active_tab = None;
                self.focused = None;
                self.zoomed = None;
                self.position = None;
            }
        }
    }
    /// The tab that slides into a closed tab's slot, or the space that slides into a closed space's.
    fn fallback(&self, spaces: &[Value]) -> Option<(String, Option<String>)> {
        let (si, ti) = self.position.unwrap_or((0, 0));
        let same = self
            .active_space
            .as_deref()
            .and_then(|id| spaces.iter().find(|s| s["id"] == id));
        let (space, slot) = match same {
            Some(space) => (space, Some(ti)),
            None => (spaces.get(si).or(spaces.last())?, None),
        };
        let id = space["id"].as_str()?.to_owned();
        let tabs = tab_ids(space);
        let tab = match slot {
            Some(ti) => tabs.get(ti).or(tabs.last()).cloned(),
            None => self.space_tab(space),
        };
        Some((id, tab))
    }
    fn select(&mut self, document: &Document, space: &str, tab: &str) {
        self.unsettle(tab);
        self.spaces.insert(space.into(), tab.into());
        self.active_space = Some(space.into());
        self.active_tab = Some(tab.into());
        self.focused = self.tab_focus(document, tab);
        if let (Some(view), Some(focused)) = (self.tabs.get_mut(tab), &self.focused) {
            view.focused = Some(focused.clone());
        }
        self.zoomed = self.tabs.get(tab).and_then(|t| t.zoomed.clone());
        self.position = position(document, space, Some(tab));
    }
    /// A space's selected tab, else its first.
    fn space_tab(&self, space: &Value) -> Option<String> {
        let ids = tab_ids(space);
        space["id"]
            .as_str()
            .and_then(|id| self.spaces.get(id))
            .filter(|tab| ids.contains(tab))
            .cloned()
            .or_else(|| ids.first().cloned())
    }
    /// A tab's focused pane, else its first.
    fn tab_focus(&self, document: &Document, tab: &str) -> Option<String> {
        let here = panes(&tab_node(document, tab)?["root"]);
        self.tabs
            .get(tab)
            .and_then(|t| t.focused.clone())
            .filter(|p| here.contains(p))
            .or_else(|| here.first().cloned())
    }
}

fn space_node<'a>(document: &'a Document, id: &str) -> Option<&'a Value> {
    document.value()["spaces"]
        .as_array()?
        .iter()
        .find(|s| s["id"] == id)
}
fn tab_node<'a>(document: &'a Document, id: &str) -> Option<&'a Value> {
    document.value()["spaces"]
        .as_array()?
        .iter()
        .flat_map(|s| s["tabs"].as_array().into_iter().flatten())
        .find(|t| t["id"] == id)
}
fn space_of_tab(document: &Document, tab: &str) -> Option<String> {
    document.value()["spaces"]
        .as_array()?
        .iter()
        .find(|s| {
            s["tabs"]
                .as_array()
                .is_some_and(|tabs| tabs.iter().any(|t| t["id"] == tab))
        })
        .and_then(|s| s["id"].as_str().map(str::to_owned))
}
fn tab_ids(space: &Value) -> Vec<String> {
    space["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["id"].as_str().map(str::to_owned))
        .collect()
}
fn position(document: &Document, space: &str, tab: Option<&str>) -> Option<(usize, usize)> {
    let spaces = document.value()["spaces"].as_array()?;
    let si = spaces.iter().position(|s| s["id"] == space)?;
    let ti = tab
        .and_then(|tab| tab_ids(&spaces[si]).iter().position(|t| t == tab))
        .unwrap_or(0);
    Some((si, ti))
}
/// Pane ids in a subtree, in tree order.
fn panes(node: &Value) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(node: &Value, out: &mut Vec<String>) {
        if node["type"] == "block" {
            out.extend(node["id"].as_str().map(str::to_owned));
        }
        for child in node["children"].as_array().into_iter().flatten() {
            walk(child, out);
        }
    }
    walk(node, &mut out);
    out
}
fn owners(document: &Document, id: &str) -> Option<(String, String)> {
    for space in document.value()["spaces"].as_array()? {
        for tab in space["tabs"].as_array()? {
            if panes(&tab["root"]).iter().any(|p| p == id) {
                return Some((space["id"].as_str()?.into(), tab["id"].as_str()?.into()));
            }
        }
    }
    None
}

/// What this viewer's attention says about one terminal.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AttentionEntry {
    pub identity: Identity,
    /// The program's 7501 word, unchanged.
    pub word: Option<String>,
    /// The agent's name from its 7501 report.
    #[serde(default)]
    pub app: Option<String>,
    /// Whether the person has seen it since it last stopped working.
    pub seen: bool,
    /// Bumped on every state change (for "most recent" ordering).
    #[serde(default)]
    pub seq: u64,
    /// When the state last changed, ms since the epoch (0: not observed by this viewer).
    #[serde(default)]
    pub since: u64,
}
/// Per-view completion tracking. Raw status words remain unchanged.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Attention {
    pub entries: Vec<AttentionEntry>,
    #[serde(default)]
    seq: u64,
}
impl Attention {
    fn entry(&self, id: &Identity) -> Option<&AttentionEntry> {
        self.entries.iter().find(|e| &e.identity == id)
    }
    /// Applies a status word from core (Herdr's seen rules). Returns whether it changed.
    pub fn set_word(
        &mut self,
        id: &Identity,
        word: Option<String>,
        app: Option<String>,
        looking: bool,
    ) -> bool {
        let index = match self.entries.iter().position(|e| &e.identity == id) {
            Some(index) => index,
            None => {
                self.entries.push(AttentionEntry {
                    identity: id.clone(),
                    word: None,
                    app: None,
                    seen: true,
                    seq: 0,
                    since: 0,
                });
                self.entries.len() - 1
            }
        };
        let entry = &mut self.entries[index];
        entry.app = app.or(entry.app.take());
        if entry.word == word {
            return false;
        }
        let was_busy = matches!(entry.word.as_deref(), Some("working" | "blocked"));
        match word.as_deref() {
            Some("working" | "blocked") => entry.seen = true,
            // A finish you didn't watch is "done" until you look at it.
            Some(_) if was_busy => entry.seen = looking,
            _ => {}
        }
        entry.word = word;
        self.seq += 1;
        entry.seq = self.seq;
        entry.since = now_ms();
        true
    }
    /// The alert a new word raises: only terminals shown in a pane ring, and a
    /// sub-agent reports to its parent instead.
    pub fn alert_for(
        &self,
        id: &Identity,
        placed: bool,
        sub_agent: bool,
        new: Option<&str>,
        looking: bool,
    ) -> Option<Alert> {
        if sub_agent || !placed {
            return None;
        }
        alert(self.word(id), new, looking)
    }
    /// Marks what the person is looking at as seen.
    pub fn mark_seen<'a>(&mut self, ids: impl IntoIterator<Item = &'a Identity>) -> bool {
        let mut changed = false;
        for id in ids {
            if let Some(entry) = self.entries.iter_mut().find(|e| &e.identity == id)
                && !entry.seen
            {
                entry.seen = true;
                changed = true;
            }
        }
        changed
    }
    /// The word last applied, if any.
    pub fn word(&self, id: &Identity) -> Option<&str> {
        self.entry(id).and_then(|e| e.word.as_deref())
    }
    /// What to show for a terminal reporting `word` now.
    pub fn status(&self, id: &Identity, word: Option<&str>) -> Option<Status> {
        Status::from_word(word, self.entry(id).is_none_or(|e| e.seen))
    }
    pub fn unseen(&self, id: &Identity) -> bool {
        self.entry(id).is_some_and(|e| !e.seen)
    }
    pub fn seq(&self, id: &Identity) -> u64 {
        self.entry(id).map_or(0, |e| e.seq)
    }
    pub fn since(&self, id: &Identity) -> u64 {
        self.entry(id).map_or(0, |e| e.since)
    }
    /// Restores saved seen state after a restart: a terminal still on the saved
    /// word keeps whether it was seen; a new word follows the usual rules.
    pub fn restore(&mut self, saved: &Attention) {
        for entry in &saved.entries {
            match self
                .entries
                .iter_mut()
                .find(|e| e.identity == entry.identity)
            {
                Some(current) if current.word == entry.word => current.seen = entry.seen,
                Some(_) => {}
                None => self.entries.push(AttentionEntry {
                    seq: 0,
                    since: 0,
                    ..entry.clone()
                }),
            }
        }
    }
    /// Forgets terminals that no longer exist.
    pub fn retain(&mut self, mut keep: impl FnMut(&Identity) -> bool) {
        self.entries.retain(|e| keep(&e.identity));
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
