use libertty_server::{catalog::CatalogHost, directories::Directories, probes::ProbePool};
use std::{
    collections::BTreeMap,
    os::unix::fs::{PermissionsExt, symlink},
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn batched_stats_preserve_order_symlink_targets_missing_paths_and_cancellation() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("data"), "").unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    symlink("folder", root.path().join("linked")).unwrap();
    let files = ["data", "absent", "folder", "linked"]
        .into_iter()
        .map(|name| (root.path().join(name).to_string_lossy().into_owned(), true))
        .collect::<Vec<_>>();
    let host = Directories::default();
    let cancel = CancellationToken::new();
    let batch = host.stat_many(files.clone(), &cancel).await.unwrap();
    for ((file, executable), actual) in files.iter().zip(&batch) {
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(host.stat(file, *executable, &cancel).await.unwrap()).unwrap()
        );
    }
    assert!(batch[0].as_ref().unwrap().file);
    assert!(batch[1].is_none());
    assert!(batch[3].as_ref().unwrap().directory);
    cancel.cancel();
    assert!(host.stat_many(files, &cancel).await.is_err());
}

#[tokio::test]
async fn spelling_indexes_preserve_exact_and_unicode_matches_and_refresh_after_rename() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("Café")).unwrap();
    let directories = Directories::default();
    let cancel = CancellationToken::new();
    for _ in 0..3 {
        assert_eq!(
            directories
                .path_spelling(root.path().join("CAFE\u{301}").to_str().unwrap(), &cancel)
                .await
                .unwrap(),
            Some(root.path().join("Café").to_string_lossy().into_owned())
        );
        assert_eq!(
            directories
                .path_spelling(root.path().join("Café").to_str().unwrap(), &cancel)
                .await
                .unwrap(),
            Some(root.path().join("Café").to_string_lossy().into_owned())
        );
    }
    std::fs::rename(root.path().join("Café"), root.path().join("Cafe")).unwrap();
    assert!(
        directories
            .path_spelling(root.path().join("CAFÉ").to_str().unwrap(), &cancel)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        directories
            .path_spelling(root.path().join("CAFE").to_str().unwrap(), &cancel)
            .await
            .unwrap(),
        Some(root.path().join("Cafe").to_string_lossy().into_owned())
    );
    cancel.cancel();
    assert!(
        directories
            .path_spelling(root.path().to_str().unwrap(), &cancel)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn corrected_spelling_preserves_symlink_parents_and_nested_case() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("Actual/Nested")).unwrap();
    std::fs::write(root.path().join("Actual/Nested/My Notes.txt"), "").unwrap();
    symlink("Actual", root.path().join("Alias")).unwrap();
    let directories = Directories::default();
    let cancel = CancellationToken::new();
    assert_eq!(
        directories
            .path_spelling(
                root.path()
                    .join("alias/nESTED/my NOTES.txt")
                    .to_str()
                    .unwrap(),
                &cancel
            )
            .await
            .unwrap(),
        Some(
            root.path()
                .join("Alias/Nested/My Notes.txt")
                .to_string_lossy()
                .into_owned()
        )
    );
}

#[tokio::test]
async fn batched_path_scans_preserve_executable_symlinks_deduplication_and_cancellation() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("tool"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(
        root.path().join("tool"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    std::fs::write(root.path().join("data"), "").unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    symlink("tool", root.path().join("linked")).unwrap();
    symlink("absent", root.path().join("broken")).unwrap();
    let cwd = root.path().to_str().unwrap();
    let env = BTreeMap::from([("PATH".into(), format!("{cwd}:{cwd}:/absent"))]);
    let catalog = CatalogHost::new(Directories::default(), ProbePool::default());
    let cancel = CancellationToken::new();
    let names = catalog.executable_names(&env, &cancel).await.unwrap();
    assert_eq!(names.iter().filter(|name| *name == "tool").count(), 1);
    assert!(names.iter().any(|name| name == "linked"));
    assert!(
        !names
            .iter()
            .any(|name| ["data", "folder", "broken"].contains(&name.as_str()))
    );
    cancel.cancel();
    assert!(catalog.executable_names(&env, &cancel).await.is_err());
}
