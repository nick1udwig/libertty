//! Explicit hc binary and session configuration. Dropping it closes only the proxy.
use crate::client::{Client, Error};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStdin, ChildStdout, Command},
};
pub struct HcConfig {
    pub binary: PathBuf,
    pub session: String,
    pub environment: BTreeMap<String, String>,
}
impl HcConfig {
    pub async fn connect(&self, deadline: Duration) -> Result<Client, Error> {
        if self.session.is_empty() {
            return Err(Error::Protocol("session must be explicit".into()));
        }
        let mut child = Command::new(&self.binary)
            .arg("connect")
            .envs(&self.environment)
            .env("HC_SESSION", &self.session)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        Client::connect(
            Pipe {
                _child: child,
                input,
                output,
            },
            deadline,
        )
        .await
    }
}
struct Pipe {
    _child: Child,
    input: ChildStdin,
    output: ChildStdout,
}
impl AsyncRead for Pipe {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.output).poll_read(cx, buf)
    }
}
impl AsyncWrite for Pipe {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.input).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.input).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.input).poll_shutdown(cx)
    }
}
