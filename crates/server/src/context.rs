use libertty_engine::path;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::SystemTime,
};
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FileStamp {
    inode: u64,
    modified: Option<SystemTime>,
    length: u64,
}
impl FileStamp {
    pub(crate) fn new(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            inode: metadata.ino(),
            modified: metadata.modified().ok(),
            length: metadata.len(),
        }
    }
}
struct Parsed<T> {
    stamp: Option<FileStamp>,
    raw: String,
    value: Arc<T>,
}
async fn cached<T>(
    file: String,
    previous: &mut Option<Parsed<T>>,
    parse: impl FnOnce(&str) -> T,
) -> Arc<T> {
    let stamp = tokio::fs::metadata(&file)
        .await
        .ok()
        .as_ref()
        .map(FileStamp::new);
    if let Some(previous) = previous.as_ref()
        && previous.stamp == stamp
    {
        return previous.value.clone();
    }
    let raw = tokio::fs::read_to_string(&file).await.unwrap_or_default();
    let value = match previous.as_ref() {
        Some(previous) if previous.raw == raw => previous.value.clone(),
        _ => Arc::new(parse(&raw)),
    };
    *previous = Some(Parsed {
        stamp,
        raw,
        value: value.clone(),
    });
    value
}
#[derive(Default)]
struct State {
    directory: String,
    value: Option<(u64, ShellContext)>,
    commands: Option<Parsed<Vec<String>>>,
    functions: Option<Parsed<Vec<String>>>,
    environment: Option<Parsed<BTreeMap<String, String>>>,
}
#[derive(Default)]
pub struct Cache {
    state: tokio::sync::Mutex<State>,
}
impl Cache {
    pub async fn get(&self, dir: &str, prompt: u64) -> ShellContext {
        let mut state = self.state.lock().await;
        if state.directory != dir {
            *state = State {
                directory: dir.into(),
                ..State::default()
            };
        }
        if let Some((revision, context)) = &state.value
            && *revision == prompt
        {
            return context.clone();
        }
        let context = if dir.is_empty() {
            ShellContext {
                commands: Arc::default(),
                functions: Arc::default(),
                environment: Arc::new(std::env::vars().collect()),
            }
        } else {
            let State {
                commands,
                functions,
                environment,
                ..
            } = &mut *state;
            let (commands, functions, environment) = tokio::join!(
                cached(path::join(&[dir, "commands"]), commands, |raw| {
                    let mut commands: Vec<_> = raw
                        .split('\n')
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect();
                    commands.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                    commands
                }),
                cached(path::join(&[dir, "functions"]), functions, |raw| raw
                    .split('\n')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()),
                cached(path::join(&[dir, "environment"]), environment, |raw| {
                    if raw.is_empty() {
                        std::env::vars().collect()
                    } else {
                        raw.split('\0')
                            .filter_map(|s| s.split_once('='))
                            .map(|(k, v)| (k.into(), v.into()))
                            .collect()
                    }
                })
            );
            ShellContext {
                commands,
                functions,
                environment,
            }
        };
        state.value = Some((prompt, context.clone()));
        context
    }
}
#[derive(Clone)]
pub struct ShellContext {
    pub commands: Arc<Vec<String>>,
    pub functions: Arc<Vec<String>>,
    pub environment: Arc<BTreeMap<String, String>>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn prompts_coalesce_and_reuse_unchanged_parsed_files() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path().to_str().unwrap();
        for (file, raw) in [
            ("commands", "git\nls\ngit\n"),
            ("functions", "_helper\n"),
            ("environment", "PATH=/bin\0HOME=/tmp\0"),
        ] {
            tokio::fs::write(directory.path().join(file), raw)
                .await
                .unwrap();
        }
        let cache = Cache::default();
        let (first, concurrent) = tokio::join!(cache.get(dir, 1), cache.get(dir, 1));
        assert!(Arc::ptr_eq(&first.commands, &concurrent.commands));
        assert!(Arc::ptr_eq(&first.environment, &concurrent.environment));
        assert_eq!(&*first.commands, &["git", "ls"]);
        tokio::fs::write(
            directory.path().join("environment"),
            "PATH=/bin\0HOME=/tmp\0",
        )
        .await
        .unwrap();
        let second = cache.get(dir, 2).await;
        assert!(Arc::ptr_eq(&first.commands, &second.commands));
        assert!(Arc::ptr_eq(&first.functions, &second.functions));
        assert!(Arc::ptr_eq(&first.environment, &second.environment));
        tokio::fs::write(directory.path().join("commands"), "newtool\n")
            .await
            .unwrap();
        tokio::fs::write(directory.path().join("environment"), "PATH=/new/bin\0")
            .await
            .unwrap();
        let third = cache.get(dir, 3).await;
        assert_eq!(&*third.commands, &["newtool"]);
        assert_eq!(third.environment["PATH"], "/new/bin");
        assert!(Arc::ptr_eq(&second.functions, &third.functions));
        assert!(Arc::ptr_eq(
            &third.commands,
            &cache.get(dir, 3).await.commands
        ));
    }
}
