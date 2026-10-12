use serde_json::Value;
use std::sync::Arc;
use termai_engine::{
    Request,
    host::FactValue,
    runtime::{DirectoryPin, DirectoryReference, HostResult, Reply, Runtime, Step},
    types::{DirectoryEntry, DirectoryLookup, SharedList},
};
mod common;

#[test]
fn asynchronous_operations_match_reference_results_and_host_operations() {
    check(include_str!(
        "../../../test/fixtures/rust-migration/host.json"
    ));
}
#[test]
fn native_bash_and_filesystem_reference_results_match() {
    check(include_str!(
        "../../../test/fixtures/rust-migration/native-host.json"
    ));
}
fn check(source: &str) {
    let corpus: Value = serde_json::from_str(source).unwrap();
    for mode in 0..3 {
        for (index, row) in corpus["fixtures"].as_array().unwrap().iter().enumerate() {
            let mut runtime = Runtime::default();
            if let Some(metadata) = row.get("metadata") {
                let seed: Request = serde_json::from_value(serde_json::json!({"operation":"seedMetadata","args":[row["args"][1],row["args"][2],metadata]})).unwrap();
                assert!(matches!(runtime.start(1, seed, 0.0), Step::Complete { .. }));
            }
            let request: Request = serde_json::from_value(
                serde_json::json!({"operation":row["operation"],"args":row["args"]}),
            )
            .unwrap();
            let mut step = runtime.start(2, request, 0.0);
            let mut observed = Vec::new();
            let mut directory = 0;
            for _ in 0..128 {
                match step {
                    Step::Pending { callbacks, .. } => {
                        assert!(!callbacks.is_empty(), "Fixture {index}: stalled");
                        let mut pins = Vec::new();
                        let replies = callbacks
                            .into_iter()
                            .map(|callback| {
                                let mut results = Vec::new();
                                let mut native = Vec::new();
                                for operation in callback.operations {
                                    let mut operation = operation;
                                    if let Some(object) = operation.as_object_mut() {
                                        object.remove("timeoutMs");
                                    }
                                    observed.push(operation.clone());
                                    let fact = row["facts"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .find(|fact| fact["operation"] == operation)
                                        .unwrap_or_else(|| {
                                            panic!("Fixture {index}: unexpected fact {operation}")
                                        });
                                    let value = &fact["reply"]["value"];
                                    if mode == 1 {
                                        native.push(
                                            if let Some(error) = fact["reply"]["error"].as_str() {
                                                Err(error.to_owned())
                                            } else {
                                                Ok(match operation["kind"].as_str() {
                                                    Some("lookup") => {
                                                        serde_json::from_value::<DirectoryLookup>(
                                                            value.clone(),
                                                        )
                                                        .map(|lookup| {
                                                            FactValue::Lookup(Arc::new(lookup))
                                                        })
                                                        .unwrap_or_else(|_| value.clone().into())
                                                    }
                                                    Some("entries") => serde_json::from_value::<
                                                        SharedList<DirectoryEntry>,
                                                    >(
                                                        value.clone()
                                                    )
                                                    .map(FactValue::Entries)
                                                    .unwrap_or_else(|_| value.clone().into()),
                                                    _ => value.clone().into(),
                                                })
                                            },
                                        );
                                    }
                                    if mode == 2 && fact["reply"].get("error").is_none() {
                                        let lookup = (operation["kind"] == "lookup")
                                            .then(|| {
                                                serde_json::from_value::<DirectoryLookup>(
                                                    value.clone(),
                                                )
                                                .ok()
                                            })
                                            .flatten();
                                        let listing = lookup
                                            .filter(|lookup| lookup.info.is_none())
                                            .and_then(|lookup| lookup.listing);
                                        let entries = if operation["kind"] == "entries" {
                                            serde_json::from_value::<SharedList<DirectoryEntry>>(
                                                value.clone(),
                                            )
                                            .ok()
                                        } else {
                                            listing.as_ref().map(|listing| listing.entries.clone())
                                        };
                                        if let Some(entries) = entries {
                                            directory += 1;
                                            pins.push(DirectoryPin {
                                                directory,
                                                entries: Some(entries),
                                            });
                                            results.push(if let Some(listing) = listing {
                                                HostResult::Lookup {
                                                    lookup: DirectoryReference {
                                                        directory,
                                                        version: listing.version,
                                                        complete: listing.complete,
                                                    },
                                                }
                                            } else {
                                                HostResult::Entries { entries: directory }
                                            });
                                            continue;
                                        }
                                    }
                                    results.push(
                                        if let Some(message) = fact["reply"]["error"].as_str() {
                                            HostResult::Error {
                                                error: message.to_owned(),
                                            }
                                        } else {
                                            HostResult::Value {
                                                value: fact["reply"]["value"].clone(),
                                            }
                                        },
                                    );
                                }
                                if mode == 1 {
                                    Reply::Native {
                                        request: callback.request,
                                        results: native,
                                    }
                                } else {
                                    Reply::Results {
                                        request: callback.request,
                                        results,
                                    }
                                }
                            })
                            .collect();
                        if !pins.is_empty() {
                            runtime.pin_directories(2, pins).unwrap();
                        }
                        step = runtime.resume(2, replies, 0.0);
                    }
                    Step::Complete { value, .. } => {
                        assert!(
                            common::same_json(&value, &row["expected"]["value"]),
                            "Fixture {index}: expected {}, actual {value}",
                            row["expected"]["value"]
                        );
                        break;
                    }
                    Step::Error { error, .. } => {
                        assert_eq!(
                            Some(error.as_str()),
                            row["expected"]["error"].as_str(),
                            "Fixture {index}"
                        );
                        break;
                    }
                }
            }
            assert_eq!(runtime.active(), 0, "Fixture {index}: leaked request");
            for fact in row["facts"].as_array().unwrap() {
                assert!(
                    observed.contains(&fact["operation"]),
                    "Fixture {index}: missing reference host fact {}",
                    fact["operation"]
                );
            }
        }
    }
}
