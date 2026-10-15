use super::*;

pub(super) async fn api_files_download_download(
    app: &Arc<App>,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = parse_query(req.uri())?;
    return app
        .send_download(query.get("ticket").map(String::as_str).unwrap_or(""))
        .await;
}

pub(super) async fn api_plugins_read(
    _app: &Arc<App>,
    ctx: FileContext,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session;
    let cwd = session.state().cwd;
    let home = session.home();
    let path = query.get("path").ok_or_else(|| fail("Select a file."))?;
    let known = req
        .headers()
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_start_matches("W/").trim_matches('"'));
    let mut cache = session.plugin_files.lock().await;
    let snapshot = cache
        .read(
            &session.filesystem(),
            &cwd,
            &home,
            path,
            known,
            &CancellationToken::new(),
        )
        .await
        .map_err(file_failure)?;
    let mut response = if known == Some(snapshot.etag.as_str()) {
        Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header("cache-control", "no-store")
            .body(Body::empty())
            .unwrap()
    } else {
        let delta = if query.get("delta").is_some_and(|value| value == "1") {
            known.and_then(|known| cache.delta(known, &snapshot))
        } else {
            None
        };
        json_response(
            StatusCode::OK,
            delta.unwrap_or_else(|| snapshot.value.as_ref().clone()),
        )
    };
    response.headers_mut().insert(
        "etag",
        HeaderValue::from_str(&format!("\"{}\"", snapshot.etag)).unwrap(),
    );
    Ok(response)
}

pub(super) async fn api_files_list(
    _app: &Arc<App>,
    ctx: FileContext,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session;
    let cwd = session.state().cwd;
    let home = session.home();
    return ok(serde_json::to_value(
        files::list_files_on(
            &session.filesystem(),
            &cwd,
            &home,
            query
                .get("path")
                .filter(|s| !s.is_empty())
                .map(String::as_str)
                .unwrap_or("."),
        )
        .await
        .map_err(file_failure)?,
    )
    .unwrap());
}

pub(super) async fn api_files_mkdir(
    _app: &Arc<App>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session = ctx.session;
    let cwd = session.state().cwd;
    let home = session.home();
    let input: crate::protocol::requests::Folder = typed_body(&mut req, 16384).await?;
    return ok(files::make_directory_on(
        &session.filesystem(),
        &cwd,
        &home,
        &input.path,
        &input.name,
    )
    .await
    .map_err(file_failure)?);
}

pub(super) async fn api_files_action(
    _app: &Arc<App>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session = ctx.session;
    let cwd = session.state().cwd;
    let home = session.home();
    let input: crate::protocol::requests::FileAction = typed_body(&mut req, 256 * 1024).await?;
    return ok(files::action_on(&session.filesystem(), &cwd, &home, input)
        .await
        .map_err(file_failure)?);
}

pub(super) async fn api_images_upload(
    _app: &Arc<App>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session;
    let payload = std::mem::take(req.body_mut());
    return ok(files::upload_image_on(
        &session.filesystem(),
        query.get("name").map(String::as_str).unwrap_or(""),
        payload,
    )
    .await
    .map_err(file_failure)?);
}

pub(super) async fn api_files_upload(
    _app: &Arc<App>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session;
    let cwd = session.state().cwd;
    let home = session.home();
    let length = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let payload = std::mem::take(req.body_mut());
    return ok(files::upload_on(
        &session.filesystem(),
        &cwd,
        &home,
        query
            .get("path")
            .filter(|s| !s.is_empty())
            .map(String::as_str)
            .unwrap_or("."),
        query.get("name").map(String::as_str).unwrap_or(""),
        payload,
        length.as_deref(),
    )
    .await
    .map_err(file_failure)?);
}

pub(super) async fn api_files_download(
    app: &Arc<App>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sid = ctx.sid;
    let session = ctx.session;
    let input: crate::protocol::requests::Path = typed_body(&mut req, 16384).await?;
    return ok(app
        .download_ticket(&owner, &sid, &session, &input.path, None, None)
        .await?);
}

pub(super) async fn api_files_transfer(
    app: &Arc<App>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sid = ctx.sid;
    let session = ctx.session;
    let input: crate::protocol::requests::Transfer = typed_body(&mut req, 16384).await?;
    let transfer = session.transfer(&input.id).ok_or((
        StatusCode::NOT_FOUND,
        "This transfer request expired. Run the command again.".into(),
    ))?;
    if input.action == crate::protocol::requests::TransferAction::Ack {
        session.acknowledge_transfer(&transfer.id);
        return ok(json!({"ok":true}));
    }
    if input.action != crate::protocol::requests::TransferAction::Download
        || transfer.action != "download"
    {
        return Err(fail("Invalid transfer action."));
    }
    let ticket = app
        .download_ticket(
            &owner,
            &sid,
            &session,
            &transfer.path,
            Some(&transfer.name),
            Some(transfer.id.clone()),
        )
        .await?;
    session.acknowledge_transfer(&transfer.id);
    ok(ticket)
}
