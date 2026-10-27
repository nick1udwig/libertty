use libertty_engine::types::Catalog;
use libertty_server::facts::context_key;
use std::collections::BTreeMap;

#[test]
fn context_identity_tracks_prompt_cwd_and_environment() {
    let env = BTreeMap::from([("HOME".into(), "/fixture".into())]);
    let catalog = Catalog {
        cwd: "/fixture".into(),
        ..Catalog::default()
    };
    let key = context_key(1, &catalog, &env);
    assert_ne!(context_key(2, &catalog, &env), key);
    let mut changed = catalog.clone();
    changed.cwd = "/other".into();
    assert_ne!(context_key(1, &changed, &env), key);
    let mut changed_env = env.clone();
    changed_env.insert("PRIVATE_SECRET".into(), "changed".into());
    assert_ne!(context_key(1, &catalog, &changed_env), key);
    changed.paths.push("new-file".into());
    changed.cwd = catalog.cwd;
    assert_eq!(context_key(1, &changed, &env), key);
}
