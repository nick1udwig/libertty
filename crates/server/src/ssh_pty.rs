use crate::{
    session::{ProcessEvent, ShellProcess},
    ssh::{ChannelGuard, RemoteChannel},
};
use russh::ChannelMsg;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

enum Command {
    Write(Vec<u8>),
    Resize(u16, u16),
}
pub(crate) struct RemotePty {
    send: mpsc::UnboundedSender<Command>,
    pause: watch::Sender<bool>,
    lifetime: CancellationToken,
}
impl RemotePty {
    pub fn start(channel: RemoteChannel) -> (Self, mpsc::Receiver<ProcessEvent>) {
        let (mut read, write) = channel.split();
        let guard = Arc::new(ChannelGuard(Arc::new(write)));
        let lifetime = CancellationToken::new();
        let (send, mut commands) = mpsc::unbounded_channel();
        let (pause, mut paused) = watch::channel(false);
        let writer = guard.clone();
        let stopped = lifetime.clone();
        tokio::spawn(async move {
            loop {
                let command = tokio::select! {biased;_=stopped.cancelled()=>break,command=commands.recv()=>command};
                let work = async {
                    match command {
                        Some(Command::Write(bytes)) => writer.0.data(bytes.as_slice()).await,
                        Some(Command::Resize(cols, rows)) => {
                            writer.0.window_change(cols as u32, rows as u32, 0, 0).await
                        }
                        None => return false,
                    }
                    .is_ok()
                };
                if !tokio::select! { biased;_=stopped.cancelled()=>false,result=work=>result } {
                    break;
                }
            }
            stopped.cancel();
        });
        let (events, receive) = mpsc::channel(128);
        let stopped = lifetime.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let mut code = 0;
            loop {
                if *paused.borrow() {
                    tokio::select! {biased;_=stopped.cancelled()=>break,result=paused.changed()=>{if result.is_err(){break;}}}
                    continue;
                }
                let message = tokio::select! { biased;_=stopped.cancelled()=>break,result=paused.changed()=>{if result.is_err(){break;} continue;}, message=read.wait()=>message };
                match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if !tokio::select! {biased;_=stopped.cancelled()=>false,result=events.send(ProcessEvent::Data(data.to_vec()))=>result.is_ok()}
                        {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status,
                    Some(ChannelMsg::Failure) => {
                        code = 1;
                        break;
                    }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            stopped.cancel();
            let _ = events.send(ProcessEvent::Closed).await;
            let _ = events.send(ProcessEvent::Exited(code)).await;
        });
        (
            Self {
                send,
                pause,
                lifetime,
            },
            receive,
        )
    }
}
impl ShellProcess for RemotePty {
    fn write(&self, text: &str) {
        let _ = self.send.send(Command::Write(text.as_bytes().to_vec()));
    }
    fn pause(&self, paused: bool) {
        self.pause.send_replace(paused);
    }
    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.send.send(Command::Resize(cols, rows));
    }
    fn kill(&self) {
        self.lifetime.cancel();
    }
}
impl Drop for RemotePty {
    fn drop(&mut self) {
        self.kill();
    }
}
