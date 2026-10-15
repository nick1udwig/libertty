use crate::{
    command_policy::{child_scope, flags_for, input_file_command, option_arity, script_operand},
    host::Host,
    path_repair::{ExpectedType, PathInput, path_input, resolve_path},
    shell_structure::word_spans,
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
    let Some(spans) = word_spans(&expanded) else {
        return Ok(None);
    };
    let Some(words) = crate::validation::simple_words(&expanded) else {
        return Ok(None);
    };
    if words.len() != spans.len() {
        return Ok(None);
    }
    let flags = flags_for("cp", metadata);
    let mut index = 1;
    let mut options = true;
    let mut operands = Vec::new();
    while index < words.len() {
        let option = &words[index].value;
        if !options || !option.starts_with('-') {
            operands.push(index);
            index += 1;
            continue;
        }
        if option == "--" {
            options = false;
            index += 1;
            continue;
        }
        // These forms do not use the final operand as a destination directory.
        if option.starts_with("--target-directory")
            || option == "--no-target-directory"
            || !option.starts_with("--") && option.contains(['t', 'T'])
        {
            return Ok(None);
        }
        let Some(takes_value) = option_arity(option, &flags) else {
            return Ok(None);
        };
        index += if takes_value { 2 } else { 1 };
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
    let Some(spans) = word_spans(expanded).filter(|spans| spans.len() >= 2) else {
        return Ok(None);
    };
    let command = expanded[spans[0].clone()].to_lowercase();
    if !input_file_command(&command) || !catalog.commands.contains(&command) {
        return Ok(None);
    }
    let flags = flags_for(&command, metadata);
    let mut index = 1;
    while index < spans.len() {
        let option = &expanded[spans[index].clone()];
        if option == "--" {
            index += 1;
            break;
        }
        if !option.starts_with('-') {
            break;
        }
        let Some(takes) = option_arity(option, &flags) else {
            return Ok(None);
        };
        index += if takes { 2 } else { 1 };
    }
    let Some(span) = spans.get(index) else {
        return Ok(None);
    };
    let mut operand = expanded[span.start..].to_owned();
    let quoted = test!(r###"^("[^"]*"|'[^']*')$"###, &operand);
    if command != "download"
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
    if parts.is_empty() || parts.len() > 16 || utf16_len(&operand) > 2000 {
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
    let expected = if ["ls", "du", "file", "stat"].contains(&command.as_str()) {
        ExpectedType::Any
    } else {
        ExpectedType::File
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
        let Some(words) = crate::validation::simple_words(&candidate.command) else {
            continue;
        };
        let Some(spans) = word_spans(&candidate.command) else {
            continue;
        };
        if words.len() != spans.len() || words.is_empty() {
            continue;
        }
        let script = script_operand(&words.iter().map(|w| &w.value).collect::<Vec<_>>());
        let mut scope = words[0].value.clone();
        let mut flags = flags_for(&scope, metadata);
        let mut index = 1;
        while index + 1 < words.len() {
            if script.is_some_and(|script| index > script)
                && let Some(script_flags) = script_flags
            {
                flags = script_flags.to_vec();
            }
            let word = &words[index];
            if word.value == "--" {
                break;
            }
            if let Some(flag) = flags.iter().find(|f| f.name == word.value) {
                if let Some(schema) = &flag.value
                    && flag.value_bounds() == (1, Some(1))
                    && matches!(
                        schema.kind,
                        ValueKind::Path | ValueKind::Directory | ValueKind::InputFile
                    )
                    && words[index + 1].value.contains('/')
                {
                    let end = ((index + 2)..words.len())
                        .find(|i| words[*i].value.starts_with('-'))
                        .unwrap_or(words.len());
                    let start = spans[index + 1].start;
                    let finish = spans[end - 1].end;
                    let raw = &candidate.command[start..finish];
                    let quoted = raw.starts_with(['\'', '"']);
                    let operand = if end == index + 2 {
                        words[index + 1].value.clone()
                    } else {
                        expand_symbols(raw, true)
                    };
                    if operand.contains(['$', '`', '\\', '*', '?', '[', ']']) {
                        break;
                    }
                    let from_home = words[index + 1].home && operand.starts_with('~');
                    let target = if from_home { &operand[1..] } else { &operand };
                    let request = PathInput {
                        command: candidate.command[..spans[index].end].into(),
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
                        repaired.command.push_str(&candidate.command[finish..]);
                        repaired.changes.extend(candidate.changes.clone());
                        result.push(repaired);
                    }
                    break;
                }
                index += if option_arity(&word.value, &flags) == Some(true) {
                    2
                } else {
                    1
                };
            } else {
                if let Some(child) = child_scope(&scope, &word.value, metadata) {
                    scope = child;
                    flags = flags_for(&scope, metadata);
                }
                index += 1;
            }
        }
    }
    Ok(result)
}
