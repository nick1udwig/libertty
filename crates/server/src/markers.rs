use crate::protocol::controls as control;
use base64::{
    Engine,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD},
};
use libertty_engine::utf16_len;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Prompt {
        cwd: String,
        code: f64,
        history: String,
    },
    Busy,
    InputLine {
        text: String,
        cursor: usize,
    },
    Ssh {
        command: String,
    },
    Herdr {
        command: String,
    },
    ReadingFile {
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    ReadingCapture {
        file: String,
        name: String,
        exit_code: u8,
    },
    TransferUpload {
        path: String,
    },
    TransferDownload {
        path: String,
    },
    TransferCapture {
        file: String,
        name: String,
    },
}
/// Node's base64 decoder accepts wrapping, URL-safe letters and missing padding.
fn decode(value: &str) -> String {
    let mut text: String = value
        .split('=')
        .next()
        .unwrap_or("")
        .chars()
        .filter_map(|ch| match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(ch),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if text.len() % 4 == 1 {
        text.pop();
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    String::from_utf8_lossy(&engine.decode(text).unwrap_or_default()).into_owned()
}
pub struct Markers {
    pending: String,
    prefix: String,
}
impl Markers {
    pub fn new(nonce: &str) -> Self {
        Self {
            pending: String::new(),
            prefix: format!("\x1b]777;libertty;{nonce};"),
        }
    }
    pub fn feed(&mut self, data: &str) -> (String, Vec<Event>) {
        self.pending.push_str(data);
        let mut output = String::new();
        let mut events = Vec::new();
        while !self.pending.is_empty() {
            let Some(index) = self.pending.find(&self.prefix) else {
                let tail = (1..self.prefix.len())
                    .filter(|n| {
                        *n <= self.pending.len()
                            && self.prefix.is_char_boundary(*n)
                            && self.pending.ends_with(&self.prefix[..*n])
                    })
                    .max()
                    .unwrap_or(0);
                output.push_str(&self.pending[..self.pending.len() - tail]);
                self.pending = self.pending[self.pending.len() - tail..].into();
                break;
            };
            output.push_str(&self.pending[..index]);
            self.pending = self.pending[index..].into();
            let Some(end) = self.pending.find('\x07') else {
                if utf16_len(&self.pending) > 32768 {
                    output.push_str(&self.pending);
                    self.pending.clear();
                }
                break;
            };
            let record: String = self.pending[self.prefix.len()..end].into();
            self.pending = self.pending[end + 1..].into();
            if let Some(event) = parse(&record.split(';').collect::<Vec<_>>()) {
                events.push(event);
            }
        }
        (output, events)
    }
}
fn capture_name(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|rest| rest.len() == 8 && rest.bytes().all(|ch| ch.is_ascii_alphanumeric()))
}
fn parse(record: &[&str]) -> Option<Event> {
    let kind = *record.first()?;
    if ["transfer-upload", "transfer-download"].contains(&kind) && record.len() == 2 {
        let path = decode(record[1]);
        if path.starts_with('/') && utf16_len(&path) <= 4096 && !path.contains('\0') {
            return Some(if kind == "transfer-upload" {
                Event::TransferUpload { path }
            } else {
                Event::TransferDownload { path }
            });
        }
    } else if kind == "transfer-capture"
        && record.len() == 3
        && capture_name(record[1], "download.")
    {
        let name = decode(record[2]);
        if !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains(['/', '\\'])
            && !control(&name)
            && name.len() <= 255
        {
            return Some(Event::TransferCapture {
                file: record[1].into(),
                name,
            });
        }
    } else if kind == "reading-file" && record.len() == 2 {
        let path = decode(record[1]);
        if path.starts_with('/') && utf16_len(&path) <= 4096 && !control(&path) {
            return Some(Event::ReadingFile { path });
        }
    } else if kind == "reading-capture" && record.len() == 4 && capture_name(record[1], "read.") {
        let code = record[3];
        if (code == "0"
            || (!code.starts_with('0')
                && code.len() <= 3
                && code.bytes().all(|ch| ch.is_ascii_digit())))
            && let Ok(exit_code) = code.parse::<u8>()
        {
            let name = decode(record[2]);
            if utf16_len(&name) <= 4000 {
                return Some(Event::ReadingCapture {
                    file: record[1].into(),
                    name,
                    exit_code,
                });
            }
        }
    } else if ["ssh", "herdr"].contains(&kind) && record.len() == 2 {
        let command = decode(record[1]);
        if utf16_len(&command) <= crate::protocol::MAX_LINE && !control(&command) {
            return Some(if kind == "herdr" {
                Event::Herdr { command }
            } else {
                Event::Ssh { command }
            });
        }
    } else if kind == "input-line" && record.len() == 3 {
        let text = decode(record[2]);
        let prefix = decode(record[1]);
        if utf16_len(&text) <= crate::protocol::MAX_TEXT
            && text.starts_with(&prefix)
            && !control(&text)
        {
            return Some(Event::InputLine {
                text,
                cursor: utf16_len(&prefix),
            });
        }
    } else if kind == "busy" {
        return Some(Event::Busy);
    } else if kind == "prompt" && [3, 4].contains(&record.len()) {
        let payload = decode(record[2]);
        let (cwd, history) = if record.len() == 4 {
            (payload, decode(record[3]))
        } else {
            let (cwd, history) = payload.split_once('\0')?;
            (cwd.into(), history.into())
        };
        let code = record[1].trim().parse::<f64>().unwrap_or(0.0);
        return Some(Event::Prompt {
            cwd,
            history,
            code: if code.is_nan() { 0.0 } else { code },
        });
    }
    None
}
pub fn marker(nonce: &str, kind: &str, payload: &str) -> String {
    format!(
        "\x1b]777;libertty;{nonce};{kind};{}\x07",
        STANDARD.encode(payload)
    )
}
