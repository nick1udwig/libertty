#[path = "support/herdr.rs"]
mod support;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use libertty_server::notifications::{self, DeliveryError, Notifications, Push, Sender};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::Fixture;

fn subscription() -> Value {
    let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
    json!({"endpoint":"https://fcm.googleapis.com/fcm/send/test-device","keys":{"p256dh":URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes()),"auth":URL_SAFE_NO_PAD.encode([13u8;16])}})
}
async fn until(check: impl Fn() -> bool) {
    let end = tokio::time::Instant::now() + Duration::from_secs(6);
    while !check() {
        assert!(
            tokio::time::Instant::now() < end,
            "Notification check timed out"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn initialized(directory: &std::path::Path) {
    until(|| {
        std::fs::read(directory.join("herdr-push.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|v| {
                v["checkpoints"]
                    .as_object()
                    .is_some_and(|c| c.values().any(|s| s["term_0"]["raw"].is_string()))
            })
    })
    .await;
}
#[test]
fn only_browser_services_with_valid_encryption_keys_are_accepted_and_delivery_is_encrypted() {
    let input = subscription();
    assert_eq!(json!(notifications::subscription(&input).unwrap()), input);
    for endpoint in [
        "http://fcm.googleapis.com/test",
        "https://127.0.0.1/test",
        "https://localhost/test",
        "https://fcm.googleapis.com.attacker.test/test",
        "https://user:pass@fcm.googleapis.com/test",
        "https://fcm.googleapis.com:8443/test",
    ] {
        let mut invalid = input.clone();
        invalid["endpoint"] = json!(endpoint);
        assert!(notifications::subscription(&invalid).is_err(), "{endpoint}");
    }
    for endpoint in [
        "https://updates.push.services.mozilla.com/wpush/v2/test",
        "https://web.push.apple.com/test",
        "https://example.notify.windows.com/test",
    ] {
        let mut valid = input.clone();
        valid["endpoint"] = json!(endpoint);
        assert_eq!(
            notifications::subscription(&valid).unwrap().endpoint,
            endpoint
        );
    }
    let mut invalid = input.clone();
    invalid["keys"] = json!({"p256dh":"bad","auth":"bad"});
    assert!(notifications::subscription(&invalid).is_err());
    let mut point = [0; 65];
    point[0] = 4;
    invalid = input.clone();
    invalid["keys"]["p256dh"] = json!(URL_SAFE_NO_PAD.encode(point));
    assert!(notifications::subscription(&invalid).is_err());
    let directory = tempfile::tempdir().unwrap();
    let push = Push::open(directory.path(), "https://example.com/libertty").unwrap();
    let text = "Private agent response";
    let message = push
        .message(&notifications::subscription(&input).unwrap(), text)
        .unwrap();
    assert_eq!(message.ttl, 3600);
    assert_eq!(message.urgency, Some(web_push::Urgency::High));
    assert_eq!(
        message.endpoint.to_string(),
        input["endpoint"].as_str().unwrap()
    );
    let payload = message.payload.unwrap();
    assert_eq!(payload.content_encoding.to_str(), "aes128gcm");
    assert!(payload.crypto_headers.iter().any(|(key, value)| {
        key.eq_ignore_ascii_case("authorization") && value.starts_with("vapid ")
    }));
    assert!(
        !payload
            .content
            .windows(text.len())
            .any(|v| v == text.as_bytes())
    );
    assert_eq!(
        Push::open(directory.path(), "https://example.com/libertty")
            .unwrap()
            .public,
        push.public
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(directory.path().join("push-keys.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[tokio::test]
async fn alerts_preserve_ownership_focus_acknowledgements_previews_and_restart_watches() {
    let fixture = Fixture::new().await;
    let directory = fixture.directory.path().join("push");
    let owner = "a".repeat(64);
    let other = "b".repeat(64);
    let owner_hash = notifications::hash(&owner);
    let check = Arc::new(move |hash: &str| hash == owner_hash);
    let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = sent.clone();
    let send: Sender = Arc::new(move |_, text| {
        let sent = received.clone();
        Box::pin(async move {
            sent.lock()
                .unwrap()
                .push(serde_json::from_str(&text).unwrap());
            Ok(())
        })
    });
    let mut manager = Notifications::open(
        &directory,
        check.clone(),
        Some(send.clone()),
        "https://example.com/libertty",
    )
    .unwrap();
    let device = manager.subscribe(&owner, &subscription()).unwrap();
    let tab = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    assert!(
        manager
            .add_view(&other, &device, tab, "", &fixture.target)
            .is_err()
    );
    manager
        .add_view(&owner, &device, tab, "", &fixture.target)
        .unwrap();
    initialized(&directory).await;
    assert!(sent.lock().unwrap().is_empty());
    *fixture.screen.lock().unwrap()="\x1b[32m• Updated the parser. All tests passed.\x1b[0m\n\nWorked for 12s\n\n╭────────────╮\n│ › ask again │\n╰────────────╯\nmodel · footer".into();
    fixture.update("idle");
    until(|| sent.lock().unwrap().len() == 1).await;
    let first = sent.lock().unwrap()[0].clone();
    assert_eq!(
        first["body"],
        "Updated the parser. All tests passed.\n/workspace"
    );
    assert_eq!(first["title"], "API");
    assert_eq!(first["tabId"], tab);
    assert_eq!(first["terminalId"], "term_0");
    assert_eq!(
        fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .rfind(|a| a["method"] == "pane.read")
            .unwrap()["params"]["format"],
        "ansi"
    );
    manager.presence("socket", &owner, &device, true).unwrap();
    fixture.update("working");
    tokio::time::sleep(Duration::from_millis(180)).await;
    fixture.update("blocked");
    tokio::time::sleep(Duration::from_millis(180)).await;
    let event = serde_json::from_value(json!({"terminalId":"term_0","kind":"request","sequence":fixture.snapshot.lock().unwrap()["agents"][0]["state_change_seq"]})).unwrap();
    manager
        .acknowledge(&owner, &device, "", &fixture.target, &event)
        .unwrap();
    assert_eq!(sent.lock().unwrap().len(), 1);
    manager.presence("socket", &owner, &device, false).unwrap();
    fixture.update("working");
    tokio::time::sleep(Duration::from_millis(180)).await;
    fixture.update("blocked");
    until(|| sent.lock().unwrap().len() == 2).await;
    manager.presence("socket", &owner, &device, true).unwrap();
    fixture.update("working");
    tokio::time::sleep(Duration::from_millis(180)).await;
    fixture.update("idle");
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(sent.lock().unwrap().len(), 2);
    manager.disconnected("socket");
    until(|| sent.lock().unwrap().len() == 3).await;
    manager.dispose();
    let stored = std::fs::read_to_string(directory.join("herdr-push.json")).unwrap();
    assert!(!stored.contains(&owner));
    assert!(!stored.contains("Updated the parser"));
    assert!(!stored.contains("Live Herdr terminal"));
    let mut saved: Value = serde_json::from_str(&stored).unwrap();
    saved["devices"][0]["futureDevice"] = json!({"retained":true});
    saved["devices"][0]["views"][0]["futureView"] = json!(["retained"]);
    std::fs::write(directory.join("herdr-push.json"), saved.to_string()).unwrap();
    manager = Notifications::open(
        &directory,
        check,
        Some(send),
        "https://example.com/libertty",
    )
    .unwrap();
    let mut updated = subscription();
    updated["keys"]["auth"] = json!("BQUFBQUFBQUFBQUFBQUFBQ");
    manager.subscribe(&owner, &updated).unwrap();
    until(|| {
        let saved: Value =
            serde_json::from_slice(&std::fs::read(directory.join("herdr-push.json")).unwrap())
                .unwrap();
        saved["devices"][0]["subscription"]["keys"]["auth"] == updated["keys"]["auth"]
            && saved["devices"][0]["futureDevice"] == json!({"retained":true})
            && saved["devices"][0]["views"][0]["futureView"] == json!(["retained"])
    })
    .await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(sent.lock().unwrap().len(), 3);
    fixture.update("working");
    tokio::time::sleep(Duration::from_millis(180)).await;
    fixture.update("idle");
    until(|| sent.lock().unwrap().len() == 4).await;
    manager.remove_view(&owner, &device, tab).unwrap();
    fixture.update("working");
    tokio::time::sleep(Duration::from_millis(180)).await;
    fixture.update("idle");
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(sent.lock().unwrap().len(), 4);
    manager.dispose();
}
#[tokio::test]
async fn expired_devices_and_revoked_pairings_stop_deliveries_and_recycled_panes_have_no_preview() {
    let fixture = Fixture::new().await;
    let directory = fixture.directory.path().join("push");
    let valid = Arc::new(AtomicBool::new(true));
    let owner = "a".repeat(64);
    let owner_hash = notifications::hash(&owner);
    let owner_valid = valid.clone();
    let sends = Arc::new(AtomicUsize::new(0));
    let count = sends.clone();
    let send: Sender = Arc::new(move |_, _| {
        let count = count.clone();
        Box::pin(async move {
            count.fetch_add(1, Ordering::SeqCst);
            Err(DeliveryError {
                status: Some(410),
                message: "Expired".into(),
            })
        })
    });
    let manager = Notifications::open(
        &directory,
        Arc::new(move |hash: &str| owner_valid.load(Ordering::SeqCst) && hash == owner_hash),
        Some(send),
        "https://example.com/libertty",
    )
    .unwrap();
    let device = manager.subscribe(&owner, &subscription()).unwrap();
    let tab = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    manager
        .add_view(&owner, &device, tab, "", &fixture.target)
        .unwrap();
    initialized(&directory).await;
    fixture.update("idle");
    until(|| sends.load(Ordering::SeqCst) == 1).await;
    until(|| {
        manager
            .add_view(&owner, &device, tab, "", &fixture.target)
            .is_err()
    })
    .await;
    let next = manager.subscribe(&owner, &subscription()).unwrap();
    manager
        .add_view(&owner, &next, tab, "", &fixture.target)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    valid.store(false, Ordering::SeqCst);
    fixture.update("working");
    tokio::time::sleep(Duration::from_millis(180)).await;
    fixture.update("idle");
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    let agent = fixture.target.snapshot().await.unwrap().agents[0].clone();
    fixture.snapshot.lock().unwrap()["panes"][0]["terminal_id"] = json!("replacement");
    fixture.actions.lock().unwrap().clear();
    assert!(fixture.target.preview(&agent).await.is_empty());
    assert!(
        !fixture
            .actions
            .lock()
            .unwrap()
            .iter()
            .any(|a| a["method"] == "pane.read")
    );
    manager.dispose();
}
