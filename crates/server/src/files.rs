use crate::filesystem::FileSystem;
use axum::body::Body;
use futures::{StreamExt, future::BoxFuture};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_UPLOAD: u64 = 1024 * 1024 * 1024;
pub const MAX_IMAGE: usize = 20 * 1024 * 1024;

pub async fn upload_image_on(fs: &FileSystem, name: &str, body: Body) -> Result<Value> {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !valid_name(name) || !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return Err(Error::new("Choose a PNG, JPEG, WebP or GIF image.", 400));
    }
    let bytes = axum::body::to_bytes(body, MAX_IMAGE)
        .await
        .map_err(|_| Error::new("Images are limited to 20 MB per file.", 413))?;
    if bytes.is_empty() {
        return Err(Error::new("Choose a nonempty image.", 400));
    }
    let name = format!(
        "termai-image-{}.{}",
        crate::storage::random_hex(16),
        extension
    );
    upload_on(fs, "/tmp", "/tmp", "/tmp", &name, Body::from(bytes), None).await?;
    Ok(json!({"path":format!("/tmp/{name}")}))
}
#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub message: String,
}
impl Error {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        match error.raw_os_error() {
            Some(libc::EEXIST) => Self::new(
                "A file with that name already exists. Rename your file before uploading.",
                409,
            ),
            Some(libc::ENOENT) => Self::new("File or directory not found.", 404),
            Some(libc::EACCES | libc::EPERM) => {
                Self::new("Permission denied for this file or directory.", 403)
            }
            _ => Self::new(error.to_string(), 400),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn file_path(cwd: &str, home: &str, input: &str) -> Result<String> {
    if input.is_empty() || input.encode_utf16().count() > 4096 || input.contains('\0') {
        return Err(Error::new("Enter a file path.", 400));
    }
    let expanded = if input == "~" {
        home.into()
    } else if let Some(tail) = input.strip_prefix("~/") {
        termai_engine::path::join(&[home, tail])
    } else {
        input.into()
    };
    Ok(termai_engine::path::resolve(&[cwd, &expanded]))
}
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 255
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c < '\x20' || c == '\x7f')
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub directory: bool,
    pub symlink: bool,
    pub size: u64,
    pub modified: f64,
    pub mode: u32,
}
#[derive(Serialize)]
pub struct Listing {
    pub path: String,
    pub parent: String,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}
pub async fn list_files(cwd: &str, home: &str, input: &str) -> Result<Listing> {
    list_files_on(&FileSystem::default(), cwd, home, input).await
}
pub async fn list_files_on(fs: &FileSystem, cwd: &str, home: &str, input: &str) -> Result<Listing> {
    let directory = file_path(cwd, home, input)?;
    let (mut entries, truncated) = fs.read_entries(&directory).await?;
    let mut preferences = icu_collator::CollatorPreferences::default();
    preferences.numeric_ordering = Some(icu_collator::preferences::CollationNumericOrdering::True);
    let collator = icu_collator::Collator::try_new(preferences, Default::default())
        .expect("compiled Unicode collation");
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| collator.compare(&a.name, &b.name))
    });
    Ok(Listing {
        parent: termai_engine::path::dirname(&directory),
        path: directory,
        entries,
        truncated,
    })
}
pub async fn make_directory(cwd: &str, home: &str, input: &str, name: &str) -> Result<Value> {
    make_directory_on(&FileSystem::default(), cwd, home, input, name).await
}
pub async fn make_directory_on(
    fs: &FileSystem,
    cwd: &str,
    home: &str,
    input: &str,
    name: &str,
) -> Result<Value> {
    if !valid_name(name) {
        return Err(Error::new("Enter a valid folder name.", 400));
    }
    let target = termai_engine::path::join(&[&file_path(cwd, home, input)?, name]);
    fs.create_directory(&target, 0o755).await?;
    Ok(json!({"path":target}))
}
/// Owned temporary or exclusive output is removed if its future is cancelled.
struct RemoveOnDrop {
    path: String,
    committed: bool,
    fs: FileSystem,
}
impl RemoveOnDrop {
    fn new(path: String, fs: &FileSystem) -> Self {
        Self {
            path,
            committed: false,
            fs: fs.clone(),
        }
    }
}
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if !self.committed {
            self.fs.remove_on_drop(self.path.clone());
        }
    }
}
pub async fn upload(
    cwd: &str,
    home: &str,
    directory: &str,
    name: &str,
    body: Body,
    length: Option<&str>,
) -> Result<Value> {
    upload_on(
        &FileSystem::default(),
        cwd,
        home,
        directory,
        name,
        body,
        length,
    )
    .await
}
pub async fn upload_on(
    fs: &FileSystem,
    cwd: &str,
    home: &str,
    directory: &str,
    name: &str,
    body: Body,
    length: Option<&str>,
) -> Result<Value> {
    if !valid_name(name) {
        return Err(Error::new("Choose a valid file name.", 400));
    }
    let directory = file_path(cwd, home, directory)?;
    if !fs.metadata(&directory, true).await?.is_dir() {
        return Err(Error::new("Upload destination is not a directory.", 400));
    }
    let too_large = || Error::new("Uploads are limited to 1 GB per file.", 413);
    if length
        .and_then(|s| s.parse::<f64>().ok())
        .is_some_and(|n| n > MAX_UPLOAD as f64)
    {
        return Err(too_large());
    }
    let file = termai_engine::path::join(&[&directory, name]);
    let mut output = fs.create_new(&file, 0o600).await?;
    let mut guard = RemoveOnDrop::new(file, fs);
    let work = async {
        let mut input = body.into_data_stream();
        let mut bytes = 0u64;
        while let Some(chunk) = input.next().await {
            let chunk = chunk.map_err(|e| Error::new(e.to_string(), 400))?;
            bytes += chunk.len() as u64;
            if bytes > MAX_UPLOAD {
                return Err(too_large());
            }
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        output.shutdown().await?;
        Ok(json!({"name":name,"bytes":bytes}))
    };
    let result = tokio::time::timeout(Duration::from_secs(30 * 60), work)
        .await
        .map_err(|_| Error::new("The operation was aborted due to timeout", 400))??;
    guard.committed = true;
    Ok(result)
}
async fn text_file(fs: &FileSystem, file: &str) -> Result<Value> {
    let info = fs.metadata(file, false).await?;
    let too_large = || Error::new("Edit supports text files up to 32 KB.", 400);
    if !info.is_file() || info.len() > 32768 {
        return Err(too_large());
    }
    let handle = fs.open_read(file).await?;
    let mut bytes = vec![];
    handle.take(32769).read_to_end(&mut bytes).await?;
    if bytes.len() > 32768 {
        return Err(too_large());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Error::new("This is not a UTF-8 text file.", 400))?;
    if text.contains('\0') {
        return Err(Error::new("Binary files cannot be edited as text.", 400));
    }
    // TextDecoder removes a leading UTF-8 BOM but hashes the original bytes.
    Ok(
        json!({"text":text.strip_prefix('\u{feff}').unwrap_or(text),"version":format!("{:x}",Sha256::digest(&bytes)),"mode":info.mode()}),
    )
}
async fn absent(fs: &FileSystem, file: &str) -> Result<()> {
    match fs.metadata(file, false).await {
        Err(error) if error.status == 404 => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(Error::new("A file with that name already exists.", 409)),
    }
}
pub async fn action(cwd: &str, home: &str, input: &Value) -> Result<Value> {
    action_on(&FileSystem::default(), cwd, home, input).await
}
pub async fn action_on<I: TryInto<crate::protocol::requests::FileAction>>(
    fs: &FileSystem,
    cwd: &str,
    home: &str,
    input: I,
) -> Result<Value>
where
    I::Error: std::fmt::Display,
{
    let input = input
        .try_into()
        .map_err(|error| Error::new(format!("Invalid file action: {error}"), 400))?;
    let kind = input.action.as_str();
    if ["read", "write", "rename"].contains(&kind) {
        let file = file_path(cwd, home, input.path.as_deref().unwrap_or(""))?;
        if kind == "rename" {
            let name = input
                .name
                .as_deref()
                .filter(|s| valid_name(s))
                .ok_or_else(|| Error::new("Enter a valid file name.", 400))?;
            let destination =
                termai_engine::path::join(&[&termai_engine::path::dirname(&file), name]);
            if destination != file {
                absent(fs, &destination).await?;
                fs.rename(&file, &destination, false).await?;
            }
            return Ok(json!({"ok":true}));
        }
        let original = text_file(fs, &file).await?;
        if kind == "read" {
            return Ok(original);
        }
        let content = input
            .text
            .as_deref()
            .filter(|s| s.len() <= 32768 && !s.contains('\0'))
            .ok_or_else(|| Error::new("Edit supports text files up to 32 KB.", 400))?;
        if json!(input.version) != original["version"] {
            return Err(Error::new(
                "The file changed since you opened it. Reopen it before saving.",
                409,
            ));
        }
        let temporary = termai_engine::path::join(&[
            &termai_engine::path::dirname(&file),
            &format!(".termai-edit-{}", crate::storage::random_hex(12)),
        ]);
        let mut output = fs
            .create_new(
                &temporary,
                original["mode"].as_u64().unwrap() as u32 & 0o777,
            )
            .await?;
        let _guard = RemoveOnDrop::new(temporary.clone(), fs);
        tokio::time::timeout(Duration::from_secs(30), async {
            output.write_all(content.as_bytes()).await?;
            output.flush().await?;
            output.shutdown().await?;
            if text_file(fs, &file).await?["version"] != original["version"] {
                return Err(Error::new(
                    "The file changed while saving. Reopen it before saving.",
                    409,
                ));
            }
            fs.rename(&temporary, &file, true).await?;
            Ok::<_, Error>(())
        })
        .await
        .map_err(|_| Error::new("The operation was aborted due to timeout", 400))??;
        return Ok(json!({"ok":true}));
    }
    let paths = input
        .paths
        .as_deref()
        .filter(|p| !p.is_empty() && p.len() <= 100)
        .filter(|_| ["copy", "delete"].contains(&kind))
        .ok_or_else(|| Error::new("Select between 1 and 100 items.", 400))?;
    let mut seen = HashSet::new();
    let mut files = vec![];
    for value in paths {
        let file = file_path(cwd, home, value.as_str())?;
        if seen.insert(file.clone()) {
            files.push(file)
        }
    }
    if files.iter().any(|f| f == "/") {
        return Err(Error::new("The filesystem root cannot be changed.", 400));
    }
    let destination = if kind == "copy" {
        file_path(cwd, home, input.destination.as_deref().unwrap_or(""))?
    } else {
        String::new()
    };
    if !destination.is_empty() && !fs.metadata(&destination, false).await?.is_dir() {
        return Err(Error::new("Choose a destination folder.", 400));
    }
    let mut targets = vec![];
    for file in &files {
        let target = if destination.is_empty() {
            None
        } else {
            Some(termai_engine::path::join(&[
                &destination,
                &termai_engine::path::basename(file),
            ]))
        };
        if let Some(target) = &target {
            if target == file || target.starts_with(&format!("{file}/")) {
                return Err(Error::new(
                    "Choose a destination outside the selected folder.",
                    400,
                ));
            }
            absent(fs, target).await?;
        }
        targets.push(target);
    }
    let mut budget = Budget {
        count: 0,
        bytes: 0,
        deadline: Instant::now() + Duration::from_secs(120),
    };
    for (file, target) in files.iter().zip(targets.iter()) {
        visit(fs, file, target.as_deref(), 0, &mut budget).await?
    }
    Ok(json!({"ok":true}))
}
struct Budget {
    count: usize,
    bytes: u64,
    deadline: Instant,
}
fn visit<'a>(
    fs: &'a FileSystem,
    file: &'a str,
    to: Option<&'a str>,
    depth: usize,
    budget: &'a mut Budget,
) -> BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        budget.count += 1;
        if budget.count > 10000 || depth > 32 || Instant::now() > budget.deadline {
            return Err(Error::new(
                "Operation limit reached. Select fewer items.",
                400,
            ));
        }
        let info = fs.metadata(file, false).await?;
        if let Some(to) = to {
            absent(fs, to).await?
        }
        if info.is_symlink() {
            if let Some(to) = to {
                fs.symlink(&fs.read_link(file).await?, to).await?
            } else {
                fs.remove(file, false).await?
            }
        } else if info.is_dir() {
            let listing = list_files_on(fs, "/", "/", file).await?;
            if listing.truncated {
                return Err(Error::new(
                    "Folder has too many entries. Select a smaller folder.",
                    400,
                ));
            }
            if let Some(to) = to {
                fs.create_directory(to, info.mode() & 0o777).await?;
            }
            for child in listing.entries {
                let from = Path::new(file)
                    .join(&child.name)
                    .to_string_lossy()
                    .into_owned();
                let target = to.map(|to| {
                    Path::new(to)
                        .join(&child.name)
                        .to_string_lossy()
                        .into_owned()
                });
                visit(fs, &from, target.as_deref(), depth + 1, budget).await?;
            }
            if to.is_none() {
                fs.remove(file, true).await?;
            }
        } else if info.is_file() {
            if let Some(to) = to {
                budget.bytes += info.len();
                if budget.bytes > MAX_UPLOAD {
                    return Err(Error::new("Copy is limited to 1 GB per operation.", 400));
                }
                let mut source = fs.open_read(file).await?;
                let mut target = fs.create_new(to, info.mode() & 0o777).await?;
                let mut guard = RemoveOnDrop::new(to.into(), fs);
                tokio::time::timeout(
                    Duration::from_secs(120),
                    tokio::io::copy(&mut source, &mut target),
                )
                .await
                .map_err(|_| Error::new("The operation was aborted due to timeout", 400))??;
                target.flush().await?;
                target.shutdown().await?;
                guard.committed = true;
            } else {
                fs.remove(file, false).await?;
            }
        } else {
            return Err(Error::new(
                "Only regular files, folders and links are supported.",
                400,
            ));
        }
        Ok(())
    })
}
