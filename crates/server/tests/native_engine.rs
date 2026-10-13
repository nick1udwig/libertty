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
async fn shared_paths_and_option_schemas_preserve_types_choices_and_arity() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::create_dir(root.path().join("docs")).unwrap();
    std::fs::write(root.path().join("docs/My Notes.txt"), "notes").unwrap();
    std::fs::write(root.path().join("tool.py"), "import argparse\nfrom pathlib import Path\np=argparse.ArgumentParser()\np.add_argument('--config', type=Path)\np.add_argument('--mode', choices=['east-zone','west-zone'])\np.add_argument('--pair', nargs=2)\np.add_argument('--tag', nargs='+')\np.add_argument('--force', action='store_true')\nsubs=p.add_subparsers()\nchild=subs.add_parser('child')\nchild.add_argument('--child-only')\n").unwrap();
    let services = HostServices::new();
    let host = NativeHost::new(
        services.clone(),
        catalog(cwd, &["cat", "less", "head", "ls", "python3"]),
        BTreeMap::from([
            ("HOME".into(), cwd.into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
        HelpProvider::new(services.pool.clone()),
    );
    let engine = NativeEngine::new().unwrap();
    for (input, expected) in [
        ("cat docs slash My Notes dot txt", "cat 'docs/My Notes.txt'"),
        (
            "cat -n docs slash My Notes dot txt",
            "cat -n 'docs/My Notes.txt'",
        ),
        (
            "less docs slash My Notes dot txt",
            "less 'docs/My Notes.txt'",
        ),
        (
            "head -n 1 docs slash My Notes dot txt",
            "head -n 1 'docs/My Notes.txt'",
        ),
        (
            "python3 tool.py config docs slash My Notes dot txt force",
            "python3 tool.py --config 'docs/My Notes.txt' --force",
        ),
        (
            "python3 tool.py config dcos slash My Notes dot txt force",
            "python3 tool.py --config 'docs/My Notes.txt' --force",
        ),
        (
            "python3 tool.py mode east zone force",
            "python3 tool.py --mode east-zone --force",
        ),
        (
            "python3 tool.py pair one two force",
            "python3 tool.py --pair one two --force",
        ),
        (
            "python3 tool.py --tag one two --force",
            "python3 tool.py --tag one two --force",
        ),
    ] {
        let result = engine
            .suggest(input, &host, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["command"] == expected && c["literal"] != true),
            "{input}: {result}"
        );
    }
    for input in [
        "python3 tool.py --pair one --force",
        "python3 tool.py --mode nowhere",
        "python3 tool.py --child-only value",
    ] {
        let result = engine
            .suggest(input, &host, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["literal"] == true),
            "{input}: {result}"
        );
    }
    let help = engine
        .invoke(
            request(
                "flagsFromHelp",
                json!(["  --output filename  Output file\n  --count number  Count\n"]),
            ),
            &host,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(help[0]["takesValue"], true);
    assert_eq!(help[0]["value"]["kind"], "outputPath");
    assert_eq!(help[1]["takesValue"], true);
}

#[tokio::test]
async fn compound_commands_repair_each_node_and_preserve_shell_expressions() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    std::fs::write(root.path().join("folder/My Notes.txt"), "notes").unwrap();
    executable(
        &root.path().join("orchard"),
        "#!/bin/sh\ncase \"$*\" in\n'--help') printf 'Commands:\\n  workspace    Workspaces\\n';;\n'workspace --help') printf 'Commands:\\n  reconcile    Reconcile\\n';;\n'workspace reconcile --help') printf '  --target NAME  Destination\\n';;\nesac\n",
    );
    let services = HostServices::new();
    let host = NativeHost::new(
        services.clone(),
        catalog(cwd, &["git", "cat", "cd", "echo", "orchard", "sudo", "env"]),
        BTreeMap::from([
            ("HOME".into(), cwd.into()),
            ("PATH".into(), format!("{cwd}:/usr/bin:/bin")),
        ]),
        HelpProvider::new(services.pool.clone()),
    );
    let engine = NativeEngine::new().unwrap();
    for (input, expected) in [
        ("Get status pipe cat", "git status | cat"),
        ("Get status pype cat", "git status | cat"),
        ("Get status; echo done", "git status; echo done"),
        ("Get status && echo done", "git status && echo done"),
        ("Get status || echo done", "git status || echo done"),
        (
            "Get status semicolon echo done semicolon echo end",
            "git status; echo done; echo end",
        ),
        (
            "Orchard work space recon cile target VALUE semicolon echo done",
            "orchard workspace reconcile --target VALUE; echo done",
        ),
        ("sudo Get status", "sudo git status"),
        ("sudo -u tester Get status", "sudo -u tester git status"),
        ("env FOO=bar Get status", "env FOO=bar git status"),
        ("Get commit -m \"$USER\"", "git commit -m \"$USER\""),
        ("gti status", "git status"),
        (
            "cd folder && cat my notes dot txt",
            "cd folder && cat 'My Notes.txt'",
        ),
    ] {
        let result = engine
            .suggest(input, &host, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["command"] == expected && c["literal"] != true),
            "{input}: {result}"
        );
        assert_eq!(result.as_array().unwrap().last().unwrap()["command"], input);
    }
    let candidate = termai_engine::types::Candidate {
        command: "unknown | cat".into(),
        score: 90.0,
        changes: vec![],
        literal: None,
    };
    let result = engine
        .invoke(
            request(
                "suggest",
                json!(["unknown pipe cat", host.catalog, host.environment]),
            ),
            &host,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        !result
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["command"] == candidate.command && c["literal"] != true),
        "{result}"
    );
}

#[tokio::test]
async fn history_and_validation_do_not_discard_live_filename_alternatives() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    for name in ["my-notes", "my_notes", "not.es"] {
        std::fs::write(root.path().join(name), "notes").unwrap();
    }
    let services = HostServices::new();
    let mut catalog = catalog(cwd, &["cat"]);
    catalog.paths = vec!["my-notes".into(), "my_notes".into()].into();
    catalog.history = vec!["cat my-notes".into()].into();
    let mut host = NativeHost::new(
        services.clone(),
        catalog,
        BTreeMap::from([
            ("HOME".into(), cwd.into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
        HelpProvider::new(services.pool.clone()),
    );
    let engine = NativeEngine::new().unwrap();
    let result = engine
        .suggest("cat my notes", &host, &CancellationToken::new())
        .await
        .unwrap();
    for command in ["cat my-notes", "cat my_notes"] {
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["command"] == command && c["literal"] != true),
            "{result}"
        );
    }
    host.catalog.paths = vec![
        "not-es".into(),
        "not_es".into(),
        "not.es".into(),
        "no_tes".into(),
    ]
    .into();
    host.catalog.history.clear();
    let result = engine
        .suggest("cat notes", &host, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result[0]["command"], "cat not.es");
    assert_eq!(result.as_array().unwrap().last().unwrap()["literal"], true);
}

#[tokio::test]
async fn script_options_keep_their_scope_after_interpreter_options_and_multiple_values() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::write(root.path().join("tool.py"), "import argparse\np=argparse.ArgumentParser()\np.add_argument('--output')\np.add_argument('--force', action='store_true')\n").unwrap();
    let mut catalog = catalog(cwd, &["python3"]);
    catalog.paths = vec!["tool.py".into()].into();
    let services = HostServices::new();
    let host = NativeHost::new(
        services.clone(),
        catalog,
        BTreeMap::from([
            ("HOME".into(), cwd.into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
        HelpProvider::new(services.pool.clone()),
    );
    let engine = NativeEngine::new().unwrap();
    for (input, expected) in [
        (
            "python3 tool.py output result force",
            "python3 tool.py --output result --force",
        ),
        (
            "python3 tool.py force output result",
            "python3 tool.py --force --output result",
        ),
        (
            "python3 tool.py --output result --force",
            "python3 tool.py --output result --force",
        ),
        (
            "python3 -u tool.py output result force",
            "python3 -u tool.py --output result --force",
        ),
    ] {
        let result = engine
            .suggest(input, &host, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["command"] == expected && c["literal"] != true),
            "{input}: {result}"
        );
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["command"] == input && c["literal"] == true)
        );
    }
    let flags = host
        .services
        .catalog
        .describe("python3 -m tool.py", cwd, &CancellationToken::new())
        .await
        .unwrap();
    assert!(flags.is_none());
}

#[tokio::test]
async fn spelled_cd_uses_directory_discovery_without_catalog_paths() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::create_dir_all(root.path().join("projects/work-space/deep-folder")).unwrap();
    let catalog = catalog(cwd, &["cd", "pushd", "upload"]);
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let env = BTreeMap::from([
        ("HOME".into(), cwd.into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ]);
    let host = NativeHost::new(services, catalog, env, help);
    let engine = NativeEngine::new().unwrap();
    for (phrase, expected) in [
        (
            "C D projects slash work space slash deep folder".to_owned(),
            "cd projects/work-space/deep-folder".to_owned(),
        ),
        (
            "see dee tilda slash projects slash work space".to_owned(),
            "cd ~/projects/work-space".to_owned(),
        ),
        (
            format!("C D {cwd}/projects/work space/deep folder"),
            format!("cd {cwd}/projects/work-space/deep-folder"),
        ),
    ] {
        let candidates = engine
            .suggest(&phrase, &host, &CancellationToken::new())
            .await
            .unwrap();
        let candidates: Vec<termai_engine::types::Candidate> =
            serde_json::from_value(candidates).unwrap();
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.command == expected && !candidate.is_literal()),
            "{phrase}: {candidates:?}"
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.command == phrase && candidate.is_literal())
        );
    }
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
    std::fs::write(&definitions, "_orchard(){ if [[ ${COMP_WORDS[COMP_CWORD]} == ea ]]; then COMPREPLY=('eager'); else COMPREPLY=('east-zone'); fi; }; complete -F _orchard orchard\n").unwrap();
    let broad = engine
        .suggest("orchard deploy east zone", &host, &cancel)
        .await
        .unwrap();
    assert_eq!(broad[0]["command"], "orchard deploy east-zone", "{broad}");
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

#[tokio::test]
async fn native_executor_keeps_short_requests_responsive_and_reset_cancels_pending_work() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    executable(
        &dir.path().join("orchard"),
        "#!/bin/sh\ntouch started\nsleep 5\nprintf '  --slow  Slow\\n'\n",
    );
    let catalog = catalog(cwd, &["orchard", "cd"]);
    let env = BTreeMap::from([("PATH".into(), format!("{cwd}:/usr/bin:/bin"))]);
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let host = NativeHost::new(services, catalog.clone(), env.clone(), help.clone());
    let engine = NativeEngine::new().unwrap();
    let cancel = CancellationToken::new();
    let slow = engine.invoke(
        request("discover", json!(["orchard", catalog, env])),
        &host,
        &cancel,
    );
    let reset = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !dir.path().join("started").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(
            Duration::from_millis(500),
            engine.invoke(
                request("cachedMetadata", json!([catalog, env])),
                &host,
                &cancel,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        engine.reset().unwrap();
    };
    let (slow, _) = tokio::join!(slow, reset);
    assert_eq!(slow.unwrap_err(), termai_server::probes::ABORTED);
    assert!(
        engine
            .invoke(
                request("cachedMetadata", json!([catalog, env])),
                &host,
                &cancel
            )
            .await
            .is_ok()
    );
    help.dispose();
}

#[tokio::test]
async fn shared_probes_survive_the_engine_that_started_them() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    executable(
        &dir.path().join("orchard"),
        "#!/bin/sh\ntouch started\nsleep .3\nprintf '  --shared  Shared\\n'\n",
    );
    let catalog = catalog(cwd, &["orchard"]);
    let env = BTreeMap::from([("PATH".into(), format!("{cwd}:/usr/bin:/bin"))]);
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let host = NativeHost::new(services, catalog.clone(), env.clone(), help.clone());
    let first = NativeEngine::new().unwrap();
    let second = NativeEngine::new().unwrap();
    let stop = CancellationToken::new();
    let first_stop = stop.clone();
    let first_host = host.clone();
    let first_request = request("discover", json!(["orchard", catalog, env]));
    let running =
        tokio::spawn(async move { first.invoke(first_request, &first_host, &first_stop).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !dir.path().join("started").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let cancel = CancellationToken::new();
    let surviving = second.invoke(
        request("discover", json!(["orchard", catalog, env])),
        &host,
        &cancel,
    );
    let close_first = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        stop.cancel();
        assert!(running.await.unwrap().is_err());
    };
    let (result, _) = tokio::join!(surviving, close_first);
    assert_eq!(
        result.unwrap()["metadata"]["flags"]["orchard"][0]["name"],
        "--shared"
    );
    assert_eq!(help.help_probes(), 1);
    help.dispose();
}

#[tokio::test]
async fn borrowed_command_checks_keep_private_helpers_explicit_and_public_functions_available() {
    let dir = tempfile::tempdir().unwrap();
    let mut catalog = catalog(dir.path().to_str().unwrap(), &["_helper", "visible"]);
    catalog.functions = Some(vec!["_helper".into(), "visible".into()].into());
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let host = NativeHost::new(services, catalog.clone(), BTreeMap::new(), help);
    let engine = NativeEngine::new().unwrap();
    let cancel = CancellationToken::new();
    for (input, command, expected) in [
        ("different", "_helper", false),
        ("_helper", "_helper", true),
        ("'_helper'", "_helper", true),
        ("different", "visible", true),
        ("different", "unknown", false),
    ] {
        let actual = engine.invoke(request("candidateValid", json!([input,{"command":command,"score":100,"changes":[]},catalog,{}, {"flags":{},"subcommands":{}}])), &host, &cancel).await.unwrap();
        assert_eq!(actual, json!(expected));
    }
}
