use crate::{
    command_profiles::{OperandCheck, profile},
    types::{CommandMetadata, Flag, ValueKind},
};
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
    crate::arguments::option_binding(value, flags).map(|binding| binding.takes_value)
}

pub fn script_command(command: &str) -> bool {
    profile(command)
        .operands
        .as_ref()
        .is_some_and(|operands| operands.check == OperandCheck::First)
}
/// Locate a script after interpreter options, without interpreting script arguments.
pub fn script_operand<T: AsRef<str>>(args: &[T]) -> Option<usize> {
    let command = args.first()?.as_ref();
    if !script_command(command) {
        return None;
    }
    let metadata = CommandMetadata::default();
    let mut cursor =
        crate::arguments::ArgumentCursor::new(args.iter().map(AsRef::as_ref), &metadata);
    while let Some(argument) = cursor.next() {
        use crate::arguments::Argument;
        match argument {
            Argument::Operand(index) => return Some(index),
            Argument::UnknownOption => return None,
            Argument::Option {
                index, complete, ..
            } => {
                if !complete || ["-c", "-m", "-e", "--eval"].contains(&args[index].as_ref()) {
                    return None;
                }
            }
            Argument::Delimiter | Argument::Subcommand => {}
        }
    }
    None
}
pub fn directory_command(command: &str) -> bool {
    profile(command).repair_kind == Some(ValueKind::Directory)
}
pub fn input_file_command(command: &str) -> bool {
    matches!(
        profile(command).repair_kind,
        Some(ValueKind::Path | ValueKind::InputFile)
    ) && !editor_command(command)
}
pub fn editor_command(command: &str) -> bool {
    profile(command)
        .operands
        .as_ref()
        .is_some_and(|operands| operands.check == OperandCheck::Repaired)
}
pub fn is_path_position<T: AsRef<str>>(args: &[T]) -> bool {
    let Some(command) = args.first().map(AsRef::as_ref) else {
        return false;
    };
    input_file_command(command)
        || editor_command(command)
        || directory_command(command)
        || (script_command(command)
            && script_operand(args).is_none()
            && !args
                .iter()
                .any(|arg| ["-c", "-m", "-e", "--eval"].contains(&arg.as_ref())))
        || args.get(1).is_some_and(|arg| {
            profile(&format!("{command} {}", arg.as_ref()))
                .operands
                .as_ref()
                .is_some_and(|operands| operands.check == OperandCheck::All)
        })
}
