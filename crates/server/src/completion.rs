use crate::{
    probes::{ABORTED, ProbeOptions, ProbePool, probe},
    shell::local_bash,
};
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
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
/// Custom definitions stay fresh; the standard framework is prepared once.
#[derive(Clone, Default)]
pub struct CompletionProvider {
    idle: Arc<Mutex<Vec<CompletionWorker>>>,
    starts: Arc<AtomicUsize>,
}
type Framework = (String, Vec<(String, SystemTime, u64)>);
struct CompletionWorker {
    bash: String,
    cwd: String,
    env: BTreeMap<String, String>,
    framework: Option<Framework>,
    _child: Child,
    _group: crate::probes::ProcessGroup,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
async fn prepared_framework(env: &BTreeMap<String, String>) -> Option<Framework> {
    // Arbitrary startup scripts can depend on live state beyond their own file.
    // Only prepare a bare standard framework; loaders still run in each child.
    if env
        .keys()
        .any(|key| key.starts_with("BASH_COMPLETION_") || key == "TERMAI_COMPLETIONS_FILE")
    {
        return None;
    }
    let home = env.get("HOME").cloned().unwrap_or_default();
    if home.is_empty() {
        return None;
    }
    let data = env
        .get("XDG_DATA_HOME")
        .cloned()
        .unwrap_or_else(|| format!("{home}/.local/share"));
    let dirs = env
        .get("XDG_DATA_DIRS")
        .cloned()
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    tokio::task::spawn_blocking(move || {
        let mut custom = vec![
            format!("{home}/.bash_completion"),
            format!("{data}/bash-completion/startup"),
            "/etc/bash_completion.d".into(),
        ];
        custom.extend(
            dirs.split(':')
                .map(|dir| format!("{dir}/bash-completion/startup")),
        );
        custom.extend(["/usr/share/bash-completion/startup".into()]);
        if custom.iter().any(|path| {
            if path.ends_with("/startup") {
                std::fs::read_dir(path).is_ok_and(|entries| {
                    entries.filter_map(Result::ok).any(|entry| {
                        entry
                            .path()
                            .extension()
                            .is_some_and(|extension| extension == "bash")
                    })
                })
            } else {
                std::fs::symlink_metadata(path).is_ok()
            }
        }) {
            return None;
        }
        let file = "/usr/share/bash-completion/bash_completion";
        let info = std::fs::metadata(file).ok()?;
        let mut stamps = vec![(file.into(), info.modified().ok()?, info.len())];
        let core = "/usr/share/bash-completion/startup-core";
        if let Ok(entries) = std::fs::read_dir(core) {
            let info = std::fs::metadata(core).ok()?;
            stamps.push((core.into(), info.modified().ok()?, info.len()));
            for entry in entries {
                let entry = entry.ok()?;
                let info = entry.metadata().ok()?;
                stamps.push((
                    entry.path().to_string_lossy().into_owned(),
                    info.modified().ok()?,
                    info.len(),
                ));
            }
        }
        stamps.sort_by(|a, b| a.0.cmp(&b.0));
        Some((file.into(), stamps))
    })
    .await
    .ok()
    .flatten()
}
impl CompletionWorker {
    fn start(
        bash: String,
        cwd: &str,
        env: &BTreeMap<String, String>,
        framework: Option<Framework>,
    ) -> Result<Self, String> {
        let script = {
            // Only the worker protocol needs to omit empty records.
            let mut body = COMPLETION_SCRIPT.replace(
                r#"if ((${#COMPREPLY[@]})); then builtin printf '%s\0' "${COMPREPLY[@]:0:1000}" >&3; fi"#,
                r#"for termai_completion_value in "${COMPREPLY[@]:0:1000}"; do
  [[ -n "$termai_completion_value" ]] && builtin printf '%s\0' "$termai_completion_value" >&3
done"#);
            let setup = if let Some((file, _)) = &framework {
                let start = body
                    .find("  if [[ -n \"$TERMAI_COMPLETIONS_FILE\"")
                    .expect("completion source block");
                let end = body[start..]
                    .find("  COMP_LINE=")
                    .expect("completion arguments")
                    + start;
                body.replace_range(start..end, "");
                format!("source {} >/dev/null 2>&1\n", shell_quote(file))
            } else {
                String::new()
            };
            format!(
                "{setup}while IFS= read -r -d '' termai_count; do\n[[ $termai_count =~ ^[0-9]+$ ]] && ((termai_count >= 3 && termai_count <= 65)) || exit 1\ntermai_words=()\nfor ((termai_i=0; termai_i<termai_count; termai_i++)); do IFS= read -r -d '' termai_word || exit 1; termai_words+=(\"$termai_word\"); done\n( set -- \"${{termai_words[@]}}\"\n{body}\n) < /dev/null\nbuiltin printf '\\0'\ndone"
            )
        };
        let mut child = Command::new(&bash)
            .args(["--noprofile", "--norc", "-c", &script, "termai-completion"])
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
            framework,
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
        let framework = prepared_framework(env).await;
        let result = pool
            .run(cancel, async {
                let mut worker = {
                    let mut idle = self.idle.lock().await;
                    idle.iter()
                        .position(|w| {
                            w.bash == bash
                                && w.cwd == cwd
                                && w.env == *env
                                && w.framework == framework
                        })
                        .map(|i| idle.swap_remove(i))
                };
                if worker.is_none() {
                    worker = Some(CompletionWorker::start(bash, cwd, env, framework)?);
                    self.starts.fetch_add(1, Ordering::Relaxed);
                }
                let mut worker = worker.unwrap();
                let values =
                    tokio::time::timeout(Duration::from_millis(1200), worker.complete(words))
                        .await
                        .map_err(|_| "Completion timed out.".to_owned())??;
                let mut idle = self.idle.lock().await;
                if idle.len() >= 2 {
                    idle.remove(0);
                }
                idle.push(worker);
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
