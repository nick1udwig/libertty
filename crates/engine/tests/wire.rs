use libertty_engine::exchange;
use serde_json::{Value, json};

#[test]
fn malformed_requests_are_errors_and_do_not_corrupt_subsequent_requests() {
    for bytes in [
        b"null".as_slice(),
        b"[]",
        b"{",
        br#"{"operation":"unknown","args":[]}"#,
        br#"{"operation":"repair","args":[123]}"#,
    ] {
        let reply: Value = serde_json::from_slice(&exchange(bytes)).unwrap();
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].is_string());
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&exchange(
            r#"{"operation":"simpleWords","args":["echo 'hello 🌍'"]}"#.as_bytes()
        ))
        .unwrap(),
        json!({"ok":true,"value":[{"value":"echo","home":false},{"value":"hello 🌍","home":false}]})
    );
}

#[test]
fn optional_wire_fields_reject_null_and_preserve_omission() {
    let valid = json!({"file":true,"directory":false,"executable":false});
    let info: libertty_engine::types::FileInfo = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(serde_json::to_value(info).unwrap(), valid);
    assert!(
        serde_json::from_value::<libertty_engine::types::FileInfo>(
            json!({"file":true,"directory":false,"executable":false,"spelling":null})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<libertty_engine::types::Flag>(
            json!({"name":"--help","takesValue":false,"optionalValue":null})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<libertty_engine::types::Candidate>(
            json!({"command":"ls","score":100,"changes":[],"literal":null})
        )
        .is_err()
    );
}
