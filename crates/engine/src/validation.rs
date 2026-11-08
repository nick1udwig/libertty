use crate::test;
use crate::types::Word;
use crate::{
    command_policy::*,
    command_profiles::{OperandCheck, profile},
    host::{self, Host},
    path,
    repair::command_available,
    types::{Candidate, Catalog, CommandMetadata, Flag, ValueKind},
};
use std::collections::BTreeMap;

pub type Environment = BTreeMap<String, String>;
fn resolve(word: &Word, cwd: &str, env: &Environment) -> String {
    let value = if word.home && (word.value == "~" || word.value.starts_with("~/")) {
        path::join(&[
            env.get("HOME")
                .filter(|home| !home.is_empty())
                .map_or(cwd, String::as_str),
            &word.value[1..],
        ])
    } else {
        word.value.clone()
    };
    path::resolve(&[cwd, &value])
}

pub async fn candidate_valid(
    input: &str,
    candidate: &Candidate,
    catalog: &Catalog,
    env: &Environment,
    metadata: &CommandMetadata,
    host: &dyn Host,
    script_flags: Option<&[Flag]>,
) -> Result<bool, String> {
    // Poll independent syntax and policy facts together, preserving browser batching.
    let (syntax, policy) = futures::join!(
        host::syntax(host, &candidate.command),
        policy_valid(input, candidate, catalog, env, metadata, host, script_flags)
    );
    let syntax = syntax?;
    let policy = policy?;
    Ok(syntax && policy)
}
async fn policy_valid(
    input: &str,
    candidate: &Candidate,
    catalog: &Catalog,
    env: &Environment,
    metadata: &CommandMetadata,
    host: &dyn Host,
    script_flags: Option<&[Flag]>,
) -> Result<bool, String> {
    if let Some(list) = crate::shell_structure::command_list(&candidate.command) {
        let checked = futures::future::join_all(list.commands.iter().map(|part| async move {
            let mut node = candidate.clone();
            node.command = (*part).into();
            let protected = crate::shell_structure::protect(part);
            if let Some(protected) = &protected {
                node.command = protected.text.clone();
            }
            let opaque = protected
                .as_ref()
                .map(|p| {
                    p.expressions
                        .iter()
                        .map(|(key, _)| key.as_str())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            policy_plain(
                input,
                &node,
                catalog,
                env,
                metadata,
                host,
                PolicyScope {
                    script_flags,
                    opaque: &opaque,
                },
            )
            .await
        }))
        .await;
        return Ok(checked
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .all(|valid| valid));
    }
    if let Some(protected) = crate::shell_structure::protect(&candidate.command) {
        let mut node = candidate.clone();
        node.command = protected.text.clone();
        let opaque = protected
            .expressions
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>();
        return policy_plain(
            input,
            &node,
            catalog,
            env,
            metadata,
            host,
            PolicyScope {
                script_flags,
                opaque: &opaque,
            },
        )
        .await;
    }
    policy_plain(
        input,
        candidate,
        catalog,
        env,
        metadata,
        host,
        PolicyScope {
            script_flags,
            opaque: &[],
        },
    )
    .await
}
struct PolicyScope<'a> {
    script_flags: Option<&'a [Flag]>,
    opaque: &'a [&'a str],
}
async fn policy_plain(
    input: &str,
    candidate: &Candidate,
    catalog: &Catalog,
    env: &Environment,
    metadata: &CommandMetadata,
    host: &dyn Host,
    scope: PolicyScope<'_>,
) -> Result<bool, String> {
    let PolicyScope {
        script_flags,
        opaque,
    } = scope;
    let Some(parsed) = crate::arguments::ParsedCommand::parse(&candidate.command) else {
        return Ok(false);
    };
    let words = parsed.words;
    let Some(first) = words.first() else {
        return Ok(false);
    };
    let command = &first.value;
    if !command_available(input, catalog, command) {
        if !command.contains('/') {
            return Ok(false);
        }
        let Some(info) = host::stat(host, &resolve(first, &catalog.cwd, env), true).await? else {
            return Ok(false);
        };
        if !info.file || !info.executable {
            return Ok(false);
        }
    }
    let mut cwd = catalog.cwd.clone();
    use crate::arguments::{Argument, ArgumentCursor};
    let mut cursor = ArgumentCursor::new(words.iter().map(|word| word.value.as_str()), metadata);
    let mut value_flags = Vec::new();
    let mut operands = Vec::new();
    let mut option_paths = Vec::new();
    while let Some(argument) = cursor.next() {
        match argument {
            Argument::Delimiter | Argument::Subcommand => {}
            Argument::UnknownOption => return Ok(false),
            Argument::Option {
                index,
                binding,
                following,
                complete,
            } => {
                let arg = &words[index].value;
                let descriptor = binding.descriptor;
                if !complete
                    || binding.attached.is_some()
                        && descriptor.is_some_and(|flag| {
                            !flag.takes_value && flag.optional_value != Some(true)
                        })
                {
                    return Ok(false);
                }
                let mut supplied = Vec::new();
                if let Some(value) = binding.attached {
                    supplied.push(Word {
                        value: value.into(),
                        home: false,
                    });
                }
                supplied.extend_from_slice(&words[following]);
                if !supplied.is_empty() {
                    value_flags.push(arg.as_str());
                    if command == "git" && arg == "-C" {
                        cwd = resolve(&supplied[0], &cwd, env);
                    }
                }
                if let Some(schema) = descriptor.and_then(|flag| flag.value.as_ref()) {
                    for value in supplied {
                        if opaque.contains(&value.value.as_str()) {
                            continue;
                        }
                        if schema.kind == ValueKind::Choice
                            && schema
                                .choices
                                .as_ref()
                                .is_some_and(|choices| !choices.contains(&value.value))
                        {
                            return Ok(false);
                        }
                        if matches!(
                            schema.kind,
                            ValueKind::Path | ValueKind::Directory | ValueKind::InputFile
                        ) {
                            option_paths.push((value, schema.kind));
                        }
                    }
                }
            }
            Argument::Operand(index) => {
                if !cursor.literal && !subcommands_ref(&cursor.scope, metadata).is_empty() {
                    return Ok(false);
                }
                operands.push(&words[index]);
                if test!(r###"^python[23]?$"###, command) && operands.len() == 1 {
                    cursor.flags = script_flags;
                }
            }
        }
    }
    let scope = cursor.scope;
    let help = words
        .iter()
        .any(|word| ["--help", "-h", "--version"].contains(&word.value.as_str()));
    let required = metadata
        .required_positionals
        .as_ref()
        .and_then(|values| values.get(&scope));
    let pattern_flag = ["grep", "rg"].contains(&command.as_str())
        && value_flags
            .iter()
            .any(|flag| ["-e", "--regexp", "-f", "--file"].contains(flag));
    if !help && required.is_some_and(|required| operands.len() < *required) && !pattern_flag {
        return Ok(false);
    }
    if help {
        return Ok(true);
    }
    let profile = profile(&scope);
    let policy = profile.operands.as_ref();
    if policy.is_some_and(|policy| {
        operands.len() < policy.schema.minimum
            || policy
                .schema
                .maximum
                .is_some_and(|maximum| operands.len() > maximum)
    }) {
        return Ok(false);
    }
    let count = policy.map_or(0, |policy| match policy.check {
        OperandCheck::All => operands.len(),
        OperandCheck::First => {
            if words
                .iter()
                .any(|word| ["-c", "-m", "-e", "--eval"].contains(&word.value.as_str()))
            {
                0
            } else {
                operands.len().min(1)
            }
        }
        OperandCheck::Repaired => {
            if candidate.changes.iter().any(|change| {
                matches!(
                    change,
                    crate::types::Change::File(_) | crate::types::Change::VerifiedFile
                )
            }) {
                operands.len()
            } else {
                0
            }
        }
    });
    let mut paths = option_paths;
    if let Some(policy) = policy {
        for operand in operands.into_iter().take(count) {
            if operand.value == "-" && !policy.dash_is_path
                || opaque.contains(&operand.value.as_str())
            {
                continue;
            }
            paths.push((operand.clone(), policy.schema.kind));
        }
    }
    let checked = futures::future::join_all(paths.into_iter().map(|(operand, kind)| {
        let cwd = &cwd;
        async move {
            let Ok(Some(info)) = host::stat(host, &resolve(&operand, cwd, env), false).await else {
                return false;
            };
            match kind {
                ValueKind::Directory => info.directory,
                ValueKind::InputFile => info.file,
                _ => info.file || info.directory,
            }
        }
    }))
    .await;
    Ok(checked.into_iter().all(|valid| valid))
}

/// Parse plain shell arguments without expansion or execution.
pub fn simple_words(line: &str) -> Option<Vec<Word>> {
    crate::arguments::ParsedCommand::parse(line).map(|parsed| parsed.words)
}
