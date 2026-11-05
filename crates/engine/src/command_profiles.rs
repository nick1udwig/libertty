//! Declarative operand and wrapper behavior shared by repair and validation.
use crate::types::{ValueKind, ValueSchema};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperandCheck {
    All,
    First,
    Repaired,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Wrapper {
    Command,
    Assignments,
    Duration,
}
pub(crate) struct OperandPolicy {
    pub schema: ValueSchema,
    pub check: OperandCheck,
    pub dash_is_path: bool,
}
pub(crate) struct CommandProfile {
    pub operands: Option<OperandPolicy>,
    pub repair_kind: Option<ValueKind>,
    pub wrapper: Option<Wrapper>,
    pub changes_directory: bool,
    pub repair_bare_paths: bool,
}
const DEFAULT: CommandProfile = CommandProfile {
    operands: None,
    repair_kind: None,
    wrapper: None,
    changes_directory: false,
    repair_bare_paths: false,
};
const PATHS: OperandPolicy = OperandPolicy {
    schema: ValueSchema {
        minimum: 0,
        maximum: None,
        kind: ValueKind::Path,
        choices: None,
    },
    check: OperandCheck::All,
    dash_is_path: false,
};
const DIRECTORY_OPERANDS: OperandPolicy = OperandPolicy {
    schema: ValueSchema {
        kind: ValueKind::Directory,
        maximum: Some(1),
        ..PATHS.schema
    },
    ..PATHS
};
const DIRECTORY: CommandProfile = CommandProfile {
    operands: Some(DIRECTORY_OPERANDS),
    repair_kind: Some(ValueKind::Directory),
    ..DEFAULT
};
const INPUT: CommandProfile = CommandProfile {
    operands: Some(PATHS),
    repair_kind: Some(ValueKind::InputFile),
    ..DEFAULT
};
static PROFILES: &[(&[&str], CommandProfile)] = &[
    (
        &["cd"],
        CommandProfile {
            changes_directory: true,
            ..DIRECTORY
        },
    ),
    (&["pushd"], DIRECTORY),
    (
        &["upload"],
        CommandProfile {
            operands: Some(OperandPolicy {
                dash_is_path: true,
                ..DIRECTORY_OPERANDS
            }),
            ..DIRECTORY
        },
    ),
    (
        &["download"],
        CommandProfile {
            repair_bare_paths: true,
            operands: Some(OperandPolicy {
                schema: ValueSchema {
                    minimum: 1,
                    maximum: Some(1),
                    kind: ValueKind::InputFile,
                    ..PATHS.schema
                },
                dash_is_path: true,
                ..PATHS
            }),
            ..INPUT
        },
    ),
    (&["cat", "less", "more", "head", "tail", "wc"], INPUT),
    (
        &["file", "stat", "du", "ls"],
        CommandProfile {
            repair_kind: Some(ValueKind::Path),
            ..INPUT
        },
    ),
    (
        &["vi", "vim", "nvim", "view", "nano", "emacs", "micro", "hx"],
        CommandProfile {
            operands: Some(OperandPolicy {
                check: OperandCheck::Repaired,
                ..PATHS
            }),
            ..DEFAULT
        },
    ),
    (
        &["python", "python3", "node", "ruby", "bash", "sh"],
        CommandProfile {
            operands: Some(OperandPolicy {
                schema: ValueSchema {
                    kind: ValueKind::InputFile,
                    ..PATHS.schema
                },
                check: OperandCheck::First,
                ..PATHS
            }),
            ..DEFAULT
        },
    ),
    (
        &["git add"],
        CommandProfile {
            operands: Some(PATHS),
            ..DEFAULT
        },
    ),
    (
        &["sudo", "command", "nohup", "nice"],
        CommandProfile {
            wrapper: Some(Wrapper::Command),
            ..DEFAULT
        },
    ),
    (
        &["env"],
        CommandProfile {
            wrapper: Some(Wrapper::Assignments),
            ..DEFAULT
        },
    ),
    (
        &["timeout"],
        CommandProfile {
            wrapper: Some(Wrapper::Duration),
            ..DEFAULT
        },
    ),
];
pub(crate) fn profile(scope: &str) -> &'static CommandProfile {
    PROFILES
        .iter()
        .find(|(names, _)| names.contains(&scope))
        .map_or_else(
            || {
                scope
                    .split_once(' ')
                    .map_or(&DEFAULT, |(command, _)| profile(command))
            },
            |(_, profile)| profile,
        )
}
pub(crate) fn directory_commands() -> Vec<String> {
    PROFILES
        .iter()
        .filter(|(_, profile)| profile.repair_kind == Some(ValueKind::Directory))
        .flat_map(|(names, _)| names.iter().map(|name| (*name).to_owned()))
        .collect()
}
