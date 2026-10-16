use crate::{
    probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe},
    shell::local_bash,
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type Entry = ((String, String), SharedTask<bool>);
#[derive(Clone, Default)]
pub struct Syntax {
    cache: Arc<Mutex<VecDeque<Entry>>>,
    pool: ProbePool,
}
impl Syntax {
    pub fn new(pool: ProbePool) -> Self {
        Self {
            pool,
            ..Self::default()
        }
    }
    pub async fn valid(
        &self,
        command: &str,
        cwd: &str,
        cancel: &CancellationToken,
    ) -> Result<bool, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let key = (cwd.to_owned(), command.to_owned());
        let task = {
            let mut cache = self.cache.lock().await;
            if let Some((_, task)) = cache
                .iter()
                .find(|(old, task)| *old == key && !task.aborted())
            {
                task.clone()
            } else {
                cache.retain(|(old, _)| *old != key);
                if cache.len() >= 1000 {
                    cache.pop_front();
                }
                let pool = self.pool.clone();
                let cwd = cwd.to_owned();
                let command = command.to_owned();
                let task = SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        let bash = local_bash(&crate::environment::vars().collect())?;
                        let env: BTreeMap<_, _> = [
                            ("PATH", "/usr/bin:/bin"),
                            ("LC_ALL", "C"),
                            ("BASH_ENV", "/dev/null"),
                            ("ENV", "/dev/null"),
                        ]
                        .into_iter()
                        .map(|(k, v)| (k.into(), v.into()))
                        .collect();
                        let options = ProbeOptions {
                            cwd,
                            env,
                            timeout: Duration::from_millis(1000),
                            max_buffer: 16384,
                        };
                        let result = probe(
                            &pool,
                            &bash,
                            &[
                                "--noprofile".into(),
                                "--norc".into(),
                                "-n".into(),
                                "-c".into(),
                                command,
                            ],
                            &options,
                            &cancel,
                        )
                        .await;
                        if cancel.is_cancelled() {
                            return Err(ABORTED.into());
                        }
                        Ok(result.is_ok_and(|result| result.success))
                    })
                });
                cache.push_back((key, task.clone()));
                task
            }
        };
        task.wait(cancel).await
    }
}
