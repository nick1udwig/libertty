use std::{
    io::Write,
    process::{Command, Stdio},
};
#[test]
fn oversized_native_frames_are_bounded_and_the_next_request_still_works() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_termai-engine"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let chunk = vec![b'x'; 1024 * 1024];
    for _ in 0..65 {
        input.write_all(&chunk).unwrap();
    }
    input
        .write_all(b"\n{\"operation\":\"tokens\",\"args\":[\"echo hello\"]}\r\n")
        .unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    let replies: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["error"], "Engine request exceeds 64 MiB.");
    assert_eq!(
        replies[1],
        serde_json::json!({"ok":true,"value":[{"value":"echo","quoted":false},{"value":"hello","quoted":false}]})
    );
}
