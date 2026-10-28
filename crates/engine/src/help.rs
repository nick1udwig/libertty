use crate::types::{Flag, Help, ValueKind, ValueSchema};
use crate::{regex, replace, test};

pub fn parse_help(command: &str, route: &[String], text: &str) -> Help {
    let scope = std::iter::once(command)
        .chain(route.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    Help {
        flags: flags_from_help(text),
        subcommands: commands_from_help(text, Some(&scope)),
        required: required_from_help(text, &scope),
        ..Help::default()
    }
}
pub fn needs_manual(command: &str, route: &[String], text: &str, help: &Help) -> bool {
    command != "git" && route.is_empty() && help.subcommands.is_empty() && has_command_slot(text)
}
pub fn apply_manual(help: &mut Help, text: &str) {
    help.subcommands = commands_from_manual(text);
    if !help.subcommands.is_empty() {
        help.probe_subcommands = Some(vec![]);
    }
}

fn clean(text: &str) -> String {
    replace!(r###"\[[0-9;]*m"###, text, "")
}
fn add(found: &mut Vec<String>, value: &str) {
    if !found.iter().any(|item| item == value) {
        found.push(value.into());
    }
}
pub fn commands_from_help(text: &str, scope: Option<&str>) -> Vec<String> {
    let (mut found, mut section, mut positional) = (Vec::new(), false, false);
    for line in clean(text).split('\n') {
        let usage = replace!(
            r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*(?:usage|or):[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*"###,
            line,
            ""
        );
        let usage = usage.trim();
        if let Some(scope) = scope
            && test!(r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*(?:usage|or):"###, line)
            && let Some(rest) = usage.strip_prefix(&format!("{scope} "))
            && let Some(child) = regex!(r###"^([a-z][a-z0-9_-]*)(?:[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]|$)"###).captures(rest)
        {
            add(&mut found, &child[1]);
        }
        if test!(
            r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*(?:[[a-zA-Z0-9_] /-]+[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+)?(?:subcommands|commands)(?:[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*\([^)]*\))?[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*:?[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*$"###,
            line,
        ) {
            section = true;
            positional = false;
            continue;
        }
        if test!(
            r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*positional arguments[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*:"###,
            line
        ) {
            positional = true;
            section = false;
            continue;
        }
        if positional {
            if let Some(choices) = regex!(r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+\{([a-z][a-z0-9_, -]+)\}"###).captures(line) {
                for name in choices[1].split(',').map(str::trim) {
                    if test!(r###"(?i)^[a-z][a-z0-9_-]*$"###, name) {
                        add(&mut found, name);
                    }
                }
            }
            if test!(r###"^\S"###, line) {
                positional = false;
            }
        }
        if section && test!(r###"^\S"###, line) {
            section = false;
        }
        if section
            && let Some(name) =
                regex!(r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]{1,8}([a-z][a-z0-9_-]*)(?::[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+\S|[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]{2,}\S|[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*$)"###).captures(line)
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
        test!(r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*usage:"###, line)
            && test!(r###"(?i)[\[<][\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*(?:sub-?)?command(?:s)?(?-u:\b)"###,
                &lines[index..(index + 3).min(lines.len())].join(" "),
            )
    })
}
pub fn commands_from_manual(text: &str) -> Vec<String> {
    let cleaned = clean(&replace!(r###"."###, text, ""));
    let lines: Vec<_> = cleaned.split('\n').collect();
    let (mut found, mut in_commands) = (Vec::new(), false);
    for (index, line) in lines.iter().enumerate() {
        if test!(
            r###"(?i)^(?:COMMANDS|SUBCOMMANDS|COMMAND REFERENCE|AVAILABLE COMMANDS)[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*$"###,
            line,
        ) {
            in_commands = true;
            continue;
        }
        if test!(
            r###"(?i)^(?:KEY BINDINGS|OPTIONS|SEE ALSO|EXAMPLES|FILES|AUTHORS?|BUGS|COPYRIGHT)[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*$"###,
            line,
        ) {
            in_commands = false;
            continue;
        }
        if !in_commands {
            continue;
        }
        let Some(command) = regex!(r###"^ {4,8}([a-z][a-z0-9-]+)[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+\[(?:[^\n]*)$"###).captures(line)
        else {
            continue;
        };
        if test!(
            r###"^(?:command|subcommand|commands|subcommands)$"###,
            &command[1]
        ) {
            continue;
        }
        add(&mut found, &command[1]);
        for continuation in lines.iter().skip(index + 1).take(3) {
            if !test!(r###"^ {9,24}\S"###, continuation) {
                break;
            }
            if let Some(aliases) =
                regex!(r###"(?i)\(alias(?:es)?:[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*([a-z][a-z0-9-]*(?:[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*,[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*[a-z][a-z0-9-]*)*)\)"###)
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
        .find(|line| test!(r###"(?i)^usage:"###, line.trim()))?;
    let usage = replace!(
        r###"(?i)^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*usage:[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*"###,
        line,
        ""
    );
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
            !test!(
                r###"^(?:[A-Z][A-Z_0-9-]*|database|key|file|directory|pattern)$"###,
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
        if !test!(
            r###"^[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*-"###,
            line
        ) {
            continue;
        }
        let declaration = regex!(r###"[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]{2,}"###)
            .split(line.trim_start())
            .next()
            .unwrap_or("");
        let declaration = replace!(
            r###"--\[no-\]([a-zA-Z][[a-zA-Z0-9_]-]*)"###,
            declaration,
            "--$1, --no-$1"
        );
        let mut entries = Vec::new();
        for entry in regex!(r###"(?:^|[[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}],|])(--?[a-zA-Z][[a-zA-Z0-9_]-]*)(?:(?:[ =]|\[=)([A-Z][A-Z_0-9-]*|strings?|ints?|floats?|duration|filename|file|path|directory|number|value|\[-\][A-Z][A-Z_0-9-]*|<[^>]+>|\{[^}]+\}))?"###).captures_iter(&declaration) {
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

#[cfg(test)]
mod policy_tests {
    use super::*;
    #[test]
    fn manual_fallback_never_authorizes_command_execution() {
        let text = "Usage: orbit <command>\n  --verbose  Show details\n";
        let mut help = parse_help("orbit", &[], text);
        assert_eq!(help.flags[0].name, "--verbose");
        assert!(needs_manual("orbit", &[], text, &help));
        assert!(!needs_manual("git", &[], text, &help));
        assert!(!needs_manual("orbit", &["run".into()], text, &help));
        apply_manual(
            &mut help,
            "COMMANDS\n     run [options]\n         Run a task.\nOPTIONS\n",
        );
        assert_eq!(help.subcommands, ["run"]);
        assert_eq!(help.probe_subcommands, Some(vec![]));
        assert!(!needs_manual("orbit", &[], text, &help));
    }
}
