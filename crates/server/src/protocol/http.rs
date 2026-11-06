use crate::session::ShellState;
use serde::Serialize;

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ShellState>,
}
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CreatedSession {
    pub id: String,
    pub name: String,
    pub state: ShellState,
}
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SocketTicket {
    pub ticket: String,
}
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Success {
    pub ok: bool,
}
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HttpError {
    pub error: String,
}
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectedHerdr {
    pub herdr_session: String,
    pub herdr_source: String,
}

#[derive(Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HerdrCreated {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct HerdrWorktrees {
    pub source: HerdrRepository,
    pub worktrees: Vec<HerdrWorktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<String>>,
}
#[derive(Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HerdrRepository {
    pub repo_name: String,
    pub repo_root: String,
}
#[derive(Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
pub struct HerdrWorktree {
    pub path: String,
    pub label: String,
    pub is_bare: bool,
    pub is_prunable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_workspace_id: Option<String>,
}
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HerdrActionErrorCode {
    Failed,
    ForceRequired,
}
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HerdrActionError {
    pub error: String,
    pub code: HerdrActionErrorCode,
}
impl From<String> for HerdrActionError {
    fn from(error: String) -> Self {
        Self {
            error,
            code: HerdrActionErrorCode::Failed,
        }
    }
}
impl From<&str> for HerdrActionError {
    fn from(error: &str) -> Self {
        error.to_owned().into()
    }
}
impl From<std::borrow::Cow<'_, str>> for HerdrActionError {
    fn from(error: std::borrow::Cow<'_, str>) -> Self {
        error.into_owned().into()
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FileText {
    pub text: String,
    pub version: String,
    pub mode: u32,
}
