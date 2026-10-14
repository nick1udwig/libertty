//! Validated client messages shared by native terminals and Herdr viewers.
use crate::alternatives::Intent;
use serde::{Deserialize, Deserializer, de::Error};
use serde_json::Value;

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
pub fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER)
}
pub fn unsigned(value: &Value) -> Option<u64> {
    integer(value).filter(|n| *n >= 0.0).map(|n| n as u64)
}
pub fn controls(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
fn bounded<'de, D: Deserializer<'de>, const N: usize, const CLEAN: bool>(
    d: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if value.encode_utf16().count() > N || (CLEAN && controls(&value)) {
        return Err(D::Error::custom(
            "Text exceeds its limit or contains control characters.",
        ));
    }
    Ok(value)
}
fn id<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded::<D, 100, false>(d)
}
fn repair_text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded::<D, 2000, true>(d)
}
fn input_text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded::<D, 65536, false>(d)
}
fn safe<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    unsigned(&Value::deserialize(d)?)
        .ok_or_else(|| D::Error::custom("Expected a safe nonnegative integer."))
}
fn optional_safe<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    safe(d).map(Some)
}
fn recording_id<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if value.len() != 36
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    {
        return Err(D::Error::custom("Expected a recording UUID."));
    }
    Ok(value)
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DictationAction {
    Start,
    Finish,
    Cancel,
}
#[derive(Deserialize)]
pub struct Repair {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(deserialize_with = "repair_text")]
    pub text: String,
    #[serde(deserialize_with = "safe")]
    pub prompt: u64,
    #[serde(deserialize_with = "safe")]
    pub revision: u64,
    #[serde(default)]
    pub intent: Intent,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
    #[serde(deserialize_with = "recording_id")]
    pub id: String,
    pub action: DictationAction,
    #[serde(default, deserialize_with = "optional_safe")]
    pub prompt: Option<u64>,
    #[serde(default, deserialize_with = "optional_safe")]
    pub revision: Option<u64>,
    #[serde(default)]
    pub target: Value,
    #[serde(default)]
    pub reading_phrases: Value,
}
impl Dictation {
    pub fn target(&self) -> Option<&str> {
        dictation_target(&self.target)
    }
}
pub fn dictation_target(value: &Value) -> Option<&str> {
    match value {
        Value::Null | Value::Bool(false) => Some("shell"),
        Value::Number(number) if number.as_f64() == Some(0.0) => Some("shell"),
        Value::String(text) if text.is_empty() => Some("shell"),
        Value::String(text) if matches!(text.as_str(), "shell" | "program") => Some(text),
        _ => None,
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    Repair(Repair),
    RepairCancel {
        #[serde(deserialize_with = "id")]
        id: String,
    },
    Dictation(Dictation),
    Ack {
        #[serde(deserialize_with = "safe")]
        seq: u64,
    },
    Resize {
        cols: f64,
        rows: f64,
        #[serde(default)]
        mobile: Option<bool>,
    },
    Input {
        #[serde(deserialize_with = "input_text")]
        data: String,
    },
    Paste {
        #[serde(deserialize_with = "input_text")]
        text: String,
    },
    Replace {
        text: String,
        #[serde(deserialize_with = "id")]
        id: String,
        #[serde(deserialize_with = "safe")]
        prompt: u64,
        #[serde(deserialize_with = "safe")]
        revision: u64,
    },
    Command {
        command: String,
        #[serde(deserialize_with = "id")]
        id: String,
        #[serde(default, deserialize_with = "optional_safe")]
        prompt: Option<u64>,
    },
    InputLine {
        #[serde(deserialize_with = "id")]
        id: String,
        #[serde(deserialize_with = "safe")]
        prompt: u64,
        #[serde(deserialize_with = "safe")]
        revision: u64,
    },
    HerdrFrameRequest,
    HerdrActive {
        active: bool,
    },
    TerminalScroll {
        lines: i32,
        column: u16,
        row: u16,
    },
    DictationPaste {
        #[serde(deserialize_with = "repair_text")]
        text: String,
        applied: bool,
        replace: bool,
        #[serde(deserialize_with = "safe")]
        prompt: u64,
        #[serde(deserialize_with = "safe")]
        revision: u64,
        #[serde(default, rename = "readingPhrases")]
        reading_phrases: Value,
    },
}
impl ClientMessage {
    pub fn prompt(&self) -> Option<u64> {
        match self {
            Self::Repair(r) => Some(r.prompt),
            Self::Dictation(d) => d.prompt,
            Self::Replace { prompt, .. }
            | Self::InputLine { prompt, .. }
            | Self::DictationPaste { prompt, .. } => Some(*prompt),
            Self::Command { prompt, .. } => *prompt,
            _ => None,
        }
    }
    pub fn edits_input(&self) -> bool {
        matches!(
            self,
            Self::Input { .. } | Self::Paste { .. } | Self::Replace { .. } | Self::Command { .. }
        )
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum KeychainAction {
    Delete {
        id: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Forget {
        host: String,
        port: Option<u16>,
    },
    Inspect {
        #[serde(default)]
        private_key: String,
        #[serde(default)]
        passphrase: String,
    },
    Create {
        #[serde(default)]
        name: String,
        #[serde(default)]
        passphrase: String,
        private_key: Option<String>,
    },
    Backup {
        #[serde(default)]
        name: String,
        #[serde(default)]
        passphrase: String,
        private_key: Option<String>,
        replace_id: Option<String>,
    },
    Export {
        id: String,
        #[serde(default)]
        passphrase: String,
    },
}
#[derive(Deserialize)]
pub struct SuggestRequest {
    #[serde(deserialize_with = "repair_text")]
    pub text: String,
}
#[derive(Deserialize)]
pub struct InputStamp {
    #[serde(deserialize_with = "safe")]
    pub prompt: u64,
    #[serde(deserialize_with = "safe")]
    pub revision: u64,
}
