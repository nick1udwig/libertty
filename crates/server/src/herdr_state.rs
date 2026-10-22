use crate::herdr::{Snapshot, Status, Terminal};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// An agent finishing or waiting for input, as notified and acknowledged by viewers.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub terminal_id: String,
    pub kind: EventKind,
    pub sequence: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Done,
    Request,
}
impl EventKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Request => "request",
        }
    }
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Agent {
    raw: Status,
    sequence: f64,
    #[serde(default)]
    working: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completion: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seen: Option<f64>,
}
fn safe(value: f64) -> bool {
    crate::protocol::integer(&Value::from(value)).is_some()
}

#[derive(Default)]
pub struct Tracker {
    states: HashMap<String, Agent>,
    initialized: bool,
    agents: Vec<Terminal>,
}
impl Tracker {
    pub fn new(checkpoint: Option<&Value>) -> Self {
        let mut tracker = Self::default();
        if let Some(checkpoint) = checkpoint.and_then(Value::as_object) {
            for (id, state) in checkpoint.iter().take(256) {
                let Ok(mut agent) = Agent::deserialize(state) else {
                    continue;
                };
                if !safe(agent.sequence) {
                    continue;
                }
                agent.completion = agent.completion.filter(|n| safe(*n));
                agent.seen = agent.seen.filter(|n| safe(*n));
                tracker.states.insert(id.clone(), agent);
            }
        }
        tracker
    }
    pub fn checkpoint(&self) -> Value {
        serde_json::to_value(&self.states).expect("tracker checkpoint")
    }
    pub fn update(&mut self, snapshot: &Snapshot) -> Vec<Event> {
        let agents = snapshot.agents.clone();
        self.states
            .retain(|id, _| agents.iter().any(|a| a.terminal_id == *id));
        let mut events = Vec::new();
        for agent in &agents {
            let id = agent.terminal_id.as_str();
            let old = self
                .states
                .get(id)
                .filter(|state| agent.sequence >= state.sequence);
            let mut state = Agent {
                raw: agent.status,
                sequence: agent.sequence,
                working: old.is_some_and(|state| state.working),
                completion: None,
                seen: old.and_then(|state| state.seen),
            };
            let event = |kind, sequence: f64| Event {
                terminal_id: id.into(),
                kind,
                sequence: sequence as u64,
            };
            match agent.status {
                Status::Working => state.working = true,
                Status::Idle | Status::Done => {
                    state.completion = agent.completion.or_else(|| {
                        if agent.status == Status::Done || old.is_some_and(|state| state.working) {
                            Some(agent.sequence)
                        } else {
                            old.and_then(|state| state.completion)
                        }
                    });
                    state.working = false;
                    if self.initialized
                        && let Some(old) = old
                        && let Some(completion) = state.completion
                        && Some(completion) != old.completion
                    {
                        events.push(event(EventKind::Done, completion));
                    }
                }
                Status::Blocked => {
                    if self.initialized
                        && let Some(old) = old
                        && (old.raw != Status::Blocked || old.sequence != agent.sequence)
                    {
                        events.push(event(EventKind::Request, agent.sequence));
                    }
                }
                Status::Unknown => state.working = false,
            }
            self.states.insert(id.into(), state);
        }
        self.agents = agents;
        self.initialized = true;
        events
    }
    pub fn viewed(&mut self, terminal: &str) -> bool {
        let Some(state) = self.states.get_mut(terminal) else {
            return false;
        };
        let Some(completion) = state.completion else {
            return false;
        };
        if state.seen.unwrap_or(-1.0) >= completion {
            return false;
        }
        state.seen = Some(completion);
        true
    }
    pub fn status(&self, agent: &Terminal) -> Status {
        match self.states.get(&agent.terminal_id) {
            Some(state) if matches!(state.raw, Status::Idle | Status::Done) => {
                if state
                    .completion
                    .is_some_and(|n| state.seen.unwrap_or(-1.0) < n)
                {
                    Status::Done
                } else {
                    Status::Idle
                }
            }
            _ => agent.status,
        }
    }
    pub fn attention(&self) -> usize {
        self.agents
            .iter()
            .filter(|a| matches!(self.status(a), Status::Done | Status::Blocked))
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::Terminal;
    fn snapshot(status: Status, sequence: f64) -> Snapshot {
        Snapshot {
            agents: vec![Terminal {
                terminal_id: "term_0".into(),
                pane_id: "pane_0".into(),
                workspace_id: None,
                tab_id: None,
                workspace: "Project".into(),
                name: "Agent".into(),
                kind: "Codex".into(),
                status,
                sequence,
                completion: None,
                cwd: "/project".into(),
            }],
            terminals: vec![],
            spaces: vec![],
            worktree_directory: None,
            version: None,
            protocol: None,
        }
    }
    #[test]
    fn browser_acknowledgements_identify_the_notified_event() {
        let mut tracker = Tracker::new(None);
        tracker.update(&snapshot(Status::Working, 4.0));
        let events = tracker.update(&snapshot(Status::Blocked, 5.0));
        let acknowledged: Event =
            serde_json::from_str(r#"{"terminalId":"term_0","kind":"request","sequence":5}"#)
                .unwrap();
        assert_eq!(events, [acknowledged]);
        let restored = Tracker::new(Some(&tracker.checkpoint()));
        assert_eq!(restored.checkpoint(), tracker.checkpoint());
        assert!(restored.states["term_0"].raw == Status::Blocked);
    }
}
