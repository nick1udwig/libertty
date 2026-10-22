use super::*;

pub(super) async fn api_notifications_subscribe(
    State(app): State<Arc<App>>,
    ctx: OwnerContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input: crate::protocol::requests::Subscribe = typed_body(&mut req, 16384).await?;
    ok(json!({"device":app.notifications.subscribe(&owner,&input.subscription).map_err(fail)?}))
}

pub(super) async fn api_notifications_unsubscribe(
    State(app): State<Arc<App>>,
    ctx: OwnerContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input: crate::protocol::requests::Device = typed_body(&mut req, 16384).await?;
    app.notifications
        .unsubscribe(&owner, &input.device)
        .map_err(fail)?;
    ok(json!({"ok":true}))
}

pub(super) async fn api_notifications_unwatch(
    State(app): State<Arc<App>>,
    ctx: OwnerContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let owner = ctx.owner;
    let input: crate::protocol::requests::Watch = typed_body(&mut req, 16384).await?;
    app.notifications
        .remove_view(&owner, &input.device, &input.tab_id)
        .map_err(fail)?;
    ok(json!({"ok":true}))
}
