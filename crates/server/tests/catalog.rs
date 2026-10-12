use termai_server::{catalog::CatalogHost, directories::Directories, probes::ProbePool};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn prepared_paths_share_storage_and_refresh_after_nested_and_root_changes() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::create_dir(root.path().join("child")).unwrap();
    std::fs::write(root.path().join("child/one"), "").unwrap();
    let catalog = CatalogHost::new(Directories::default(), ProbePool::default());
    let cancel = CancellationToken::new();
    let first = catalog.paths_in(cwd, &cancel).await.unwrap();
    assert_eq!(first.as_slice(), ["child/", "child/one"]);
    let second = catalog.paths_in(cwd, &cancel).await.unwrap();
    assert!(first.shares_storage(&second));
    std::fs::write(root.path().join("child/two"), "").unwrap();
    let third = catalog.paths_in(cwd, &cancel).await.unwrap();
    assert_eq!(third.as_slice(), ["child/", "child/one", "child/two"]);
    assert!(!third.shares_storage(&first));
    std::fs::rename(root.path().join("child"), root.path().join("renamed")).unwrap();
    let fourth = catalog.paths_in(cwd, &cancel).await.unwrap();
    assert_eq!(
        fourth.as_slice(),
        ["renamed/", "renamed/one", "renamed/two"]
    );
    assert_eq!(first.as_slice(), ["child/", "child/one"]);
    cancel.cancel();
    assert!(catalog.paths_in(cwd, &cancel).await.is_err());
}
