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
async fn a_closed_terminal_controller_ends_quietly_before_history_detects_the_close() {
    let fixture = support::Fixture::new().await;
    let mut target = fixture.target.clone();
    target.binary = "/bin/false".into();
    let terminal = target
        .snapshot()
        .await
        .unwrap()
        .terminal("term_0")
        .unwrap()
        .clone();
    {
        let mut snapshot = fixture.snapshot.lock().unwrap();
        snapshot["workspaces"] = json!([]);
        snapshot["panes"] = json!([]);
        snapshot["agents"] = json!([]);
    }
    let (send, mut receive, _) = viewer_queue::channel();
    let cancel = CancellationToken::new();
    let view = View::open(
        target,
        terminal,
        &Hub::default(),
        &herdr_history::Hub::default(),
        Some((Size { cols: 40, rows: 30 }, None)),
        send,
        cancel.clone(),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match receive.recv().await.unwrap().message {
                Transport::Close(code, reason) => {
                    assert_eq!(code, 1000);
                    assert_eq!(reason, "Herdr terminal ended");
                    break;
                }
                message => assert_ne!(message.value().unwrap()["type"], "reading-error"),
            }
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    drop(view);
}

#[tokio::test]
async fn history_errors_reconcile_closed_moved_and_replaced_panes_before_reporting_failures() {
    for state in ["closed", "moved", "replaced", "live"] {
        let fixture = support::Fixture::new().await;
        let mut target = fixture.target.clone();
        target.binary = "/bin/false".into();
        let (metadata, mut snapshots) = tokio::sync::mpsc::channel(16);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(termai_server::herdr::metadata(
            target.clone(),
            metadata,
            cancel.clone(),
        ));
        snapshots.recv().await.unwrap();
        let terminal = target
            .snapshot()
            .await
            .unwrap()
            .terminal("term_0")
            .unwrap()
            .clone();
        let (send, mut receive, _) = viewer_queue::channel();
        let view = View::open(
            target,
            terminal,
            &Hub::default(),
            &herdr_history::Hub::default(),
            None,
            send,
            cancel.clone(),
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let item = receive.recv().await.unwrap();
                if let Some(value) = item.message.value()
                    && value["type"] == "screen"
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        {
            let mut snapshot = fixture.snapshot.lock().unwrap();
            match state {
                "closed" => {
                    snapshot["workspaces"] = json!([]);
                    snapshot["panes"] = json!([]);
                    snapshot["agents"] = json!([]);
                }
                "moved" => {
                    snapshot["panes"][0]["pane_id"] = json!("w1:p1");
                    snapshot["agents"][0]["pane_id"] = json!("w1:p1");
                }
                "replaced" => {
                    snapshot["panes"][0]["terminal_id"] = json!("term_new");
                    snapshot["agents"][0]["terminal_id"] = json!("term_new");
                }
                _ => {}
            }
        }
        // Withhold metadata events so the history failure must refresh a cached snapshot.
        let cached = fixture.target.snapshot().await.unwrap();
        assert_eq!(cached.terminals[0].terminal_id, "term_0");
        assert_eq!(cached.terminals[0].pane_id, "w1:p0");
        *fixture.read_error.lock().unwrap() = "Pane not found".into();
        let mut errors = Vec::new();
        let code = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match receive.recv().await.unwrap().message {
                    Transport::Close(code, _) => break code,
                    message => {
                        let value = message.value().unwrap();
                        if value["type"] == "reading-error" {
                            errors.push(value);
                        }
                    }
                }
            }
        })
        .await
        .unwrap();
        if state == "live" {
            assert_eq!(code, 1011);
            assert_eq!(errors.len(), 1);
            assert_eq!(errors[0]["message"], "Pane not found");
        } else {
            assert_eq!(code, 1000, "{state}");
            assert!(errors.is_empty(), "{state}: {errors:?}");
        }
        cancel.cancel();
        drop(view);
        task.await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rapid_input_and_commands_reach_herdr_in_receive_order() {
    let fixture = support::Fixture::new().await;
    let mut target = fixture.target.clone();
    target.binary = "/bin/false".into();
    let history = herdr_history::Hub::default();
    let frames = Hub::default();
    let (send, mut receive, _) = viewer_queue::channel();
    let cancel = CancellationToken::new();
    let view = View::open(
        target,
        fixture
            .target
            .snapshot()
            .await
            .unwrap()
            .terminal("term_0")
            .unwrap()
            .clone(),
        &frames,
        &history,
        None,
        send,
        cancel.clone(),
    )
    .unwrap();
    let mut expected = String::new();
    for i in 0..100 {
        let text = format!("[{i:03}]");
        expected.push_str(&text);
        view.receive(json!({"type":"input","data":text})).unwrap();
    }
    for text in ["\x1b[D", "界", "😀", "\x7f"] {
        view.receive(json!({"type":"input","data":text})).unwrap();
        expected.push_str(text);
    }
    view.receive(json!({"type":"paste","text":"literal paste"}))
        .unwrap();
    expected.push_str("literal paste");
    view.receive(json!({"type":"input","data":"tail"})).unwrap();
    expected.push_str("tail");
    view.receive(json!({"type":"command","id":"ordered","command":"done"}))
        .unwrap();
    expected.push_str("done\r");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let item = receive.recv().await.unwrap();
            if let Some(value) = item.message.value()
                && value["type"] == "result"
                && value["id"] == "ordered"
            {
                assert_eq!(value["accepted"], true);
                break;
            }
        }
    })
    .await
    .unwrap();
    let actions = fixture.actions.lock().unwrap();
    let sends: Vec<_> = actions
        .iter()
        .filter(|action| {
            matches!(
                action["method"].as_str(),
                Some("pane.send_text" | "pane.send_input")
            )
        })
        .collect();
    let actual = sends
        .iter()
        .map(|action| action["params"]["text"].as_str().unwrap())
        .collect::<String>();
    assert_eq!(actual, expected);
    assert!(
        sends.len() < 100,
        "Queued typing should use fewer Herdr calls"
    );
    for control in ["\x1b[D", "\x7f", "done\r"] {
        assert!(
            sends
                .iter()
                .any(|action| action["params"]["text"] == control)
        );
    }
    assert!(
        sends
            .iter()
            .any(|action| action["method"] == "pane.send_input"
                && action["params"]["text"] == "literal paste")
    );
    drop(actions);
    cancel.cancel();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typing_reuses_pane_validation_until_herdr_reports_a_change() {
    let fixture = support::Fixture::new().await;
    let mut target = fixture.target.clone();
    target.binary = "/bin/false".into();
    let count = |method: &str| {
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .filter(|action| action["method"] == method)
            .count()
    };
    let wait = |method: &'static str, expected: usize| {
        let count = &count;
        async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                while count(method) < expected {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{method} reached {expected}"));
        }
    };
    let (send, _receive, _) = viewer_queue::channel();
    let cancel = CancellationToken::new();
    let view = View::open(
        target.clone(),
        target
            .snapshot()
            .await
            .unwrap()
            .terminal("term_0")
            .unwrap()
            .clone(),
        &Hub::default(),
        &herdr_history::Hub::default(),
        None,
        send,
        cancel.clone(),
    )
    .unwrap();
    // Without watched events, every keystroke proves its pane first.
    for i in 1..=2 {
        view.receive(json!({"type":"input","data":"u"})).unwrap();
        wait("pane.send_text", i).await;
    }
    assert_eq!(count("pane.get"), 2);
    let (metadata, mut snapshots) = tokio::sync::mpsc::channel(16);
    let task = tokio::spawn(termai_server::herdr::metadata(
        target.clone(),
        metadata,
        cancel.clone(),
    ));
    snapshots.recv().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while target.layout_epoch().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    for i in 3..=7 {
        view.receive(json!({"type":"input","data":"w"})).unwrap();
        wait("pane.send_text", i).await;
    }
    assert_eq!(
        count("pane.get"),
        3,
        "a watched typing burst validates once"
    );
    let before = target.layout_epoch();
    fixture.notify();
    tokio::time::timeout(Duration::from_secs(5), async {
        while target.layout_epoch() == before {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    view.receive(json!({"type":"input","data":"e"})).unwrap();
    wait("pane.send_text", 8).await;
    assert_eq!(
        count("pane.get"),
        4,
        "a Herdr event requires a fresh validation"
    );
    cancel.cancel();
    task.await.unwrap();
}

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
        fixture
            .target
            .snapshot()
            .await
            .unwrap()
            .terminal("term_0")
            .unwrap()
            .clone(),
        &frames,
        &history,
        Some((Size { cols: 40, rows: 30 }, Some(6))),
        send,
        cancel.clone(),
    )
    .unwrap();
    let mut messages: Vec<Value> = vec![];
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let item = receive.recv().await.unwrap();
            if let Some(value) = item.message.value() {
                let mobile = value["type"] == "herdr-frame" && value["width"] == 40;
                messages.push(value);
                if mobile {
                    break;
                }
            }
        }
    })
    .await
    .expect("A mobile-sized Herdr frame must arrive before checking the redraw barrier");
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
        if let Some(value) = item.message.value() {
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
            if let Some(value) = item.message.value()
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
            if let Some(value) = item.message.value()
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
