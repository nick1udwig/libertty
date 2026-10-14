use super::*;

pub(super) async fn api_herdr_connect(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let input = body(&mut req, 16384).await?;
    let sid = session_id(input.get("source"))?;
    let source = app
        .sessions
        .lock()
        .await
        .get(&format!("{owner}/{sid}"))
        .map(|t| t.session.clone())
        .filter(|s| s.files_only)
        .ok_or_else(|| fail("Open a dedicated connection before connecting Herdr."))?;
    let session_name = herdr::session(input.get("session")).map_err(fail)?;
    let target = herdr::Target::from_source(&source, &session_name)
        .await
        .map_err(fail)?;
    target.ensure(&source.state().cwd).await.map_err(fail)?;
    if !app
        .sessions
        .lock()
        .await
        .get(&format!("{owner}/{sid}"))
        .is_some_and(|t| Arc::ptr_eq(&t.session, &source))
    {
        return Err(fail("This connection has closed."));
    }
    app.herdr_targets
        .lock()
        .unwrap()
        .insert(format!("{owner}/{sid}/{}", target.session), target);
    ok(json!({"herdrSession":session_name,"herdrSource":sid}))
}

pub(super) async fn api_herdr_captured(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let query = &ctx.query;
    let sid = session_id(query.get("session").map(|s| json!(s)).as_ref())?;
    let source = app
        .sessions
        .lock()
        .await
        .get(&format!("{owner}/{sid}"))
        .map(|t| t.session.clone())
        .ok_or_else(|| fail("The source terminal has ended."))?;
    let input = body(&mut req, 16384).await?;
    let id = text(&input, "id");
    if input["action"] == "ack" {
        source.acknowledge_capture(id);
        return ok(json!({"ok":true}));
    }
    let _flight = source.capture_flight.lock().await;
    if let Some(result) = source.capture_result(id) {
        return ok(result);
    }
    let capture = source
        .captured()
        .filter(|c| c["kind"] == "herdr" && c["id"] == id)
        .ok_or_else(|| fail("This Herdr request is no longer active."))?;
    if input["action"] == "cancel" || input["action"] == "native" {
        source
            .release_capture(id, input["action"] == "native", None)
            .map_err(fail)?;
        return ok(json!({"native":true}));
    }
    let env = source.environment().await;
    let (binary, session) =
        herdr::parse_command(capture["command"].as_str().unwrap_or(""), &env).map_err(fail)?;
    let socket_path = herdr::socket(&session, &env).map_err(fail)?;
    let target = herdr::Target {
        remote: source.remote.clone(),
        session: session.clone(),
        binary,
        socket_path: Some(socket_path.clone()),
        env,
        repairs: Default::default(),
    };
    target.ensure(&source.state().cwd).await.map_err(fail)?;
    if !app
        .sessions
        .lock()
        .await
        .get(&format!("{owner}/{sid}"))
        .is_some_and(|t| Arc::ptr_eq(&t.session, &source))
    {
        return Err(fail("This connection has closed."));
    }
    let local = source.remote.is_none()
        && socket_path == herdr::socket(&session, &std::env::vars().collect()).map_err(fail)?;
    let result = json!({"herdrSession":session,"herdrSource":if local{""}else{&sid},"name":if target.session.is_empty(){"Herdr".into()}else{format!("Herdr · {}",target.session)},"remote":source.remote.is_some()});
    app.herdr_targets
        .lock()
        .unwrap()
        .insert(format!("{owner}/{sid}/{}", target.session), target.clone());
    if local {
        app.herdr_targets
            .lock()
            .unwrap()
            .insert(format!("{owner}//{}", target.session), target);
    }
    source
        .release_capture(id, false, Some(result.clone()))
        .map_err(fail)?;
    ok(result)
}

pub(super) async fn api_herdr_notifications(
    app: &Arc<App>,
    ctx: RequestContext<3>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let target = ctx.target.unwrap();
    let source = ctx.source.as_str();
    let input = body(&mut req, 16384).await?;
    app.notifications
        .add_view(owner, &input["device"], &input["tabId"], source, &target)
        .map_err(fail)?;
    ok(json!({"ok":true}))
}

pub(super) async fn api_herdr_snapshot(
    _app: &Arc<App>,
    ctx: RequestContext<3>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let target = ctx.target.unwrap();
    return ok(target.snapshot().await.map_err(fail)?);
}

pub(super) async fn api_herdr_images_upload(
    _app: &Arc<App>,
    ctx: RequestContext<3>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = &ctx.query;
    let target = ctx.target.unwrap();
    let terminal = query.get("terminalId").map(String::as_str).unwrap_or("");
    if !target.snapshot().await.map_err(fail)?["terminals"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["terminalId"] == terminal))
    {
        return Err(fail("This terminal has ended."));
    }
    let fs = crate::filesystem::FileSystem {
        remote: target.remote.clone(),
    };
    let payload = std::mem::take(req.body_mut());
    return ok(files::upload_image_on(
        &fs,
        query.get("name").map(String::as_str).unwrap_or(""),
        payload,
    )
    .await
    .map_err(file_failure)?);
}

pub(super) async fn api_herdr_options(
    _app: &Arc<App>,
    ctx: RequestContext<3>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let target = ctx.target.unwrap();
    return ok(target.options().await.map_err(fail)?);
}

pub(super) async fn api_herdr_suggest(
    app: &Arc<App>,
    ctx: RequestContext<3>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = &ctx.query;
    let target = ctx.target.unwrap();
    let input: crate::protocol::SuggestRequest = typed_body(&mut req, 16384).await?;
    let text = input.text.as_str();
    let terminal = query.get("terminalId").map(String::as_str).unwrap_or("");
    return ok(bounded(async |cancel| {
        target
            .suggest(terminal, text, app.services.clone(), cancel)
            .await
    })
    .await?);
}

pub(super) async fn api_herdr_action(
    _app: &Arc<App>,
    ctx: RequestContext<3>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let target = ctx.target.unwrap();
    return ok(target
        .action(&body(&mut req, 65536).await?)
        .await
        .map_err(fail)?);
}

pub(super) async fn api_herdr_ticket(
    app: &Arc<App>,
    ctx: RequestContext<3>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let query = &ctx.query;
    let session_name = ctx.session_name;
    let target = ctx.target.unwrap();
    let source = ctx.source.as_str();
    let terminal = query.get("terminalId").cloned().unwrap_or_default();
    // Existing ticket callers may omit a JSON body entirely.
    let input = if req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        body(&mut req, 2048).await?
    } else {
        json!({})
    };
    let size = if input["mobile"] == true && !terminal.is_empty() {
        let dimension = |key: &str| {
            input[key]
                .as_u64()
                .filter(|n| (1..=1000).contains(n))
                .map(|n| n as u16)
        };
        Some(herdr_terminal_stream::Size {
            cols: dimension("cols").ok_or_else(|| fail("Invalid terminal size."))?,
            rows: dimension("rows").ok_or_else(|| fail("Invalid terminal size."))?,
        })
    } else {
        None
    };
    if !terminal.is_empty()
        && !target.snapshot().await.map_err(fail)?["terminals"]
            .as_array()
            .is_some_and(|a| a.iter().any(|a| a["terminalId"] == terminal))
    {
        return Err(fail("This agent has ended."));
    }
    let mut tickets = app.herdr_tickets.lock().unwrap();
    tickets.retain(|_, t| t.until >= Instant::now());
    if tickets.len() >= 256 || app.herdr_capacity.available_permits() == 0 {
        return Err(fail("Too many pending Herdr connections."));
    }
    let ticket = storage::random_hex(32);
    tickets.insert(
        ticket.clone(),
        HerdrTicket {
            size,
            owner: owner.into(),
            session: session_name,
            source: source.into(),
            terminal,
            target,
            until: Instant::now() + Duration::from_secs(15),
        },
    );
    ok(
        json!({"ticket":ticket,"initialGeometry":true,"parkViews":true,"redrawBarrier":true,"wire":[wire::BINARY,wire::GZIP_FAST,wire::GZIP]}),
    )
}
