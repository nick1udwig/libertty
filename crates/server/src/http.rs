use libertty_engine::utf16_len;
mod idempotency;
mod routes;
mod socket;
use crate::{
    assets, dictation, files, herdr, herdr_terminal_stream, herdr_view,
    host::HostServices,
    notifications,
    pairing::{Pairings, pairing_token, token_matches},
    reading,
    session::{Session, Transport},
    ssh, storage, system_ssh,
    vault::{Vault, inspect_private_key},
    wire,
};
use axum::{
    Router,
    body::{Body, HttpBody},
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
            setting("LIBERTTY_BASE_PATH", "")
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
            return Err("Invalid LIBERTTY_BASE_PATH.".into());
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
            "LIBERTTY_ALLOWED_HOSTS",
            if loopback {
                "localhost,127.0.0.1,[::1]"
            } else {
                ""
            },
        );
        if !loopback && allowed_hosts.is_empty() {
            return Err("Set LIBERTTY_ALLOWED_HOSTS to the hostname(s) used by your phone.".into());
        }
        let home = setting("HOME", ".");
        let data_directory = PathBuf::from(setting(
            "LIBERTTY_DATA_DIR",
            &PathBuf::from(&home)
                .join(".local/share/libertty")
                .to_string_lossy(),
        ));
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let packaged = crate::release::packaged_root().map(|root| root.join("dist"));
        let dist = std::env::var_os("LIBERTTY_DIST_DIR")
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
            allowed_hosts,
            allowed_origins: set("LIBERTTY_ALLOWED_ORIGINS", ""),
            release: crate::release::metadata(),
            dev_frontend: if setting("NODE_ENV", "production") == "development" {
                std::env::var("LIBERTTY_DEV_FRONTEND")
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
    size: Option<herdr_terminal_stream::Size>,
    owner: String,
    session: String,
    source: String,
    terminal: String,
    target: herdr::Target,
    until: Instant,
}
#[derive(Clone)]
struct Download {
    owner: String,
    terminal: SessionKey,
    session: std::sync::Weak<Session>,
    file: String,
    name: String,
    until: Instant,
    transfer: Option<String>,
    /// The file's size and modification time when the ticket was issued, so a resume never splices two versions.
    version: (u64, f64),
    started: bool,
}
/// Retires a download once its last byte leaves, because a sized body ends without polling for its end.
struct DownloadProgress {
    app: Arc<App>,
    ticket: String,
    session: Arc<Session>,
    transfer: Option<String>,
    remaining: u64,
}
impl DownloadProgress {
    fn sent(&mut self, bytes: usize) {
        self.remaining = self.remaining.saturating_sub(bytes as u64);
        if self.remaining == 0 {
            if let Some(id) = self.transfer.take() {
                self.session.remove_transfer(&id);
            }
            self.app.downloads.lock().unwrap().remove(&self.ticket);
        }
    }
}
pub struct App {
    pub config: Config,
    token: String,
    owners: Arc<Mutex<Pairings>>,
    vault: Arc<Vault>,
    sessions: tokio::sync::Mutex<HashMap<SessionKey, Terminal>>,
    openings: Mutex<HashMap<SessionKey, Opening>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    downloads: Mutex<HashMap<String, Download>>,
    herdr_tickets: Mutex<HashMap<String, HerdrTicket>>,
    herdr_targets: Mutex<HashMap<HerdrKey, herdr::Target>>,
    herdr_readings: Mutex<HashMap<HerdrKey, crate::reading::Captures>>,
    herdr_reading_capacity: tokio::sync::Semaphore,
    herdr_connections: Mutex<HashMap<String, (SessionKey, CancellationToken)>>,
    herdr_capacity: Arc<tokio::sync::Semaphore>,
    ssh_probes: tokio::sync::Semaphore,
    herdr_terminals: herdr_terminal_stream::Hub,
    herdr_inputs: herdr_view::Ledgers,
    replies: idempotency::Replies,
    uploads: crate::uploads::Uploads,
    herdr_polls: crate::herdr_poll::Polls,
    notifications: Arc<notifications::Notifications>,
    services: HostServices,
    commands: Vec<String>,
}
/// The paired owner and terminal id that scope a session and its Herdr connections.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SessionKey {
    owner: String,
    sid: String,
}
impl SessionKey {
    fn new(owner: &str, sid: &str) -> Self {
        Self {
            owner: owner.into(),
            sid: sid.into(),
        }
    }
}
/// A Herdr session reached through a source terminal, or directly when the source id is empty.
type HerdrKey = (SessionKey, String);
/// An HTTP error status with the message its JSON body reports.
struct Failure(StatusCode, String);
impl IntoResponse for Failure {
    fn into_response(self) -> Response<Body> {
        error(self.0, self.1)
    }
}
fn fail(message: impl Into<String>) -> Failure {
    Failure(StatusCode::BAD_REQUEST, message.into())
}
fn file_failure(error: files::Error) -> Failure {
    Failure(
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
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (0.0..=9007199254740991.0).contains(&value)
}
fn session_id(value: Option<&Value>) -> Result<String, Failure> {
    if value.is_none_or(Value::is_null) {
        return session_id_text(None);
    }
    session_id_text(Some(
        value
            .and_then(Value::as_str)
            .ok_or_else(|| fail("Invalid terminal session."))?,
    ))
}
fn session_id_text(value: Option<&str>) -> Result<String, Failure> {
    let Some(id) = value.filter(|id| *id != "default") else {
        return Ok("default".into());
    };
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    {
        return Err(fail("Invalid terminal session."));
    }
    Ok(id.into())
}
impl App {
    pub async fn new(config: Config) -> Result<Arc<Self>, String> {
        let token = pairing_token(
            &config.data_directory,
            std::env::var("LIBERTTY_TOKEN").ok().as_deref(),
        )
        .map_err(|e| e.to_string())?;
        let owners = Pairings::open(&config.data_directory, &token).map_err(|e| e.to_string())?;
        let owners = Arc::new(Mutex::new(owners));
        let registry = owners.clone();
        let contact = std::env::var("LIBERTTY_PUSH_CONTACT")
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
            herdr_readings: Mutex::new(HashMap::new()),
            herdr_reading_capacity: tokio::sync::Semaphore::new(2),
            herdr_connections: Mutex::new(HashMap::new()),
            herdr_capacity: Arc::new(tokio::sync::Semaphore::new(64)),
            ssh_probes: tokio::sync::Semaphore::new(4),
            herdr_terminals: herdr_terminal_stream::Hub::default(),
            herdr_inputs: Default::default(),
            replies: Default::default(),
            uploads: Default::default(),
            herdr_polls: crate::herdr_poll::Polls::default(),
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
                s.split(';').find_map(|s| {
                    let cookie = s.trim_start();
                    cookie.strip_prefix("libertty=").filter(|s| valid(s))
                })
            });
        bearer
            .or(cookie)
            .filter(|id| self.owners.lock().unwrap().has(id))
            .map(str::to_owned)
    }
    async fn reserve_session(
        &self,
        key: &SessionKey,
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
                    key.clone(),
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
        let key = SessionKey::new(owner, sid);
        let (_opening, cancel) = self.reserve_session(&key).await?;
        let registry = self.sessions.lock().await;
        if let Some(terminal) = registry.get(&key) {
            return Ok(terminal.session.clone());
        }
        drop(registry);
        let cwd = std::env::var("LIBERTTY_CWD")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let session = Session::start(cwd, self.commands.clone(), files, self.services.clone())
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
        let key = SessionKey::new(owner, sid);
        if let Some(opening) = self.openings.lock().unwrap().get(&key) {
            opening.cancel.cancel();
        }
        self.notifications.remove_source(owner, sid);
        self.herdr_connections
            .lock()
            .unwrap()
            .retain(|_, (source, cancel)| {
                if *source == key {
                    cancel.cancel();
                    false
                } else {
                    true
                }
            });
        self.herdr_targets
            .lock()
            .unwrap()
            .retain(|(source, _), _| *source != key);
        self.herdr_readings
            .lock()
            .unwrap()
            .retain(|(source, _), _| *source != key);
        self.herdr_tickets
            .lock()
            .unwrap()
            .retain(|_, t| t.owner != owner || t.source != sid);
        let terminal = self.sessions.lock().await.remove(&key);
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
        let key = SessionKey::new(owner, sid);
        let (_opening, cancel) = self
            .reserve_session(&key)
            .await
            .map_err(|Failure(_, error)| ssh::Error::from(error))?;
        let registry = self.sessions.lock().await;
        if let Some(terminal) = registry.get(&key) {
            return Ok(terminal.session.clone());
        }
        drop(registry);
        let host = ssh::SSHHost::connect(input, self.vault.clone(), system, files, &cancel).await?;
        let session = Session::start_remote(host.clone(), files, self.services.clone()).await;
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
            .unwrap_or_else(|| libertty_engine::path::basename(&file));
        let mut downloads = self.downloads.lock().unwrap();
        downloads.retain(|_, d| {
            d.until >= Instant::now()
                && d.session.upgrade().is_some()
                && self.owners.lock().unwrap().has(&d.owner)
        });
        if downloads.len() >= 256 {
            return Err(Failure(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many pending downloads. Try again shortly.".into(),
            ));
        }
        let ticket = storage::random_hex(32);
        downloads.insert(
            ticket.clone(),
            Download {
                owner: owner.into(),
                terminal: SessionKey::new(owner, sid),
                session: Arc::downgrade(session),
                file,
                name: name.clone(),
                until: Instant::now() + Duration::from_secs(60),
                transfer,
                version: attrs.version(),
                started: false,
            },
        );
        Ok(json!({"ticket":ticket,"name":name,"size":attrs.len()}))
    }
    /// Stream a download, resuming from `offset` after an interruption; the ticket retires once a request reaches the end.
    async fn send_download(
        self: &Arc<Self>,
        ticket: &str,
        offset: u64,
    ) -> Result<Response<Body>, Failure> {
        let expired = || {
            Failure(
                StatusCode::NOT_FOUND,
                "This download link has expired. Download the file again.".into(),
            )
        };
        let download = {
            let mut downloads = self.downloads.lock().unwrap();
            let download = downloads.get_mut(ticket).ok_or_else(expired)?;
            if download.until < Instant::now() || !self.owners.lock().unwrap().has(&download.owner)
            {
                downloads.remove(ticket);
                return Err(expired());
            }
            // A started download may resume for as long as one attempt may last.
            if !download.started {
                download.started = true;
                download.until = Instant::now() + Duration::from_secs(30 * 60);
            }
            download.clone()
        };
        let retire = || {
            self.downloads.lock().unwrap().remove(ticket);
        };
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
            retire();
            return Err(fail("Choose a regular file to download."));
        }
        if attrs.version() != download.version {
            retire();
            return Err(Failure(
                StatusCode::CONFLICT,
                "The file changed during the download. Download it again.".into(),
            ));
        }
        let size = attrs.len();
        if offset > 0 && offset >= size {
            return Err(Failure(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "The download is already complete.".into(),
            ));
        }
        let file = session
            .filesystem()
            .open_read_at(&download.file, offset)
            .await
            .map_err(file_failure)?;
        let stream = tokio_util::io::ReaderStream::new(file);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30 * 60);
        let mut progress = DownloadProgress {
            app: self.clone(),
            ticket: ticket.to_owned(),
            session,
            transfer: download.transfer,
            remaining: size - offset,
        };
        progress.sent(0);
        let stream = futures::stream::unfold(
            (stream, deadline, progress),
            |(mut stream, deadline, mut progress)| async move {
                match tokio::time::timeout_at(deadline, stream.next()).await {
                    Ok(Some(chunk)) => {
                        if let Ok(bytes) = &chunk {
                            progress.sent(bytes.len());
                        }
                        Some((chunk, (stream, deadline, progress)))
                    }
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "Download timed out.",
                        )),
                        (stream, deadline, progress),
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
        let mut response = Response::builder()
            .header("content-type", "application/octet-stream")
            .header("content-length", size - offset)
            .header("accept-ranges", "bytes");
        if offset > 0 {
            response = response.status(StatusCode::PARTIAL_CONTENT).header(
                "content-range",
                format!("bytes {offset}-{}/{size}", size - 1),
            );
        }
        Ok(response
            .header("cache-control", "no-store")
            .header(
                "content-disposition",
                format!("attachment; filename=\"download\"; filename*=UTF-8''{encoded}"),
            )
            .body(Body::from_stream(stream))
            .unwrap())
    }
    pub fn router(self: &Arc<Self>) -> Router {
        let api = routes::router();
        let router = if self.config.base_path == "/" {
            api.fallback(static_request)
        } else {
            // The fallback also accepts proxies that strip the public mount prefix.
            Router::new()
                .nest(&self.config.base_path, api.clone())
                .fallback_service(api.fallback(static_request).with_state(self.clone()))
        };
        router
            .layer(middleware::from_fn_with_state(
                self.clone(),
                idempotency::idempotent,
            ))
            .layer(middleware::from_fn(compression))
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
    } else if req.uri().path().contains("/api/")
        && app.owner(req.headers()).is_none()
        && !(req.uri().path().ends_with("/api/connect") && *req.method() == Method::POST)
        && !(req.uri().path().ends_with("/api/files/download") && *req.method() == Method::GET)
    {
        error(StatusCode::UNAUTHORIZED, "Connect to your shell first.")
    } else if req.uri().path().contains("/api/")
        && *req.method() != Method::GET
        && !app.same_origin(req.headers())
    {
        error(StatusCode::FORBIDDEN, "Origin is not allowed.")
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
                "Content-Type, Authorization, If-None-Match, X-libertty-Link, Idempotency-Key, Range",
            ),
            ("access-control-allow-methods", "GET, POST, DELETE, OPTIONS"),
            ("access-control-allow-private-network", "true"),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}
async fn typed_body<T: serde::de::DeserializeOwned>(
    req: &mut Request<Body>,
    limit: usize,
) -> Result<T, Failure> {
    if !req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
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
    if utf16_len(&content) > limit {
        return Err(fail("Request too large"));
    }
    let content = if content.is_empty() { "{}" } else { &content };
    if !content.trim_start().starts_with('{') {
        return Err(fail("Expected an object"));
    }
    serde_json::from_str(content).map_err(|error| {
        if error.is_syntax() || error.is_eof() {
            fail("Invalid JSON")
        } else {
            fail(format!("Invalid request: {error}"))
        }
    })
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
async fn compression(req: Request<Body>, next: Next) -> Response<Body> {
    let accepted = assets::accepted_encodings(
        req.headers()
            .get("accept-encoding")
            .and_then(|value| value.to_str().ok()),
    );
    let constrained = req
        .headers()
        .get("x-libertty-link")
        .is_some_and(|value| value == "constrained");
    let head = *req.method() == Method::HEAD;
    let response = next.run(req).await;
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let size = response.body().size_hint().exact().unwrap_or(0);
    let threshold = if constrained { 2048 } else { 128 * 1024 };
    if head
        || !accepted.contains(&"gzip")
        || response.headers().contains_key("content-encoding")
        || !(mime.starts_with("text/")
            || mime.starts_with("application/json")
            || mime.starts_with("application/xml")
            || mime.starts_with("image/svg+xml"))
        || size < threshold
        || size > reading::MAX_READING_BYTES as u64 + 1024 * 1024
    {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, reading::MAX_READING_BYTES + 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Response unavailable."),
    };
    let shared = bytes.clone();
    let compressed = tokio::task::spawn_blocking(move || wire::gzip(&shared))
        .await
        .ok()
        .flatten()
        .filter(|compressed| compressed.len() < bytes.len() * 7 / 8);
    if let Some(compressed) = compressed {
        parts
            .headers
            .insert("content-encoding", HeaderValue::from_static("gzip"));
        parts.headers.insert(
            "content-length",
            HeaderValue::from_str(&compressed.len().to_string()).unwrap(),
        );
        parts.headers.append(
            "vary",
            HeaderValue::from_static("Accept-Encoding, X-libertty-Link"),
        );
        Response::from_parts(parts, Body::from(compressed))
    } else {
        Response::from_parts(parts, Body::from(bytes))
    }
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
async fn herdr_websocket(
    app: &Arc<App>,
    req: Request<Body>,
    query: &HashMap<String, String>,
) -> Result<Response<Body>, Failure> {
    let denied = || Failure(StatusCode::FORBIDDEN, "Forbidden".into());
    let session_name =
        herdr::session(query.get("herdrSession").map(String::as_str)).map_err(|_| denied())?;
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
                .contains_key(&SessionKey::new(&ticket.owner, source)))
    {
        return Err(denied());
    }
    let permit = app
        .herdr_capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| denied())?;
    let upgrade = socket::upgrade(req).await?;
    let app = app.clone();
    let ledger = input_client(query)
        .filter(|_| !terminal.is_empty())
        .map(|client| {
            app.herdr_inputs
                .open(format!("{}/{terminal}/{client}", ticket.owner))
        });
    Ok(upgrade
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let id = storage::random_hex(16);
            let cancel = CancellationToken::new();
            app.herdr_connections.lock().unwrap().insert(
                id.clone(),
                (
                    SessionKey::new(&ticket.owner, &ticket.source),
                    cancel.clone(),
                ),
            );
            herdr_socket_session(socket, &app, ticket, cancel.clone(), &id, ledger).await;
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
    ledger: Option<(Arc<herdr_view::Ledger>, bool)>,
) {
    let _source = if ticket.source.is_empty() {
        None
    } else {
        let source = app
            .sessions
            .lock()
            .await
            .get(&SessionKey::new(&ticket.owner, &ticket.source))
            .and_then(|terminal| terminal.session.lease());
        let Some(source) = source else { return };
        Some(source)
    };
    let (send, output, slow) = crate::viewer_queue::channel();
    let notification_target = ticket.target.clone();
    let view = if ticket.terminal.is_empty() {
        let (metadata, mut receive) = tokio::sync::mpsc::channel(16);
        let target = ticket.target.clone();
        let lifetime = cancel.clone();
        tokio::spawn(herdr::metadata(target, metadata, lifetime.clone()));
        let send = send.clone();
        tokio::spawn(async move {
            loop {
                let message = tokio::select! {
                    biased;
                    _ = lifetime.cancelled() => break,
                    message = receive.recv() => message,
                };
                let Some(message) = message else { break };
                if !send.send(Transport::Metadata(message)) {
                    break;
                }
            }
        });
        None
    } else {
        let snapshot = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            snapshot = ticket.target.snapshot() => snapshot,
        };
        let agent = snapshot
            .ok()
            .and_then(|snapshot| snapshot.terminal(&ticket.terminal).cloned());
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
        let revision = if ticket.size.is_some() {
            crate::herdr_redraw::revision(&ticket.target, &agent.pane_id, &cancel).await
        } else {
            None
        };
        let recording_scope = json!([
            ticket.owner,
            ticket.source,
            ticket.session,
            ticket.terminal,
            ticket.target.path().ok()
        ])
        .to_string();
        match herdr_view::View::open(
            ticket.target,
            agent,
            &app.herdr_terminals,
            &app.herdr_polls,
            ticket.size.map(|size| (size, revision)),
            herdr_view::Viewer {
                send,
                cancel: cancel.clone(),
                ledger,
            },
        ) {
            Ok(view) => {
                view.set_recording_scope(recording_scope);
                Some(view)
            }
            Err(_) => return,
        }
    };
    let input = if let Some(view) = &view {
        socket::Input::Herdr(view)
    } else {
        socket::Input::Metadata {
            app,
            connection: id,
            owner: &ticket.owner,
            source: &ticket.source,
            target: &notification_target,
        }
    };
    socket::pump(
        socket,
        input,
        socket::Output::Herdr(output),
        socket::Policy::herdr(cancel.clone(), slow, view.is_some()),
    )
    .await;
    cancel.cancel();
    drop(view);
}
async fn websocket(
    app: &Arc<App>,
    req: Request<Body>,
    query: &HashMap<String, String>,
) -> Result<Response<Body>, Failure> {
    let denied = || Failure(StatusCode::FORBIDDEN, "Forbidden".into());
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
        .get(&SessionKey::new(&owner, &sid))
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
    let upgrade = socket::upgrade(req).await?;
    if let Some(ticket) = query.get("ticket") {
        app.tickets.lock().unwrap().remove(ticket);
    }
    let stream = query.get("stream").cloned();
    let client = input_client(query);
    Ok(upgrade
        .on_upgrade(move |socket| socket_session(socket, session, after as u64, stream, client))
        .into_response())
}
/// The browser terminal's own id for numbering its keys, ignored unless it is a short token.
fn input_client(query: &HashMap<String, String>) -> Option<String> {
    query
        .get("client")
        .filter(|id| {
            (1..=64).contains(&id.len())
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .cloned()
}
async fn socket_session(
    socket: WebSocket,
    session: Arc<Session>,
    after: u64,
    stream: Option<String>,
    client: Option<String>,
) {
    let (id, output) = session.attach(after, stream.as_deref(), client.as_deref());
    socket::pump(
        socket,
        socket::Input::Native {
            session: &session,
            attachment: id,
        },
        socket::Output::Native(output),
        socket::Policy::native(),
    )
    .await;
    session.detach(id);
}
pub async fn run() -> Result<(), String> {
    let app = App::new(Config::from_env()?).await?;
    let listener = tokio::net::TcpListener::bind((app.config.host.as_str(), app.config.port))
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "libertty → http://{}:{}{} (Rust, Ghostty)",
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
                cleanup.close_session(&key.owner, &key.sid).await;
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

async fn static_request(State(app): State<Arc<App>>, req: Request<Body>) -> Response<Body> {
    let path = req.uri().path().to_owned();
    if app.config.base_path != "/" && path == app.config.base_path {
        return Response::builder()
            .status(308)
            .header("location", &app.config.public_base)
            .body(Body::empty())
            .unwrap();
    }
    let pathname = if app.config.base_path != "/" && path.starts_with(&app.config.public_base) {
        &path[app.config.base_path.len()..]
    } else {
        &path
    };
    if pathname.starts_with("/api/") {
        return if app.owner(req.headers()).is_none() {
            error(StatusCode::UNAUTHORIZED, "Connect to your shell first.")
        } else {
            error(StatusCode::NOT_FOUND, "Not found")
        };
    }
    if let Some(frontend) = &app.config.dev_frontend {
        return match crate::dev::serve(
            frontend,
            &app.config.public_base,
            pathname,
            app.owner(req.headers()).is_some(),
            app.same_origin(req.headers()),
            req,
        )
        .await
        {
            Ok(response) => response,
            Err((status, message)) => error(status, message),
        };
    }
    assets::serve(
        &app.config.dist,
        &app.config.public_base,
        pathname,
        req.method(),
        req.headers(),
    )
    .await
}
