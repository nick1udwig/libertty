use serde_json::json;
use std::time::Duration;
use termai_server::herdr_history::Hub;
#[path = "support/herdr.rs"]
mod support;

#[tokio::test]
async fn shared_history_replays_changes_without_duplicate_polls_and_stops_with_last_viewer() {
    let fixture = support::Fixture::new().await;
    let other = support::Fixture::new().await;
    let hub = Hub::default();
    let mut first = hub
        .subscribe(fixture.target.clone(), json!("w1:p0"))
        .unwrap();
    first.receive.changed().await.unwrap();
    let mut second = hub
        .subscribe(fixture.target.clone(), json!("w1:p0"))
        .unwrap();
    assert_eq!(
        first.receive.borrow().as_ref().unwrap().as_ref().unwrap()["text"],
        second.receive.borrow().as_ref().unwrap().as_ref().unwrap()["text"]
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
    let mut isolated = hub.subscribe(other.target.clone(), json!("w1:p0")).unwrap();
    isolated.receive.changed().await.unwrap();
    *fixture.screen.lock().unwrap() = "changed 界😀".into();
    second.receive.changed().await.unwrap();
    assert_eq!(
        second.receive.borrow().as_ref().unwrap().as_ref().unwrap()["text"],
        "changed 界😀"
    );
    assert_eq!(
        isolated
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()["text"],
        "Live Herdr terminal"
    );
    drop(first);
    drop(second);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let count = fixture.actions.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert_eq!(fixture.actions.lock().unwrap().len(), count);
    let mut reopened = hub
        .subscribe(fixture.target.clone(), json!("w1:p0"))
        .unwrap();
    reopened.receive.changed().await.unwrap();
    assert_eq!(
        reopened
            .receive
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()["text"],
        "changed 界😀"
    );
}

#[tokio::test]
async fn unchanged_metadata_is_suppressed_but_changed_status_is_delivered() {
    let fixture = support::Fixture::new().await;
    let (send, mut receive) = tokio::sync::mpsc::channel(16);
    let cancel = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(termai_server::herdr::metadata(
        fixture.target.clone(),
        send,
        cancel.clone(),
    ));
    assert_eq!(receive.recv().await.unwrap()["type"], "snapshot");
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
            .unwrap()["snapshot"]["agents"][0]["status"],
        "idle"
    );
    cancel.cancel();
    task.await.unwrap();
}
