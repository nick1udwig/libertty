use crate::{herdr::Status, protocol::integer};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
pub struct Tracker {
    states: HashMap<String, Value>,
    initialized: bool,
    agents: Vec<crate::herdr::Terminal>,
}

fn status(value: &Value) -> bool {
    ["idle", "working", "blocked", "done", "unknown"]
        .iter()
        .any(|s| value == *s)
}
impl Tracker {
    pub fn new(checkpoint: Option<&Value>) -> Self {
        let mut tracker = Self::default();
        if let Some(checkpoint) = checkpoint.and_then(Value::as_object) {
            for (id, state) in checkpoint.iter().take(256) {
                if integer(&state["sequence"]).is_none() || !status(&state["raw"]) {
                    continue;
                }
                let mut value = json!({"raw":state["raw"],"sequence":state["sequence"],"working":state["working"]==true});
                for field in ["completion", "seen"] {
                    if integer(&state[field]).is_some() {
                        value[field] = state[field].clone();
                    }
                }
                tracker.states.insert(id.clone(), value);
            }
        }
        tracker
    }
    pub fn checkpoint(&self) -> Value {
        json!(self.states)
    }
    pub fn update(&mut self, snapshot: &crate::herdr::Snapshot) -> Vec<Value> {
        let agents = snapshot.agents.clone();
        self.states
            .retain(|id, _| agents.iter().any(|a| a.terminal_id == *id));
        let mut notifications = Vec::new();
        for agent in &agents {
            let id = agent.terminal_id.as_str();
            let old = self
                .states
                .get(id)
                .filter(|s| agent.sequence >= s["sequence"].as_f64().unwrap_or(0.0));
            let mut state = json!({"raw":agent.status,"sequence":agent.sequence,"working":old.is_some_and(|s| s["working"]==true)});
            if let Some(seen) = old.and_then(|s| s.get("seen")) {
                state["seen"] = seen.clone();
            }
            if agent.status == Status::Working {
                state["working"] = json!(true);
            }
            if matches!(agent.status, Status::Idle | Status::Done) {
                let completion = agent.completion.or_else(|| {
                    if agent.status == Status::Done
                        || old.is_some_and(|state| state["working"] == true)
                    {
                        Some(agent.sequence)
                    } else {
                        old.and_then(|state| state["completion"].as_f64())
                    }
                });
                if let Some(completion) = completion {
                    state["completion"] = json!(completion);
                }
                state["working"] = json!(false);
                if self.initialized
                    && old.is_some()
                    && completion.is_some()
                    && completion != old.and_then(|state| state["completion"].as_f64())
                {
                    notifications
                        .push(json!({"terminalId":id,"kind":"done","sequence":completion}));
                }
            }
            if self.initialized
                && let Some(old) = old
                && agent.status == Status::Blocked
                && (old["raw"] != "blocked" || old["sequence"] != agent.sequence)
            {
                notifications
                    .push(json!({"terminalId":id,"kind":"request","sequence":agent.sequence}));
            }
            if agent.status == Status::Unknown {
                state["working"] = json!(false);
            }
            self.states.insert(id.into(), state);
        }
        self.agents = agents;
        self.initialized = true;
        notifications
    }
    pub fn viewed(&mut self, terminal: &str) -> bool {
        let Some(state) = self.states.get_mut(terminal) else {
            return false;
        };
        let Some(completion) = state["completion"].as_f64() else {
            return false;
        };
        if state["seen"].as_f64().unwrap_or(-1.0) >= completion {
            return false;
        }
        state["seen"] = state["completion"].clone();
        true
    }
    pub fn status(&self, agent: &crate::herdr::Terminal) -> Status {
        if let Some(state) = self.states.get(&agent.terminal_id)
            && (state["raw"] == "idle" || state["raw"] == "done")
        {
            return if state["completion"]
                .as_f64()
                .is_some_and(|n| state["seen"].as_f64().unwrap_or(-1.0) < n)
            {
                Status::Done
            } else {
                Status::Idle
            };
        }
        agent.status
    }
    pub fn attention(&self) -> usize {
        self.agents
            .iter()
            .filter(|a| matches!(self.status(a), Status::Done | Status::Blocked))
            .count()
    }
}
