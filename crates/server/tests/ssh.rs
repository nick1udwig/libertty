use rand::rngs::OsRng;
use serde_json::{Value, json};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use termai_server::{
    files,
    filesystem::FileSystem,
    host::{HostServices, NativeHost},
    session::{Session, Transport},
    ssh::SSHHost,
    vault::{Vault, fingerprint},
};
use tokio::{io::AsyncReadExt, sync::mpsc};
use tokio_util::sync::CancellationToken;

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
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = format!("{root}/sshd_config");
        tokio::fs::write(&config,format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {root}/host\nPidFile {root}/pid\nAuthorizedKeysFile {root}/authorized\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers {user}\nSetEnv HOME={root}/home\nSubsystem sftp internal-sftp\n")).await.unwrap();
        let executable = std::env::var("TERMAI_TEST_SSHD").unwrap_or_else(|_| {
            if std::path::Path::new("/usr/bin/sshd").exists() {
                "/usr/bin/sshd"
            } else {
                "/usr/sbin/sshd"
            }
            .into()
        });
        let child = tokio::process::Command::new(executable)
            .args(["-D", "-e", "-f", &config])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
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
        "x".repeat(termai_server::history::HISTORY_BYTES + 100)
            + "\n#123456789\necho eternal 界😀\n private command\n",
    )
    .await
    .unwrap();
    assert_eq!(host.history(&cancel).await, ["echo eternal 界😀"]);
    assert_eq!(
        host.history(&cancel).await,
        termai_server::history::read_history(&eternal, termai_server::history::HISTORY_BYTES).await
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
    let catalog = termai_engine::types::Catalog {
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
        termai_server::help::HelpProvider::new(Default::default()),
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
        Transport::Message(value) => {
            if value["type"] == "output" {
                session.receive(attachment, json!({"type":"ack","seq":value["seq"]}));
            }
            value
        }
        Transport::Close(code, reason) => panic!("Unexpected remote close {code}: {reason}"),
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
    let session = Session::start_remote(host.clone(), "server".into(), false, HostServices::new())
        .await
        .unwrap();
    let (attachment, mut receive) = session.attach(0, None);
    ready(&session, attachment, &mut receive, 0).await;
    assert_eq!(session.state().cwd, fixture.home());
    let snapshot = session.snapshot(true).await.unwrap();
    assert!(snapshot.0.commands.contains(&"cd".into()));
    assert_eq!(snapshot.1["HOME"], fixture.home());
    let prompt = session.state().prompt;
    session.receive(attachment,json!({"type":"command","id":"remote-command","command":"printf remote-output","prompt":prompt}));
    ready(&session, attachment, &mut receive, prompt).await;
    assert!(
        session
            .snapshot(false)
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
