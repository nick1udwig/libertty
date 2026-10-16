use crate::{
    files::{self, Error, Result},
    storage,
};
use libertty_engine::{truncate_utf16, utf16_len};
use serde::Serialize;
use std::collections::VecDeque;
use tokio::io::AsyncReadExt;
pub const MAX_READING_BYTES: usize = 20 * 1024 * 1024;
pub fn mime(file: &str, data: &[u8]) -> &'static str {
    match std::path::Path::new(file)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "xml" => "application/xml",
        "txt" | "log" | "jsonl" | "yaml" | "yml" | "toml" | "html" | "htm" | "css" | "js"
        | "ts" | "tsx" | "jsx" | "py" | "sh" | "bash" | "go" | "rs" | "c" | "h" | "cpp"
        | "java" | "sql" | "svg" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => {
            if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
                "image/png"
            } else if data.starts_with(&[255, 216, 255]) {
                "image/jpeg"
            } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
                "image/gif"
            } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else if data.starts_with(b"%PDF-") {
                "application/pdf"
            } else if data[..data.len().min(4096)].contains(&0)
                || std::str::from_utf8(data).is_err()
            {
                "application/octet-stream"
            } else {
                "text/plain"
            }
        }
    }
}
pub struct File {
    pub path: String,
    pub data: Vec<u8>,
    pub mime: &'static str,
}
pub async fn read(cwd: &str, home: &str, input: &str) -> Result<File> {
    if input.is_empty()
        || utf16_len(input) > 4096
        || input.chars().any(|c| c < '\x20' || c == '\x7f')
    {
        return Err(Error::new("Enter a file path.", 400));
    }
    let file = files::file_path(cwd, home, input)?;
    let info = tokio::fs::metadata(&file).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::new("File not found.", 404)
        } else {
            e.into()
        }
    })?;
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
    let handle = tokio::fs::File::open(&file).await?;
    let mut data = vec![];
    handle
        .take(MAX_READING_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .await?;
    if data.len() > MAX_READING_BYTES {
        return Err(too_large());
    }
    Ok(File {
        mime: mime(&file, &data),
        path: file,
        data,
    })
}
pub fn strip_vt(text: &str) -> String {
    let pattern = r"[\x1b\x9b][\[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))";
    static REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    REGEX
        .get_or_init(|| regex::Regex::new(pattern).unwrap())
        .replace_all(text, "")
        .into_owned()
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub id: String,
    pub name: String,
    pub exit_code: u8,
}
#[derive(Clone)]
pub struct Capture {
    pub id: String,
    pub name: String,
    pub data: Vec<u8>,
    pub mime: &'static str,
    pub pending: bool,
    pub exit_code: u8,
}
impl Capture {
    pub fn descriptor(&self) -> Descriptor {
        Descriptor {
            id: self.id.clone(),
            name: self.name.clone(),
            exit_code: self.exit_code,
        }
    }
}
#[derive(Default)]
pub struct Captures {
    entries: VecDeque<Capture>,
    bytes: usize,
}
impl Captures {
    pub fn add(&mut self, name: &str, mut data: Vec<u8>, exit_code: u8) -> Result<Descriptor> {
        if data.len() > MAX_READING_BYTES {
            return Err(Error::new(
                "Reading Mode output exceeds the 20 MB limit.",
                400,
            ));
        }
        let mime = mime("", &data);
        if mime.starts_with("text/") {
            data = strip_vt(&String::from_utf8_lossy(&data)).into_bytes()
        }
        while self.entries.len() >= 16 || self.bytes + data.len() > 64 * 1024 * 1024 {
            let Some(old) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.data.len();
        }
        let stripped = strip_vt(name)
            .chars()
            .map(|c| if c < '\x20' || c == '\x7f' { ' ' } else { c })
            .collect::<String>();
        let name = truncate_utf16(stripped.trim(), 180).to_owned();
        let capture = Capture {
            id: storage::random_hex(16),
            name: if name.is_empty() {
                "Command output".into()
            } else {
                name
            },
            data,
            mime,
            pending: true,
            exit_code,
        };
        self.bytes += capture.data.len();
        let descriptor = capture.descriptor();
        self.entries.push_back(capture);
        Ok(descriptor)
    }
    pub fn get(&mut self, id: &str) -> Option<Capture> {
        let entry = self.entries.iter_mut().find(|c| c.id == id)?;
        entry.pending = false;
        Some(entry.clone())
    }
    pub fn pending(&self) -> Vec<Descriptor> {
        self.entries
            .iter()
            .filter(|c| c.pending)
            .map(Capture::descriptor)
            .collect()
    }
    pub fn remove(&mut self, id: &str) {
        if let Some(at) = self.entries.iter().position(|c| c.id == id) {
            self.bytes -= self.entries.remove(at).unwrap().data.len()
        }
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0
    }
}
