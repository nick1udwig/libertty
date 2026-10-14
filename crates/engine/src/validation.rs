use crate::test;
use crate::types::Word;
use crate::{
    command_policy::*,
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
    let Some(words) = simple_words(&candidate.command) else {
        return Ok(false);
    };
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
    let mut scope = command.clone();
    let mut flags = flags_for(command, metadata);
    let mut literal = false;
    let mut value_flags = Vec::new();
    let mut operands = Vec::new();
    let mut option_paths = Vec::new();
    let mut index = 1;
    while index < words.len() {
        let word = &words[index];
        let arg = &word.value;
        index += 1;
        if !literal && arg == "--" {
            literal = true;
            continue;
        }
        if !literal && test!(r###"^-."###, arg) {
            let Some(takes) = option_arity(arg, &flags) else {
                return Ok(false);
            };
            if let Some((name, _)) = arg.split_once('=')
                && flags.iter().any(|flag| {
                    flag.name == name && !flag.takes_value && flag.optional_value != Some(true)
                })
            {
                return Ok(false);
            }
            let descriptor = flags
                .iter()
                .find(|flag| flag.name == arg.split('=').next().unwrap());
            let (mut minimum, mut maximum) = descriptor
                .map(Flag::value_bounds)
                .unwrap_or((usize::from(takes), Some(usize::from(takes))));
            let mut supplied = Vec::new();
            if let Some((_, value)) = arg.split_once('=') {
                supplied.push(Word {
                    value: value.into(),
                    home: false,
                });
                minimum = minimum.saturating_sub(1);
                maximum = maximum.map(|n| n.saturating_sub(1));
            }
            let mut count = 0;
            while maximum.is_none_or(|maximum| count < maximum) && index < words.len() {
                let value = &words[index];
                if value.value == "--" || option_arity(&value.value, &flags).is_some() {
                    break;
                }
                supplied.push(value.clone());
                count += 1;
                index += 1;
            }
            if count < minimum {
                return Ok(false);
            }
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
            continue;
        }
        if !literal && !subcommands_for(&scope, metadata).is_empty() {
            let Some(child) = child_scope(&scope, arg, metadata) else {
                return Ok(false);
            };
            scope = child;
            flags = flags_for(&scope, metadata);
            continue;
        }
        operands.push(word);
        if test!(r###"^python[23]?$"###, command)
            && operands.len() == 1
            && let Some(script_flags) = script_flags
        {
            flags = script_flags.to_vec();
        }
    }
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
    let directory_only = directory_command(command);
    if directory_only && operands.len() > 1 || command == "download" && operands.len() != 1 {
        return Ok(false);
    }
    let script = script_command(command)
        && !words
            .iter()
            .any(|word| ["-c", "-m", "-e", "--eval"].contains(&word.value.as_str()));
    let check_all = directory_only
        || input_file_command(command)
        || command == "git" && scope == "git add"
        || editor_command(command)
            && candidate.changes.iter().any(|change| {
                matches!(
                    change,
                    crate::types::Change::File(_) | crate::types::Change::VerifiedFile
                )
            });
    let count = if check_all {
        operands.len()
    } else if script {
        operands.len().min(1)
    } else {
        0
    };
    let mut paths = option_paths;
    for operand in operands.into_iter().take(count) {
        if operand.value == "-" && command != "download" && command != "upload"
            || opaque.contains(&operand.value.as_str())
        {
            continue;
        }
        paths.push((
            operand.clone(),
            if directory_only {
                ValueKind::Directory
            } else if script || command == "download" {
                ValueKind::InputFile
            } else {
                ValueKind::Path
            },
        ));
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
    let mut result = Vec::new();
    let (mut value, mut quote, mut active, mut home) = (String::new(), None, false, false);
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                value.push(ch);
            }
            continue;
        }
        if ch == '\\' {
            value.push(chars.next()?);
            active = true;
            continue;
        }
        if quote == Some('"') {
            if ch == '"' {
                quote = None;
            } else if ch == '$' || ch == '`' {
                return None;
            } else {
                value.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            active = true;
            continue;
        }
        if "|&;<>()`$*?[]{}\n\r".contains(ch) {
            return None;
        }
        if crate::util::js_whitespace(ch) {
            if active {
                result.push(Word {
                    value: std::mem::take(&mut value),
                    home,
                });
            }
            value.clear();
            active = false;
            home = false;
            continue;
        }
        if !active && ch == '#' {
            return None;
        }
        if !active && ch == '~' {
            home = true;
        }
        value.push(ch);
        active = true;
    }
    if quote.is_some() {
        return None;
    }
    if active {
        result.push(Word { value, home });
    }
    Some(result)
}
