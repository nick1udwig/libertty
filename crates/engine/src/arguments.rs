//! Plain command arguments retain their source spans and share option interpretation.
use crate::types::{CommandMetadata, Flag, Word};
use std::ops::Range;

pub(crate) struct ParsedCommand {
    pub words: Vec<Word>,
    pub spans: Vec<Range<usize>>,
}
impl ParsedCommand {
    pub fn parse(input: &str) -> Option<Self> {
        let mut words = Vec::new();
        let mut spans = Vec::new();
        let (mut value, mut quote, mut start, mut home) = (String::new(), None, None, false);
        let mut chars = input.char_indices();
        while let Some((offset, ch)) = chars.next() {
            if quote == Some('\'') {
                if ch == '\'' {
                    quote = None;
                } else {
                    value.push(ch);
                }
                continue;
            }
            if ch == '\\' {
                start.get_or_insert(offset);
                let (_, escaped) = chars.next()?;
                if quote == Some('"') && !"$`\"\\\n".contains(escaped) {
                    value.push('\\');
                }
                if escaped != '\n' {
                    value.push(escaped);
                }
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
                start.get_or_insert(offset);
                quote = Some(ch);
                continue;
            }
            if "|&;<>()`$*?[]{}\n\r".contains(ch) {
                return None;
            }
            if crate::util::js_whitespace(ch) {
                if let Some(begin) = start.take() {
                    words.push(Word {
                        value: std::mem::take(&mut value),
                        home,
                    });
                    spans.push(begin..offset);
                }
                home = false;
                continue;
            }
            if start.is_none() {
                if ch == '#' {
                    return None;
                }
                home = ch == '~';
                start = Some(offset);
            }
            value.push(ch);
        }
        if quote.is_some() {
            return None;
        }
        if let Some(begin) = start {
            words.push(Word { value, home });
            spans.push(begin..input.len());
        }
        Some(Self { words, spans })
    }
}
pub(crate) struct OptionBinding<'a> {
    pub descriptor: Option<&'a Flag>,
    pub attached: Option<&'a str>,
    pub takes_value: bool,
}
impl OptionBinding<'_> {
    pub fn following_bounds(&self) -> (usize, Option<usize>) {
        let (minimum, maximum) = self.descriptor.map(Flag::value_bounds).unwrap_or((
            usize::from(self.takes_value),
            Some(usize::from(self.takes_value)),
        ));
        let attached = usize::from(self.attached.is_some());
        (
            minimum.saturating_sub(attached),
            maximum.map(|n| n.saturating_sub(attached)),
        )
    }
}
pub(crate) fn option_binding<'a>(value: &'a str, flags: &'a [Flag]) -> Option<OptionBinding<'a>> {
    let (name, attached) = value
        .split_once('=')
        .map_or((value, None), |(name, value)| (name, Some(value)));
    if let Some(flag) = flags.iter().find(|flag| flag.name == name) {
        return Some(OptionBinding {
            descriptor: Some(flag),
            attached,
            takes_value: attached.is_none() && flag.takes_value,
        });
    }
    if !value.starts_with('-')
        || value.starts_with("--")
        || value.chars().count() < 3
        || attached.is_some()
    {
        return None;
    }
    let chars: Vec<_> = value.chars().skip(1).collect();
    for (index, ch) in chars.iter().enumerate() {
        let flag = flags.iter().find(|flag| flag.name == format!("-{ch}"))?;
        if flag.takes_value {
            return Some(OptionBinding {
                descriptor: None,
                attached: None,
                takes_value: index == chars.len() - 1,
            });
        }
    }
    Some(OptionBinding {
        descriptor: None,
        attached: None,
        takes_value: false,
    })
}

pub(crate) enum Argument<'a> {
    Delimiter,
    Subcommand,
    Operand(usize),
    UnknownOption,
    Option {
        index: usize,
        binding: OptionBinding<'a>,
        following: Range<usize>,
        complete: bool,
    },
}

/// Walk lexical roles once while consumers choose their own acceptance policy.
pub(crate) struct ArgumentCursor<'a> {
    values: Vec<&'a str>,
    metadata: &'a CommandMetadata,
    pub scope: String,
    pub literal: bool,
    pub index: usize,
    pub flags: Option<&'a [Flag]>,
}
impl<'a> ArgumentCursor<'a> {
    pub fn new(values: impl Iterator<Item = &'a str>, metadata: &'a CommandMetadata) -> Self {
        let values: Vec<_> = values.collect();
        Self {
            scope: values.first().copied().unwrap_or_default().into(),
            values,
            metadata,
            literal: false,
            index: 1,
            flags: None,
        }
    }
    pub fn next(&mut self) -> Option<Argument<'a>> {
        let index = self.index;
        let value = *self.values.get(index)?;
        self.index += 1;
        if !self.literal && value == "--" {
            self.literal = true;
            return Some(Argument::Delimiter);
        }
        if !self.literal && value.starts_with('-') && value != "-" {
            let flags = self.flags.unwrap_or_else(|| {
                crate::command_policy::flags_ref(&self.scope, self.metadata, &[])
            });
            let Some(binding) = option_binding(value, flags) else {
                return Some(Argument::UnknownOption);
            };
            let (minimum, maximum) = binding.following_bounds();
            let start = self.index;
            while maximum.is_none_or(|limit| self.index - start < limit) {
                let Some(value) = self.values.get(self.index) else {
                    break;
                };
                if *value == "--" || option_binding(value, flags).is_some() {
                    break;
                }
                self.index += 1;
            }
            return Some(Argument::Option {
                index,
                binding,
                following: start..self.index,
                complete: self.index - start >= minimum,
            });
        }
        if !self.literal
            && let Some(child) =
                crate::command_policy::child_scope(&self.scope, value, self.metadata)
        {
            self.scope = child;
            self.flags = None;
            return Some(Argument::Subcommand);
        }
        Some(Argument::Operand(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lexical_values_and_spans_use_the_same_whitespace_and_quote_rules() {
        for input in [
            "echo\u{feff}hello",
            "echo\u{85}hello",
            r#"echo "a\qb" escaped\ value '' ~/file"#,
        ] {
            let parsed = ParsedCommand::parse(input).unwrap();
            assert_eq!(parsed.words.len(), parsed.spans.len());
            for (word, span) in parsed.words.iter().zip(&parsed.spans) {
                let single = ParsedCommand::parse(&input[span.clone()]).unwrap();
                assert_eq!(single.words.as_slice(), std::slice::from_ref(word));
            }
        }
        let parsed = ParsedCommand::parse("echo\u{feff}hello").unwrap();
        assert_eq!(parsed.words.len(), 2);
        assert_eq!(
            ParsedCommand::parse("echo\u{85}hello").unwrap().words.len(),
            1
        );
        assert_eq!(
            ParsedCommand::parse(r#"echo "a\qb""#).unwrap().words[1].value,
            r"a\qb"
        );
    }

    #[test]
    fn cursor_binds_attached_and_following_values_without_consuming_delimiters() {
        let metadata: CommandMetadata = serde_json::from_value(serde_json::json!({"flags":{"tool":[{"name":"--pair","takesValue":true,"value":{"kind":"text","minimum":2,"maximum":2}}]}})).unwrap();
        let parsed = ParsedCommand::parse("tool --pair=first 'second value' -- --pair").unwrap();
        let mut cursor = ArgumentCursor::new(
            parsed.words.iter().map(|word| word.value.as_str()),
            &metadata,
        );
        let Some(Argument::Option {
            binding,
            following,
            complete,
            ..
        }) = cursor.next()
        else {
            panic!("option");
        };
        assert!(complete);
        assert_eq!(binding.attached, Some("first"));
        assert_eq!(following, 2..3);
        assert!(matches!(cursor.next(), Some(Argument::Delimiter)));
        assert!(matches!(cursor.next(), Some(Argument::Operand(4))));
        let mut short = ArgumentCursor::new(["tool", "--pair=first", "--"].into_iter(), &metadata);
        assert!(matches!(
            short.next(),
            Some(Argument::Option {
                complete: false,
                ..
            })
        ));
        assert!(matches!(short.next(), Some(Argument::Delimiter)));
    }
    #[test]
    fn cursor_changes_flag_scope_at_subcommands() {
        let metadata: CommandMetadata = serde_json::from_value(serde_json::json!({"subcommands":{"tool":["child"]}, "flags":{"tool child":[{"name":"--file","takesValue":true}]}})).unwrap();
        let mut cursor = ArgumentCursor::new(
            ["tool", "child", "--file", "name", "tail"].into_iter(),
            &metadata,
        );
        assert!(matches!(cursor.next(), Some(Argument::Subcommand)));
        assert_eq!(cursor.scope, "tool child");
        assert!(
            matches!(cursor.next(), Some(Argument::Option { following, complete: true, .. }) if following == (3..4))
        );
        assert!(matches!(cursor.next(), Some(Argument::Operand(4))));
    }
    #[test]
    fn spans_and_values_preserve_escaped_and_quoted_arguments() {
        let input = "tool --config='a b' escaped\\ value -- '--literal'";
        let parsed = ParsedCommand::parse(input).unwrap();
        assert_eq!(
            parsed
                .words
                .iter()
                .map(|word| word.value.as_str())
                .collect::<Vec<_>>(),
            ["tool", "--config=a b", "escaped value", "--", "--literal"]
        );
        assert_eq!(&input[parsed.spans[1].clone()], "--config='a b'");
        assert_eq!(&input[parsed.spans[2].clone()], "escaped\\ value");
        assert!(ParsedCommand::parse("tool $(command)").is_none());
    }
    #[test]
    fn attached_values_reduce_the_remaining_schema_arity() {
        let flags: Vec<Flag> = serde_json::from_value(serde_json::json!([
            {"name":"--pair","takesValue":true,"value":{"kind":"text","minimum":2,"maximum":2}}
        ]))
        .unwrap();
        let binding = option_binding("--pair=first", &flags).unwrap();
        assert_eq!(binding.attached, Some("first"));
        assert_eq!(binding.following_bounds(), (1, Some(1)));
        assert_eq!(
            option_binding("--pair", &flags).unwrap().following_bounds(),
            (2, Some(2))
        );
    }
}
