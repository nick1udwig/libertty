use base64::{Engine, engine::general_purpose::STANDARD};
use termai_server::markers::{Event, Markers, marker};
fn all_splits(nonce: &str, record: &str, expected: &[Event], visible: &str) {
    for split in (0..=record.len()).filter(|split| record.is_char_boundary(*split)) {
        let mut parser = Markers::new(nonce);
        let (mut a, mut events) = parser.feed(&record[..split]);
        let (b, tail) = parser.feed(&record[split..]);
        a.push_str(&b);
        events.extend(tail);
        assert_eq!(a, visible, "split {split}");
        assert_eq!(events, expected, "split {split}");
    }
}
#[test]
fn wrapped_prompt_payload_survives_character_chunks_and_embedded_newlines() {
    let payload = STANDARD.encode("/tmp/a\nb\0  12 echo hello");
    let wrapped = payload
        .as_bytes()
        .chunks(8)
        .map(|bytes| std::str::from_utf8(bytes).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let record = format!("\x1b]777;termai;nonce;prompt;0;{wrapped}\x07");
    let mut parser = Markers::new("nonce");
    let mut events = Vec::new();
    for ch in record.chars() {
        let (visible, next) = parser.feed(&ch.to_string());
        assert!(visible.is_empty());
        events.extend(next);
    }
    assert_eq!(
        events,
        vec![Event::Prompt {
            cwd: "/tmp/a\nb".into(),
            code: 0.0,
            history: "  12 echo hello".into()
        }]
    );
}
#[test]
fn split_records_strip_only_this_shells_nonce_and_leave_other_oscs_visible() {
    let record = format!(
        "before\x1b]777;termai;secret;prompt;7;{};{}\x07after",
        STANDARD.encode("/a folder"),
        STANDARD.encode("  3  echo hi")
    );
    all_splits(
        "secret",
        &record,
        &[Event::Prompt {
            cwd: "/a folder".into(),
            code: 7.0,
            history: "  3  echo hi".into(),
        }],
        "beforeafter",
    );
    all_splits("other", &record, &[], &record);
    let mut parser = Markers::new("secret");
    assert_eq!(
        parser.feed("\x1b]0;title\x07"),
        ("\x1b]0;title\x07".into(), vec![])
    );
    assert_eq!(
        parser.feed("\x1b]777;termai;secret;busy\x07"),
        ("".into(), vec![Event::Busy])
    );
}
#[test]
fn unicode_readline_prefixes_use_utf16_cursor_units() {
    let text = "echo 界😀 tail";
    let prefix = "echo 界😀";
    let record = format!(
        "\x1b]777;termai;secret;input-line;{};{}\x07",
        STANDARD.encode(prefix),
        STANDARD.encode(text)
    );
    all_splits(
        "secret",
        &record,
        &[Event::InputLine {
            text: text.into(),
            cursor: prefix.encode_utf16().count(),
        }],
        "",
    );
}
#[test]
fn capture_markers_validate_private_names_and_exit_codes() {
    let ssh = "ssh -i '/tmp/key with spaces' user@server";
    all_splits(
        "secret",
        &marker("secret", "ssh", ssh),
        &[Event::Ssh {
            command: ssh.into(),
        }],
        "",
    );
    let record = format!(
        "\x1b]777;termai;secret;reading-capture;read.aB123456;{};7\x07",
        STANDARD.encode("git diff")
    );
    all_splits(
        "secret",
        &record,
        &[Event::ReadingCapture {
            file: "read.aB123456".into(),
            name: "git diff".into(),
            exit_code: 7,
        }],
        "",
    );
    let mut parser = Markers::new("secret");
    assert!(
        parser
            .feed(&record.replace("read.aB123456", "../private"))
            .1
            .is_empty()
    );
    assert!(
        parser
            .feed(&record.replace(";7\x07", ";999\x07"))
            .1
            .is_empty()
    );
    assert_eq!(
        parser
            .feed(&marker("secret", "reading-file", "/tmp/a b.md"))
            .1,
        vec![Event::ReadingFile {
            path: "/tmp/a b.md".into()
        }]
    );
    assert!(
        parser
            .feed(&marker("secret", "ssh", "echo\ncontrol"))
            .1
            .is_empty()
    );
    all_splits(
        "secret",
        &marker("secret", "transfer-upload", "/tmp/a b"),
        &[Event::TransferUpload {
            path: "/tmp/a b".into(),
        }],
        "",
    );
    all_splits(
        "secret",
        &format!(
            "\x1b]777;termai;secret;transfer-capture;download.aB123456;{}\x07",
            STANDARD.encode("a b.txt")
        ),
        &[Event::TransferCapture {
            file: "download.aB123456".into(),
            name: "a b.txt".into(),
        }],
        "",
    );
}
