use crate::protocol::ServerMessage;
use std::sync::Arc;
use termai_engine::utf16_len;

#[derive(Default)]
pub(super) struct History {
    previous: Option<Arc<str>>,
    version: u64,
}
struct Edit {
    drop: usize,
    prefix: usize,
    suffix: usize,
}
fn edit(previous: &str, text: &str, drop: usize) -> Edit {
    let old = &previous[drop..];
    let mut prefix = old
        .bytes()
        .zip(text.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !text.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = old[prefix..]
        .bytes()
        .rev()
        .zip(text[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !text.is_char_boundary(text.len() - suffix) {
        suffix -= 1;
    }
    Edit {
        drop,
        prefix,
        suffix,
    }
}
impl History {
    pub fn reset(&mut self) {
        self.previous = None;
    }
    pub fn next(&mut self, text: Arc<str>) -> Option<ServerMessage> {
        if self.previous.as_ref() == Some(&text) {
            return None;
        }
        let base = self.version;
        self.version += 1;
        let message = if let Some(previous) = &self.previous {
            let mut best = edit(previous, &text, 0);
            // Recent history can roll forward by whole lines as its window fills.
            if let Some(first) = text
                .split_inclusive('\n')
                .next()
                .filter(|first| !first.is_empty())
            {
                for (drop, _) in previous
                    .match_indices(first)
                    .filter(|(drop, _)| *drop > 0 && previous.as_bytes()[drop - 1] == b'\n')
                    .take(8)
                {
                    let candidate = edit(previous, &text, drop);
                    if candidate.prefix + candidate.suffix > best.prefix + best.suffix {
                        best = candidate;
                    }
                }
            }
            if best.prefix + best.suffix > 128 {
                Some(ServerMessage::ScreenDelta {
                    base,
                    version: self.version,
                    drop: utf16_len(&previous[..best.drop]),
                    from: utf16_len(&text[..best.prefix]),
                    tail: utf16_len(&text[text.len() - best.suffix..]),
                    text: Arc::from(&text[best.prefix..text.len() - best.suffix]),
                })
            } else {
                None
            }
        } else {
            None
        };
        self.previous = Some(text.clone());
        Some(message.unwrap_or(ServerMessage::Screen {
            text,
            version: Some(self.version),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn apply(old: &str, value: &serde_json::Value) -> String {
        if value["type"] == "screen" {
            return value["text"].as_str().unwrap().into();
        }
        let old: Vec<_> = old.encode_utf16().collect();
        let drop = value["drop"].as_u64().unwrap() as usize;
        let from = value["from"].as_u64().unwrap() as usize;
        let tail = value["tail"].as_u64().unwrap() as usize;
        String::from_utf16(&old[drop..drop + from]).unwrap()
            + value["text"].as_str().unwrap()
            + &String::from_utf16(&old[old.len() - tail..]).unwrap()
    }
    #[test]
    fn deltas_preserve_ansi_unicode_truncation_and_rolling_history() {
        let mut history = History::default();
        let mut old = String::new();
        let prefix = "\x1b[32m界😀\x1b[0m\n".repeat(40);
        for text in [
            format!("header\n{prefix}end"),
            format!("header\n{prefix}end appended"),
            format!("header\n{prefix}界😀"),
            format!("{prefix}界😀\nnew line"),
            format!("{prefix}界😃\nnew line"),
            "unrelated".into(),
        ] {
            let message = history.next(text.clone().into()).unwrap().value();
            assert_eq!(apply(&old, &message), text);
            assert!(history.next(text.clone().into()).is_none());
            old = text;
        }
        history.reset();
        let baseline = history.next(old.into()).unwrap().value();
        assert_eq!(baseline["type"], "screen");
        assert_eq!(baseline["version"], 7);
    }
    #[test]
    fn changed_spinners_and_rolling_windows_send_only_small_edits() {
        let mut history = History::default();
        let body = (0..1000)
            .map(|i| format!("line {i:04} hello 界😀\n"))
            .collect::<String>();
        history.next(format!("spinner A\n{body}").into());
        let spinner = history
            .next(format!("spinner B\n{body}").into())
            .unwrap()
            .value();
        assert_eq!(spinner["text"], "B");
        assert!(spinner.to_string().len() < 150);
        let rolled = history
            .next(format!("{}new line\n", body.split_once('\n').unwrap().1).into())
            .unwrap()
            .value();
        assert_eq!(rolled["text"], "new line\n");
        assert!(rolled.to_string().len() < 150);
    }
}
