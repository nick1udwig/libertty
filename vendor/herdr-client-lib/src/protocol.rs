//! Typed core protocol records, parameters, and results.
//!
//! Adapted from herdr-core `crates/herdr-core/src/api/types.rs`, `terminals.rs`,
//! `status.rs`, `foreground.rs`, `machines.rs`, and `remote.rs` at
//! 298d9c9094ce36c2c80c8bd917032458d5f440f1 (Apache-2.0).
//! CLI attributes, schema derivations, and core bookkeeping are omitted.
//! Records keep fields that a newer core adds in `extra`.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

fn is_false(value: &bool) -> bool {
    !*value
}

/// The program's own word for what it's doing (OSC 7501).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Status {
    /// idle, working, done, blocked, error, or a newer word.
    pub state: String,
    /// permission, question or auth (blocked only, when the program said).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 0..100 (working or blocked, when the program said).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub app: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub msg: String,
}

/// What runs in a terminal right now and where.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Foreground {
    /// The foreground process group's leader.
    pub pid: i32,
    /// Its name as the OS has it (`node`, `vim`, `sh`).
    pub name: String,
    pub argv: Vec<String>,
    /// Its working directory now (resolved by the OS).
    pub cwd: String,
}

/// A terminal as clients see it (API results, events).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Terminal {
    /// `t7`, or `machine/t7` for a terminal on an added machine.
    pub address: String,
    pub name: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub argv: Vec<String>,
    pub cwd: String,
    /// Replace a lost program with this machine's shell, in place.
    pub keep: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_cwd: Option<String>,
    /// "live" or "finished".
    pub state: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// Why its program ended or is pending.
    pub reason: Option<String>,
    pub created_ms: u64,
    pub finished_ms: Option<u64>,
    /// "exact", or "inexact" after a core crash.
    pub screen: String,
    pub cols: u16,
    pub rows: u16,
    pub identity: String,
    /// The root OSC 7501 record; null if it never said, or after it exited.
    pub status: Option<Status>,
    pub status_ms: Option<u64>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub records: BTreeMap<String, Status>,
    /// Goes up each time the status leaves `working`.
    pub turn: u64,
    /// Whether the program ever sent a 7501 report.
    pub reported: bool,
    pub title: String,
    /// The terminal that started it (`t3`), set once at start.
    pub parent: Option<String>,
    pub notify: bool,
    pub die_with_parent: bool,
    pub rm: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub full_screen: bool,
    pub template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<Foreground>,
    /// Fields this library does not interpret, kept as received.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Terminal {
    pub fn is_live(&self) -> bool {
        self.state == "live"
    }
    /// The root status word, unchanged; `None` when the program never said.
    pub fn word(&self) -> Option<&str> {
        self.status.as_ref().map(|s| s.state.as_str())
    }
    /// A non-empty label value.
    pub fn label(&self, key: &str) -> Option<&str> {
        self.labels
            .get(key)
            .map(String::as_str)
            .filter(|s| !s.is_empty())
    }
    /// The folder it works in now: the foreground's, else its start folder.
    pub fn folder(&self) -> Option<&str> {
        self.foreground
            .as_ref()
            .map(|f| f.cwd.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| Some(self.cwd.as_str()).filter(|s| !s.is_empty()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CoreInfo {
    /// Permanent random id, reset only when state is wiped.
    pub id: String,
    /// Display name, the hostname by default.
    pub name: String,
}

/// The connection handshake reply.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hello {
    pub generation: u32,
    pub version: String,
    pub core: CoreInfo,
    pub framed: bool,
    pub methods: Vec<String>,
    pub features: Vec<String>,
}

/// A machine as `machine.list` shows it: its profile and its line now.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Machine {
    /// What this core calls it: `rohan` in `rohan/t7`.
    pub name: String,
    pub target: String,
    pub via: bool,
    pub temporary: bool,
    pub session: Option<String>,
    /// The other core's permanent id.
    pub id: String,
    pub host: String,
    pub version: String,
    /// connecting, connected, needs_login, needs_update or unreachable.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl Machine {
    pub fn connected(&self) -> bool {
        self.state == "connected"
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MachineList {
    pub machines: Vec<Machine>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalList {
    /// This machine's terminals, then each connected machine's (`machine/t7`).
    pub terminals: Vec<Terminal>,
    pub hidden_finished: usize,
    pub machines: Vec<Machine>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ListParams {
    /// Include finished terminals.
    #[serde(default, skip_serializing_if = "is_false")]
    pub all: bool,
    /// Only terminals carrying all of these labels.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RunParams {
    /// Program and arguments; with neither argv nor line, that machine's shell.
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Another machine; omitted for this core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default)]
    pub no_parent: bool,
    #[serde(default)]
    pub no_notify: bool,
    #[serde(default)]
    pub outlive_parent: bool,
    #[serde(default)]
    pub rm: bool,
    /// Replace lost programs with a shell in place.
    #[serde(default)]
    pub keep: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ExecParams {
    /// Program and arguments, run as given (no shell).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Seconds before it and everything it started are ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
    /// Bytes for its stdin, base64.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExecResult {
    /// Its exit code; null when a signal ended it.
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// What it wrote, base64.
    pub stdout: String,
    /// What it wrote, base64.
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AttachParams {
    /// The terminal: `t7`, a name, or `machine/t7`.
    pub terminal: String,
    /// Watch only: never type or resize.
    #[serde(default, skip_serializing_if = "is_false")]
    pub observe: bool,
    /// Scrollback lines to show first (main screen only).
    #[serde(default)]
    pub history: usize,
    pub cols: u16,
    pub rows: u16,
    /// The viewer's own colors and cell size, used to answer display queries.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub display: Value,
    /// Back after a dropped line: sets the size only once active again.
    #[serde(default, skip_serializing_if = "is_false")]
    pub resumed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReadResult {
    pub text: String,
    pub complete: bool,
    /// "screen", "history", or "stitched".
    pub how: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocGetResult {
    pub value: Value,
    /// Zero when never written.
    pub version: u64,
}

/// An event subscription's starting point: a sequence and the matching terminals.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub seq: u64,
    pub terminals: Vec<Terminal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub machines: Vec<Machine>,
}

/// One change to a terminal or document.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Event {
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: String,
    /// Absent on document events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    /// This core's name for the machine a document event came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// The event's data; see core's event table for each type.
    pub data: Value,
}

impl Event {
    /// The document name of a `doc` event.
    pub fn document(&self) -> Option<&str> {
        (self.kind == "doc")
            .then(|| self.data["name"].as_str())
            .flatten()
    }
}

/// A subscription notification.
#[derive(Clone, Debug, PartialEq)]
pub enum Notification {
    Event(Event),
    Heartbeat {
        seq: u64,
    },
    Missed(Snapshot),
    /// A notification this library does not interpret.
    Other(Value),
}

impl Notification {
    pub fn decode(value: Value) -> Result<Self, serde_json::Error> {
        let params = value["params"].clone();
        Ok(match value["method"].as_str() {
            Some("event") => Self::Event(serde_json::from_value(params)?),
            Some("heartbeat") => Self::Heartbeat {
                seq: params["seq"].as_u64().unwrap_or_default(),
            },
            Some("missed") => Self::Missed(serde_json::from_value(params)?),
            _ => Self::Other(value),
        })
    }
}
