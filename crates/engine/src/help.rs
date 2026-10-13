use crate::{
    types::{Flag, ValueKind, ValueSchema},
    util::{regex, replace, test},
};
fn clean(text: &str) -> String {
    replace("\x1b\\[[0-9;]*m", text, "")
}
fn add(found: &mut Vec<String>, value: &str) {
    if !found.iter().any(|item| item == value) {
        found.push(value.into());
    }
}
pub fn commands_from_help(text: &str, scope: Option<&str>) -> Vec<String> {
    let (mut found, mut section, mut positional) = (Vec::new(), false, false);
    for line in clean(text).split('\n') {
        let usage = replace("(?i)^\\s*(?:usage|or):\\s*", line, "");
        let usage = usage.trim();
        if let Some(scope) = scope
            && test("(?i)^\\s*(?:usage|or):", line)
            && let Some(rest) = usage.strip_prefix(&format!("{scope} "))
            && let Some(child) = regex("^([a-z][a-z0-9_-]*)(?:\\s|$)").captures(rest)
        {
            add(&mut found, &child[1]);
        }
        if test(
            r"(?i)^\s*(?:[\w /-]+\s+)?(?:subcommands|commands)(?:\s*\([^)]*\))?\s*:?\s*$",
            line,
        ) {
            section = true;
            positional = false;
            continue;
        }
        if test("(?i)^\\s*positional arguments\\s*:", line) {
            positional = true;
            section = false;
            continue;
        }
        if positional {
            if let Some(choices) = regex(r"(?i)^\s+\{([a-z][a-z0-9_, -]+)\}").captures(line) {
                for name in choices[1].split(',').map(str::trim) {
                    if test("(?i)^[a-z][a-z0-9_-]*$", name) {
                        add(&mut found, name);
                    }
                }
            }
            if test("^\\S", line) {
                positional = false;
            }
        }
        if section && test("^\\S", line) {
            section = false;
        }
        if section
            && let Some(name) =
                regex(r"(?i)^\s{1,8}([a-z][a-z0-9_-]*)(?::\s+\S|\s{2,}\S|\s*$)").captures(line)
        {
            add(&mut found, &name[1]);
        }
    }
    found
}
pub fn has_command_slot(text: &str) -> bool {
    let clean = clean(text);
    let lines: Vec<_> = clean.split('\n').collect();
    lines.iter().enumerate().any(|(index, line)| {
        test("(?i)^\\s*usage:", line)
            && test(
                r"(?i)[\[<]\s*(?:sub-?)?command(?:s)?\b",
                &lines[index..(index + 3).min(lines.len())].join(" "),
            )
    })
}
pub fn commands_from_manual(text: &str) -> Vec<String> {
    let cleaned = clean(&replace(".\x08", text, ""));
    let lines: Vec<_> = cleaned.split('\n').collect();
    let (mut found, mut in_commands) = (Vec::new(), false);
    for (index, line) in lines.iter().enumerate() {
        if test(
            "(?i)^(?:COMMANDS|SUBCOMMANDS|COMMAND REFERENCE|AVAILABLE COMMANDS)\\s*$",
            line,
        ) {
            in_commands = true;
            continue;
        }
        if test(
            "(?i)^(?:KEY BINDINGS|OPTIONS|SEE ALSO|EXAMPLES|FILES|AUTHORS?|BUGS|COPYRIGHT)\\s*$",
            line,
        ) {
            in_commands = false;
            continue;
        }
        if !in_commands {
            continue;
        }
        let Some(command) = regex(r"^ {4,8}([a-z][a-z0-9-]+)\s+\[(?:[^\n]*)$").captures(line)
        else {
            continue;
        };
        if test("^(?:command|subcommand|commands|subcommands)$", &command[1]) {
            continue;
        }
        add(&mut found, &command[1]);
        for continuation in lines.iter().skip(index + 1).take(3) {
            if !test("^ {9,24}\\S", continuation) {
                break;
            }
            if let Some(aliases) =
                regex(r"(?i)\(alias(?:es)?:\s*([a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)\)")
                    .captures(continuation)
            {
                for alias in aliases[1].split(',').map(str::trim) {
                    add(&mut found, alias);
                }
            }
        }
    }
    found
}
pub fn required_from_help(text: &str, command: &str) -> Option<usize> {
    let line = text
        .split('\n')
        .find(|line| test("(?i)^usage:", line.trim()))?;
    let usage = replace("(?i)^\\s*usage:\\s*", line, "");
    let rest = usage.strip_prefix(&format!("{command} "))?;
    let (mut depth, mut required) = (0_i32, String::new());
    for ch in rest.chars() {
        if ch == '[' {
            depth += 1;
            continue;
        }
        if ch == ']' {
            depth -= 1;
            continue;
        }
        if depth == 0 {
            required.push(ch);
        }
    }
    let required = required.replace("...", "");
    let operands: Vec<_> = required.split_whitespace().collect();
    if depth != 0
        || operands.is_empty()
        || operands.iter().any(|word| {
            !test(
                "^(?:[A-Z][A-Z_0-9-]*|database|key|file|directory|pattern)$",
                word.trim_start_matches('<').trim_end_matches('>'),
            )
        })
    {
        None
    } else {
        Some(operands.len())
    }
}
pub fn flags_from_help(help: &str) -> Vec<Flag> {
    let mut flags: Vec<Flag> = Vec::new();
    for line in clean(help).split('\n') {
        if !test("^\\s*-", line) {
            continue;
        }
        let declaration = regex("\\s{2,}")
            .split(line.trim_start())
            .next()
            .unwrap_or("");
        let declaration = replace(r"--\[no-\]([a-zA-Z][\w-]*)", declaration, "--$1, --no-$1");
        let mut entries = Vec::new();
        for entry in regex(r"(?:^|[\s,|])(--?[a-zA-Z][\w-]*)(?:(?:[ =]|\[=)([A-Z][A-Z_0-9-]*|strings?|ints?|floats?|duration|filename|file|path|directory|number|value|\[-\][A-Z][A-Z_0-9-]*|<[^>]+>|\{[^}]+\}))?").captures_iter(&declaration) {
            let mut takes=entry.get(2).is_some();
            if let Some(value)=entry.get(2)&& declaration[value.end()..].chars().next().is_some_and(|ch| !ch.is_whitespace() && ch!=',' && ch!=']') {takes=false;}
            let optional=takes && entry[0].contains("[=");entries.push((entry[1].to_owned(),takes && !optional,optional,entry.get(2).map(|value| value.as_str().to_owned())));
        }
        let takes_value = entries.iter().any(|entry| entry.1);
        let placeholder = entries
            .iter()
            .find_map(|entry| entry.3.as_deref())
            .unwrap_or("");
        let normalized = placeholder.trim_matches(['<', '>']).to_lowercase();
        let kind = if normalized.contains("dir") {
            ValueKind::Directory
        } else if ["path", "file", "filename"].contains(&normalized.as_str()) {
            ValueKind::Path
        } else if normalized.starts_with('{') {
            ValueKind::Choice
        } else {
            ValueKind::Text
        };
        let choices = (kind == ValueKind::Choice).then(|| {
            placeholder
                .trim_matches(['{', '}'])
                .split(',')
                .map(|value| value.trim().to_owned())
                .take(256)
                .collect()
        });
        for (name, _, optional, _) in entries {
            let flag = Flag {
                name: name.clone(),
                takes_value,
                optional_value: optional.then_some(true),
                value: (kind != ValueKind::Text).then(|| ValueSchema {
                    minimum: usize::from(!optional),
                    maximum: Some(usize::from(!optional)),
                    kind: if name.contains("output") && kind == ValueKind::Path {
                        ValueKind::OutputPath
                    } else {
                        kind
                    },
                    choices: choices.clone(),
                }),
            };
            if let Some(previous) = flags.iter_mut().find(|flag| flag.name == name) {
                *previous = flag;
            } else {
                flags.push(flag);
            }
        }
    }
    flags
}
