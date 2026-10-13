use serde_json::{Value, json};
use std::collections::BTreeMap;
use termai_engine::types::Catalog;
use termai_server::facts::{Facts, context_key, validate};

#[test]
fn wire_context_hides_environment_reuses_catalogs_and_emits_only_changed_fields() {
    let env = BTreeMap::from([
        ("HOME".into(), "/fixture".into()),
        ("PRIVATE_SECRET".into(), "do-not-send".into()),
    ]);
    let mut catalog = Catalog {
        cwd: "/fixture".into(),
        commands: vec!["git".into()].into(),
        history: vec!["git init".into()].into(),
        ..Catalog::default()
    };
    let mut facts = Facts::default();
    let first = facts.context(1, catalog.clone(), &env, None, false);
    assert!(!first.to_string().contains("do-not-send"));
    assert_eq!(first["home"], "/fixture");
    let key = first["catalogKey"].as_str().unwrap();
    let second = facts.context(1, catalog.clone(), &env, Some(key), false);
    assert!(second.get("catalog").is_none());
    assert!(second.get("patch").is_none());
    catalog.paths.push("new-file".into());
    let third = facts.context(1, catalog.clone(), &env, Some(key), true);
    assert_eq!(third["key"], first["key"]);
    assert_ne!(third["catalogKey"], first["catalogKey"]);
    assert_eq!(third["base"], key);
    assert_eq!(third["patch"], json!({"paths":["new-file"]}));
    assert_ne!(context_key(2, &catalog, &env), first["key"]);
    let mut changed = env.clone();
    changed.insert("PRIVATE_SECRET".into(), "changed".into());
    assert_ne!(context_key(1, &catalog, &changed), first["key"]);
    for i in 0..9 {
        catalog.paths = vec![i.to_string()].into();
        facts.context(1, catalog.clone(), &env, None, true);
    }
    assert!(
        facts
            .context(1, catalog, &env, Some(key), true)
            .get("catalog")
            .is_some()
    );
}

#[test]
fn complete_fact_batches_reject_invalid_paths_limits_routes_and_expensive_operations() {
    for valid in [
        json!([{"kind":"entries","path":"/fixture","limit":10000.0}]),
        json!([{"kind":"directory","path":"/fixture","version":""}]),
        json!([{"kind":"help","command":"tool","route":["workspace","reconcile"]}]),
        json!([{"kind":"scoped","cwd":"/other","operation":{"kind":"help","command":"tool","route":["workspace"]}}]),
    ] {
        assert!(validate(&valid).is_ok());
    }
    for invalid in [
        Value::Null,
        json!({}),
        json!([]),
        json!(vec![json!({"kind":"syntax","command":"true"}); 65]),
        json!([null]),
        json!([{"kind":"unknown"}]),
        json!([{"kind":"scoped","cwd":"relative","operation":{"kind":"syntax","command":"true"}}]),
        json!([{"kind":"scoped","cwd":"/other","operation":{"kind":"scoped","cwd":"/nested","operation":{"kind":"syntax","command":"true"}}}]),
        json!(vec![
            json!({"kind":"scoped","cwd":"/other","operation":{"kind":"help","command":"tool","route":[]}});
            9
        ]),
        json!([{"kind":"stat","path":"relative"}]),
        json!([{"kind":"stat","path":"/bad\0path"}]),
        json!([{"kind":"stat","path":format!("/{}","🌍".repeat(2048))}]),
        json!([{"kind":"entries","path":"/fixture","limit":0}]),
        json!([{"kind":"entries","path":"/fixture","limit":10001}]),
        json!([{"kind":"entries","path":"/fixture","limit":1.5}]),
        json!([{"kind":"directory","path":"/fixture","version":null}]),
        json!([{"kind":"directory","path":"/fixture","version":"x".repeat(257)}]),
        json!([{"kind":"syntax","command":"tool\ncontrol"}]),
        json!([{"kind":"help","command":"tool","route":["--evil"]}]),
        json!([{"kind":"help","command":"tool","route":["a","b","c","d"]}]),
        json!(vec![
            json!({"kind":"entries","path":"/fixture","limit":1});
            9
        ]),
        json!(vec![json!({"kind":"help","command":"tool","route":[]}); 9]),
        json!([{"kind":"syntax","command":"true"},{"kind":"completion","words":["tool","bad\noperand"]}]),
    ] {
        assert!(validate(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn prepared_contexts_keep_wire_keys_and_invalidate_functions_history_and_environment() {
    use std::sync::Arc;
    let mut facts = Facts::default();
    let env = BTreeMap::from([("HOME".into(), "/fixture".into())]);
    let catalog = Catalog {
        cwd: "/fixture".into(),
        functions: Some(vec!["helper".into()].into()),
        history_cwds: Some(Arc::new(BTreeMap::from([("ls".into(), "/old".into())]))),
        ..Catalog::default()
    };
    let first = facts.context(1, catalog.clone(), &env, None, true);
    assert_eq!(
        first["catalogKey"],
        termai_server::facts::digest(&json!(catalog))
    );
    for prompt in 1..4 {
        let next = facts.context(
            prompt,
            catalog.clone(),
            &env,
            first["catalogKey"].as_str(),
            true,
        );
        assert_eq!(next["key"], context_key(prompt, &catalog, &env));
        assert!(next.get("catalog").is_none());
    }
    let mut changed = catalog.clone();
    changed.functions.as_mut().unwrap().push("second".into());
    Arc::make_mut(changed.history_cwds.as_mut().unwrap()).insert("ls".into(), "/new".into());
    let next = facts.context(4, changed, &env, first["catalogKey"].as_str(), true);
    assert_eq!(
        next["patch"],
        json!({"functions":["helper","second"],"historyCwds":{"ls":"/new"}})
    );
    assert_eq!(catalog.functions.as_ref().unwrap().as_slice(), ["helper"]);
    assert_eq!(catalog.history_cwds.as_ref().unwrap()["ls"], "/old");
    let mut changed_env = env.clone();
    changed_env.insert("PWD".into(), "/different".into());
    let next = facts.context(1, catalog.clone(), &changed_env, None, true);
    assert_ne!(next["key"], first["key"]);
    assert_eq!(next["discoveryKey"], first["discoveryKey"]);
    changed_env.insert("HOME".into(), "/new-home".into());
    let next = facts.context(1, catalog, &changed_env, None, true);
    assert_ne!(next["discoveryKey"], first["discoveryKey"]);
    assert_eq!(next["home"], "/new-home");
}
