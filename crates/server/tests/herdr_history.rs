use libertty_server::herdr_history::Hub;
use std::time::Duration;
#[path = "support/herdr.rs"]
mod support;

#[tokio::test]
async fn shared_history_replays_changes_without_duplicate_polls_and_stops_with_last_viewer() {
    let fixture = support::Fixture::new().await;
    let other = support::Fixture::new().await;
    let hub = Hub::default();
    let mut first = hub
        .subscribe(fixture.target.clone(), "w1:p0".into())
        .unwrap();
    first.receive.changed().await.unwrap();
    let mut second = hub
        .subscribe(fixture.target.clone(), "w1:p0".into())
        .unwrap();
    assert_eq!(
        first
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .value()["text"],
        second
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .value()["text"]
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(220), second.receive.changed())
            .await
            .is_err()
    );
    assert!(
        fixture.actions.lock().unwrap().len() <= 2,
        "two viewers must share one poll"
    );
    second.refresh.notify_one();
    second.receive.changed().await.unwrap();
    assert_eq!(
        second
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .value()["text"],
        "Live Herdr terminal"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(180), second.receive.changed())
            .await
            .is_err()
    );
    let mut isolated = hub.subscribe(other.target.clone(), "w1:p0".into()).unwrap();
    isolated.receive.changed().await.unwrap();
    *fixture.screen.lock().unwrap() = "changed 界😀".into();
    second.receive.changed().await.unwrap();
    assert_eq!(
        second
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .value()["text"],
        "changed 界😀"
    );
    assert_eq!(
        isolated
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .value()["text"],
        "Live Herdr terminal"
    );
    drop(first);
    drop(second);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let count = fixture.actions.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert_eq!(fixture.actions.lock().unwrap().len(), count);
    let mut reopened = hub
        .subscribe(fixture.target.clone(), "w1:p0".into())
        .unwrap();
    reopened.receive.changed().await.unwrap();
    assert_eq!(
        reopened
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .value()["text"],
        "changed 界😀"
    );
}

#[tokio::test]
async fn unchanged_metadata_is_suppressed_but_changed_status_is_delivered() {
    let fixture = support::Fixture::new().await;
    let (send, mut receive) = tokio::sync::mpsc::channel(16);
    let cancel = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(libertty_server::herdr::metadata(
        fixture.target.clone(),
        send,
        cancel.clone(),
    ));
    assert_eq!(receive.recv().await.unwrap().value()["type"], "snapshot");
    tokio::time::sleep(Duration::from_millis(100)).await;
    fixture.notify();
    assert!(
        tokio::time::timeout(Duration::from_millis(220), receive.recv())
            .await
            .is_err()
    );
    fixture.update("idle");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), receive.recv())
            .await
            .unwrap()
            .unwrap()
            .value()["snapshot"]["agents"][0]["status"],
        "idle"
    );
    cancel.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn a_live_frame_stream_replaces_interval_polling_with_reads_on_activity() {
    let fixture = support::Fixture::new().await;
    let hub = Hub::default();
    let mut history = hub
        .subscribe(fixture.target.clone(), "w1:p0".into())
        .unwrap();
    history.receive.changed().await.unwrap();
    let reads = || {
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .filter(|action| action["method"] == "pane.read")
            .count()
    };
    // Without frames the pane keeps the polling cadence.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(reads() >= 3, "polling without a stream: {}", reads());
    hub.activity(&fixture.target, "w1:p0", true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let quiet = reads();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(reads(), quiet, "a quiet streamed pane is not reread");
    fixture.screen.lock().unwrap().push_str(" with new output");
    hub.activity(&fixture.target, "w1:p0", true);
    tokio::time::timeout(Duration::from_millis(500), history.receive.changed())
        .await
        .expect("a frame prompts a history read")
        .unwrap();
    assert_eq!(reads(), quiet + 1);
    // An empty reset frame means the stream stopped, so polling resumes.
    hub.activity(&fixture.target, "w1:p0", false);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(reads() >= quiet + 4, "polling resumes: {}", reads());
}
