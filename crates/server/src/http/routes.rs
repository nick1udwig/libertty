use super::*;
use axum::{
    http::{Uri, request::Parts},
    routing::{any, get, post},
};
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
    key: SessionKey,
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
    key: SessionKey,
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
    type Rejection = Failure;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Failure> {
        let owner = app.owner(&parts.headers).ok_or_else(|| {
            Failure(
                StatusCode::UNAUTHORIZED,
                "Connect to your shell first.".into(),
            )
        })?;
        let query = parse_query(&parts.uri)?;
        let sid = session_id_text(query.get("session").map(String::as_str))?;
        let key = SessionKey::new(&owner, &sid);
        Ok(Self {
            owner,
            query,
            sid,
            key,
        })
    }
}
impl FromRequestParts<Arc<App>> for FileContext {
    type Rejection = Failure;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Failure> {
        let OwnerContext {
            owner,
            query,
            sid,
            key,
        } = OwnerContext::from_request_parts(parts, app).await?;
        if sid != "default" && !app.sessions.lock().await.contains_key(&key) {
            return Err(Failure(StatusCode::NOT_FOUND, "Terminal not found.".into()));
        }
        let session = app.get_session(&owner, &sid, "Terminal", false).await?;
        Ok(Self {
            owner,
            query,
            sid,
            session,
        })
    }
}
impl FromRequestParts<Arc<App>> for ShellContext {
    type Rejection = Failure;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Failure> {
        let FileContext {
            owner,
            query,
            sid,
            session,
        } = FileContext::from_request_parts(parts, app).await?;
        if session.files_only {
            return Err(fail("Open a terminal tab for shell actions."));
        }
        let key = SessionKey::new(&owner, &sid);
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
    type Rejection = Failure;
    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Failure> {
        let OwnerContext { owner, query, .. } =
            OwnerContext::from_request_parts(parts, app).await?;
        let session_name =
            herdr::session(query.get("herdrSession").map(String::as_str)).map_err(fail)?;
        let source = query
            .get("herdrSource")
            .filter(|source| !source.is_empty())
            .cloned()
            .unwrap_or_default();
        let disconnected = || {
            Failure(StatusCode::NOT_FOUND, "This Herdr connection has ended. Reconnect from the host menu, or run herdr again in its source terminal.".into())
        };
        let target = if source.is_empty() {
            let key = (SessionKey::new(&owner, ""), session_name.clone());
            let mut targets = app.herdr_targets.lock().unwrap();
            if let Some(target) = targets.get(&key) {
                target.clone()
            } else {
                let target = herdr::Target::local(&session_name).map_err(fail)?;
                targets.insert(key, target.clone());
                target
            }
        } else {
            let source = session_id_text(Some(&source))?;
            if !app
                .sessions
                .lock()
                .await
                .contains_key(&SessionKey::new(&owner, &source))
            {
                return Err(disconnected());
            }
            app.herdr_targets
                .lock()
                .unwrap()
                .get(&(SessionKey::new(&owner, &source), session_name.clone()))
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
async fn socket(
    State(app): State<Arc<App>>,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = parse_query(req.uri())?;
    websocket(&app, req, &query).await
}
async fn herdr_socket(
    State(app): State<Arc<App>>,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let query = parse_query(req.uri())?;
    herdr_websocket(&app, req, &query).await
}
pub(super) fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/healthz", get(terminal_routes::healthz))
        .route(
            "/api/files/download",
            get(files_routes::api_files_download_download).post(files_routes::api_files_download),
        )
        .route("/api/connect", post(terminal_routes::api_connect))
        .route(
            "/api/notifications/key",
            get(terminal_routes::api_notifications_key),
        )
        .route("/api/ssh/probe", post(ssh_routes::api_ssh_probe))
        .route("/api/dictation", get(terminal_routes::api_dictation))
        .route("/api/ping", get(terminal_routes::api_ping))
        .route(
            "/api/keychain",
            get(keychain_routes::api_keychain).post(keychain_routes::api_keychain),
        )
        .route(
            "/api/sessions",
            get(terminal_routes::api_sessions_get).post(terminal_routes::api_sessions_post),
        )
        .route(
            "/api/sessions/close",
            post(terminal_routes::api_sessions_close),
        )
        .route("/api/ticket", post(terminal_routes::api_ticket))
        .route("/api/plugins/read", get(files_routes::api_plugins_read))
        .route("/api/files/list", get(files_routes::api_files_list))
        .route("/api/files/mkdir", post(files_routes::api_files_mkdir))
        .route("/api/files/action", post(files_routes::api_files_action))
        .route("/api/images/upload", post(files_routes::api_images_upload))
        .route("/api/files/upload", post(files_routes::api_files_upload))
        .route(
            "/api/files/transfer",
            post(files_routes::api_files_transfer),
        )
        .route(
            "/api/dictation/install",
            post(terminal_routes::api_dictation_install),
        )
        .route(
            "/api/reading/capture",
            get(terminal_routes::api_reading_capture).delete(terminal_routes::api_reading_capture),
        )
        .route("/api/reading/file", get(terminal_routes::api_reading_file))
        .route("/api/ssh/captured", post(ssh_routes::api_ssh_captured))
        .route("/api/suggest", post(terminal_routes::api_suggest))
        .route("/api/new", post(terminal_routes::api_new))
        .route("/api/herdr/connect", post(herdr_routes::api_herdr_connect))
        .route(
            "/api/herdr/captured",
            post(herdr_routes::api_herdr_captured),
        )
        .route(
            "/api/herdr/notifications",
            post(herdr_routes::api_herdr_notifications),
        )
        .route("/api/herdr/snapshot", get(herdr_routes::api_herdr_snapshot))
        .route("/api/herdr/response", get(herdr_routes::api_herdr_response))
        .route(
            "/api/herdr/images/upload",
            post(herdr_routes::api_herdr_images_upload),
        )
        .route("/api/herdr/options", get(herdr_routes::api_herdr_options))
        .route("/api/herdr/reading", post(herdr_routes::api_herdr_reading))
        .route(
            "/api/herdr/reading/file",
            get(herdr_routes::api_herdr_reading_file),
        )
        .route(
            "/api/herdr/reading/capture",
            get(herdr_routes::api_herdr_reading_capture)
                .delete(herdr_routes::api_herdr_reading_capture),
        )
        .route("/api/herdr/action", post(herdr_routes::api_herdr_action))
        .route("/api/herdr/ticket", post(herdr_routes::api_herdr_ticket))
        .route(
            "/api/notifications/subscribe",
            post(notifications_routes::api_notifications_subscribe),
        )
        .route(
            "/api/notifications/unsubscribe",
            post(notifications_routes::api_notifications_unsubscribe),
        )
        .route(
            "/api/notifications/unwatch",
            post(notifications_routes::api_notifications_unwatch),
        )
        .route("/ws", any(socket))
        .route("/herdr/ws", any(herdr_socket))
}
