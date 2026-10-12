use serde_json::{Value, json};
use termai_engine::{Request, dispatch, exchange};
mod common;
use common::same_json;

#[test]
fn reference_corpus_preserves_complete_outputs() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-migration/engine.json"
    ))
    .unwrap();
    let lexical: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-migration/lexical.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for (index, row) in corpus["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .chain(lexical["fixtures"].as_array().unwrap())
        .enumerate()
    {
        let request: Request = serde_json::from_value(row.clone()).unwrap();
        let actual = dispatch(&request).unwrap_or_else(|error| json!({"error":error}));
        if !same_json(&actual, &row["result"]) && failures.len() < 30 {
            failures.push(format!(
                "fixture {index}: {} {:?}\nexpected={}\nactual={actual}",
                request.operation, request.args, row["result"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

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
    let info: termai_engine::types::FileInfo = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(serde_json::to_value(info).unwrap(), valid);
    assert!(
        serde_json::from_value::<termai_engine::types::FileInfo>(
            json!({"file":true,"directory":false,"executable":false,"spelling":null})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<termai_engine::types::Flag>(
            json!({"name":"--help","takesValue":false,"optionalValue":null})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<termai_engine::types::Candidate>(
            json!({"command":"ls","score":100,"changes":[],"literal":null})
        )
        .is_err()
    );
}
