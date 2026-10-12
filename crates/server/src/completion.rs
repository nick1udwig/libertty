use crate::{
    probes::{ABORTED, ProbeOptions, ProbePool, probe},
    shell::local_bash,
};
use std::{collections::BTreeMap, time::Duration};
use termai_engine::repair::shell_quote;
use tokio_util::sync::CancellationToken;
pub const COMPLETION_SCRIPT: &str = include_str!("../assets/completion.sh");
pub const COMPLETION_SNAPSHOT: &str = include_str!("../assets/completion-snapshot.sh");
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
