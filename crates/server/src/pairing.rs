use crate::storage::{atomic_write, create_private, private_directory, random_hex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub fn token_matches(expected: &str, supplied: &str) -> bool {
    expected.as_bytes().ct_eq(supplied.as_bytes()).into()
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn validate(token: &str) -> io::Result<String> {
    if token.encode_utf16().count() < 24 || token.trim() != token || token.contains(['\r', '\n']) {
        return Err(invalid(
            "The pairing token must contain at least 24 characters with no surrounding whitespace. Check TERMAI_TOKEN or pairing-token in TERMAI_DATA_DIR.",
        ));
    }
    Ok(token.into())
}
pub fn pairing_token(directory: &Path, configured: Option<&str>) -> io::Result<String> {
    if let Some(token) = configured.filter(|token| !token.is_empty()) {
        return validate(token);
    }
    let file = directory.join("pairing-token");
    match fs::read_to_string(&file) {
        Ok(token) => return validate(token.trim_end()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    private_directory(directory)?;
    let token = random_hex(32);
    match create_private(&file, format!("{token}\n").as_bytes()) {
        Ok(()) => Ok(token),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            validate(fs::read_to_string(file)?.trim_end())
        }
        Err(error) => Err(error),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    version: serde_json::Number,
    token_hash: String,
    credentials: Vec<String>,
}
pub struct Pairings {
    file: PathBuf,
    token_hash: String,
    credentials: Vec<String>,
}
impl Pairings {
    pub fn open(directory: &Path, token: &str) -> io::Result<Self> {
        let mut registry = Self {
            file: directory.join("paired-clients.json"),
            token_hash: digest(token),
            credentials: vec![],
        };
        let data: Data = match fs::read(&registry.file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid paired-clients.json. Restore it or remove it to revoke saved pairings."))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(registry),
            Err(error) => return Err(error),
        };
        if data.version.as_f64() != Some(1.0)
            || !valid_digest(&data.token_hash)
            || data.credentials.len() > 256
            || !data.credentials.iter().all(|value| valid_digest(value))
        {
            return Err(invalid(
                "Invalid paired-clients.json. Restore it or remove it to revoke saved pairings.",
            ));
        }
        if data.token_hash == registry.token_hash {
            for credential in data.credentials {
                if !registry.credentials.contains(&credential) {
                    registry.credentials.push(credential);
                }
            }
        } else {
            registry.save(&[])?;
        }
        Ok(registry)
    }
    pub fn len(&self) -> usize {
        self.credentials.len()
    }
    pub fn is_empty(&self) -> bool {
        self.credentials.is_empty()
    }
    pub fn has(&self, credential: &str) -> bool {
        valid_digest(credential) && self.has_digest(&digest(credential))
    }
    pub fn has_digest(&self, hash: &str) -> bool {
        self.credentials.iter().any(|value| value == hash)
    }
    pub fn issue(&mut self) -> io::Result<String> {
        if self.len() >= 256 {
            return Err(invalid(
                "The saved pairing limit has been reached. Revoke old pairings before adding more.",
            ));
        }
        let credential = random_hex(32);
        let mut next = self.credentials.clone();
        next.push(digest(&credential));
        self.save(&next)?;
        self.credentials = next;
        Ok(credential)
    }
    fn save(&self, credentials: &[String]) -> io::Result<()> {
        atomic_write(
            &self.file,
            &serde_json::to_vec(&Data {
                version: 1.into(),
                token_hash: self.token_hash.clone(),
                credentials: credentials.to_vec(),
            })?,
        )
    }
}
