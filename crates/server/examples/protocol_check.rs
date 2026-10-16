use std::io::{self, BufRead};
use termai_server::protocol::{
    ClientMessage, DictationSource, DictationState, EngineMode, HerdrFrame, RepairReply,
    ServerMessage,
};
fn server_samples() -> Vec<ServerMessage> {
    let id = || "fixture".to_owned();
    vec![
        ServerMessage::Pong,
        ServerMessage::RepairResult(RepairReply::new(id(), "echo words".into(), 1, 2, true)),
        ServerMessage::InputLine {
            id: id(),
            prompt: 1,
            revision: 2,
            text: Some("世界".into()),
            cursor: Some(2),
        },
        ServerMessage::Transfer {
            request: termai_server::transfers::Request {
                id: id(),
                action: "download".into(),
                path: "/fixture".into(),
                name: "fixture".into(),
            },
        },
        ServerMessage::Pasted {
            text: "words".into(),
            replace: false,
            prompt: 1,
            revision: 2,
            source: Some(DictationSource::Dictation),
            repairing: Some(true),
        },
        ServerMessage::Dictation {
            resume: Some(termai_server::dictation::Checkpoint {
                accepted_frames: 0,
                finished: false,
            }),
            id: id(),
            state: DictationState::Ready,
            message: None,
        },
        ServerMessage::ReadingFile {
            path: "/fixture".into(),
        },
        ServerMessage::ReadingCapture(termai_server::reading::Descriptor {
            id: id(),
            name: "output".into(),
            exit_code: 0,
        }),
        ServerMessage::ReadingError {
            message: "fixture".into(),
        },
        ServerMessage::SshCommand {
            id: id(),
            command: "ssh fixture".into(),
        },
        ServerMessage::HerdrCommand {
            id: id(),
            command: "herdr".into(),
        },
        ServerMessage::SshReleased { id: id() },
        ServerMessage::Output {
            seq: 1,
            data: "世界\r\n".into(),
        },
        ServerMessage::ScreenDelta {
            base: 1,
            version: 2,
            drop: 0,
            from: 1,
            tail: 0,
            text: "changed".into(),
        },
        ServerMessage::Screen {
            version: Some(1),
            text: "history".into(),
        },
        ServerMessage::HerdrLayout {
            cols: 40,
            rows: 30,
            ready: true,
        },
        ServerMessage::HerdrFrame(HerdrFrame {
            seq: Some(1),
            width: 40,
            height: 30,
            full: true,
            bytes: [].into(),
        }),
        ServerMessage::State {
            state: termai_server::session::ShellState {
                cwd: "/fixture".into(),
                input_revision: 2,
                input_context: None,
                prompt_revision: 1,
                ready: true,
                prompt: 1,
                exited: false,
                exit_code: None,
                input_target: Some("shell".into()),
                terminal_scroll: Some(true),
            },
        },
        ServerMessage::Hello {
            engine: EngineMode::Server,
            reset: false,
            truncated: false,
            first_seq: 1,
            last_seq: Some(2),
            stream_id: id(),
        },
        ServerMessage::EditResult {
            id: id(),
            accepted: true,
            revision: 2,
        },
        ServerMessage::Result {
            id: id(),
            accepted: false,
            message: Some("fixture".into()),
        },
    ]
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--server") {
        println!("{}", serde_json::to_string(&server_samples()).unwrap());
        return;
    }
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        println!("{}", serde_json::from_str::<ClientMessage>(&line).is_ok());
    }
}
