use crate::{repair::tokens, speech::expand_symbols, validation::simple_words};
use serde::{Deserialize, Serialize};

pub fn transfer_action(text: &str) -> Option<String> {
    let words = simple_words(text.trim())?;
    let command = words.first()?;
    (!tokens(text.trim()).first()?.quoted
        && ["upload", "download"].contains(&command.value.as_str()))
    .then(|| command.value.clone())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DownloadPipeline {
    pub command: String,
    pub tail: String,
}

pub fn download_pipeline(input: &str) -> Option<DownloadPipeline> {
    let text = expand_symbols(input, true);
    let text = text.trim();
    let chars: Vec<_> = text.char_indices().collect();
    let (mut quote, mut depth, mut pipe, mut i) = (None, 0i32, None, 0);
    while i < chars.len() {
        let (offset, ch) = chars[i];
        if ch == '\\' && quote != Some('\'') {
            i += 2;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
        } else if ['\'', '"', '`'].contains(&ch) {
            quote = Some(ch);
        } else if "({".contains(ch) {
            depth += 1;
        } else if ")}".contains(ch) {
            depth -= 1;
        } else if ch == '|'
            && depth == 0
            && (i == 0 || chars[i - 1].1 != '|')
            && chars
                .get(i + 1)
                .is_none_or(|(_, ch)| !['|', '&'].contains(ch))
        {
            pipe = Some(offset);
        }
        i += 1;
    }
    let pipe = pipe.filter(|offset| *offset >= 1)?;
    if quote.is_some() || depth != 0 {
        return None;
    }
    let tail = text[pipe + 1..].trim();
    let words = simple_words(tail)?;
    let first = words.first()?;
    let parsed = tokens(tail);
    if parsed.first()?.quoted || first.value.to_lowercase() != "download" {
        return None;
    }
    let rest = &words[1..];
    if rest.first().is_some_and(|word| word.value == "--file")
        || rest.len() > 1
        || rest
            .iter()
            .enumerate()
            .any(|(i, word)| !parsed[i + 1].quoted && word.value.starts_with('-'))
    {
        return None;
    }
    Some(DownloadPipeline {
        command: text[..pipe].trim().into(),
        tail: format!("download{}", &tail[first.value.len()..]),
    })
}
