use axum::{
    body::to_bytes,
    http::{HeaderMap, Method, StatusCode},
};
use libertty_server::assets::{accepted_encodings, serve};
use std::os::unix::fs::PermissionsExt;

#[test]
fn encoding_negotiation_retains_exclusions_preferences_and_identity_fallback() {
    for (header, expected) in [
        (None, vec!["identity"]),
        (Some("gzip, br"), vec!["br", "gzip", "identity"]),
        (
            Some("br;q=0, gzip;q=1, identity;q=0.5"),
            vec!["gzip", "identity"],
        ),
        (Some("*;q=0"), vec![]),
    ] {
        assert_eq!(accepted_encodings(header), expected);
    }
}

#[tokio::test]
async fn static_variants_stream_bytes_and_head_avoids_reading_unreadable_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("assets")).unwrap();
    let file = root.path().join("assets/app.js");
    let content = b"const hello = 'world';".repeat(10000);
    std::fs::write(&file, &content).unwrap();
    std::fs::write(
        root.path().join("assets/app.js.br"),
        b"brotli variant bytes",
    )
    .unwrap();
    std::fs::write(root.path().join("assets/app.js.gz"), b"gzip variant bytes").unwrap();
    std::fs::write(
        root.path().join("index.html"),
        "<base href=\"/\" data-libertty-base><main>Hi</main>",
    )
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("accept-encoding", "gzip, br".parse().unwrap());
    let response = serve(
        root.path(),
        "/mounted/",
        "/assets/app.js",
        &Method::GET,
        &headers,
    )
    .await;
    assert_eq!(response.headers()["content-encoding"], "br");
    assert_eq!(response.headers()["vary"], "Accept-Encoding");
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX).await.unwrap(),
        b"brotli variant bytes".as_slice()
    );
    let response = serve(
        root.path(),
        "/mounted/",
        "/assets/app.js",
        &Method::GET,
        &HeaderMap::new(),
    )
    .await;
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX).await.unwrap(),
        content
    );
    headers.insert("accept-encoding", "*;q=0".parse().unwrap());
    assert_eq!(
        serve(
            root.path(),
            "/mounted/",
            "/assets/app.js",
            &Method::GET,
            &headers
        )
        .await
        .status(),
        StatusCode::NOT_ACCEPTABLE
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o0)).unwrap();
    let head = serve(
        root.path(),
        "/mounted/",
        "/assets/app.js",
        &Method::HEAD,
        &HeaderMap::new(),
    )
    .await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()["content-length"], content.len().to_string());
    assert!(
        to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    let page = serve(
        root.path(),
        "/mounted/",
        "/",
        &Method::GET,
        &HeaderMap::new(),
    )
    .await;
    assert!(
        String::from_utf8(
            to_bytes(page.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec()
        )
        .unwrap()
        .contains("href=\"/mounted/\"")
    );
    assert_eq!(
        serve(
            root.path(),
            "/mounted/",
            "/missing",
            &Method::GET,
            &HeaderMap::new()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        serve(
            root.path(),
            "/mounted/",
            "/../outside",
            &Method::GET,
            &HeaderMap::new()
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
}
