use std::{
    collections::BTreeMap,
    os::unix::fs::{PermissionsExt, symlink},
};
use termai_server::{catalog::CatalogHost, directories::Directories, probes::ProbePool};
use tokio_util::sync::CancellationToken;

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
