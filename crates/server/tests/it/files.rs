use axum::body::Body;
use libertty_server::{files, markers::Event, reading, transfers::Transfers};
use serde_json::json;
use std::os::unix::fs::{PermissionsExt, symlink};

#[tokio::test]
async fn exclusive_renames_preserve_existing_files_directories_and_links() {
    let root = tempfile::tempdir().unwrap();
    let fs = libertty_server::filesystem::FileSystem::default();
    let source = root.path().join("source");
    std::fs::write(&source, "source").unwrap();
    std::fs::write(root.path().join("file"), "keep").unwrap();
    std::fs::create_dir(root.path().join("directory")).unwrap();
    symlink("missing", root.path().join("link")).unwrap();
    for name in ["file", "directory", "link"] {
        assert_eq!(
            fs.rename(
                source.to_str().unwrap(),
                root.path().join(name).to_str().unwrap(),
                false
            )
            .await
            .unwrap_err()
            .status,
            409
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
    }
    assert_eq!(std::fs::read(root.path().join("file")).unwrap(), b"keep");
    assert!(root.path().join("directory").is_dir());
    assert_eq!(
        std::fs::read_link(root.path().join("link")).unwrap(),
        std::path::Path::new("missing")
    );
    fs.rename(
        source.to_str().unwrap(),
        root.path().join("file").to_str().unwrap(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(root.path().join("file")).unwrap(), b"source");
}

#[tokio::test]
async fn concurrent_exclusive_renames_have_one_winner() {
    let root = tempfile::tempdir().unwrap();
    let fs = libertty_server::filesystem::FileSystem::default();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let destination = root.path().join("destination");
    std::fs::write(&first, "first").unwrap();
    std::fs::write(&second, "second").unwrap();
    let (a, b) = tokio::join!(
        fs.rename(
            first.to_str().unwrap(),
            destination.to_str().unwrap(),
            false
        ),
        fs.rename(
            second.to_str().unwrap(),
            destination.to_str().unwrap(),
            false
        )
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(a.err().or(b.err()).unwrap().status, 409);
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        if first.exists() {
            b"second".as_slice()
        } else {
            b"first".as_slice()
        }
    );
    assert_ne!(first.exists(), second.exists());
}

#[tokio::test]
async fn images_get_unique_private_paths_and_enforce_type_and_size_limits() {
    let fs = libertty_server::filesystem::FileSystem::default();
    let bytes = b"\x89PNG\r\n\x1a\nfixture";
    let mut paths = vec![];
    for _ in 0..2 {
        let result = files::upload_image_on(&fs, "screen shot.PNG", Body::from(bytes.as_slice()))
            .await
            .unwrap();
        let path = result["path"].as_str().unwrap().to_owned();
        assert!(path.starts_with("/tmp/libertty-image-") && path.ends_with(".png"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        paths.push(path);
    }
    assert_ne!(paths[0], paths[1]);
    for path in paths {
        std::fs::remove_file(path).unwrap();
    }
    for name in ["../escape.png", "photo.txt", "photo"] {
        assert_eq!(
            files::upload_image_on(&fs, name, Body::from("x"))
                .await
                .unwrap_err()
                .status,
            400
        );
    }
    assert_eq!(
        files::upload_image_on(&fs, "empty.png", Body::empty())
            .await
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        files::upload_image_on(&fs, "large.png", Body::from(vec![0; files::MAX_IMAGE + 1]))
            .await
            .unwrap_err()
            .status,
        413
    );
}

#[tokio::test]
async fn uploads_are_exclusive_accept_empty_files_and_remove_cancelled_writes() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::write(root.path().join("original"), "keep").unwrap();
    symlink("original", root.path().join("link")).unwrap();
    for name in ["original", "link"] {
        assert_eq!(
            files::upload(cwd, cwd, ".", name, Body::from("replace"), None)
                .await
                .unwrap_err()
                .status,
            409
        );
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("original")).unwrap(),
        "keep"
    );
    assert_eq!(
        files::upload(cwd, cwd, ".", "empty", Body::empty(), None)
            .await
            .unwrap(),
        json!({"name":"empty","bytes":0})
    );
    assert_eq!(
        files::upload(cwd, cwd, ".", "too-big", Body::empty(), Some("1073741825"))
            .await
            .unwrap_err()
            .status,
        413
    );
    assert!(!root.path().join("too-big").exists());
    let stream = futures::stream::once(async { Ok::<_, std::io::Error>(vec![b'x'; 256 * 1024]) })
        .chain(futures::stream::pending());
    let cwd = cwd.to_owned();
    let task = tokio::spawn(async move {
        files::upload(&cwd, &cwd, ".", "partial", Body::from_stream(stream), None).await
    });
    for _ in 0..200 {
        if std::fs::metadata(root.path().join("partial")).is_ok_and(|m| m.len() > 0) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        std::fs::metadata(root.path().join("partial"))
            .unwrap()
            .len()
            > 0
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!root.path().join("partial").exists());
}
use futures::StreamExt;
#[tokio::test]
async fn edits_reject_stale_binary_symlink_and_oversized_inputs_and_preserve_modes() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    let file = root.path().join("note");
    std::fs::write(&file, "hello 🌱").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    let original = files::action(cwd, cwd, &json!({"action":"read","path":"note"}))
        .await
        .unwrap();
    assert_eq!(original["text"], "hello 🌱");
    assert_eq!(original["mode"].as_u64().unwrap() & 0o777, 0o640);
    assert_eq!(
        files::action(
            cwd,
            cwd,
            &json!({"action":"write","path":"note","text":"update","version":"stale"})
        )
        .await
        .unwrap_err()
        .status,
        409
    );
    files::action(
        cwd,
        cwd,
        &json!({"action":"write","path":"note","text":"update","version":original["version"]}),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "update");
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode & 0o600, 0o600);
    assert_eq!(mode & !0o640, 0, "Saving must not add permissions");
    for (name, bytes, message) in [
        ("binary", vec![0, 1], "Binary files"),
        ("invalid", vec![255], "UTF-8"),
        ("large", vec![b'a'; 32769], "32 KB"),
    ] {
        std::fs::write(root.path().join(name), bytes).unwrap();
        assert!(
            files::action(cwd, cwd, &json!({"action":"read","path":name}))
                .await
                .unwrap_err()
                .message
                .contains(message)
        );
    }
    symlink("note", root.path().join("link")).unwrap();
    assert!(
        files::action(cwd, cwd, &json!({"action":"read","path":"link"}))
            .await
            .is_err()
    );
    assert!(std::fs::read_dir(root.path()).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".libertty-edit-")
    }));
}
#[tokio::test]
async fn copy_and_delete_bound_recursion_do_not_follow_links_or_overwrite_targets() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    std::fs::create_dir(root.path().join("destination")).unwrap();
    std::fs::write(root.path().join("outside"), "keep").unwrap();
    std::fs::write(root.path().join("folder/file"), "copy").unwrap();
    symlink("../outside", root.path().join("folder/link")).unwrap();
    assert!(
        files::action(
            cwd,
            cwd,
            &json!({"action":"copy","paths":["folder"],"destination":"folder"})
        )
        .await
        .unwrap_err()
        .message
        .contains("outside")
    );
    files::action(
        cwd,
        cwd,
        &json!({"action":"copy","paths":["folder","folder"],"destination":"destination"}),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("destination/folder/file")).unwrap(),
        "copy"
    );
    assert_eq!(
        std::fs::read_link(root.path().join("destination/folder/link")).unwrap(),
        std::path::Path::new("../outside")
    );
    assert_eq!(
        files::action(
            cwd,
            cwd,
            &json!({"action":"copy","paths":["folder"],"destination":"destination"})
        )
        .await
        .unwrap_err()
        .status,
        409
    );
    files::action(cwd, cwd, &json!({"action":"delete","paths":["folder"]}))
        .await
        .unwrap();
    assert!(!root.path().join("folder").exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("outside")).unwrap(),
        "keep"
    );
    assert!(
        files::action(cwd, cwd, &json!({"action":"delete","paths":["/"]}))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn listings_preserve_hidden_names_links_numeric_collation_and_parent_paths() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    for name in ["file10", "file2", ".hidden"] {
        std::fs::write(root.path().join(name), "x").unwrap();
    }
    symlink("folder", root.path().join("folder-link")).unwrap();
    let listing = files::list_files(cwd, cwd, ".").await.unwrap();
    assert!(!listing.truncated);
    assert_eq!(listing.path, cwd);
    assert_eq!(
        listing
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["folder", "folder-link", ".hidden", "file2", "file10"]
    );
    assert!(listing.entries[1].symlink && listing.entries[1].directory);
    assert_eq!(
        files::file_path(cwd, cwd, "~/../x").unwrap(),
        root.path().parent().unwrap().join("x").to_string_lossy()
    );
    for name in ["", "..", "a/b", "a\\b", "bad\n"] {
        assert!(!files::valid_name(name));
    }
}
#[tokio::test]
async fn listings_bound_entries_and_keep_dangling_links() {
    let root = tempfile::tempdir().unwrap();
    let fs = libertty_server::filesystem::FileSystem::default();
    let directory = root.path().to_str().unwrap();
    symlink("missing", root.path().join("dangling")).unwrap();
    let (entries, truncated) = fs.read_entries(directory).await.unwrap();
    assert!(!truncated);
    assert_eq!(entries.len(), 1);
    assert!(entries[0].symlink);
    assert!(!entries[0].directory);
    for index in 1..10000 {
        std::fs::write(root.path().join(index.to_string()), "").unwrap();
    }
    let (entries, truncated) = fs.read_entries(directory).await.unwrap();
    assert_eq!(entries.len(), 10000);
    assert!(!truncated);
    std::fs::write(root.path().join("extra"), "").unwrap();
    let (entries, truncated) = fs.read_entries(directory).await.unwrap();
    assert_eq!(entries.len(), 10000);
    assert!(truncated);
}
#[test]
fn reading_snapshots_preserve_binary_strip_terminal_codes_and_bound_retention() {
    assert_eq!(reading::mime("page.html", b"<script>"), "text/plain");
    assert_eq!(reading::mime("photo.PNG", b"image"), "image/png");
    assert_eq!(
        reading::mime("unknown", &[0, 1]),
        "application/octet-stream"
    );
    let mut captures = reading::Captures::default();
    let first = captures
        .add("git diff", b"\x1b[31m+hello\x1b[0m\n".to_vec(), 7)
        .unwrap();
    assert_eq!(captures.pending(), vec![first.clone()]);
    let capture = captures.get(&first.id).unwrap();
    assert_eq!(capture.data, b"+hello\n");
    assert_eq!(capture.exit_code, 7);
    assert!(captures.pending().is_empty());
    let png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 255];
    let picture = captures.add("Command output", png.clone(), 0).unwrap();
    let capture = captures.get(&picture.id).unwrap();
    assert_eq!(capture.mime, "image/png");
    assert_eq!(capture.data, png);
    for _ in 0..16 {
        captures.add("output", b"text".to_vec(), 0).unwrap();
    }
    assert!(captures.get(&first.id).is_none());
    assert_eq!(captures.pending().len(), 16);
    assert!(
        captures
            .add("too big", vec![0; reading::MAX_READING_BYTES + 1], 0)
            .is_err()
    );
    captures.clear();
    assert!(captures.pending().is_empty());
}
#[tokio::test]
async fn reading_files_validate_paths_utf8_and_size_without_importing_or_executing() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    std::fs::write(
        root.path().join("hello.py"),
        "raise RuntimeError('never execute')",
    )
    .unwrap();
    assert_eq!(
        reading::read(cwd, cwd, "hello.py").await.unwrap().mime,
        "text/plain"
    );
    assert_eq!(
        reading::read(cwd, cwd, "missing")
            .await
            .err()
            .unwrap()
            .status,
        404
    );
    assert_eq!(
        reading::read(cwd, cwd, ".").await.err().unwrap().status,
        400
    );
    assert!(reading::read(cwd, cwd, "bad\n").await.is_err());
    let file = std::fs::File::create(root.path().join("large")).unwrap();
    file.set_len(reading::MAX_READING_BYTES as u64 + 1).unwrap();
    assert_eq!(
        reading::read(cwd, cwd, "large").await.err().unwrap().status,
        413
    );
}
#[test]
fn transfers_replay_until_acknowledged_and_clean_captured_files_on_eviction_and_drop() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_str().unwrap();
    let captured = root.path().join("download.ABCDEFGH");
    std::fs::write(&captured, "data").unwrap();
    let mut transfers = Transfers::default();
    let request = transfers.add(
        Event::TransferCapture {
            file: "download.ABCDEFGH".into(),
            name: "out.txt".into(),
        },
        cwd,
    );
    assert_eq!(transfers.pending().len(), 1);
    transfers.acknowledge(&request.id);
    assert!(transfers.pending().is_empty());
    assert!(transfers.get(&request.id).is_some());
    transfers.clear();
    assert!(!captured.exists());
    for n in 0..17 {
        transfers.add(
            Event::TransferUpload {
                path: format!("{cwd}/{n}"),
            },
            cwd,
        );
    }
    assert_eq!(transfers.pending().len(), 16);
}
