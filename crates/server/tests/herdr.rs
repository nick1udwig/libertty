use serde_json::{Value, json};
use termai_server::{herdr, herdr_state::Tracker};
#[path = "support/herdr.rs"]
mod support;

#[test]
fn boundaries_match_unchanged_reference_fixtures() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-migration/herdr.json"
    ))
    .unwrap();
    for (index, row) in corpus["rows"].as_array().unwrap().iter().enumerate() {
        let args = row["args"].as_array().unwrap();
        let string = |i: usize| args[i].as_str().unwrap();
        let result = match row["operation"].as_str().unwrap() {
            "session" => herdr::session(args.first()).map(|v| json!(v)),
            "name" => herdr::name(&args[0]).map(|v| json!(v)),
            "socket" => herdr::socket(string(0), &serde_json::from_value(args[1].clone()).unwrap())
                .map(|v| json!(v)),
            "parse" => {
                herdr::parse_command(string(0), &serde_json::from_value(args[1].clone()).unwrap())
                    .map(|(binary, session)| json!({"binary":binary,"session":session}))
            }
            "normalize" => herdr::normalize(&args[0]),
            "preview" => Ok(json!(herdr::response_preview(string(0)))),
            "body" => Ok(json!(herdr::notification_body(string(0), string(1)))),
            _ => panic!("Unknown fixture operation"),
        };
        let expected = &row["expected"];
        match result {
            Ok(value) => assert_eq!(
                &value, &expected["value"],
                "Fixture {index}: {}",
                row["operation"]
            ),
            Err(error) => assert_eq!(
                json!(error),
                expected["error"],
                "Fixture {index}: {}",
                row["operation"]
            ),
        }
    }
}
#[test]
fn notification_histories_match_reference_checkpoints_and_transitions() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-migration/herdr.json"
    ))
    .unwrap();
    for row in corpus["states"].as_array().unwrap() {
        let mut tracker = Tracker::new(row.get("initial"));
        for step in row["steps"].as_array().unwrap() {
            if let Some(snapshot) = step.get("snapshot") {
                assert_eq!(json!(tracker.update(snapshot)), step["notifications"]);
                assert_eq!(
                    json!(tracker.status(&snapshot["agents"][0])),
                    step["status"]
                );
                assert_eq!(json!(tracker.attention()), step["attention"]);
            } else {
                assert_eq!(
                    json!(tracker.viewed(step["viewed"].as_str().unwrap())),
                    step["result"]
                );
            }
            assert_eq!(tracker.checkpoint(), step["checkpoint"]);
        }
    }
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
