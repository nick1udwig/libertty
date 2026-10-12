use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
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
        let root = tempfile::tempdir().unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        std::fs::create_dir(root.path().join("dist")).unwrap();
        std::fs::create_dir(root.path().join("dist/assets")).unwrap();
        std::fs::write(
            root.path().join("dist/index.html"),
            "<base href=\"/\" data-termai-base>",
        )
        .unwrap();
        std::fs::write(root.path().join("dist/assets/test.wasm"), b"\0asm").unwrap();
        std::fs::write(root.path().join("dist/assets/test.wasm.br"), b"compressed").unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_termai"))
            .env("HOST", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("TERMAI_ENGINE", engine)
            .env("TERMAI_BASE_PATH", "/terminal")
            .env("TERMAI_CWD", root.path())
            .env("HOME", root.path())
            .env("TERMAI_NO_RC", "1")
            .env("TERMAI_DIST_DIR", root.path().join("dist"))
            .env("TERMAI_DATA_DIR", root.path().join("data"))
            .env("TERMAI_TOKEN", "test-local-pairing-token-123456789")
            .env("TERMAI_ALLOWED_HOSTS", "127.0.0.1,localhost")
            .env("TERMAI_ALLOWED_ORIGINS", "")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let backend = Self { child, root, port };
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "Rust HTTP startup timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
        backend
    }
    fn request(
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
            "{method} /terminal{path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n",
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
        let split = data.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
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
    let cookie = format!("termai={owner}");
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
    assert_eq!(page.bytes, b"<base href=\"/terminal/\" data-termai-base>");
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
    assert_eq!(backend.request("GET", &path, &[], b"").status, 404);
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
