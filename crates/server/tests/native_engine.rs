use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    os::unix::fs::{PermissionsExt, symlink},
    sync::Arc,
    time::Duration,
};
use termai_engine::{Request, types::Catalog};
use termai_server::{
    completion::shell_complete,
    engine::NativeEngine,
    help::HelpProvider,
    host::{HostServices, NativeHost},
    probes::{ProbeOptions, ProbePool, SharedTask, probe},
    syntax::Syntax,
};
use tokio_util::sync::CancellationToken;

fn catalog(cwd: &str, commands: &[&str]) -> Catalog {
    Catalog {
        cwd: cwd.into(),
        commands: commands.iter().map(|s| (*s).into()).collect(),
        ..Catalog::default()
    }
}
fn request(operation: &str, args: Value) -> Request {
    serde_json::from_value(json!({"operation":operation,"args":args})).unwrap()
}
fn executable(file: &std::path::Path, content: &str) {
    std::fs::write(file, content).unwrap();
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[tokio::test]
async fn directory_facts_preserve_hidden_names_symlinks_bounds_and_fresh_versions() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    std::fs::create_dir(dir.path().join("My Folder")).unwrap();
    std::fs::write(dir.path().join(".hidden"), "").unwrap();
    std::fs::write(dir.path().join("Café 🌍"), "").unwrap();
    symlink("My Folder", dir.path().join("link")).unwrap();
    let services = HostServices::new();
    let facts = services.directories.clone();
    let cancel = CancellationToken::new();
    assert!(facts.entries(cwd, 0, &cancel).await.unwrap().is_empty());
    let first = facts.snapshot(cwd, 10000, &cancel).await.unwrap();
    assert!(first.complete);
    assert!(
        first
            .entries
            .iter()
            .any(|e| e.name == ".hidden" && !e.directory)
    );
    assert!(
        first
            .entries
            .iter()
            .any(|e| e.name == "link" && e.symlink && !e.directory)
    );
    let link = facts
        .stat(&format!("{cwd}/link"), true, &cancel)
        .await
        .unwrap()
        .unwrap();
    assert!(link.directory);
    let short = facts.snapshot(cwd, 2, &cancel).await.unwrap();
    assert_eq!(short.entries.len(), 2);
    assert!(!short.complete);
    assert!(short.entries.windows(2).all(|pair| {
        pair[0]
            .name
            .encode_utf16()
            .cmp(pair[1].name.encode_utf16())
            .is_le()
    }));
    assert_eq!(facts.snapshot(cwd, 2, &cancel).await.unwrap(), short);
    assert_eq!(
        facts.snapshot(cwd, 10000, &cancel).await.unwrap().version,
        first.version
    );
    let reused = facts.snapshot(cwd, 10000, &cancel).await.unwrap();
    assert!(first.entries.shares_storage(&reused.entries));
    let help = HelpProvider::new(services.pool.clone());
    let host = NativeHost::new(services, catalog(cwd, &["cd"]), BTreeMap::new(), help);
    let lookup = json!({"kind":"lookup","path":format!("{cwd}/missing")});
    let wire = host.fact(&lookup, &cancel).await.unwrap();
    let termai_engine::host::FactValue::Lookup(typed) =
        host.engine_fact(&lookup, &cancel).await.unwrap()
    else {
        panic!("Expected a typed directory lookup");
    };
    assert_eq!(serde_json::to_value(typed.as_ref()).unwrap(), wire);
    assert!(
        typed
            .listing
            .as_ref()
            .unwrap()
            .entries
            .shares_storage(&first.entries)
    );
    let termai_engine::host::FactValue::Entries(typed_entries) = host
        .engine_fact(&json!({"kind":"entries","path":cwd,"limit":10000}), &cancel)
        .await
        .unwrap()
    else {
        panic!("Expected typed entries");
    };
    assert!(typed_entries.shares_storage(&first.entries));
    std::fs::write(dir.path().join("new"), "").unwrap();
    let changed = facts.snapshot(cwd, 10000, &cancel).await.unwrap();
    assert_ne!(changed.version, first.version);
    assert!(changed.entries.iter().any(|e| e.name == "new"));
    assert!(!first.entries.iter().any(|e| e.name == "new"));
    assert!(!first.entries.shares_storage(&changed.entries));
    std::fs::remove_file(dir.path().join("new")).unwrap();
    let deleted = facts.snapshot(cwd, 10000, &cancel).await.unwrap();
    assert!(!deleted.entries.iter().any(|e| e.name == "new"));
    std::fs::remove_dir(dir.path().join("My Folder")).unwrap();
    std::fs::write(dir.path().join("My Folder"), "now a file").unwrap();
    let replaced = facts.snapshot(cwd, 10000, &cancel).await.unwrap();
    assert!(
        !replaced
            .entries
            .iter()
            .find(|e| e.name == "My Folder")
            .unwrap()
            .directory
    );
    assert_eq!(
        facts
            .path_spelling(&format!("{cwd}/My Folder"), &cancel)
            .await
            .unwrap()
            .as_deref(),
        Some(format!("{cwd}/My Folder").as_str())
    );
    cancel.cancel();
    assert!(facts.entries(cwd, 10000, &cancel).await.is_err());
    assert!(host.engine_fact(&lookup, &cancel).await.is_err());
}

#[tokio::test]
async fn syntax_parses_without_execution_and_cancellation_releases_probes() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let syntax = Syntax::default();
    let cancel = CancellationToken::new();
    let sentinel = dir.path().join("executed");
    assert!(
        syntax
            .valid(
                &format!(
                    "echo $(touch '{}') > '{}'",
                    sentinel.display(),
                    sentinel.display()
                ),
                cwd,
                &cancel
            )
            .await
            .unwrap()
    );
    assert!(
        !syntax
            .valid("echo 'unfinished", cwd, &cancel)
            .await
            .unwrap()
    );
    assert!(!sentinel.exists());
    cancel.cancel();
    assert!(syntax.valid("echo ok", cwd, &cancel).await.is_err());
    let pool = ProbePool::new(1);
    let options = ProbeOptions {
        cwd: cwd.into(),
        env: BTreeMap::new(),
        timeout: Duration::from_secs(30),
        max_buffer: 1024,
    };
    let cancellation = CancellationToken::new();
    let arguments = ["-c".into(), "sleep 20".into()];
    let work = probe(&pool, "/bin/sh", &arguments, &options, &cancellation);
    let stop = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancellation.cancel();
    };
    let (result, _) = tokio::join!(work, stop);
    assert!(result.is_err());
    assert!(!pool.busy());
    let output = probe(
        &pool,
        "/bin/sh",
        &["-c".into(), "printf recovered".into()],
        &options,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(output.stdout, b"recovered");
}

#[tokio::test]
async fn a_cancelled_subscriber_leaves_shared_work_for_the_other_subscriber() {
    let task = SharedTask::new(|cancel| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!cancel.is_cancelled());
            Ok(42)
        })
    });
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    let stop = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        first.cancel();
    };
    let (a, b, _) = tokio::join!(task.wait(&first), task.wait(&second), stop);
    assert!(a.is_err());
    assert_eq!(b.unwrap(), 42);
    assert!(!task.aborted());
}

#[tokio::test]
async fn native_help_coalesces_verified_routes_and_invalidates_context_and_executable_changes() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let tool = dir.path().join("orchard");
    executable(
        &tool,
        "#!/bin/sh\n/bin/sleep .03\nprintf '%s\\n' \"$*\" >> probes\nif [ \"$1\" = deploy ]; then printf '  --target NAME  Target\\n'; else printf 'Commands:\\n  deploy    Deploy it\\nOptions:\\n  --quiet  Silence\\n'; fi\n",
    );
    let catalog = catalog(cwd, &["orchard"]);
    let env = BTreeMap::from([("PATH".into(), cwd.into()), ("HOME".into(), cwd.into())]);
    let help = HelpProvider::new(ProbePool::default());
    let cancel = CancellationToken::new();
    let route = vec!["deploy".into()];
    let (first, second) = tokio::join!(
        help.read("orchard", &route, &catalog, &env, &cancel),
        help.read("orchard", &route, &catalog, &env, &cancel)
    );
    assert_eq!(first.unwrap().flags[0].name, "--target");
    assert_eq!(second.unwrap().flags[0].name, "--target");
    assert_eq!(help.help_probes(), 2);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("probes")).unwrap(),
        "--help\ndeploy --help\n"
    );
    assert!(
        help.read("orchard", &["destroy".into()], &catalog, &env, &cancel)
            .await
            .unwrap_err()
            .contains("Unverified")
    );
    let mut volatile = env.clone();
    volatile.insert("PWD".into(), "changed".into());
    volatile.insert("TERMAI_SECRET".into(), "synthetic".into());
    help.read("orchard", &[], &catalog, &volatile, &cancel)
        .await
        .unwrap();
    assert_eq!(help.help_probes(), 2);
    let mut meaningful = env.clone();
    meaningful.insert("HOME".into(), "/tmp".into());
    help.read("orchard", &[], &catalog, &meaningful, &cancel)
        .await
        .unwrap();
    assert_eq!(help.help_probes(), 3);
    executable(&tool, "#!/bin/sh\nprintf '  --changed  Different\\n'\n");
    assert_eq!(
        help.read("orchard", &[], &catalog, &env, &cancel)
            .await
            .unwrap()
            .flags[0]
            .name,
        "--changed"
    );
    assert_eq!(help.help_probes(), 4);
    help.dispose();
    assert!(
        help.read("orchard", &[], &catalog, &env, &cancel)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_completion_and_suggestions_preserve_ambiguity_quotes_and_operand_safety() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let definitions = dir.path().join("completions");
    std::fs::write(&definitions, "_orchard(){ COMPREPLY=('release/east-zone' 'release/west-zone'); printf 'private chatter'; }; complete -F _orchard orchard\n").unwrap();
    executable(
        &dir.path().join("orchard"),
        "#!/bin/sh\nif [ \"$1\" = deploy ]; then printf 'usage: orchard deploy [NAME]\\n'; else printf 'Commands:\\n  deploy    Deploy it\\n'; fi\n",
    );
    let catalog = catalog(cwd, &["orchard", "git", "cat", "cd"]);
    let env = BTreeMap::from([
        ("PATH".into(), format!("{cwd}:/usr/bin:/bin")),
        ("HOME".into(), cwd.into()),
        (
            "TERMAI_COMPLETIONS_FILE".into(),
            definitions.to_string_lossy().into_owned(),
        ),
    ]);
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let host = NativeHost::new(services, catalog.clone(), env.clone(), help.clone());
    let engine = NativeEngine::new().unwrap();
    let cancel = CancellationToken::new();
    for input in [
        "orchard deploy release slash east dash zone",
        "orchard deploy R E L E A S E slash east dash zone",
    ] {
        let result = engine
            .invoke(
                request("suggest", json!([input, catalog, env])),
                &host,
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(result[0]["command"], "orchard deploy release/east-zone");
        assert_eq!(result.as_array().unwrap().last().unwrap()["literal"], true);
    }
    let ambiguous = engine
        .invoke(
            request("suggest", json!(["orchard deploy release", catalog, env])),
            &host,
            &cancel,
        )
        .await
        .unwrap();
    let commands: Vec<_> = ambiguous
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| {
            c["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str().unwrap().starts_with("Completion →"))
        })
        .map(|c| c["command"].as_str().unwrap())
        .collect();
    assert_eq!(
        commands,
        [
            "orchard deploy release/east-zone",
            "orchard deploy release/west-zone"
        ]
    );
    let quoted = engine
        .invoke(
            request("suggest", json!(["orchard deploy 'release'", catalog, env])),
            &host,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(quoted[0]["command"], "orchard deploy 'release'");
    let sentinel = dir.path().join("executed");
    shell_complete(
        &host.services.pool,
        &[
            "orchard".into(),
            "deploy".into(),
            format!("$(touch '{}')", sentinel.display()),
        ],
        cwd,
        &env,
        &cancel,
    )
    .await
    .unwrap();
    assert!(!sentinel.exists());
    assert!(!ambiguous.to_string().contains("private chatter"));
    let other = NativeEngine::new().unwrap();
    let cached = other
        .invoke(
            request("cachedMetadata", json!([catalog, env])),
            &host,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(cached["flags"], json!({}));
    engine.reset().unwrap();
    let cached = engine
        .invoke(
            request("cachedMetadata", json!([catalog, env])),
            &host,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(cached["flags"], json!({}));
    help.dispose();
}

#[tokio::test]
async fn cancelled_native_discovery_does_not_poison_later_work() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    executable(
        &dir.path().join("orchard"),
        "#!/bin/sh\n/bin/sleep .2\nprintf '  --quiet  Silence\\n'\n",
    );
    let catalog = catalog(cwd, &["orchard"]);
    let env = BTreeMap::from([("PATH".into(), cwd.into())]);
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let host = Arc::new(NativeHost::new(
        services,
        catalog.clone(),
        env.clone(),
        help.clone(),
    ));
    let engine = NativeEngine::new().unwrap();
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    let a = engine.invoke(
        request("discover", json!(["orchard", catalog, env])),
        &host,
        &first,
    );
    let b = engine.invoke(
        request("discover", json!(["orchard", catalog, env])),
        &host,
        &second,
    );
    let stop = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        first.cancel();
    };
    let (a, b, _) = tokio::join!(a, b, stop);
    assert!(a.is_err());
    assert_eq!(
        b.unwrap()["metadata"]["flags"]["orchard"][0]["name"],
        "--quiet"
    );
    assert_eq!(help.help_probes(), 1);
    assert!(
        engine
            .invoke(
                request("discover", json!(["orchard", catalog, env])),
                &host,
                &second
            )
            .await
            .is_ok()
    );
    help.dispose();
}
