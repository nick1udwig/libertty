use crate::{
    directories::executable,
    probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe},
};
use libertty_engine::{path, repair::tokens, types::Flag};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
pub const AST_SCRIPT: &str = include_str!("../assets/describe.py");
type FlagEntry = (String, String, SharedTask<Option<Vec<Flag>>>);
#[derive(Clone, Default)]
pub struct CatalogHost {
    pool: ProbePool,
    flags: Arc<Mutex<VecDeque<FlagEntry>>>,
}
impl CatalogHost {
    pub fn new(pool: ProbePool) -> Self {
        Self {
            pool,
            flags: Arc::new(Mutex::new(VecDeque::new())),
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
        let words = tokens(command);
        let script = libertty_engine::command_policy::script_operand(
            &words.iter().map(|w| &w.value).collect::<Vec<_>>(),
        );
        if !words
            .first()
            .is_some_and(|w| ["python", "python3"].contains(&w.value.as_str()))
            || !script.is_some_and(|index| words[index].value.ends_with(".py"))
        {
            return Ok(None);
        }
        let file = path::resolve(&[cwd, &words[script.unwrap()].value]);
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
