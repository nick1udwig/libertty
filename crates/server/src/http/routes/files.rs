use super::*;

pub(super) async fn api_files_download_download(
    State(app): State<Arc<App>>,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = parse_query(req.uri())?;
    // Only an open-ended byte range resumes; any other range receives the whole file.
    let offset = req
        .headers()
        .get("range")
        .and_then(|value| {
            value
                .to_str()
                .ok()?
                .strip_prefix("bytes=")?
                .strip_suffix('-')?
                .parse()
                .ok()
        })
        .unwrap_or(0);
    return app
        .send_download(
            query.get("ticket").map(String::as_str).unwrap_or(""),
            offset,
        )
        .await;
}

pub(super) async fn api_plugins_read(
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

pub(super) async fn api_files_list(ctx: FileContext) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session;
    let cwd = session.state().cwd;
    let home = session.home();
    return ok(files::list_files_on(
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
    .map_err(file_failure)?);
}

pub(super) async fn api_files_mkdir(
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
    State(app): State<Arc<App>>,
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
    let directory = query
        .get("path")
        .filter(|s| !s.is_empty())
        .map(String::as_str)
        .unwrap_or(".");
    let name = query.get("name").map(String::as_str).unwrap_or("");
    // A numbered upload keeps its partial file, so a retry continues from the bytes that arrived.
    if let Some(id) = query.get("upload") {
        let number = |key: &str| query.get(key).and_then(|value| value.parse::<u64>().ok());
        let (Some(size), Some(offset)) = (number("size"), number("offset")) else {
            return Err(fail("Invalid upload."));
        };
        if !(1..=64).contains(&id.len())
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(fail("Invalid upload."));
        }
        return ok(app
            .uploads
            .receive(
                &format!("{}/{}", ctx.owner, ctx.sid),
                id,
                &session.filesystem(),
                crate::uploads::Destination {
                    cwd: &cwd,
                    home: &home,
                    directory,
                    name,
                    size,
                },
                offset,
                payload,
            )
            .await
            .map_err(file_failure)?);
    }
    return ok(files::upload_on(
        &session.filesystem(),
        &cwd,
        &home,
        directory,
        name,
        payload,
        length.as_deref(),
    )
    .await
    .map_err(file_failure)?);
}

pub(super) async fn api_files_download(
    State(app): State<Arc<App>>,
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
    State(app): State<Arc<App>>,
    ctx: FileContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sid = ctx.sid;
    let session = ctx.session;
    let input: crate::protocol::requests::Transfer = typed_body(&mut req, 16384).await?;
    let transfer = session.transfer(&input.id).ok_or(Failure(
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
