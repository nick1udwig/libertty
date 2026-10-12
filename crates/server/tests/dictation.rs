use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use termai_server::dictation::{self, Recording};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};
fn capabilities() -> Value {
    json!({"type":"capabilities","protocol":2,"dictation":true,"sample_rate":16000,"channels":1,"format":"opus","framing":"sequence_opus_v1","audio_encodings":["opus_v1"],"results":["partial","final"]})
}
fn ready() -> Value {
    json!({"type":"ready","protocol":2,"sample_rate":16000,"channels":1,"format":"opus","audio_encoding":"opus_v1","framing":"sequence_opus_v1","max_seconds":300,"max_encoded_bytes":2097152,"resume":true,"accepted_frames":0,"finished":false})
}
fn frame(sequence: u64, final_frame: bool, packet: bool) -> Vec<u8> {
    let mut bytes = sequence.to_be_bytes().to_vec();
    bytes.extend([1, u8::from(sequence == 0) | u8::from(final_frame) << 1]);
    bytes.extend(0u16.to_be_bytes());
    bytes.extend(if final_frame { 1600u32 } else { 0 }.to_be_bytes());
    bytes.push(u8::from(packet));
    if packet {
        bytes.extend([0, 3, 0xf8, 0xff, 0xfe]);
    }
    bytes
}
#[test]
fn capability_negotiation_and_binary_opus_validation_reject_older_or_malformed_inputs() {
    assert!(dictation::compatible(&capabilities()));
    for patch in [
        json!({"protocol":1}),
        json!({"sample_rate":48000}),
        json!({"results":["partial"]}),
        json!({"dictation":false}),
        json!({"format":"pcm_s16le"}),
        json!({"audio_encodings":["pcm_zlib_v1"]}),
        json!({"framing":null}),
    ] {
        let mut caps = capabilities();
        for (key, value) in patch.as_object().unwrap() {
            caps[key] = value.clone();
        }
        assert!(!dictation::compatible(&caps));
    }
    let encoded = frame(0, true, true);
    let parsed = dictation::parse_opus_frame(&encoded).unwrap();
    assert!(parsed.first && parsed.final_frame);
    assert_eq!(parsed.total_samples, 1600);
    assert_eq!(parsed.packets, vec![vec![0xf8, 0xff, 0xfe]]);
    for bytes in [vec![0; 16], vec![0; 6403], vec![0; 3200]] {
        assert!(dictation::parse_opus_frame(&bytes).is_err());
    }
    let mut invalid = encoded.clone();
    invalid.push(0);
    assert_eq!(
        dictation::parse_opus_frame(&invalid).err().unwrap(),
        "Trailing Opus frame bytes."
    );
    let mut invalid = encoded;
    invalid[16] = 6;
    assert_eq!(
        dictation::parse_opus_frame(&invalid).err().unwrap(),
        "Invalid Opus frame header."
    );
}
#[tokio::test]
// Tungstenite's handshake callback fixes the error type to an HTTP response.
#[allow(clippy::result_large_err)]
async fn authenticated_daemon_negotiation_inserts_only_final_safe_transcripts_and_cancels_failures()
{
    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = "test-secret-".repeat(4);
    let env = BTreeMap::from([
        ("HOME".into(), root.path().to_string_lossy().into_owned()),
        (
            "TERMAI_VOXTYPE_TOKEN_FILE".into(),
            root.path().join("token").to_string_lossy().into_owned(),
        ),
        (
            "TERMAI_VOXTYPE_URL".into(),
            format!("ws://127.0.0.1:{port}/v1/dictate"),
        ),
    ]);
    let transcript = Arc::new(Mutex::new("hello\nworld".to_owned()));
    let ready_event = Arc::new(Mutex::new(ready()));
    let admissions = Arc::new(AtomicUsize::new(0));
    let acks = Arc::new(AtomicUsize::new(0));
    let cancels = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(AtomicUsize::new(0));
    let task = {
        let transcript = transcript.clone();
        let ready_event = ready_event.clone();
        let admissions = admissions.clone();
        let acks = acks.clone();
        let cancels = cancels.clone();
        let received = received.clone();
        let token = token.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let transcript = transcript.clone();
                let ready_event = ready_event.clone();
                let admissions = admissions.clone();
                let acks = acks.clone();
                let cancels = cancels.clone();
                let received = received.clone();
                let token = token.clone();
                tokio::spawn(async move {
                    let capability = Arc::new(AtomicUsize::new(0));
                    let marker = capability.clone();
                    let mut socket =
                        accept_hdr_async(stream, move |request: &Request, response: Response| {
                            assert_eq!(
                                request.headers()["authorization"],
                                format!("Bearer {token}")
                            );
                            assert!(request.headers().get("origin").is_none());
                            if request.uri().path() == "/v1/capabilities" {
                                marker.store(1, Ordering::SeqCst);
                            } else {
                                assert_eq!(request.headers()["x-voxtype-protocol"], "2");
                                assert_eq!(request.headers()["x-voxtype-audio"], "opus_v1");
                                assert_eq!(
                                    request.headers()["x-voxtype-session"]
                                        .to_str()
                                        .unwrap()
                                        .len(),
                                    32
                                );
                            }
                            Ok(response)
                        })
                        .await
                        .unwrap();
                    if capability.load(Ordering::SeqCst) == 1 {
                        socket
                            .send(Message::Text(capabilities().to_string().into()))
                            .await
                            .unwrap();
                        return;
                    }
                    admissions.fetch_add(1, Ordering::SeqCst);
                    let ready = ready_event.lock().unwrap().clone();
                    socket
                        .send(Message::Text(ready.to_string().into()))
                        .await
                        .unwrap();
                    let mut sequence = 0;
                    let mut final_frame = false;
                    while let Some(Ok(message)) = socket.next().await {
                        if let Message::Binary(bytes) = message {
                            let frame = dictation::parse_opus_frame(&bytes).unwrap();
                            assert_eq!(frame.sequence, sequence);
                            sequence += 1;
                            final_frame = frame.final_frame;
                            received.fetch_add(bytes.len(), Ordering::SeqCst);
                        } else if let Message::Text(text) = message {
                            let message: Value = serde_json::from_str(&text).unwrap();
                            match message["type"].as_str() {
                                Some("ack") => {
                                    acks.fetch_add(1, Ordering::SeqCst);
                                }
                                Some("cancel") => {
                                    cancels.fetch_add(1, Ordering::SeqCst);
                                }
                                Some("finish") => {
                                    assert!(final_frame);
                                    socket
                                        .send(Message::Text(
                                            json!({"type":"partial","text":"never insert this"})
                                                .to_string()
                                                .into(),
                                        ))
                                        .await
                                        .unwrap();
                                    let text = transcript.lock().unwrap().clone();
                                    socket
                                        .send(Message::Text(
                                            json!({"type":"final","text":text}).to_string().into(),
                                        ))
                                        .await
                                        .unwrap();
                                }
                                _ => {}
                            }
                        }
                    }
                });
            }
        })
    };
    assert_eq!(dictation::detect(&env).await["available"], false);
    std::fs::write(root.path().join("token"), token).unwrap();
    std::fs::set_permissions(
        root.path().join("token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        dictation::detect(&env).await,
        json!({"installed":true,"available":true})
    );
    assert_eq!(admissions.load(Ordering::SeqCst), 0);
    let results = Arc::new(Mutex::new(Vec::<String>::new()));
    async fn dictate(
        env: BTreeMap<String, String>,
        results: Arc<Mutex<Vec<String>>>,
        mode: usize,
    ) -> (String, Option<String>) {
        let (sender, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let recording = Recording::start(
            env,
            Arc::new(move |text| {
                results.lock().unwrap().push(text);
                Ok(())
            }),
            Arc::new(move |state, message| {
                let _ = sender.send((state.to_owned(), message));
            }),
        );
        loop {
            let (state, message) = tokio::time::timeout(Duration::from_secs(5), receive.recv())
                .await
                .unwrap()
                .unwrap();
            if state == "ready" {
                match mode {
                    0 => {
                        recording.audio(frame(0, true, true));
                        recording.finish();
                    }
                    1 => recording.finish(),
                    2 => recording.audio(vec![0; 3200]),
                    3 => recording.audio(frame(1, true, false)),
                    _ => panic!("Legacy daemon must not become ready"),
                }
            } else {
                return (state, message);
            }
        }
    }
    assert_eq!(
        dictate(env.clone(), results.clone(), 0).await,
        ("done".into(), None)
    );
    assert_eq!(*results.lock().unwrap(), ["hello world"]);
    assert!(received.load(Ordering::SeqCst) > 17 && received.load(Ordering::SeqCst) < 1000);
    *transcript.lock().unwrap() = "\x1b[201~\recho injected".into();
    assert_eq!(dictate(env.clone(), results.clone(), 0).await.0, "error");
    assert!(
        dictate(env.clone(), results.clone(), 1)
            .await
            .1
            .unwrap()
            .contains("complete Opus")
    );
    assert!(
        dictate(env.clone(), results.clone(), 2)
            .await
            .1
            .unwrap()
            .contains("Invalid Opus")
    );
    assert!(
        dictate(env.clone(), results.clone(), 3)
            .await
            .1
            .unwrap()
            .contains("audio limit")
    );
    let mut legacy = ready();
    legacy["protocol"] = json!(1);
    *ready_event.lock().unwrap() = legacy;
    assert!(
        dictate(env, results.clone(), 4)
            .await
            .1
            .unwrap()
            .contains("Unsupported Voxtype")
    );
    assert_eq!(results.lock().unwrap().len(), 1);
    for _ in 0..100 {
        if acks.load(Ordering::SeqCst) == 1 && cancels.load(Ordering::SeqCst) == 5 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(acks.load(Ordering::SeqCst), 1);
    assert_eq!(cancels.load(Ordering::SeqCst), 5);
    task.abort();
}
#[tokio::test]
async fn installer_commands_quote_paths_and_validate_https_without_running_installers() {
    let root = tempfile::tempdir().unwrap();
    let checkout = root.path().join("source with ' quotes");
    std::fs::create_dir_all(checkout.join("scripts")).unwrap();
    std::fs::write(checkout.join("scripts/install"), "never execute").unwrap();
    let mut env = BTreeMap::from([
        ("HOME".into(), root.path().to_string_lossy().into_owned()),
        (
            "TERMAI_VOXTYPE_SOURCE".into(),
            checkout.to_string_lossy().into_owned(),
        ),
    ]);
    assert!(
        dictation::install_command(&env)
            .await
            .unwrap()
            .contains("'\\''")
    );
    env.remove("TERMAI_VOXTYPE_SOURCE");
    assert!(dictation::install_command(&env).await.is_err());
    env.insert(
        "TERMAI_VOXTYPE_INSTALL_URL".into(),
        "http://example.com/install".into(),
    );
    assert_eq!(
        dictation::install_command(&env).await.err().unwrap(),
        "The installer URL must use HTTPS."
    );
    env.insert(
        "TERMAI_VOXTYPE_INSTALL_URL".into(),
        "https://raw.githubusercontent.com/example/voxtype/main/scripts/install".into(),
    );
    let command = dictation::install_command(&env).await.unwrap();
    assert!(command.contains("VOXTYPE_MOBILE_REPO='https://github.com/example/voxtype.git'"));
    assert!(!root.path().join("executed").exists());
}
