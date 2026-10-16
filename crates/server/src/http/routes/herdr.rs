use super::*;

pub(super) async fn api_herdr_connect(
    app: &Arc<App>,
    ctx: OwnerContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let input: crate::protocol::requests::HerdrConnect = typed_body(&mut req, 16384).await?;
    let sid = session_id_text(input.source.as_deref())?;
    let source = app
        .sessions
        .lock()
        .await
        .get(&format!("{owner}/{sid}"))
        .map(|t| t.session.clone())
        .filter(|s| s.files_only)
        .ok_or_else(|| fail("Open a dedicated connection before connecting Herdr."))?;
    let session_name = herdr::session(
        input
            .session
            .as_ref()
            .map(|session| json!(session))
            .as_ref(),
    )
    .map_err(fail)?;
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
    ctx: OwnerContext,
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
    let input: crate::protocol::requests::Capture = typed_body(&mut req, 16384).await?;
    let id = input.id.as_str();
    if input.action == crate::protocol::requests::CaptureAction::Ack {
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
    if input.action == crate::protocol::requests::CaptureAction::Cancel
        || input.action == crate::protocol::requests::CaptureAction::Native
    {
        source
            .release_capture(
                id,
                input.action == crate::protocol::requests::CaptureAction::Native,
                None,
            )
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
        shared: Default::default(),
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
    ctx: HerdrContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let target = ctx.target;
    let source = ctx.source.as_str();
    let input: crate::protocol::requests::Watch = typed_body(&mut req, 16384).await?;
    app.notifications
        .add_view(
            owner,
            &json!(input.device),
            &json!(input.tab_id),
            source,
            &target,
        )
        .map_err(fail)?;
    ok(json!({"ok":true}))
}

pub(super) async fn api_herdr_snapshot(
    _app: &Arc<App>,
    ctx: HerdrContext,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let target = ctx.target;
    return ok(json!(target.snapshot().await.map_err(fail)?));
}

pub(super) async fn api_herdr_images_upload(
    _app: &Arc<App>,
    ctx: HerdrContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = &ctx.query;
    let target = ctx.target;
    let terminal = query.get("terminalId").map(String::as_str).unwrap_or("");
    if target
        .snapshot()
        .await
        .map_err(fail)?
        .terminal(terminal)
        .is_none()
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
    ctx: HerdrContext,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let target = ctx.target;
    return ok(target.options().await.map_err(fail)?);
}

pub(super) async fn api_herdr_action(
    _app: &Arc<App>,
    ctx: HerdrContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let target = ctx.target;
    let input: crate::herdr_action::Action = typed_body(&mut req, 65536).await?;
    return ok(target.action(input).await.map_err(fail)?);
}

pub(super) async fn api_herdr_ticket(
    app: &Arc<App>,
    ctx: HerdrContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner.as_str();
    let query = &ctx.query;
    let session_name = ctx.session_name;
    let target = ctx.target;
    let source = ctx.source.as_str();
    let terminal = query.get("terminalId").cloned().unwrap_or_default();
    // Existing ticket callers may omit a JSON body entirely.
    let input = if req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        typed_body::<crate::protocol::requests::HerdrTicket>(&mut req, 2048).await?
    } else {
        crate::protocol::requests::HerdrTicket::default()
    };
    let size = if input.mobile && !terminal.is_empty() {
        let dimension = |value: Option<u16>| value.filter(|value| (1..=1000).contains(value));
        Some(herdr_terminal_stream::Size {
            cols: dimension(input.cols).ok_or_else(|| fail("Invalid terminal size."))?,
            rows: dimension(input.rows).ok_or_else(|| fail("Invalid terminal size."))?,
        })
    } else {
        None
    };
    if !terminal.is_empty()
        && target
            .snapshot()
            .await
            .map_err(fail)?
            .terminal(&terminal)
            .is_none()
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
            history_delta: input.history_delta,
            frame_ack: input.frame_ack,
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
        json!({"ticket":ticket,"initialGeometry":true,"parkViews":true,"redrawBarrier":true,"heartbeat":true,"inputContexts":true,"wire":[wire::BINARY,wire::GZIP_FAST,wire::GZIP]}),
    )
}

pub(super) async fn api_herdr_reading(
    app: &Arc<App>,
    ctx: HerdrContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let input: crate::protocol::requests::HerdrReading = typed_body(&mut req, 32768).await?;
    let _permit = app
        .herdr_reading_capacity
        .try_acquire()
        .map_err(|_| fail("Too many reading commands are running."))?;
    let cancel = CancelOnDrop(CancellationToken::new());
    let opened = tokio::time::timeout(
        Duration::from_secs(30),
        crate::herdr_reading::open(
            &ctx.target,
            &input.terminal_id,
            &input.command,
            &input.context,
            &input.cwd,
            &cancel.0,
        ),
    )
    .await
    .map_err(|_| fail("Reading command timed out."))?
    .map_err(fail)?;
    match opened {
        crate::herdr_reading::Opened::File(path) => ok(json!({"path":path})),
        crate::herdr_reading::Opened::Capture {
            name,
            data,
            exit_code,
        } => {
            let key = format!("{}/{}/{}", ctx.owner, ctx.source, ctx.session_name);
            let mut readings = app.herdr_readings.lock().unwrap();
            if readings.len() >= 32
                && !readings.contains_key(&key)
                && let Some(old) = readings.keys().next().cloned()
            {
                readings.remove(&old);
            }
            let capture = readings
                .entry(key)
                .or_default()
                .add(&name, data, exit_code)
                .map_err(file_failure)?;
            ok(json!({"capture":capture.id,"name":capture.name,"exitCode":capture.exit_code}))
        }
    }
}

pub(super) async fn api_herdr_reading_file(
    _app: &Arc<App>,
    ctx: HerdrContext,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let path = ctx
        .query
        .get("path")
        .filter(|path| path.starts_with('/'))
        .ok_or_else(|| fail("Use an absolute file path."))?;
    let cancel = CancelOnDrop(CancellationToken::new());
    let file = if let Some(remote) = &ctx.target.remote {
        remote.read_for_viewing("/", path, &cancel.0).await
    } else {
        crate::reading::read(
            "/",
            ctx.target.env.get("HOME").map(String::as_str).unwrap_or(""),
            path,
        )
        .await
    }
    .map_err(file_failure)?;
    Ok(binary_response(file.mime, file.data))
}

pub(super) async fn api_herdr_reading_capture(
    app: &Arc<App>,
    ctx: HerdrContext,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let key = format!("{}/{}/{}", ctx.owner, ctx.source, ctx.session_name);
    let id = ctx.query.get("id").map(String::as_str).unwrap_or("");
    let mut readings = app.herdr_readings.lock().unwrap();
    if req.method() == Method::DELETE {
        if let Some(readings) = readings.get_mut(&key) {
            readings.remove(id);
        }
        return ok(json!({"ok":true}));
    }
    let capture = readings
        .get_mut(&key)
        .and_then(|readings| readings.get(id))
        .ok_or((
            StatusCode::NOT_FOUND,
            "This captured output has expired. Run the command again to create a new snapshot."
                .into(),
        ))?;
    Ok(binary_response(capture.mime, capture.data))
}
