use crate::{
    pty_input,
    session::{ProcessEvent, ShellProcess},
    ssh::{ChannelGuard, RemoteChannel},
};
use russh::ChannelMsg;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

enum Command {
    Write(pty_input::Input),
    Resize(u16, u16),
}
pub(crate) struct RemotePty {
    send: pty_input::Sender,
    resize: watch::Sender<(u16, u16)>,
    pause: watch::Sender<bool>,
    lifetime: CancellationToken,
}
impl RemotePty {
    pub fn start(channel: RemoteChannel) -> (Self, mpsc::Receiver<ProcessEvent>) {
        let (mut read, write) = channel.split();
        let guard = Arc::new(ChannelGuard(Arc::new(write)));
        let lifetime = CancellationToken::new();
        let (send, mut commands) = pty_input::channel();
        let (resize, mut sizes) = watch::channel((80, 24));
        let (events, receive) = mpsc::channel(128);
        let input_events = events.clone();
        let (pause, mut paused) = watch::channel(false);
        let writer = guard.clone();
        let stopped = lifetime.clone();
        tokio::spawn(async move {
            loop {
                let command = tokio::select! {
                    biased;
                    _=stopped.cancelled()=>break,
                    changed=sizes.changed()=>{
                        if changed.is_err() { break; }
                        let (cols, rows) = *sizes.borrow_and_update();
                        Command::Resize(cols, rows)
                    },
                    input=commands.recv()=>match input { Some(input)=>Command::Write(input), None=>break },
                };
                let work = async {
                    match command {
                        Command::Write(input) => writer.0.data(input.bytes.as_slice()).await,
                        Command::Resize(cols, rows) => {
                            writer.0.window_change(cols as u32, rows as u32, 0, 0).await
                        }
                    }
                };
                let result =
                    tokio::select! { biased;_=stopped.cancelled()=>break,result=work=>result };
                if result.is_err() {
                    let _ = input_events.send(ProcessEvent::WriteFailed).await;
                    break;
                }
            }
            stopped.cancel();
        });
        let stopped = lifetime.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let mut code = 1;
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
                resize,
                pause,
                lifetime,
            },
            receive,
        )
    }
}
impl ShellProcess for RemotePty {
    fn write(&self, text: &str) -> Result<(), &'static str> {
        self.send.write(text)
    }
    fn pause(&self, paused: bool) {
        self.pause.send_replace(paused);
    }
    fn resize(&self, cols: u16, rows: u16) {
        self.resize.send_replace((cols, rows));
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
