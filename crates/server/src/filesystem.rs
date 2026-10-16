use crate::{
    files::{Entry, Error, Result},
    ssh::SSHHost,
};
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use std::{os::unix::fs::MetadataExt, sync::Arc, time::Duration};
use tokio::{
    fs,
    io::{AsyncRead, AsyncSeekExt, AsyncWrite},
};
pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;
#[derive(Clone, Default)]
pub struct FileSystem {
    pub remote: Option<Arc<SSHHost>>,
}
pub struct Metadata {
    size: u64,
    mode: u32,
    modified: f64,
}
impl Metadata {
    pub fn len(&self) -> u64 {
        self.size
    }
    /// Size and modification time, which change when the file's content does.
    pub fn version(&self) -> (u64, f64) {
        (self.size, self.modified)
    }
    pub fn is_empty(&self) -> bool {
        self.size == 0
    }
    pub fn mode(&self) -> u32 {
        self.mode
    }
    pub fn is_file(&self) -> bool {
        self.mode & 0o170000 == 0o100000
    }
    pub fn is_dir(&self) -> bool {
        self.mode & 0o170000 == 0o040000
    }
    pub fn is_symlink(&self) -> bool {
        self.mode & 0o170000 == 0o120000
    }
}
impl From<FileAttributes> for Metadata {
    fn from(value: FileAttributes) -> Self {
        Self {
            size: value.len(),
            mode: value.permissions.unwrap_or_default(),
            modified: value.mtime.unwrap_or_default() as f64 * 1000.0,
        }
    }
}
impl From<std::fs::Metadata> for Metadata {
    fn from(value: std::fs::Metadata) -> Self {
        Self {
            size: value.len(),
            mode: value.mode(),
            modified: value.mtime() as f64 * 1000.0 + value.mtime_nsec() as f64 / 1e6,
        }
    }
}
impl From<SftpError> for Error {
    fn from(error: SftpError) -> Self {
        if let SftpError::Status(status) = &error {
            return match status.status_code {
                StatusCode::NoSuchFile => Error::new("File or directory not found.", 404),
                StatusCode::PermissionDenied => {
                    Error::new("Permission denied for this file or directory.", 403)
                }
                _ => Error::new(error.to_string(), 400),
            };
        }
        Error::new(error.to_string(), 400)
    }
}
async fn call<T>(
    work: impl std::future::Future<Output = std::result::Result<T, SftpError>>,
) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(15), work)
        .await
        .map_err(|_| Error::new("The remote filesystem did not respond.", 504))?
        .map_err(Into::into)
}
struct DirectoryGuard {
    host: Arc<SSHHost>,
    handle: String,
}
impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        let host = self.host.clone();
        let handle = self.handle.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = host.raw.close(handle).await;
            });
        }
    }
}
impl FileSystem {
    pub async fn metadata(&self, file: &str, follow: bool) -> Result<Metadata> {
        if let Some(host) = &self.remote {
            let info = if follow {
                call(host.files.metadata(file)).await?
            } else {
                call(host.files.symlink_metadata(file)).await?
            };
            Ok(info.into())
        } else {
            Ok(if follow {
                fs::metadata(file).await?
            } else {
                fs::symlink_metadata(file).await?
            }
            .into())
        }
    }
    pub async fn read_entries(&self, directory: &str) -> Result<(Vec<Entry>, bool)> {
        let mut entries = Vec::new();
        let mut truncated = false;
        if let Some(host) = &self.remote {
            let guard = DirectoryGuard {
                host: host.clone(),
                handle: call(host.raw.opendir(directory)).await?.handle,
            };
            loop {
                let reply =
                    tokio::time::timeout(Duration::from_secs(15), host.raw.readdir(&guard.handle))
                        .await
                        .map_err(|_| Error::new("The remote filesystem did not respond.", 504))?;
                let batch = match reply {
                    Ok(batch) => batch.files,
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break;
                    }
                    Err(error) => return Err(error.into()),
                };
                if batch.is_empty() {
                    break;
                }
                for item in batch {
                    if item.filename == "." || item.filename == ".." {
                        continue;
                    }
                    if entries.len() >= 10000 {
                        truncated = true;
                        break;
                    }
                    let info = Metadata::from(item.attrs);
                    let symlink = info.is_symlink();
                    let directory = if symlink {
                        self.metadata(
                            &libertty_engine::path::join(&[directory, &item.filename]),
                            true,
                        )
                        .await
                        .is_ok_and(|m| m.is_dir())
                    } else {
                        info.is_dir()
                    };
                    entries.push(Entry {
                        name: item.filename,
                        directory,
                        symlink,
                        size: info.size,
                        modified: info.modified,
                        mode: info.mode,
                    });
                }
                if truncated {
                    break;
                }
            }
        } else {
            let mut reader = fs::read_dir(directory).await?;
            while let Some(item) = reader.next_entry().await? {
                if entries.len() >= 10000 {
                    truncated = true;
                    break;
                }
                let file = item.path().to_string_lossy().into_owned();
                let Ok(info) = self.metadata(&file, false).await else {
                    continue;
                };
                let symlink = info.is_symlink();
                let directory = if symlink {
                    self.metadata(&file, true).await.is_ok_and(|m| m.is_dir())
                } else {
                    info.is_dir()
                };
                entries.push(Entry {
                    name: item.file_name().to_string_lossy().into_owned(),
                    directory,
                    symlink,
                    size: info.size,
                    modified: info.modified,
                    mode: info.mode,
                });
            }
        }
        Ok((entries, truncated))
    }
    pub async fn create_directory(&self, file: &str, mode: u32) -> Result<()> {
        if let Some(host) = &self.remote {
            call(host.raw.mkdir(
                file,
                FileAttributes {
                    permissions: Some(mode),
                    ..FileAttributes::empty()
                },
            ))
            .await?;
        } else {
            fs::DirBuilder::new().mode(mode).create(file).await?;
        }
        Ok(())
    }
    /// Open a file at a byte offset, so an interrupted download continues where it stopped.
    pub async fn open_read_at(&self, file: &str, offset: u64) -> Result<Reader> {
        if let Some(host) = &self.remote {
            let mut file = call(host.files.open(file)).await?;
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            Ok(Box::new(file))
        } else {
            let mut file = fs::File::open(file).await?;
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            Ok(Box::new(file))
        }
    }
    /// Open an existing file for writing at a byte offset, so a resumed upload continues its partial file.
    pub async fn open_write_at(&self, file: &str, offset: u64) -> Result<Writer> {
        if let Some(host) = &self.remote {
            let mut file = call(host.files.open_with_flags(file, OpenFlags::WRITE)).await?;
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            Ok(Box::new(file))
        } else {
            let mut file = fs::OpenOptions::new().write(true).open(file).await?;
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            Ok(Box::new(file))
        }
    }
    pub async fn open_read(&self, file: &str) -> Result<Reader> {
        if let Some(host) = &self.remote {
            Ok(Box::new(call(host.files.open(file)).await?))
        } else {
            Ok(Box::new(fs::File::open(file).await?))
        }
    }
    pub async fn create_new(&self, file: &str, mode: u32) -> Result<Writer> {
        if let Some(host) = &self.remote {
            let result = call(host.files.open_with_flags_and_attributes(
                file,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                FileAttributes {
                    permissions: Some(mode),
                    ..FileAttributes::empty()
                },
            ))
            .await;
            match result {
                Ok(file) => Ok(Box::new(file)),
                Err(_) if self.metadata(file, false).await.is_ok() => Err(Error::new(
                    "A file with that name already exists. Rename your file before uploading.",
                    409,
                )),
                Err(error) => Err(error),
            }
        } else {
            Ok(Box::new(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(mode)
                    .open(file)
                    .await?,
            ))
        }
    }
    pub async fn remove(&self, file: &str, directory: bool) -> Result<()> {
        if let Some(host) = &self.remote {
            if directory {
                call(host.files.remove_dir(file)).await?;
            } else {
                call(host.files.remove_file(file)).await?;
            }
        } else if directory {
            fs::remove_dir(file).await?;
        } else {
            fs::remove_file(file).await?;
        }
        Ok(())
    }
    pub async fn rename(&self, from: &str, to: &str, overwrite: bool) -> Result<()> {
        if let Some(host) = &self.remote {
            if overwrite {
                let mut payload = Vec::new();
                for value in [from, to] {
                    payload.extend_from_slice(&(value.len() as u32).to_be_bytes());
                    payload.extend_from_slice(value.as_bytes());
                }
                match call(host.raw.extended("posix-rename@openssh.com", payload)).await? {
                    Packet::Status(status) if status.status_code == StatusCode::Ok => {}
                    Packet::Status(status) => return Err(SftpError::Status(status).into()),
                    _ => return Err(Error::new("Invalid SFTP rename reply.", 400)),
                }
            } else {
                call(host.files.rename(from, to)).await?;
            }
        } else {
            fs::rename(from, to).await?;
        }
        Ok(())
    }
    pub async fn read_link(&self, file: &str) -> Result<String> {
        if let Some(host) = &self.remote {
            call(host.files.read_link(file)).await
        } else {
            Ok(fs::read_link(file).await?.to_string_lossy().into_owned())
        }
    }
    pub async fn symlink(&self, target: &str, file: &str) -> Result<()> {
        if let Some(host) = &self.remote {
            // OpenSSH preserves its historical target-before-link wire order.
            call(host.files.symlink(target, file)).await?;
        } else {
            fs::symlink(target, file).await?;
        }
        Ok(())
    }
    pub fn remove_on_drop(&self, path: String) {
        if self.remote.is_some() {
            let fs = self.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = fs.remove(&path, false).await;
                });
            }
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
}
