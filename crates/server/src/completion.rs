use crate::{
    probes::{ABORTED, ProbeOptions, ProbePool, probe},
    shell::local_bash,
};
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use termai_engine::repair::shell_quote;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
pub const COMPLETION_SCRIPT: &str = include_str!("../assets/completion.sh");
pub const COMPLETION_SNAPSHOT: &str = include_str!("../assets/completion-snapshot.sh");

/// Reuse Bash itself, but execute each completion in an isolated subshell.
/// Definitions are sourced for every request, including after files change.
#[derive(Clone, Default)]
pub struct CompletionProvider {
    idle: Arc<Mutex<Vec<CompletionWorker>>>,
    starts: Arc<AtomicUsize>,
}
struct CompletionWorker {
    bash: String,
    cwd: String,
    env: BTreeMap<String, String>,
    _child: Child,
    _group: crate::probes::ProcessGroup,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl CompletionWorker {
    fn start(bash: String, cwd: &str, env: &BTreeMap<String, String>) -> Result<Self, String> {
        static SCRIPT: OnceLock<String> = OnceLock::new();
        let script = SCRIPT.get_or_init(|| format!(
            "while IFS= read -r -d '' termai_count; do\n[[ $termai_count =~ ^[0-9]+$ ]] && ((termai_count >= 3 && termai_count <= 65)) || exit 1\ntermai_words=()\nfor ((termai_i=0; termai_i<termai_count; termai_i++)); do IFS= read -r -d '' termai_word || exit 1; termai_words+=(\"$termai_word\"); done\n( set -- \"${{termai_words[@]}}\"\n{COMPLETION_SCRIPT}\n) < /dev/null\nbuiltin printf '\\0'\ndone"
        ));
        let mut child = Command::new(&bash)
            .args(["--noprofile", "--norc", "-c", script, "termai-completion"])
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .env("BASH_ENV", "/dev/null")
            .env("ENV", "/dev/null")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().expect("piped input");
        let output = BufReader::new(child.stdout.take().expect("piped output"));
        Ok(Self {
            bash,
            cwd: cwd.into(),
            env: env.clone(),
            _group: crate::probes::ProcessGroup(child.id()),
            _child: child,
            input,
            output,
        })
    }
    async fn complete(&mut self, words: &[String]) -> Result<Vec<String>, String> {
        let args = completion_args(words);
        let mut request = format!("{}\0", args.len()).into_bytes();
        for arg in args {
            request.extend_from_slice(arg.as_bytes());
            request.push(0);
        }
        self.input
            .write_all(&request)
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        loop {
            let start = bytes.len();
            let count = (&mut self.output)
                .take((128 * 1024 + 1 - start) as u64)
                .read_until(0, &mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            if count == 0 || bytes.len() > 128 * 1024 || bytes.last() != Some(&0) {
                return Err("Completion worker closed or exceeded its output limit.".into());
            }
            if count == 1 {
                break;
            }
        }
        Ok(completion_values(&String::from_utf8_lossy(&bytes)))
    }
}
impl CompletionProvider {
    pub fn worker_starts(&self) -> usize {
        self.starts.load(Ordering::Relaxed)
    }
    pub async fn complete(
        &self,
        pool: &ProbePool,
        words: &[String],
        cwd: &str,
        env: &BTreeMap<String, String>,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, String> {
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        if !valid_completion_words(words) {
            return Ok(vec![]);
        }
        let bash = local_bash(&std::env::vars().collect())?;
        let result = pool
            .run(cancel, async {
                let mut worker = {
                    let mut idle = self.idle.lock().await;
                    idle.iter()
                        .position(|w| w.bash == bash && w.cwd == cwd && w.env == *env)
                        .map(|i| idle.swap_remove(i))
                };
                if worker.is_none() {
                    worker = Some(CompletionWorker::start(bash, cwd, env)?);
                    self.starts.fetch_add(1, Ordering::Relaxed);
                }
                let mut worker = worker.unwrap();
                let values =
                    tokio::time::timeout(Duration::from_millis(1200), worker.complete(words))
                        .await
                        .map_err(|_| "Completion timed out.".to_owned())??;
                let mut idle = self.idle.lock().await;
                if idle.len() < 2 {
                    idle.push(worker);
                }
                Ok(values)
            })
            .await;
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        Ok(result.unwrap_or_default())
    }
}
pub fn valid_completion_words(words: &[String]) -> bool {
    (2..=64).contains(&words.len())
        && words.iter().all(|w| {
            w.encode_utf16().count() <= 2000 && !w.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        })
        && words.join(" ").encode_utf16().count() <= 4000
        && !words[0].is_empty()
        && words[0]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./+-".contains(c))
}
pub fn completion_args(words: &[String]) -> Vec<String> {
    std::iter::once(
        words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if i == words.len() - 1 && w.is_empty() {
                    String::new()
                } else {
                    shell_quote(w)
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
    .chain(words.iter().cloned())
    .collect()
}
pub fn completion_values(raw: &str) -> Vec<String> {
    let mut result = Vec::new();
    for value in raw.split('\0').map(str::trim_end) {
        if !value.is_empty()
            && value.encode_utf16().count() <= 2000
            && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            && !result.iter().any(|old| old == value)
        {
            result.push(value.to_owned());
            if result.len() == 1000 {
                break;
            }
        }
    }
    result
}
pub async fn shell_complete(
    pool: &ProbePool,
    words: &[String],
    cwd: &str,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> Result<Vec<String>, String> {
    if cancel.is_cancelled() {
        return Err(ABORTED.into());
    }
    if !valid_completion_words(words) {
        return Ok(vec![]);
    }
    let bash = local_bash(&std::env::vars().collect())?;
    let mut env = env.clone();
    env.extend([
        ("BASH_ENV".into(), "/dev/null".into()),
        ("ENV".into(), "/dev/null".into()),
        ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
    ]);
    let options = ProbeOptions {
        cwd: cwd.into(),
        env,
        timeout: Duration::from_millis(1200),
        max_buffer: 128 * 1024,
    };
    let args: Vec<_> = [
        "--noprofile",
        "--norc",
        "-c",
        COMPLETION_SCRIPT,
        "termai-completion",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain(completion_args(words))
    .collect();
    let result = probe(pool, &bash, &args, &options, cancel).await;
    if cancel.is_cancelled() {
        return Err(ABORTED.into());
    }
    Ok(result
        .ok()
        .filter(|r| r.success)
        .map(|r| completion_values(&String::from_utf8_lossy(&r.stdout)))
        .unwrap_or_default())
}
