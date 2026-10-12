use crate::{
    directories::{Directories, executable},
    probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe},
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
    time::Duration,
};
use termai_engine::{
    path,
    repair::tokens,
    types::{Flag, SharedList},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
pub const AST_SCRIPT: &str = include_str!("../assets/describe.py");
type FlagEntry = (String, String, SharedTask<Option<Vec<Flag>>>);
struct Paths {
    cwd: String,
    versions: Vec<String>,
    values: SharedList<String>,
}
#[derive(Clone, Default)]
pub struct CatalogHost {
    directories: Directories,
    pool: ProbePool,
    flags: Arc<Mutex<VecDeque<FlagEntry>>>,
    paths: Arc<Mutex<VecDeque<Paths>>>,
}
impl CatalogHost {
    pub fn new(directories: Directories, pool: ProbePool) -> Self {
        Self {
            directories,
            pool,
            flags: Arc::new(Mutex::new(VecDeque::new())),
            paths: Arc::default(),
        }
    }
    pub async fn executable_names(
        &self,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        let mut names: BTreeSet<_> = [
            "cd", "pwd", "echo", "printf", "export", "alias", "history", "source", "jobs", "fg",
            "bg", "type", "exit",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        for dir in env
            .get("PATH")
            .map(String::as_str)
            .unwrap_or("")
            .split(':')
            .filter(|dir| !dir.is_empty())
        {
            let Ok(mut handle) = tokio::fs::read_dir(dir).await else {
                continue;
            };
            while let Ok(Some(entry)) = handle.next_entry().await {
                if cancel.is_cancelled() {
                    return Err(ABORTED.into());
                }
                let file = entry.path();
                if executable(&file.to_string_lossy())
                    && tokio::fs::metadata(&file).await.is_ok_and(|m| m.is_file())
                {
                    names.insert(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        let mut names: Vec<_> = names.into_iter().collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(names)
    }
    pub async fn paths_in(
        &self,
        cwd: &str,
        cancel: &CancellationToken,
    ) -> Result<SharedList<String>, String> {
        let root = self.directories.snapshot(cwd, 10000, cancel).await?;
        let entries = &root.entries;
        let mut versions = vec![root.version];
        let mut children = vec![];
        let mut count = entries.len();
        for dir in entries {
            if count >= 4000 {
                break;
            }
            if !dir.directory
                || dir.name.starts_with('.')
                || ["node_modules", ".git", ".venv", "venv", "dist", ".cache"]
                    .contains(&dir.name.as_str())
            {
                continue;
            }
            let snapshot = self
                .directories
                .snapshot(&path::join(&[cwd, &dir.name]), 4000 - count, cancel)
                .await?;
            count += snapshot.entries.len();
            versions.push(snapshot.version);
            children.push((&dir.name, snapshot.entries));
        }
        let cacheable = versions.iter().all(|version| !version.is_empty());
        if cacheable
            && let Some(old) = self
                .paths
                .lock()
                .await
                .iter()
                .find(|old| old.cwd == cwd && old.versions == versions)
        {
            return Ok(old.values.clone());
        }
        let mut paths: Vec<_> = entries
            .iter()
            .map(|e| format!("{}{}", e.name, if e.directory { "/" } else { "" }))
            .collect();
        for (dir, children) in children {
            for child in &children {
                if paths.len() >= 4000 {
                    break;
                }
                paths.push(format!(
                    "{}/{}{}",
                    dir,
                    child.name,
                    if child.directory { "/" } else { "" }
                ));
            }
        }
        let paths: SharedList<String> = paths.into();
        if cacheable {
            let mut cache = self.paths.lock().await;
            cache.retain(|old| old.cwd != cwd);
            cache.push_back(Paths {
                cwd: cwd.into(),
                versions,
                values: paths.clone(),
            });
            while cache.len() > 8
                || cache.iter().map(|entry| entry.values.len()).sum::<usize>() > 40000
            {
                cache.pop_front();
            }
        }
        Ok(paths)
    }
    pub async fn describe(
        &self,
        command: &str,
        cwd: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<Vec<Flag>>, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let words = tokens(command);
        if !words
            .first()
            .is_some_and(|w| ["python", "python3"].contains(&w.value.as_str()))
            || !words.get(1).is_some_and(|w| w.value.ends_with(".py"))
        {
            return Ok(None);
        }
        let file = path::resolve(&[cwd, &words[1].value]);
        let info = tokio::fs::metadata(&file).await.ok();
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let Some(info) = info.filter(|m| m.is_file() && m.len() <= 1024 * 1024) else {
            return Ok(None);
        };
        let stamp = format!("{:?}", info.modified().ok());
        let task = {
            let mut cache = self.flags.lock().await;
            if let Some((_, _, task)) = cache.iter().find(|(old, old_stamp, task)| {
                old == &file && old_stamp == &stamp && !task.aborted()
            }) {
                task.clone()
            } else {
                cache.retain(|(old, _, _)| old != &file);
                if cache.len() >= 200 {
                    cache.pop_front();
                }
                let pool = self.pool.clone();
                let target = file.clone();
                let task = SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        let options = ProbeOptions {
                            cwd: std::env::current_dir()
                                .map_err(|e| e.to_string())?
                                .to_string_lossy()
                                .into_owned(),
                            env: std::env::vars().collect(),
                            timeout: Duration::from_millis(1500),
                            max_buffer: 128 * 1024,
                        };
                        let result = probe(
                            &pool,
                            "python3",
                            &["-I".into(), "-c".into(), AST_SCRIPT.into(), target],
                            &options,
                            &cancel,
                        )
                        .await;
                        if cancel.is_cancelled() {
                            return Err(ABORTED.into());
                        }
                        Ok(result
                            .ok()
                            .filter(|r| r.success)
                            .and_then(|r| serde_json::from_slice(&r.stdout).ok()))
                    })
                });
                cache.push_back((file, stamp, task.clone()));
                task
            }
        };
        task.wait(cancel).await
    }
}
