use libertty_engine::{
    Request,
    runtime::{Reply, Runtime, Step},
};
use serde_json::{Value, json};

fn prepare(text: &str, intent: Value) -> Value {
    let mut runtime = Runtime::default();
    let request: Request = serde_json::from_value(json!({
        "operation": "alternatives",
        "args": [text, intent, {
            "cwd": "/fixture", "commands": ["cat", "echo"],
            "paths": ["README.md"], "history": []
        }, {}]
    }))
    .unwrap();
    let mut step = runtime.start(1, request, 0.0);
    for wave in 1..=20 {
        step = match step {
            Step::Complete { value, .. } => return value,
            Step::Pending { callbacks, .. } => {
                let replies = callbacks.into_iter().map(|callback| Reply::Values {
                    request: callback.request,
                    values: callback.operations.iter().map(|operation| {
                        use libertty_engine::host::HostOperation;
                        match operation {
                            HostOperation::Syntax { .. } => json!(true),
                            HostOperation::Help { command, .. } if command == "echo" => json!({"flags":[],"subcommands":[]}),
                            HostOperation::Stat { path, .. } => {
                                if path == "/fixture/README.md" {
                                    json!({"file": true, "directory": false, "executable": false})
                                } else {
                                    Value::Null
                                }
                            }
                            _ => panic!("Unexpected fact: {operation:?}"),
                        }
                    }).collect(),
                }).collect();
                runtime.resume(1, replies, f64::from(wave))
            }
            _ => panic!("Preparation failed"),
        };
    }
    panic!("Preparation exceeded its fact-wave limit")
}

#[test]
fn production_preparation_preserves_original_and_maps_reader_choices() {
    for (text, intent, selected) in [
        (
            "cat readme dot md",
            json!({"kind":"shell"}),
            "cat README.md",
        ),
        (
            "look at readme dot md",
            json!({"kind":"reading-file","phrase":"look at","operand":"readme dot md"}),
            "look at README.md",
        ),
        (
            "echo hello pipe look at",
            json!({"kind":"reading-pipeline","phrase":"look at","command":"echo hello"}),
            "echo hello | look at",
        ),
    ] {
        let result = prepare(text, intent);
        assert_eq!(result["original"], text);
        assert_eq!(result["selected"], selected);
        let choices = result["candidates"].as_array().unwrap();
        assert!(choices.len() <= 4);
        assert!(choices.iter().any(|choice| choice["command"] == selected));
        assert!(
            choices
                .iter()
                .any(|choice| choice["command"] == text && choice["literal"] == true)
        );
    }
}

#[test]
fn reading_intents_match_the_shared_browser_contract() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../../test/fixtures/reading-intents.json")).unwrap();
    for fixture in fixtures {
        let actual = libertty_engine::alternatives::Intent::detect(
            fixture["text"].as_str().unwrap(),
            &fixture["phrases"],
        );
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            fixture["intent"],
            "{}",
            fixture["text"]
        );
    }
}
