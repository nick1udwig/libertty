//! Plain command arguments retain their source spans and share option interpretation.
use crate::{
    shell_structure::word_spans,
    types::{Flag, Word},
    validation::simple_words,
};
use std::ops::Range;

pub(crate) struct ParsedCommand {
    pub words: Vec<Word>,
    pub spans: Vec<Range<usize>>,
}
impl ParsedCommand {
    pub fn parse(input: &str) -> Option<Self> {
        let words = simple_words(input)?;
        let spans = word_spans(input)?;
        (words.len() == spans.len()).then_some(Self { words, spans })
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

#[cfg(test)]
mod tests {
    use super::*;
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
