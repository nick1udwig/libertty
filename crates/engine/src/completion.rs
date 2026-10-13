use crate::{
    command_policy::{child_scope, flags_for, is_path_position, option_arity, subcommands_for},
    host::{self, Host},
    repair::{argument_matches, key, repair_candidates as repair, tokens},
    types::{Candidate, Catalog, CommandMetadata, Flag},
    util::{test, utf16_len},
    validation::simple_words,
};
use std::collections::BTreeMap;

fn operand_position(args: &[String], metadata: &CommandMetadata) -> bool {
    if is_path_position(args) || ["echo", "printf"].contains(&args[0].as_str()) {
        return false;
    }
    let mut scope = args[0].clone();
    let mut literal = false;
    let (mut operands, mut supplied_text, mut i) = (0, false, 1);
    while i < args.len() {
        let word = &args[i];
        if !literal && word == "--" {
            literal = true;
            i += 1;
            continue;
        }
        if !literal && word.starts_with('-') {
            let Some(takes) = option_arity(word, &flags_for(&scope, metadata)) else {
                return false;
            };
            if takes {
                i += 1;
                if i >= args.len() {
                    return false;
                }
            }
            if takes && ["-e", "--regexp", "-f", "--file"].contains(&word.as_str()) {
                supplied_text = true;
            }
        } else if let Some(child) = (!literal)
            .then(|| child_scope(&scope, word, metadata))
            .flatten()
        {
            scope = child;
        } else {
            operands += 1;
        }
        i += 1;
    }
    if ["grep", "rg", "sed", "awk"].contains(&args[0].as_str()) && operands == 0 && !supplied_text {
        return false;
    }
    literal || subcommands_for(&scope, metadata).is_empty()
}

pub async fn complete_arguments(
    input: &str,
    catalog: &Catalog,
    metadata: &CommandMetadata,
    host: &dyn Host,
    script_flags: Option<&[Flag]>,
) -> Result<Vec<Candidate>, String> {
    if !host.supports_completion() || simple_words(input).is_none() {
        return Ok(vec![]);
    }
    let words = tokens(input);
    if words.len() > 64 || utf16_len(input) > 2000 {
        return Ok(vec![]);
    }
    let mut learned = metadata.clone();
    learned.argument_values = Some(BTreeMap::new());
    let deadline = host.now_ms() + 1500.0;
    let requests = std::cell::Cell::new(0usize);
    // Independent contexts share a callback wave; a second pass can use earlier corrections.
    for _ in 0..2 {
        let mut pending = Vec::new();
        for index in 1..words.len() {
            let word = &words[index];
            if word.quoted || test("(?i)^-|^(dash|hyphen|hep)$", &word.value) {
                continue;
            }
            let prefix = words[..index]
                .iter()
                .map(|word| {
                    if word.quoted {
                        format!("'{}'", word.value.replace('\'', "'\\''"))
                    } else {
                        word.value.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            for candidate in repair(&prefix, catalog, script_flags, &learned)
                .into_iter()
                .filter(|c| !c.is_literal())
                .take(2)
            {
                let Some(args) = simple_words(&candidate.command)
                    .map(|ws| ws.into_iter().map(|w| w.value).collect::<Vec<_>>())
                    .filter(|args| !args.is_empty())
                else {
                    continue;
                };
                if !operand_position(&args, metadata) {
                    continue;
                }
                let script_option = crate::command_policy::script_operand(&args).is_some()
                    && script_flags.is_some_and(|flags| {
                        flags.iter().any(|flag| key(&word.value) == key(&flag.name))
                    });
                let option = repair(
                    &format!("{} {}", candidate.command, word.value),
                    catalog,
                    script_flags,
                    metadata,
                )
                .iter()
                .filter(|c| !c.is_literal())
                .any(|c| {
                    tokens(&c.command)
                        .last()
                        .is_some_and(|w| w.value.starts_with('-'))
                });
                if script_option || option {
                    continue;
                }
                let context = serde_json::to_string(&args).expect("completion context");
                if !learned
                    .argument_values
                    .as_ref()
                    .unwrap()
                    .contains_key(&context)
                    && !pending.iter().any(|(old, _, _)| old == &context)
                {
                    pending.push((context, args, index));
                }
            }
        }
        if pending.is_empty() || requests.get() >= 6 || host.now_ms() >= deadline {
            break;
        }
        let count = (6 - requests.get()).div_ceil(2);
        let replies = futures::future::join_all(pending.into_iter().take(count).map(
            |(context, args, index)| {
                let requests = &requests;
                let words = &words;
                async move {
                    if requests.get() >= 6 || host.now_ms() >= deadline {
                        return (context, vec![]);
                    }
                    requests.set(requests.get() + 1);
                    let mut prefix = words[index].value.to_lowercase();
                    if test("(?i)^[a-z]$", &prefix)
                        && words
                            .get(index + 1)
                            .is_some_and(|w| test("(?i)^[a-z]$", &w.value))
                    {
                        prefix.push_str(&words[index + 1].value.to_lowercase());
                    }
                    prefix = if test("(?i)^[a-z0-9_]", &prefix) {
                        prefix.chars().take(2).collect()
                    } else {
                        String::new()
                    };
                    let mut request = args;
                    request.push(prefix.clone());
                    let mut values =
                        host::complete(host, &request, (deadline - host.now_ms()).max(0.0))
                            .await
                            .unwrap_or_default();
                    // Nonempty but unrelated narrow results must not hide a useful broader match.
                    if argument_matches(words, index, &values).is_empty()
                        && !prefix.is_empty()
                        && requests.get() < 6
                        && host.now_ms() < deadline
                    {
                        requests.set(requests.get() + 1);
                        *request.last_mut().unwrap() = String::new();
                        if let Ok(broad) =
                            host::complete(host, &request, (deadline - host.now_ms()).max(0.0))
                                .await
                        {
                            for value in broad {
                                if !values.contains(&value) {
                                    values.push(value);
                                }
                            }
                        }
                    }
                    (context, values)
                }
            },
        ))
        .await;
        learned.argument_values.as_mut().unwrap().extend(replies);
    }
    Ok(repair(input, catalog, script_flags, &learned)
        .into_iter()
        .filter(|c| {
            c.changes
                .iter()
                .any(|change| change.starts_with("Completion →"))
        })
        .collect())
}
