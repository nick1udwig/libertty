//! A bounded shell structure that preserves opaque expressions instead of evaluating them.
use crate::utf16_len;
use crate::{
    command_policy::{flags_for, option_arity},
    types::CommandMetadata,
};
use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Separator {
    Pipe,
    Sequence,
    And,
    Or,
}
impl Separator {
    pub fn text(self) -> &'static str {
        match self {
            Self::Pipe => " | ",
            Self::Sequence => "; ",
            Self::And => " && ",
            Self::Or => " || ",
        }
    }
}
#[derive(Debug)]
pub struct CommandList<'a> {
    pub commands: Vec<&'a str>,
    pub separators: Vec<Separator>,
}

pub fn command_list(input: &str) -> Option<CommandList<'_>> {
    if utf16_len(input) > 2000 || input.contains(['\n', '\r']) {
        return None;
    }
    let chars: Vec<_> = input.char_indices().collect();
    let (mut quote, mut depth, mut start, mut index) = (None, 0_i32, 0, 0);
    let mut commands = Vec::new();
    let mut separators = Vec::new();
    while index < chars.len() {
        let (offset, ch) = chars[index];
        index += 1;
        if ch == '\\' && quote != Some('\'') {
            index += 1;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        if "\'\"`".contains(ch) {
            quote = Some(ch);
            continue;
        }
        if "({".contains(ch) {
            depth += 1;
            continue;
        }
        if ")}".contains(ch) {
            depth -= 1;
            if depth < 0 {
                return None;
            }
            continue;
        }
        if depth != 0 {
            continue;
        }
        if ch == '#' && (offset == 0 || input[..offset].ends_with(char::is_whitespace)) {
            return None;
        }
        let separator = match ch {
            ';' => Separator::Sequence,
            '|' if chars.get(index).is_some_and(|(_, ch)| *ch == '|') => {
                index += 1;
                Separator::Or
            }
            '|' if chars.get(index).is_some_and(|(_, ch)| *ch == '&') => return None,
            '|' => Separator::Pipe,
            '&' if chars.get(index).is_some_and(|(_, ch)| *ch == '&') => {
                index += 1;
                Separator::And
            }
            '&' => return None,
            _ => continue,
        };
        commands.push(input[start..offset].trim());
        separators.push(separator);
        start = chars.get(index).map_or(input.len(), |(offset, _)| *offset);
    }
    if quote.is_some() || depth != 0 || separators.is_empty() {
        return None;
    }
    commands.push(input[start..].trim());
    if commands.len() > 6 || commands.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(CommandList {
        commands,
        separators,
    })
}

/// Token spans retain quoting and escaped whitespace for exact reconstruction.
pub fn word_spans(input: &str) -> Option<Vec<Range<usize>>> {
    let mut spans = Vec::new();
    let (mut start, mut quote, mut depth) = (None, None, 0_i32);
    let mut chars = input.char_indices();
    while let Some((offset, ch)) = chars.next() {
        if start.is_none() && ch.is_whitespace() {
            continue;
        }
        start.get_or_insert(offset);
        if ch == '\\' && quote != Some('\'') {
            chars.next()?;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        if "\'\"`".contains(ch) {
            quote = Some(ch);
            continue;
        }
        if ch == '(' {
            depth += 1;
        }
        if ch == ')' {
            depth -= 1;
            if depth < 0 {
                return None;
            }
        }
        if ch.is_whitespace() && depth == 0 {
            spans.push(start.take().unwrap()..offset);
        }
    }
    if quote.is_some() || depth != 0 {
        return None;
    }
    if let Some(start) = start {
        spans.push(start..input.len());
    }
    (spans.len() <= 64).then_some(spans)
}

pub struct ProtectedInput {
    pub text: String,
    pub expressions: Vec<(String, String)>,
}
impl ProtectedInput {
    pub fn restore(&self, input: &str) -> String {
        let mut result = input.to_owned();
        for (key, original) in &self.expressions {
            result = result
                .replace(&format!("'{key}'"), original)
                .replace(key, original);
        }
        result
    }
}
pub fn protect(input: &str) -> Option<ProtectedInput> {
    let spans = word_spans(input)?;
    let mut result = ProtectedInput {
        text: String::new(),
        expressions: Vec::new(),
    };
    let mut at = 0;
    let mut prefix = "__termai_expression_".to_owned();
    while input.contains(&prefix) {
        prefix.push('_');
    }
    for (index, span) in spans.into_iter().enumerate() {
        let raw = &input[span.clone()];
        result.text.push_str(&input[at..span.start]);
        let literal_quote = raw.starts_with('\'') && raw.ends_with('\'');
        let quoted = raw.starts_with('"') && raw.ends_with('"');
        if index > 0
            && !literal_quote
            && (!quoted || raw.contains(['$', '`', '\\']))
            && raw.contains([
                '$', '`', '\\', '*', '?', '[', ']', '(', ')', '{', '}', '<', '>',
            ])
        {
            let key = format!("{prefix}{}__", result.expressions.len());
            result.text.push_str(&format!("'{key}'"));
            result.expressions.push((key, raw.to_owned()));
        } else {
            result.text.push_str(raw);
        }
        at = span.end;
    }
    result.text.push_str(&input[at..]);
    (!result.expressions.is_empty()).then_some(result)
}

/// Return the nested command offset for explicitly supplied wrappers and assignments.
pub fn nested_command(input: &str, metadata: &CommandMetadata) -> Option<usize> {
    let spans = word_spans(input)?;
    let first = &input[spans.first()?.clone()];
    let assignment = |word: &str| {
        word.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty()
                && name.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
        })
    };
    let wrapper = first.to_lowercase();
    if !assignment(first)
        && !["sudo", "env", "command", "nohup", "nice", "timeout"].contains(&wrapper.as_str())
    {
        return None;
    }
    let flags = flags_for(&wrapper, metadata);
    let mut index = if assignment(first) { 0 } else { 1 };
    let mut duration = wrapper == "timeout";
    while index < spans.len() {
        let word = &input[spans[index].clone()];
        if word == "--" {
            index += 1;
            break;
        }
        if word.starts_with('-') {
            index += if option_arity(word, &flags)? { 2 } else { 1 };
        } else if (wrapper == "env" || assignment(first)) && assignment(word) {
            index += 1;
        } else if duration {
            duration = false;
            index += 1;
        } else {
            break;
        }
    }
    spans.get(index).map(|span| span.start)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structure_preserves_quotes_expressions_and_operator_kinds() {
        let list = command_list("echo 'a;b'|cat; echo \"$USER\" && ls || printf done").unwrap();
        assert_eq!(
            list.commands,
            ["echo 'a;b'", "cat", "echo \"$USER\"", "ls", "printf done"]
        );
        assert_eq!(
            list.separators,
            [
                Separator::Pipe,
                Separator::Sequence,
                Separator::And,
                Separator::Or
            ]
        );
        assert!(command_list("cat | | ls").is_none());
        assert!(command_list("cat |& ls").is_none());
        let original = "Get commit -m \"$USER\"";
        let protected = protect(original).unwrap();
        assert_eq!(protected.restore(&protected.text), original);
        assert!(word_spans("cat 'unfinished").is_none());
        assert_eq!(
            nested_command("env FOO=bar Get status", &CommandMetadata::default()),
            Some(12)
        );
    }
}
