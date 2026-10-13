use crate::types::Word;
use crate::{
    command_policy::*,
    host::{self, Host},
    path,
    repair::command_available,
    types::{Candidate, Catalog, CommandMetadata, Flag},
    util::test,
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
    let Some(words) = simple_words(&candidate.command) else {
        return Ok(true);
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
    let mut index = 1;
    while index < words.len() {
        let word = &words[index];
        let arg = &word.value;
        index += 1;
        if !literal && arg == "--" {
            literal = true;
            continue;
        }
        if !literal && test("^-.", arg) {
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
            if takes {
                let Some(value) = words.get(index) else {
                    return Ok(false);
                };
                index += 1;
                value_flags.push(arg.as_str());
                if command == "git" && arg == "-C" {
                    cwd = resolve(value, &cwd, env);
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
        if test("^python[23]?$", command)
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
            && candidate
                .changes
                .iter()
                .any(|change| change.starts_with("File →"));
    let count = if check_all {
        operands.len()
    } else if script {
        operands.len().min(1)
    } else {
        0
    };
    let checked = futures::future::join_all(operands.into_iter().take(count).map(|operand| {
        let cwd = &cwd;
        async move {
            if operand.value == "-" && command != "download" && command != "upload" {
                return true;
            }
            let Ok(Some(info)) = host::stat(host, &resolve(operand, cwd, env), false).await else {
                return false;
            };
            !((directory_only && !info.directory)
                || ((script || command == "download") && !info.file))
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
