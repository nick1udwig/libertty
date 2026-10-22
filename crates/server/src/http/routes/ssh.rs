use super::*;

pub(super) async fn api_ssh_probe(
    State(app): State<Arc<App>>,
    _ctx: OwnerContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let _permit = app.ssh_probes.try_acquire().map_err(|_| {
        Failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Route probes are busy. Try again.".into(),
        )
    })?;
    let input: crate::protocol::requests::SshAddress = typed_body(&mut req, 16384).await?;
    ok(
        json!({"milliseconds":ssh::route_probe_request(&input,&CancellationToken::new()).await.map_err(fail)?}),
    )
}

pub(super) async fn api_ssh_captured(
    State(app): State<Arc<App>>,
    ctx: ShellContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let key = ctx.key;
    let session = ctx.session;
    let cwd = session.state().cwd;
    let input: crate::protocol::requests::Capture = typed_body(&mut req, 16384).await?;
    let id = input.id.as_str();
    if input.action == crate::protocol::requests::CaptureAction::Ack {
        session.acknowledge_capture(id);
        return ok(json!({"ok":true}));
    }
    if let Some(result) = session.capture_result(id) {
        return ok(result);
    }
    if input.action == crate::protocol::requests::CaptureAction::Cancel
        || input.action == crate::protocol::requests::CaptureAction::Native
    {
        let _flight = session
            .capture_flight
            .try_lock()
            .map_err(|_| fail("SSH is still connecting."))?;
        if session.remote.is_some()
            || session
                .captured()
                .is_none_or(|c| c["kind"] != "ssh" || c["id"] != id)
        {
            return Err(fail("This SSH request is no longer active."));
        }
        session
            .release_capture(
                id,
                input.action == crate::protocol::requests::CaptureAction::Native,
                None,
            )
            .map_err(fail)?;
        return ok(
            json!({"native":input.action == crate::protocol::requests::CaptureAction::Native}),
        );
    }
    let _flight = session.capture_flight.lock().await;
    if let Some(result) = session.capture_result(id) {
        return ok(result);
    }
    let capture = session
        .captured()
        .filter(|c| c["kind"] == "ssh" && c["id"] == id && session.remote.is_none())
        .ok_or_else(|| fail("This SSH request is no longer active."))?;
    let resolved = system_ssh::resolve(
        capture["command"].as_str().unwrap_or(""),
        &session.environment().await,
        &cwd,
        input.passphrase.as_deref(),
        &CancellationToken::new(),
    )
    .await;
    let system = match resolved {
        Ok(system) if system.identities.is_empty() && !system.locked => {
            let result =
                json!({"native":true,"message":"No reusable key was found; using native SSH."});
            session
                .release_capture(id, true, Some(result.clone()))
                .map_err(fail)?;
            return ok(result);
        }
        Ok(system) => system,
        Err(error) if error.native => {
            let result = json!({"native":true,"message":error.message});
            session
                .release_capture(id, true, Some(result.clone()))
                .map_err(fail)?;
            return ok(result);
        }
        Err(error) => return Err(fail(error.message)),
    };
    if id.len() != 32 {
        return Err(fail("This SSH request is no longer active."));
    }
    let child_id = format!(
        "{}-{}-{}-{}-{}",
        &id[..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..]
    );
    let name = format!("{}@{}", system.address.username, system.address.host);
    let input = json!({"host":system.address.host,"port":system.address.port,"username":system.address.username,"trust":input.trust});
    let child = match app
        .get_remote_session(&owner, &child_id, &name, &input, Some(system), false)
        .await
    {
        Ok(child) => child,
        Err(error) => return Ok(ssh_error(error)),
    };
    let mut result = json!({"id":child_id,"name":name,"host":input["host"],"port":input["port"],"username":input["username"]});
    if let Some(key) = child.remote.as_ref().and_then(|h| h.key.as_ref()) {
        result["key"] = json!(key);
    }
    if !app
        .sessions
        .lock()
        .await
        .get(&key)
        .is_some_and(|t| Arc::ptr_eq(&t.session, &session))
    {
        app.close_session(&owner, &child_id).await;
        return Err(fail("The source terminal has ended."));
    }
    session
        .release_capture(id, false, Some(result.clone()))
        .map_err(fail)?;
    ok(result)
}
