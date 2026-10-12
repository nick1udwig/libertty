use std::{collections::BTreeMap, time::Duration};
use termai_server::{
    completion::{CompletionProvider, shell_complete},
    probes::{ABORTED, ProbePool},
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn reused_workers_preserve_fresh_definitions_files_environment_and_isolation() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    let definitions = root.path().join("completion");
    std::fs::write(&definitions, "_t(){ COMPREPLY=('' \"${LEAK:-clean}\" \"$VALUE\" \"$(cat item)\"); LEAK=dirty; }; complete -F _t tool").unwrap();
    std::fs::write(root.path().join("item"), "first").unwrap();
    let mut env = BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("VALUE".into(), "env-first".into()),
        (
            "TERMAI_COMPLETIONS_FILE".into(),
            definitions.to_string_lossy().into_owned(),
        ),
    ]);
    let words = vec!["tool".into(), "".into()];
    let pool = ProbePool::new(2);
    let provider = CompletionProvider::default();
    let cancel = CancellationToken::new();
    for _ in 0..3 {
        assert_eq!(
            provider
                .complete(&pool, &words, cwd, &env, &cancel)
                .await
                .unwrap(),
            shell_complete(&pool, &words, cwd, &env, &cancel)
                .await
                .unwrap()
        );
    }
    assert_eq!(provider.worker_starts(), 1);
    std::fs::write(root.path().join("item"), "second").unwrap();
    assert_eq!(
        provider
            .complete(&pool, &words, cwd, &env, &cancel)
            .await
            .unwrap(),
        ["clean", "env-first", "second"]
    );
    std::fs::write(
        &definitions,
        "_t(){ COMPREPLY=(changed); }; complete -F _t tool",
    )
    .unwrap();
    assert_eq!(
        provider
            .complete(&pool, &words, cwd, &env, &cancel)
            .await
            .unwrap(),
        ["changed"]
    );
    assert_eq!(provider.worker_starts(), 1);
    env.insert("VALUE".into(), "env-second".into());
    provider
        .complete(&pool, &words, cwd, &env, &cancel)
        .await
        .unwrap();
    assert_eq!(provider.worker_starts(), 2);
}

#[tokio::test]
async fn cancelled_and_oversized_completions_discard_workers_and_recover() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    let definitions = root.path().join("completion");
    std::fs::write(
        &definitions,
        "_t(){ sleep 10; COMPREPLY=(late); }; complete -F _t tool",
    )
    .unwrap();
    let env = BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin".into()),
        (
            "TERMAI_COMPLETIONS_FILE".into(),
            definitions.to_string_lossy().into_owned(),
        ),
    ]);
    let words = vec!["tool".into(), "".into()];
    let provider = CompletionProvider::default();
    let pool = ProbePool::new(1);
    let cancel = CancellationToken::new();
    let stop = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(provider.complete(&pool, &words, cwd, &env, &cancel), stop);
    assert_eq!(result.unwrap_err(), ABORTED);
    assert!(!pool.busy());
    let cancel = CancellationToken::new();
    std::fs::write(
        &definitions,
        "_t(){ printf -v x '%150000s' ''; COMPREPLY=(\"$x\"); }; complete -F _t tool",
    )
    .unwrap();
    assert!(
        provider
            .complete(&pool, &words, cwd, &env, &cancel)
            .await
            .unwrap()
            .is_empty()
    );
    std::fs::write(
        &definitions,
        "_t(){ COMPREPLY=(recovered); }; complete -F _t tool",
    )
    .unwrap();
    assert_eq!(
        provider
            .complete(&pool, &words, cwd, &env, &cancel)
            .await
            .unwrap(),
        ["recovered"]
    );
    assert_eq!(provider.worker_starts(), 3);
}
