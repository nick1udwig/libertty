use futures::{SinkExt, StreamExt};
use libertty_server::dictation::{self, Recording};
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
            "LIBERTTY_VOXTYPE_TOKEN_FILE".into(),
            root.path().join("token").to_string_lossy().into_owned(),
        ),
        (
            "LIBERTTY_VOXTYPE_URL".into(),
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
            "LIBERTTY_VOXTYPE_SOURCE".into(),
            checkout.to_string_lossy().into_owned(),
        ),
    ]);
    assert!(
        dictation::install_command(&env)
            .await
            .unwrap()
            .contains("'\\''")
    );
    env.remove("LIBERTTY_VOXTYPE_SOURCE");
    assert!(dictation::install_command(&env).await.is_err());
    env.insert(
        "LIBERTTY_VOXTYPE_INSTALL_URL".into(),
        "http://example.com/install".into(),
    );
    assert_eq!(
        dictation::install_command(&env).await.err().unwrap(),
        "The installer URL must use HTTPS."
    );
    env.insert(
        "LIBERTTY_VOXTYPE_INSTALL_URL".into(),
        "https://raw.githubusercontent.com/example/voxtype/main/scripts/install".into(),
    );
    let command = dictation::install_command(&env).await.unwrap();
    assert!(command.contains("VOXTYPE_MOBILE_REPO='https://github.com/example/voxtype.git'"));
    assert!(!root.path().join("executed").exists());
}

fn resume_environment(root: &std::path::Path, port: u16) -> BTreeMap<String, String> {
    let file = root.join("token");
    std::fs::write(&file, "resume-secret-".repeat(4)).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    BTreeMap::from([
        (
            "LIBERTTY_VOXTYPE_TOKEN_FILE".into(),
            file.to_string_lossy().into_owned(),
        ),
        (
            "LIBERTTY_VOXTYPE_URL".into(),
            format!("ws://127.0.0.1:{port}/v1/dictate"),
        ),
    ])
}
#[tokio::test]
async fn suspended_recordings_resume_accepted_frames_without_cancelling_the_daemon_session() {
    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let env = resume_environment(root.path(), listener.local_addr().unwrap().port());
    let (accepted, mut accepted_rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut first = tokio_tungstenite::accept_async(stream).await.unwrap();
        first
            .send(Message::Text(ready().to_string().into()))
            .await
            .unwrap();
        let audio = first.next().await.unwrap().unwrap();
        assert!(audio.is_binary());
        assert_eq!(
            dictation::parse_opus_frame(&audio.into_data())
                .unwrap()
                .sequence,
            0
        );
        accepted.send(()).unwrap();
        let detached = first.next().await.unwrap().unwrap();
        assert!(
            matches!(detached, Message::Close(_)),
            "Disconnect must preserve the logical recording instead of sending cancel"
        );
        drop(first);
        let (stream, _) = listener.accept().await.unwrap();
        let mut second = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut checkpoint = ready();
        checkpoint["accepted_frames"] = json!(1);
        second
            .send(Message::Text(checkpoint.to_string().into()))
            .await
            .unwrap();
        let audio = second.next().await.unwrap().unwrap();
        assert_eq!(
            dictation::parse_opus_frame(&audio.into_data())
                .unwrap()
                .sequence,
            1
        );
        let finish: Value =
            serde_json::from_slice(&second.next().await.unwrap().unwrap().into_data()).unwrap();
        assert_eq!(finish["type"], "finish");
        second
            .send(Message::Text(
                json!({"type":"final","text":"saved speech"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let ack: Value =
            serde_json::from_slice(&second.next().await.unwrap().unwrap().into_data()).unwrap();
        assert_eq!(ack["type"], "ack");
    });
    let results = Arc::new(Mutex::new(Vec::new()));
    let (checkpoints, mut checkpoint_rx) = tokio::sync::mpsc::unbounded_channel();
    let (statuses, mut status_rx) = tokio::sync::mpsc::unbounded_channel();
    let start = || {
        let results = results.clone();
        let checkpoints = checkpoints.clone();
        let statuses = statuses.clone();
        Recording::start_resumable(
            env.clone(),
            "a".repeat(32),
            Arc::new(move |text| {
                let results = results.clone();
                Box::pin(async move {
                    results.lock().unwrap().push(text);
                    Ok(())
                })
            }),
            Arc::new(move |state, error| {
                statuses.send((state.to_owned(), error)).unwrap();
            }),
            Arc::new(move |checkpoint| {
                checkpoints.send(checkpoint).unwrap();
            }),
        )
    };
    let first = start();
    assert_eq!(
        receive_with_timeout(&mut checkpoint_rx)
            .await
            .accepted_frames,
        0
    );
    first.audio(frame(0, false, true));
    receive_with_timeout(&mut accepted_rx).await;
    first.suspend();
    let resumed = start();
    assert_eq!(
        receive_with_timeout(&mut checkpoint_rx)
            .await
            .accepted_frames,
        1
    );
    resumed.audio(frame(1, true, true));
    resumed.finish();
    let status = tokio::time::timeout(Duration::from_secs(5), status_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, ("done".into(), None));
    assert_eq!(*results.lock().unwrap(), vec!["saved speech"]);
    task.await.unwrap();
}

#[tokio::test]
async fn finished_daemon_checkpoints_deliver_cached_final_without_reupload_or_finish() {
    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let env = resume_environment(root.path(), listener.local_addr().unwrap().port());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut checkpoint = ready();
        checkpoint["accepted_frames"] = json!(2);
        checkpoint["finished"] = json!(true);
        socket
            .send(Message::Text(checkpoint.to_string().into()))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"type":"final","text":"cached final"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let ack: Value =
            serde_json::from_slice(&socket.next().await.unwrap().unwrap().into_data()).unwrap();
        assert_eq!(
            ack["type"], "ack",
            "A cached final must not cause audio or finish to be resent"
        );
    });
    let (finals, mut final_rx) = tokio::sync::mpsc::unbounded_channel();
    let (checkpoints, mut checkpoint_rx) = tokio::sync::mpsc::unbounded_channel();
    let recording = Recording::start_resumable(
        env,
        "b".repeat(32),
        Arc::new(move |text| {
            let finals = finals.clone();
            Box::pin(async move {
                finals.send(text).unwrap();
                Ok(())
            })
        }),
        Arc::new(|state, message| assert_ne!(state, "error", "{message:?}")),
        Arc::new(move |checkpoint| {
            checkpoints.send(checkpoint).unwrap();
        }),
    );
    assert!(receive_with_timeout(&mut checkpoint_rx).await.finished);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), final_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "cached final"
    );
    task.await.unwrap();
    drop(recording);
}

#[tokio::test]
async fn accepted_final_audio_can_finish_after_its_finish_control_was_lost() {
    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let env = resume_environment(root.path(), listener.local_addr().unwrap().port());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut checkpoint = ready();
        checkpoint["accepted_frames"] = json!(1);
        socket
            .send(Message::Text(checkpoint.to_string().into()))
            .await
            .unwrap();
        let control = socket.next().await.unwrap().unwrap();
        assert!(control.is_text());
        assert_eq!(
            serde_json::from_slice::<Value>(&control.into_data()).unwrap()["type"],
            "finish"
        );
        socket
            .send(Message::Text(
                json!({"type":"final","text":"complete retained audio"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&socket.next().await.unwrap().unwrap().into_data())
                .unwrap()["type"],
            "ack"
        );
    });
    let (checkpoints, mut checkpoint_rx) = tokio::sync::mpsc::unbounded_channel();
    let (finals, mut final_rx) = tokio::sync::mpsc::unbounded_channel();
    let recording = Recording::start_resumable(
        env,
        "c".repeat(32),
        Arc::new(move |text| {
            let finals = finals.clone();
            Box::pin(async move {
                finals.send(text).unwrap();
                Ok(())
            })
        }),
        Arc::new(|state, message| assert_ne!(state, "error", "{message:?}")),
        Arc::new(move |checkpoint| {
            checkpoints.send(checkpoint).unwrap();
        }),
    );
    assert_eq!(
        receive_with_timeout(&mut checkpoint_rx)
            .await
            .accepted_frames,
        1
    );
    recording.finish();
    assert_eq!(
        receive_with_timeout(&mut final_rx).await,
        "complete retained audio"
    );
    task.await.unwrap();
}

async fn receive_with_timeout<T>(receive: &mut tokio::sync::mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), receive.recv())
        .await
        .expect("Recording fixture timed out")
        .expect("Recording fixture closed")
}
