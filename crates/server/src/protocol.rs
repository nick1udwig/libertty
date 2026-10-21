//! Validated client messages shared by native terminals and Herdr viewers.
use crate::alternatives::Intent;
use libertty_engine::utf16_len;
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use serde_json::Value;

#[derive(Clone, Copy, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum EngineMode {
    Server,
}
#[derive(Clone, Copy, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum DictationSource {
    Dictation,
}
#[derive(Clone, Copy, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum DictationState {
    Ready,
    Done,
    Error,
}
impl DictationState {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "ready" => Some(Self::Ready),
            "done" => Some(Self::Done),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}
/// Where dictated text goes: the shell prompt or a running program.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum DictationTarget {
    Shell,
    Program,
}
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HerdrFrame {
    /// Viewers receive only acknowledged frames.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(type = "number"))]
    pub seq: Option<u64>,
    pub width: u16,
    pub height: u16,
    pub full: bool,
    /// Raw ANSI bytes, decoded once from Herdr and base64-encoded only for JSON clients.
    #[serde(serialize_with = "base64")]
    #[cfg_attr(test, ts(type = "string"))]
    pub bytes: std::sync::Arc<[u8]>,
}
fn base64<S: serde::Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    use base64::Engine;
    serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
}
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    Pong,
    RepairResult(RepairReply),
    InputLine {
        id: String,
        prompt: u64,
        revision: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<usize>,
    },
    Transfer {
        request: crate::transfers::Request,
    },
    Pasted {
        text: String,
        replace: bool,
        prompt: u64,
        revision: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<DictationSource>,
        #[serde(skip_serializing_if = "Option::is_none")]
        repairing: Option<bool>,
    },
    Dictation {
        #[serde(skip_serializing_if = "Option::is_none")]
        resume: Option<crate::dictation::Checkpoint>,
        id: String,
        state: DictationState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    ReadingFile {
        path: String,
    },
    ReadingCapture(crate::reading::Descriptor),
    ReadingError {
        message: String,
    },
    SshCommand {
        id: String,
        command: String,
    },
    HerdrCommand {
        id: String,
        command: String,
    },
    SshReleased {
        id: String,
    },
    Output {
        seq: u64,
        data: std::sync::Arc<str>,
    },
    Screen {
        text: std::sync::Arc<str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<u64>,
    },
    ScreenDelta {
        base: u64,
        version: u64,
        drop: usize,
        from: usize,
        tail: usize,
        text: std::sync::Arc<str>,
    },
    HerdrLayout {
        cols: u16,
        rows: u16,
        ready: bool,
    },
    HerdrFrame(HerdrFrame),
    State {
        state: crate::session::ShellState,
    },
    Hello {
        engine: EngineMode,
        reset: bool,
        truncated: bool,
        first_seq: u64,
        last_seq: u64,
        stream_id: String,
    },
    EditResult {
        id: String,
        accepted: bool,
        revision: u64,
    },
    /// The last numbered key this terminal delivered for the connecting browser, absent when it is new here.
    InputAck {
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
    Result {
        id: String,
        accepted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}
impl ServerMessage {
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("server message")
    }
}
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields, rename = "RepairResult"))]
pub struct RepairReply {
    pub id: String,
    pub prompt: u64,
    pub revision: u64,
    pub accepted: bool,
    #[serde(flatten)]
    pub prepared: crate::alternatives::Prepared,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<DictationSource>,
}
impl RepairReply {
    pub fn new(id: String, text: String, prompt: u64, revision: u64, backend: bool) -> Self {
        Self {
            id,
            prompt,
            revision,
            accepted: false,
            prepared: crate::alternatives::Prepared {
                original: text.clone(),
                selected: text,
                candidates: vec![],
            },
            error: None,
            source: backend.then_some(DictationSource::Dictation),
        }
    }
    pub fn backend(&self) -> bool {
        self.source.is_some()
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ViewerMessage {
    Ping,
    NotificationPresence { device: String, focused: bool },
    NotificationAck { device: String, event: Value },
}
pub mod requests;

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
    if utf16_len(&value) > N || (CLEAN && controls(&value)) {
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum DictationAction {
    Start,
    Finish,
    Cancel,
}
#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "RepairRequest"))]
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
    #[cfg_attr(test, ts(optional = nullable))]
    pub intent: Intent,
}
#[derive(Deserialize)]
#[cfg_attr(
    test,
    derive(ts_rs::TS),
    ts(optional_fields, rename = "DictationRequest")
)]
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
    #[cfg_attr(test, ts(type = "DictationTarget", optional = nullable))]
    pub target: Value,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "string[]", optional = nullable))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    Ping {
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        checkpoint: bool,
    },
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
        /// Numbers keys per browser terminal so a reconnect can resend them exactly once.
        #[serde(default, deserialize_with = "optional_safe")]
        seq: Option<u64>,
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
    TerminalClick {
        column: u16,
        row: u16,
        cols: u16,
        rows: u16,
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
        #[cfg_attr(test, ts(type = "string[]", optional = nullable))]
        reading_phrases: Value,
    },
}
impl TryFrom<Value> for ClientMessage {
    type Error = serde_json::Error;
    fn try_from(value: Value) -> Result<Self, Self::Error> {
        serde_json::from_value(value)
    }
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
        match self {
            Self::Input { data, .. } => !matches!(data.as_str(), "\x1b[I" | "\x1b[O"),
            Self::Paste { .. } | Self::Replace { .. } | Self::Command { .. } => true,
            _ => false,
        }
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

#[cfg(test)]
mod tests {
    use super::ClientMessage;
    use serde_json::{Value, json};
    use ts_rs::{Config, TS};

    const BINDINGS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/generated/protocol.ts"
    );

    /// One declaration per type, with one-line field comments and one union member per line.
    fn declaration(file: &str) -> String {
        let mut result = String::new();
        let mut comment: Option<Vec<&str>> = None;
        for line in file.lines() {
            match (line.trim(), &mut comment) {
                (_, None) if line.starts_with("// ") || line.starts_with("import ") => {}
                ("/**", _) => comment = Some(vec![]),
                ("*/", Some(lines)) => {
                    let separator = if result.is_empty() { "\n" } else { " " };
                    result += &format!("/** {} */{separator}", lines.join(" "));
                    comment = None;
                }
                (text, Some(lines)) => lines.push(text.trim_start_matches('*').trim()),
                (_, None) => result += line,
            }
        }
        result.trim().replace(" | { \"", "\n  | { \"")
    }

    #[test]
    fn typescript_bindings_match_the_rust_wire_types() {
        let directory = tempfile::tempdir().unwrap();
        let config = Config::new()
            .with_large_int("number")
            .with_out_dir(directory.path());
        super::ServerMessage::export_all(&config).unwrap();
        ClientMessage::export_all(&config).unwrap();
        crate::herdr::Metadata::export_all(&config).unwrap();
        crate::files::Listing::export_all(&config).unwrap();
        libertty_engine::types::Catalog::export_all(&config).unwrap();
        let mut files: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        files.sort();
        let declarations: Vec<String> = files
            .iter()
            .map(|file| declaration(&std::fs::read_to_string(file).unwrap()))
            .collect();
        let generated = format!(
            "// Generated from the Rust wire types by `npm run bindings`; do not edit.\n\n{}\n",
            declarations.join("\n\n")
        );
        if std::env::var_os("LIBERTTY_WRITE_BINDINGS").is_some() {
            std::fs::write(BINDINGS, generated).unwrap();
        } else {
            assert!(
                std::fs::read_to_string(BINDINGS).ok().as_deref() == Some(generated.as_str()),
                "src/generated/protocol.ts is stale; run `npm run bindings`"
            );
        }
    }

    #[test]
    fn client_messages_accept_unknown_fields_and_reject_malformed_field_types() {
        let id = "11111111-1111-4111-8111-111111111111";
        let samples = [
            json!({"type":"ping"}),
            json!({"type":"repair","id":id,"text":"echo 🌍","prompt":1,"revision":2}),
            json!({"type":"repair-cancel","id":id}),
            json!({"type":"input-line","id":id,"prompt":1,"revision":2}),
            json!({"type":"dictation","id":id,"action":"start","target":"program","prompt":1,"revision":2}),
            json!({"type":"input","data":"\u{1b}[A","seq":1}),
            json!({"type":"paste","text":"🌍"}),
            json!({"type":"dictation-paste","text":"hello","applied":false,"replace":false,"prompt":1,"revision":2}),
            json!({"type":"replace","id":id,"text":"echo","prompt":1,"revision":2}),
            json!({"type":"command","id":id,"command":"echo","prompt":1}),
            json!({"type":"resize","cols":80,"rows":24,"mobile":true}),
            json!({"type":"terminal-scroll","lines":-2,"column":0,"row":0}),
            json!({"type":"terminal-click","column":3,"row":4,"cols":80,"rows":24}),
            json!({"type":"herdr-frame-request"}),
            json!({"type":"herdr-active","active":true}),
            json!({"type":"ack","seq":9_007_199_254_740_991u64}),
        ];
        for sample in samples {
            let mut extended = sample.clone();
            extended["future"] = json!(true);
            assert!(ClientMessage::try_from(extended).is_ok(), "{sample}");
            for (field, value) in sample.as_object().unwrap() {
                if field == "type" || field == "target" {
                    continue;
                }
                let mut malformed = sample.clone();
                malformed[field] = if value.is_string() {
                    json!({})
                } else {
                    Value::from("invalid")
                };
                assert!(
                    ClientMessage::try_from(malformed).is_err(),
                    "{sample} {field}"
                );
            }
        }
    }
}
