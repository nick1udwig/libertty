//! Observe terminal-content revisions independently of the first resized grid.
use crate::herdr::Target;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub async fn revision(target: &Target, pane: &Value, cancel: &CancellationToken) -> Option<u64> {
    let request = target.request(
        "pane.copy_motion",
        json!({"pane_id":pane,"motion":"line_end","cursor":{"row":0,"col":0}}),
    );
    tokio::select! { biased; _=cancel.cancelled()=>None, result=request=>result.ok().and_then(|value| value["content_revision"].as_u64()) }
}
/// A resize advances the native revision by two; PTY output advances it again.
pub fn redrawn(before: u64, current: u64) -> bool {
    current.is_multiple_of(2) && (current == before || current > before.saturating_add(2))
}
pub async fn wait(
    target: &Target,
    pane: &Value,
    before: Option<u64>,
    cancel: &CancellationToken,
) -> bool {
    let Some(before) = before else { return true };
    let work = async {
        loop {
            if revision(target, pane, cancel)
                .await
                .is_none_or(|current| redrawn(before, current))
            {
                return true;
            }
            tokio::select! { biased; _=cancel.cancelled()=>return false, _=tokio::time::sleep(Duration::from_millis(20))=>{} }
        }
    };
    tokio::select! { biased; _=cancel.cancelled()=>false, result=tokio::time::timeout(Duration::from_secs(2),work)=>result.unwrap_or(true) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_alone_is_not_application_output() {
        assert!(!redrawn(10, 12));
        assert!(!redrawn(10, 11));
        assert!(!redrawn(10, 8));
        assert!(redrawn(10, 10));
        assert!(redrawn(10, 14));
    }
}
