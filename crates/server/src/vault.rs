use crate::storage::{atomic_write, random_uuid};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};
use zeroize::Zeroizing;

fn error(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn password(value: &str) -> io::Result<()> {
    if value.is_empty() {
        Err(error("Enter a key passphrase."))
    } else {
        Ok(())
    }
}
fn derive(passphrase: &str, salt: &[u8]) -> io::Result<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0; 32]);
    let params = scrypt::Params::new(15, 8, 1, 32).expect("reference scrypt parameters");
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut *key)
        .map_err(|_| error("Invalid scrypt parameters."))?;
    Ok(key)
}
pub fn fingerprint(bytes: &[u8]) -> String {
    format!(
        "SHA256:{}",
        STANDARD.encode(Sha256::digest(bytes)).trim_end_matches('=')
    )
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyReference {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<KeyReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnownHost {
    pub host: String,
    #[serde(deserialize_with = "host_port")]
    pub port: u16,
    pub fingerprint: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
fn host_port<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u16, D::Error> {
    let value = Value::deserialize(deserializer)?;
    value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (1.0..=65535.0).contains(n))
        .map(|n| n as u16)
        .ok_or_else(|| serde::de::Error::custom("Invalid known-host port."))
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedKey {
    pub public_key: String,
    pub fingerprint: String,
}
pub fn inspect_private_key(raw: &str, passphrase: &str) -> io::Result<InspectedKey> {
    password(passphrase)?;
    if raw.is_empty() || raw.encode_utf16().count() > 20000 {
        return Err(error("Invalid private key."));
    }
    if !raw
        .trim()
        .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
    {
        let parsed = crate::system_ssh::decode_private(raw, Some(passphrase)).map_err(|_| {
            error("Cannot unlock this private key. Check its passphrase and format.")
        })?;
        let (public_key, fingerprint) = crate::system_ssh::key_info(parsed.public_key())
            .map_err(|_| error("Invalid public key."))?;
        return Ok(InspectedKey {
            public_key,
            fingerprint,
        });
    }
    // ssh2 writes 64-column PEM; ssh-key's PEM reader assumes OpenSSH's
    // 70-column wrapping. Decode the unchanged body independently of wrapping.
    let body = raw
        .trim()
        .strip_prefix("-----BEGIN OPENSSH PRIVATE KEY-----")
        .and_then(|text| text.strip_suffix("-----END OPENSSH PRIVATE KEY-----"))
        .ok_or_else(|| error("Cannot unlock this private key. Check its passphrase and format."))?;
    let encoded = Zeroizing::new(
        body.chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect::<String>(),
    );
    let bytes =
        Zeroizing::new(STANDARD.decode(encoded.as_bytes()).map_err(|_| {
            error("Cannot unlock this private key. Check its passphrase and format.")
        })?);
    let parsed = PrivateKey::from_bytes(&bytes)
        .map_err(|_| error("Cannot unlock this private key. Check its passphrase and format."))?;
    let parsed = if parsed.is_encrypted() {
        parsed.decrypt(passphrase).map_err(|_| {
            error("Cannot unlock this private key. Check its passphrase and format.")
        })?
    } else {
        parsed
    };
    let public = parsed.public_key();
    let wire = public
        .to_bytes()
        .map_err(|_| error("Invalid public key."))?;
    // Metadata excludes comments, matching ssh2's public SSH blob output.
    let algorithm = public.algorithm().as_str().to_owned();
    Ok(InspectedKey {
        public_key: format!("{algorithm} {}", STANDARD.encode(&wire)),
        fingerprint: fingerprint(&wire),
    })
}
#[derive(Clone, Serialize, Deserialize)]
struct StoredKey {
    #[serde(flatten)]
    info: KeyInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    iv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    keys: Vec<StoredKey>,
    known_hosts: Vec<KnownHost>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Keychain {
    pub keys: Vec<KeyInfo>,
    pub known_hosts: Vec<KnownHost>,
}
pub struct Vault {
    file: PathBuf,
    queue: Mutex<()>,
}
impl Vault {
    pub fn new(directory: &Path) -> Self {
        Self {
            file: directory.join("vault.json"),
            queue: Mutex::new(()),
        }
    }
    fn load(&self) -> io::Result<Data> {
        match fs::read(&self.file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Data::default()),
            Err(error) => Err(error),
        }
    }
    fn change<T>(&self, work: impl FnOnce(&mut Data) -> io::Result<T>) -> io::Result<T> {
        let _guard = self
            .queue
            .lock()
            .map_err(|_| error("Vault mutation failed."))?;
        let mut data = self.load()?;
        let result = work(&mut data)?;
        atomic_write(&self.file, &serde_json::to_vec(&data)?)?;
        Ok(result)
    }
    pub fn list(&self) -> io::Result<Keychain> {
        let _guard = self
            .queue
            .lock()
            .map_err(|_| error("Vault mutation failed."))?;
        let data = self.load()?;
        Ok(Keychain {
            keys: data.keys.into_iter().map(|key| key.info).collect(),
            known_hosts: data.known_hosts,
        })
    }
    pub fn create(
        &self,
        name: &str,
        passphrase: &str,
        private_key: Option<&str>,
        replace_id: Option<&str>,
    ) -> io::Result<KeyInfo> {
        password(passphrase)?;
        if name.trim().is_empty() || name.encode_utf16().count() > 100 {
            return Err(error("Name the SSH key (up to 100 characters)."));
        }
        if private_key.is_some_and(|raw| raw.encode_utf16().count() > 20000) {
            return Err(error("Invalid private key."));
        }
        let generated = if private_key.is_none_or(str::is_empty) {
            Some(
                PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
                    .map_err(io::Error::other)?
                    .to_openssh(LineEnding::LF)
                    .map_err(io::Error::other)?,
            )
        } else {
            None
        };
        let raw = private_key
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| generated.as_ref().unwrap().as_str());
        let inspected = inspect_private_key(raw, passphrase)?;
        let (mut salt, mut iv) = ([0; 16], [0; 12]);
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut iv);
        let key = derive(passphrase, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&*key).expect("32-byte AES key");
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&iv), raw.as_bytes())
            .map_err(|_| error("Could not encrypt the SSH key."))?;
        let split = encrypted.len() - 16;
        let id = random_uuid();
        let mut stored = StoredKey {
            info: KeyInfo {
                id,
                name: name.trim().into(),
                public_key: inspected.public_key,
                fingerprint: inspected.fingerprint,
                created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                reference: None,
            },
            salt: Some(STANDARD.encode(salt)),
            iv: Some(STANDARD.encode(iv)),
            tag: Some(STANDARD.encode(&encrypted[split..])),
            ciphertext: Some(STANDARD.encode(&encrypted[..split])),
            extra: Default::default(),
        };
        self.change(|data| {
            if let Some(index) =
                replace_id.and_then(|id| data.keys.iter().position(|key| key.info.id == id))
            {
                let previous = &data.keys[index];
                if previous.info.reference.is_some() {
                    return Err(error(
                        "A key reference cannot be overwritten with a stored key.",
                    ));
                }
                if previous.info.fingerprint != stored.info.fingerprint {
                    return Err(error("This backup belongs to a different SSH key."));
                }
                stored.info.id = previous.info.id.clone();
                data.keys[index] = stored.clone();
            } else {
                if data.keys.len() >= 64 {
                    return Err(error("The keychain holds up to 64 keys."));
                }
                data.keys.push(stored.clone());
            }
            Ok(stored.info.clone())
        })
    }
    pub fn reference(
        &self,
        name: &str,
        public_key: &str,
        fingerprint: &str,
        reference: KeyReference,
    ) -> io::Result<KeyInfo> {
        if !Path::new(&reference.path).is_absolute()
            || !["file", "agent"].contains(&reference.kind.as_str())
        {
            return Err(error("Invalid SSH key reference."));
        }
        self.change(|data| {
            if let Some(existing) = data.keys.iter().find(|key| {
                key.info.fingerprint == fingerprint
                    && key.info.reference.as_ref() == Some(&reference)
            }) {
                return Ok(existing.info.clone());
            }
            if data.keys.len() >= 64 {
                return Err(error("The keychain holds up to 64 keys."));
            }
            let info = KeyInfo {
                id: random_uuid(),
                name: name
                    .chars()
                    .scan(0, |units, c| {
                        *units += c.len_utf16();
                        if *units <= 100 { Some(c) } else { None }
                    })
                    .collect(),
                public_key: public_key.into(),
                fingerprint: fingerprint.into(),
                reference: Some(reference),
                created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            };
            data.keys.push(StoredKey {
                info: info.clone(),
                salt: None,
                iv: None,
                tag: None,
                ciphertext: None,
                extra: Default::default(),
            });
            Ok(info)
        })
    }
    pub fn unlock(&self, id: &str, passphrase: &str) -> io::Result<Zeroizing<Vec<u8>>> {
        password(passphrase)?;
        let _guard = self
            .queue
            .lock()
            .map_err(|_| error("Vault mutation failed."))?;
        let data = self.load()?;
        let item = data
            .keys
            .iter()
            .find(|key| key.info.id == id)
            .ok_or_else(|| error("SSH key not found on this backend."))?;
        if item.info.reference.is_some() {
            return Err(error(
                "This key is an external reference. Export it from its original location.",
            ));
        }
        let decode = |value: &Option<String>| {
            STANDARD
                .decode(
                    value
                        .as_deref()
                        .ok_or_else(|| error("Invalid stored key."))?,
                )
                .map_err(|_| error("Invalid stored key."))
        };
        let (salt, iv, tag) = (decode(&item.salt)?, decode(&item.iv)?, decode(&item.tag)?);
        if salt.len() != 16 || iv.len() != 12 || tag.len() != 16 {
            return Err(error("Invalid stored key."));
        }
        let mut ciphertext = decode(&item.ciphertext)?;
        ciphertext.extend_from_slice(&tag);
        let key = derive(passphrase, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&*key).expect("32-byte AES key");
        cipher
            .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
            .map(Zeroizing::new)
            .map_err(|_| error("Incorrect key passphrase."))
    }
    pub fn remove(&self, id: &str) -> io::Result<()> {
        self.change(|data| {
            data.keys.retain(|key| key.info.id != id);
            Ok(())
        })
    }
    pub fn rename(&self, id: &str, name: &str) -> io::Result<()> {
        if name.trim().is_empty() || name.encode_utf16().count() > 100 {
            return Err(error("Enter a key name."));
        }
        self.change(|data| {
            let key = data
                .keys
                .iter_mut()
                .find(|key| key.info.id == id)
                .ok_or_else(|| error("Key not found."))?;
            key.info.name = name.trim().into();
            Ok(())
        })
    }
    pub fn trust(&self, host: &str, port: u16, fingerprint: &str) -> io::Result<()> {
        self.change(|data| {
            if let Some(existing) = data.known_hosts.iter().find(|pin| pin.host == host && pin.port == port) {
                if existing.fingerprint != fingerprint { return Err(error("Host key changed. Remove its known-host entry only after verifying the new fingerprint.")); }
            } else {
                if data.known_hosts.len() >= 1000 { return Err(error("Known-host limit reached.")); }
                data.known_hosts.push(KnownHost { host: host.into(), port, fingerprint: fingerprint.into(), extra:Default::default() });
            }
            Ok(())
        })
    }
    pub fn forget(&self, host: &str, port: u16) -> io::Result<()> {
        self.change(|data| {
            data.known_hosts
                .retain(|pin| pin.host != host || pin.port != port);
            Ok(())
        })
    }
}
