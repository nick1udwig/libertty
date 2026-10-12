use crate::probes::ABORTED;
use std::{
    collections::VecDeque,
    ffi::CString,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use termai_engine::{
    path,
    types::{DirectoryEntry, DirectoryLookup, DirectorySnapshot, FileInfo},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone)]
struct Listing {
    key: (String, usize),
    stamp: String,
    snapshot: DirectorySnapshot,
}
#[derive(Clone, Default)]
pub struct Directories {
    cache: Arc<Mutex<VecDeque<Listing>>>,
    generation: Arc<AtomicU64>,
}
fn check(cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err(ABORTED.into())
    } else {
        Ok(())
    }
}
pub fn executable(file: &str) -> bool {
    CString::new(file).is_ok_and(|file| unsafe { libc::access(file.as_ptr(), libc::X_OK) == 0 })
}
pub async fn directory_version(dir: &str) -> String {
    tokio::fs::metadata(dir)
        .await
        .map(|m| {
            format!(
                "{}:{}:{}:{}:{}:{}:{}",
                m.dev(),
                m.ino(),
                m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128,
                m.ctime() as i128 * 1_000_000_000 + m.ctime_nsec() as i128,
                m.size(),
                m.nlink(),
                m.mode()
            )
        })
        .unwrap_or_default()
}
impl Directories {
    pub async fn snapshot(
        &self,
        dir: &str,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<DirectorySnapshot, String> {
        check(cancel)?;
        let empty = || DirectorySnapshot {
            version: String::new(),
            entries: Default::default(),
            complete: false,
        };
        if limit == 0 {
            return Ok(empty());
        }
        let key = (dir.to_owned(), limit);
        let stamp = directory_version(dir).await;
        check(cancel)?;
        {
            let mut cache = self.cache.lock().await;
            if let Some(index) = cache.iter().position(|listing| listing.key == key) {
                let old = cache.remove(index).unwrap();
                if !stamp.is_empty() && old.stamp == stamp {
                    let snapshot = old.snapshot.clone();
                    cache.push_back(old);
                    return Ok(snapshot);
                }
            }
        }
        if stamp.is_empty() {
            return Ok(empty());
        }
        let Ok(mut handle) = tokio::fs::read_dir(dir).await else {
            check(cancel)?;
            return Ok(empty());
        };
        let mut entries = Vec::new();
        let mut complete = true;
        loop {
            let entry = tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), entry = handle.next_entry() => entry };
            let entry = match entry {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(_) => {
                    check(cancel)?;
                    return Ok(empty());
                }
            };
            let Ok(kind) = entry.file_type().await else {
                check(cancel)?;
                return Ok(empty());
            };
            entries.push(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                directory: kind.is_dir(),
                symlink: kind.is_symlink(),
            });
            if entries.len() >= limit {
                complete = false;
                break;
            }
        }
        entries.sort_by(|a, b| a.name.encode_utf16().cmp(b.name.encode_utf16()));
        let stable = stamp == directory_version(dir).await;
        check(cancel)?;
        let snapshot = DirectorySnapshot {
            version: if stable {
                format!(
                    "{stamp}:{}",
                    self.generation.fetch_add(1, Ordering::SeqCst) + 1
                )
            } else {
                String::new()
            },
            entries: entries.into(),
            complete,
        };
        if stable {
            let mut cache = self.cache.lock().await;
            cache.retain(|entry| entry.key != key);
            cache.push_back(Listing {
                key,
                stamp,
                snapshot: snapshot.clone(),
            });
            while cache.len() > 64
                || cache
                    .iter()
                    .map(|entry| entry.snapshot.entries.len())
                    .sum::<usize>()
                    > 40000
            {
                cache.pop_front();
            }
        }
        Ok(snapshot)
    }
    pub async fn entries(
        &self,
        dir: &str,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<termai_engine::types::SharedList<DirectoryEntry>, String> {
        Ok(self.snapshot(dir, limit, cancel).await?.entries)
    }
    pub async fn path_spelling(
        &self,
        file: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, String> {
        let resolved = path::resolve(&[file]);
        let parts: Vec<_> = resolved.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() > 64 {
            return Ok(None);
        }
        let mut actual = "/".to_owned();
        for part in parts {
            let entries = self.entries(&actual, 10000, cancel).await?;
            let fold = |name: &str| name.nfc().collect::<String>().to_lowercase();
            let Some(entry) = entries
                .iter()
                .find(|e| e.name == part)
                .or_else(|| entries.iter().find(|e| fold(&e.name) == fold(part)))
            else {
                return Ok(None);
            };
            actual = path::join(&[&actual, &entry.name]);
        }
        Ok(Some(actual))
    }
    pub async fn stat(
        &self,
        file: &str,
        check_executable: bool,
        cancel: &CancellationToken,
    ) -> Result<Option<FileInfo>, String> {
        check(cancel)?;
        let info = tokio::fs::metadata(file).await.ok();
        check(cancel)?;
        let Some(info) = info else {
            return Ok(None);
        };
        let spelling = if cfg!(target_os = "macos") {
            self.path_spelling(file, cancel)
                .await?
                .filter(|spelling| *spelling != path::resolve(&[file]))
        } else {
            None
        };
        check(cancel)?;
        Ok(Some(FileInfo {
            file: info.is_file(),
            directory: info.is_dir(),
            executable: check_executable && info.is_file() && executable(file),
            spelling,
        }))
    }
    pub async fn lookup(
        &self,
        file: &str,
        cancel: &CancellationToken,
    ) -> Result<DirectoryLookup, String> {
        let info = self.stat(file, true, cancel).await?;
        Ok(if info.is_some() {
            DirectoryLookup {
                info,
                listing: None,
            }
        } else {
            DirectoryLookup {
                info: None,
                listing: Some(
                    self.snapshot(
                        Path::new(file)
                            .parent()
                            .and_then(Path::to_str)
                            .filter(|p| !p.is_empty())
                            .unwrap_or("."),
                        10000,
                        cancel,
                    )
                    .await?,
                ),
            }
        })
    }
}
