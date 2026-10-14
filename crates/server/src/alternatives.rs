use serde::{Deserialize, Serialize};
use serde_json::Value;
use termai_engine::{
    shell_structure::{Separator, command_list},
    types::Candidate,
    validation::simple_words,
};

#[derive(Clone, Default, Deserialize, Serialize)]
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
impl Intent {
    pub fn detect(text: &str, phrases: &Value) -> Self {
        let phrases: Vec<String> = phrases
            .as_array()
            .filter(|items| items.len() <= 12)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|phrase| {
                        !phrase.is_empty()
                            && phrase.len() <= 50
                            && !phrase.chars().any(char::is_control)
                    })
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| vec!["look at".into()]);
        let expanded = termai_engine::speech::expand_symbols(text, true);
        let expanded = expanded.trim_end_matches(['.', '!', '?']);
        if let Some(list) = command_list(expanded)
            && list.separators.last() == Some(&Separator::Pipe)
            && let Some(last) = list.commands.last()
            && phrases
                .iter()
                .any(|phrase| phrase.eq_ignore_ascii_case(last.trim()))
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
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&phrase))
                && text
                    .get(phrase.len()..)
                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))
            {
                return Self::ReadingFile {
                    phrase: text[..phrase.len()].into(),
                    operand: text[phrase.len()..]
                        .trim()
                        .trim_end_matches(['.', '!', '?'])
                        .into(),
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
pub struct Prepared {
    pub original: String,
    pub selected: String,
    pub candidates: Vec<Candidate>,
}
pub async fn prepare<'a>(
    text: &str,
    intent: &Intent,
    mut suggest: impl FnMut(String) -> futures::future::BoxFuture<'a, Result<Value, String>>,
) -> Result<Prepared, String> {
    let query = intent.query(text);
    let phrase = match intent {
        Intent::Shell => "",
        Intent::ReadingFile { phrase, .. } | Intent::ReadingPipeline { phrase, .. } => phrase,
    };
    if text.encode_utf16().count() > 2000
        || query.encode_utf16().count() > 2000
        || text.chars().chain(query.chars()).any(char::is_control)
        || phrase.len() > 50
        || phrase.chars().any(char::is_control)
    {
        return Err("Expected command text under 2,000 characters.".into());
    }
    let result = suggest(query).await?;
    let mut candidates: Vec<Candidate> = serde::Deserialize::deserialize(&result["candidates"])
        .map_err(|error| error.to_string())?;
    candidates.retain(|candidate| !candidate.is_literal());
    let mut fallback = false;
    if let Intent::ReadingFile { operand, .. } = intent {
        candidates.retain(|candidate| {
            simple_words(&candidate.command)
                .is_some_and(|words| words.len() == 2 && words[0].value == "cat")
        });
        if candidates.is_empty() {
            let result = suggest(operand.clone()).await?;
            candidates = serde::Deserialize::deserialize(&result["candidates"])
                .map_err(|error| error.to_string())?;
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
                format!(
                    "{phrase} {}",
                    termai_engine::repair::shell_quote(&words[1].value)
                )
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
    Ok(Prepared {
        original: text.into(),
        selected,
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn reading_intent_keeps_the_phrase_and_runs_fallback_on_the_backend() {
        let intent = Intent::detect("look at get diff", &Value::Null);
        let mut queries = vec![];
        let result = prepare("look at get diff", &intent, |query| {
            queries.push(query.clone());
            Box::pin(async move {
                Ok(json!({"candidates":if query.starts_with("cat ") { vec![Candidate::literal(&query)] } else { vec![Candidate { command: "git diff".into(), score: 100.0, changes: vec![], literal: None, evidence: Default::default() }] }}))
            })
        }).await.unwrap();
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
    #[tokio::test]
    async fn malformed_intent_cannot_put_control_characters_into_an_applied_line() {
        let intent = Intent::ReadingFile {
            phrase: "look at\r".into(),
            operand: "notes".into(),
        };
        assert!(
            prepare("look at notes", &intent, |_| Box::pin(async {
                panic!("Invalid intent must not request facts")
            }))
            .await
            .is_err()
        );
    }
}
