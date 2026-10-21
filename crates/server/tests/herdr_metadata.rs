use libertty_server::herdr::{Status, Target, metadata};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};
use tokio_util::sync::CancellationToken;
#[path = "support/herdr.rs"]
mod support;

fn count(fixture: &support::Fixture, method: &str) -> usize {
    fixture
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request["method"] == method)
        .count()
}
async fn next(
    receive: &mut tokio::sync::mpsc::Receiver<libertty_server::herdr::Metadata>,
) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(2), receive.recv())
        .await
        .unwrap()
        .unwrap()
        .value()
}

#[tokio::test]
async fn independent_targets_share_subscriptions_and_cache_until_last_listener_leaves() {
    let fixture = support::Fixture::new().await;
    let mut independent = Target::local("").unwrap();
    independent.socket_path = fixture.target.socket_path.clone();
    let (send, mut first) = tokio::sync::mpsc::channel(16);
    let one = CancellationToken::new();
    let task_one = tokio::spawn(metadata(fixture.target.clone(), send, one.clone()));
    next(&mut first).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (send, mut second) = tokio::sync::mpsc::channel(16);
    let two = CancellationToken::new();
    let task_two = tokio::spawn(metadata(independent.clone(), send, two.clone()));
    assert_eq!(next(&mut second).await["type"], "snapshot");
    assert_eq!(count(&fixture, "events.subscribe"), 1);
    let snapshots = count(&fixture, "session.snapshot");
    let connections = fixture.connections.load(Ordering::Relaxed);
    for _ in 0..8 {
        independent.snapshot().await.unwrap();
    }
    assert_eq!(count(&fixture, "session.snapshot"), snapshots);
    assert_eq!(fixture.connections.load(Ordering::Relaxed), connections);
    fixture.update("idle");
    assert_eq!(
        next(&mut first).await["snapshot"]["agents"][0]["status"],
        "idle"
    );
    assert_eq!(
        next(&mut second).await["snapshot"]["agents"][0]["status"],
        "idle"
    );
    assert_eq!(count(&fixture, "session.snapshot"), snapshots + 1);
    independent
        .action(&json!({"action":"rename","terminalId":"term_0","name":"Renamed"}))
        .await
        .unwrap();
    assert_eq!(
        independent.snapshot().await.unwrap().terminals[0].name,
        "Renamed"
    );
    one.cancel();
    task_one.await.unwrap();
    fixture.update("working");
    loop {
        if next(&mut second).await["snapshot"]["agents"][0]["status"] == "working" {
            break;
        }
    }
    two.cancel();
    task_two.await.unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    let requests = count(&fixture, "session.snapshot");
    fixture.update("done");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(count(&fixture, "session.snapshot"), requests);
    assert_eq!(
        independent.snapshot().await.unwrap().agents[0].status,
        Status::Done
    );
    let (send, mut reopened) = tokio::sync::mpsc::channel(16);
    let cancel = CancellationToken::new();
    let task = tokio::spawn(metadata(independent, send, cancel.clone()));
    assert_eq!(
        next(&mut reopened).await["snapshot"]["agents"][0]["status"],
        "done"
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while count(&fixture, "events.subscribe") != 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn separate_sockets_never_share_cached_metadata() {
    let first = support::Fixture::new().await;
    let second = support::Fixture::new().await;
    second.update("idle");
    let (send, mut receive) = tokio::sync::mpsc::channel(16);
    let cancel = CancellationToken::new();
    let task = tokio::spawn(metadata(first.target.clone(), send, cancel.clone()));
    next(&mut receive).await;
    assert_eq!(
        first.target.snapshot().await.unwrap().agents[0].status,
        Status::Working
    );
    assert_eq!(
        second.target.snapshot().await.unwrap().agents[0].status,
        Status::Idle
    );
    cancel.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn cached_pane_addresses_cannot_rename_a_recycled_terminal() {
    let fixture = support::Fixture::new().await;
    let (send, mut receive) = tokio::sync::mpsc::channel(16);
    let cancel = CancellationToken::new();
    let task = tokio::spawn(metadata(fixture.target.clone(), send, cancel.clone()));
    next(&mut receive).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    fixture.snapshot.lock().unwrap()["panes"][0]["terminal_id"] = json!("term_recycled");
    // No event has arrived: the hub still contains the old terminal address.
    assert!(
        fixture
            .target
            .snapshot()
            .await
            .unwrap()
            .terminal("term_0")
            .is_some()
    );
    for action in [
        json!({"action":"rename","terminalId":"term_0","name":"Wrong terminal"}),
        json!({"action":"close","terminalId":"term_0"}),
        json!({"action":"split","workspaceId":"w1","terminalId":"term_0","direction":"down"}),
    ] {
        assert!(
            fixture
                .target
                .action(&action)
                .await
                .unwrap_err()
                .contains("ended or moved")
        );
    }
    assert_eq!(count(&fixture, "pane.rename"), 0);
    assert_eq!(count(&fixture, "pane.close"), 0);
    assert_eq!(count(&fixture, "pane.split"), 0);
    cancel.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn one_shot_rpc_connections_never_replay_actions_and_cancelled_calls_are_closed() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rpc.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let mut target = Target::local("").unwrap();
    target.socket_path = Some(path.to_string_lossy().into_owned());
    let (send, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let send = send.clone();
            tokio::spawn(async move {
                let mut stream = BufReader::new(stream);
                let Some(request) = libertty_server::herdr::read_line(&mut stream)
                    .await
                    .unwrap()
                else {
                    return;
                };
                send.send(request["method"].as_str().unwrap().to_owned())
                    .unwrap();
                match request["method"].as_str().unwrap() {
                    "pane.rename" => {} // Simulate an applied action with a lost reply.
                    "wait" => {
                        let mut byte = [0];
                        assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
                    }
                    _ => {
                        stream
                            .get_mut()
                            .write_all(
                                format!("{}\n", json!({"id":request["id"],"result":{"ok":true}}))
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                }
            });
        }
    });
    for _ in 0..3 {
        assert_eq!(
            target.request("pane.get", json!({})).await.unwrap()["ok"],
            true
        );
    }
    assert!(target.request("pane.rename", json!({})).await.is_err());
    assert!(target.request("pane.get", json!({})).await.is_ok());
    assert!(
        tokio::time::timeout(Duration::from_millis(80), target.request("wait", json!({})))
            .await
            .is_err()
    );
    assert!(target.request("pane.get", json!({})).await.is_ok());
    let mut seen = Vec::new();
    while let Ok(method) = requests.try_recv() {
        seen.push(method);
    }
    assert_eq!(
        seen.iter()
            .filter(|method| *method == "pane.rename")
            .count(),
        1
    );
    assert_eq!(
        seen.iter().filter(|method| *method == "pane.get").count(),
        5
    );
    server.abort();
}
