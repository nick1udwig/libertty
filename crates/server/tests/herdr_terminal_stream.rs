use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, time::Duration};
use termai_server::{
    herdr::Target,
    herdr_terminal_stream::{Hub, Size},
};
use tokio::sync::mpsc;

struct Fixture {
    root: tempfile::TempDir,
    target: Target,
}
impl Fixture {
    fn new(fail: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("herdr");
        std::fs::write(&binary, include_str!("support/terminal.py")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut target = Target::local("").unwrap();
        target.binary = binary.to_string_lossy().into_owned();
        target.socket_path = Some(
            root.path()
                .join("herdr.sock")
                .to_string_lossy()
                .into_owned(),
        );
        target.env.insert(
            "TEST_TERMINAL_LOG".into(),
            root.path().join("log").to_string_lossy().into_owned(),
        );
        target.env.insert(
            "TEST_TERMINAL_FRAME".into(),
            root.path().join("frame").to_string_lossy().into_owned(),
        );
        if fail {
            target.env.insert("TEST_TERMINAL_FAIL".into(), "1".into());
        }
        Self { root, target }
    }
    fn events(&self, kind: &str) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|event| event["event"] == kind)
            .collect()
    }
    fn reaped(&self) -> usize {
        self.events("open")
            .iter()
            .filter(|event| {
                let pid = event["pid"].as_i64().unwrap() as libc::pid_t;
                // Signal zero checks existence without changing the process.
                (unsafe { libc::kill(pid, 0) }) == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            })
            .count()
    }
    fn frame(&self, full: bool) {
        std::fs::write(self.root.path().join("frame"), json!({"type":"terminal.frame","encoding":"ansi","width":40,"height":30,"full":full,"bytes":"YWJjZA=="}).to_string()).unwrap();
    }
}
async fn until(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("Terminal stream must settle");
}
async fn frame(receive: &mut mpsc::Receiver<Value>, width: u16, full: bool) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let message = receive.recv().await.unwrap();
            if message["type"] == "herdr-frame"
                && message["width"] == width
                && message["full"] == full
            {
                return message;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn observers_ignoring_stdin_do_not_delay_mobile_control_or_disposal() {
    let mut fixture = Fixture::new(false);
    fixture
        .target
        .env
        .insert("TEST_TERMINAL_OBSERVER_IGNORES_STDIN".into(), "1".into());
    let hub = Hub::default();
    let (send, mut receive) = mpsc::channel(128);
    let view = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    frame(&mut receive, 80, true).await;

    view.resize(Some(Size { cols: 40, rows: 30 })).unwrap();
    tokio::time::timeout(Duration::from_millis(750), frame(&mut receive, 40, true))
        .await
        .expect("Mobile control must not wait for an observer's shutdown grace period");
    assert_eq!(
        fixture.reaped(),
        1,
        "The observer must be reaped before control opens"
    );

    view.resize(None).unwrap();
    frame(&mut receive, 80, true).await;
    assert!(
        fixture
            .events("command")
            .iter()
            .any(|event| { event["message"]["type"] == "terminal.release" }),
        "Controllers must still release geometry gracefully"
    );
    assert_eq!(fixture.reaped(), 2);

    drop(view);
    tokio::time::timeout(Duration::from_millis(750), until(|| fixture.reaped() == 3))
        .await
        .expect("The last observer must be reaped without a shutdown grace period");
}

#[tokio::test]
async fn mobile_viewers_share_geometry_release_to_observers_and_clamp_scroll_cells() {
    let fixture = Fixture::new(false);
    let hub = Hub::default();
    let (send, mut desktop_frames) = mpsc::channel(128);
    let desktop = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    frame(&mut desktop_frames, 80, true).await;
    desktop.scroll(-2, 1, 2).await.unwrap();
    assert!(fixture.events("command").is_empty());
    let (send, mut first_frames) = mpsc::channel(128);
    let first = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    first.resize(Some(Size { cols: 42, rows: 31 })).unwrap();
    frame(&mut first_frames, 42, true).await;
    assert_eq!(fixture.events("open").len(), 2);
    assert_eq!(fixture.reaped(), 1);
    frame(&mut desktop_frames, 42, true).await;
    let (send, mut second_frames) = mpsc::channel(128);
    let second = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    frame(&mut second_frames, 42, true).await;
    second.resize(Some(Size { cols: 58, rows: 22 })).unwrap();
    frame(&mut second_frames, 58, true).await;
    first.resize(Some(Size { cols: 39, rows: 19 })).unwrap();
    frame(&mut first_frames, 39, true).await;
    first.resize(None).unwrap();
    frame(&mut second_frames, 58, true).await;
    second.scroll(-3, 99, 99).await.unwrap();
    second.scroll(1, 3, 4).await.unwrap();
    until(|| {
        fixture
            .events("command")
            .iter()
            .filter(|e| e["message"]["type"] == "terminal.scroll")
            .count()
            == 4
    })
    .await;
    let scroll = fixture
        .events("command")
        .into_iter()
        .filter(|e| e["message"]["type"] == "terminal.scroll")
        .map(|e| e["message"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        &scroll[..3],
        vec![
            json!({"type":"terminal.scroll","source":"wheel","direction":"up","lines":1,"column":57,"row":21});
            3
        ]
    );
    assert_eq!(
        scroll[3],
        json!({"type":"terminal.scroll","source":"wheel","direction":"down","lines":1,"column":3,"row":4})
    );
    second.resize(None).unwrap();
    second.scroll(10, 0, 0).await.unwrap();
    frame(&mut desktop_frames, 80, true).await;
    assert_eq!(fixture.events("open").len(), 3);
    assert_eq!(
        fixture
            .events("command")
            .iter()
            .filter(|e| e["message"]["type"] == "terminal.scroll")
            .count(),
        4
    );
    drop((first, second, desktop));
    until(|| fixture.reaped() == 3).await;
}

#[tokio::test]
async fn incremental_join_refresh_preserves_controller_and_observers_cannot_repaint() {
    let fixture = Fixture::new(false);
    let hub = Hub::default();
    let (send, mut first_frames) = mpsc::channel(128);
    let first = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    first.resize(Some(Size { cols: 40, rows: 30 })).unwrap();
    frame(&mut first_frames, 40, true).await;
    fixture.frame(false);
    frame(&mut first_frames, 40, false).await;
    let (send, mut second_frames) = mpsc::channel(128);
    let second = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(second_frames.try_recv().is_err());
    second.resize(Some(Size { cols: 40, rows: 30 })).unwrap();
    frame(&mut second_frames, 40, true).await;
    second.refresh();
    frame(&mut second_frames, 40, true).await;
    assert_eq!(fixture.events("open").len(), 1);
    first.resize(Some(Size { cols: 55, rows: 25 })).unwrap();
    frame(&mut first_frames, 55, true).await;
    frame(&mut second_frames, 55, true).await;
    second.refresh();
    frame(&mut second_frames, 55, true).await;
    until(|| fixture.events("command").len() == 4).await;
    let commands = fixture.events("command");
    assert_eq!(
        commands
            .iter()
            .map(|command| command["message"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!({"type":"terminal.resize","cols":40,"rows":30}),
            json!({"type":"terminal.resize","cols":40,"rows":30}),
            json!({"type":"terminal.resize","cols":55,"rows":25}),
            json!({"type":"terminal.resize","cols":55,"rows":25}),
        ]
    );
    let (send, _) = mpsc::channel(128);
    let observer = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    observer.refresh();
    drop(second);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(fixture.events("command").len(), commands.len());
    drop((observer, first));
    until(|| fixture.events("close").len() == 1).await;
}

#[tokio::test]
async fn failed_controllers_retry_with_a_bound_and_stop_when_the_last_viewer_leaves() {
    let fixture = Fixture::new(true);
    let hub = Hub::default();
    let (send, mut receive) = mpsc::channel(128);
    let view = hub
        .subscribe(fixture.target.clone(), "term_0".into(), send)
        .unwrap();
    view.resize(Some(Size { cols: 40, rows: 20 })).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while receive.recv().await.unwrap()["type"] != "reading-error" {}
    })
    .await
    .unwrap();
    assert_eq!(fixture.events("open").len(), 1);
    drop(view);
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert_eq!(fixture.events("open").len(), 1);
}
