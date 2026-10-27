use serde_json::{Value, json};
#[path = "support/herdr.rs"]
mod herdr_support;
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

struct Backend {
    child: Child,
    root: tempfile::TempDir,
    port: u16,
}
struct Response {
    status: u16,
    headers: String,
    bytes: Vec<u8>,
}
impl Response {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap()
    }
}
impl Backend {
    fn start(engine: &str) -> Self {
        Self::start_with_base(engine, "/terminal")
    }
    fn start_with_base(engine: &str, base: &str) -> Self {
        Self::start_with_heartbeat(engine, base, None)
    }
    fn start_with_heartbeat(engine: &str, base: &str, heartbeat: Option<Duration>) -> Self {
        let root = tempfile::tempdir().unwrap();
        static PORTS: LazyLock<Mutex<HashSet<u16>>> = LazyLock::new(Default::default);
        let port = loop {
            let port = TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            if PORTS.lock().unwrap().insert(port) {
                break port;
            }
        };
        std::fs::create_dir(root.path().join("dist")).unwrap();
        std::fs::create_dir(root.path().join("dist/assets")).unwrap();
        std::fs::write(
            root.path().join("dist/index.html"),
            "<base href=\"/\" data-libertty-base>",
        )
        .unwrap();
        std::fs::write(root.path().join("dist/assets/test.wasm"), b"\0asm").unwrap();
        std::fs::write(root.path().join("dist/assets/test.wasm.br"), b"compressed").unwrap();
        let stderr = std::fs::File::create(root.path().join("stderr.log")).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_libertty"))
            .env("HOST", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("LIBERTTY_ENGINE", engine)
            .env("LIBERTTY_BASE_PATH", base)
            .env("LIBERTTY_CWD", root.path())
            .env("HOME", root.path())
            .env("HERDR_SOCKET_PATH", root.path().join("herdr.sock"))
            .env("LIBERTTY_NO_RC", "1")
            .env("LIBERTTY_DIST_DIR", root.path().join("dist"))
            .env("LIBERTTY_DATA_DIR", root.path().join("data"))
            .env("LIBERTTY_TOKEN", "test-local-pairing-token-123456789")
            .env("LIBERTTY_ALLOWED_HOSTS", "127.0.0.1,localhost")
            .env("LIBERTTY_ALLOWED_ORIGINS", "")
            .env(
                "LIBERTTY_TEST_HEARTBEAT_MS",
                heartbeat
                    .map(|value| value.as_millis().to_string())
                    .unwrap_or_default(),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()
            .unwrap();
        let mut backend = Self { child, root, port };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = backend.child.try_wait().unwrap() {
                panic!(
                    "Rust HTTP backend exited with {status}: {}",
                    backend.stderr()
                );
            }
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "Rust HTTP startup timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
        backend
    }
    fn stderr(&self) -> String {
        std::fs::read_to_string(self.root.path().join("stderr.log")).unwrap_or_default()
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        bytes: &[u8],
    ) -> Response {
        self.raw_request(method, &format!("/terminal{path}"), headers, bytes)
    }
    fn raw_request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        bytes: &[u8],
    ) -> Response {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n",
            bytes.len()
        );
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        {
            request.push_str(&format!("Host: 127.0.0.1:{}\r\n", self.port));
        }
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        stream.write_all(bytes).unwrap();
        let mut data = vec![];
        stream.read_to_end(&mut data).unwrap();
        let split = data
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or_else(|| {
                panic!(
                    "No HTTP response to {method} {path} on port {}: {}",
                    self.port,
                    self.stderr()
                )
            });
        let headers = String::from_utf8(data[..split].to_vec()).unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        Response {
            status,
            headers,
            bytes: data[split + 4..].to_vec(),
        }
    }
    fn api(&self, method: &str, path: &str, owner: Option<&str>, body: Option<Value>) -> Response {
        let origin = format!("http://127.0.0.1:{}", self.port);
        let bearer = owner.map(|o| format!("Bearer {o}"));
        let mut headers = vec![
            ("Origin", origin.as_str()),
            ("Content-Type", "application/json"),
        ];
        if let Some(bearer) = &bearer {
            headers.push(("Authorization", bearer));
        }
        let bytes = body.map(|body| body.to_string()).unwrap_or_default();
        self.request(method, path, &headers, bytes.as_bytes())
    }
    fn pair(&self) -> String {
        let response = self.api(
            "POST",
            "/api/connect",
            None,
            Some(json!({"token":"test-local-pairing-token-123456789","noSession":true})),
        );
        assert_eq!(response.status, 200);
        response.json()["accessToken"].as_str().unwrap().into()
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_and_herdr_sockets_share_ping_audio_and_malformed_frame_rules() {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let fixture = herdr_support::Fixture::new().await;
    let backend = Backend::start("server");
    std::os::unix::fs::symlink(
        fixture.target.path().unwrap(),
        backend.root.path().join("herdr.sock"),
    )
    .unwrap();
    let origin = format!("http://127.0.0.1:{}", backend.port);
    let paired = backend.request(
        "POST",
        "/api/connect",
        &[("Origin", &origin), ("Content-Type", "application/json")],
        br#"{"token":"test-local-pairing-token-123456789"}"#,
    );
    assert_eq!(paired.status, 200);
    let bearer = format!("Bearer {}", paired.json()["accessToken"].as_str().unwrap());
    for herdr in [false, true] {
        for protocol in [
            None,
            Some(libertty_server::wire::BINARY),
            Some(libertty_server::wire::GZIP),
            Some(libertty_server::wire::GZIP_FAST),
        ] {
            let (ticket_path, socket_path, query) = if herdr {
                (
                    "/api/herdr/ticket?terminalId=term_0",
                    "/herdr/ws",
                    "&terminalId=term_0",
                )
            } else {
                ("/api/ticket", "/ws", "")
            };
            let ticket = backend.request(
                "POST",
                ticket_path,
                &[
                    ("Origin", &origin),
                    ("Authorization", &bearer),
                    ("Content-Type", "application/json"),
                ],
                b"{}",
            );
            assert_eq!(ticket.status, 200);
            let url = format!(
                "ws://127.0.0.1:{}/terminal{socket_path}?ticket={}{}",
                backend.port,
                ticket.json()["ticket"].as_str().unwrap(),
                query
            );
            let mut request = url.into_client_request().unwrap();
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
            if let Some(protocol) = protocol {
                request
                    .headers_mut()
                    .insert("sec-websocket-protocol", protocol.parse().unwrap());
            }
            let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
            assert_eq!(
                response
                    .headers()
                    .get("sec-websocket-protocol")
                    .map(|value| value.to_str().unwrap()),
                protocol
            );
            let audio = vec![b'T', b'M', 1, 6, 0, 255];
            socket.send(Message::Binary(audio.into())).await.unwrap();
            let ping = vec![0, 255, 42];
            socket
                .send(Message::Ping(ping.clone().into()))
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match socket.next().await.unwrap().unwrap() {
                        Message::Pong(bytes) => {
                            assert_eq!(&bytes[..], &ping);
                            break;
                        }
                        Message::Close(frame) => panic!("socket closed before pong: {frame:?}"),
                        _ => {}
                    }
                }
            })
            .await
            .unwrap();
            let malformed = if protocol == Some(libertty_server::wire::BINARY) {
                Message::Binary(vec![b'T', b'M', 2, 3].into())
            } else {
                Message::Text("{invalid".into())
            };
            socket.send(malformed).await.unwrap();
            let frame = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Message::Close(frame) = socket.next().await.unwrap().unwrap() {
                        break frame.unwrap();
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(u16::from(frame.code), 1008);
            let reason = if protocol == Some(libertty_server::wire::BINARY) {
                "Invalid wire message"
            } else if herdr {
                "Invalid terminal message"
            } else {
                "Invalid message"
            };
            assert_eq!(frame.reason, reason);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_viewer_neither_pauses_the_shell_nor_stays_attached() {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let heartbeat = Duration::from_secs(if cfg!(debug_assertions) { 1 } else { 30 });
    let backend = Backend::start_with_heartbeat("server", "/terminal", Some(heartbeat));
    let origin = format!("http://127.0.0.1:{}", backend.port);
    let token = backend.pair();
    let state = || {
        let response = backend.api(
            "POST",
            "/api/connect",
            Some(&token),
            Some(json!({"session":"default"})),
        );
        assert_eq!(response.status, 200);
        response.json()["state"].clone()
    };
    state();
    let ticket = backend.api("POST", "/api/ticket", Some(&token), Some(json!({})));
    let url = format!(
        "ws://127.0.0.1:{}/terminal/ws?ticket={}&after=0",
        backend.port,
        ticket.json()["ticket"].as_str().unwrap()
    );
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Message::Binary(bytes) = socket.next().await.unwrap().unwrap()
                && bytes[3] == 0
                && serde_json::from_slice::<Value>(&bytes[4..]).unwrap()["state"]["ready"] == true
            {
                break;
            }
        }
    })
    .await
    .expect("shell prompt");
    let prompt = state()["prompt"].as_u64().unwrap();
    // Far more output than one acknowledgement window, then a computed marker.
    socket
        .send(Message::Text(
            json!({"type":"input","data":"printf '%524288s' ''; echo $((6*7))-done\r"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    // Keep the heartbeat alive without reading or acknowledging output until the shell completes.
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let current = state();
        if current["ready"] == true && current["prompt"].as_u64().unwrap() > prompt {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the shell stayed paused behind a silent viewer: {current}"
        );
        socket
            .send(Message::Text(json!({"type":"ping"}).to_string().into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    // Stop all traffic until the heartbeat must have released the socket.
    tokio::time::sleep(heartbeat * 2 + Duration::from_secs(1)).await;
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the silent viewer's socket stayed open");
}

#[test]
fn mounted_apis_accept_prefix_preserving_and_prefix_stripping_proxies() {
    let backend = Backend::start("server");
    let origin = format!("http://127.0.0.1:{}", backend.port);
    for prefix in ["/terminal", ""] {
        let response = backend.raw_request("GET", &format!("{prefix}/healthz"), &[], &[]);
        assert_eq!(
            response.status, 200,
            "Health route through {prefix:?} proxy"
        );
        assert_eq!(response.json()["ok"], true);
        let response = backend.raw_request(
            "GET",
            &format!("{prefix}/api/ping"),
            &[("Origin", origin.as_str())],
            &[],
        );
        assert_eq!(
            response.status, 401,
            "Stripped routes retain authentication"
        );
        for socket in ["/ws", "/herdr/ws"] {
            let response = backend.raw_request(
                "GET",
                &format!("{prefix}{socket}"),
                &[("Origin", origin.as_str())],
                &[],
            );
            assert_eq!(
                response.status, 403,
                "WebSocket route through {prefix:?} proxy retains its ticket checks"
            );
        }
        let response = backend.raw_request(
            "POST",
            &format!("{prefix}/api/connect"),
            &[
                ("Origin", origin.as_str()),
                ("Content-Type", "application/json"),
            ],
            br#"{"token":"test-local-pairing-token-123456789","noSession":true}"#,
        );
        assert_eq!(response.status, 200);
        assert!(
            response.headers.contains("Path=/terminal/"),
            "Cookie scope retains the public mount"
        );
        let token = response.json()["accessToken"].as_str().unwrap().to_owned();
        let bearer = format!("Bearer {token}");
        let response = backend.raw_request(
            "GET",
            &format!("{prefix}/api/ping"),
            &[
                ("Origin", origin.as_str()),
                ("Authorization", bearer.as_str()),
            ],
            &[],
        );
        assert_eq!(response.status, 200, "Paired API through {prefix:?} proxy");
    }
}

#[test]
fn public_mounts_can_overlap_unmounted_route_names() {
    let backend = Backend::start_with_base("server", "/herdr");
    for path in ["/herdr/healthz", "/healthz"] {
        assert_eq!(backend.raw_request("GET", path, &[], &[]).status, 200);
    }
}

#[test]
fn suggestions_use_native_context_and_legacy_fact_routes_are_absent() {
    // Old installed configs continue to start, always using the native engine.
    let backend = Backend::start("client");
    let owner = backend.pair();
    let id = backend
        .api("POST", "/api/sessions", Some(&owner), Some(json!({})))
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/suggest?session={id}");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let result = backend.api("POST", &path, Some(&owner), Some(json!({"text":"LSL"})));
        if result.status == 200 {
            assert!(
                result.json()["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["command"] == "ls -l")
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Suggestions did not become ready: {}",
            result.json()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        backend
            .api(
                "POST",
                "/api/facts",
                Some(&owner),
                Some(json!({"kind":"context"}))
            )
            .status,
        404
    );
    assert_eq!(
        backend
            .api("GET", "/api/context", Some(&owner), None)
            .status,
        404
    );
}

#[test]
fn slow_ssh_connections_do_not_block_existing_or_new_local_sessions() {
    let backend = Backend::start("client");
    let owner = backend.pair();
    let sid = backend
        .api(
            "POST",
            "/api/sessions",
            Some(&owner),
            Some(json!({"files":true})),
        )
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::scope(|scope| {
        let slow = scope.spawn(|| backend.api("POST", "/api/sessions", Some(&owner), Some(json!({"ssh":{"host":"127.0.0.1","port":port,"username":"test","password":"synthetic"}}))));
        let (connection, _) = listener.accept().unwrap();
        let start = Instant::now();
        assert_eq!(
            backend
                .api(
                    "GET",
                    &format!("/api/files/list?session={sid}"),
                    Some(&owner),
                    None
                )
                .status,
            200
        );
        assert_eq!(
            backend
                .api(
                    "POST",
                    "/api/sessions",
                    Some(&owner),
                    Some(json!({"files":true}))
                )
                .status,
            200
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "Unrelated local sessions must stay responsive during SSH setup"
        );
        drop(connection);
        assert_ne!(slow.join().unwrap().status, 200);
    });
}

#[test]
fn authentication_json_limits_static_assets_and_owned_file_streams_are_compatible() {
    let backend = Backend::start("client");
    let origin = format!("http://127.0.0.1:{}", backend.port);
    let health = backend.api("GET", "/healthz", None, None);
    assert_eq!(health.status, 200);
    assert_eq!(health.json()["runtime"], "rust");
    let unauthenticated = backend.api("GET", "/api/ping", None, None);
    assert_eq!(unauthenticated.status, 401);
    assert_eq!(
        unauthenticated.json()["error"],
        "Connect to your shell first."
    );
    assert!(
        unauthenticated
            .headers
            .contains("x-content-type-options: nosniff")
    );
    assert_eq!(
        backend
            .request(
                "POST",
                "/api/connect",
                &[("Content-Type", "application/json")],
                b"{}"
            )
            .status,
        403
    );
    assert_eq!(
        backend
            .request(
                "POST",
                "/api/connect",
                &[("Origin", origin.as_str())],
                b"{}"
            )
            .json()["error"],
        "Expected JSON"
    );
    assert_eq!(
        backend
            .api("POST", "/api/connect", None, Some(json!([])))
            .json()["error"],
        "Expected an object"
    );
    assert_eq!(
        backend
            .api("POST", "/api/connect", None, Some(json!({"token":"wrong"})))
            .status,
        401
    );
    assert_eq!(
        backend
            .api(
                "POST",
                "/api/connect",
                None,
                Some(json!({"ignored":"x".repeat(16384)}))
            )
            .json()["error"],
        "Request too large"
    );
    assert_eq!(
        backend
            .request(
                "OPTIONS",
                "/api/connect",
                &[("Origin", origin.as_str())],
                b""
            )
            .status,
        204
    );
    assert_eq!(
        backend
            .request(
                "OPTIONS",
                "/api/connect",
                &[("Origin", "http://evil.example")],
                b""
            )
            .status,
        403
    );
    let owner = backend.pair();
    let bearer = format!("Bearer {owner}");
    let paired = backend.api(
        "POST",
        "/api/connect",
        Some(&owner),
        Some(json!({"ignored":"🌱".repeat(4000),"noSession":true})),
    );
    assert_eq!(paired.status, 200, "JSON limits count UTF-16 units");
    assert!(
        paired
            .headers
            .contains("Path=/terminal/; HttpOnly; SameSite=Strict; Max-Age=31536000")
    );
    let cookie = format!("libertty={owner}");
    assert_eq!(
        backend
            .request("GET", "/api/ping", &[("Cookie", &cookie)], b"")
            .status,
        200
    );
    let wrong = format!("Bearer {}", "a".repeat(64));
    assert_eq!(
        backend
            .request(
                "GET",
                "/api/ping",
                &[("Cookie", &cookie), ("Authorization", &wrong)],
                b""
            )
            .status,
        401
    );
    assert_eq!(
        backend
            .request(
                "GET",
                "/api/ping",
                &[("Host", "evil.example"), ("Authorization", &bearer)],
                b""
            )
            .status,
        403
    );
    let page = backend.request("GET", "/", &[], b"");
    assert_eq!(page.status, 200);
    assert_eq!(page.bytes, b"<base href=\"/terminal/\" data-libertty-base>");
    let wasm = backend.request(
        "GET",
        "/assets/test.wasm",
        &[("Accept-Encoding", "gzip;q=0, br;q=1, identity;q=0")],
        b"",
    );
    assert_eq!(wasm.status, 200);
    assert_eq!(wasm.bytes, b"compressed");
    assert!(wasm.headers.contains("content-encoding: br"));
    assert!(wasm.headers.contains("content-type: application/wasm"));
    assert_eq!(
        backend
            .request("HEAD", "/assets/test.wasm", &[], b"")
            .bytes
            .len(),
        0
    );
    assert_eq!(
        backend
            .request("GET", "/", &[("Accept-Encoding", "identity;q=0")], b"")
            .status,
        406
    );
    assert_eq!(
        backend.request("GET", "/%2e%2e%2fsecret", &[], b"").status,
        403
    );
    let terminal = backend
        .api(
            "POST",
            "/api/sessions",
            Some(&owner),
            Some(json!({"name":"Files","files":true})),
        )
        .json();
    let sid = terminal["id"].as_str().unwrap();
    let other = backend.pair();
    assert_eq!(
        backend
            .api(
                "GET",
                &format!("/api/files/list?session={sid}"),
                Some(&other),
                None
            )
            .status,
        404
    );
    assert_eq!(
        backend
            .api(
                "POST",
                &format!("/api/ticket?session={sid}"),
                Some(&owner),
                Some(json!({}))
            )
            .status,
        404
    );
    let upload = backend.request(
        "POST",
        &format!("/api/files/upload?session={sid}&path=.&name=sample.bin"),
        &[("Origin", &origin), ("Authorization", &bearer)],
        &[0, 255, 65, 66, 67],
    );
    assert_eq!(upload.status, 200);
    assert_eq!(upload.json()["bytes"], 5);
    // A numbered upload keeps its partial file, so a retry continues from the bytes that arrived.
    let resumable = |id: &str, size: u64, offset: u64, body: &[u8]| {
        backend.request(
            "POST",
            &format!("/api/files/upload?session={sid}&path=.&name=resumed.bin&upload={id}&size={size}&offset={offset}"),
            &[("Origin", &origin), ("Authorization", &bearer)],
            body,
        )
    };
    let root = backend.root.path();
    assert_eq!(resumable("u1", 5, 0, &[1, 2]).json(), json!({"received":2}));
    assert!(!root.join("resumed.bin").exists() && root.join(".libertty-upload-u1").exists());
    assert_eq!(
        resumable("u1", 5, 0, &[]).json(),
        json!({"received":2}),
        "an attempt at another offset learns what arrived"
    );
    assert_eq!(
        resumable("u1", 5, 2, &[3, 4, 5]).json(),
        json!({"name":"resumed.bin","bytes":5})
    );
    assert_eq!(
        std::fs::read(root.join("resumed.bin")).unwrap(),
        [1, 2, 3, 4, 5]
    );
    assert!(!root.join(".libertty-upload-u1").exists());
    assert_eq!(
        resumable("u1", 5, 0, &[]).json(),
        json!({"name":"resumed.bin","bytes":5}),
        "a lost completion reply can be retried"
    );
    assert_eq!(resumable("u1", 6, 0, &[]).status, 409);
    assert_eq!(
        resumable("u2", 5, 0, &[]).status,
        409,
        "uploads never overwrite"
    );
    std::fs::remove_file(root.join("resumed.bin")).unwrap();
    assert_eq!(resumable("u3", 2, 0, &[1, 2, 3]).status, 400);
    assert!(!root.join("resumed.bin").exists());
    let listing = backend
        .api(
            "GET",
            &format!("/api/files/list?session={sid}"),
            Some(&owner),
            None,
        )
        .json();
    assert!(
        listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "sample.bin")
    );
    let download = backend
        .api(
            "POST",
            &format!("/api/files/download?session={sid}"),
            Some(&owner),
            Some(json!({"path":"sample.bin"})),
        )
        .json();
    let path = format!(
        "/api/files/download?ticket={}",
        download["ticket"].as_str().unwrap()
    );
    let downloaded = backend.request("GET", &path, &[], b"");
    assert_eq!(downloaded.status, 200);
    assert_eq!(downloaded.bytes, [0, 255, 65, 66, 67]);
    assert!(
        downloaded
            .headers
            .contains("attachment; filename=\"download\"; filename*=UTF-8''sample.bin")
    );
    assert_eq!(
        backend.request("GET", &path, &[], b"").bytes,
        downloaded.bytes
    );
    // Even after the server queues the final chunk, the browser may need to resume.
    let ticket = |name: &str| {
        let ticket = backend
            .api(
                "POST",
                &format!("/api/files/download?session={sid}"),
                Some(&owner),
                Some(json!({ "path": name })),
            )
            .json();
        format!(
            "/api/files/download?ticket={}",
            ticket["ticket"].as_str().unwrap()
        )
    };
    let path = ticket("sample.bin");
    let resumed = backend.request("GET", &path, &[("Range", "bytes=2-")], b"");
    assert_eq!(
        (resumed.status, &resumed.bytes[..]),
        (206, &[65, 66, 67][..])
    );
    assert!(resumed.headers.contains("content-range: bytes 2-4/5"));
    assert_eq!(
        backend
            .request("GET", &path, &[("Range", "bytes=4-")], b"")
            .bytes,
        [67]
    );
    let path = ticket("sample.bin");
    assert_eq!(
        backend
            .request("GET", &path, &[("Range", "bytes=5-")], b"")
            .status,
        416
    );
    std::fs::write(backend.root.path().join("sample.bin"), [1, 2, 3]).unwrap();
    assert_eq!(
        backend
            .request("GET", &path, &[("Range", "bytes=1-")], b"")
            .status,
        409,
        "a changed file cannot be spliced onto earlier bytes"
    );
    std::fs::write(backend.root.path().join("sample.bin"), [0, 255, 65, 66, 67]).unwrap();
    let revoke = backend
        .api(
            "POST",
            &format!("/api/files/download?session={sid}"),
            Some(&owner),
            Some(json!({"path":"sample.bin"})),
        )
        .json();
    assert_eq!(
        backend
            .api(
                "POST",
                &format!("/api/sessions/close?session={sid}"),
                Some(&owner),
                Some(json!({}))
            )
            .status,
        200
    );
    assert_eq!(
        backend
            .request(
                "GET",
                &format!(
                    "/api/files/download?ticket={}",
                    revoke["ticket"].as_str().unwrap()
                ),
                &[],
                b""
            )
            .status,
        404
    );
    assert_eq!(
        std::fs::read(backend.root.path().join("sample.bin")).unwrap(),
        [0, 255, 65, 66, 67]
    );
}

#[test]
fn retried_changes_with_one_idempotency_key_run_once_and_replay_their_reply() {
    let backend = Backend::start("client");
    let owner = backend.pair();
    let sid = backend
        .api(
            "POST",
            "/api/sessions",
            Some(&owner),
            Some(json!({"files":true})),
        )
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let origin = format!("http://127.0.0.1:{}", backend.port);
    let mkdir = |owner: &str, key: &str| {
        let bearer = format!("Bearer {owner}");
        backend.request(
            "POST",
            &format!("/api/files/mkdir?session={sid}"),
            &[
                ("Origin", &origin),
                ("Content-Type", "application/json"),
                ("Authorization", &bearer),
                ("Idempotency-Key", key),
            ],
            json!({"path":".","name":"once"}).to_string().as_bytes(),
        )
    };
    let first = mkdir(&owner, "retry-1");
    assert_eq!(first.status, 200);
    // A retry whose first attempt already ran receives the original reply instead of an "already exists" failure.
    let retry = mkdir(&owner, "retry-1");
    assert_eq!((retry.status, retry.bytes), (200, first.bytes));
    assert_eq!(
        mkdir(&owner, "retry-2").status,
        409,
        "a new key is a new request"
    );
    let other = backend.pair();
    assert_ne!(other, owner);
    assert_eq!(
        mkdir(&other, "retry-1").status,
        404,
        "another owner runs its own request and cannot see this session"
    );
    assert!(backend.root.path().join("once").is_dir());
    // Concurrent attempts share the first one's work, so opening a terminal twice still opens one.
    let bearer = format!("Bearer {owner}");
    let open = || {
        backend
            .request(
                "POST",
                "/api/sessions",
                &[
                    ("Origin", &origin),
                    ("Content-Type", "application/json"),
                    ("Authorization", &bearer),
                    ("Idempotency-Key", "open-once"),
                ],
                json!({"name":"Once"}).to_string().as_bytes(),
            )
            .json()["id"]
            .clone()
    };
    let ids = std::thread::scope(|scope| {
        let attempts: Vec<_> = (0..2).map(|_| scope.spawn(open)).collect();
        attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(ids[0], ids[1]);
    let sessions = backend
        .api("GET", "/api/sessions", Some(&owner), None)
        .json();
    assert_eq!(
        sessions
            .as_array()
            .unwrap()
            .iter()
            .filter(|session| session["name"] == "Once")
            .count(),
        1
    );
    for index in 0..140 {
        assert_eq!(mkdir(&owner, &format!("fill-{index}")).status, 409);
    }
    assert_eq!(
        mkdir(&owner, "retry-1").status,
        200,
        "Recent keys survive more than 128 changes"
    );
}

#[test]
fn conditional_plugin_reads_compression_and_owner_scoping() {
    let backend = Backend::start("client");
    let owner = backend.pair();
    let sid = backend
        .api(
            "POST",
            "/api/sessions",
            Some(&owner),
            Some(json!({"files":true})),
        )
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let text = "plugin events 界😀\n".repeat(20_000);
    std::fs::write(backend.root.path().join("plugin.log"), &text).unwrap();
    let route = format!("/api/plugins/read?path=plugin.log&session={sid}&delta=1");
    let origin = format!("http://127.0.0.1:{}", backend.port);
    let bearer = format!("Bearer {owner}");
    let headers = [
        ("Origin", origin.as_str()),
        ("Authorization", bearer.as_str()),
        ("Accept-Encoding", "gzip"),
    ];
    let first = backend.request("GET", &route, &headers, b"");
    assert_eq!(first.status, 200);
    assert!(
        first
            .headers
            .to_lowercase()
            .contains("content-encoding: gzip")
    );
    assert!(first.bytes.len() < 5000);
    let mut decoded = String::new();
    flate2::read::GzDecoder::new(&first.bytes[..])
        .read_to_string(&mut decoded)
        .unwrap();
    let value: Value = serde_json::from_str(&decoded).unwrap();
    // Long selected files retain the bounded tail, including Unicode.
    assert_eq!(
        value["text"].as_str().unwrap().encode_utf16().count(),
        256 * 1024
    );
    let etag = format!("\"{}\"", value["version"].as_str().unwrap());
    let conditional = [
        ("Origin", origin.as_str()),
        ("Authorization", bearer.as_str()),
        ("If-None-Match", etag.as_str()),
    ];
    let same = backend.request("GET", &route, &conditional, b"");
    assert_eq!(same.status, 304);
    assert!(same.bytes.is_empty());
    let other = backend.pair();
    assert_eq!(backend.api("GET", &route, Some(&other), None).status, 404);
    let raw = backend.request(
        "GET",
        &route,
        &[
            ("Origin", origin.as_str()),
            ("Authorization", bearer.as_str()),
            ("Accept-Encoding", "gzip;q=0"),
        ],
        b"",
    );
    assert!(
        !raw.headers
            .to_lowercase()
            .contains("content-encoding: gzip")
    );
    std::fs::write(
        backend.root.path().join("plugin.log"),
        "short text\n".repeat(100),
    )
    .unwrap();
    let initial = backend.api("GET", &route, Some(&owner), None).json();
    std::fs::write(
        backend.root.path().join("plugin.log"),
        "short text\n".repeat(100) + "append 😀\n",
    )
    .unwrap();
    let etag = format!("\"{}\"", initial["version"].as_str().unwrap());
    let delta = backend
        .request(
            "GET",
            &route,
            &[
                ("Origin", origin.as_str()),
                ("Authorization", bearer.as_str()),
                ("If-None-Match", etag.as_str()),
            ],
            b"",
        )
        .json();
    assert_eq!(delta["append"], "append 😀\n");
    assert_eq!(delta["baseVersion"], initial["version"]);
}
