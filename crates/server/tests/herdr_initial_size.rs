use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, time::Duration};
use termai_server::{
    herdr::Target,
    herdr_terminal_stream::{Hub, Size},
};
use tokio::sync::mpsc;

#[tokio::test]
async fn initial_mobile_geometry_opens_control_directly_and_does_not_replay_other_sizes() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("herdr");
    std::fs::write(&binary, include_str!("support/terminal.py")).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut target = Target::local("").unwrap();
    target.binary = binary.to_string_lossy().into_owned();
    target.socket_path = Some(
        root.path()
            .join("herdr.sock")
            .to_string_lossy()
            .into_owned(),
    );
    let log = root.path().join("log");
    target.env.insert(
        "TEST_TERMINAL_LOG".into(),
        log.to_string_lossy().into_owned(),
    );
    target.env.insert(
        "TEST_TERMINAL_FRAME".into(),
        root.path().join("frame").to_string_lossy().into_owned(),
    );
    let hub = Hub::default();
    let (send, mut receive) = mpsc::channel(128);
    let phone = hub
        .subscribe_sized(
            target.clone(),
            "term_0".into(),
            send,
            Some(Size { cols: 40, rows: 30 }),
        )
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.value()["width"], 40);
    assert_eq!(first.value()["height"], 30);
    assert_eq!(first.value()["full"], true);
    let entries: Vec<Value> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0]["arguments"],
        json!([
            "terminal", "session", "control", "term_0", "--cols", "40", "--rows", "30"
        ])
    );
    std::fs::write(root.path().join("frame"), json!({"type":"terminal.frame","encoding":"ansi","width":40,"height":30,"full":false,"bytes":"YWJj"}).to_string()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while receive.recv().await.unwrap().value()["full"] != false {}
    })
    .await
    .unwrap();
    let (send, mut joined) = mpsc::channel(128);
    let same_size = hub
        .subscribe_sized(
            target.clone(),
            "term_0".into(),
            send,
            Some(Size { cols: 40, rows: 30 }),
        )
        .unwrap();
    let baseline = tokio::time::timeout(Duration::from_secs(3), joined.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(baseline.value()["width"], 40);
    assert_eq!(
        baseline.value()["full"],
        true,
        "Joining an incremental stream must request a complete baseline"
    );
    drop(same_size);
    let (send, mut second) = mpsc::channel(128);
    let other = hub
        .subscribe_sized(
            target.clone(),
            "term_0".into(),
            send,
            Some(Size { cols: 38, rows: 28 }),
        )
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(3), second.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        first.value()["width"],
        38,
        "Do not replay the previous viewer's grid"
    );
    drop(other);
    tokio::time::timeout(Duration::from_secs(3), async {
        while receive.recv().await.unwrap().value()["width"] != 40 {}
    })
    .await
    .unwrap();
    let (send, _) = mpsc::channel(1);
    assert!(
        hub.subscribe_sized(
            target,
            "term_0".into(),
            send,
            Some(Size {
                cols: 1001,
                rows: 30
            })
        )
        .is_err()
    );
    drop(phone);
}
