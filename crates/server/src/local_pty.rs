use crate::{
    history, pty_input,
    session::{ProcessEvent, RC, ShellProcess},
    shell::local_bash,
    storage,
};
use libertty_engine::{path, validation::Environment};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    io::{Read, Write},
    sync::{Arc, Condvar, Mutex},
};
use tokio::sync::mpsc;
pub(crate) struct LocalPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    write: pty_input::Sender,
    kill: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    paused: Arc<(Mutex<bool>, Condvar)>,
}
impl ShellProcess for LocalPty {
    fn write(&self, text: &str) -> Result<(), &'static str> {
        self.write.write(text)
    }
    fn pause(&self, paused: bool) {
        *self.paused.0.lock().unwrap() = paused;
        self.paused.1.notify_all();
    }
    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().unwrap().resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    fn kill(&self) {
        self.pause(false);
        let _ = self.kill.lock().unwrap().kill();
    }
}
impl LocalPty {
    pub async fn start(
        cwd: &str,
        directory: &str,
        env: &Environment,
        nonce: &str,
    ) -> Result<(Self, mpsc::Receiver<ProcessEvent>), String> {
        storage::private_directory(std::path::Path::new(directory)).map_err(|e| e.to_string())?;
        let rc = path::join(&[directory, "bashrc"]);
        storage::create_private(std::path::Path::new(&rc), RC.as_bytes())
            .map_err(|e| e.to_string())?;
        let history_source = history::readline_history_source(env).await;
        let mut command = CommandBuilder::new(local_bash(env)?);
        command.args(["--noprofile", "--rcfile", &rc, "-i"]);
        command.cwd(cwd);
        for (key, value) in env {
            command.env(key, value);
        }
        for (key, value) in [
            ("TERM", "xterm-256color".into()),
            ("COLORTERM", "truecolor".into()),
            ("LIBERTTY_TRANSFER_DIR", directory.to_owned()),
            ("LIBERTTY_CAPTURE_SSH", "1".into()),
            ("LIBERTTY_READING_DIR", directory.to_owned()),
            ("LIBERTTY_NONCE", nonce.to_owned()),
            ("LIBERTTY_HISTORY_SOURCE", history_source),
        ] {
            command.env(key, value);
        }
        for (key, name) in [
            ("LIBERTTY_ENV_FILE", "environment"),
            ("LIBERTTY_COMMANDS_FILE", "commands"),
            ("LIBERTTY_FUNCTIONS_FILE", "functions"),
            ("LIBERTTY_COMPLETIONS_FILE", "completions"),
        ] {
            command.env(key, path::join(&[directory, name]));
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        let kill = child.clone_killer();
        let handles = (|| {
            Ok::<_, String>((
                pair.master.try_clone_reader().map_err(|e| e.to_string())?,
                pair.master.take_writer().map_err(|e| e.to_string())?,
            ))
        })();
        let (mut reader, mut writer) = match handles {
            Ok(handles) => handles,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let (sender, receiver) = mpsc::channel(128);
        let input_events = sender.clone();
        let (write, mut input) = pty_input::channel();
        std::thread::spawn(move || {
            while let Some(data) = input.blocking_recv() {
                if writer.write_all(&data.bytes).is_err() {
                    let _ = input_events.blocking_send(ProcessEvent::WriteFailed);
                    break;
                }
            }
        });
        let paused = Arc::new((Mutex::new(false), Condvar::new()));
        let process = Self {
            master: Mutex::new(pair.master),
            write,
            kill: Mutex::new(kill),
            paused: paused.clone(),
        };
        let output = sender.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16384];
            loop {
                let mut pause = paused.0.lock().unwrap();
                while *pause {
                    pause = paused.1.wait(pause).unwrap();
                }
                drop(pause);
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if output
                            .blocking_send(ProcessEvent::Data(buffer[..size].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = output.blocking_send(ProcessEvent::Closed);
        });
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            let _ = sender.blocking_send(ProcessEvent::Exited(code));
        });
        Ok((process, receiver))
    }
}
