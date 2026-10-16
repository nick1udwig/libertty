use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connect {
    pub token: Option<String>,
    pub session: Option<String>,
    #[serde(default)]
    pub no_session: bool,
}
#[derive(Deserialize)]
pub struct Sessions {
    pub name: Option<String>,
    pub ssh: Option<Value>,
    #[serde(default)]
    pub files: bool,
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureAction {
    #[default]
    Connect,
    Ack,
    Cancel,
    Native,
}
#[derive(Deserialize)]
pub struct Capture {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub action: CaptureAction,
    pub passphrase: Option<String>,
    pub trust: Option<String>,
}
#[derive(Deserialize)]
pub struct HerdrConnect {
    pub source: Option<String>,
    pub session: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrReading {
    pub terminal_id: String,
    pub command: String,
    pub context: String,
    pub cwd: String,
}
#[derive(Default, Deserialize)]
pub struct HerdrTicket {
    #[serde(default)]
    pub mobile: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}
#[derive(Deserialize)]
pub struct Subscribe {
    pub subscription: Value,
}
#[derive(Deserialize)]
pub struct Device {
    pub device: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub device: String,
    pub tab_id: String,
}
#[derive(Deserialize)]
pub struct Folder {
    pub path: String,
    pub name: String,
}
#[derive(Deserialize)]
pub struct Path {
    pub path: String,
}
#[derive(Deserialize)]
pub struct Transfer {
    pub id: String,
    pub action: TransferAction,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferAction {
    Ack,
    Download,
}
#[derive(Deserialize)]
pub struct SshAddress {
    pub host: String,
    pub username: String,
    pub port: Option<f64>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileActionKind {
    Read,
    Write,
    Rename,
    Copy,
    Delete,
}
impl FileActionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Rename => "rename",
            Self::Copy => "copy",
            Self::Delete => "delete",
        }
    }
}
#[derive(Deserialize)]
pub struct FileAction {
    pub action: FileActionKind,
    pub path: Option<String>,
    pub name: Option<String>,
    pub text: Option<String>,
    pub version: Option<String>,
    pub paths: Option<Vec<String>>,
    pub destination: Option<String>,
}
impl TryFrom<&Value> for FileAction {
    type Error = serde_json::Error;
    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        Self::deserialize(value)
    }
}
