use serde_json::json;
use termai_server::{filesystem::FileSystem, plugin_file::Cache};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn selected_file_versions_delta_rotation_unicode_and_limits() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_str().unwrap();
    let path = directory.path().join("app.log");
    let fs = FileSystem::default();
    let cancel = CancellationToken::new();
    let mut cache = Cache::default();
    let text = "hello 界😀\n".repeat(100);
    tokio::fs::write(&path, &text).await.unwrap();
    let first = cache
        .read(&fs, root, root, "app.log", None, &cancel)
        .await
        .unwrap();
    let same = cache
        .read(&fs, root, root, "app.log", Some(&first.etag), &cancel)
        .await
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&first.value, &same.value));
    tokio::fs::write(&path, text.clone() + "new 😀\n")
        .await
        .unwrap();
    let second = cache
        .read(&fs, root, root, "app.log", Some(&first.etag), &cancel)
        .await
        .unwrap();
    assert_eq!(
        cache.delta(&first.etag, &second).unwrap()["append"],
        "new 😀\n"
    );
    assert_ne!(first.etag, second.etag);
    tokio::fs::rename(&path, directory.path().join("old.log"))
        .await
        .unwrap();
    tokio::fs::write(&path, "rotated").await.unwrap();
    let rotated = cache
        .read(&fs, root, root, "app.log", Some(&second.etag), &cancel)
        .await
        .unwrap();
    assert_eq!(rotated.value["text"], "rotated");
    assert!(cache.delta(&second.etag, &rotated).is_none());
    tokio::fs::write(&path, "changed").await.unwrap();
    assert_eq!(
        cache
            .read(&fs, root, root, "app.log", None, &cancel)
            .await
            .unwrap()
            .value["text"],
        "changed"
    );
    for bytes in [vec![255], b"bad\0file".to_vec()] {
        tokio::fs::write(&path, bytes).await.unwrap();
        assert_eq!(
            cache
                .read(&fs, root, root, "app.log", None, &cancel)
                .await
                .err()
                .unwrap()
                .status,
            400
        );
    }
    tokio::fs::write(&path, "😀".repeat(150_000)).await.unwrap();
    let tail = cache
        .read(&fs, root, root, "app.log", None, &cancel)
        .await
        .unwrap();
    assert_eq!(tail.value["truncated"], json!(true));
    assert_eq!(
        tail.value["text"].as_str().unwrap().encode_utf16().count(),
        256 * 1024
    );
    cancel.cancel();
    assert!(
        cache
            .read(&fs, root, root, "app.log", None, &cancel)
            .await
            .is_err()
    );
}
