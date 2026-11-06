use crate::{
    arguments::{Argument, ArgumentCursor, ParsedCommand},
    command_policy::script_operand,
    host::Host,
    path_repair::{ExpectedType, PathInput, path_input, resolve_path},
    speech::expand_symbols,
    types::{Candidate, Catalog, CommandMetadata, Flag, ValueKind},
    util::utf16_len,
};
use crate::{replace, test};

/// Resolve an existing copy destination without changing its source operands.
pub async fn repair_copy_destination(
    input: &str,
    catalog: &Catalog,
    home: &str,
    host: &dyn Host,
    metadata: &CommandMetadata,
) -> Result<Option<Vec<Candidate>>, String> {
    if !input
        .split_whitespace()
        .next()
        .is_some_and(|command| command.eq_ignore_ascii_case("cp"))
        || !catalog.commands.contains(&"cp".into())
    {
        return Ok(None);
    }
    let expanded = expand_symbols(input, true);
    let Some(parsed) = ParsedCommand::parse(&expanded) else {
        return Ok(None);
    };
    let (mut words, spans) = (parsed.words, parsed.spans);
    words[0].value = "cp".into();
    let mut cursor = ArgumentCursor::new(words.iter().map(|word| word.value.as_str()), metadata);
    let mut operands = Vec::new();
    while let Some(argument) = cursor.next() {
        match argument {
            Argument::Operand(index) => operands.push(index),
            Argument::Option {
                index, complete, ..
            } => {
                let option = &words[index].value;
                if !complete
                    || option.starts_with("--target-directory")
                    || option == "--no-target-directory"
                    || !option.starts_with("--") && option.contains(['t', 'T'])
                {
                    return Ok(None);
                }
            }
            Argument::UnknownOption => return Ok(None),
            Argument::Delimiter | Argument::Subcommand => {}
        }
    }
    for start in operands
        .into_iter()
        .skip(1)
        .filter(|&start| words[start].value.contains('/'))
        .take(4)
    {
        if words[start + 1..]
            .iter()
            .any(|word| word.home || word.value.starts_with(['/', '-']))
        {
            continue;
        }
        let target = &expanded[spans[start].start..];
        if test!(r###"[*?\[\]{}]"###, target) {
            continue;
        }
        let command = format!(
            "cp{}",
            expanded[spans[0].end..spans[start].start].trim_end()
        );
        let Some(request) = path_input(&command, "", target) else {
            continue;
        };
        let mut candidates = resolve_path(&request, catalog, home, host, ExpectedType::Directory)
            .await?
            .unwrap_or_default();
        if !candidates.is_empty() {
            for candidate in &mut candidates {
                if !request.parts.is_empty() || request.from_home {
                    candidate.command.push('/');
                }
            }
            return Ok(Some(candidates));
        }
    }
    Ok(None)
}

/// Describe a single existing-path operand; traversal is shared with directory repair.
pub async fn repair_input_file(
    input: &str,
    catalog: &Catalog,
    home: &str,
    host: &dyn Host,
    spoken_input: &str,
    metadata: &CommandMetadata,
) -> Result<Option<Vec<Candidate>>, String> {
    let expanded = expand_symbols(input, true);
    let expanded = expanded.trim();
    let Some(parsed) = ParsedCommand::parse(expanded).filter(|parsed| parsed.words.len() >= 2)
    else {
        return Ok(None);
    };
    let (mut words, spans) = (parsed.words, parsed.spans);
    let command = words[0].value.to_lowercase();
    if !matches!(
        crate::command_profiles::profile(&command).repair_kind,
        Some(ValueKind::Path | ValueKind::InputFile)
    ) || !catalog.commands.contains(&command)
    {
        return Ok(None);
    }
    words[0].value.clone_from(&command);
    let mut cursor = ArgumentCursor::new(words.iter().map(|word| word.value.as_str()), metadata);
    let index = loop {
        match cursor.next() {
            Some(Argument::Operand(index)) => break index,
            Some(
                Argument::UnknownOption
                | Argument::Option {
                    complete: false, ..
                },
            )
            | None => return Ok(None),
            _ => {}
        }
    };
    let span = &spans[index];
    let mut operand = expanded[span.start..].to_owned();
    let quoted = test!(r###"^("[^"]*"|'[^']*')$"###, &operand);
    if !crate::command_profiles::profile(&command).repair_bare_paths
        && (!operand.contains('/')
            || (test!(
                r###"[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]"###,
                &replace!(
                    r###"[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*/[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*"###,
                    &operand,
                    "/"
                )
            ) && !quoted
                && !test!(r###"(?i)(?-u:\b)slash(?-u:\b)"###, spoken_input)))
    {
        return Ok(None);
    }
    if test!(r###"[|&;<>`$\\*?\[\]{}\n\r]"###, &operand)
        || (operand.contains(['\'', '"']) && !quoted)
    {
        return Ok(None);
    }
    operand = if quoted {
        operand[1..operand.len() - 1].into()
    } else {
        replace!(
            r###"[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*/[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*"###,
            &operand,
            "/"
        )
    };
    let from_home = !quoted && (operand == "~" || operand.starts_with("~/"));
    let absolute = operand.starts_with('/');
    let parts: Vec<_> = (if from_home { &operand[1..] } else { &operand })
        .split('/')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    if parts.is_empty() || parts.len() > 16 || utf16_len(&operand) > crate::MAX_COMMAND {
        return Ok(Some(vec![]));
    }
    let request = PathInput {
        command: command.clone(),
        options: expanded[spans[0].end..span.start].trim_start().into(),
        quoted,
        from_home,
        absolute,
        prefix: if from_home {
            "~/"
        } else if absolute {
            "/"
        } else {
            ""
        }
        .into(),
        parts,
    };
    let expected = match crate::command_profiles::profile(&command).repair_kind {
        Some(ValueKind::InputFile) => ExpectedType::File,
        _ => ExpectedType::Any,
    };
    resolve_path(&request, catalog, home, host, expected).await
}

/// Resolve a schema-declared path value with the same walker as ordinary operands.
pub async fn repair_option_paths(
    input: &str,
    catalog: &Catalog,
    home: &str,
    host: &dyn Host,
    metadata: &CommandMetadata,
    script_flags: Option<&[Flag]>,
) -> Result<Vec<Candidate>, String> {
    let mut result = Vec::new();
    let deadline = (host.now_ms() + 1500.0).min(host.deadline_ms());
    for candidate in crate::repair::repair_candidates(input, catalog, script_flags, metadata)
        .into_iter()
        .filter(|c| !c.is_literal())
        .take(4)
    {
        if host.now_ms() >= deadline {
            break;
        }
        let Some(parsed) = ParsedCommand::parse(&candidate.command) else {
            continue;
        };
        let (words, spans) = (parsed.words, parsed.spans);
        if words.is_empty() {
            continue;
        }
        let script = script_operand(&words.iter().map(|w| &w.value).collect::<Vec<_>>());
        let mut cursor =
            ArgumentCursor::new(words.iter().map(|word| word.value.as_str()), metadata);
        loop {
            if script.is_some_and(|script| cursor.index > script) {
                cursor.flags = script_flags;
            }
            let Some(argument) = cursor.next() else { break };
            if matches!(argument, Argument::Delimiter) {
                break;
            }
            if let Argument::Option { index, binding, .. } = argument
                && let Some(flag) = binding.descriptor
            {
                let attached = binding.attached;
                let value_index = if attached.is_some() { index } else { index + 1 };
                if let Some(schema) = &flag.value
                    && flag.value_bounds() == (1, Some(1))
                    && matches!(
                        schema.kind,
                        ValueKind::Path | ValueKind::Directory | ValueKind::InputFile
                    )
                    && words
                        .get(value_index)
                        .is_some_and(|word| attached.unwrap_or(&word.value).contains('/'))
                {
                    let end = if attached.is_some() {
                        index + 1
                    } else {
                        ((index + 2)..words.len())
                            .find(|i| words[*i].value.starts_with('-'))
                            .unwrap_or(words.len())
                    };
                    let start = spans[value_index].start;
                    let finish = spans[end - 1].end;
                    let raw = &candidate.command[start..finish];
                    let quoted = raw.starts_with(['\'', '"']);
                    let operand = if let Some(value) = attached {
                        value.into()
                    } else if end == index + 2 {
                        words[index + 1].value.clone()
                    } else {
                        expand_symbols(raw, true)
                    };
                    if operand.contains(['$', '`', '\\', '*', '?', '[', ']']) {
                        break;
                    }
                    let from_home =
                        attached.is_none() && words[value_index].home && operand.starts_with('~');
                    let target = if from_home { &operand[1..] } else { &operand };
                    let request = PathInput {
                        command: if attached.is_some() {
                            candidate.command[..spans[index].start].trim_end().into()
                        } else {
                            candidate.command[..spans[index].end].into()
                        },
                        options: String::new(),
                        quoted,
                        from_home,
                        absolute: operand.starts_with('/'),
                        prefix: if from_home {
                            "~/"
                        } else if operand.starts_with('/') {
                            "/"
                        } else {
                            ""
                        }
                        .into(),
                        parts: target
                            .split('/')
                            .filter(|part| !part.is_empty())
                            .map(str::to_owned)
                            .collect(),
                    };
                    if request.parts.is_empty() || request.parts.len() > 16 {
                        break;
                    }
                    let expected = match schema.kind {
                        ValueKind::Directory => ExpectedType::Directory,
                        ValueKind::InputFile => ExpectedType::File,
                        _ => ExpectedType::Any,
                    };
                    for mut repaired in resolve_path(&request, catalog, home, host, expected)
                        .await?
                        .unwrap_or_default()
                    {
                        if attached.is_some() {
                            let Some(parsed) = ParsedCommand::parse(&repaired.command) else {
                                continue;
                            };
                            let Some(value) = parsed.words.last() else {
                                continue;
                            };
                            repaired.command = format!(
                                "{}{}",
                                &candidate.command[..spans[index].start],
                                crate::repair::shell_quote(&format!(
                                    "{}={}",
                                    flag.name, value.value
                                ))
                            );
                        }
                        repaired.command.push_str(&candidate.command[finish..]);
                        repaired.changes.extend(candidate.changes.clone());
                        result.push(repaired);
                    }
                    break;
                }
            }
        }
    }
    Ok(result)
}
