//! Lifecycle and stale-result guards shared by shell and Herdr input adapters.
use crate::{
    dictation::Recording,
    protocol::{Dictation, DictationAction},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Controller {
    pub repair: Option<(String, CancellationToken)>,
    pub dictation: Option<(String, Recording)>,
    pub serial: u64,
}
impl Controller {
    pub fn cancel_repair(&self, id: Option<&str>) {
        if let Some((current, cancel)) = &self.repair
            && id.is_none_or(|id| id == current)
        {
            cancel.cancel();
        }
    }
    pub fn replace_repair(&mut self, id: String, cancel: CancellationToken) {
        if let Some((_, previous)) = self.repair.replace((id, cancel)) {
            previous.cancel();
        }
    }
    /// A start never replaces a recording that is still processing.
    pub fn control_dictation(&mut self, request: &Dictation) -> bool {
        let current = self
            .dictation
            .as_ref()
            .is_some_and(|(id, _)| id == &request.id);
        match request.action {
            DictationAction::Cancel if current => {
                self.dictation.take();
            }
            DictationAction::Finish if current => {
                self.dictation.as_ref().unwrap().1.finish();
            }
            DictationAction::Start => {
                return self.dictation.as_ref().is_some_and(|(_, r)| !r.done());
            }
            _ => {}
        }
        true
    }
    pub fn current(&self, id: &str, serial: u64) -> bool {
        self.serial == serial
            && self
                .dictation
                .as_ref()
                .is_some_and(|(current, _)| current == id)
    }
    pub fn status(&mut self, id: &str, serial: u64, state: &str) -> bool {
        if !self.current(id, serial) {
            return false;
        }
        if state != "ready" {
            self.dictation.take();
        }
        true
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        self.cancel_repair(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn stale_recording_status_and_controls_cannot_replace_current_recording() {
        let id = "11111111-1111-1111-1111-111111111111";
        let mut controller = Controller {
            serial: 2,
            dictation: Some((id.into(), Recording::dormant())),
            repair: None,
        };
        assert!(!controller.status(id, 1, "error"));
        assert!(controller.current(id, 2));
        let request: Dictation = serde_json::from_value(
            json!({"id":"22222222-2222-2222-2222-222222222222","action":"cancel"}),
        )
        .unwrap();
        assert!(controller.control_dictation(&request));
        assert!(controller.current(id, 2));
        assert!(controller.status(id, 2, "done"));
        assert!(!controller.current(id, 2));
    }
    #[test]
    fn replacing_repair_cancels_its_predecessor_and_scopes_cancellation() {
        let mut controller = Controller::default();
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        controller.replace_repair("first".into(), first.clone());
        controller.replace_repair("second".into(), second.clone());
        assert!(first.is_cancelled());
        controller.cancel_repair(Some("first"));
        assert!(!second.is_cancelled());
        controller.cancel_repair(Some("second"));
        assert!(second.is_cancelled());
    }
}
