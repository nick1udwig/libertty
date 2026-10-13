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
#[cfg(any(target_os = "macos", test))]
fn attribute_name(buffer: &[u8]) -> Option<&str> {
    // ATTR_CMN_NAME follows a u32 buffer length and an attrreference_t.
    // https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html
    let length = u32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?) as usize;
    let buffer = buffer.get(..length)?;
    let offset = i32::from_ne_bytes(buffer.get(4..8)?.try_into().ok()?) as isize;
    let count = u32::from_ne_bytes(buffer.get(8..12)?.try_into().ok()?) as usize;
    let start = 4usize.checked_add_signed(offset)?;
    if start < 12 {
        return None;
    }
    let end = start.checked_add(count)?;
    std::ffi::CStr::from_bytes_with_nul(buffer.get(start..end)?)
        .ok()
        .and_then(|name| name.to_str().ok())
        .filter(|name| !name.is_empty())
}
#[cfg(target_os = "macos")]
fn native_path_spelling(file: &str, cancel: &CancellationToken) -> Result<Option<String>, String> {
    let mut actual = "/".to_owned();
    for part in file.split('/').filter(|part| !part.is_empty()) {
        check(cancel)?;
        let requested = path::join(&[&actual, part]);
        let Ok(requested) = CString::new(requested) else {
            return Ok(None);
        };
        let mut attributes = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: libc::ATTR_CMN_NAME,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let mut buffer = [0u8; 4096];
        // Query each logical component without replacing a symlink with its target.
        let result = unsafe {
            libc::getattrlist(
                requested.as_ptr(),
                (&mut attributes as *mut libc::attrlist).cast(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                libc::FSOPT_NOFOLLOW,
            )
        };
        let Some(name) = (result == 0).then(|| attribute_name(&buffer)).flatten() else {
            return Ok(None);
        };
        if name != part && fold(name) != fold(part) {
            return Ok(None);
        }
        actual = path::join(&[&actual, name]);
    }
    check(cancel)?;
    Ok(Some(actual))
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
        #[cfg(target_os = "macos")]
        {
            let file = resolved.clone();
            let stop = cancel.clone();
            let work = tokio::task::spawn_blocking(move || native_path_spelling(&file, &stop));
            let spelling = tokio::select! {biased;_=cancel.cancelled()=>return Err(ABORTED.into()),result=work=>result.map_err(|e|e.to_string())??};
            check(cancel)?;
            if spelling.is_some() {
                return Ok(spelling);
            }
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
        let info = self.stat(file, false, cancel).await?;
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

#[cfg(test)]
mod tests {
    use super::attribute_name;

    #[test]
    fn file_name_attributes_reject_truncated_offsets_and_invalid_strings() {
        let name = "Café\0".as_bytes();
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&((12 + name.len()) as u32).to_ne_bytes());
        buffer.extend_from_slice(&8i32.to_ne_bytes());
        buffer.extend_from_slice(&(name.len() as u32).to_ne_bytes());
        buffer.extend_from_slice(name);
        assert_eq!(attribute_name(&buffer), Some("Café"));
        for length in 0..buffer.len() {
            assert_eq!(attribute_name(&buffer[..length]), None);
        }
        let mut invalid = buffer.clone();
        invalid[4..8].copy_from_slice(&(-8i32).to_ne_bytes());
        assert_eq!(attribute_name(&invalid), None);
        let mut invalid = buffer.clone();
        invalid[8..12].copy_from_slice(&u32::MAX.to_ne_bytes());
        assert_eq!(attribute_name(&invalid), None);
        let mut invalid = buffer.clone();
        *invalid.last_mut().unwrap() = b'x';
        assert_eq!(attribute_name(&invalid), None);
        let mut invalid = buffer.clone();
        invalid[13] = 0;
        assert_eq!(attribute_name(&invalid), None);
        let mut invalid = buffer;
        invalid[12] = 0xff;
        assert_eq!(attribute_name(&invalid), None);
    }
}
