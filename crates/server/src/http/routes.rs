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
/// Paired ownership and validated query scope, without opening a session.
struct OwnerContext {
    owner: String,
    query: HashMap<String, String>,
    sid: String,
    key: String,
}
struct FileContext {
    owner: String,
    query: HashMap<String, String>,
    sid: String,
    session: Arc<Session>,
}
struct ShellContext {
    owner: String,
    query: HashMap<String, String>,
    sid: String,
    key: String,
    session: Arc<Session>,
}
struct HerdrContext {
    owner: String,
    query: HashMap<String, String>,
    target: herdr::Target,
    source: String,
    session_name: String,
}
impl FromRequestParts<Arc<App>> for OwnerContext {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let owner = app.owner(&parts.headers).ok_or_else(|| {
            ApiError((
                StatusCode::UNAUTHORIZED,
                "Connect to your shell first.".into(),
            ))
        })?;
        let query = parse_query(&parts.uri).map_err(ApiError)?;
        let sid = session_id_text(query.get("session").map(String::as_str)).map_err(ApiError)?;
        let key = format!("{owner}/{sid}");
        Ok(Self {
            owner,
            query,
            sid,
            key,
        })
    }
}
impl FromRequestParts<Arc<App>> for FileContext {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let OwnerContext {
            owner,
            query,
            sid,
            key,
        } = OwnerContext::from_request_parts(parts, app).await?;
        if sid != "default" && !app.sessions.lock().await.contains_key(&key) {
            return Err(ApiError((
                StatusCode::NOT_FOUND,
                "Terminal not found.".into(),
            )));
        }
        let session = app
            .get_session(&owner, &sid, "Terminal", false)
            .await
            .map_err(ApiError)?;
        Ok(Self {
            owner,
            query,
            sid,
            session,
        })
    }
}
impl FromRequestParts<Arc<App>> for ShellContext {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let FileContext {
            owner,
            query,
            sid,
            session,
        } = FileContext::from_request_parts(parts, app).await?;
        if session.files_only {
            return Err(ApiError(fail("Open a terminal tab for shell actions.")));
        }
        let key = format!("{owner}/{sid}");
        Ok(Self {
            owner,
            query,
            sid,
            key,
            session,
        })
    }
}
impl FromRequestParts<Arc<App>> for HerdrContext {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let OwnerContext { owner, query, .. } =
            OwnerContext::from_request_parts(parts, app).await?;
        let session_name = herdr::session(query.get("herdrSession").map(|s| json!(s)).as_ref())
            .map_err(|error| ApiError(fail(error)))?;
        let source = query
            .get("herdrSource")
            .filter(|source| !source.is_empty())
            .cloned()
            .unwrap_or_default();
        let disconnected = || {
            ApiError((StatusCode::NOT_FOUND, "This Herdr connection has ended. Reconnect from the host menu, or run herdr again in its source terminal.".into()))
        };
        let target = if source.is_empty() {
            let key = format!("{owner}//{session_name}");
            let mut targets = app.herdr_targets.lock().unwrap();
            if let Some(target) = targets.get(&key) {
                target.clone()
            } else {
                let target =
                    herdr::Target::local(&session_name).map_err(|error| ApiError(fail(error)))?;
                targets.insert(key, target.clone());
                target
            }
        } else {
            let source = session_id_text(Some(&source)).map_err(ApiError)?;
            if !app
                .sessions
                .lock()
                .await
                .contains_key(&format!("{owner}/{source}"))
            {
                return Err(disconnected());
            }
            app.herdr_targets
                .lock()
                .unwrap()
                .get(&format!("{owner}/{source}/{session_name}"))
                .cloned()
                .ok_or_else(disconnected)?
        };
        Ok(Self {
            owner,
            query,
            target,
            source,
            session_name,
        })
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
macro_rules! routes {
    ($($path:literal => $method:ident($handler:path $(, $context:ty)?) $(, $next:ident($next_handler:path $(, $next_context:ty)?))*;)*) => {
        Router::new()$(.route($path, axum::routing::$method(endpoint!($handler $(, $context)?))$(.$next(endpoint!($next_handler $(, $next_context)?)))*))*
    };
}
pub(super) fn router() -> Router<Arc<App>> {
    routes! {
        "/healthz" => get(terminal_routes::healthz);
        "/api/files/download" => get(files_routes::api_files_download_download),
            post(files_routes::api_files_download, FileContext);
        "/api/connect" => post(terminal_routes::api_connect);
        "/api/notifications/key" => get(terminal_routes::api_notifications_key, OwnerContext);
        "/api/ssh/probe" => post(ssh_routes::api_ssh_probe, OwnerContext);
        "/api/dictation" => get(terminal_routes::api_dictation, OwnerContext);
        "/api/ping" => get(terminal_routes::api_ping, OwnerContext);
        "/api/keychain" => get(keychain_routes::api_keychain, OwnerContext),
            post(keychain_routes::api_keychain, OwnerContext);
        "/api/sessions" => get(terminal_routes::api_sessions_get, OwnerContext),
            post(terminal_routes::api_sessions_post, OwnerContext);
        "/api/sessions/close" => post(terminal_routes::api_sessions_close, OwnerContext);
        "/api/ticket" => post(terminal_routes::api_ticket, OwnerContext);
        "/api/plugins/read" => get(files_routes::api_plugins_read, FileContext);
        "/api/files/list" => get(files_routes::api_files_list, FileContext);
        "/api/files/mkdir" => post(files_routes::api_files_mkdir, FileContext);
        "/api/files/action" => post(files_routes::api_files_action, FileContext);
        "/api/images/upload" => post(files_routes::api_images_upload, FileContext);
        "/api/files/upload" => post(files_routes::api_files_upload, FileContext);
        "/api/files/transfer" => post(files_routes::api_files_transfer, FileContext);
        "/api/dictation/install" => post(terminal_routes::api_dictation_install, ShellContext);
        "/api/reading/capture" => get(terminal_routes::api_reading_capture, ShellContext),
            delete(terminal_routes::api_reading_capture, ShellContext);
        "/api/reading/file" => get(terminal_routes::api_reading_file, ShellContext);
        "/api/ssh/captured" => post(ssh_routes::api_ssh_captured, ShellContext);
        "/api/suggest" => post(terminal_routes::api_suggest, ShellContext);
        "/api/new" => post(terminal_routes::api_new, ShellContext);
        "/api/herdr/connect" => post(herdr_routes::api_herdr_connect, OwnerContext);
        "/api/herdr/captured" => post(herdr_routes::api_herdr_captured, OwnerContext);
        "/api/herdr/notifications" => post(herdr_routes::api_herdr_notifications, HerdrContext);
        "/api/herdr/snapshot" => get(herdr_routes::api_herdr_snapshot, HerdrContext);
        "/api/herdr/images/upload" => post(herdr_routes::api_herdr_images_upload, HerdrContext);
        "/api/herdr/options" => get(herdr_routes::api_herdr_options, HerdrContext);
        "/api/herdr/reading" => post(herdr_routes::api_herdr_reading, HerdrContext);
        "/api/herdr/reading/file" => get(herdr_routes::api_herdr_reading_file, HerdrContext);
        "/api/herdr/reading/capture" => get(herdr_routes::api_herdr_reading_capture, HerdrContext),
            delete(herdr_routes::api_herdr_reading_capture, HerdrContext);
        "/api/herdr/action" => post(herdr_routes::api_herdr_action, HerdrContext);
        "/api/herdr/ticket" => post(herdr_routes::api_herdr_ticket, HerdrContext);
        "/api/notifications/subscribe" => post(notifications_routes::api_notifications_subscribe, OwnerContext);
        "/api/notifications/unsubscribe" => post(notifications_routes::api_notifications_unsubscribe, OwnerContext);
        "/api/notifications/unwatch" => post(notifications_routes::api_notifications_unwatch, OwnerContext);
    }
    .route("/ws", axum::routing::any(socket))
    .route("/herdr/ws", axum::routing::any(herdr_socket))
}
