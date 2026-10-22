use libertty_engine::{
    Request,
    runtime::{Reply, Runtime, Step},
};
use serde_json::{Value, json};

#[test]
fn failed_candidate_facts_leave_independently_validated_alternatives_available() {
    let mut runtime = Runtime::default();
    let request = Request {
        operation: "suggest".into(),
        args: vec![
            json!("cat my notes"),
            json!({"cwd":"/fixture","commands":["cat"],"paths":["my-notes","my_notes"],"history":[]}),
            json!({}),
            json!(false),
        ],
    };
    let Step::Pending { callbacks, .. } = runtime.start(1, request, 0.0) else {
        panic!("Expected validation facts");
    };
    let replies = callbacks
        .into_iter()
        .map(|callback| Reply::Results {
            request: callback.request,
            results: callback
                .operations
                .into_iter()
                .map(|operation| {
                    use libertty_engine::{host::HostOperation, runtime::HostResult};
                    match operation {
                        HostOperation::Syntax { command } if command == "cat my-notes" => {
                            HostResult::Error {
                                error: "Probe unavailable".into(),
                            }
                        }
                        HostOperation::Syntax { .. } => HostResult::Value { value: json!(true) },
                        HostOperation::Stat { path, .. } => HostResult::Value {
                            value: if path.ends_with("my-notes") || path.ends_with("my_notes") {
                                json!({"file":true,"directory":false,"executable":false})
                            } else {
                                Value::Null
                            },
                        },
                        _ => panic!("Unexpected fact: {operation:?}"),
                    }
                })
                .collect(),
        })
        .collect();
    let Step::Complete { value, .. } = runtime.resume(1, replies, 150.0) else {
        panic!("Validated alternative must survive");
    };
    assert_eq!(value[0]["command"], "cat my_notes");
}

#[test]
fn exhausted_request_budget_does_not_start_more_fact_waves() {
    let mut runtime = Runtime::default();
    let request = Request {
        operation: "suggest".into(),
        args: vec![
            json!("orbit target value"),
            json!({"cwd":"/fixture","commands":["orbit"],"paths":[],"history":[]}),
            json!({}),
            json!(false),
        ],
    };
    let Step::Pending { callbacks, .. } = runtime.start(1, request, 0.0) else {
        panic!("Expected discovery");
    };
    let replies = callbacks
        .into_iter()
        .map(|callback| Reply::Values {
            request: callback.request,
            values: callback
                .operations
                .iter()
                .map(|_| json!({"flags":[{"name":"--target","takesValue":true}],"subcommands":[]}))
                .collect(),
        })
        .collect();
    let Step::Complete { value, .. } = runtime.resume(1, replies, 4501.0) else {
        panic!("Budget exhaustion must finish without another wave");
    };
    assert!(
        value
            .as_array()
            .unwrap()
            .iter()
            .all(|candidate| candidate["literal"] == true)
    );
}

#[test]
fn independent_operand_validation_uses_one_callback_wave() {
    let mut runtime = Runtime::default();
    let request = Request {
        operation: "suggest".into(),
        args: vec![
            json!("ls alpha beta gamma"),
            json!({"cwd":"/fixture","commands":["ls"],"paths":["alpha","beta","gamma"],"history":[]}),
            json!({"HOME":"/fixture"}),
            json!(false),
        ],
    };
    let Step::Pending { callbacks, .. } = runtime.start(1, request, 0.0) else {
        panic!("Expected fact wave");
    };
    let operations: Vec<_> = callbacks.iter().flat_map(|c| &c.operations).collect();
    assert_eq!(
        operations
            .iter()
            .filter(|op| matches!(op, libertty_engine::host::HostOperation::Stat { .. }))
            .count(),
        3
    );
    let replies = callbacks
        .into_iter()
        .map(|callback| Reply::Values {
            request: callback.request,
            values: callback
                .operations
                .iter()
                .map(|op| match op {
                    libertty_engine::host::HostOperation::Syntax { .. } => json!(true),
                    libertty_engine::host::HostOperation::Stat { executable, .. } => {
                        assert!(!executable);
                        json!({"file":true,"directory":false,"executable":false})
                    }
                    _ => panic!("Unexpected operation: {op:?}"),
                })
                .collect(),
        })
        .collect();
    assert!(matches!(
        runtime.resume(1, replies, 150.0),
        Step::Complete { .. }
    ));
}
fn request(path: &str) -> Request {
    serde_json::from_value(json!({"operation":"candidateValid","args":["cat",{"command":format!("cat {path}"),"score":100,"changes":[]},
        {"cwd":"/fixture","commands":["cat"],"paths":[],"history":[]},{},{"flags":{},"subcommands":{}}]})).unwrap()
}
fn pending(step: Step) -> u32 {
    let Step::Pending { callbacks, .. } = step else {
        panic!("Expected pending host facts");
    };
    assert_eq!(callbacks.len(), 1);
    assert_eq!(callbacks[0].operations.len(), 2);
    callbacks[0].request
}
fn values(callback: u32, exists: bool) -> Reply {
    Reply::Values {
        request: callback,
        values: vec![
            json!(true),
            if exists {
                json!({"file":true,"directory":false,"executable":false})
            } else {
                Value::Null
            },
        ],
    }
}
#[test]
fn replies_cancellation_and_cached_facts_are_request_scoped() {
    let mut runtime = Runtime::default();
    let first = pending(runtime.start(1, request("one"), 0.0));
    let second = pending(runtime.start(2, request("two"), 0.0));
    assert_ne!(first, second);
    runtime.cancel(1);
    assert!(matches!(
        runtime.start(1, request("replacement"), 1.0),
        Step::Error { .. }
    ));
    assert!(matches!(
        runtime.resume(1, vec![values(first, true)], 1.0),
        Step::Error { .. }
    ));
    assert_eq!(runtime.active(), 1);
    assert!(matches!(
        runtime.resume(2, vec![values(second, false)], 1.0),
        Step::Complete {
            value: Value::Bool(false),
            ..
        }
    ));
    let third = pending(runtime.start(3, request("one"), 2.0));
    assert!(matches!(
        runtime.resume(3, vec![values(third, true)], 3.0),
        Step::Complete {
            value: Value::Bool(true),
            ..
        }
    ));
    assert_eq!(runtime.active(), 0);
}
#[test]
fn foreign_duplicate_and_incomplete_replies_fail_closed_without_affecting_other_requests() {
    for invalid in ["foreign", "duplicate", "incomplete"] {
        let mut runtime = Runtime::default();
        let first = pending(runtime.start(1, request("one"), 0.0));
        let second = pending(runtime.start(2, request("two"), 0.0));
        let replies = match invalid {
            "foreign" => vec![values(second, true)],
            "duplicate" => vec![values(first, true), values(first, true)],
            _ => vec![Reply::Values {
                request: first,
                values: vec![json!(true)],
            }],
        };
        assert!(matches!(
            runtime.resume(1, replies, 1.0),
            Step::Error { .. }
        ));
        assert_eq!(runtime.active(), 1);
        assert!(matches!(
            runtime.resume(2, vec![values(second, true)], 1.0),
            Step::Complete {
                value: Value::Bool(true),
                ..
            }
        ));
        assert_eq!(runtime.active(), 0);
    }
}
#[test]
fn request_limits_do_not_replace_existing_work_and_host_failures_propagate() {
    let mut runtime = Runtime::default();
    let callback = pending(runtime.start(1, request("one"), 0.0));
    assert!(matches!(
        runtime.start(1, request("two"), 0.0),
        Step::Error { .. }
    ));
    for id in 2..=32 {
        pending(runtime.start(id, request("one"), 0.0));
    }
    assert!(matches!(
        runtime.start(33, request("one"), 0.0),
        Step::Error { .. }
    ));
    assert!(
        matches!(runtime.resume(1,vec![Reply::Error { request:callback,error:"Host denied.".into() }],1.0), Step::Error { error, .. } if error=="Host denied.")
    );
    for id in 2..=32 {
        runtime.cancel(id);
    }
    assert_eq!(runtime.active(), 0);
}

#[test]
fn invalid_and_backwards_host_clocks_release_pending_requests() {
    for now in [-1.0, f64::NAN, f64::INFINITY] {
        let mut runtime = Runtime::default();
        assert!(matches!(
            runtime.start(1, request("one"), now),
            Step::Error { .. }
        ));
        assert_eq!(runtime.active(), 0);
    }
    let mut runtime = Runtime::default();
    let callback = pending(runtime.start(1, request("one"), 10.0));
    assert!(matches!(
        runtime.resume(1, vec![values(callback, true)], 9.0),
        Step::Error { .. }
    ));
    assert_eq!(runtime.active(), 0);
}

#[test]
fn separate_engine_instances_never_share_learned_command_metadata() {
    let mut first = Runtime::default();
    let mut second = Runtime::default();
    let catalog = json!({"cwd":"/project","commands":["orchard"],"paths":[],"history":[]});
    let seed = Request {
        operation: "seedMetadata".into(),
        args: vec![
            catalog.clone(),
            json!({}),
            json!({"flags":{"orchard":[{"name":"--private","takesValue":false}]},"subcommands":{}}),
        ],
    };
    assert!(matches!(first.start(1, seed, 0.0), Step::Complete { .. }));
    let query = || Request {
        operation: "cachedMetadata".into(),
        args: vec![catalog.clone(), json!({})],
    };
    let Step::Complete { value: private, .. } = first.start(2, query(), 1.0) else {
        panic!();
    };
    let Step::Complete { value: other, .. } = second.start(1, query(), 1.0) else {
        panic!();
    };
    assert_eq!(private["flags"]["orchard"][0]["name"], "--private");
    assert_eq!(other["flags"], json!({}));
    first.reset();
    let Step::Complete { value: reset, .. } = first.start(3, query(), 2.0) else {
        panic!();
    };
    assert_eq!(reset["flags"], json!({}));
}
