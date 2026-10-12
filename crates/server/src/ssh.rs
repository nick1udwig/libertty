use crate::{
    context::ShellContext,
    history::{HISTORY_BYTES, history_lines},
    probes::{ABORTED, ProbePool},
    system_ssh::{self, Method, System},
    vault::{KeyInfo, Vault, fingerprint, inspect_private_key},
};
use russh::{
    Channel, ChannelMsg, ChannelStream, ChannelWriteHalf, Disconnect, Sig, client,
    keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate, agent::client::AgentClient},
};
use russh_sftp::{
    client::{RawSftpSession, SftpSession},
    protocol::{FileAttributes, OpenFlags},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use termai_engine::{path, repair::shell_quote, validation::Environment};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Debug)]
pub struct Error {
    pub message: String,
    pub status: u16,
    pub fingerprint: Option<String>,
    pub changed: Option<bool>,
    pub needs_secret: Option<bool>,
}
impl Error {
    fn secret(message: &str, needed: bool) -> Self {
        Self {
            needs_secret: Some(needed),
            ..message.to_owned().into()
        }
    }
    pub fn value(&self) -> Value {
        let mut value = json!({"error":self.message});
        if let Some(fingerprint) = &self.fingerprint {
            value["fingerprint"] = json!(fingerprint);
        }
        if let Some(changed) = self.changed {
            value["changed"] = json!(changed);
        }
        if let Some(needed) = self.needs_secret {
            value["needsSecret"] = json!(needed);
        }
        value
    }
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self {
            message,
            status: 400,
            fingerprint: None,
            changed: None,
            needs_secret: None,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for Error {}
pub struct Verify {
    expected: HashSet<String>,
    observed: Arc<Mutex<Option<String>>>,
}
impl client::Handler for Verify {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let bytes = if let Some(certificate) = key.certificate() {
            certificate.to_bytes().map_err(russh::Error::from)?
        } else {
            key.public_key().to_bytes().map_err(russh::Error::from)?
        };
        let observed = fingerprint(&bytes);
        *self.observed.lock().unwrap() = Some(observed.clone());
        Ok(self.expected.contains(&observed))
    }
}
pub type RemoteChannel = Channel<client::Msg>;
pub type RemoteStream = ChannelStream<client::Msg>;
pub(crate) struct ChannelGuard(pub Arc<ChannelWriteHalf<client::Msg>>);
impl Drop for ChannelGuard {
    fn drop(&mut self) {
        let channel = self.0.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    let _ = channel.signal(Sig::KILL).await;
                    let _ = channel.close().await;
                })
                .await;
            });
        }
    }
}
#[derive(Debug)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: u32,
}
pub struct SSHHost {
    client: client::Handle<Verify>,
    pub files: SftpSession,
    pub(crate) raw: Arc<RawSftpSession>,
    pub key: Option<KeyInfo>,
    pub home: String,
    pub cwd: String,
    pub pool: ProbePool,
    directory: Mutex<String>,
    history_source: Mutex<String>,
    context: tokio::sync::Mutex<Option<(u64, ShellContext)>>,
    closed: AtomicBool,
    pub(crate) help_cache: tokio::sync::Mutex<
        std::collections::VecDeque<(
            String,
            std::time::Instant,
            crate::probes::SharedTask<termai_engine::types::Help>,
        )>,
    >,
    pub(crate) syntax_cache: Mutex<std::collections::VecDeque<(String, bool)>>,
    pub(crate) lifetime: CancellationToken,
}
impl std::fmt::Debug for SSHHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SSHHost")
            .field("home", &self.home)
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}
impl SSHHost {
    pub async fn connect(
        input: &Value,
        vault: Arc<Vault>,
        mut system: Option<System>,
        files_only: bool,
        cancel: &CancellationToken,
    ) -> Result<Arc<Self>, Error> {
        let address = system_ssh::address(input)?;
        let listing = {
            let vault = vault.clone();
            tokio::task::spawn_blocking(move || vault.list())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };
        let known = listing
            .known_hosts
            .iter()
            .find(|k| k.host == address.host && k.port == address.port);
        let stored = input["keyId"]
            .as_str()
            .and_then(|id| listing.keys.iter().find(|key| key.id == id))
            .cloned();
        let passphrase = input["passphrase"].as_str();
        if let Some(reference) = stored.as_ref().and_then(|key| key.reference.as_ref()) {
            let stored = stored.as_ref().unwrap();
            let method = if reference.kind == "file" {
                let private = system_ssh::read_identity(&reference.path, passphrase)
                    .await?
                    .ok_or_else(|| Error::secret("Unlock the referenced SSH key.", true))?;
                if system_ssh::key_info(private.public_key())?.1 != stored.fingerprint {
                    return Err("The referenced SSH key has changed. Remove its reference and connect again to select the new identity.".to_owned().into());
                }
                Method::Private(Arc::new(private))
            } else {
                let public = system_ssh::agent_identities(&reference.path)
                    .await?
                    .into_iter()
                    .find(|key| {
                        system_ssh::key_info(key).is_ok_and(|(_, fp)| fp == stored.fingerprint)
                    })
                    .ok_or("This SSH identity is not available in the backend agent.".to_owned())?;
                Method::Agent(reference.path.clone(), public)
            };
            system = Some(System {
                address: system_ssh::address(input)?,
                identities: vec![system_ssh::Identity {
                    reference: reference.clone(),
                    public_key: stored.public_key.clone(),
                    fingerprint: stored.fingerprint.clone(),
                    method,
                }],
                known: HashSet::new(),
                algorithms: vec![],
                locked: false,
            });
        }
        let private = if let Some(system) = &system {
            if system.identities.is_empty() {
                return Err(Error::secret(
                    "No unlocked SSH identity is available.",
                    system.locked,
                ));
            }
            None
        } else if input.get("privateKey").is_some() {
            if input.get("keyId").is_some_and(|v| !v.is_null()) {
                return Err("Choose one SSH key source.".to_owned().into());
            }
            let raw = input["privateKey"]
                .as_str()
                .ok_or("Invalid private key.".to_owned())?;
            inspect_private_key(raw, passphrase.unwrap_or("")).map_err(|e| e.to_string())?;
            Some(Arc::new(system_ssh::decode_private(raw, passphrase)?))
        } else if let Some(id) = input["keyId"].as_str().filter(|s| !s.is_empty()) {
            let id = id.to_owned();
            let password = Zeroizing::new(passphrase.unwrap_or("").to_owned());
            let vault = vault.clone();
            let raw = tokio::task::spawn_blocking(move || vault.unlock(&id, &password))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            Some(Arc::new(system_ssh::decode_private(
                std::str::from_utf8(&raw).map_err(|e| e.to_string())?,
                passphrase,
            )?))
        } else {
            if input["password"].as_str().is_none_or(str::is_empty) {
                return Err("Choose an SSH key or enter the SSH account password."
                    .to_owned()
                    .into());
            }
            None
        };
        let expected = if let Some(known) = known {
            HashSet::from([known.fingerprint.clone()])
        } else if let Some(system) = system.as_ref().filter(|s| !s.known.is_empty()) {
            system.known.clone()
        } else {
            input["trust"]
                .as_str()
                .map(|s| HashSet::from([s.to_owned()]))
                .unwrap_or_default()
        };
        let observed = Arc::new(Mutex::new(None));
        let mut config = client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            ..client::Config::default()
        };
        if input["compression"] == "on" {
            config.preferred.compression =
                vec![russh::compression::ZLIB_LEGACY, russh::compression::NONE].into();
        }
        if let Some(system) = &system
            && !system.algorithms.is_empty()
        {
            let algorithms = system
                .algorithms
                .iter()
                .filter_map(|name| russh::keys::Algorithm::new(name).ok())
                .collect::<Vec<_>>();
            if !algorithms.is_empty() {
                config.preferred.key = algorithms.into();
            }
        }
        let establish = async {
            let mut client = client::connect(
                Arc::new(config),
                (address.host.as_str(), address.port),
                Verify {
                    expected: expected.clone(),
                    observed: observed.clone(),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            let hash = client
                .best_supported_rsa_hash()
                .await
                .map_err(|e| e.to_string())?
                .flatten();
            let mut successful = None;
            let authenticated = if let Some(system) = &system {
                for identity in &system.identities {
                    let success = match &identity.method {
                        Method::Private(key) => client
                            .authenticate_publickey(
                                &address.username,
                                PrivateKeyWithHashAlg::new(key.clone(), hash),
                            )
                            .await
                            .map_err(|e| e.to_string())?
                            .success(),
                        Method::Agent(socket, key) => {
                            let mut agent = tokio::time::timeout(
                                Duration::from_secs(2),
                                AgentClient::connect_uds(socket),
                            )
                            .await
                            .map_err(|_| "SSH agent timed out.".to_owned())?
                            .map_err(|e| e.to_string())?;
                            client
                                .authenticate_publickey_with(
                                    &address.username,
                                    key.clone(),
                                    hash,
                                    &mut agent,
                                )
                                .await
                                .map_err(|e| e.to_string())?
                                .success()
                        }
                    };
                    if success {
                        successful = Some(identity.clone());
                        break;
                    }
                }
                successful.is_some()
            } else if let Some(private) = private {
                client
                    .authenticate_publickey(
                        &address.username,
                        PrivateKeyWithHashAlg::new(private, hash),
                    )
                    .await
                    .map_err(|e| e.to_string())?
                    .success()
            } else {
                client
                    .authenticate_password(
                        &address.username,
                        input["password"].as_str().unwrap_or(""),
                    )
                    .await
                    .map_err(|e| e.to_string())?
                    .success()
            };
            if !authenticated {
                let _ = client
                    .disconnect(Disconnect::ByApplication, "Authentication failed", "en")
                    .await;
                return Err("All configured authentication methods failed.".to_owned());
            }
            Ok((client, successful))
        };
        let result = tokio::select! {
            biased; _ = cancel.cancelled() => Err(ABORTED.to_owned()),
            result = tokio::time::timeout(Duration::from_secs(12), establish) => result.unwrap_or_else(|_| Err("SSH connection timed out.".into()))
        };
        let (client, successful) = match result {
            Ok(result) => result,
            Err(message) => {
                if let Some(observed) = observed
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|fp| !expected.contains(*fp))
                {
                    let changed =
                        known.is_some() || system.as_ref().is_some_and(|s| !s.known.is_empty());
                    return Err(Error {
                        message: if changed {
                            "The SSH host key has changed."
                        } else {
                            "Verify the SSH host fingerprint before connecting."
                        }
                        .into(),
                        status: 409,
                        fingerprint: Some(observed.clone()),
                        changed: Some(changed),
                        needs_secret: None,
                    });
                }
                if system.as_ref().is_some_and(|s| s.locked) && message.contains("authentication") {
                    return Err(Error::secret("Unlock the SSH identity to connect.", true));
                }
                return Err(message.into());
            }
        };
        let key = if let Some(identity) = successful {
            let vault = vault.clone();
            let name = format!("{}@{}", address.username, address.host);
            Some(
                tokio::task::spawn_blocking(move || {
                    vault.reference(
                        &name,
                        &identity.public_key,
                        &identity.fingerprint,
                        identity.reference,
                    )
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?,
            )
        } else {
            stored
        };
        if known.is_none() {
            let observed = observed.lock().unwrap().clone().unwrap();
            let vault = vault.clone();
            tokio::task::spawn_blocking(move || {
                vault.trust(&address.host, address.port, &observed)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        }
        let files = bounded(cancel, async {
            let channel = client
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| e.to_string())?;
            SftpSession::new_opts(channel.into_stream(), Some(15))
                .await
                .map_err(|e| e.to_string())
        })
        .await?;
        let raw = bounded(cancel, async {
            let channel = client
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| e.to_string())?;
            let raw = RawSftpSession::new(channel.into_stream());
            raw.set_timeout(15).await;
            raw.init().await.map_err(|e| e.to_string())?;
            Ok(Arc::new(raw))
        })
        .await?;
        let mut host = Self {
            client,
            files,
            raw,
            key,
            home: String::new(),
            cwd: String::new(),
            pool: ProbePool::new(4),
            directory: Mutex::new(String::new()),
            history_source: Mutex::new(String::new()),
            context: tokio::sync::Mutex::new(None),
            closed: AtomicBool::new(false),
            help_cache: tokio::sync::Mutex::new(Default::default()),
            syntax_cache: Mutex::new(Default::default()),
            lifetime: CancellationToken::new(),
        };
        if files_only {
            host.home = bounded(cancel, async {
                host.files
                    .canonicalize(".")
                    .await
                    .map_err(|e| e.to_string())
            })
            .await?;
            host.cwd = host.home.clone();
        } else {
            let output = host
                .exec("printf '%s\\n%s' \"$HOME\" \"$PWD\"", cancel)
                .await?;
            let (home, cwd) = output
                .stdout
                .trim_end()
                .split_once('\n')
                .ok_or("SSH target must provide a POSIX shell and SFTP.".to_owned())?;
            if !home.starts_with('/') || !cwd.starts_with('/') {
                return Err("SSH target must provide a POSIX shell and SFTP."
                    .to_owned()
                    .into());
            }
            host.home = home.into();
            host.cwd = cwd.into();
            let eternal = path::join(&[&host.home, ".bash_eternal_history"]);
            let source = if host
                .files
                .metadata(&eternal)
                .await
                .is_ok_and(|m| m.file_type().is_file())
            {
                eternal
            } else {
                path::join(&[&host.home, ".bash_history"])
            };
            *host.history_source.lock().unwrap() = source;
        }
        Ok(Arc::new(host))
    }
    pub fn directory(&self) -> String {
        self.directory.lock().unwrap().clone()
    }
    pub async fn exec(&self, command: &str, cancel: &CancellationToken) -> Result<Output, String> {
        self.pool
            .run(cancel, self.exec_inner(command, cancel))
            .await
    }
    async fn exec_inner(
        &self,
        command: &str,
        cancel: &CancellationToken,
    ) -> Result<Output, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("SSH connection closed.".into());
        }
        bounded(cancel, async {
            let channel = self
                .client
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            let (mut read, write) = channel.split();
            let guard = ChannelGuard(Arc::new(write));
            guard
                .0
                .exec(true, command.as_bytes().to_vec())
                .await
                .map_err(|e| e.to_string())?;
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut code = 0;
            while let Some(message) = read.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                    ChannelMsg::Failure => return Err("SSH command was refused.".into()),
                    ChannelMsg::Close => break,
                    _ => {}
                }
                if stdout.len() + stderr.len() > 1024 * 1024 {
                    return Err("SSH fact output exceeded its limit.".into());
                }
            }
            Ok(Output {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                code,
            })
        })
        .await
    }
    pub async fn open_unix(
        &self,
        socket: &str,
        cancel: &CancellationToken,
    ) -> Result<RemoteStream, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("SSH connection closed. Reconnect the source host.".into());
        }
        bounded(cancel, async {
            self.client.channel_open_direct_streamlocal(socket).await.map(|c| c.into_stream())
                .map_err(|_| "Cannot reach Herdr on this SSH host. Check that its server is running and Unix socket forwarding is allowed.".into())
        }).await
    }
    pub async fn open_stream(
        &self,
        command: &str,
        cancel: &CancellationToken,
    ) -> Result<RemoteChannel, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("SSH connection closed.".into());
        }
        bounded(cancel, async {
            let channel = self
                .client
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            channel
                .exec(true, command.as_bytes().to_vec())
                .await
                .map_err(|e| e.to_string())?;
            Ok(channel)
        })
        .await
    }
    pub async fn prepare_shell(
        &self,
        rc: &str,
        nonce: &str,
        cancel: &CancellationToken,
    ) -> Result<RemoteChannel, String> {
        let output = self
            .exec("umask 077; mktemp -d /tmp/termai.XXXXXXXX", cancel)
            .await?;
        let directory = output.stdout.trim().to_owned();
        if output.code != 0
            || !directory
                .strip_prefix("/tmp/termai.")
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            return Err("Cannot create a private SSH shell context.".into());
        }
        *self.directory.lock().unwrap() = directory.clone();
        bounded(cancel, async {
            let mut file = self
                .files
                .open_with_flags_and_attributes(
                    path::join(&[&directory, "bashrc"]),
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    FileAttributes {
                        permissions: Some(0o600),
                        ..FileAttributes::empty()
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            file.write_all(rc.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            file.shutdown().await.map_err(|e| e.to_string())
        })
        .await?;
        let mut variables = Environment::from([
            ("TERMAI_TRANSFER_DIR".into(), directory.clone()),
            ("TERMAI_READING_DIR".into(), directory.clone()),
            ("TERMAI_CAPTURE_SSH".into(), "0".into()),
            ("TERMAI_NONCE".into(), nonce.into()),
            (
                "TERMAI_HISTORY_SOURCE".into(),
                self.history_source.lock().unwrap().clone(),
            ),
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
        ]);
        for (key, file) in [
            ("TERMAI_ENV_FILE", "environment"),
            ("TERMAI_COMMANDS_FILE", "commands"),
            ("TERMAI_FUNCTIONS_FILE", "functions"),
            ("TERMAI_COMPLETIONS_FILE", "completions"),
        ] {
            variables.insert(key.into(), path::join(&[&directory, file]));
        }
        let assignments = variables
            .iter()
            .map(|(k, v)| format!("{k}={}", shell_quote(v)))
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "cd {} && env {assignments} bash --noprofile --rcfile {} -i",
            shell_quote(&self.home),
            shell_quote(&path::join(&[&directory, "bashrc"]))
        );
        bounded(cancel, async {
            let channel = self
                .client
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            channel
                .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
                .await
                .map_err(|e| e.to_string())?;
            channel
                .exec(true, command.into_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(channel)
        })
        .await
    }
    pub async fn read_bytes(
        &self,
        file: &str,
        limit: usize,
        start: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, String> {
        bounded(cancel, async {
            let mut file = self.files.open(file).await.map_err(|e| e.to_string())?;
            if start > 0 {
                file.seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            file.shutdown().await.map_err(|e| e.to_string())?;
            if bytes.len() > limit {
                return Err("SSH file exceeds limit.".into());
            }
            Ok(bytes)
        })
        .await
    }
    pub async fn read_for_viewing(
        self: &Arc<Self>,
        cwd: &str,
        input: &str,
        cancel: &CancellationToken,
    ) -> crate::files::Result<crate::reading::File> {
        use crate::{
            files::Error,
            reading::{File, MAX_READING_BYTES, mime},
        };
        if input.is_empty()
            || input.encode_utf16().count() > 4096
            || input.chars().any(|c| c < '\x20' || c == '\x7f')
        {
            return Err(Error::new("Enter a file path.", 400));
        }
        let path = crate::files::file_path(cwd, &self.home, input)?;
        let filesystem = crate::filesystem::FileSystem {
            remote: Some(self.clone()),
        };
        let info = tokio::select! { biased; _=cancel.cancelled()=>return Err(Error::new(ABORTED, 400)), result=filesystem.metadata(&path, true)=>result }
            .map_err(|_| Error::new("File not found.", 404))?;
        if !info.is_file() {
            return Err(Error::new("This path is not a regular file.", 400));
        }
        let too_large = || {
            Error::new(
                "This file is too large for Reading Mode (20 MB limit).",
                413,
            )
        };
        if info.len() > MAX_READING_BYTES as u64 {
            return Err(too_large());
        }
        let read = async {
            let file = filesystem.open_read(&path).await?;
            let mut data = Vec::new();
            file.take(MAX_READING_BYTES as u64 + 1)
                .read_to_end(&mut data)
                .await
                .map_err(Error::from)?;
            if data.len() > MAX_READING_BYTES {
                return Err(too_large());
            }
            Ok(data)
        };
        let data = tokio::select! { biased; _=cancel.cancelled()=>return Err(Error::new(ABORTED, 400)), result=tokio::time::timeout(Duration::from_secs(15), read)=>result.map_err(|_| Error::new("SSH file read timed out.", 400))? }?;
        Ok(File {
            mime: mime(&path, &data),
            path,
            data,
        })
    }
    pub async fn history(&self, cancel: &CancellationToken) -> Vec<String> {
        let result = async {
            let eternal = path::join(&[&self.home, ".bash_eternal_history"]);
            let source = if self
                .files
                .metadata(&eternal)
                .await
                .is_ok_and(|info| info.file_type().is_file())
            {
                eternal
            } else {
                path::join(&[&self.home, ".bash_history"])
            };
            *self.history_source.lock().unwrap() = source.clone();
            let info = self
                .files
                .metadata(&source)
                .await
                .map_err(|e| e.to_string())?;
            if !info.file_type().is_file() {
                return Ok(vec![]);
            }
            let start = info.len().saturating_sub(HISTORY_BYTES as u64);
            let bytes = self
                .read_bytes(&source, HISTORY_BYTES, start, cancel)
                .await?;
            Ok::<_, String>(history_lines(&String::from_utf8_lossy(&bytes), start > 0))
        };
        bounded(cancel, result).await.unwrap_or_default()
    }
    pub async fn context(
        &self,
        prompt: u64,
        cancel: &CancellationToken,
    ) -> Result<ShellContext, String> {
        let mut cache = self.context.lock().await;
        if let Some((revision, context)) = &*cache
            && *revision == prompt
        {
            return Ok(context.clone());
        }
        let directory = self.directory();
        if directory.is_empty() {
            return Ok(ShellContext {
                commands: Arc::default(),
                functions: Arc::default(),
                environment: Arc::new(Environment::from([
                    ("HOME".into(), self.home.clone()),
                    ("PWD".into(), self.cwd.clone()),
                ])),
            });
        }
        let read = |name: &'static str| {
            let file = path::join(&[&directory, name]);
            async move {
                self.read_bytes(&file, 1024 * 1024, 0, cancel)
                    .await
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            }
        };
        let (commands, functions, environment) =
            tokio::try_join!(read("commands"), read("functions"), read("environment"))?;
        let mut commands = commands
            .split('\n')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        commands.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let context = ShellContext {
            commands: Arc::new(commands),
            functions: Arc::new(
                functions
                    .split('\n')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
            ),
            environment: Arc::new(
                environment
                    .split('\0')
                    .filter_map(|s| s.split_once('='))
                    .map(|(k, v)| (k.into(), v.into()))
                    .collect(),
            ),
        };
        *cache = Some((prompt, context.clone()));
        Ok(context)
    }
    pub async fn dispose(&self) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let directory = self.directory();
        if !directory.is_empty() {
            let _ = self
                .exec(
                    &format!("rm -rf -- {}", shell_quote(&directory)),
                    &CancellationToken::new(),
                )
                .await;
        }
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.lifetime.cancel();
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            self.client
                .disconnect(Disconnect::ByApplication, "Session ended", "en"),
        )
        .await;
    }
}
impl Drop for SSHHost {
    fn drop(&mut self) {
        self.lifetime.cancel();
    }
}
pub(crate) async fn bounded<T>(
    cancel: &CancellationToken,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased; _ = cancel.cancelled() => Err(ABORTED.into()),
        result = tokio::time::timeout(Duration::from_secs(4),work) => result.unwrap_or_else(|_| Err("SSH operation timed out.".into()))
    }
}
pub async fn route_probe(input: &Value, cancel: &CancellationToken) -> Result<f64, String> {
    let address = system_ssh::address(input)?;
    let start = std::time::Instant::now();
    tokio::select! {
        biased; _=cancel.cancelled()=>Err(ABORTED.into()),
        result=tokio::time::timeout(Duration::from_millis(2500),tokio::net::TcpStream::connect((address.host.as_str(),address.port)))=>{
            result.map_err(|_| "SSH endpoint did not respond.".to_owned())?.map_err(|e| e.to_string())?;
            Ok(start.elapsed().as_secs_f64()*1000.0)
        }
    }
}
