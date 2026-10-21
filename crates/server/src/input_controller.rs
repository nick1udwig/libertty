//! Lifecycle and stale-result guards shared by shell and Herdr input adapters.
use crate::{
    dictation::Recording,
    protocol::{ClientMessage, Dictation, DictationAction, DictationState, DictationTarget},
};
use tokio_util::sync::CancellationToken;

/// The terminal input a new recording must match, absent while no input can accept text.
pub struct Line {
    pub target: Option<DictationTarget>,
    pub prompt: u64,
    pub revision: u64,
}
#[derive(Default)]
pub struct Controller {
    pub repair: Option<(String, CancellationToken)>,
    pub dictation: Option<(String, Recording)>,
    pub serial: u64,
}
impl Controller {
    /// Consume shared lifecycle actions before the terminal-specific dispatch.
    pub fn intercept(&self, message: &ClientMessage) -> bool {
        if message.edits_input() {
            self.cancel_repair(None);
        }
        if let ClientMessage::RepairCancel { id } = message {
            self.cancel_repair(Some(id));
            return true;
        }
        false
    }
    pub fn finish_repair(&mut self, id: &str) {
        if self.repair.as_ref().is_some_and(|(active, _)| active == id) {
            self.repair.take();
        }
    }
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
    /// Claim the next recording serial for a start that matches the terminal's input line.
    pub fn begin_dictation(
        &mut self,
        request: &Dictation,
        line: Option<Line>,
    ) -> Result<u64, &'static str> {
        let Some(line) = line.filter(|line| line.target.is_some()) else {
            return Err("Wait for terminal input before dictating.");
        };
        if request.target() != line.target
            || request.prompt != Some(line.prompt)
            || request.revision != Some(line.revision)
        {
            return Err("Terminal input changed. Try dictating again.");
        }
        self.serial += 1;
        Ok(self.serial)
    }
    pub fn current(&self, id: &str, serial: u64) -> bool {
        self.serial == serial
            && self
                .dictation
                .as_ref()
                .is_some_and(|(current, _)| current == id)
    }
    pub fn status(&mut self, id: &str, serial: u64, state: DictationState) -> bool {
        if !self.current(id, serial) {
            return false;
        }
        if !matches!(state, DictationState::Ready) {
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
        assert!(!controller.status(id, 1, DictationState::Error));
        assert!(controller.current(id, 2));
        let request: Dictation = serde_json::from_value(
            json!({"id":"22222222-2222-2222-2222-222222222222","action":"cancel"}),
        )
        .unwrap();
        assert!(controller.control_dictation(&request));
        assert!(controller.current(id, 2));
        assert!(controller.status(id, 2, DictationState::Done));
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
        controller.finish_repair("first");
        assert_eq!(controller.repair.as_ref().unwrap().0, "second");
        controller.cancel_repair(Some("first"));
        assert!(!second.is_cancelled());
        controller.cancel_repair(Some("second"));
        assert!(second.is_cancelled());
    }
    #[test]
    fn focus_reports_preserve_repairs_but_mixed_input_cancels_them() {
        let mut controller = Controller::default();
        let cancel = CancellationToken::new();
        controller.replace_repair("repair".into(), cancel.clone());
        for data in ["\x1b[I", "\x1b[O"] {
            let message = ClientMessage::try_from(json!({"type":"input","data":data})).unwrap();
            assert!(!message.edits_input());
            assert!(!controller.intercept(&message));
            assert!(!cancel.is_cancelled());
        }
        let message = ClientMessage::try_from(json!({"type":"input","data":"\x1b[Ix"})).unwrap();
        assert!(message.edits_input());
        assert!(!controller.intercept(&message));
        assert!(cancel.is_cancelled());
    }
}
