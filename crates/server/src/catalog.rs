use crate::task_cache::TaskCache;
use crate::{
    directories::executable,
    probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe},
};
use libertty_engine::types::Flag;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
pub const AST_SCRIPT: &str = include_str!("../assets/describe.py");
type Flags = TaskCache<String, String, Option<Vec<Flag>>, 200>;
#[derive(Clone, Default)]
pub struct CatalogHost {
    pool: ProbePool,
    flags: Arc<Mutex<Flags>>,
}
impl CatalogHost {
    pub fn new(pool: ProbePool) -> Self {
        Self {
            pool,
            flags: Default::default(),
        }
    }
    pub async fn executable_names(
        &self,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        let environment = env.clone();
        let stop = cancel.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let mut names: BTreeSet<_> = [
                "cd", "pwd", "echo", "printf", "export", "alias", "history", "source", "jobs",
                "fg", "bg", "type", "exit",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect();
            for dir in environment
                .get("PATH")
                .map(String::as_str)
                .unwrap_or("")
                .split(':')
                .filter(|dir| !dir.is_empty())
            {
                if stop.is_cancelled() {
                    return Err(ABORTED.into());
                }
                let Ok(handle) = std::fs::read_dir(dir) else {
                    continue;
                };
                for entry in handle {
                    if stop.is_cancelled() {
                        return Err(ABORTED.into());
                    }
                    let Ok(entry) = entry else {
                        break;
                    };
                    let file = entry.path();
                    if executable(&file.to_string_lossy())
                        && std::fs::metadata(&file).is_ok_and(|m| m.is_file())
                    {
                        names.insert(entry.file_name().to_string_lossy().into_owned());
                    }
                }
            }
            let mut names: Vec<_> = names.into_iter().collect();
            names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Ok(names)
        });
        tokio::select! { biased; _ = cancel.cancelled() => Err(ABORTED.into()), result = scan => result.map_err(|e| e.to_string())? }
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
        let Some(file) = crate::probe_policy::python_script(command, cwd) else {
            return Ok(None);
        };
        let info = tokio::fs::metadata(&file).await.ok();
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let Some(info) = info.filter(|m| m.is_file() && m.len() <= 1024 * 1024) else {
            return Ok(None);
        };
        use std::os::unix::fs::MetadataExt;
        let stamp = format!(
            "{}:{}:{}:{}:{}:{}:{}",
            info.dev(),
            info.ino(),
            info.mtime(),
            info.mtime_nsec(),
            info.ctime(),
            info.ctime_nsec(),
            info.len()
        );
        let task = {
            let mut cache = self.flags.lock().await;
            cache.get_or_insert_with(file.clone(), stamp, None, || {
                let pool = self.pool.clone();
                let target = file;
                SharedTask::new(move |cancel| {
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
                        let result = result?;
                        if !result.success {
                            return Err("Script description probe failed.".into());
                        }
                        serde_json::from_slice(&result.stdout).map_err(|error| error.to_string())
                    })
                })
            })
        };
        task.wait(cancel).await
    }
}
