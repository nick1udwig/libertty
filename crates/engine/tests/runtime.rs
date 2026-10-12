use serde_json::{Value, json};
use termai_engine::{
    Request,
    runtime::{Reply, Runtime, Step},
};
#[test]
fn prepared_contexts_preserve_pending_snapshots_reject_stale_ids_and_reset() {
    use termai_engine::types::Catalog;
    fn complete(runtime: &mut Runtime, mut step: Step) -> Value {
        for now in 1..50 {
            match step {
                Step::Complete { value, .. } => return value,
                Step::Error { error, .. } => panic!("{error}"),
                Step::Pending { request, callbacks } => {
                    let replies = callbacks
                        .into_iter()
                        .map(|callback| Reply::Values {
                            request: callback.request,
                            values: callback
                                .operations
                                .iter()
                                .map(|op| match op["kind"].as_str().unwrap() {
                                    "syntax" => json!(true),
                                    "entries" | "completion" => json!([]),
                                    _ => Value::Null,
                                })
                                .collect(),
                        })
                        .collect();
                    step = runtime.resume(request, replies, now as f64);
                }
            }
        }
        panic!("The engine must complete without an unbounded callback loop")
    }
    let first = json!({"cwd":"/fixture","commands":["git"],"paths":[],"history":["git init"]});
    let second = json!({"cwd":"/fixture","commands":["ls"],"paths":[],"history":[]});
    let mut runtime = Runtime::default();
    runtime
        .prepare_context(
            1,
            serde_json::from_value::<Catalog>(first.clone()).unwrap(),
            Default::default(),
        )
        .unwrap();
    let pending = runtime.start_prepared(1, "Get in it.".into(), 1, 0.0);
    assert!(matches!(pending, Step::Pending { .. }));
    runtime
        .prepare_context(
            2,
            serde_json::from_value(second).unwrap(),
            Default::default(),
        )
        .unwrap();
    assert!(matches!(
        runtime.start_prepared(2, "Get in it.".into(), 1, 0.0),
        Step::Error { .. }
    ));
    let actual = complete(&mut runtime, pending);
    let mut reference = Runtime::default();
    let step = reference.start(
        1,
        Request {
            operation: "suggest".into(),
            args: vec![json!("Get in it."), first, json!({})],
        },
        0.0,
    );
    assert_eq!(actual, complete(&mut reference, step));
    assert!(
        actual
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["command"] == "git init")
    );
    assert!(
        runtime
            .prepare_context(2, Catalog::default(), Default::default())
            .is_err()
    );
    runtime.reset();
    assert!(matches!(
        runtime.start_prepared(2, "ls".into(), 2, 0.0),
        Step::Error { .. }
    ));
    assert!(
        runtime
            .prepare_context(1, Catalog::default(), Default::default())
            .is_err()
    );
    runtime
        .prepare_context(3, Catalog::default(), Default::default())
        .unwrap();
}

#[test]
fn fused_directory_import_and_resume_matches_separate_calls_and_rejects_partial_imports() {
    use termai_engine::runtime::{DirectoryPin, message};
    let request: Request = serde_json::from_value(json!({"operation":"repairDirectory","args":["cd work space",{"cwd":"/fixture","commands":["cd"],"paths":[],"history":[]},""]})).unwrap();
    let mut fused = Runtime::default();
    let mut separate = Runtime::default();
    let Step::Pending { callbacks, .. } = fused.start(
        1,
        Request {
            operation: request.operation.clone(),
            args: request.args.clone(),
        },
        0.0,
    ) else {
        panic!("Expected lookup");
    };
    separate.start(1, request, 0.0);
    let pins =
        json!([{"directory":1,"entries":[{"name":"Workspace","directory":true,"symlink":false}]}]);
    let replies = json!([{"request":callbacks[0].request,"results":[{"lookup":{"directory":1,"version":"v1","complete":true}}]}]);
    let bad = json!({"request":1,"replies":replies,"now":1,"directories":[pins[0],pins[0]]});
    assert!(matches!(
        message(&mut fused, &serde_json::to_vec(&bad).unwrap(), true),
        Step::Error { request: 1, .. }
    ));
    let valid = json!({"request":1,"replies":replies,"now":1,"directories":pins});
    let actual = message(&mut fused, &serde_json::to_vec(&valid).unwrap(), true);
    assert!(!matches!(actual, Step::Error { .. }));
    separate
        .pin_directories(
            1,
            serde_json::from_value::<Vec<DirectoryPin>>(pins).unwrap(),
        )
        .unwrap();
    let expected = separate.resume(1, serde_json::from_value(replies).unwrap(), 1.0);
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
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
fn directory_pins_survive_eviction_but_reject_stale_and_cross_request_references() {
    use termai_engine::{
        runtime::{DirectoryPin, DirectoryReference, HostResult},
        types::{DirectoryEntry, SharedList},
    };
    assert!(serde_json::from_value::<DirectoryPin>(json!({"directory":1,"entries":null})).is_err());
    let entries: SharedList<_> = vec![DirectoryEntry {
        name: "Workspace".into(),
        directory: true,
        symlink: false,
    }]
    .into();
    let repair = || {
        serde_json::from_value(json!({"operation":"repairDirectory","args":["cd work space",{"cwd":"/fixture","commands":["cd"],"paths":[],"history":[]},""]})).unwrap()
    };
    let start = |runtime: &mut Runtime, id| {
        let Step::Pending { callbacks, .. } = runtime.start(id, repair(), 0.0) else {
            panic!("Expected a directory lookup");
        };
        assert_eq!(callbacks.len(), 1);
        assert_eq!(callbacks[0].operations.len(), 1);
        callbacks[0].request
    };
    let result = |callback| Reply::Results {
        request: callback,
        results: vec![HostResult::Lookup {
            lookup: DirectoryReference {
                directory: 1,
                version: "v1".into(),
                complete: true,
            },
        }],
    };
    let mut runtime = Runtime::default();
    let first = start(&mut runtime, 1);
    assert!(
        runtime
            .pin_directories(
                1,
                vec![
                    DirectoryPin {
                        directory: 1,
                        entries: Some(entries.clone())
                    },
                    DirectoryPin {
                        directory: 1,
                        entries: None
                    }
                ]
            )
            .is_err()
    );
    runtime
        .pin_directories(
            1,
            vec![DirectoryPin {
                directory: 1,
                entries: Some(entries.clone()),
            }],
        )
        .unwrap();
    let second = start(&mut runtime, 2);
    assert!(
        runtime
            .pin_directories(
                2,
                vec![DirectoryPin {
                    directory: 2,
                    entries: Some(vec![entries[0].clone(); 30001].into())
                }]
            )
            .is_err()
    );
    // A failed import does not consume an ID, and cache eviction cannot release an active request's pins.
    for id in 2..35 {
        runtime
            .pin_directories(
                2,
                vec![DirectoryPin {
                    directory: id,
                    entries: Some(entries.clone()),
                }],
            )
            .unwrap();
    }
    assert!(
        runtime
            .pin_directories(
                2,
                vec![DirectoryPin {
                    directory: 1,
                    entries: None
                }]
            )
            .is_err()
    );
    assert!(matches!(
        runtime.resume(2, vec![result(second)], 1.0),
        Step::Error { .. }
    ));
    assert_eq!(runtime.active(), 1);
    let Step::Complete { value, .. } = runtime.resume(1, vec![result(first)], 1.0) else {
        panic!("Pinned snapshot was lost");
    };
    assert_eq!(value[0]["command"], "cd Workspace");
    start(&mut runtime, 3);
    assert!(
        runtime
            .pin_directories(
                3,
                vec![DirectoryPin {
                    directory: 1,
                    entries: Some(entries.clone())
                }]
            )
            .is_err()
    );
    runtime
        .pin_directories(
            3,
            vec![DirectoryPin {
                directory: 35,
                entries: Some(entries.clone()),
            }],
        )
        .unwrap();
    runtime.cancel(3);
    assert!(
        runtime
            .pin_directories(
                3,
                vec![DirectoryPin {
                    directory: 35,
                    entries: None
                }]
            )
            .is_err()
    );
    runtime.reset();
    start(&mut runtime, 4);
    assert!(
        runtime
            .pin_directories(
                4,
                vec![DirectoryPin {
                    directory: 35,
                    entries: None
                }]
            )
            .is_err()
    );
    assert!(
        runtime
            .pin_directories(
                4,
                vec![DirectoryPin {
                    directory: 35,
                    entries: Some(entries.clone())
                }]
            )
            .is_err()
    );
    runtime
        .pin_directories(
            4,
            vec![DirectoryPin {
                directory: 36,
                entries: Some(entries),
            }],
        )
        .unwrap();
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
