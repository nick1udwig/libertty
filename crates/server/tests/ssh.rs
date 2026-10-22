use libertty_server::{
    files,
    filesystem::FileSystem,
    host::{HostServices, NativeHost},
    session::{Session, Transport},
    ssh::SSHHost,
    vault::{Vault, fingerprint},
};
use rand::rngs::OsRng;
use serde_json::{Value, json};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::{net::SocketAddr, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, sync::mpsc};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn typed_host_facts_and_completion_budgets_work_locally_and_over_ssh() {
    use libertty_engine::{
        host::{FactValue, HostOperation},
        types::Catalog,
    };
    let fixture = Fixture::start().await;
    let remote = fixture.connect(false).await;
    let home = fixture.home();
    let definitions = format!("{home}/completions");
    tokio::fs::write(
        &definitions,
        "_slow(){ sleep 1; COMPREPLY=(late); }; complete -F _slow slow\n",
    )
    .await
    .unwrap();
    let services = HostServices::new();
    let mut host = NativeHost::new(
        services.clone(),
        Catalog {
            cwd: home.clone(),
            ..Default::default()
        },
        std::collections::BTreeMap::from([
            ("HOME".into(), home.clone()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LIBERTTY_COMPLETIONS_FILE".into(), definitions),
        ]),
        libertty_server::help::HelpProvider::new(services.pool.clone()),
    );
    let cancel = CancellationToken::new();
    for transport in [None, Some(remote.clone())] {
        host.remote = transport;
        let lookup = HostOperation::Lookup {
            path: format!("{home}/missing"),
        };
        let typed = host.engine_operation(&lookup, &cancel).await.unwrap();
        assert!(matches!(typed, FactValue::Lookup(_)));
        assert_eq!(
            serde_json::to_value(typed).unwrap(),
            host.fact(&serde_json::to_value(lookup).unwrap(), &cancel)
                .await
                .unwrap()
        );
        let completion = |timeout: f64| HostOperation::Completion {
            words: vec!["slow".into(), "x".into()],
            timeout: timeout.to_bits(),
        };
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            host.engine_operation(&completion(50.0), &cancel),
        )
        .await
        .expect("Completion must honor the supplied budget");
        match result {
            Ok(FactValue::Completion(values)) => assert!(values.is_empty()),
            Err(message) => assert_eq!(message, "Completion timed out."),
            other => panic!("Unexpected completion: {other:?}"),
        }
        for invalid in [-1.0, f64::INFINITY, f64::NAN] {
            assert_eq!(
                host.engine_operation(&completion(invalid), &cancel)
                    .await
                    .unwrap_err(),
                "Invalid completion timeout."
            );
        }
    }
    remote.dispose().await;
    fixture.stop().await;
}

async fn probe_sshd(socket: tokio::net::TcpSocket, address: SocketAddr) -> std::io::Result<()> {
    // A loopback socket can connect to itself while sshd has not bound its port.
    if socket.local_addr()? == address {
        return Err(std::io::Error::other("SSH probe would connect to itself"));
    }
    let mut stream = socket.connect(address).await?;
    let mut banner = [0; 4];
    stream.read_exact(&mut banner).await?;
    if &banner != b"SSH-" {
        return Err(std::io::Error::other(
            "SSH probe received an invalid banner",
        ));
    }
    Ok(())
}

struct Fixture {
    directory: tempfile::TempDir,
    child: tokio::process::Child,
    input: Value,
    pin: String,
    vault: Arc<Vault>,
}
impl Fixture {
    async fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_string_lossy().into_owned();
        let host = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let identity = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        tokio::fs::write(
            format!("{root}/host"),
            host.to_openssh(LineEnding::LF).unwrap().as_bytes(),
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(
            format!("{root}/host"),
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        .unwrap();
        tokio::fs::write(
            format!("{root}/authorized"),
            identity.public_key().to_openssh().unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::create_dir(format!("{root}/home")).await.unwrap();
        tokio::fs::write(
            format!("{root}/home/.bash_eternal_history"),
            "#123456789\nprintf initial-history\n",
        )
        .await
        .unwrap();
        let user = String::from_utf8(
            std::process::Command::new("id")
                .arg("-un")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let port = address.port();
        let config = format!("{root}/sshd_config");
        // The loopback remote must use the same supported Bash as local tests.
        let bash = libertty_server::shell::local_bash(&std::env::vars().collect()).unwrap();
        let remote_path = format!(
            "{}:/usr/bin:/bin",
            std::path::Path::new(&bash).parent().unwrap().display()
        );
        tokio::fs::write(&config,format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {root}/host\nPidFile {root}/pid\nAuthorizedKeysFile {root}/authorized\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers {user}\nSetEnv HOME={root}/home PATH={remote_path}\nSubsystem sftp internal-sftp\n")).await.unwrap();
        let executable = std::env::var("LIBERTTY_TEST_SSHD").unwrap_or_else(|_| {
            if std::path::Path::new("/usr/bin/sshd").exists() {
                "/usr/bin/sshd"
            } else {
                "/usr/sbin/sshd"
            }
            .into()
        });
        let log = directory.path().join("sshd.log");
        let stderr = std::fs::File::create(&log).unwrap();
        // Reserve the server port until its configuration is ready to launch.
        drop(listener);
        let mut child = tokio::process::Command::new(executable)
            .args(["-D", "-e", "-f", &config])
            .stdout(std::process::Stdio::null())
            .stderr(stderr)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let readiness = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(status) = child.try_wait()? {
                    return Err(std::io::Error::other(format!(
                        "SSH fixture exited before readiness: {status}"
                    )));
                }
                let socket = tokio::net::TcpSocket::new_v4()?;
                socket.bind("127.0.0.1:0".parse().unwrap())?;
                if matches!(
                    tokio::time::timeout(Duration::from_millis(200), probe_sshd(socket, address))
                        .await,
                    Ok(Ok(()))
                ) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if !matches!(readiness, Ok(Ok(()))) {
            let diagnostics = tokio::fs::read_to_string(&log).await.unwrap_or_default();
            panic!("SSH fixture failed to start: {readiness:?}\n{diagnostics}");
        }
        let input = json!({"host":"127.0.0.1","port":port,"username":user,"privateKey":identity.to_openssh(LineEnding::LF).unwrap().to_string(),"passphrase":"unused-for-plain-key"});
        let pin = fingerprint(&host.public_key().to_bytes().unwrap());
        let vault = Arc::new(Vault::new(&directory.path().join("vault")));
        Self {
            directory,
            child,
            input,
            pin,
            vault,
        }
    }
    async fn connect(&self, files: bool) -> Arc<SSHHost> {
        let mut input = self.input.clone();
        input["trust"] = json!(self.pin);
        SSHHost::connect(
            &input,
            self.vault.clone(),
            None,
            files,
            &CancellationToken::new(),
        )
        .await
        .unwrap()
    }
    fn home(&self) -> String {
        self.directory
            .path()
            .join("home")
            .to_string_lossy()
            .into_owned()
    }
    async fn stop(mut self) {
        self.child.kill().await.unwrap();
        self.child.wait().await.unwrap();
    }
}

#[tokio::test]
async fn sshd_probe_rejects_loopback_self_connections() {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let address = socket.local_addr().unwrap();
    assert!(
        probe_sshd(socket, address)
            .await
            .unwrap_err()
            .to_string()
            .contains("connect to itself")
    );
}

#[tokio::test]
async fn sshd_probe_waits_for_an_ssh_banner() {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let mut probe = tokio::spawn(probe_sshd(socket, address));
    let (mut stream, _) = listener.accept().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut probe)
            .await
            .is_err()
    );
    stream.write_all(b"SSH-2.0-fixture\r\n").await.unwrap();
    probe.await.unwrap().unwrap();
}

#[tokio::test]
async fn sshd_probe_rejects_non_ssh_listeners() {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let probe = tokio::spawn(probe_sshd(socket, address));
    let (mut stream, _) = listener.accept().await.unwrap();
    stream.write_all(b"HTTP/1.1 200 OK\r\n").await.unwrap();
    assert!(
        probe
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("invalid banner")
    );
}

#[tokio::test]
async fn remote_authentication_pins_facts_and_bounded_channels() {
    let fixture = Fixture::start().await;
    let cancel = CancellationToken::new();
    let error = SSHHost::connect(&fixture.input, fixture.vault.clone(), None, false, &cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(error.status, 409);
    assert_eq!(error.fingerprint.as_deref(), Some(fixture.pin.as_str()));
    assert_eq!(error.changed, Some(false));
    assert!(fixture.vault.list().unwrap().known_hosts.is_empty());
    let host = fixture.connect(false).await;
    assert_eq!(host.home, fixture.home());
    assert_eq!(host.history(&cancel).await, vec!["printf initial-history"]);
    let eternal = format!("{}/.bash_eternal_history", fixture.home());
    let standard = format!("{}/.bash_history", fixture.home());
    tokio::fs::write(&standard, "echo standard-only\n")
        .await
        .unwrap();
    tokio::fs::write(
        &eternal,
        "x".repeat(libertty_server::history::HISTORY_BYTES + 100)
            + "\n#123456789\necho eternal 界😀\n private command\n",
    )
    .await
    .unwrap();
    assert_eq!(host.history(&cancel).await, ["echo eternal 界😀"]);
    assert_eq!(
        host.history(&cancel).await,
        libertty_server::history::read_history(&eternal, libertty_server::history::HISTORY_BYTES)
            .await
    );
    tokio::fs::write(&eternal, "echo eternal 界😀\n")
        .await
        .unwrap();
    assert_eq!(host.history(&cancel).await, ["echo eternal 界😀"]);
    tokio::fs::remove_file(&eternal).await.unwrap();
    assert_eq!(host.history(&cancel).await, ["echo standard-only"]);
    tokio::fs::remove_file(&standard).await.unwrap();
    assert!(host.history(&cancel).await.is_empty());
    assert_eq!(
        fixture.vault.list().unwrap().known_hosts[0].fingerprint,
        fixture.pin
    );
    let mut wrong = fixture.input.clone();
    wrong["privateKey"] = json!(
        PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string()
    );
    assert!(
        SSHHost::connect(&wrong, fixture.vault.clone(), None, false, &cancel)
            .await
            .is_err()
    );
    let output = host
        .exec("printf stdout; printf stderr >&2; exit 7", &cancel)
        .await
        .unwrap();
    assert_eq!(
        (output.stdout, output.stderr, output.code),
        ("stdout".into(), "stderr".into(), 7)
    );
    assert!(
        host.exec("head -c 1048577 /dev/zero", &cancel)
            .await
            .unwrap_err()
            .contains("exceeded its limit")
    );
    let cancelled = CancellationToken::new();
    let work = host.exec("sleep 30", &cancelled);
    let cancel_work = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancelled.cancel();
    };
    let (result, ()) = tokio::join!(work, cancel_work);
    assert!(result.is_err());
    assert_eq!(
        host.exec("printf live", &cancel).await.unwrap().stdout,
        "live"
    );
    let commands = (0..8).map(|i| {
        let host = host.clone();
        let cancel = cancel.clone();
        async move {
            host.exec(&format!("sleep 0.02; printf {i}"), &cancel)
                .await
                .unwrap()
                .stdout
        }
    });
    assert_eq!(
        futures::future::join_all(commands).await,
        (0..8).map(|i| i.to_string()).collect::<Vec<_>>()
    );
    tokio::fs::write(
        fixture.directory.path().join("home/hello_world.py"),
        "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n",
    )
    .await
    .unwrap();
    let catalog = libertty_engine::types::Catalog {
        cwd: fixture.home(),
        commands: vec!["python3".into(), "git".into(), "ls".into()].into(),
        functions: Some(vec![].into()),
        ..Default::default()
    };
    let mut native = NativeHost::new(
        HostServices::new(),
        catalog,
        std::collections::BTreeMap::from([
            ("HOME".into(), fixture.home()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
        libertty_server::help::HelpProvider::new(Default::default()),
    );
    native.remote = Some(host.clone());
    assert_eq!(
        native
            .fact(&json!({"kind":"syntax","command":"echo valid"}), &cancel)
            .await
            .unwrap(),
        true
    );
    assert_eq!(
        native
            .fact(&json!({"kind":"syntax","command":"echo ("}), &cancel)
            .await
            .unwrap(),
        false
    );
    let described = native
        .fact(
            &json!({"kind":"describe","command":"python3 hello_world.py"}),
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        described
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["name"] == "--myarg"),
        "{described}"
    );
    let help = native.read_help("git", &[], false, &cancel).await.unwrap();
    assert!(
        help.safe_subcommands
            .as_ref()
            .unwrap()
            .contains(&"status".into())
    );
    assert!(
        !native
            .read_help("git", &["status".into()], false, &cancel)
            .await
            .unwrap()
            .flags
            .is_empty()
    );
    assert!(
        native
            .read_help("git", &["unverified".into()], false, &cancel)
            .await
            .is_err()
    );
    host.dispose().await;
    let pinned = fixture.vault.list().unwrap().known_hosts[0].clone();
    fixture.vault.forget(&pinned.host, pinned.port).unwrap();
    fixture
        .vault
        .trust(&pinned.host, pinned.port, "SHA256:changed-fixture")
        .unwrap();
    let error = SSHHost::connect(&fixture.input, fixture.vault.clone(), None, false, &cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(error.status, 409);
    assert_eq!(error.changed, Some(true));
    fixture.stop().await;
}
async fn next(
    session: &Arc<Session>,
    attachment: u64,
    receive: &mut mpsc::UnboundedReceiver<Transport>,
) -> Value {
    match tokio::time::timeout(Duration::from_secs(10), receive.recv())
        .await
        .unwrap()
        .unwrap()
    {
        Transport::Close(code, reason) => panic!("Unexpected remote close {code}: {reason}"),
        message => {
            let value = message.value().unwrap();
            if value["type"] == "output" {
                session.receive(attachment, json!({"type":"ack","seq":value["seq"]}));
            }
            value
        }
    }
}
async fn ready(
    session: &Arc<Session>,
    attachment: u64,
    receive: &mut mpsc::UnboundedReceiver<Transport>,
    after: u64,
) {
    loop {
        let v = next(session, attachment, receive).await;
        if v["type"] == "state"
            && v["state"]["ready"] == true
            && v["state"]["prompt"].as_u64().is_some_and(|p| p > after)
        {
            break;
        }
    }
}
#[tokio::test]
async fn remote_pty_and_sftp_share_session_guards_and_file_actions() {
    let fixture = Fixture::start().await;
    let host = fixture.connect(false).await;
    let session = Session::start_remote(host.clone(), false, HostServices::new())
        .await
        .unwrap();
    let (attachment, mut receive) = session.attach(0, None, None);
    ready(&session, attachment, &mut receive, 0).await;
    assert_eq!(session.state().cwd, fixture.home());
    let snapshot = session.snapshot().await.unwrap();
    assert!(snapshot.0.commands.contains(&"cd".into()));
    assert_eq!(snapshot.1["HOME"], fixture.home());
    for cols in 2..=300 {
        session.receive(attachment, json!({"type":"resize","cols":cols,"rows":24}));
    }
    session.receive(attachment, json!({"type":"resize","cols":101,"rows":42}));
    let prompt = session.state().prompt;
    session.receive(attachment, json!({"type":"command","id":"dimensions","command":"stty size > dimensions","prompt":prompt}));
    ready(&session, attachment, &mut receive, prompt).await;
    assert_eq!(
        tokio::fs::read_to_string(format!("{}/dimensions", fixture.home()))
            .await
            .unwrap()
            .trim(),
        "42 101"
    );
    let prompt = session.state().prompt;
    session.receive(attachment,json!({"type":"command","id":"remote-command","command":"printf remote-output","prompt":prompt}));
    ready(&session, attachment, &mut receive, prompt).await;
    assert!(
        session
            .snapshot()
            .await
            .unwrap()
            .0
            .history
            .contains(&"printf remote-output".into())
    );
    let fs = FileSystem {
        remote: Some(host.clone()),
    };
    files::make_directory_on(&fs, &fixture.home(), &fixture.home(), ".", "docs")
        .await
        .unwrap();
    let upload = files::upload_on(
        &fs,
        &fixture.home(),
        &fixture.home(),
        "docs",
        "über file.txt",
        axum::body::Body::from("original"),
        Some("8"),
    )
    .await
    .unwrap();
    assert_eq!(upload["bytes"], 8);
    let path = format!("{}/docs/über file.txt", fixture.home());
    assert_eq!(
        files::upload_on(
            &fs,
            "/",
            "/",
            &format!("{}/docs", fixture.home()),
            "über file.txt",
            axum::body::Body::from("no"),
            None
        )
        .await
        .unwrap_err()
        .status,
        409
    );
    let original = files::action_on(&fs, "/", "/", &json!({"action":"read","path":path}))
        .await
        .unwrap();
    assert_eq!(original["text"], "original");
    assert_eq!(
        files::action_on(
            &fs,
            "/",
            "/",
            &json!({"action":"write","path":path,"text":"change","version":"stale"})
        )
        .await
        .unwrap_err()
        .status,
        409
    );
    files::action_on(
        &fs,
        "/",
        "/",
        &json!({"action":"write","path":path,"text":"saved","version":original["version"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        session
            .read_file(&fixture.home(), &path)
            .await
            .unwrap()
            .data,
        b"saved"
    );
    let Err(missing) = session
        .read_file(&fixture.home(), "/missing-reading-fixture")
        .await
    else {
        panic!("A missing reading file must be rejected");
    };
    assert_eq!(missing.status, 404);
    assert_eq!(missing.message, "File not found.");
    files::make_directory_on(&fs, "/", "/", &fixture.home(), "copies")
        .await
        .unwrap();
    fs.symlink("docs", &format!("{}/link", fixture.home()))
        .await
        .unwrap();
    files::action_on(&fs,"/","/",&json!({"action":"copy","paths":[format!("{}/docs",fixture.home()),format!("{}/link",fixture.home())],"destination":format!("{}/copies",fixture.home())})).await.unwrap();
    assert!(
        fs.metadata(&format!("{}/copies/link", fixture.home()), false)
            .await
            .unwrap()
            .is_symlink()
    );
    assert_eq!(
        fs.read_link(&format!("{}/copies/link", fixture.home()))
            .await
            .unwrap(),
        "docs"
    );
    assert_eq!(
        files::action_on(
            &fs,
            "/",
            "/",
            &json!({"action":"read","path":format!("{}/link",fixture.home())})
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    let listing = files::list_files_on(&fs, "/", "/", &fixture.home())
        .await
        .unwrap();
    assert!(!listing.truncated);
    assert!(
        listing
            .entries
            .iter()
            .any(|e| e.name == "link" && e.directory && e.symlink)
    );
    files::action_on(
        &fs,
        "/",
        "/",
        &json!({"action":"delete","paths":[format!("{}/copies",fixture.home())]}),
    )
    .await
    .unwrap();
    assert!(
        fs.metadata(&format!("{}/copies", fixture.home()), false)
            .await
            .is_err()
    );
    let mut file = fs.open_read(&path).await.unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"saved");
    let directory = session.directory.clone();
    session.dispose().await;
    assert!(!std::path::Path::new(&directory).exists());
    fixture.stop().await;
}

#[tokio::test]
async fn compressed_ssh_selected_file_unchanged_and_delta_preserve_remote_bytes() {
    let fixture = Fixture::start().await;
    let mut input = fixture.input.clone();
    input["trust"] = json!(fixture.pin);
    input["compression"] = json!("on");
    let cancel = CancellationToken::new();
    let host = SSHHost::connect(&input, fixture.vault.clone(), None, true, &cancel)
        .await
        .unwrap();
    let fs = FileSystem {
        remote: Some(host.clone()),
    };
    let path = format!("{}/plugin.log", fixture.home());
    let text = "remote 界😀\n".repeat(1000);
    tokio::fs::write(&path, &text).await.unwrap();
    let mut cache = libertty_server::plugin_file::Cache::default();
    let first = cache
        .read(&fs, &fixture.home(), &fixture.home(), &path, None, &cancel)
        .await
        .unwrap();
    assert_eq!(first.value["text"], text);
    let same = cache
        .read(
            &fs,
            &fixture.home(),
            &fixture.home(),
            &path,
            Some(&first.etag),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(same.etag, first.etag);
    assert!(same.value.is_null());
    tokio::fs::write(&path, text + "new 😀\n").await.unwrap();
    let second = cache
        .read(
            &fs,
            &fixture.home(),
            &fixture.home(),
            &path,
            Some(&first.etag),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        cache.delta(&first.etag, &second).unwrap()["append"],
        "new 😀\n"
    );
    tokio::fs::write(&path, b"binary\0").await.unwrap();
    assert_eq!(
        cache
            .read(&fs, &fixture.home(), &fixture.home(), &path, None, &cancel)
            .await
            .err()
            .unwrap()
            .status,
        400
    );
    host.dispose().await;
    fixture.stop().await;
}

/// Real encrypted SSH socket counts with bounded FIFO pacing in each direction.
#[tokio::test]
#[ignore = "transport benchmark; run explicitly with --ignored --nocapture"]
async fn transport_ssh_benchmark() {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn pump(
        mut read: tokio::net::tcp::OwnedReadHalf,
        mut write: tokio::net::tcp::OwnedWriteHalf,
        count: Arc<AtomicU64>,
        rtt: f64,
        mbps: f64,
        cancel: CancellationToken,
    ) {
        let (send, mut receive) = mpsc::channel::<(tokio::time::Instant, Vec<u8>)>(16);
        let reader_cancel = cancel.clone();
        let reader = tokio::spawn(async move {
            let mut departure = tokio::time::Instant::now();
            loop {
                let mut bytes = vec![0; 16 * 1024];
                let n = tokio::select! { _=reader_cancel.cancelled()=>break, n=read.read(&mut bytes)=>match n{Ok(0)|Err(_)=>break,Ok(n)=>n} };
                bytes.truncate(n);
                count.fetch_add(n as u64, Ordering::Relaxed);
                departure = departure.max(tokio::time::Instant::now())
                    + Duration::from_secs_f64(n as f64 * 8.0 / (mbps * 1e6));
                let item = (departure + Duration::from_secs_f64(rtt / 2000.0), bytes);
                tokio::select! { _=reader_cancel.cancelled()=>break, result=send.send(item)=>if result.is_err(){break;} }
            }
        });
        loop {
            let item = tokio::select! { _=cancel.cancelled()=>break, item=receive.recv()=>item };
            let Some((when, bytes)) = item else { break };
            tokio::select! { _=cancel.cancelled()=>break, _=tokio::time::sleep_until(when)=>{} }
            if write.write_all(&bytes).await.is_err() {
                break;
            }
        }
        reader.abort();
        let _ = write.shutdown().await;
    }
    let fixture = Fixture::start().await;
    let mut rows = vec![];
    for (profile, rtt, mbps) in [("fast", 2.0, 100.0), ("constrained", 150.0, 1.0)] {
        for compression in ["off", "on"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let destination = fixture.input["port"].as_u64().unwrap() as u16;
            let up = Arc::new(AtomicU64::new(0));
            let down = Arc::new(AtomicU64::new(0));
            let (u, d) = (up.clone(), down.clone());
            let cancel = CancellationToken::new();
            let lifetime = cancel.clone();
            let proxy = tokio::spawn(async move {
                let (client, _) = listener.accept().await.unwrap();
                let server = tokio::net::TcpStream::connect(("127.0.0.1", destination))
                    .await
                    .unwrap();
                let (cr, cw) = client.into_split();
                let (sr, sw) = server.into_split();
                tokio::join!(
                    pump(cr, sw, u, rtt, mbps, lifetime.clone()),
                    pump(sr, cw, d, rtt, mbps, lifetime)
                );
            });
            let mut input = fixture.input.clone();
            input["port"] = json!(port);
            input["trust"] = json!(fixture.pin);
            input["compression"] = json!(compression);
            let start = std::time::Instant::now();
            let host = SSHHost::connect(&input, fixture.vault.clone(), None, false, &cancel)
                .await
                .unwrap();
            rows.push(json!({"profile":profile,"compression":compression,"case":"startup","ms":start.elapsed().as_secs_f64()*1000.0,"up":up.load(Ordering::Relaxed),"down":down.load(Ordering::Relaxed)}));
            for (name, bytes) in [
                ("typing", "hello 界😀\n".as_bytes().to_vec()),
                ("text", "INFO completed 界😀\n".repeat(10_000).into_bytes()),
                (
                    "random",
                    (0..65_536).map(|_| rand::random::<u8>()).collect(),
                ),
            ] {
                let path = format!("{}/wire-{name}", fixture.home());
                tokio::fs::write(&path, &bytes).await.unwrap();
                for sample in 0..7 {
                    let (u, d) = (up.load(Ordering::Relaxed), down.load(Ordering::Relaxed));
                    let start = std::time::Instant::now();
                    let mut stream = host
                        .open_stream(
                            &format!("cat {}", libertty_engine::repair::shell_quote(&path)),
                            &cancel,
                        )
                        .await
                        .unwrap()
                        .into_stream();
                    let mut out = vec![];
                    stream.read_to_end(&mut out).await.unwrap();
                    assert_eq!(out, bytes);
                    rows.push(json!({"profile":profile,"compression":compression,"case":name,"sample":sample,"ms":start.elapsed().as_secs_f64()*1000.0,"up":up.load(Ordering::Relaxed)-u,"down":down.load(Ordering::Relaxed)-d,"bytes":bytes.len()}));
                }
            }
            let fs = FileSystem {
                remote: Some(host.clone()),
            };
            let path = format!("{}/wire-text", fixture.home());
            let mut cache = libertty_server::plugin_file::Cache::default();
            let initial = cache
                .read(&fs, &fixture.home(), &fixture.home(), &path, None, &cancel)
                .await
                .unwrap();
            for method in ["sftp-full", "plugin-unchanged"] {
                for sample in 0..7 {
                    let (u, d) = (up.load(Ordering::Relaxed), down.load(Ordering::Relaxed));
                    let start = std::time::Instant::now();
                    if method == "sftp-full" {
                        let mut bytes = vec![];
                        fs.open_read(&path)
                            .await
                            .unwrap()
                            .read_to_end(&mut bytes)
                            .await
                            .unwrap();
                        assert_eq!(bytes, "INFO completed 界😀\n".repeat(10_000).into_bytes());
                    } else {
                        let same = cache
                            .read(
                                &fs,
                                &fixture.home(),
                                &fixture.home(),
                                &path,
                                Some(&initial.etag),
                                &cancel,
                            )
                            .await
                            .unwrap();
                        assert_eq!(same.etag, initial.etag);
                    }
                    rows.push(json!({"profile":profile,"compression":compression,"case":method,"sample":sample,"ms":start.elapsed().as_secs_f64()*1000.0,"up":up.load(Ordering::Relaxed)-u,"down":down.load(Ordering::Relaxed)-d}));
                }
            }
            host.dispose().await;
            cancel.cancel();
            proxy.abort();
        }
    }
    std::fs::create_dir_all("../../.test-artifacts").unwrap();
    std::fs::write("../../.test-artifacts/transport-ssh.json", serde_json::to_vec_pretty(&json!({"measurement":"Actual encrypted SSH TCP bytes, excluding TCP/IP headers; request to complete read; FIFO paced socket per direction; current CPU, no throttling; seven warm samples per case.","rows":rows})).unwrap()).unwrap();
    fixture.stop().await;
}
