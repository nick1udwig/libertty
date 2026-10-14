use super::*;
use axum::http::{Uri, request::Parts};
#[path = "routes/files.rs"]
mod files_routes;
#[path = "routes/herdr.rs"]
mod herdr_routes;
#[path = "routes/keychain.rs"]
mod keychain_routes;
#[path = "routes/notifications.rs"]
mod notifications_routes;
#[path = "routes/ssh.rs"]
mod ssh_routes;
#[path = "routes/terminal.rs"]
mod terminal_routes;

struct ApiError(Failure);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response<Body> {
        error(self.0.0, self.0.1)
    }
}
fn respond(result: Result<Response<Body>, Failure>) -> Response<Body> {
    result.unwrap_or_else(|failure| ApiError(failure).into_response())
}
fn ok(value: Value) -> Result<Response<Body>, Failure> {
    Ok(json_response(StatusCode::OK, value))
}
fn parse_query(uri: &Uri) -> Result<HashMap<String, String>, Failure> {
    Ok(url::Url::parse(&format!("http://localhost{uri}"))
        .map_err(|_| fail("Invalid URL"))?
        .query_pairs()
        .into_owned()
        .collect())
}
/// Resolve paired ownership once; modes add a scoped file session, shell, or Herdr target.
struct RequestContext<const MODE: u8> {
    owner: String,
    query: HashMap<String, String>,
    sid: String,
    key: String,
    session: Option<Arc<Session>>,
    target: Option<herdr::Target>,
    source: String,
    session_name: String,
}
impl<const MODE: u8> FromRequestParts<Arc<App>> for RequestContext<MODE> {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> Result<Self, Self::Rejection> {
        let work = async {
            let owner = app.owner(&parts.headers).ok_or((
                StatusCode::UNAUTHORIZED,
                "Connect to your shell first.".into(),
            ))?;
            let query = parse_query(&parts.uri)?;
            let sid = session_id(query.get("session").map(|s| json!(s)).as_ref())?;
            let key = format!("{owner}/{sid}");
            let session = if MODE == 1 || MODE == 2 {
                if sid != "default" && !app.sessions.lock().await.contains_key(&key) {
                    return Err((StatusCode::NOT_FOUND, "Terminal not found.".into()));
                }
                let session = app.get_session(&owner, &sid, "Terminal", false).await?;
                if MODE == 2 && session.files_only {
                    return Err(fail("Open a terminal tab for shell actions."));
                }
                Some(session)
            } else {
                None
            };
            let session_name = if MODE == 3 {
                herdr::session(query.get("herdrSession").map(|s| json!(s)).as_ref())
                    .map_err(fail)?
            } else {
                String::new()
            };
            let (source, target) = if MODE == 3 {
                let source = query
                    .get("herdrSource")
                    .filter(|s| !s.is_empty())
                    .map(String::as_str)
                    .unwrap_or("");
                let target = if source.is_empty() {
                    let key = format!("{owner}//{session_name}");
                    let mut targets = app.herdr_targets.lock().unwrap();
                    if let Some(target) = targets.get(&key) {
                        target.clone()
                    } else {
                        let target = herdr::Target::local(&session_name).map_err(fail)?;
                        targets.insert(key, target.clone());
                        target
                    }
                } else {
                    let source = session_id(Some(&json!(source)))?;
                    if !app
                        .sessions
                        .lock()
                        .await
                        .contains_key(&format!("{owner}/{source}"))
                    {
                        return Err((StatusCode::NOT_FOUND,"This Herdr connection has ended. Reconnect from the host menu, or run herdr again in its source terminal.".into()));
                    }
                    app.herdr_targets.lock().unwrap().get(&format!("{owner}/{source}/{session_name}")).cloned().ok_or((StatusCode::NOT_FOUND,"This Herdr connection has ended. Reconnect from the host menu, or run herdr again in its source terminal.".into()))?
                };
                (source.to_owned(), Some(target))
            } else {
                (String::new(), None)
            };
            Ok(Self {
                owner,
                query,
                sid,
                key,
                session,
                target,
                source,
                session_name,
            })
        };
        work.await.map_err(ApiError)
    }
}
async fn socket(State(app): State<Arc<App>>, req: Request<Body>) -> Response<Body> {
    respond(match parse_query(req.uri()) {
        Ok(query) => websocket(&app, req, &query).await,
        Err(error) => Err(error),
    })
}
async fn herdr_socket(State(app): State<Arc<App>>, req: Request<Body>) -> Response<Body> {
    respond(match parse_query(req.uri()) {
        Ok(query) => herdr_websocket(&app, req, &query).await,
        Err(error) => Err(error),
    })
}
macro_rules! endpoint {
    ($handler:path) => {
        |State(app): State<Arc<App>>, req: Request<Body>| async move {
            respond($handler(&app, req).await)
        }
    };
    ($handler:path, $context:ty) => {
        |State(app): State<Arc<App>>, ctx: $context, req: Request<Body>| async move {
            respond($handler(&app, ctx, req).await)
        }
    };
}
pub(super) fn router() -> Router<Arc<App>> {
    Router::new()
        .route(
            "/healthz",
            axum::routing::get(endpoint!(terminal_routes::healthz)),
        )
        .route(
            "/api/files/download",
            axum::routing::get(endpoint!(files_routes::api_files_download_download)).post(
                endpoint!(files_routes::api_files_download, RequestContext<1>),
            ),
        )
        .route(
            "/api/connect",
            axum::routing::post(endpoint!(terminal_routes::api_connect)),
        )
        .route(
            "/api/notifications/key",
            axum::routing::get(endpoint!(
                terminal_routes::api_notifications_key,
                RequestContext<0>
            )),
        )
        .route(
            "/api/ssh/probe",
            axum::routing::post(endpoint!(ssh_routes::api_ssh_probe, RequestContext<0>)),
        )
        .route(
            "/api/dictation",
            axum::routing::get(endpoint!(terminal_routes::api_dictation, RequestContext<0>)),
        )
        .route(
            "/api/ping",
            axum::routing::get(endpoint!(terminal_routes::api_ping, RequestContext<0>)),
        )
        .route(
            "/api/keychain",
            axum::routing::get(endpoint!(keychain_routes::api_keychain, RequestContext<0>))
                .post(endpoint!(keychain_routes::api_keychain, RequestContext<0>)),
        )
        .route(
            "/api/sessions",
            axum::routing::get(endpoint!(
                terminal_routes::api_sessions_get,
                RequestContext<0>
            ))
            .post(endpoint!(
                terminal_routes::api_sessions_post,
                RequestContext<0>
            )),
        )
        .route(
            "/api/sessions/close",
            axum::routing::post(endpoint!(
                terminal_routes::api_sessions_close,
                RequestContext<0>
            )),
        )
        .route(
            "/api/ticket",
            axum::routing::post(endpoint!(terminal_routes::api_ticket, RequestContext<0>)),
        )
        .route(
            "/api/plugins/read",
            axum::routing::get(endpoint!(files_routes::api_plugins_read, RequestContext<1>)),
        )
        .route(
            "/api/files/list",
            axum::routing::get(endpoint!(files_routes::api_files_list, RequestContext<1>)),
        )
        .route(
            "/api/files/mkdir",
            axum::routing::post(endpoint!(files_routes::api_files_mkdir, RequestContext<1>)),
        )
        .route(
            "/api/files/action",
            axum::routing::post(endpoint!(files_routes::api_files_action, RequestContext<1>)),
        )
        .route(
            "/api/images/upload",
            axum::routing::post(endpoint!(
                files_routes::api_images_upload,
                RequestContext<1>
            )),
        )
        .route(
            "/api/files/upload",
            axum::routing::post(endpoint!(files_routes::api_files_upload, RequestContext<1>)),
        )
        .route(
            "/api/files/transfer",
            axum::routing::post(endpoint!(
                files_routes::api_files_transfer,
                RequestContext<1>
            )),
        )
        .route(
            "/api/dictation/install",
            axum::routing::post(endpoint!(
                terminal_routes::api_dictation_install,
                RequestContext<2>
            )),
        )
        .route(
            "/api/reading/capture",
            axum::routing::get(endpoint!(
                terminal_routes::api_reading_capture,
                RequestContext<2>
            ))
            .delete(endpoint!(
                terminal_routes::api_reading_capture,
                RequestContext<2>
            )),
        )
        .route(
            "/api/reading/file",
            axum::routing::get(endpoint!(
                terminal_routes::api_reading_file,
                RequestContext<2>
            )),
        )
        .route(
            "/api/ssh/captured",
            axum::routing::post(endpoint!(ssh_routes::api_ssh_captured, RequestContext<2>)),
        )
        .route(
            "/api/context",
            axum::routing::get(endpoint!(terminal_routes::api_context, RequestContext<2>)),
        )
        .route(
            "/api/suggest",
            axum::routing::post(endpoint!(terminal_routes::api_suggest, RequestContext<2>)),
        )
        .route(
            "/api/facts",
            axum::routing::post(endpoint!(terminal_routes::api_facts, RequestContext<2>)),
        )
        .route(
            "/api/new",
            axum::routing::post(endpoint!(terminal_routes::api_new, RequestContext<2>)),
        )
        .route(
            "/api/herdr/connect",
            axum::routing::post(endpoint!(
                herdr_routes::api_herdr_connect,
                RequestContext<0>
            )),
        )
        .route(
            "/api/herdr/captured",
            axum::routing::post(endpoint!(
                herdr_routes::api_herdr_captured,
                RequestContext<0>
            )),
        )
        .route(
            "/api/herdr/notifications",
            axum::routing::post(endpoint!(
                herdr_routes::api_herdr_notifications,
                RequestContext<3>
            )),
        )
        .route(
            "/api/herdr/snapshot",
            axum::routing::get(endpoint!(
                herdr_routes::api_herdr_snapshot,
                RequestContext<3>
            )),
        )
        .route(
            "/api/herdr/images/upload",
            axum::routing::post(endpoint!(
                herdr_routes::api_herdr_images_upload,
                RequestContext<3>
            )),
        )
        .route(
            "/api/herdr/options",
            axum::routing::get(endpoint!(
                herdr_routes::api_herdr_options,
                RequestContext<3>
            )),
        )
        .route(
            "/api/herdr/suggest",
            axum::routing::post(endpoint!(
                herdr_routes::api_herdr_suggest,
                RequestContext<3>
            )),
        )
        .route(
            "/api/herdr/action",
            axum::routing::post(endpoint!(herdr_routes::api_herdr_action, RequestContext<3>)),
        )
        .route(
            "/api/herdr/ticket",
            axum::routing::post(endpoint!(herdr_routes::api_herdr_ticket, RequestContext<3>)),
        )
        .route(
            "/api/notifications/subscribe",
            axum::routing::post(endpoint!(
                notifications_routes::api_notifications_subscribe,
                RequestContext<0>
            )),
        )
        .route(
            "/api/notifications/unsubscribe",
            axum::routing::post(endpoint!(
                notifications_routes::api_notifications_unsubscribe,
                RequestContext<0>
            )),
        )
        .route(
            "/api/notifications/unwatch",
            axum::routing::post(endpoint!(
                notifications_routes::api_notifications_unwatch,
                RequestContext<0>
            )),
        )
        .route("/ws", axum::routing::any(socket))
        .route("/herdr/ws", axum::routing::any(herdr_socket))
}
