use crate::{
    assets, dictation, files, herdr, herdr_terminal_stream, herdr_view,
    host::HostServices,
    notifications,
    pairing::{Pairings, pairing_token, token_matches},
    reading,
    session::{Session, Transport},
    ssh, storage, system_ssh,
    vault::{Vault, inspect_private_key},
};
use axum::{
    Router,
    body::Body,
    extract::{
        FromRequestParts, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub base_path: String,
    pub public_base: String,
    pub data_directory: PathBuf,
    pub dist: PathBuf,
    pub engine: String,
    pub allowed_hosts: HashSet<String>,
    pub allowed_origins: HashSet<String>,
    pub release: Option<Value>,
    pub dev_frontend: Option<String>,
}
impl Config {
    pub fn from_env() -> Result<Self, String> {
        let setting = |name: &str, fallback: &str| {
            std::env::var(name)
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| fallback.into())
        };
        let host = setting("HOST", "127.0.0.1");
        let port = setting("PORT", "3000")
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or("PORT must be between 1 and 65535.")?;
        let base_path = format!(
            "/{}",
            setting("TERMAI_BASE_PATH", "")
                .split('/')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        );
        if base_path != "/"
            && !base_path[1..].split('/').all(|p| {
                p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
        {
            return Err("Invalid TERMAI_BASE_PATH.".into());
        }
        let public_base = if base_path == "/" {
            "/".into()
        } else {
            format!("{base_path}/")
        };
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(&host.as_str());
        let set = |name, fallback| {
            setting(name, fallback)
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect::<HashSet<_>>()
        };
        let allowed_hosts = set(
            "TERMAI_ALLOWED_HOSTS",
            if loopback {
                "localhost,127.0.0.1,[::1]"
            } else {
                ""
            },
        );
        if !loopback && allowed_hosts.is_empty() {
            return Err("Set TERMAI_ALLOWED_HOSTS to the hostname(s) used by your phone.".into());
        }
        let home = setting("HOME", ".");
        let data_directory = PathBuf::from(setting(
            "TERMAI_DATA_DIR",
            &format!("{home}/.local/share/termai"),
        ));
        let engine = setting("TERMAI_ENGINE", "server");
        if !["server", "client"].contains(&engine.as_str()) {
            return Err("TERMAI_ENGINE must be server or client.".into());
        }
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let packaged = crate::release::packaged_root().map(|root| root.join("dist"));
        let dist = std::env::var_os("TERMAI_DIST_DIR")
            .map(PathBuf::from)
            .or(packaged)
            .unwrap_or_else(|| source_root.join("dist"));
        Ok(Self {
            host,
            port,
            base_path,
            public_base,
            data_directory,
            dist,
            engine,
            allowed_hosts,
            allowed_origins: set("TERMAI_ALLOWED_ORIGINS", ""),
            release: crate::release::metadata(),
            dev_frontend: if setting("NODE_ENV", "production") == "development" {
                std::env::var("TERMAI_DEV_FRONTEND")
                    .ok()
                    .map(|v| crate::dev::origin(&v))
                    .transpose()?
            } else {
                None
            },
        })
    }
}
struct Terminal {
    session: Arc<Session>,
    id: String,
    name: String,
}
struct Opening {
    gate: std::sync::Weak<tokio::sync::Mutex<()>>,
    cancel: CancellationToken,
}
struct Ticket {
    owner: String,
    session: String,
    until: Instant,
}
struct HerdrTicket {
    owner: String,
    session: String,
    source: String,
    terminal: String,
    target: herdr::Target,
    until: Instant,
}
struct Download {
    owner: String,
    terminal: String,
    session: std::sync::Weak<Session>,
    file: String,
    name: String,
    until: Instant,
    transfer: Option<String>,
}
pub struct App {
    pub config: Config,
    token: String,
    owners: Arc<Mutex<Pairings>>,
    vault: Arc<Vault>,
    sessions: tokio::sync::Mutex<HashMap<String, Terminal>>,
    openings: Mutex<HashMap<String, Opening>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    downloads: Mutex<HashMap<String, Download>>,
    herdr_tickets: Mutex<HashMap<String, HerdrTicket>>,
    herdr_targets: Mutex<HashMap<String, herdr::Target>>,
    herdr_connections: Mutex<HashMap<String, (String, CancellationToken)>>,
    herdr_capacity: Arc<tokio::sync::Semaphore>,
    ssh_probes: tokio::sync::Semaphore,
    herdr_terminals: herdr_terminal_stream::Hub,
    notifications: Arc<notifications::Notifications>,
    services: HostServices,
    commands: Vec<String>,
}
type Failure = (StatusCode, String);
fn fail(message: impl Into<String>) -> Failure {
    (StatusCode::BAD_REQUEST, message.into())
}
fn file_failure(error: files::Error) -> Failure {
    (
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        error.message,
    )
}
fn json_response(status: StatusCode, data: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Body::from(data.to_string()))
        .unwrap()
}
fn error(status: StatusCode, message: impl Into<String>) -> Response<Body> {
    json_response(status, json!({"error":message.into()}))
}
fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or("")
}
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (0.0..=9007199254740991.0).contains(&value)
}
fn session_id(value: Option<&Value>) -> Result<String, Failure> {
    if value.is_none_or(Value::is_null) || value.and_then(Value::as_str) == Some("default") {
        return Ok("default".into());
    }
    let id = value
        .and_then(Value::as_str)
        .ok_or_else(|| fail("Invalid terminal session."))?;
    if id.len() != 36
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    {
        return Err(fail("Invalid terminal session."));
    }
    Ok(id.into())
}
impl App {
    pub async fn new(config: Config) -> Result<Arc<Self>, String> {
        let token = pairing_token(
            &config.data_directory,
            std::env::var("TERMAI_TOKEN").ok().as_deref(),
        )
        .map_err(|e| e.to_string())?;
        let owners = Pairings::open(&config.data_directory, &token).map_err(|e| e.to_string())?;
        let owners = Arc::new(Mutex::new(owners));
        let registry = owners.clone();
        let contact = std::env::var("TERMAI_PUSH_CONTACT")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                format!(
                    "https://{}{}",
                    config
                        .allowed_hosts
                        .iter()
                        .find(|s| !["localhost", "127.0.0.1", "[::1]"].contains(&s.as_str()))
                        .map(String::as_str)
                        .unwrap_or("example.com"),
                    config.public_base
                )
            });
        let notifications = notifications::Notifications::open(
            &config.data_directory,
            Arc::new(move |hash| registry.lock().unwrap().has_digest(hash)),
            None,
            &contact,
        )?;
        let services = HostServices::new();
        let commands = services
            .catalog
            .executable_names(&std::env::vars().collect(), &CancellationToken::new())
            .await?;
        Ok(Arc::new(Self {
            vault: Arc::new(Vault::new(&config.data_directory)),
            config,
            token,
            owners,
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            openings: Mutex::new(HashMap::new()),
            tickets: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            herdr_tickets: Mutex::new(HashMap::new()),
            herdr_targets: Mutex::new(HashMap::new()),
            herdr_connections: Mutex::new(HashMap::new()),
            herdr_capacity: Arc::new(tokio::sync::Semaphore::new(64)),
            ssh_probes: tokio::sync::Semaphore::new(4),
            herdr_terminals: herdr_terminal_stream::Hub::default(),
            notifications,
            services,
            commands,
        }))
    }
    fn allowed(&self, headers: &HeaderMap) -> bool {
        headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .and_then(|host| url::Url::parse(&format!("http://{host}")).ok())
            .and_then(|u| u.host_str().map(str::to_owned))
            .is_some_and(|h| self.config.allowed_hosts.contains(&h))
    }
    fn same_origin(&self, headers: &HeaderMap) -> bool {
        let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
            return false;
        };
        let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
            return false;
        };
        url::Url::parse(origin).ok().is_some_and(|url| {
            let origin_host = url.host_str().unwrap_or("");
            let with_port = url
                .port()
                .map_or_else(|| origin_host.to_owned(), |p| format!("{origin_host}:{p}"));
            with_port == host || self.config.allowed_origins.contains(origin)
        })
    }
    fn owner(&self, headers: &HeaderMap) -> Option<String> {
        let valid = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .filter(|s| valid(s));
        let cookie = headers
            .get("cookie")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                s.split(';')
                    .find_map(|s| s.trim_start().strip_prefix("termai=").filter(|s| valid(s)))
            });
        bearer
            .or(cookie)
            .filter(|id| self.owners.lock().unwrap().has(id))
            .map(str::to_owned)
    }
    async fn reserve_session(
        &self,
        key: &str,
    ) -> Result<(tokio::sync::OwnedMutexGuard<()>, CancellationToken), Failure> {
        let (gate, cancel) = {
            let mut openings = self.openings.lock().unwrap();
            openings.retain(|_, opening| opening.gate.strong_count() > 0);
            if let Some(opening) = openings.get(key)
                && let Some(gate) = opening.gate.upgrade()
            {
                (gate, opening.cancel.clone())
            } else {
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                let cancel = CancellationToken::new();
                openings.insert(
                    key.into(),
                    Opening {
                        gate: Arc::downgrade(&gate),
                        cancel: cancel.clone(),
                    },
                );
                (gate, cancel)
            }
        };
        let guard = gate.lock_owned().await;
        let registry = self.sessions.lock().await;
        let pending = self
            .openings
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, opening)| {
                !registry.contains_key(*key) && opening.gate.strong_count() > 0
            })
            .count();
        if !registry.contains_key(key) && registry.len() + pending > 32 {
            return Err(fail("The session limit has been reached."));
        }
        if cancel.is_cancelled() {
            return Err(fail("Session ended."));
        }
        Ok((guard, cancel))
    }
    async fn get_session(
        &self,
        owner: &str,
        sid: &str,
        name: &str,
        files: bool,
    ) -> Result<Arc<Session>, Failure> {
        let key = format!("{owner}/{sid}");
        let (_opening, cancel) = self.reserve_session(&key).await?;
        let registry = self.sessions.lock().await;
        if let Some(terminal) = registry.get(&key) {
            return Ok(terminal.session.clone());
        }
        drop(registry);
        let cwd = std::env::var("TERMAI_CWD")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let session = Session::start(
            cwd,
            self.commands.clone(),
            self.config.engine.clone(),
            files,
            self.services.clone(),
        )
        .await
        .map_err(fail)?;
        if cancel.is_cancelled() || !self.owners.lock().unwrap().has(owner) {
            session.dispose().await;
            return Err(fail("Session ended."));
        }
        self.sessions.lock().await.insert(
            key,
            Terminal {
                session: session.clone(),
                id: sid.into(),
                name: name.into(),
            },
        );
        Ok(session)
    }
    async fn close_session(&self, owner: &str, sid: &str) {
        if let Some(opening) = self.openings.lock().unwrap().get(&format!("{owner}/{sid}")) {
            opening.cancel.cancel();
        }
        self.notifications.remove_source(owner, sid);
        let prefix = format!("{owner}/{sid}");
        self.herdr_connections
            .lock()
            .unwrap()
            .retain(|_, (key, cancel)| {
                if *key == prefix {
                    cancel.cancel();
                    false
                } else {
                    true
                }
            });
        self.herdr_targets
            .lock()
            .unwrap()
            .retain(|key, _| !key.starts_with(&format!("{prefix}/")));
        self.herdr_tickets
            .lock()
            .unwrap()
            .retain(|_, t| t.owner != owner || t.source != sid);
        let terminal = self.sessions.lock().await.remove(&format!("{owner}/{sid}"));
        if let Some(terminal) = terminal {
            terminal.session.dispose().await;
        }
    }
    async fn get_remote_session(
        &self,
        owner: &str,
        sid: &str,
        name: &str,
        input: &Value,
        system: Option<system_ssh::System>,
        files: bool,
    ) -> Result<Arc<Session>, ssh::Error> {
        let key = format!("{owner}/{sid}");
        let (_opening, cancel) = self
            .reserve_session(&key)
            .await
            .map_err(|(_, error)| ssh::Error::from(error))?;
        let registry = self.sessions.lock().await;
        if let Some(terminal) = registry.get(&key) {
            return Ok(terminal.session.clone());
        }
        drop(registry);
        let host = ssh::SSHHost::connect(input, self.vault.clone(), system, files, &cancel).await?;
        let session = Session::start_remote(
            host.clone(),
            self.config.engine.clone(),
            files,
            self.services.clone(),
        )
        .await;
        let session = match session {
            Ok(session) => session,
            Err(error) => {
                host.dispose().await;
                return Err(error.into());
            }
        };
        if cancel.is_cancelled() || !self.owners.lock().unwrap().has(owner) {
            session.dispose().await;
            return Err("Session ended.".to_owned().into());
        }
        self.sessions.lock().await.insert(
            key,
            Terminal {
                session: session.clone(),
                id: sid.into(),
                name: name.into(),
            },
        );
        Ok(session)
    }
    async fn download_ticket(
        &self,
        owner: &str,
        sid: &str,
        session: &Arc<Session>,
        input: &str,
        name: Option<&str>,
        transfer: Option<String>,
    ) -> Result<Value, Failure> {
        let home = session.home();
        let file = files::file_path(&session.state().cwd, &home, input).map_err(file_failure)?;
        let attrs = session
            .filesystem()
            .metadata(&file, true)
            .await
            .map_err(file_failure)?;
        if !attrs.is_file() {
            return Err(fail("Choose a regular file to download."));
        }
        let name = name
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| termai_engine::path::basename(&file));
        let mut downloads = self.downloads.lock().unwrap();
        downloads.retain(|_, d| {
            d.until >= Instant::now()
                && d.session.upgrade().is_some()
                && self.owners.lock().unwrap().has(&d.owner)
        });
        if downloads.len() >= 256 {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Too many pending downloads. Try again shortly.".into(),
            ));
        }
        let ticket = storage::random_hex(32);
        downloads.insert(
            ticket.clone(),
            Download {
                owner: owner.into(),
                terminal: format!("{owner}/{sid}"),
                session: Arc::downgrade(session),
                file,
                name: name.clone(),
                until: Instant::now() + Duration::from_secs(60),
                transfer,
            },
        );
        Ok(json!({"ticket":ticket,"name":name,"size":attrs.len()}))
    }
    async fn send_download(&self, ticket: &str) -> Result<Response<Body>, Failure> {
        let expired = || {
            (
                StatusCode::NOT_FOUND,
                "This download link has expired. Download the file again.".into(),
            )
        };
        let download = self
            .downloads
            .lock()
            .unwrap()
            .remove(ticket)
            .ok_or_else(expired)?;
        if download.until < Instant::now() || !self.owners.lock().unwrap().has(&download.owner) {
            return Err(expired());
        }
        let session = download.session.upgrade().ok_or_else(expired)?;
        if !self
            .sessions
            .lock()
            .await
            .get(&download.terminal)
            .is_some_and(|t| Arc::ptr_eq(&t.session, &session))
            || download
                .transfer
                .as_ref()
                .is_some_and(|id| session.transfer(id).is_none())
        {
            return Err(expired());
        }
        let attrs = session
            .filesystem()
            .metadata(&download.file, true)
            .await
            .map_err(file_failure)?;
        if !attrs.is_file() {
            return Err(fail("Choose a regular file to download."));
        }
        let file = session
            .filesystem()
            .open_read(&download.file)
            .await
            .map_err(file_failure)?;
        let stream = tokio_util::io::ReaderStream::new(file);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30 * 60);
        let stream = futures::stream::unfold(
            (stream, session, download.transfer, deadline),
            |(mut stream, session, transfer, deadline)| async move {
                match tokio::time::timeout_at(deadline, stream.next()).await {
                    Ok(Some(chunk)) => Some((chunk, (stream, session, transfer, deadline))),
                    Ok(None) => {
                        if let Some(id) = transfer {
                            session.remove_transfer(&id);
                        }
                        None
                    }
                    Err(_) => Some((
                        Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "Download timed out.",
                        )),
                        (stream, session, transfer, deadline),
                    )),
                }
            },
        );
        let encoded = download
            .name
            .as_bytes()
            .iter()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.!~".contains(b) {
                    (*b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>();
        Ok(Response::builder()
            .header("content-type", "application/octet-stream")
            .header("content-length", attrs.len())
            .header("cache-control", "no-store")
            .header(
                "content-disposition",
                format!("attachment; filename=\"download\"; filename*=UTF-8''{encoded}"),
            )
            .body(Body::from_stream(stream))
            .unwrap())
    }
    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .fallback(dispatch)
            .layer(middleware::from_fn_with_state(self.clone(), security))
            .with_state(self.clone())
    }
}
async fn security(State(app): State<Arc<App>>, req: Request<Body>, next: Next) -> Response<Body> {
    let origin = req
        .headers()
        .get("origin")
        .cloned()
        .filter(|_| app.same_origin(req.headers()));
    let mut response = if !app.allowed(req.headers()) {
        error(StatusCode::FORBIDDEN, "Hostname is not allowed.")
    } else if *req.method() == Method::OPTIONS {
        Response::builder()
            .status(if app.same_origin(req.headers()) {
                204
            } else {
                403
            })
            .body(Body::empty())
            .unwrap()
    } else {
        next.run(req).await
    };
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    if let Some(origin) = origin {
        headers.insert("access-control-allow-origin", origin);
        headers.append("vary", HeaderValue::from_static("Origin"));
        for (name, value) in [
            ("access-control-allow-credentials", "true"),
            (
                "access-control-allow-headers",
                "Content-Type, Authorization",
            ),
            ("access-control-allow-methods", "GET, POST, DELETE, OPTIONS"),
            ("access-control-allow-private-network", "true"),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}
async fn body(req: &mut Request<Body>, limit: usize) -> Result<Value, Failure> {
    if !req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.starts_with("application/json"))
    {
        return Err(fail("Expected JSON"));
    }
    let mut stream = std::mem::take(req.body_mut()).into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| fail("Request failed"))?;
        if bytes.len() + chunk.len() > limit.saturating_mul(4) {
            return Err(fail("Request too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let content = String::from_utf8_lossy(&bytes);
    if content.encode_utf16().count() > limit {
        return Err(fail("Request too large"));
    }
    let parsed: Value = serde_json::from_str(if content.is_empty() { "{}" } else { &content })
        .map_err(|_| fail("Invalid JSON"))?;
    if !parsed.is_object() {
        return Err(fail("Expected an object"));
    }
    Ok(parsed)
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel()
    }
}
async fn bounded<T>(
    work: impl AsyncFnOnce(&CancellationToken) -> Result<T, String>,
) -> Result<T, Failure> {
    let cancel = CancelOnDrop(CancellationToken::new());
    tokio::time::timeout(Duration::from_secs(5), work(&cancel.0))
        .await
        .map_err(|_| fail("The operation was aborted due to timeout"))?
        .map_err(fail)
}
async fn dispatch(State(app): State<Arc<App>>, req: Request<Body>) -> Response<Body> {
    match request(&app, req).await {
        Ok(response) => response,
        Err((status, message)) => error(status, message),
    }
}
async fn request(app: &Arc<App>, mut req: Request<Body>) -> Result<Response<Body>, Failure> {
    let uri = req.uri().to_string();
    let url =
        url::Url::parse(&format!("http://localhost{uri}")).map_err(|_| fail("Invalid URL"))?;
    let pathname = if app.config.base_path != "/" && url.path().starts_with(&app.config.public_base)
    {
        &url.path()[app.config.base_path.len()..]
    } else {
        url.path()
    };
    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let get = *req.method() == Method::GET;
    if app.config.base_path != "/" && url.path() == app.config.base_path {
        return Ok(Response::builder()
            .status(308)
            .header("location", &app.config.public_base)
            .body(Body::empty())
            .unwrap());
    }
    if pathname == "/ws" {
        return websocket(app, req, &query).await;
    }
    if pathname == "/herdr/ws" {
        return herdr_websocket(app, req, &query).await;
    }
    if pathname == "/healthz" && get {
        return Ok(json_response(
            StatusCode::OK,
            json!({"ok":true,"version":env!("CARGO_PKG_VERSION"),"commit":app.config.release.as_ref().and_then(|v| v["commit"].as_str()).or(option_env!("TERMAI_COMMIT")),"platform":if cfg!(target_os="macos"){"darwin"}else{std::env::consts::OS},"arch":if cfg!(target_arch="x86_64"){"x64"}else{std::env::consts::ARCH},"runtime":"rust","packaged":app.config.release.is_some() || option_env!("TERMAI_COMMIT").is_some()}),
        ));
    }
    if !pathname.starts_with("/api/") {
        if let Some(frontend) = &app.config.dev_frontend {
            return crate::dev::serve(
                frontend,
                &app.config.public_base,
                pathname,
                app.owner(req.headers()).is_some(),
                app.same_origin(req.headers()),
                req,
            )
            .await;
        }
        return Ok(assets::serve(
            &app.config.dist,
            &app.config.public_base,
            pathname,
            req.method(),
            req.headers(),
        )
        .await);
    }
    if !get && !app.same_origin(req.headers()) {
        return Err((StatusCode::FORBIDDEN, "Origin is not allowed.".into()));
    }
    if pathname == "/api/files/download" && get {
        return app
            .send_download(query.get("ticket").map(String::as_str).unwrap_or(""))
            .await;
    }
    let mut owner = app.owner(req.headers());
    let ok = |value| Ok(json_response(StatusCode::OK, value));
    if pathname == "/api/connect" && *req.method() == Method::POST {
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
                return Err((StatusCode::TOO_MANY_REQUESTS,"The saved pairing limit has been reached. Revoke old pairings before adding more.".into()));
            }
            owner = Some(registry.issue().map_err(|e| fail(e.to_string()))?);
        }
        let owner = owner.unwrap();
        let sid = session_id(input.get("session"))?;
        let result = if input["noSession"] == true {
            json!({"accessToken":owner})
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
            json!({"state":app.get_session(&owner,&sid,"Terminal",false).await?.state(),"accessToken":owner})
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
    let owner = owner.ok_or((
        StatusCode::UNAUTHORIZED,
        "Connect to your shell first.".into(),
    ))?;
    if pathname == "/api/notifications/key" && get {
        return ok(json!({"publicKey":app.notifications.public_key}));
    }
    if pathname.starts_with("/api/notifications/") && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        match pathname {
            "/api/notifications/subscribe" => {
                return ok(
                    json!({"device":app.notifications.subscribe(&owner,&input["subscription"]).map_err(fail)?}),
                );
            }
            "/api/notifications/unsubscribe" => app
                .notifications
                .unsubscribe(&owner, &input["device"])
                .map_err(fail)?,
            "/api/notifications/unwatch" => app
                .notifications
                .remove_view(&owner, &input["device"], &input["tabId"])
                .map_err(fail)?,
            _ => return Err((StatusCode::NOT_FOUND, "Not found".into())),
        }
        return ok(json!({"ok":true}));
    }
    if pathname.starts_with("/api/herdr/") {
        return herdr_request(app, &owner, pathname, &query, &mut req).await;
    }
    if pathname == "/api/ssh/probe" && *req.method() == Method::POST {
        let _permit = app.ssh_probes.try_acquire().map_err(|_| {
            (
                StatusCode::TOO_MANY_REQUESTS,
                "Route probes are busy. Try again.".into(),
            )
        })?;
        let input = body(&mut req, 16384).await?;
        return ok(
            json!({"milliseconds":ssh::route_probe(&input,&CancellationToken::new()).await.map_err(fail)?}),
        );
    }
    let sid = session_id(
        query
            .get("session")
            .map(|s| Value::String(s.clone()))
            .as_ref(),
    )?;
    let key = format!("{owner}/{sid}");
    if pathname == "/api/dictation" && get {
        return ok(dictation::detect(&std::env::vars().collect()).await);
    }
    if pathname == "/api/ping" && get {
        return ok(json!({"ok":true}));
    }
    if pathname == "/api/keychain" {
        let vault = app.vault.clone();
        let input = if get {
            None
        } else {
            Some(body(&mut req, 16384).await?)
        };
        let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
            let result = || -> std::io::Result<Value> {
                if let Some(input) = input {
                    match text(&input, "action") {
                        "delete" if input["id"].is_string() => vault.remove(text(&input, "id"))?,
                        "rename" if input["id"].is_string() && input["name"].is_string() => {
                            vault.rename(text(&input, "id"), text(&input, "name"))?
                        }
                        "forget" => {
                            let address = system_ssh::address(&json!({"host":input["host"],"port":input.get("port"),"username":"unused"})).map_err(std::io::Error::other)?;
                            vault.forget(&address.host,address.port)?;
                        },
                        "inspect" => {
                            return Ok(serde_json::to_value(inspect_private_key(
                                text(&input, "privateKey"),
                                text(&input, "passphrase"),
                            )?)?);
                        }
                        "create" | "backup" => {
                            return Ok(serde_json::to_value(vault.create(
                                text(&input, "name"),
                                text(&input, "passphrase"),
                                input["privateKey"].as_str(),
                                if input["action"] == "backup" {
                                    input["replaceId"].as_str()
                                } else {
                                    None
                                },
                            )?)?);
                        }
                        "export" if input["id"].is_string() => {
                            let raw =
                                vault.unlock(text(&input, "id"), text(&input, "passphrase"))?;
                            let mut info = serde_json::to_value(
                                vault
                                    .list()?
                                    .keys
                                    .into_iter()
                                    .find(|k| k.id == text(&input, "id"))
                                    .ok_or_else(|| std::io::Error::other("SSH key not found."))?,
                            )?;
                            info["privateKey"] = json!(String::from_utf8_lossy(&raw));
                            return Ok(info);
                        }
                        _ => return Err(std::io::Error::other("Unknown keychain action.")),
                    }
                }
                Ok(serde_json::to_value(vault.list()?)?)
            };
            result().map_err(|e| e.to_string())
        })
        .await
        .map_err(|_| fail("Vault operation failed."))?
        .map_err(fail)?;
        return ok(result);
    }
    if pathname == "/api/sessions" && get {
        let sessions = app.sessions.lock().await;
        return ok(json!(sessions.iter().filter(|(key,_)|key.starts_with(&format!("{owner}/"))).map(|(_,t)|json!({"id":t.id,"name":t.name,"kind":if t.session.remote.is_some(){"ssh"}else{"http"},"state":t.session.state()})).collect::<Vec<_>>()));
    }
    if pathname == "/api/sessions" && *req.method() == Method::POST {
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
    if pathname == "/api/sessions/close" && *req.method() == Method::POST {
        app.close_session(&owner, &sid).await;
        return ok(json!({"ok":true}));
    }
    if pathname == "/api/ticket" && *req.method() == Method::POST {
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
        return ok(json!({"ticket":ticket}));
    }
    if sid != "default" && !app.sessions.lock().await.contains_key(&key) {
        return Err((StatusCode::NOT_FOUND, "Terminal not found.".into()));
    }
    let session = app.get_session(&owner, &sid, "Terminal", false).await?;
    let cwd = session.state().cwd;
    let home = session.home();
    if pathname == "/api/plugins/read" && get {
        let path = query.get("path").ok_or_else(|| fail("Select a file."))?;
        let file = reading::read(&cwd, &home, path)
            .await
            .map_err(file_failure)?;
        let text = std::str::from_utf8(&file.data)
            .ok()
            .filter(|t| !t.contains('\0'))
            .ok_or_else(|| fail("This plugin can read only UTF-8 text files."))?;
        let units = text.encode_utf16().collect::<Vec<_>>();
        let text = String::from_utf16_lossy(&units[units.len().saturating_sub(256 * 1024)..]);
        return ok(json!({"path":file.path,"text":text,"truncated":units.len()>256*1024}));
    }
    if pathname == "/api/files/list" && get {
        return ok(serde_json::to_value(
            files::list_files_on(
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
            .map_err(file_failure)?,
        )
        .unwrap());
    }
    if pathname == "/api/files/mkdir" && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        if !input["name"].is_string() || !input["path"].is_string() {
            return Err(fail("Enter a folder name."));
        }
        return ok(files::make_directory_on(
            &session.filesystem(),
            &cwd,
            &home,
            text(&input, "path"),
            text(&input, "name"),
        )
        .await
        .map_err(file_failure)?);
    }
    if pathname == "/api/files/action" && *req.method() == Method::POST {
        let input = body(&mut req, 256 * 1024).await?;
        return ok(files::action_on(&session.filesystem(), &cwd, &home, &input)
            .await
            .map_err(file_failure)?);
    }
    if pathname == "/api/files/upload" && *req.method() == Method::POST {
        let length = req
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let payload = std::mem::take(req.body_mut());
        return ok(files::upload_on(
            &session.filesystem(),
            &cwd,
            &home,
            query
                .get("path")
                .filter(|s| !s.is_empty())
                .map(String::as_str)
                .unwrap_or("."),
            query.get("name").map(String::as_str).unwrap_or(""),
            payload,
            length.as_deref(),
        )
        .await
        .map_err(file_failure)?);
    }
    if pathname == "/api/files/download" && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        return ok(app
            .download_ticket(&owner, &sid, &session, text(&input, "path"), None, None)
            .await?);
    }
    if pathname == "/api/files/transfer" && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        let transfer = session.transfer(text(&input, "id")).ok_or((
            StatusCode::NOT_FOUND,
            "This transfer request expired. Run the command again.".into(),
        ))?;
        if input["action"] == "ack" {
            session.acknowledge_transfer(&transfer.id);
            return ok(json!({"ok":true}));
        }
        if input["action"] != "download" || transfer.action != "download" {
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
        return ok(ticket);
    }
    if session.files_only {
        return Err(fail("Open a terminal tab for shell actions."));
    }
    if pathname == "/api/dictation/install" && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        let command = dictation::install_command(&std::env::vars().collect())
            .await
            .map_err(fail)?;
        let number = |field| {
            input[field]
                .as_f64()
                .filter(|n| safe_integer(*n))
                .map(|n| n as u64)
        };
        if !number("prompt")
            .zip(number("revision"))
            .is_some_and(|(prompt, revision)| session.paste(&command, prompt, revision, true, None))
        {
            return Err(fail(
                "The terminal changed. Return to the shell prompt and try again.",
            ));
        }
        return ok(json!({"ok":true}));
    }
    if pathname == "/api/reading/capture" {
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
    }
    if pathname == "/api/reading/file" && get {
        let path = query
            .get("path")
            .ok_or_else(|| fail("Enter a file path."))?;
        let file = session.read_file(&cwd, path).await.map_err(file_failure)?;
        return Ok(binary_response(file.mime, file.data));
    }
    if pathname == "/api/ssh/captured" && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        let id = text(&input, "id");
        if input["action"] == "ack" {
            session.acknowledge_capture(id);
            return ok(json!({"ok":true}));
        }
        if let Some(result) = session.capture_result(id) {
            return ok(result);
        }
        if input["action"] == "cancel" || input["action"] == "native" {
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
                .release_capture(id, input["action"] == "native", None)
                .map_err(fail)?;
            return ok(json!({"native":input["action"] == "native"}));
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
            input["passphrase"].as_str(),
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
        let input = json!({"host":system.address.host,"port":system.address.port,"username":system.address.username,"trust":input.get("trust")});
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
        return ok(result);
    }
    if pathname == "/api/context" && get {
        return ok(
            serde_json::to_value(session.snapshot(true).await.map_err(fail)?.0)
                .map_err(|e| fail(e.to_string()))?,
        );
    }
    if pathname == "/api/suggest" && *req.method() == Method::POST {
        if session.engine_mode != "server" {
            return Err((
                StatusCode::CONFLICT,
                "This connection computes suggestions in the client.".into(),
            ));
        }
        let input = body(&mut req, 16384).await?;
        let text = input["text"]
            .as_str()
            .filter(|t| t.encode_utf16().count() <= 2000)
            .ok_or((
                StatusCode::BAD_REQUEST,
                "Keep a command under 2,000 characters.".into(),
            ))?;
        return ok(bounded(async |cancel| session.suggest(text, cancel).await).await?);
    }
    if pathname == "/api/facts" && *req.method() == Method::POST {
        let input = body(&mut req, 16384).await?;
        return ok(bounded(async |cancel| {
            if input["kind"] == "context" {
                session
                    .context(input["known"].as_str(), input["paths"] != false)
                    .await
            } else if input["kind"] == "repair" {
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
    if pathname == "/api/new" && *req.method() == Method::POST {
        if session.remote.is_some() {
            return Err(fail(
                "Open the saved SSH host again to start another shell.",
            ));
        }
        app.close_session(&owner, &sid).await;
        return ok(json!({"state":app.get_session(&owner,&sid,"Terminal",false).await?.state()}));
    }
    Err((StatusCode::NOT_FOUND, "Not found".into()))
}
fn ssh_error(error: ssh::Error) -> Response<Body> {
    json_response(
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        error.value(),
    )
}
fn binary_response(mime: &str, data: Vec<u8>) -> Response<Body> {
    Response::builder()
        .header("content-type", mime)
        .header("content-length", data.len())
        .header("cache-control", "no-store")
        .header("content-disposition", "attachment")
        .body(Body::from(data))
        .unwrap()
}
async fn herdr_request(
    app: &Arc<App>,
    owner: &str,
    path: &str,
    query: &HashMap<String, String>,
    req: &mut Request<Body>,
) -> Result<Response<Body>, Failure> {
    let session_name =
        herdr::session(query.get("herdrSession").map(|s| json!(s)).as_ref()).map_err(fail)?;
    let get = *req.method() == Method::GET;
    let ok = |value| Ok(json_response(StatusCode::OK, value));
    if path == "/api/herdr/connect" && *req.method() == Method::POST {
        let input = body(req, 16384).await?;
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
        return ok(json!({"herdrSession":session_name,"herdrSource":sid}));
    }
    if path == "/api/herdr/captured" && *req.method() == Method::POST {
        let sid = session_id(query.get("session").map(|s| json!(s)).as_ref())?;
        let source = app
            .sessions
            .lock()
            .await
            .get(&format!("{owner}/{sid}"))
            .map(|t| t.session.clone())
            .ok_or_else(|| fail("The source terminal has ended."))?;
        let input = body(req, 16384).await?;
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
        return ok(result);
    }
    let source = query
        .get("herdrSource")
        .filter(|s| !s.is_empty())
        .map(String::as_str)
        .unwrap_or("");
    let target = if source.is_empty() {
        app.herdr_targets
            .lock()
            .unwrap()
            .get(&format!("{owner}//{session_name}"))
            .cloned()
            .unwrap_or(herdr::Target::local(&session_name).map_err(fail)?)
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
    if path == "/api/herdr/notifications" && *req.method() == Method::POST {
        let input = body(req, 16384).await?;
        app.notifications
            .add_view(owner, &input["device"], &input["tabId"], source, &target)
            .map_err(fail)?;
        return ok(json!({"ok":true}));
    }
    if path == "/api/herdr/snapshot" && get {
        return ok(target.snapshot().await.map_err(fail)?);
    }
    if path == "/api/herdr/options" && get {
        return ok(target.options().await.map_err(fail)?);
    }
    if path == "/api/herdr/action" && *req.method() == Method::POST {
        return ok(target
            .action(&body(req, 65536).await?)
            .await
            .map_err(fail)?);
    }
    if path == "/api/herdr/ticket" && *req.method() == Method::POST {
        let terminal = query.get("terminalId").cloned().unwrap_or_default();
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
                owner: owner.into(),
                session: session_name,
                source: source.into(),
                terminal,
                target,
                until: Instant::now() + Duration::from_secs(15),
            },
        );
        return ok(json!({"ticket":ticket}));
    }
    Err((StatusCode::NOT_FOUND, "Not found".into()))
}
async fn herdr_websocket(
    app: &Arc<App>,
    req: Request<Body>,
    query: &HashMap<String, String>,
) -> Result<Response<Body>, Failure> {
    let denied = || (StatusCode::FORBIDDEN, "Forbidden".into());
    let session_name = herdr::session(query.get("herdrSession").map(|s| json!(s)).as_ref())
        .map_err(|_| denied())?;
    let ticket = query
        .get("ticket")
        .and_then(|s| app.herdr_tickets.lock().unwrap().remove(s))
        .ok_or_else(denied)?;
    let source = query.get("herdrSource").map(String::as_str).unwrap_or("");
    let terminal = query.get("terminalId").map(String::as_str).unwrap_or("");
    if !app.same_origin(req.headers())
        || ticket.until <= Instant::now()
        || ticket.session != session_name
        || ticket.source != source
        || ticket.terminal != terminal
        || !app.owners.lock().unwrap().has(&ticket.owner)
        || (!source.is_empty()
            && !app
                .sessions
                .lock()
                .await
                .contains_key(&format!("{}/{source}", ticket.owner)))
    {
        return Err(denied());
    }
    let permit = app
        .herdr_capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| denied())?;
    let (mut parts, _) = req.into_parts();
    let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &())
        .await
        .map_err(|_| denied())?;
    let app = app.clone();
    Ok(upgrade
        .max_message_size(128 * 1024)
        .max_frame_size(128 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let id = storage::random_hex(16);
            let cancel = CancellationToken::new();
            app.herdr_connections.lock().unwrap().insert(
                id.clone(),
                (
                    format!("{}/{}", ticket.owner, ticket.source),
                    cancel.clone(),
                ),
            );
            herdr_socket_session(socket, &app, ticket, cancel.clone(), &id).await;
            cancel.cancel();
            app.herdr_connections.lock().unwrap().remove(&id);
            app.notifications.disconnected(&id);
        })
        .into_response())
}
async fn herdr_socket_session(
    socket: WebSocket,
    app: &Arc<App>,
    ticket: HerdrTicket,
    cancel: CancellationToken,
    id: &str,
) {
    let (send, mut output, slow) = crate::viewer_queue::channel();
    let notification_target = ticket.target.clone();
    let view = if ticket.terminal.is_empty() {
        let (metadata, mut receive) = tokio::sync::mpsc::channel(16);
        let target = ticket.target.clone();
        let lifetime = cancel.clone();
        tokio::spawn(herdr::metadata(target, metadata, lifetime.clone()));
        let send = send.clone();
        tokio::spawn(async move {
            loop {
                let message = tokio::select! {biased;_=lifetime.cancelled()=>break,message=receive.recv()=>message};
                let Some(message) = message else { break };
                if !send.send(Transport::Message(message)) {
                    break;
                }
            }
        });
        None
    } else {
        let snapshot = tokio::select! {biased;_=cancel.cancelled()=>return,snapshot=ticket.target.snapshot()=>snapshot};
        let agent = snapshot.ok().and_then(|snapshot| {
            snapshot["terminals"]
                .as_array()
                .and_then(|a| a.iter().find(|a| a["terminalId"] == ticket.terminal))
                .cloned()
        });
        let Some(agent) = agent else {
            let mut socket = socket;
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "Agent ended".into(),
                })))
                .await;
            return;
        };
        match herdr_view::View::open(
            ticket.target,
            agent,
            &app.herdr_terminals,
            send,
            cancel.clone(),
        ) {
            Ok(view) => Some(view),
            Err(_) => return,
        }
    };
    let (mut send, mut receive) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut alive = true;
    loop {
        tokio::select! {
            biased;
            _=slow.cancelled()=>{let _=tokio::time::timeout(Duration::from_secs(1),send.send(Message::Close(Some(CloseFrame{code:1013,reason:"Viewer is too slow; reconnect for a fresh screen.".into()})))).await;break;},
            _=cancel.cancelled()=>{let _=send.send(Message::Close(Some(CloseFrame{code:1000,reason:"Connection closed".into()}))).await;break;},
            item=output.recv()=>match item {
                Some(item)=>match &item.message {
                    Transport::Message(message)=>{if !matches!(tokio::time::timeout(Duration::from_secs(5),send.send(Message::Text(message.to_string().into()))).await,Ok(Ok(()))){break;}},
                    Transport::Close(code,reason)=>{let _=send.send(Message::Close(Some(CloseFrame{code:*code,reason:reason.clone().into()}))).await;break;},
                },
                None=>break,
            },
            _=heartbeat.tick(),if view.is_some()=>{
                if !alive{break;}alive=false;if send.send(Message::Ping(Vec::new().into())).await.is_err(){break;}
            },
            message=receive.next()=>match message{
                Some(Ok(Message::Text(bytes)))=>if let Some(view)=&view{
                    if serde_json::from_str::<Value>(&bytes).map_err(|_|"Invalid terminal message".to_owned()).and_then(|message|view.receive(message)).is_err(){
                        let _=send.send(Message::Close(Some(CloseFrame{code:1008,reason:"Invalid terminal message".into()}))).await;break;
                    }
                } else if bytes.len()<=2048 && let Ok(message)=serde_json::from_str::<Value>(&bytes) {
                    if message["type"]=="notification-presence" && let Some(focused)=message["focused"].as_bool(){
                        let _=app.notifications.presence(id,&ticket.owner,&message["device"],focused);
                    } else if message["type"]=="notification-ack" {
                        let _=app.notifications.acknowledge(&ticket.owner,&message["device"],&ticket.source,&notification_target,&message["event"]);
                    }
                },
                Some(Ok(Message::Binary(bytes)))=>if let Some(view)=&view{view.audio(bytes.to_vec());},
                Some(Ok(Message::Ping(bytes)))=>if send.send(Message::Pong(bytes)).await.is_err(){break;},
                Some(Ok(Message::Pong(_)))=>alive=true,
                _=>break,
            }
        }
    }
    cancel.cancel();
    drop(view);
}
async fn websocket(
    app: &Arc<App>,
    req: Request<Body>,
    query: &HashMap<String, String>,
) -> Result<Response<Body>, Failure> {
    let denied = || (StatusCode::FORBIDDEN, "Forbidden".into());
    if !app.same_origin(req.headers()) {
        return Err(denied());
    }
    let sid = session_id(
        query
            .get("session")
            .map(|s| Value::String(s.clone()))
            .as_ref(),
    )?;
    let owner = {
        let tickets = app.tickets.lock().unwrap();
        query
            .get("ticket")
            .and_then(|ticket| tickets.get(ticket))
            .filter(|t| t.until > Instant::now() && t.session == sid)
            .map(|t| t.owner.clone())
            .or_else(|| app.owner(req.headers()))
            .ok_or_else(denied)?
    };
    let session = app
        .sessions
        .lock()
        .await
        .get(&format!("{owner}/{sid}"))
        .map(|t| t.session.clone())
        .filter(|s| !s.files_only)
        .ok_or_else(denied)?;
    let after = query
        .get("after")
        .filter(|s| !s.is_empty())
        .map_or(Ok(0.0), |s| s.trim().parse::<f64>())
        .map_err(|_| denied())?;
    if !safe_integer(after) {
        return Err(denied());
    }
    let (mut parts, _) = req.into_parts();
    let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &())
        .await
        .map_err(|_| denied())?;
    if let Some(ticket) = query.get("ticket") {
        app.tickets.lock().unwrap().remove(ticket);
    }
    let stream = query.get("stream").cloned();
    Ok(upgrade
        .max_message_size(128 * 1024)
        .max_frame_size(128 * 1024)
        .on_upgrade(move |socket| socket_session(socket, session, after as u64, stream))
        .into_response())
}
async fn socket_session(
    socket: WebSocket,
    session: Arc<Session>,
    after: u64,
    stream: Option<String>,
) {
    let (id, mut output) = session.attach(after, stream.as_deref());
    let (mut send, mut receive) = socket.split();
    loop {
        tokio::select! {
            biased;
            event=output.recv()=>match event {
                Some(Transport::Message(value))=>if send.send(Message::Text(value.to_string().into())).await.is_err(){break},
                Some(Transport::Close(code,reason))=>{let _=send.send(Message::Close(Some(CloseFrame{code,reason:reason.into()}))).await;break},
                None=>break,
            },
            event=receive.next()=>match event {
                Some(Ok(Message::Text(value)))=>match serde_json::from_str::<Value>(&value) { Ok(message)=>session.receive(id,message),Err(_)=>{let _=send.send(Message::Close(Some(CloseFrame{code:1008,reason:"Invalid message".into()}))).await;break} },
                Some(Ok(Message::Ping(bytes)))=>if send.send(Message::Pong(bytes)).await.is_err(){break},
                Some(Ok(Message::Binary(bytes)))=>session.receive_binary(id,bytes.to_vec()),
                Some(Ok(Message::Pong(_)))=>{},
                _=>break,
            }
        }
    }
    session.detach(id);
}
pub async fn run() -> Result<(), String> {
    let app = App::new(Config::from_env()?).await?;
    let listener = tokio::net::TcpListener::bind((app.config.host.as_str(), app.config.port))
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "termai → http://{}:{}{} (Rust, Ghostty)",
        app.config.host, app.config.port, app.config.public_base
    );
    println!("Pairing token: {}", app.token);
    let cleanup = app.clone();
    let lifetime = CancellationToken::new();
    let maintenance = lifetime.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! { biased;_=maintenance.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(60))=>{} }
            let expired = cleanup
                .sessions
                .lock()
                .await
                .iter()
                .filter(|(_, t)| t.session.mark_expired())
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            for key in expired {
                if let Some((owner, sid)) = key.split_once('/') {
                    cleanup.close_session(owner, sid).await;
                }
            }
        }
    });
    axum::serve(listener, app.router())
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! { _=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            lifetime.cancel();
            for opening in app.openings.lock().unwrap().values() {
                opening.cancel.cancel();
            }
            app.notifications.dispose();
            for (_, (_, cancel)) in app.herdr_connections.lock().unwrap().drain() {
                cancel.cancel();
            }
            let terminals = std::mem::take(&mut *app.sessions.lock().await);
            for (_, terminal) in terminals {
                terminal.session.dispose().await;
            }
        })
        .await
        .map_err(|e| e.to_string())
}
