use crate::context::FileStamp;
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    sync::{Arc, Mutex, OnceLock},
};
use termai_engine::path;
use termai_engine::utf16_len;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
};
pub const HISTORY_ENTRIES: usize = 5000;
pub const HISTORY_BYTES: usize = 2 * 1024 * 1024;
pub fn history_lines(raw: &str, partial: bool) -> Vec<String> {
    let mut lines: Vec<_> = raw
        .split('\n')
        .skip(usize::from(partial))
        .filter(|line| {
            !line.trim().is_empty()
                && !line.starts_with(char::is_whitespace)
                && !(line.starts_with('#')
                    && line.len() > 1
                    && line[1..].bytes().all(|c| c.is_ascii_digit()))
                && utf16_len(line) <= 2000
        })
        .map(str::to_owned)
        .collect();
    if lines.len() > HISTORY_ENTRIES {
        lines.drain(..lines.len() - HISTORY_ENTRIES);
    }
    lines
}
pub async fn read_history(file: &str, limit: usize) -> Vec<String> {
    let result: Result<Vec<String>, std::io::Error> = async {
        let mut handle = File::open(file).await?;
        let info = handle.metadata().await?;
        if !info.is_file() {
            return Ok(vec![]);
        }
        let start = info.len().saturating_sub(limit as u64);
        handle.seek(std::io::SeekFrom::Start(start)).await?;
        let mut bytes = Vec::new();
        handle.take(limit as u64).read_to_end(&mut bytes).await?;
        Ok(history_lines(&String::from_utf8_lossy(&bytes), start > 0))
    }
    .await;
    result.unwrap_or_default()
}
type HistoryCell = Arc<tokio::sync::OnceCell<Arc<Vec<String>>>>;
struct CachedSource {
    file: String,
    stamp: FileStamp,
    lines: HistoryCell,
}
async fn cached_history(file: &str) -> Arc<Vec<String>> {
    static SOURCES: OnceLock<Mutex<VecDeque<CachedSource>>> = OnceLock::new();
    let cache = SOURCES.get_or_init(Mutex::default);
    let metadata = tokio::fs::metadata(file).await.ok().filter(|m| m.is_file());
    let Some(metadata) = metadata else {
        cache.lock().unwrap().retain(|source| source.file != file);
        return Arc::default();
    };
    let stamp = FileStamp::new(&metadata);
    let lines = {
        let mut cache = cache.lock().unwrap();
        if let Some(source) = cache
            .iter()
            .find(|source| source.file == file && source.stamp == stamp)
        {
            source.lines.clone()
        } else {
            cache.retain(|source| source.file != file);
            if cache.len() >= 32 {
                cache.pop_front();
            }
            let lines = Arc::new(tokio::sync::OnceCell::new());
            cache.push_back(CachedSource {
                file: file.into(),
                stamp,
                lines: lines.clone(),
            });
            lines
        }
    };
    lines
        .get_or_init(|| async { Arc::new(read_history(file, HISTORY_BYTES).await) })
        .await
        .clone()
}
pub async fn readline_history_source(env: &BTreeMap<String, String>) -> String {
    for key in ["TERMAI_HISTORY_FILE", "TERMAI_ETERNAL_HISTORY_FILE"] {
        if let Some(file) = env.get(key).filter(|v| !v.is_empty()) {
            return file.clone();
        }
    }
    let home = env.get("HOME").cloned().unwrap_or_default();
    let eternal = path::join(&[&home, ".bash_eternal_history"]);
    if tokio::fs::metadata(&eternal)
        .await
        .is_ok_and(|m| m.is_file())
    {
        eternal
    } else {
        path::join(&[&home, ".bash_history"])
    }
}
pub async fn history_sources(env: &BTreeMap<String, String>) -> Vec<String> {
    let home = env.get("HOME").map(String::as_str).unwrap_or("");
    let files = if let Some(file) = env.get("TERMAI_HISTORY_FILE").filter(|v| !v.is_empty()) {
        vec![
            Some(file.clone()),
            env.get("TERMAI_ETERNAL_HISTORY_FILE").cloned(),
        ]
    } else {
        vec![
            Some(path::join(&[home, ".bash_history"])),
            Some(path::join(&[home, ".bash_eternal_history"])),
            env.get("TERMAI_ETERNAL_HISTORY_FILE").cloned(),
            env.get("TERMAI_REAL_HISTFILE")
                .or_else(|| env.get("HISTFILE"))
                .cloned(),
        ]
    };
    let mut seen = HashSet::new();
    let files: Vec<_> = files
        .into_iter()
        .flatten()
        .filter(|f| !f.is_empty() && f != "/dev/null" && seen.insert(f.clone()))
        .collect();
    let groups = futures::future::join_all(files.iter().map(|f| cached_history(f))).await;
    let mut seen = HashSet::new();
    let mut lines: Vec<_> = groups
        .into_iter()
        .flat_map(|lines| lines.as_ref().clone())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter(|line| seen.insert(line.clone()))
        .take(HISTORY_ENTRIES)
        .collect();
    lines.reverse();
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn source_precedence_regular_files_and_explicit_overrides() {
        let home = tempfile::tempdir().unwrap();
        let standard = home.path().join(".bash_history");
        let eternal = home.path().join(".bash_eternal_history");
        let mut env = BTreeMap::from([("HOME".into(), home.path().to_str().unwrap().into())]);
        tokio::fs::write(&standard, "echo standard\n")
            .await
            .unwrap();
        assert_eq!(
            readline_history_source(&env).await,
            standard.to_str().unwrap()
        );
        tokio::fs::create_dir(&eternal).await.unwrap();
        assert_eq!(
            readline_history_source(&env).await,
            standard.to_str().unwrap()
        );
        tokio::fs::remove_dir(&eternal).await.unwrap();
        tokio::fs::write(&eternal, "echo eternal\n").await.unwrap();
        assert_eq!(
            readline_history_source(&env).await,
            eternal.to_str().unwrap()
        );
        env.insert(
            "TERMAI_ETERNAL_HISTORY_FILE".into(),
            "/custom/eternal".into(),
        );
        assert_eq!(readline_history_source(&env).await, "/custom/eternal");
        env.insert("TERMAI_HISTORY_FILE".into(), "/custom/history".into());
        assert_eq!(readline_history_source(&env).await, "/custom/history");
        assert!(history_sources(&env).await.is_empty());
    }
    #[tokio::test]
    async fn bounded_utf8_tails_filter_private_and_timestamp_lines_and_cache_refreshes() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("history");
        let file = file.to_str().unwrap();
        let raw =
            "x".repeat(HISTORY_BYTES + 100) + "\n#123456789\necho eternal 界😀\n private command\n";
        tokio::fs::write(file, raw).await.unwrap();
        assert_eq!(
            read_history(file, HISTORY_BYTES).await,
            ["echo eternal 界😀"]
        );
        let (first, concurrent) = tokio::join!(cached_history(file), cached_history(file));
        assert!(Arc::ptr_eq(&first, &concurrent));
        assert!(Arc::ptr_eq(&first, &cached_history(file).await));
        tokio::fs::write(file, "echo changed\n").await.unwrap();
        assert_eq!(&*cached_history(file).await, &["echo changed"]);
        tokio::fs::remove_file(file).await.unwrap();
        assert!(cached_history(file).await.is_empty());
        let lines = (0..5500)
            .map(|i| format!("echo eternal-{i}\n"))
            .collect::<String>();
        assert_eq!(history_lines(&lines, false).len(), HISTORY_ENTRIES);
        assert_eq!(history_lines(&lines, false)[0], "echo eternal-500");
    }
    #[tokio::test]
    async fn sources_deduplicate_latest_occurrence_and_honor_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let standard = directory.path().join(".bash_history");
        let eternal = directory.path().join(".bash_eternal_history");
        tokio::fs::write(&standard, "echo common\necho standard\n")
            .await
            .unwrap();
        tokio::fs::write(&eternal, "echo eternal\necho common\n")
            .await
            .unwrap();
        let mut env = BTreeMap::from([("HOME".into(), directory.path().to_str().unwrap().into())]);
        assert_eq!(
            history_sources(&env).await,
            ["echo standard", "echo eternal", "echo common"]
        );
        env.insert(
            "TERMAI_HISTORY_FILE".into(),
            standard.to_str().unwrap().into(),
        );
        assert_eq!(
            history_sources(&env).await,
            ["echo common", "echo standard"]
        );
        env.insert(
            "TERMAI_ETERNAL_HISTORY_FILE".into(),
            standard.to_str().unwrap().into(),
        );
        assert_eq!(
            history_sources(&env).await,
            ["echo common", "echo standard"]
        );
        env.insert("TERMAI_HISTORY_FILE".into(), "/dev/null".into());
        env.remove("TERMAI_ETERNAL_HISTORY_FILE");
        assert!(history_sources(&env).await.is_empty());
    }
}
