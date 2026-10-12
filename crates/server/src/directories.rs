use crate::probes::ABORTED;
use std::{
    collections::{HashMap, VecDeque},
    ffi::CString,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{
        Arc, OnceLock,
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
    names: Option<Arc<NameIndex>>,
}
struct NameIndex {
    exact: HashMap<String, usize>,
    folded: OnceLock<HashMap<String, usize>>,
}
fn fold(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
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
    pub async fn stat_many(
        &self,
        files: Vec<(String, bool)>,
        cancel: &CancellationToken,
    ) -> Result<Vec<Option<FileInfo>>, String> {
        check(cancel)?;
        if cfg!(target_os = "macos") {
            return futures::future::join_all(
                files
                    .iter()
                    .map(|(file, executable)| self.stat(file, *executable, cancel)),
            )
            .await
            .into_iter()
            .collect();
        }
        let stop = cancel.clone();
        let work = tokio::task::spawn_blocking(move || {
            files
                .into_iter()
                .map(|(file, is_executable)| {
                    check(&stop)?;
                    Ok(std::fs::metadata(&file).ok().map(|info| FileInfo {
                        file: info.is_file(),
                        directory: info.is_dir(),
                        executable: is_executable && info.is_file() && executable(&file),
                        spelling: None,
                    }))
                })
                .collect::<Result<Vec<_>, String>>()
        });
        tokio::select! { biased; _ = cancel.cancelled() => Err(ABORTED.into()), result = work => { check(cancel)?; result.map_err(|e|e.to_string())? } }
    }
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
        // Read and classify a whole listing in one blocking-pool submission.
        let target = dir.to_owned();
        let stop = cancel.clone();
        let read = tokio::task::spawn_blocking(move || {
            check(&stop)?;
            let Ok(handle) = std::fs::read_dir(target) else {
                return Ok(None);
            };
            let mut entries = Vec::new();
            let mut complete = true;
            for entry in handle {
                check(&stop)?;
                let Ok(entry) = entry else {
                    return Ok(None);
                };
                let Ok(kind) = entry.file_type() else {
                    return Ok(None);
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
            check(&stop)?;
            Ok::<_, String>(Some((entries, complete)))
        });
        let listing = tokio::select! { biased; _ = cancel.cancelled() => return Err(ABORTED.into()), result = read => result.map_err(|e| e.to_string())?? };
        let Some((entries, complete)) = listing else {
            check(cancel)?;
            return Ok(empty());
        };
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
                names: None,
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
            let snapshot = self.snapshot(&actual, 10000, cancel).await?;
            let names = self.names(&snapshot).await;
            let index = names.exact.get(part).copied().or_else(|| {
                let folded = names.folded.get_or_init(|| {
                    let mut index = HashMap::new();
                    for (at, entry) in snapshot.entries.iter().enumerate() {
                        index.entry(fold(&entry.name)).or_insert(at);
                    }
                    index
                });
                folded.get(&fold(part)).copied()
            });
            let Some(entry) = index.and_then(|at| snapshot.entries.get(at)) else {
                return Ok(None);
            };
            actual = path::join(&[&actual, &entry.name]);
        }
        Ok(Some(actual))
    }
    async fn names(&self, snapshot: &DirectorySnapshot) -> Arc<NameIndex> {
        if !snapshot.version.is_empty()
            && let Some(names) = self
                .cache
                .lock()
                .await
                .iter()
                .find(|old| old.snapshot.version == snapshot.version)
                .and_then(|old| old.names.clone())
        {
            return names;
        }
        let names = Arc::new(NameIndex {
            exact: snapshot
                .entries
                .iter()
                .enumerate()
                .map(|(at, entry)| (entry.name.clone(), at))
                .collect(),
            folded: OnceLock::new(),
        });
        if !snapshot.version.is_empty()
            && let Some(old) = self
                .cache
                .lock()
                .await
                .iter_mut()
                .find(|old| old.snapshot.version == snapshot.version)
        {
            old.names = Some(names.clone());
        }
        names
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
