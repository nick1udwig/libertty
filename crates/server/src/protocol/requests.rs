use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct Connect {
    pub token: Option<String>,
    pub session: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub no_session: bool,
}
#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct Sessions {
    pub name: Option<String>,
    #[cfg_attr(test, ts(type = "unknown", optional))]
    pub ssh: Option<Value>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct HerdrConnect {
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub core: bool,
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
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct HerdrTicket {
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct SshAddress {
    pub host: String,
    pub username: String,
    pub port: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum FileAction {
    Read {
        path: String,
    },
    Write {
        path: String,
        text: String,
        version: String,
    },
    Rename {
        path: String,
        name: String,
    },
    Copy {
        paths: Vec<String>,
        destination: String,
    },
    Delete {
        paths: Vec<String>,
    },
}
impl TryFrom<&Value> for FileAction {
    type Error = serde_json::Error;
    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        Self::deserialize(value)
    }
}

#[cfg(test)]
mod tests {
    use super::FileAction;
    use serde_json::json;

    #[test]
    fn file_actions_require_their_operation_fields() {
        for input in [
            json!({"action":"read"}),
            json!({"action":"write","path":"/file","text":"new"}),
            json!({"action":"rename","path":"/file"}),
            json!({"action":"copy","paths":["/file"]}),
            json!({"action":"delete"}),
        ] {
            assert!(FileAction::try_from(&input).is_err(), "{input}");
        }
        assert!(FileAction::try_from(&json!({"action":"read","path":"/file"})).is_ok());
        assert!(
            FileAction::try_from(&json!({"action":"write","path":"/file","text":"","version":"v"}))
                .is_ok()
        );
    }
}
