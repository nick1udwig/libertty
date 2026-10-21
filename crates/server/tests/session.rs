use libertty_server::{
    host::HostServices,
    session::{Session, Transport},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

#[test]
fn pty_contracts_run_in_an_isolated_shell_environment() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("history"), "echo remembered-command\n").unwrap();
    std::fs::write(
        root.path().join("eternal-history"),
        "#1234567890\ngit init\n",
    )
    .unwrap();
    std::fs::create_dir(root.path().join("subfolder")).unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "pty_contract_child", "--nocapture"])
        .env("LIBERTTY_PTY_TEST_ROOT", root.path())
        .env("HOME", root.path())
        .env("LIBERTTY_NO_RC", "1")
        .env("LIBERTTY_HISTORY_FILE", root.path().join("history"))
        .env(
            "LIBERTTY_ETERNAL_HISTORY_FILE",
            root.path().join("eternal-history"),
        )
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
struct Browser {
    session: Arc<Session>,
    id: u64,
    receive: mpsc::UnboundedReceiver<Transport>,
    output: String,
    seq: u64,
}
impl Browser {
    fn attach(session: Arc<Session>, after: u64, stream: Option<&str>) -> Self {
        let (id, receive) = session.attach(after, stream, None);
        Self {
            session,
            id,
            receive,
            output: String::new(),
            seq: after,
        }
    }
    async fn next(&mut self) -> Value {
        match tokio::time::timeout(Duration::from_secs(10), self.receive.recv())
            .await
            .expect("PTY response timeout")
            .expect("live attachment")
        {
            Transport::Close(code, reason) => panic!("Unexpected close {code}: {reason}"),
            message => {
                let value = message.value().unwrap();
                if value["type"] == "output" {
                    let seq = value["seq"].as_u64().unwrap();
                    assert!(seq > self.seq, "Output must be ordered");
                    self.seq = seq;
                    self.output.push_str(value["data"].as_str().unwrap());
                    self.send(json!({"type":"ack","seq":seq}));
                }
                value
            }
        }
    }
    fn send(&self, value: Value) {
        self.session.receive(self.id, value);
    }
    async fn until(&mut self, check: impl Fn(&Value) -> bool) -> Value {
        loop {
            let value = self.next().await;
            if check(&value) {
                return value;
            }
        }
    }
    async fn ready(&mut self, after: u64) {
        let output_at = self.output.len();
        self.until(|value| {
            value["type"] == "state"
                && value["state"]["ready"] == true
                && value["state"]["prompt"].as_u64().is_some_and(|p| p > after)
        })
        .await;
        // The prompt marker precedes Readline restoring raw terminal input.
        // Wait for its bracketed-paste enable before sending control keys.
        while !self.output[output_at..].contains("\x1b[?2004h") {
            self.next().await;
        }
    }
    async fn command(&mut self, id: &str, command: &str) {
        let prompt = self.session.state().prompt;
        self.send(json!({"type":"command","id":id,"command":command,"prompt":prompt}));
        let result = self.until(|v| v["type"] == "result" && v["id"] == id).await;
        assert_eq!(result["accepted"], true, "{}", result);
        self.ready(prompt).await;
    }
    async fn typed(&mut self, command: &str) {
        let prompt = self.session.state().prompt;
        self.send(json!({"type":"input","data":format!("{command}\r")}));
        self.ready(prompt).await;
        assert_eq!(self.session.state().exit_code, Some(0.0), "{command}");
    }
}

#[tokio::test]
async fn light_catalog_does_not_poison_full_paths_and_nested_changes_refresh() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    let session = Session::start(
        root.path().to_str().unwrap().into(),
        vec!["cd".into()],
        true,
        HostServices::new(),
    )
    .await
    .unwrap();
    assert!(session.snapshot(false).await.unwrap().0.paths.is_empty());
    assert_eq!(
        session.snapshot(true).await.unwrap().0.paths.as_slice(),
        ["nested/"]
    );
    assert_eq!(
        session.snapshot(true).await.unwrap().0.paths.as_slice(),
        ["nested/"]
    );
    std::fs::write(root.path().join("nested/new-script.py"), "").unwrap();
    assert!(session.snapshot(false).await.unwrap().0.paths.is_empty());
    assert!(
        session
            .snapshot(true)
            .await
            .unwrap()
            .0
            .paths
            .contains(&"nested/new-script.py".into())
    );
    session.dispose().await;
}

#[tokio::test]
async fn native_suggestions_refresh_paths_and_honor_cancellation() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("Workspace")).unwrap();
    std::fs::write(
        root.path().join("hello_world.py"),
        "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n",
    )
    .unwrap();
    let session = Session::start(
        root.path().to_str().unwrap().into(),
        vec!["cd".into(), "python3".into()],
        true,
        HostServices::new(),
    )
    .await
    .unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    // A light directory repair must not poison the next full script catalog.
    let candidates = session.suggest("cd work space", &cancel).await.unwrap();
    assert_eq!(candidates["candidates"][0]["command"], "cd Workspace");
    let python = session
        .suggest("Python three hello world dot py myarg food", &cancel)
        .await
        .unwrap();
    assert_eq!(
        python["candidates"][0]["command"],
        "python3 hello_world.py --myarg food"
    );
    cancel.cancel();
    assert!(session.suggest("cd work space", &cancel).await.is_err());
    session.dispose().await;
}

#[test]
fn large_readline_and_private_utilities_run_in_isolated_home() {
    let root = tempfile::tempdir().unwrap();
    let mut lines = (0..5500)
        .map(|i| format!("echo eternal-{i}"))
        .collect::<Vec<_>>();
    lines[600] = "echo libertty-eternal-needle".into();
    std::fs::write(root.path().join(".bash_history"), "echo standard-only\n").unwrap();
    std::fs::write(
        root.path().join(".bash_eternal_history"),
        format!("#123456789\n{}\n", lines.join("\n")),
    )
    .unwrap();
    std::fs::write(root.path().join("payload.txt"), "payload").unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "large_readline_and_private_utilities_child",
            "--nocapture",
        ])
        .env("LIBERTTY_LARGE_HISTORY_ROOT", root.path())
        .env("HOME", root.path())
        .env("INPUTRC", "/dev/null")
        .env("HISTSIZE", "20")
        .env("LIBERTTY_NO_RC", "1")
        .env_remove("LIBERTTY_HISTORY_FILE")
        .env_remove("LIBERTTY_ETERNAL_HISTORY_FILE")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[tokio::test]
async fn large_readline_and_private_utilities_child() {
    let Ok(root) = std::env::var("LIBERTTY_LARGE_HISTORY_ROOT") else {
        return;
    };
    let session = Session::start(root.clone(), vec![], false, HostServices::new())
        .await
        .unwrap();
    let mut browser = Browser::attach(session.clone(), 0, None);
    browser.ready(0).await;
    browser.send(json!({"type":"input","data":"\x12libertty-eternal-needle\x05"}));
    browser.send(json!({"type":"input-line","id":"search","prompt":session.state().prompt,"revision":session.state().input_revision}));
    let found = browser
        .until(|message| message["type"] == "input-line" && message["id"] == "search")
        .await;
    assert_eq!(found["text"], "echo libertty-eternal-needle");
    assert_eq!(
        session.state().prompt,
        1,
        "Searching must not execute the command"
    );
    browser.typed("\x15 builtin history > bash-history").await;
    let mut expected = (500..5500)
        .map(|i| format!("echo eternal-{i}"))
        .collect::<Vec<_>>();
    expected[100] = "echo libertty-eternal-needle".into();
    let saved = std::fs::read_to_string(format!("{root}/bash-history")).unwrap();
    let history = saved
        .lines()
        .map(|line| {
            line.trim_start()
                .split_once(' ')
                .unwrap()
                .1
                .trim_start()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(history, expected);
    // Compare both histories after an ordinary typed command establishes the boundary.
    browser.typed("echo keep-before").await;
    for command in [
        "upload",
        "download payload.txt",
        "look at payload.txt",
        "printf 'piped data' | download result.txt",
        "printf 'read output' | look at",
    ] {
        browser.typed(command).await;
    }
    browser
        .command("generated-download", "download payload.txt")
        .await;
    browser
        .command("generated-reading", "look at payload.txt")
        .await;
    browser
        .typed("echo 'upload | download | look at payload.txt'")
        .await;
    browser.typed("echo keep-after").await;
    browser.typed(" builtin history > utility-history").await;
    let expected = [
        "echo keep-before",
        "echo 'upload | download | look at payload.txt'",
        "echo keep-after",
    ];
    let catalog = session.snapshot(false).await.unwrap().0;
    assert_eq!(&catalog.history[catalog.history.len() - 3..], expected);
    let saved = std::fs::read_to_string(format!("{root}/utility-history")).unwrap();
    let history = saved
        .lines()
        .map(|line| {
            line.trim_start()
                .split_once(' ')
                .unwrap()
                .1
                .trim_start()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(&history[history.len() - 3..], expected);
    assert_eq!(history.len(), 5000);
    session.dispose().await;
}
#[tokio::test]
async fn pty_contract_child() {
    let Ok(cwd) = std::env::var("LIBERTTY_PTY_TEST_ROOT") else {
        return;
    };
    let session = Session::start(
        cwd.clone(),
        vec![
            "echo".into(),
            "git".into(),
            "ls".into(),
            "cat".into(),
            "printf".into(),
        ],
        false,
        HostServices::new(),
    )
    .await
    .unwrap();
    let private = session.directory.clone();
    let mut browser = Browser::attach(session.clone(), 0, None);
    let hello = browser.next().await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["reset"], true);
    browser.ready(0).await;
    let catalog = session.snapshot(true).await.unwrap().0;
    assert!(catalog.history.contains(&"echo remembered-command".into()));
    assert!(catalog.history.contains(&"git init".into()));
    assert!(catalog.paths.contains(&"subfolder/".into()));

    let repair_state = session.state();
    for data in ["\x1b[I", "\x1b[O"] {
        browser.send(json!({"type":"input","data":data}));
        assert_eq!(session.state().input_revision, repair_state.input_revision);
    }
    browser.send(json!({"type":"repair","id":"fused","text":"Get in it.","prompt":repair_state.prompt,"revision":repair_state.input_revision}));
    browser.send(json!({"type":"input","data":"\x1b[I"}));
    let repaired = browser
        .until(|value| value["type"] == "repair-result" && value["id"] == "fused")
        .await;
    assert_eq!(repaired["accepted"], true, "{repaired}");
    assert_eq!(repaired["selected"], "git init");
    assert_eq!(repaired["original"], "Get in it.");
    assert!(
        !std::path::Path::new(&cwd).join(".git").exists(),
        "Repair must never submit the line"
    );
    browser.send(json!({"type":"input-line","id":"fused-line","prompt":session.state().prompt,"revision":session.state().input_revision}));
    assert_eq!(
        browser
            .until(|value| value["type"] == "input-line" && value["id"] == "fused-line")
            .await["text"],
        "git init"
    );
    browser.send(json!({"type":"repair","id":"stale-repair","text":"echo wrong","prompt":repair_state.prompt,"revision":repair_state.input_revision}));
    assert_eq!(
        browser
            .until(|value| value["type"] == "repair-result" && value["id"] == "stale-repair")
            .await["accepted"],
        false
    );
    let repair_state = session.state();
    browser.send(json!({"type":"repair","id":"cancel-repair","text":"echo wrong","prompt":repair_state.prompt,"revision":repair_state.input_revision}));
    browser.send(json!({"type":"repair-cancel","id":"cancel-repair"}));
    assert_eq!(
        browser
            .until(|value| value["type"] == "repair-result" && value["id"] == "cancel-repair")
            .await["accepted"],
        false
    );
    browser.send(json!({"type":"repair","id":"edited-repair","text":"echo wrong","prompt":repair_state.prompt,"revision":repair_state.input_revision}));
    browser.send(json!({"type":"input","data":"X"}));
    assert_eq!(
        browser
            .until(|value| value["type"] == "repair-result" && value["id"] == "edited-repair")
            .await["accepted"],
        false
    );
    browser.send(json!({"type":"replace","id":"clear-repair","text":"","prompt":session.state().prompt,"revision":session.state().input_revision}));
    assert_eq!(
        browser
            .until(|value| value["type"] == "edit-result" && value["id"] == "clear-repair")
            .await["accepted"],
        true
    );

    browser.send(json!({"type":"input","data":"echo Unicode🌱"}));
    let state = session.state();
    browser.send(json!({"type":"input-line","id":"line","prompt":state.prompt,"revision":state.input_revision}));
    let line = browser
        .until(|v| v["type"] == "input-line" && v["id"] == "line")
        .await;
    assert_eq!(line["text"], "echo Unicode🌱");
    assert_eq!(
        line["cursor"].as_u64().unwrap(),
        "echo Unicode🌱".encode_utf16().count() as u64
    );
    browser.send(json!({"type":"replace","id":"clear","text":"","prompt":state.prompt,"revision":state.input_revision}));
    assert_eq!(
        browser
            .until(|v| v["type"] == "edit-result" && v["id"] == "clear")
            .await["accepted"],
        true
    );
    browser.send(json!({"type":"replace","id":"stale","text":"echo never","prompt":state.prompt,"revision":state.input_revision}));
    assert_eq!(
        browser
            .until(|v| v["type"] == "edit-result" && v["id"] == "stale")
            .await["accepted"],
        false
    );

    browser.typed("echo 界😀").await;
    for (id, input, expected, cursor) in [
        ("history", "\x1b[A", "echo 界😀", 8),
        ("edited", "\x01\x04", "cho 界😀", 0),
        ("completion", "\x15\x05\x15echo comp\t", "echo comp", 9),
    ] {
        browser.send(json!({"type":"input","data":input}));
        browser.send(json!({"type":"input-line","id":id,"prompt":session.state().prompt,"revision":session.state().input_revision}));
        let line = browser
            .until(|message| message["type"] == "input-line" && message["id"] == id)
            .await;
        assert_eq!(line["text"], expected);
        assert_eq!(line["cursor"], cursor);
        assert_eq!(
            session.state().prompt,
            2,
            "Snapshots must not execute the editable line"
        );
        assert!(session.state().ready);
    }

    browser
        .command("once", "printf x >> counter; printf UNIQUE_OUTPUT")
        .await;
    assert_eq!(
        std::fs::read_to_string(format!("{cwd}/counter")).unwrap(),
        "x"
    );
    browser.send(json!({"type":"command","id":"once","command":"printf x >> counter","prompt":session.state().prompt}));
    assert_eq!(
        browser
            .until(|v| v["type"] == "result" && v["id"] == "once")
            .await["accepted"],
        true
    );
    browser.send(
        json!({"type":"command","id":"old-prompt","command":"printf x >> counter","prompt":0}),
    );
    assert_eq!(
        browser
            .until(|v| v["type"] == "result" && v["id"] == "old-prompt")
            .await["accepted"],
        false
    );
    assert_eq!(
        std::fs::read_to_string(format!("{cwd}/counter")).unwrap(),
        "x"
    );

    let prompt = session.state().prompt;
    browser.send(json!({"type":"command","id":"capture","command":"report() { printf x >> capture-counter; printf '\\033[31mworks/two words\\033[0m'; return 7; }; look at report","prompt":prompt}));
    let capture = browser.until(|v| v["type"] == "reading-capture").await;
    let saved = session
        .reading_capture(capture["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(saved.data, b"works/two words");
    assert_eq!(saved.exit_code, 7);
    assert_eq!(
        std::fs::read_to_string(format!("{cwd}/capture-counter")).unwrap(),
        "x"
    );
    if !session.state().ready {
        browser.ready(prompt).await;
    }
    let prompt = session.state().prompt;
    browser.send(json!({"type":"command","id":"binary-capture","command":"printf '\\000\\377ABC' | look at","prompt":prompt}));
    let capture = browser.until(|v| v["type"] == "reading-capture").await;
    assert_eq!(
        session
            .reading_capture(capture["id"].as_str().unwrap())
            .unwrap()
            .data,
        [0, 255, 65, 66, 67]
    );
    if !session.state().ready {
        browser.ready(prompt).await;
    }

    let prompt = session.state().prompt;
    browser.send(json!({"type":"command","id":"transfer","command":"printf '\\000\\377ABC' | download 'result file.bin'","prompt":prompt}));
    let transfer = browser.until(|v| v["type"] == "transfer").await["request"].clone();
    assert_eq!(transfer["name"], "result file.bin");
    assert_eq!(
        std::fs::read(transfer["path"].as_str().unwrap()).unwrap(),
        [0, 255, 65, 66, 67]
    );
    if !session.state().ready {
        browser.ready(prompt).await;
    }
    session.acknowledge_transfer(transfer["id"].as_str().unwrap());
    assert!(session.transfer(transfer["id"].as_str().unwrap()).is_some());

    let old_id = browser.id;
    let old_seq = browser.seq;
    let mut newer = Browser::attach(session.clone(), old_seq, Some(&session.stream_id));
    loop {
        match tokio::time::timeout(Duration::from_secs(2), browser.receive.recv())
            .await
            .unwrap()
        {
            Some(Transport::Close(4001, _)) => break,
            Some(Transport::Server(_) | Transport::Message(_)) => {}
            other => panic!(
                "Expected the previous attachment to close: {}",
                other.is_some()
            ),
        }
    }
    let hello = newer.next().await;
    assert_eq!(hello["reset"], false);
    newer.until(|v| v["type"] == "state").await;
    session.detach(old_id);
    session.receive(old_id,json!({"type":"command","id":"former-tab","command":"printf x >> counter","prompt":session.state().prompt}));
    newer.command("new-tab", "printf NEW_TAB").await;
    assert_eq!(
        std::fs::read_to_string(format!("{cwd}/counter")).unwrap(),
        "x"
    );
    assert!(newer.output.contains("NEW_TAB"));
    newer
        .command(
            "large",
            "head -c 300000 /dev/zero | tr '\\000' x; printf LARGE_DONE",
        )
        .await;
    assert!(newer.output.len() > 300000);
    assert!(newer.output.contains("LARGE_DONE"));
    assert!(
        session
            .snapshot(false)
            .await
            .unwrap()
            .0
            .history
            .iter()
            .any(|h| h.contains("LARGE_DONE"))
    );
    session.dispose().await;
    assert!(!std::path::Path::new(&private).exists());
    assert!(session.transfer(transfer["id"].as_str().unwrap()).is_none());
}
