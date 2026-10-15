use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use termai_server::herdr::{Target, read_line};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
};
use tokio_util::sync::CancellationToken;

// Shared integration fixture exposes controls needed by different harnesses.
#[allow(dead_code)]
pub struct Fixture {
    pub directory: tempfile::TempDir,
    pub target: Target,
    pub snapshot: Arc<Mutex<Value>>,
    pub actions: Arc<Mutex<Vec<Value>>>,
    pub requests: Arc<Mutex<Vec<Value>>>,
    pub connections: Arc<AtomicU64>,
    pub screen: Arc<Mutex<String>>,
    pub content_revision: Arc<AtomicU64>,
    pub close_error: Arc<Mutex<String>>,
    pub read_error: Arc<Mutex<String>>,
    pub reading_shell: Arc<AtomicBool>,
    pub split_error: Arc<Mutex<String>>,
    events: tokio::sync::broadcast::Sender<()>,
    cancel: CancellationToken,
}
impl Fixture {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("herdr.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let snapshot = Arc::new(Mutex::new(json!({"version":"test","protocol":22,
            "workspaces":[{"workspace_id":"w1","label":"Termai","active_tab_id":"t1"}],
            "tabs":[{"tab_id":"t1","workspace_id":"w1","label":"API"}],
            "panes":[{"pane_id":"w1:p0","terminal_id":"term_0","workspace_id":"w1","tab_id":"t1","focused":true,"label":"API","cwd":"/workspace"}],
            "agents":[{"terminal_id":"term_0","pane_id":"w1:p0","workspace_id":"w1","tab_id":"t1","name":"agent-address","agent":"fixture","agent_status":"working","state_change_seq":1,"revision":1,"cwd":"/workspace"}]
        })));
        let actions = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicU64::new(0));
        let screen = Arc::new(Mutex::new("Live Herdr terminal".into()));
        let content_revision = Arc::new(AtomicU64::new(6));
        let close_error = Arc::new(Mutex::new(String::new()));
        let read_error = Arc::new(Mutex::new(String::new()));
        let reading_shell = Arc::new(AtomicBool::new(false));
        let split_error = Arc::new(Mutex::new(String::new()));
        let (events, _) = tokio::sync::broadcast::channel(64);
        let cancel = CancellationToken::new();
        let fixture = Self {
            directory,
            target: Target {
                remote: None,
                session: String::new(),
                socket_path: Some(path.to_string_lossy().into_owned()),
                binary: "herdr".into(),
                env: std::env::vars().collect(),
                repairs: Default::default(),
                shared: Default::default(),
            },
            snapshot: snapshot.clone(),
            actions: actions.clone(),
            requests: requests.clone(),
            connections: connections.clone(),
            screen: screen.clone(),
            content_revision: content_revision.clone(),
            close_error: close_error.clone(),
            read_error: read_error.clone(),
            reading_shell: reading_shell.clone(),
            split_error: split_error.clone(),
            events: events.clone(),
            cancel: cancel.clone(),
        };
        tokio::spawn(async move {
            loop {
                let stream = tokio::select! {biased;_=cancel.cancelled()=>break,result=listener.accept()=>result.unwrap().0};
                connections.fetch_add(1, Ordering::Relaxed);
                let requests = requests.clone();
                let snapshot = snapshot.clone();
                let actions = actions.clone();
                let screen = screen.clone();
                let content_revision = content_revision.clone();
                let events = events.clone();
                let cancel = cancel.clone();
                let close_error = close_error.clone();
                let read_error = read_error.clone();
                let reading_shell = reading_shell.clone();
                let split_error = split_error.clone();
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    loop {
                        let request = tokio::select! {biased;_=cancel.cancelled()=>break,result=read_line(&mut stream)=>result.unwrap_or(None)};
                        let Some(request) = request else { break };
                        requests.lock().unwrap().push(request.clone());
                        let method = request["method"].as_str().unwrap_or("");
                        let params = &request["params"];
                        let mut error = None;
                        let mut changed = false;
                        let result = match method {
                            "session.snapshot" => {
                                json!({"snapshot":snapshot.lock().unwrap().clone()})
                            }
                            "server.agent_manifests" => {
                                json!({"manifests":[{"agent":"codex"},{"agent":"claude"},{"agent":"pi"},{"agent":"unsafe argument"},{"agent":"codex"}]})
                            }
                            "events.subscribe" => {
                                let mut receiver = events.subscribe();
                                if stream.get_mut().write_all(format!("{}\n",json!({"id":request["id"],"result":{"type":"subscribed"}})).as_bytes()).await.is_err(){break;}
                                loop {
                                    tokio::select! {biased;_=cancel.cancelled()=>break,_=stream.fill_buf()=>break,_=receiver.recv()=>{}}
                                    if stream
                                        .get_mut()
                                        .write_all(b"{\"type\":\"event\"}\n")
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                                break;
                            }
                            "pane.copy_motion" => {
                                json!({"content_revision":content_revision.load(Ordering::Relaxed),"cursor":{"row":0,"col":0}})
                            }
                            "pane.process_info" if reading_shell.load(Ordering::Relaxed) => {
                                json!({"process_info":{"shell_pid":1,"foreground_process_group_id":1,"foreground_processes":[{"pid":1,"name":"bash","cwd":snapshot.lock().unwrap()["panes"][0]["cwd"]}]}})
                            }
                            "pane.read" => {
                                actions.lock().unwrap().push(request.clone());
                                let message = read_error.lock().unwrap().clone();
                                if !message.is_empty() {
                                    error = Some(message);
                                }
                                json!({"read":{"text":screen.lock().unwrap().clone()}})
                            }
                            "pane.get" => {
                                actions.lock().unwrap().push(request.clone());
                                json!({"pane":snapshot.lock().unwrap()["panes"][0]})
                            }
                            "pane.rename" => {
                                actions.lock().unwrap().push(request.clone());
                                snapshot.lock().unwrap()["panes"][0]["label"] =
                                    params["label"].clone();
                                changed = true;
                                json!({"type":"ok"})
                            }
                            "workspace.rename" => {
                                actions.lock().unwrap().push(request.clone());
                                snapshot.lock().unwrap()["workspaces"][0]["label"] =
                                    params["label"].clone();
                                changed = true;
                                json!({"type":"ok"})
                            }
                            "workspace.move_block" => {
                                actions.lock().unwrap().push(request.clone());
                                json!({"type":"ok"})
                            }
                            "worktree.list" => {
                                actions.lock().unwrap().push(request.clone());
                                json!({"source":{"repo_name":"repo","repo_root":snapshot.lock().unwrap()["panes"][0]["cwd"]},"worktrees":[{"path":"/workspace","label":"main","is_bare":false,"is_prunable":false},{"path":"/worktrees/repo/review","label":"review","is_bare":false,"is_prunable":false},{"path":"/pruned","is_prunable":true}]})
                            }
                            "worktree.create" | "worktree.open" => {
                                actions.lock().unwrap().push(request.clone());
                                json!({"workspace":{"workspace_id":"w2"},"root_pane":{"terminal_id":"term_1"}})
                            }
                            "worktree.remove" => {
                                actions.lock().unwrap().push(request.clone());
                                let message = close_error.lock().unwrap().clone();
                                if !message.is_empty() {
                                    error = Some(message);
                                } else {
                                    let mut snapshot = snapshot.lock().unwrap();
                                    snapshot["workspaces"] = json!([]);
                                    snapshot["agents"] = json!([]);
                                    snapshot["panes"] = json!([]);
                                    changed = true;
                                }
                                json!({"type":"worktree.removed"})
                            }
                            "pane.split" => {
                                actions.lock().unwrap().push(request.clone());
                                let message = split_error.lock().unwrap().clone();
                                if !message.is_empty() {
                                    error = Some(message);
                                }
                                json!({"pane":{"terminal_id":"term_split"}})
                            }
                            "pane.send_text" | "pane.send_input" => {
                                actions.lock().unwrap().push(request.clone());
                                screen
                                    .lock()
                                    .unwrap()
                                    .push_str(params["text"].as_str().unwrap_or(""));
                                json!({"type":"ok"})
                            }
                            "workspace.close" | "pane.close" => {
                                actions.lock().unwrap().push(request.clone());
                                let message = close_error.lock().unwrap().clone();
                                if !message.is_empty() {
                                    error = Some(message);
                                } else {
                                    snapshot.lock().unwrap()["agents"] = json!([]);
                                    snapshot.lock().unwrap()["panes"] = json!([]);
                                    changed = true;
                                }
                                json!({"type":"ok"})
                            }
                            _ => {
                                error = Some("Unsupported fixture method".into());
                                Value::Null
                            }
                        };
                        let reply = if let Some(message) = error {
                            json!({"id":request["id"],"error":{"message":message}})
                        } else {
                            json!({"id":request["id"],"result":result})
                        };
                        if stream
                            .get_mut()
                            .write_all(format!("{reply}\n").as_bytes())
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if changed {
                            let _ = events.send(());
                        }
                    }
                });
            }
        });
        fixture
    }
    #[allow(dead_code)]
    pub fn notify(&self) {
        let _ = self.events.send(());
    }
    #[allow(dead_code)]
    pub fn update(&self, status: &str) {
        let mut snapshot = self.snapshot.lock().unwrap();
        let agent = &mut snapshot["agents"][0];
        let old = agent["agent_status"].as_str().unwrap_or("").to_owned();
        let sequence = agent["state_change_seq"].as_u64().unwrap() + 1;
        agent["agent_status"] = json!(status);
        agent["state_change_seq"] = json!(sequence);
        if (status == "idle" || status == "done") && old == "working" {
            agent["completion_seq"] = json!(sequence);
        }
        drop(snapshot);
        let _ = self.events.send(());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
