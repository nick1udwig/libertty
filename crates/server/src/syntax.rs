use crate::task_cache::TaskCache;
use crate::{
    probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe},
    shell::local_bash,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type SyntaxCache = TaskCache<(String, String), (), bool, 1000>;
#[derive(Clone, Default)]
pub struct Syntax {
    cache: Arc<Mutex<SyntaxCache>>,
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
            cache.get_or_insert_with(key, (), None, || {
                let pool = self.pool.clone();
                let cwd = cwd.to_owned();
                let command = command.to_owned();
                SharedTask::new(move |cancel| {
                    Box::pin(async move {
                        let bash = local_bash(&std::env::vars().collect())?;
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
                        result.map(|result| result.success)
                    })
                })
            })
        };
        task.wait(cancel).await
    }
}
