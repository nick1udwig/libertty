use crate::{
    probes::{self, ProbeOptions, ProbePool},
    vault::{self, KeyReference},
};
use regex::Regex;
use russh::keys::{PrivateKey, PublicKey, agent::client::AgentClient};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, LazyLock},
    time::Duration,
};
use termai_engine::utf16_len;
use termai_engine::{path, validation::Environment};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Debug, Clone)]
pub struct Error {
    pub message: String,
    pub native: bool,
}
impl Error {
    fn native(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            native: true,
        }
    }
    fn regular(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            native: false,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for Error {}
pub struct Address {
    pub host: String,
    pub port: u16,
    pub username: String,
}
pub fn address(value: &Value) -> Result<Address, String> {
    let port = value
        .get("port")
        .filter(|value| !value.is_null())
        .map_or(Some(22.0), Value::as_f64)
        .ok_or("SSH port must be between 1 and 65535.")?;
    address_parts(
        value["host"].as_str().unwrap_or(""),
        port,
        value["username"].as_str().unwrap_or(""),
    )
}
pub fn address_parts(host: &str, port: f64, username: &str) -> Result<Address, String> {
    let host = host.trim();
    if host.is_empty()
        || utf16_len(host) > 253
        || !host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":._%-".contains(&c))
    {
        return Err("Enter a hostname or IP address.".into());
    }
    let port = Some(port)
        .filter(|value| value.fract() == 0.0 && (1.0..=65535.0).contains(value))
        .ok_or("SSH port must be between 1 and 65535.")?;
    let username = username.trim();
    if username.is_empty()
        || utf16_len(username) > 128
        || username.chars().any(|c| c <= '\u{20}' || c == '\u{7f}')
    {
        return Err("Enter an SSH username.".into());
    }
    Ok(Address {
        host: host.into(),
        port: port as u16,
        username: username.into(),
    })
}
pub fn arguments(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && quote != Some('\'') {
            let next = chars.next()?;
            if quote == Some('"') && !['\\', '"', '$', '\u{60}'].contains(&next) {
                word.push('\\');
            }
            word.push(next);
            started = true;
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                if q == '"' && ['$', '\u{60}'].contains(&c) {
                    return None;
                }
                word.push(c);
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            started = true;
        } else if c.is_whitespace() || c == '\u{feff}' {
            if started {
                words.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            if ";&|<>$(){}*?[]#".contains(c) || c == '\u{60}' {
                return None;
            }
            word.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    if !words
        .first()
        .is_some_and(|s| ["ssh", "/usr/bin/ssh"].contains(&s.as_str()))
    {
        return None;
    }
    words.remove(0);
    let options = [
        "identityfile",
        "identitiesonly",
        "identityagent",
        "hostname",
        "user",
        "port",
        "userknownhostsfile",
        "globalknownhostsfile",
        "stricthostkeychecking",
        "hostkeyalias",
    ];
    let mut destination = false;
    let mut at = 0;
    while at < words.len() {
        let value = &words[at];
        if destination {
            return None;
        }
        if value == "-t" || value == "-tt" {
            at += 1;
            continue;
        }
        let bytes = value.as_bytes();
        if bytes.len() >= 2 && bytes[0] == b'-' && b"iplFo".contains(&bytes[1]) {
            let flag = bytes[1];
            let arg = if value.len() > 2 {
                &value[2..]
            } else {
                at += 1;
                words.get(at)?
            };
            if arg.is_empty() {
                return None;
            }
            if flag == b'o'
                && !options.contains(
                    &arg.split(|c: char| c == '=' || c.is_whitespace() || c == '\u{feff}')
                        .next()?
                        .to_ascii_lowercase()
                        .as_str(),
                )
            {
                return None;
            }
        } else if value.starts_with('-') {
            return None;
        } else {
            destination = true;
        }
        at += 1;
    }
    if destination { Some(words) } else { None }
}
pub fn expand(file: &str, env: &Environment, cwd: &str) -> Result<String, Error> {
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"%[A-Za-z]").unwrap());
    static VARIABLE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").unwrap());
    if file.starts_with('~') && file.len() > 1 && !file.starts_with("~/") || TOKEN.is_match(file) {
        return Err(Error::native(
            "This SSH path uses an unsupported expansion.",
        ));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let file = if file == "~" {
        home
    } else if let Some(rest) = file.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        file.into()
    };
    let mut missing = false;
    let file = VARIABLE.replace_all(&file, |captures: &regex::Captures| {
        match env.get(&captures[1]).filter(|s| !s.is_empty()) {
            Some(value) => value.clone(),
            None => {
                missing = true;
                String::new()
            }
        }
    });
    if missing {
        return Err(Error::native(
            "This SSH path needs an environment variable.",
        ));
    }
    Ok(path::resolve(&[cwd, &file]))
}
pub fn key_info(key: &PublicKey) -> Result<(String, String), String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = key.to_bytes().map_err(|e| e.to_string())?;
    Ok((
        format!("{} {}", key.algorithm().as_str(), STANDARD.encode(&bytes)),
        vault::fingerprint(&bytes),
    ))
}
pub fn decode_private(raw: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let trimmed = raw.trim();
    // Preserve the reference's supported formats; generic PKCS8 is not accepted.
    if trimmed.starts_with("-----BEGIN PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----")
    {
        return Err("Cannot unlock this private key. Check its passphrase and format.".into());
    }
    if trimmed.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let body = trimmed
            .strip_prefix("-----BEGIN OPENSSH PRIVATE KEY-----")
            .and_then(|s| s.strip_suffix("-----END OPENSSH PRIVATE KEY-----"))
            .ok_or("Invalid SSH private key.")?;
        let encoded = Zeroizing::new(
            body.chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect::<String>(),
        );
        let bytes = Zeroizing::new(
            STANDARD
                .decode(encoded.as_bytes())
                .map_err(|e| e.to_string())?,
        );
        let key = PrivateKey::from_bytes(&bytes).map_err(|e| e.to_string())?;
        return if key.is_encrypted() {
            key.decrypt(passphrase.unwrap_or(""))
                .map_err(|e| e.to_string())
        } else {
            Ok(key)
        };
    }
    if trimmed.starts_with("PuTTY-User-Key-File-2: ssh-rsa")
        || trimmed.starts_with("PuTTY-User-Key-File-2: ssh-dss")
    {
        if trimmed.lines().nth(1) == Some("Encryption: none") {
            return decode_plain_putty(trimmed, passphrase.unwrap_or(""));
        }
        return russh::keys::decode_secret_key(trimmed, passphrase).map_err(|e| e.to_string());
    }
    if !["RSA", "DSA", "EC"]
        .iter()
        .any(|kind| trimmed.starts_with(&format!("-----BEGIN {kind} PRIVATE KEY-----")))
    {
        return Err("Invalid SSH private key.".into());
    }
    let parsed = openssl::pkey::PKey::private_key_from_pem_passphrase(
        trimmed.as_bytes(),
        passphrase.unwrap_or("").as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    if trimmed.starts_with("-----BEGIN DSA PRIVATE KEY-----") {
        let dsa = parsed.dsa().map_err(|e| e.to_string())?;
        use russh::keys::ssh_key::{
            Mpint,
            private::{DsaKeypair, DsaPrivateKey},
            public::DsaPublicKey,
        };
        let mpint = |value: &openssl::bn::BigNumRef| Mpint::from_positive_bytes(&value.to_vec());
        let public = DsaPublicKey::new(
            mpint(dsa.p()),
            mpint(dsa.q()),
            mpint(dsa.g()),
            mpint(dsa.pub_key()),
        )
        .map_err(|e| e.to_string())?;
        let private = DsaPrivateKey::new(mpint(dsa.priv_key())).map_err(|e| e.to_string())?;
        let pair = DsaKeypair::new(public, private).map_err(|e| e.to_string())?;
        return PrivateKey::new(pair.into(), "").map_err(|e| e.to_string());
    }
    let pem = Zeroizing::new(
        parsed
            .private_key_to_pem_pkcs8()
            .map_err(|e| e.to_string())?,
    );
    russh::keys::decode_secret_key(std::str::from_utf8(&pem).map_err(|e| e.to_string())?, None)
        .map_err(|e| e.to_string())
}
fn decode_plain_putty(raw: &str, passphrase: &str) -> Result<PrivateKey, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use openssl::{hash::MessageDigest, pkey::PKey, sign::Signer};
    let lines: Vec<_> = raw.lines().collect();
    let field = |index: usize, prefix: &str| -> Result<&str, String> {
        lines
            .get(index)
            .and_then(|line| line.strip_prefix(prefix))
            .ok_or("Invalid PuTTY key.".into())
    };
    let algorithm = field(0, "PuTTY-User-Key-File-2: ")?;
    let encryption = field(1, "Encryption: ")?;
    let comment = field(2, "Comment: ")?;
    let count: usize = field(3, "Public-Lines: ")?
        .parse()
        .map_err(|_| "Invalid PuTTY key.")?;
    if count > lines.len() {
        return Err("Invalid PuTTY key.".into());
    }
    let public = STANDARD
        .decode(
            lines
                .get(4..4 + count)
                .ok_or("Invalid PuTTY key.")?
                .join(""),
        )
        .map_err(|e| e.to_string())?;
    let start = 5 + count;
    let count: usize = field(start - 1, "Private-Lines: ")?
        .parse()
        .map_err(|_| "Invalid PuTTY key.")?;
    if count > lines.len() {
        return Err("Invalid PuTTY key.".into());
    }
    let private = Zeroizing::new(
        STANDARD
            .decode(
                lines
                    .get(start..start + count)
                    .ok_or("Invalid PuTTY key.")?
                    .join(""),
            )
            .map_err(|e| e.to_string())?,
    );
    let mac = field(start + count, "Private-MAC: ")?;
    let mut data = Zeroizing::new(Vec::new());
    for bytes in [
        algorithm.as_bytes(),
        encryption.as_bytes(),
        comment.as_bytes(),
        &public,
        &private,
    ] {
        data.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        data.extend_from_slice(bytes);
    }
    let sign = |password: &str| -> Result<String, String> {
        let key =
            openssl::sha::sha1(format!("putty-private-key-file-mac-key{password}").as_bytes());
        let key = PKey::hmac(&key).map_err(|e| e.to_string())?;
        let mut signer = Signer::new(MessageDigest::sha1(), &key).map_err(|e| e.to_string())?;
        signer.update(&data).map_err(|e| e.to_string())?;
        Ok(signer
            .sign_to_vec()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    };
    if sign(passphrase)? != mac {
        return Err("PuTTY key integrity check failed.".into());
    }
    // The reference authenticates an unencrypted PPK with the supplied password.
    // The Rust parser uses an empty password for this format, so normalize only
    // after verifying the original MAC and keep the original bytes in the vault.
    let mut normalized = lines[..start + count].join("\n");
    normalized.push_str(&format!("\nPrivate-MAC: {}\n", sign("")?));
    russh::keys::decode_secret_key(&normalized, None).map_err(|e| e.to_string())
}
pub async fn read_identity(
    file: &str,
    passphrase: Option<&str>,
) -> Result<Option<PrivateKey>, String> {
    let metadata = tokio::fs::metadata(file).await.map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 20000 {
        return Err("Invalid SSH identity file.".into());
    }
    let bytes = Zeroizing::new(tokio::fs::read(file).await.map_err(|e| e.to_string())?);
    Ok(std::str::from_utf8(&bytes)
        .ok()
        .and_then(|s| decode_private(s, passphrase).ok()))
}
#[derive(Clone)]
pub enum Method {
    Private(Arc<PrivateKey>),
    Agent(String, PublicKey),
}
#[derive(Clone)]
pub struct Identity {
    pub reference: KeyReference,
    pub public_key: String,
    pub fingerprint: String,
    pub method: Method,
}
pub struct System {
    pub address: Address,
    pub identities: Vec<Identity>,
    pub known: HashSet<String>,
    pub algorithms: Vec<String>,
    pub locked: bool,
}
pub async fn agent_identities(socket: &str) -> Result<Vec<PublicKey>, String> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut client = AgentClient::connect_uds(socket)
            .await
            .map_err(|e| e.to_string())?;
        client
            .request_identities()
            .await
            .map(|identities| {
                identities
                    .into_iter()
                    .filter_map(|identity| match identity {
                        russh::keys::agent::AgentIdentity::PublicKey { key, .. } => Some(key),
                        _ => None,
                    })
                    .collect()
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "SSH agent did not respond.".to_owned())?
}
pub async fn resolve(
    command: &str,
    env: &Environment,
    cwd: &str,
    passphrase: Option<&str>,
    cancel: &CancellationToken,
) -> Result<System, Error> {
    let mut args = arguments(command)
        .ok_or_else(|| Error::native("This SSH invocation uses the native client."))?;
    args.insert(0, "-G".into());
    let pool = ProbePool::new(1);
    let options = ProbeOptions {
        cwd: cwd.into(),
        env: env.clone(),
        timeout: Duration::from_secs(4),
        max_buffer: 256 * 1024,
    };
    let result = probes::probe(&pool, "/usr/bin/ssh", &args, &options, cancel)
        .await
        .map_err(Error::regular)?;
    if !result.success {
        return Err(Error::regular(
            String::from_utf8_lossy(&result.stderr).trim().to_owned(),
        ));
    }
    let mut config = BTreeMap::<String, Vec<String>>::new();
    for line in String::from_utf8_lossy(&result.stdout).split('\n') {
        if let Some((key, value)) = line.split_once(' ') {
            config.entry(key.into()).or_default().push(value.into());
        }
    }
    let value = |name: &str| {
        config
            .get(name)
            .and_then(|values| values.first())
            .map(String::as_str)
            .unwrap_or("")
    };
    if [
        "localforward",
        "remoteforward",
        "dynamicforward",
        "localcommand",
        "proxycommand",
        "proxyjump",
        "remotecommand",
        "certificatefile",
        "controlpath",
    ]
    .iter()
    .any(|name| !value(name).is_empty() && value(name) != "none")
        || value("forwardx11") == "yes"
        || value("permitlocalcommand") == "yes"
        || (!value("tunnel").is_empty() && !["false", "no"].contains(&value("tunnel")))
        || value("sessiontype") != "default"
        || value("requesttty") == "no"
        || value("forwardagent") != "no"
    {
        return Err(Error::native(
            "This SSH configuration uses the native client.",
        ));
    }
    let address=address(&serde_json::json!({"host":value("hostname"),"port":value("port").parse::<f64>().unwrap_or(0.0),"username":value("user")})).map_err(Error::regular)?;
    let mut identities = Vec::new();
    let mut allowed = HashSet::new();
    let mut locked = false;
    for identity in config.get("identityfile").into_iter().flatten().take(16) {
        if identity == "none" {
            continue;
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let file = expand(
            &identity
                .replace("%d", &home)
                .replace("%h", &address.host)
                .replace("%r", &address.username)
                .replace("%%", "%"),
            env,
            cwd,
        )?;
        let public = file.clone() + ".pub";
        if let Ok(metadata) = tokio::fs::metadata(&public).await
            && metadata.is_file()
            && metadata.len() <= 20000
            && let Ok(bytes) = tokio::fs::read(&public).await
            && let Ok(text) = std::str::from_utf8(&bytes)
            && let Ok(key) = PublicKey::from_openssh(text)
            && let Ok((_, fingerprint)) = key_info(&key)
        {
            allowed.insert(fingerprint);
        }
        match tokio::fs::metadata(&file).await {
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(Error::regular(error.to_string())),
            Ok(_) => match read_identity(&file, passphrase)
                .await
                .map_err(Error::regular)?
            {
                Some(key) => {
                    let (public_key, fingerprint) =
                        key_info(key.public_key()).map_err(Error::regular)?;
                    allowed.insert(fingerprint.clone());
                    identities.push(Identity {
                        reference: KeyReference {
                            kind: "file".into(),
                            path: file,
                        },
                        public_key,
                        fingerprint,
                        method: Method::Private(Arc::new(key)),
                    });
                }
                None => locked = true,
            },
        }
    }
    let mut socket = if value("identityagent").is_empty() {
        env.get("SSH_AUTH_SOCK").cloned()
    } else {
        Some(value("identityagent").into())
    };
    if socket.as_deref() == Some("SSH_AUTH_SOCK") {
        socket = env.get("SSH_AUTH_SOCK").cloned();
    }
    if let Some(name) = socket.as_deref().and_then(|s| s.strip_prefix('$')) {
        socket = env.get(name).cloned();
    }
    if let Some(socket) = socket.filter(|s| !s.is_empty() && s != "none") {
        let socket = expand(&socket, env, cwd)?;
        let mut agent = Vec::new();
        for key in agent_identities(&socket).await.unwrap_or_default() {
            let (public_key, fingerprint) = key_info(&key).map_err(Error::regular)?;
            if value("identitiesonly") == "yes" && !allowed.contains(&fingerprint) {
                continue;
            }
            agent.push(Identity {
                reference: KeyReference {
                    kind: "agent".into(),
                    path: socket.clone(),
                },
                public_key,
                fingerprint,
                method: Method::Agent(socket.clone(), key),
            });
        }
        agent.sort_by_key(|identity| !allowed.contains(&identity.fingerprint));
        agent.extend(identities);
        identities = agent;
    }
    let mut known = HashSet::new();
    let mut algorithms = Vec::new();
    let host_key = if !value("hostkeyalias").is_empty() {
        value("hostkeyalias").into()
    } else if address.port == 22 {
        address.host.clone()
    } else {
        format!("[{}]:{}", address.host, address.port)
    };
    for line in ["userknownhostsfile", "globalknownhostsfile"]
        .iter()
        .flat_map(|name| config.get(*name).into_iter().flatten())
    {
        let files = line.split(' ').collect::<Vec<_>>();
        if files.len() > 1
            && files.iter().any(|s| {
                !s.starts_with('/') && !s.starts_with("~/") && !s.as_bytes().starts_with(b"${")
            })
        {
            return Err(Error::native(
                "This SSH known-hosts path uses the native client.",
            ));
        }
        for file in files {
            if file.is_empty() || file == "none" {
                continue;
            }
            let options = ProbeOptions {
                timeout: Duration::from_secs(2),
                ..options.clone()
            };
            if let Ok(result) = probes::probe(
                &pool,
                "/usr/bin/ssh-keygen",
                &[
                    "-F".into(),
                    host_key.clone(),
                    "-f".into(),
                    expand(file, env, cwd)?,
                ],
                &options,
                cancel,
            )
            .await
            {
                for line in String::from_utf8_lossy(&result.stdout)
                    .split('\n')
                    .filter(|s| !s.is_empty() && !s.starts_with('#'))
                {
                    if line.starts_with('@') {
                        return Err(Error::native(
                            "Certificate or revoked host entries use the native SSH client.",
                        ));
                    }
                    let text = line
                        .split_whitespace()
                        .skip(1)
                        .take(2)
                        .collect::<Vec<_>>()
                        .join(" ");
                    if let Ok(key) = PublicKey::from_openssh(&text) {
                        known.insert(key_info(&key).map_err(Error::regular)?.1);
                        let kind = key.algorithm().as_str().to_owned();
                        for algorithm in if kind == "ssh-rsa" {
                            vec![
                                "rsa-sha2-512".into(),
                                "rsa-sha2-256".into(),
                                "ssh-rsa".into(),
                            ]
                        } else {
                            vec![kind]
                        } {
                            if !algorithms.contains(&algorithm) {
                                algorithms.push(algorithm);
                            }
                        }
                    }
                }
            }
        }
    }
    identities.truncate(16);
    Ok(System {
        address,
        identities,
        known,
        algorithms,
        locked,
    })
}
