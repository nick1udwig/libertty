use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
pub struct Tracker {
    states: HashMap<String, Value>,
    initialized: bool,
    agents: Vec<Value>,
}
fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0)
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
    pub fn update(&mut self, snapshot: &Value) -> Vec<Value> {
        let agents = snapshot["agents"].as_array().cloned().unwrap_or_default();
        self.states
            .retain(|id, _| agents.iter().any(|a| a["terminalId"] == *id));
        let mut notifications = Vec::new();
        for agent in &agents {
            let Some(id) = agent["terminalId"].as_str() else {
                continue;
            };
            let old = self.states.get(id).filter(|s| {
                agent["sequence"].as_f64().unwrap_or(0.0) >= s["sequence"].as_f64().unwrap_or(0.0)
            });
            let mut state = json!({"raw":agent["status"],"sequence":agent["sequence"],"working":old.is_some_and(|s| s["working"]==true)});
            if let Some(seen) = old.and_then(|s| s.get("seen")) {
                state["seen"] = seen.clone();
            }
            if agent["status"] == "working" {
                state["working"] = json!(true);
            }
            if agent["status"] == "idle" || agent["status"] == "done" {
                let completion = agent
                    .get("completion")
                    .filter(|v| !v.is_null())
                    .or_else(|| {
                        if agent["status"] == "done" || old.is_some_and(|s| s["working"] == true) {
                            agent.get("sequence")
                        } else {
                            old.and_then(|s| s.get("completion"))
                        }
                    });
                if let Some(completion) = completion {
                    state["completion"] = completion.clone();
                }
                state["working"] = json!(false);
                if self.initialized
                    && old.is_some()
                    && completion.is_some()
                    && completion != old.and_then(|s| s.get("completion"))
                {
                    notifications
                        .push(json!({"terminalId":id,"kind":"done","sequence":completion}));
                }
            }
            if self.initialized
                && let Some(old) = old
                && agent["status"] == "blocked"
                && (old["raw"] != "blocked" || old["sequence"] != agent["sequence"])
            {
                notifications
                    .push(json!({"terminalId":id,"kind":"request","sequence":agent["sequence"]}));
            }
            if agent["status"] == "unknown" {
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
    pub fn status(&self, agent: &Value) -> String {
        if let Some(state) = agent["terminalId"]
            .as_str()
            .and_then(|s| self.states.get(s))
            && (state["raw"] == "idle" || state["raw"] == "done")
        {
            return if state["completion"]
                .as_f64()
                .is_some_and(|n| state["seen"].as_f64().unwrap_or(-1.0) < n)
            {
                "done"
            } else {
                "idle"
            }
            .into();
        }
        agent["status"].as_str().unwrap_or("unknown").into()
    }
    pub fn attention(&self) -> usize {
        self.agents
            .iter()
            .filter(|a| ["done", "blocked"].contains(&self.status(a).as_str()))
            .count()
    }
}
