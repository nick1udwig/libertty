//! Shared command policy for local and SSH fact adapters.
use libertty_engine::{
    command_policy::{script_operand, subcommands_for},
    path,
    repair::tokens,
    types::{CommandMetadata, Help},
};
use std::collections::BTreeMap;

pub(crate) const BUILTINS: &[&str] = &[
    "cd", "echo", "printf", "export", "alias", "history", "source", "jobs", "fg", "bg", "type",
    "read", "pwd", "set", "unset", "umask", "ulimit", "pushd", "popd",
];
pub(crate) fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
}
pub(crate) fn help_children(command: &str, route: &[String], parent: &Help) -> Vec<String> {
    if command == "git" && route.is_empty() {
        return parent
            .safe_subcommands
            .clone()
            .unwrap_or_else(|| subcommands_for("git", &CommandMetadata::default()));
    }
    if let Some(probes) = &parent.probe_subcommands {
        return probes.clone();
    }
    let scope = std::iter::once(command)
        .chain(route.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    parent
        .subcommands
        .iter()
        .cloned()
        .chain(subcommands_for(&scope, &CommandMetadata::default()))
        .collect()
}
pub(crate) fn help_args(command: &str, route: &[String]) -> Vec<String> {
    if BUILTINS.contains(&command) {
        return [
            "--noprofile",
            "--norc",
            "-c",
            "builtin help \"$1\"",
            "libertty-help",
            command,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
    }
    route
        .iter()
        .cloned()
        .chain(std::iter::once(
            if command == "git" && !route.is_empty() {
                "-h"
            } else {
                "--help"
            }
            .into(),
        ))
        .collect()
}
pub(crate) fn help_environment(mut env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.extend(
        [
            ("BASH_ENV", "/dev/null"),
            ("ENV", "/dev/null"),
            ("NO_COLOR", "1"),
            ("PAGER", "cat"),
            ("GIT_PAGER", "cat"),
            ("TERM", "dumb"),
            ("LC_ALL", "C"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into())),
    );
    env
}
pub(crate) fn manual_environment(home: &str) -> BTreeMap<String, String> {
    [
        ("PATH", "/usr/bin:/bin"),
        ("HOME", home),
        ("MANWIDTH", "100"),
        ("MANPAGER", "cat"),
        ("MANOPT", ""),
        ("LC_ALL", "C"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}
pub(crate) fn python_script(command: &str, cwd: &str) -> Option<String> {
    let words = tokens(command);
    if !words
        .first()
        .is_some_and(|word| ["python", "python3"].contains(&word.value.as_str()))
    {
        return None;
    }
    let index = script_operand(&words.iter().map(|word| &word.value).collect::<Vec<_>>())?;
    words[index]
        .value
        .ends_with(".py")
        .then(|| path::resolve(&[cwd, &words[index].value]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_help_routes_take_precedence_over_vocabulary() {
        let parent = Help {
            probe_subcommands: Some(vec!["safe".into()]),
            ..Default::default()
        };
        assert_eq!(help_children("tool", &[], &parent), ["safe"]);
        let git = Help {
            safe_subcommands: Some(vec!["status".into()]),
            subcommands: vec!["unsafe-alias".into()],
            ..Default::default()
        };
        assert_eq!(help_children("git", &[], &git), ["status"]);
    }
    #[test]
    fn scripts_follow_interpreter_options_and_exclude_inline_code() {
        assert_eq!(
            python_script("python3 -u 'a b.py'", "/work"),
            Some("/work/a b.py".into())
        );
        assert_eq!(python_script("python3 -c 'x.py'", "/work"), None);
        assert_eq!(python_script("node x.py", "/work"), None);
    }
    #[test]
    fn help_environment_overrides_startup_hooks_and_preserves_host_values() {
        let env = help_environment(BTreeMap::from([
            ("PATH".into(), "/custom".into()),
            ("BASH_ENV".into(), "/unsafe".into()),
        ]));
        assert_eq!(env["PATH"], "/custom");
        assert_eq!(env["BASH_ENV"], "/dev/null");
        assert_eq!(help_args("cd", &[])[3], "builtin help \"$1\"");
        assert_eq!(help_args("git", &["status".into()]), ["status", "-h"]);
    }
}
