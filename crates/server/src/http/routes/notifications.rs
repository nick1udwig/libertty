use super::*;

pub(super) async fn api_notifications_subscribe(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input = body(&mut req, 16384).await?;
    ok(json!({"device":app.notifications.subscribe(&owner,&input["subscription"]).map_err(fail)?}))
}

pub(super) async fn api_notifications_unsubscribe(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input = body(&mut req, 16384).await?;
    app.notifications
        .unsubscribe(&owner, &input["device"])
        .map_err(fail)?;
    ok(json!({"ok":true}))
}

pub(super) async fn api_notifications_unwatch(
    app: &Arc<App>,
    ctx: RequestContext<0>,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input = body(&mut req, 16384).await?;
    app.notifications
        .remove_view(&owner, &input["device"], &input["tabId"])
        .map_err(fail)?;
    ok(json!({"ok":true}))
}
