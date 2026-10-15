use crate::{protocol::ServerMessage, storage};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Kind {
    Ssh,
    Herdr,
}
#[derive(Clone, Serialize)]
pub(super) struct Capture {
    id: String,
    pub command: String,
    kind: Kind,
}
impl Capture {
    fn message(&self) -> ServerMessage {
        match self.kind {
            Kind::Ssh => ServerMessage::SshCommand {
                id: self.id.clone(),
                command: self.command.clone(),
            },
            Kind::Herdr => ServerMessage::HerdrCommand {
                id: self.id.clone(),
                command: self.command.clone(),
            },
        }
    }
    fn value(&self) -> Value {
        serde_json::to_value(self).expect("captured command")
    }
}
struct Completed {
    capture: Capture,
    value: Value,
    acknowledged: bool,
}
#[derive(Default)]
pub(super) struct Handoffs {
    active: Option<Capture>,
    completed: Option<Completed>,
}
impl Handoffs {
    pub fn active(&self) -> bool {
        self.active.is_some()
    }
    pub fn captured(&self) -> Option<Value> {
        self.active.as_ref().map(Capture::value)
    }
    pub fn begin(&mut self, kind: Kind, command: String) -> Option<ServerMessage> {
        if self.active.is_some() {
            return None;
        }
        let capture = Capture {
            id: storage::random_hex(16),
            command,
            kind,
        };
        let message = capture.message();
        self.active = Some(capture);
        Some(message)
    }
    pub fn result(&self, id: &str) -> Option<Value> {
        self.completed
            .as_ref()
            .filter(|result| result.capture.id == id)
            .map(|result| result.value.clone())
    }
    pub fn acknowledge(&mut self, id: &str) {
        if let Some(result) = self
            .completed
            .as_mut()
            .filter(|result| result.capture.id == id)
        {
            result.acknowledged = true;
        }
    }
    pub fn release(&mut self, id: &str, value: Option<Value>) -> Result<Capture, String> {
        let capture = self
            .active
            .as_ref()
            .filter(|capture| capture.id == id)
            .cloned()
            .ok_or("This connection request is no longer active.")?;
        self.active = None;
        if let Some(value) = value {
            self.completed = Some(Completed {
                capture: capture.clone(),
                value,
                acknowledged: false,
            });
        }
        Ok(capture)
    }
    pub fn pending(&self) -> Option<ServerMessage> {
        self.active
            .as_ref()
            .or_else(|| {
                self.completed
                    .as_ref()
                    .filter(|result| !result.acknowledged)
                    .map(|result| &result.capture)
            })
            .map(Capture::message)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn handoff_results_replay_until_acknowledged_and_wrong_ids_preserve_active_requests() {
        let mut handoffs = Handoffs::default();
        let message = handoffs.begin(Kind::Herdr, "herdr".into()).unwrap().value();
        let id = message["id"].as_str().unwrap();
        assert!(handoffs.begin(Kind::Ssh, "ssh host".into()).is_none());
        assert!(handoffs.release("wrong", None).is_err());
        assert!(handoffs.active());
        handoffs
            .release(id, Some(json!({"connection":"saved"})))
            .unwrap();
        assert_eq!(handoffs.pending().unwrap().value(), message);
        assert_eq!(handoffs.result(id), Some(json!({"connection":"saved"})));
        handoffs.acknowledge("wrong");
        assert!(handoffs.pending().is_some());
        handoffs.acknowledge(id);
        assert!(handoffs.pending().is_none());
        assert!(handoffs.result(id).is_some());
    }
}
