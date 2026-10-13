use serde_json::json;
use termai_server::herdr;
#[path = "support/herdr.rs"]
mod support;

#[tokio::test]
async fn worktrees_and_splits_are_scoped_to_the_held_space() {
    let fixture = support::Fixture::new().await;
    for input in [
        json!({"action":"list-worktrees","workspaceId":"missing"}),
        json!({"action":"split","workspaceId":"w1","terminalId":"other-space-pane","direction":"right"}),
        json!({"action":"split","workspaceId":"w1","terminalId":"term_0","direction":"invalid"}),
        json!({"action":"new-worktree","workspaceId":"w1","branch":"bad\nbranch"}),
        json!({"action":"open-worktree","workspaceId":"w1","path":"/unlisted"}),
        json!({"action":"open-worktree","workspaceId":"w1","path":"/pruned"}),
    ] {
        assert!(fixture.target.action(&input).await.is_err());
    }
    assert!(
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .all(|a| a["method"] == "worktree.list")
    );
    let created = fixture
        .target
        .action(&json!({"action":"new-worktree","workspaceId":"w1","branch":"review/mobile"}))
        .await
        .unwrap();
    assert_eq!(created, json!({"workspaceId":"w2","terminalId":"term_1"}));
    fixture
        .target
        .action(
            &json!({"action":"open-worktree","workspaceId":"w1","path":"/worktrees/repo/review"}),
        )
        .await
        .unwrap();
    fixture
        .target
        .action(
            &json!({"action":"split","workspaceId":"w1","terminalId":"term_0","direction":"down"}),
        )
        .await
        .unwrap();
    let actions = fixture.actions.lock().unwrap();
    assert_eq!(
        actions
            .iter()
            .find(|a| a["method"] == "worktree.create")
            .unwrap()["params"],
        json!({"workspace_id":"w1","branch":"review/mobile","base":"HEAD","focus":false,"trust_repository":false})
    );
    assert_eq!(
        actions
            .iter()
            .find(|a| a["method"] == "worktree.open")
            .unwrap()["params"],
        json!({"workspace_id":"w1","path":"/worktrees/repo/review","focus":false,"trust_repository":false})
    );
    assert_eq!(
        actions
            .iter()
            .find(|a| a["method"] == "pane.split")
            .unwrap()["params"],
        json!({"workspace_id":"w1","target_pane_id":"w1:p0","direction":"down","focus":false})
    );
    drop(actions);
    fixture.snapshot.lock().unwrap()["workspaces"][0]["worktree"] =
        json!({"is_linked_worktree":true});
    assert!(
        fixture
            .target
            .action(&json!({"action":"list-worktrees","workspaceId":"w1"}))
            .await
            .unwrap_err()
            .contains("parent space")
    );
}

#[tokio::test]
async fn rpc_actions_preserve_labels_and_reject_stale_or_refused_changes() {
    let fixture = support::Fixture::new().await;
    assert_eq!(
        fixture.target.options().await.unwrap(),
        json!({"kinds":["codex","claude","pi"]})
    );
    assert!(
        fixture
            .target
            .action(&json!({"action":"rename","terminalId":"missing","name":"No"}))
            .await
            .unwrap_err()
            .contains("ended")
    );
    fixture
        .target
        .action(&json!({"action":"rename","terminalId":"term_0","name":"API routes"}))
        .await
        .unwrap();
    assert_eq!(
        fixture.snapshot.lock().unwrap()["panes"][0]["label"],
        "API routes"
    );
    assert_eq!(
        fixture.snapshot.lock().unwrap()["agents"][0]["name"],
        "agent-address"
    );
    assert_eq!(
        fixture.target.snapshot().await.unwrap()["agents"][0]["name"],
        "API routes"
    );
    assert!(
        fixture
            .target
            .action(&json!({"action":"rename-space","workspaceId":"missing","name":"No"}))
            .await
            .unwrap_err()
            .contains("closed")
    );
    fixture
        .target
        .action(&json!({"action":"rename-space","workspaceId":"w1","name":"Review"}))
        .await
        .unwrap();
    assert_eq!(
        fixture.target.snapshot().await.unwrap()["spaces"][0]["name"],
        "Review"
    );
    assert!(
        fixture
            .target
            .action(&json!({"action":"move-space","workspaceId":"w1","beforeWorkspaceId":"w1"}))
            .await
            .unwrap_err()
            .contains("another")
    );
    *fixture.close_error.lock().unwrap() = "Server refused to close pane.".into();
    assert!(
        fixture
            .target
            .action(&json!({"action":"close","terminalId":"term_0"}))
            .await
            .unwrap_err()
            .contains("refused")
    );
    assert_eq!(
        fixture.target.snapshot().await.unwrap()["terminals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fixture.close_error.lock().unwrap().clear();
    fixture
        .target
        .action(&json!({"action":"close-space","workspaceId":"w1"}))
        .await
        .unwrap();
    assert!(
        fixture.target.snapshot().await.unwrap()["terminals"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .rfind(|a| a["method"] == "workspace.close")
            .unwrap()["params"],
        json!({"workspace_id":"w1","close_group":false})
    );
}

#[tokio::test]
async fn chunked_lines_keep_partial_frames_across_cancelled_reads_and_bound_memory() {
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader};
    let (mut write, read) = tokio::io::duplex(1024);
    let mut input = BufReader::new(read);
    let mut lines = herdr::Lines::default();
    write.write_all(b"\n {\"value\":\"").await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), lines.read(&mut input))
            .await
            .is_err()
    );
    write
        .write_all("🌱\"}\n{\"second\":2}\n".as_bytes())
        .await
        .unwrap();
    assert_eq!(
        lines.read(&mut input).await.unwrap(),
        Some(json!({"value":"🌱"}))
    );
    assert_eq!(
        lines.read(&mut input).await.unwrap(),
        Some(json!({"second":2}))
    );
    let (mut write, read) = tokio::io::duplex(4096);
    let task = tokio::spawn(async move {
        let bytes = vec![b'x'; 8192];
        for _ in 0..1025 {
            if write.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    assert_eq!(
        herdr::Lines::default()
            .read(&mut BufReader::new(read))
            .await
            .unwrap_err(),
        "Herdr response exceeded its limit."
    );
    task.await.unwrap();
    let mut bad = BufReader::new(&b"malformed\n"[..]);
    assert_eq!(
        herdr::read_line(&mut bad).await.unwrap_err(),
        "Invalid Herdr response."
    );
}
