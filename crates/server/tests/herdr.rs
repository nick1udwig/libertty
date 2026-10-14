use serde_json::json;
use termai_server::herdr;
#[path = "support/herdr.rs"]
mod support;

#[tokio::test]
async fn checkout_deletion_validates_the_confirmed_folder_and_preserves_refusals() {
    let fixture = support::Fixture::new().await;
    let request =
        json!({"action":"delete-worktree","workspaceId":"w1","path":"/worktrees/repo/review"});
    assert!(
        fixture
            .target
            .action(&request)
            .await
            .unwrap_err()
            .contains("linked worktree")
    );
    fixture.snapshot.lock().unwrap()["workspaces"][0]["worktree"] =
        json!({"is_linked_worktree":true,"checkout_path":"/worktrees/repo/review"});
    // A pane can cd into a subdirectory without changing the checkout being removed.
    fixture.snapshot.lock().unwrap()["panes"][0]["foreground_cwd"] =
        json!("/worktrees/repo/review/src");
    fixture.snapshot.lock().unwrap()["agents"][0]["cwd"] = json!("/worktrees/repo/review/src");
    let snapshot = fixture.target.snapshot().await.unwrap();
    assert_eq!(snapshot["spaces"][0]["cwd"], "/worktrees/repo/review/src");
    assert_eq!(
        snapshot["spaces"][0]["checkoutPath"],
        "/worktrees/repo/review"
    );
    assert!(fixture.target.action(&json!({"action":"delete-worktree","workspaceId":"missing","path":"/worktrees/repo/review"})).await.unwrap_err().contains("closed"));
    for path in [json!("/other"), json!(null)] {
        assert!(
            fixture
                .target
                .action(&json!({"action":"delete-worktree","workspaceId":"w1","path":path}))
                .await
                .unwrap_err()
                .contains("folder changed")
        );
    }
    assert!(fixture.actions.lock().unwrap().is_empty());
    *fixture.close_error.lock().unwrap() = "Checkout contains uncommitted changes.".into();
    assert!(
        fixture
            .target
            .action(&request)
            .await
            .unwrap_err()
            .contains("uncommitted")
    );
    assert_eq!(
        fixture.target.snapshot().await.unwrap()["spaces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fixture.close_error.lock().unwrap().clear();
    fixture.target.action(&request).await.unwrap();
    assert!(
        fixture.target.snapshot().await.unwrap()["spaces"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .all(|action| action["method"] == "worktree.remove"
                && action["params"]
                    == json!({"workspace_id":"w1","force":false,"trust_repository":false}))
    );
}

#[tokio::test]
async fn worktree_branch_suggestions_read_only_local_refs_from_the_held_repository() {
    let fixture = support::Fixture::new().await;
    let repo = fixture.directory.path().join("repo with 'quotes'");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        let result = std::process::Command::new("git")
            .current_dir(&repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&[
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Initial",
    ]);
    git(&["branch", "review/existing"]);
    git(&["branch", "fix/another"]);
    git(&["tag", "not-a-branch"]);
    git(&["update-ref", "refs/remotes/origin/not-local", "HEAD"]);
    fixture.snapshot.lock().unwrap()["panes"][0]["cwd"] = json!(repo.to_str().unwrap());
    let listing = fixture
        .target
        .action(&json!({"action":"list-worktrees","workspaceId":"w1"}))
        .await
        .unwrap();
    assert_eq!(
        listing["branches"],
        json!(["fix/another", "main", "review/existing"])
    );
    assert_eq!(listing["source"]["repo_root"], repo.to_str().unwrap());
    assert_eq!(listing["worktrees"].as_array().unwrap().len(), 3);
}

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
    {
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
    }
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
    let options = fixture.target.options().await.unwrap();
    assert_eq!(options["kinds"], json!(["codex", "claude", "pi"]));
    assert!(
        options["actions"]
            .as_array()
            .unwrap()
            .contains(&json!("split"))
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
async fn unsupported_split_actions_explain_which_server_needs_updating() {
    let fixture = support::Fixture::new().await;
    *fixture.split_error.lock().unwrap() = "Unknown action: pane.split".into();
    let error = fixture
        .target
        .action(
            &json!({"action":"split","workspaceId":"w1","terminalId":"term_0","direction":"right"}),
        )
        .await
        .unwrap_err();
    assert!(error.contains("Update Herdr on this host"), "{error}");
    assert_eq!(
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "pane.split")
            .count(),
        1,
        "Unsupported actions are not replayed"
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
