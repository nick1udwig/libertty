use std::sync::atomic::Ordering;
use termai_server::herdr_reading::{Opened, open};
use tokio_util::sync::CancellationToken;
#[path = "support/herdr.rs"]
mod support;

#[tokio::test]
async fn readers_resolve_pane_paths_and_capture_binary_commands_once_with_status() {
    let mut fixture = support::Fixture::new().await;
    let startup = fixture.directory.path().join("bash-env");
    std::fs::write(&startup, "set -e -o pipefail\n").unwrap();
    fixture
        .target
        .env
        .insert("BASH_ENV".into(), startup.to_string_lossy().into_owned());
    fixture.reading_shell.store(true, Ordering::Relaxed);
    let cwd = fixture.directory.path().to_str().unwrap();
    fixture.snapshot.lock().unwrap()["panes"][0]["cwd"] = cwd.into();
    std::fs::write(fixture.directory.path().join("two words.md"), "# Reading").unwrap();
    let cancel = CancellationToken::new();
    let run = |command: &'static str| open(&fixture.target, "term_0", command, "1:1", cwd, &cancel);
    match run("look at 'two words.md'").await.unwrap() {
        Opened::File(path) => assert_eq!(path, format!("{cwd}/two words.md")),
        _ => panic!("Expected a file"),
    }
    for command in [
        "look at printf '\\000\\377ABC'",
        "printf '\\000\\377ABC' | look at",
    ] {
        match run(command).await.unwrap() {
            Opened::Capture {
                data, exit_code, ..
            } => {
                assert_eq!(data, b"\x00\xffABC");
                assert_eq!(exit_code, 0);
            }
            _ => panic!("Expected command output"),
        }
    }
    match run("look at sh -c 'printf x >> counter; printf result; exit 7'")
        .await
        .unwrap()
    {
        Opened::Capture {
            data, exit_code, ..
        } => {
            assert_eq!(data, b"result");
            assert_eq!(exit_code, 7);
        }
        _ => panic!("Expected command output"),
    }
    assert_eq!(
        std::fs::read(fixture.directory.path().join("counter")).unwrap(),
        b"x"
    );
    assert!(
        open(
            &fixture.target,
            "term_0",
            "look at printf wrong",
            "old",
            cwd,
            &cancel
        )
        .await
        .is_err()
    );
    fixture.reading_shell.store(false, Ordering::Relaxed);
    assert!(run("look at printf wrong").await.is_err());
}
