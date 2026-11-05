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
