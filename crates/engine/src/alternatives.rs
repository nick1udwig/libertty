//! Alternatives for typed or dictated input, shared by the backend and browser adapters.
use crate::utf16_len;
use crate::{
    shell_structure::{Separator, reading_command_list},
    types::Candidate,
    validation::simple_words,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;

#[derive(Clone, Default, Deserialize, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "RepairIntent"))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Intent {
    #[default]
    Shell,
    ReadingFile {
        phrase: String,
        operand: String,
    },
    ReadingPipeline {
        phrase: String,
        command: String,
    },
}
fn trim_sentence(text: &str) -> &str {
    text.strip_suffix(['.', '!', '?']).unwrap_or(text)
}
pub fn reading_phrases(value: &Value) -> Vec<String> {
    let normalize = || -> Option<Vec<String>> {
        let items = value.as_array().filter(|items| items.len() <= 12)?;
        let mut phrases = Vec::new();
        for item in items {
            let phrase = item
                .as_str()?
                .split(crate::util::js_whitespace)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if phrase.is_empty()
                || utf16_len(&phrase) > 50
                || phrase.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
            {
                return None;
            }
            if !phrases.contains(&phrase) {
                phrases.push(phrase);
            }
        }
        phrases.sort_by_key(|phrase| std::cmp::Reverse(utf16_len(phrase)));
        Some(phrases)
    };
    normalize().unwrap_or_else(|| vec!["look at".into()])
}
impl Intent {
    pub fn detect(text: &str, phrases: &Value) -> Self {
        let phrases = reading_phrases(phrases);
        let expanded = crate::speech::expand_symbols(text, true);
        let expanded = trim_sentence(&expanded);
        if let Some(list) = reading_command_list(expanded)
            && list.separators.last() == Some(&Separator::Pipe)
            && let Some(last) = list.commands.last()
            && phrases
                .iter()
                .any(|phrase| phrase == &last.trim().to_lowercase())
        {
            let end = expanded.rfind('|').unwrap();
            return Self::ReadingPipeline {
                phrase: last.trim().into(),
                command: expanded[..end].trim().into(),
            };
        }
        let text = text.trim();
        for phrase in phrases {
            if text
                .get(..phrase.len())
                .is_some_and(|prefix| prefix.to_lowercase() == phrase)
                && text
                    .get(phrase.len()..)
                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))
            {
                if trim_sentence(text[phrase.len()..].trim()).is_empty() {
                    continue;
                }
                return Self::ReadingFile {
                    phrase: text[..phrase.len()].into(),
                    operand: trim_sentence(text[phrase.len()..].trim()).into(),
                };
            }
        }
        Self::Shell
    }
    fn query(&self, text: &str) -> String {
        match self {
            Self::Shell => text.into(),
            Self::ReadingFile { operand, .. } => format!("cat {operand}"),
            Self::ReadingPipeline { command, .. } => command.clone(),
        }
    }
}
#[derive(Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(optional_fields))]
pub struct Prepared {
    pub original: String,
    pub selected: String,
    pub candidates: Vec<Candidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<std::collections::BTreeMap<String, Intent>>,
}
pub async fn prepare<F: Future<Output = Result<Vec<Candidate>, String>>>(
    text: &str,
    intent: &Intent,
    mut suggest: impl FnMut(String) -> F,
) -> Result<Prepared, String> {
    let query = intent.query(text);
    let phrase = match intent {
        Intent::Shell => "",
        Intent::ReadingFile { phrase, .. } | Intent::ReadingPipeline { phrase, .. } => phrase,
    };
    if utf16_len(text) > crate::MAX_COMMAND
        || utf16_len(&query) > crate::MAX_COMMAND
        || text.chars().chain(query.chars()).any(char::is_control)
        || utf16_len(phrase) > 50
        || phrase.chars().any(char::is_control)
    {
        return Err("Expected command text under 2,000 characters.".into());
    }
    let canonical = match intent {
        Intent::Shell => Intent::Shell,
        Intent::ReadingFile { phrase, .. } | Intent::ReadingPipeline { phrase, .. } => {
            Intent::detect(text, &serde_json::json!([phrase]))
        }
    };
    let intent = &canonical;
    let mut candidates = suggest(intent.query(text)).await?;
    candidates.retain(|candidate| !candidate.is_literal());
    let mut fallback = false;
    if let Intent::ReadingFile { operand, .. } = intent {
        candidates.retain(|candidate| {
            simple_words(&candidate.command)
                .is_some_and(|words| words.len() == 2 && words[0].value == "cat")
        });
        if candidates.is_empty() {
            candidates = suggest(operand.clone()).await?;
            candidates.retain(|candidate| !candidate.is_literal());
            fallback = true;
        }
    }
    for candidate in &mut candidates {
        candidate.command = match intent {
            Intent::Shell => candidate.command.clone(),
            Intent::ReadingPipeline { phrase, .. } => format!("{} | {phrase}", candidate.command),
            Intent::ReadingFile { phrase, .. } if fallback => {
                format!("{phrase} {}", candidate.command)
            }
            Intent::ReadingFile { phrase, .. } => {
                let words = simple_words(&candidate.command).unwrap();
                format!("{phrase} {}", crate::repair::shell_quote(&words[1].value))
            }
        };
    }
    candidates.truncate(3);
    let selected = candidates
        .first()
        .map(|candidate| candidate.command.clone())
        .unwrap_or_else(|| text.into());
    if candidates.iter().all(|candidate| candidate.command != text) {
        candidates.push(Candidate::literal(text));
    }
    let mut actions = std::collections::BTreeMap::new();
    for command in candidates
        .iter()
        .map(|candidate| candidate.command.as_str())
        .chain(std::iter::once(text))
    {
        let action = match intent {
            Intent::Shell => Intent::Shell,
            Intent::ReadingFile { phrase, .. } => Intent::ReadingFile {
                phrase: phrase.clone(),
                operand: command
                    .strip_prefix(phrase)
                    .unwrap_or(command)
                    .trim()
                    .into(),
            },
            Intent::ReadingPipeline { phrase, .. } => {
                if command == text {
                    intent.clone()
                } else {
                    Intent::ReadingPipeline {
                        phrase: phrase.clone(),
                        command: command
                            .strip_suffix(&format!(" | {phrase}"))
                            .unwrap_or(command)
                            .into(),
                    }
                }
            }
        };
        actions.insert(command.into(), action);
    }
    Ok(Prepared {
        original: text.into(),
        selected,
        candidates,
        actions: Some(actions),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        pin::pin,
        task::{Context, Poll, Waker},
    };
    /// These suggestion stubs never wait, so one poll completes the preparation.
    fn ready<T>(future: impl Future<Output = T>) -> T {
        match pin!(future).poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("Suggestion stubs must not wait"),
        }
    }
    #[test]
    fn reading_intent_keeps_the_phrase_and_runs_fallback_on_the_backend() {
        let intent = Intent::detect("look at get diff", &Value::Null);
        let mut queries = vec![];
        let result = ready(prepare("look at get diff", &intent, |query| {
            queries.push(query.clone());
            async move {
                Ok(if query.starts_with("cat ") {
                    vec![Candidate::literal(&query)]
                } else {
                    vec![Candidate {
                        command: "git diff".into(),
                        score: 100.0,
                        changes: vec![],
                        literal: None,
                        evidence: Default::default(),
                    }]
                })
            }
        }))
        .unwrap();
        assert_eq!(queries, ["cat get diff", "get diff"]);
        assert_eq!(result.selected, "look at git diff");
        assert_eq!(result.original, "look at get diff");
        assert!(result.candidates.last().unwrap().is_literal());
        assert!(matches!(
            Intent::detect("echo 'pipe look at'", &Value::Null),
            Intent::Shell
        ));
        assert!(matches!(
            Intent::detect("Get diff pipe look at.", &Value::Null),
            Intent::ReadingPipeline { .. }
        ));
        assert!(matches!(
            Intent::detect("read this file", &json!(["read this"])),
            Intent::ReadingFile { .. }
        ));
    }
    #[test]
    fn malformed_intent_cannot_put_control_characters_into_an_applied_line() {
        let intent = Intent::ReadingFile {
            phrase: "look at\r".into(),
            operand: "notes".into(),
        };
        assert!(
            ready(prepare("look at notes", &intent, |_| async {
                panic!("Invalid intent must not request facts")
            }))
            .is_err()
        );
    }
}
