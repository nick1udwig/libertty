use crate::types::{CommandMetadata, Flag};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Vocabulary {
    pub common_flags: BTreeMap<String, Vec<Flag>>,
    pub subcommands: BTreeMap<String, Vec<String>>,
    pub symbol_names: BTreeMap<String, String>,
}
pub(crate) fn vocabulary() -> &'static Vocabulary {
    static DATA: OnceLock<Vocabulary> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/engine-vocabulary.json"))
            .expect("engine vocabulary")
    })
}
pub fn flags_for(scope: &str, metadata: &CommandMetadata) -> Vec<Flag> {
    flags_ref(scope, metadata, &[]).to_vec()
}
pub(crate) fn flags_ref<'a>(
    scope: &str,
    metadata: &'a CommandMetadata,
    fallback: &'a [Flag],
) -> &'a [Flag] {
    metadata
        .flags
        .get(scope)
        .or_else(|| vocabulary().common_flags.get(scope))
        .map(Vec::as_slice)
        .unwrap_or(fallback)
}
pub fn subcommands_for(scope: &str, metadata: &CommandMetadata) -> Vec<String> {
    subcommands_ref(scope, metadata).to_vec()
}
pub(crate) fn subcommands_ref<'a>(scope: &str, metadata: &'a CommandMetadata) -> &'a [String] {
    metadata
        .subcommands
        .get(scope)
        .or_else(|| vocabulary().subcommands.get(scope))
        .map(Vec::as_slice)
        .unwrap_or_default()
}
pub fn child_scope(scope: &str, word: &str, metadata: &CommandMetadata) -> Option<String> {
    subcommands_ref(scope, metadata)
        .iter()
        .any(|name| name == word)
        .then(|| format!("{scope} {word}"))
}
pub fn option_arity(value: &str, flags: &[Flag]) -> Option<bool> {
    let (name, attached) = value
        .split_once('=')
        .map_or((value, false), |(name, _)| (name, true));
    if let Some(flag) = flags.iter().find(|flag| flag.name == name) {
        return Some(!attached && flag.takes_value);
    }
    if !value.starts_with('-') || value.starts_with("--") || value.chars().count() < 3 || attached {
        return None;
    }
    let chars: Vec<_> = value.chars().skip(1).collect();
    for (index, ch) in chars.iter().enumerate() {
        let flag = flags.iter().find(|flag| flag.name == format!("-{ch}"))?;
        if flag.takes_value {
            return Some(index == chars.len() - 1);
        }
    }
    Some(false)
}
pub fn script_command(command: &str) -> bool {
    ["python", "python3", "node", "ruby", "bash", "sh"].contains(&command)
}
pub fn directory_command(command: &str) -> bool {
    ["cd", "pushd", "upload"].contains(&command)
}
pub fn input_file_command(command: &str) -> bool {
    [
        "download", "cat", "less", "more", "head", "tail", "file", "stat", "wc", "du", "ls",
    ]
    .contains(&command)
}
pub fn editor_command(command: &str) -> bool {
    ["vi", "vim", "nvim", "view", "nano", "emacs", "micro", "hx"].contains(&command)
}
pub fn is_path_position<T: AsRef<str>>(args: &[T]) -> bool {
    let Some(command) = args.first().map(AsRef::as_ref) else {
        return false;
    };
    input_file_command(command)
        || editor_command(command)
        || directory_command(command)
        || (script_command(command) && args.len() == 1)
        || (command == "git" && args.get(1).is_some_and(|arg| arg.as_ref() == "add"))
}
