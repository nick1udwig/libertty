use super::*;

pub(super) async fn healthz(
    app: &Arc<App>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    return Ok(json_response(
        StatusCode::OK,
        json!({"ok":true,"version":env!("CARGO_PKG_VERSION"),"commit":app.config.release.as_ref().and_then(|v| v["commit"].as_str()).or(option_env!("TERMAI_COMMIT")),"platform":if cfg!(target_os="macos"){"darwin"}else{std::env::consts::OS},"arch":if cfg!(target_arch="x86_64"){"x64"}else{std::env::consts::ARCH},"runtime":"rust","packaged":app.config.release.is_some() || option_env!("TERMAI_COMMIT").is_some()}),
    ));
}

pub(super) async fn api_connect(
    app: &Arc<App>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let mut owner = app.owner(req.headers());
    let input = body(&mut req, 16384).await?;
    if owner.is_none() {
        if !token_matches(&app.token, text(&input, "token")) {
            return Err((
                StatusCode::UNAUTHORIZED,
                "Enter the pairing token shown by your termai server.".into(),
            ));
        }
        let mut registry = app.owners.lock().unwrap();
        if registry.len() >= 256 {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "The saved pairing limit has been reached. Revoke old pairings before adding more."
                    .into(),
            ));
        }
        owner = Some(registry.issue().map_err(|e| fail(e.to_string()))?);
    }
    let owner = owner.unwrap();
    let sid = session_id(input.get("session"))?;
    let result = if input["noSession"] == true {
        json!({"accessToken":owner,"wire":[wire::BINARY,wire::GZIP_FAST,wire::GZIP]})
    } else {
        if sid != "default"
            && !app
                .sessions
                .lock()
                .await
                .contains_key(&format!("{owner}/{sid}"))
        {
            return Err((
                StatusCode::NOT_FOUND,
                "This terminal has ended. Open its saved host to reconnect.".into(),
            ));
        }
        json!({"state":app.get_session(&owner,&sid,"Terminal",false).await?.state(),"accessToken":owner,"wire":[wire::BINARY,wire::GZIP_FAST,wire::GZIP]})
    };
    let secure = if req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.starts_with("https:"))
    {
        "; Secure"
    } else {
        ""
    };
    let mut response = json_response(StatusCode::OK, result);
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "termai={owner}; Path={}; HttpOnly; SameSite=Strict; Max-Age=31536000{secure}",
            app.config.public_base
        ))
        .map_err(|_| fail("Invalid pairing credential."))?,
    );
    return Ok(response);
}

pub(super) async fn api_notifications_key(
    app: &Arc<App>,
    _ctx: RequestContext<0>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    return ok(json!({"publicKey":app.notifications.public_key}));
}

pub(super) async fn api_dictation(
    _app: &Arc<App>,
    _ctx: RequestContext<0>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    return ok(dictation::detect(&std::env::vars().collect()).await);
}

pub(super) async fn api_ping(
    _app: &Arc<App>,
    _ctx: RequestContext<0>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    return ok(json!({"ok":true}));
}

pub(super) async fn api_sessions_get(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sessions = app.sessions.lock().await;
    return ok(json!(sessions.iter().filter(|(key,_)|key.starts_with(&format!("{owner}/"))).map(|(_,t)|json!({"id":t.id,"name":t.name,"kind":if t.session.remote.is_some(){"ssh"}else{"http"},"state":t.session.state()})).collect::<Vec<_>>()));
}

pub(super) async fn api_sessions_post(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input = body(&mut req, 16384).await?;
    let raw = storage::random_hex(16);
    let sid = format!(
        "{}-{}-{}-{}-{}",
        &raw[..8],
        &raw[8..12],
        &raw[12..16],
        &raw[16..20],
        &raw[20..]
    );
    let name = if text(&input, "name").trim().is_empty() {
        "Terminal".into()
    } else {
        text(&input, "name")
            .trim()
            .chars()
            .scan(0, |n, c| {
                *n += c.len_utf16();
                if *n <= 100 { Some(c) } else { None }
            })
            .collect::<String>()
    };
    let session = if input.get("ssh").is_some_and(|v| !v.is_null()) {
        match app
            .get_remote_session(
                &owner,
                &sid,
                &name,
                &input["ssh"],
                None,
                input["files"] == true,
            )
            .await
        {
            Ok(session) => session,
            Err(error) => return Ok(ssh_error(error)),
        }
    } else {
        app.get_session(&owner, &sid, &name, input["files"] == true)
            .await?
    };
    return ok(json!({"id":sid,"name":name,"state":session.state()}));
}

pub(super) async fn api_sessions_close(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sid = ctx.sid;
    app.close_session(&owner, &sid).await;
    return ok(json!({"ok":true}));
}

pub(super) async fn api_ticket(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sid = ctx.sid;
    let key = ctx.key;
    if !app
        .sessions
        .lock()
        .await
        .get(&key)
        .is_some_and(|t| !t.session.files_only)
    {
        return Err((StatusCode::NOT_FOUND, "Terminal not found.".into()));
    }
    let mut tickets = app.tickets.lock().unwrap();
    tickets.retain(|_, t| t.until >= Instant::now());
    if tickets.len() >= 256 {
        return Err(fail("Too many pending connections."));
    }
    let ticket = storage::random_hex(32);
    tickets.insert(
        ticket.clone(),
        Ticket {
            owner,
            session: sid,
            until: Instant::now() + Duration::from_secs(15),
        },
    );
    return ok(json!({"ticket":ticket,"wire":[wire::BINARY,wire::GZIP_FAST,wire::GZIP]}));
}

pub(super) async fn api_dictation_install(
    _app: &Arc<App>,
    ctx: RequestContext<2>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session = ctx.session.unwrap();
    let input: crate::protocol::InputStamp = typed_body(&mut req, 16384).await?;
    let command = dictation::install_command(&std::env::vars().collect())
        .await
        .map_err(fail)?;
    if !session.paste(&command, input.prompt, input.revision, true, None) {
        return Err(fail(
            "The terminal changed. Return to the shell prompt and try again.",
        ));
    }
    return ok(json!({"ok":true}));
}

pub(super) async fn api_reading_capture(
    _app: &Arc<App>,
    ctx: RequestContext<2>,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session.unwrap();
    let get = *req.method() == Method::GET;
    let id = query.get("id").map(String::as_str).unwrap_or("");
    if *req.method() == Method::DELETE {
        session.remove_reading_capture(id);
        return ok(json!({"ok":true}));
    }
    if get {
        let capture = session.reading_capture(id).ok_or((
            StatusCode::NOT_FOUND,
            "This captured output has expired. Run the command again to create a new snapshot."
                .into(),
        ))?;
        return Ok(binary_response(capture.mime, capture.data));
    }
    Err((StatusCode::NOT_FOUND, "Not found".into()))
}

pub(super) async fn api_reading_file(
    _app: &Arc<App>,
    ctx: RequestContext<2>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = ctx.query;
    let session = ctx.session.unwrap();
    let cwd = session.state().cwd;
    let path = query
        .get("path")
        .ok_or_else(|| fail("Enter a file path."))?;
    let file = session.read_file(&cwd, path).await.map_err(file_failure)?;
    return Ok(binary_response(file.mime, file.data));
}

pub(super) async fn api_context(
    _app: &Arc<App>,
    ctx: RequestContext<2>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session = ctx.session.unwrap();
    return ok(
        serde_json::to_value(session.snapshot(true).await.map_err(fail)?.0)
            .map_err(|e| fail(e.to_string()))?,
    );
}

pub(super) async fn api_suggest(
    _app: &Arc<App>,
    ctx: RequestContext<2>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session = ctx.session.unwrap();
    if session.engine_mode != "server" {
        return Err((
            StatusCode::CONFLICT,
            "This connection computes suggestions in the client.".into(),
        ));
    }
    let input: crate::protocol::SuggestRequest = typed_body(&mut req, 16384).await?;
    let text = input.text.as_str();
    return ok(bounded(async |cancel| session.suggest(text, cancel).await).await?);
}

pub(super) async fn api_facts(
    _app: &Arc<App>,
    ctx: RequestContext<2>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session = ctx.session.unwrap();
    let input = body(&mut req, 16384).await?;
    return ok(bounded(async |cancel| {
        if input["kind"] == "context" {
            session
                .context(input["known"].as_str(), input["paths"] != false)
                .await
        } else if input["kind"] == "repair" {
            if input.get("key").is_none() {
                let prompt = session.state().prompt;
                if input
                    .get("prompt")
                    .is_some_and(|value| value.as_u64() != Some(prompt))
                {
                    return Err("Shell context changed. Try again.".into());
                }
                let result = session
                    .suggest(
                        input["text"]
                            .as_str()
                            .filter(|text| text.encode_utf16().count() <= 2000)
                            .ok_or("Expected command text under 2,000 characters.")?,
                        cancel,
                    )
                    .await?;
                if session.state().prompt != prompt {
                    return Err("Shell context changed. Try again.".into());
                }
                return Ok(result["candidates"].clone());
            }
            session
                .repair(
                    input["key"].as_str().ok_or("Expected a context key.")?,
                    input["catalogKey"]
                        .as_str()
                        .ok_or("Expected a catalog key.")?,
                    input["text"].as_str().ok_or("Expected command text.")?,
                    cancel,
                )
                .await
        } else if let Some(key) = input["key"].as_str() {
            session.read_facts(key, &input["operations"], cancel).await
        } else {
            Err("Expected a context key.".into())
        }
    })
    .await?);
}

pub(super) async fn api_new(
    app: &Arc<App>,
    ctx: RequestContext<2>,
    _req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let sid = ctx.sid;
    let session = ctx.session.unwrap();
    if session.remote.is_some() {
        return Err(fail(
            "Open the saved SSH host again to start another shell.",
        ));
    }
    app.close_session(&owner, &sid).await;
    return ok(json!({"state":app.get_session(&owner,&sid,"Terminal",false).await?.state()}));
}
