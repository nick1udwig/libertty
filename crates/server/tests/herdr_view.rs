use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, sync::atomic::Ordering, time::Duration};
use termai_server::{
    herdr_history,
    herdr_terminal_stream::{Hub, Size},
    herdr_view::View,
    session::Transport,
    viewer_queue,
};
use tokio_util::sync::CancellationToken;
#[path = "support/herdr.rs"]
mod support;

#[tokio::test]
async fn layout_waits_for_pty_output_and_parked_views_keep_geometry_without_updates() {
    let fixture = support::Fixture::new().await;
    let mut target = fixture.target.clone();
    let binary = fixture.directory.path().join("terminal");
    std::fs::write(&binary, include_str!("support/terminal.py")).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    target.binary = binary.to_string_lossy().into_owned();
    target.env.insert(
        "TEST_TERMINAL_LOG".into(),
        fixture
            .directory
            .path()
            .join("log")
            .to_string_lossy()
            .into_owned(),
    );
    target.env.insert(
        "TEST_TERMINAL_FRAME".into(),
        fixture
            .directory
            .path()
            .join("frame")
            .to_string_lossy()
            .into_owned(),
    );
    fixture.content_revision.store(8, Ordering::Relaxed);
    let history = herdr_history::Hub::default();
    let frames = Hub::default();
    let (send, mut receive, _) = viewer_queue::channel();
    let cancel = CancellationToken::new();
    let view = View::open(
        target,
        json!({"terminalId":"term_0","paneId":"w1:p0","cwd":"/fixture"}),
        &frames,
        &history,
        Some((Size { cols: 40, rows: 30 }, Some(6))),
        send,
        cancel.clone(),
    )
    .unwrap();
    let mut messages: Vec<Value> = vec![];
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(item) = receive.try_recv() {
        if let Transport::Message(value) = item.message {
            messages.push(value);
        }
    }
    assert!(
        messages
            .iter()
            .any(|value| value["type"] == "herdr-frame" && value["width"] == 40)
    );
    assert!(
        !messages
            .iter()
            .any(|value| value["type"] == "herdr-layout" && value["ready"] == true),
        "Geometry-only revision must not reveal inherited content"
    );
    view.receive(json!({"type":"herdr-active","active":false}))
        .unwrap();
    view.receive(json!({"type":"herdr-active","active":true}))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(item) = receive.try_recv() {
        if let Transport::Message(value) = item.message {
            assert!(
                value["type"] != "herdr-layout" || value["ready"] != true,
                "Returning during a resize must retain the original redraw fence"
            );
        }
    }
    fixture.content_revision.store(10, Ordering::Relaxed);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let item = receive.recv().await.unwrap();
            if let Transport::Message(value) = item.message
                && value["type"] == "herdr-layout"
                && value["ready"] == true
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    view.receive(json!({"type":"herdr-active","active":false}))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    while receive.try_recv().is_ok() {}
    let polls = fixture.actions.lock().unwrap().len();
    *fixture.screen.lock().unwrap() = "new while parked".into();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        fixture.actions.lock().unwrap().len(),
        polls,
        "Parked-only history must not poll the host"
    );
    assert!(receive.try_recv().is_err());
    assert!(
        view.receive(json!({"type":"herdr-active","active":"bad"}))
            .is_err()
    );
    view.receive(json!({"type":"herdr-active","active":true}))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let item = receive.recv().await.unwrap();
            if let Transport::Message(value) = item.message
                && value["type"] == "screen"
            {
                assert_eq!(value["text"], "new while parked");
                break;
            }
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    drop(view);
}
