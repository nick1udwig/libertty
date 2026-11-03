//! Git operations always execute on the core's host, including local connections.
use crate::{
    client::{Client, Error},
    commands::{Creation, Launch, Placement},
    protocol::ExecParams,
    sync::{Session, on},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{collections::BTreeMap, time::Duration};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkout {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub locked: bool,
    pub prunable: bool,
    pub bare: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Removal {
    pub machine: String,
    pub repository: String,
    pub checkout: Checkout,
    pub status: Vec<u8>,
    pub submodules: Vec<u8>,
    pub unmerged: Vec<u8>,
    pub submodule_unpushed: Vec<u8>,
}
/// What a removal would lose or why Git refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemovalRisk {
    /// Modified or untracked files would be deleted.
    Dirty,
    /// Commits reachable only from this checkout's HEAD.
    UnreferencedCommits,
    /// Submodule commits that no remote or parent pin holds.
    UnpushedSubmoduleCommits,
    Locked,
    Prunable,
    Bare,
}
impl RemovalRisk {
    /// Whether the person may accept it and remove anyway, as the app and Herdr allow.
    pub fn acceptable(self) -> bool {
        matches!(
            self,
            Self::Dirty | Self::UnreferencedCommits | Self::UnpushedSubmoduleCommits
        )
    }
}
impl Removal {
    pub fn risks(&self) -> Vec<RemovalRisk> {
        [
            (!self.status.is_empty(), RemovalRisk::Dirty),
            (!self.unmerged.is_empty(), RemovalRisk::UnreferencedCommits),
            (
                !self.submodule_unpushed.is_empty(),
                RemovalRisk::UnpushedSubmoduleCommits,
            ),
            (self.checkout.locked, RemovalRisk::Locked),
            (self.checkout.prunable, RemovalRisk::Prunable),
            (self.checkout.bare, RemovalRisk::Bare),
        ]
        .into_iter()
        .filter_map(|(present, risk)| present.then_some(risk))
        .collect()
    }
    pub fn safe(&self) -> bool {
        self.risks().is_empty()
    }
    /// Whether removal may proceed: safe, or every risk is accepted and acceptable.
    pub fn allowed(&self, accept_risks: bool) -> bool {
        self.safe() || (accept_risks && self.risks().into_iter().all(RemovalRisk::acceptable))
    }
}
#[derive(Debug)]
pub struct Output {
    pub code: Option<i64>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
#[derive(Debug)]
pub struct WorktreeOutcome {
    pub git: Output,
    pub workspace: Option<Creation>,
}
pub struct Git {
    pub client: Client,
    pub machine: String,
    pub deadline: Duration,
}
impl Git {
    pub async fn exec(&self, argv: Vec<String>, cwd: Option<&str>) -> Result<Output, Error> {
        let params = ExecParams {
            argv,
            cwd: cwd.map(str::to_owned),
            on: on(&self.machine).map(str::to_owned),
            ..Default::default()
        };
        let v = self.client.machine_exec(&params, self.deadline).await?;
        if v.truncated || v.timed_out {
            return Err(Error::Protocol("incomplete machine execution".into()));
        }
        let decode = |field: &str| {
            STANDARD
                .decode(field)
                .map_err(|e| Error::Protocol(e.to_string()))
        };
        Ok(Output {
            code: v.code.map(i64::from),
            stdout: decode(&v.stdout)?,
            stderr: decode(&v.stderr)?,
        })
    }
    pub async fn run(&self, path: &str, args: &[&str]) -> Result<Output, Error> {
        self.exec(
            std::iter::once("git".to_owned())
                .chain(args.iter().map(|s| s.to_string()))
                .collect(),
            Some(path),
        )
        .await
    }
    async fn checked(&self, path: &str, args: &[&str]) -> Result<Vec<u8>, Error> {
        let result = self.run(path, args).await?;
        if result.code != Some(0) {
            return Err(Error::Protocol(
                String::from_utf8_lossy(&result.stderr).into(),
            ));
        }
        Ok(result.stdout)
    }
    pub async fn list(&self, path: &str) -> Result<Vec<Checkout>, Error> {
        parse(
            &self
                .checked(path, &["worktree", "list", "--porcelain", "-z"])
                .await?,
        )
    }
    pub async fn branches(&self, path: &str) -> Result<Vec<String>, Error> {
        let bytes = self
            .checked(
                path,
                &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            )
            .await?;
        Ok(String::from_utf8(bytes)
            .map_err(|e| Error::Protocol(e.to_string()))?
            .lines()
            .map(str::to_owned)
            .collect())
    }
    pub async fn default_path(&self, repository: &str, branch: &str) -> Result<String, Error> {
        self.default_path_in(repository, branch, None).await
    }
    /// `<root>/<repo>/<branch-slug>` as Herdr names checkouts. `directory` is the
    /// configured root (`~` and relative paths start at the target machine's home);
    /// None uses Herdr's `~/.herdr/worktrees`.
    pub async fn default_path_in(
        &self,
        repository: &str,
        branch: &str,
        directory: Option<&str>,
    ) -> Result<String, Error> {
        let root = self.worktree_root(directory).await?;
        let repo = repository
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::Protocol("repository name".into()))?;
        let slug = slug(branch);
        if slug.is_empty() {
            return Err(Error::Protocol("empty branch slug".into()));
        }
        Ok(format!("{}/{repo}/{slug}", root.trim_end_matches('/')))
    }
    /// The checkout root on the target machine.
    pub async fn worktree_root(&self, directory: Option<&str>) -> Result<String, Error> {
        let directory = directory.map(str::trim).filter(|d| !d.is_empty());
        let absolute = |d: &str| {
            d.starts_with('/')
                || d.starts_with('\\')
                || d.get(1..3).is_some_and(|s| s == ":/" || s == ":\\")
        };
        if let Some(directory) = directory.filter(|d| absolute(d)) {
            return Ok(directory.replace('\\', "/"));
        }
        let home = self.home().await?;
        let rest = match directory {
            None => ".herdr/worktrees",
            Some("~") => "",
            Some(d) => d
                .strip_prefix("~/")
                .or_else(|| d.strip_prefix("~\\"))
                .unwrap_or(d),
        };
        Ok(if rest.is_empty() {
            home
        } else {
            format!("{home}/{}", rest.replace('\\', "/"))
        })
    }
    async fn home(&self) -> Result<String, Error> {
        // The physical home, so the stored folder matches the path git reports.
        let result = self
            .exec(
                vec![
                    "sh".into(),
                    "-c".into(),
                    "cd \"$HOME\" && pwd -P | tr -d '\\n'".into(),
                ],
                None,
            )
            .await;
        let result = match result {
            Ok(v) if v.code == Some(0) => v,
            _ => {
                self.exec(
                    vec![
                        "powershell.exe".into(),
                        "-NoProfile".into(),
                        "-Command".into(),
                        "[Console]::Write($HOME)".into(),
                    ],
                    None,
                )
                .await?
            }
        };
        if result.code != Some(0) {
            return Err(Error::Protocol("home unavailable".into()));
        }
        let home = String::from_utf8(result.stdout).map_err(|e| Error::Protocol(e.to_string()))?;
        Ok(home.replace('\\', "/"))
    }
    pub async fn create(
        &self,
        repository: &str,
        path: &str,
        branch: &str,
        new_branch: bool,
    ) -> Result<Output, Error> {
        self.checked(repository, &["check-ref-format", "--branch", branch])
            .await?;
        let args = if new_branch {
            vec!["worktree", "add", "-b", branch, "--", path]
        } else {
            vec!["worktree", "add", "--", path, branch]
        };
        self.run(repository, &args).await
    }
    /// The checkout's top folder as git names it, resolving symlinks in `path`.
    pub async fn toplevel(&self, path: &str) -> Result<String, Error> {
        let top = self
            .checked(path, &["rev-parse", "--show-toplevel"])
            .await?;
        String::from_utf8(top)
            .map(|top| top.trim_end_matches(['\n', '\r']).to_owned())
            .map_err(|e| Error::Protocol(e.to_string()))
    }
    pub async fn assess_remove(&self, repository: &str, path: &str) -> Result<Removal, Error> {
        let list = self.list(repository).await?;
        let resolved = self.toplevel(path).await;
        let path = match &resolved {
            Ok(top) if list.iter().any(|c| &c.path == top) => top.as_str(),
            _ => path,
        };
        if list.first().is_some_and(|c| c.path == path) {
            return Err(Error::Protocol("cannot remove main checkout".into()));
        }
        let checkout = list
            .into_iter()
            .find(|c| c.path == path)
            .ok_or_else(|| Error::Protocol("checkout missing".into()))?;
        let status = self
            .checked(
                path,
                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            )
            .await?;
        // Include unreferenced submodule branches, not only each checked-out HEAD.
        let submodules = self
            .checked(path, &["submodule", "status", "--recursive"])
            .await?;
        let submodule_unpushed = self.submodule_risks(path).await?;
        let unmerged = self
            .checked(
                path,
                &[
                    "rev-list",
                    "HEAD",
                    "--not",
                    "--branches",
                    "--tags",
                    "--remotes",
                ],
            )
            .await?;
        Ok(Removal {
            machine: self.machine.clone(),
            repository: repository.into(),
            checkout,
            status,
            submodules,
            unmerged,
            submodule_unpushed,
        })
    }
    async fn submodule_risks(&self, path: &str) -> Result<Vec<u8>, Error> {
        let gitdir = String::from_utf8(
            self.checked(path, &["rev-parse", "--absolute-git-dir"])
                .await?,
        )
        .map_err(|e| Error::Protocol(e.to_string()))?
        .trim()
        .to_owned();
        let mut pending = vec![(gitdir, Some(format!("{path}/.gitmodules")))];
        let mut risks = Vec::new();
        while let Some((parent, file)) = pending.pop() {
            let mut args = vec!["--git-dir", parent.as_str(), "config", "-z"];
            match &file {
                Some(file) => args.extend(["--file", file.as_str()]),
                None => args.extend(["--blob", "HEAD:.gitmodules"]),
            }
            args.extend(["--get-regexp", "^submodule\\..*\\.path$"]);
            let config = self.run(path, &args).await?;
            if config.code == Some(1) {
                continue;
            }
            if config.code != Some(0) {
                return Err(Error::Protocol(
                    "cannot inspect submodule configuration".into(),
                ));
            }
            let config =
                String::from_utf8(config.stdout).map_err(|e| Error::Protocol(e.to_string()))?;
            for record in config.split('\0').filter(|r| !r.is_empty()) {
                let (key, relative) = record
                    .split_once('\n')
                    .ok_or_else(|| Error::Protocol("submodule configuration".into()))?;
                let name = key
                    .strip_prefix("submodule.")
                    .and_then(|s| s.strip_suffix(".path"))
                    .ok_or_else(|| Error::Protocol("submodule name".into()))?;
                let dir = format!("{parent}/modules/{name}");
                if self
                    .run(path, &["--git-dir", &dir, "rev-parse", "--git-dir"])
                    .await?
                    .code
                    != Some(0)
                {
                    continue;
                }
                let pinned = self
                    .checked(
                        path,
                        &[
                            "--git-dir",
                            &parent,
                            "rev-parse",
                            &format!("HEAD:{relative}"),
                        ],
                    )
                    .await?;
                let pinned =
                    String::from_utf8(pinned).map_err(|e| Error::Protocol(e.to_string()))?;
                let commits = self
                    .checked(
                        path,
                        &[
                            "--git-dir",
                            &dir,
                            "rev-list",
                            "-n1",
                            "--all",
                            "--not",
                            "--remotes",
                            pinned.trim(),
                        ],
                    )
                    .await?;
                if !commits.is_empty() {
                    risks.extend(name.as_bytes());
                    risks.push(0);
                    risks.extend(commits);
                }
                if self
                    .run(
                        path,
                        &["--git-dir", &dir, "cat-file", "-e", "HEAD:.gitmodules"],
                    )
                    .await?
                    .code
                    == Some(0)
                {
                    pending.push((dir, None));
                }
            }
        }
        Ok(risks)
    }
    /// Removes a reviewed checkout. With `accept_risks`, dirty files and unreferenced
    /// commits the person reviewed are deleted too; any change since the review refuses.
    pub async fn remove(&self, assessment: &Removal, accept_risks: bool) -> Result<Output, Error> {
        if assessment.machine != self.machine || !assessment.allowed(accept_risks) {
            return Err(Error::Protocol(
                "removal requires clean checkout without unreferenced commits".into(),
            ));
        }
        let current = self
            .assess_remove(&assessment.repository, &assessment.checkout.path)
            .await?;
        if current != *assessment {
            return Err(Error::Protocol("removal preconditions changed".into()));
        }
        let mut args = vec!["worktree", "remove"];
        // Git refuses dirty checkouts and ones with submodules unless forced.
        if !assessment.submodules.is_empty() || !assessment.status.is_empty() {
            args.push("--force");
        }
        args.extend(["--", &assessment.checkout.path]);
        self.run(&assessment.repository, &args).await
    }
    pub async fn open(
        &self,
        session: &mut Session,
        path: &str,
        placement: Placement,
        correlation: String,
    ) -> Result<Creation, Error> {
        let path = self.toplevel(path).await?;
        session
            .create(
                &self.machine,
                placement,
                Launch {
                    argv: Vec::new(),
                    line: None,
                    cwd: Some(path),
                    env: BTreeMap::new(),
                },
                correlation,
            )
            .await
    }
}
pub fn slug(branch: &str) -> String {
    let mut result = String::new();
    for c in branch.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            result.push(c);
        } else if !result.ends_with('-') {
            result.push('-');
        }
    }
    result.trim_matches('-').into()
}
pub fn parse(bytes: &[u8]) -> Result<Vec<Checkout>, Error> {
    let text = std::str::from_utf8(bytes).map_err(|e| Error::Protocol(e.to_string()))?;
    let mut result = Vec::new();
    let mut current: Option<Checkout> = None;
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(c) = current.take() {
                result.push(c);
            }
            current = Some(Checkout {
                path: path.into(),
                branch: None,
                head: String::new(),
                locked: false,
                prunable: false,
                bare: false,
            });
        } else if let Some(c) = &mut current {
            if let Some(head) = field.strip_prefix("HEAD ") {
                c.head = head.into();
            } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                c.branch = Some(branch.into());
            } else if field.starts_with("locked") {
                c.locked = true;
            } else if field.starts_with("prunable") {
                c.prunable = true;
            } else if field == "bare" {
                c.bare = true;
            }
        }
    }
    if let Some(c) = current {
        result.push(c);
    }
    Ok(result)
}
#[derive(Debug)]
pub struct CreatedSpace {
    pub git: Output,
    pub workspace: Result<Creation, Error>,
}
#[derive(Debug)]
pub struct RemovedSpace {
    pub workspace: crate::commands::CloseOutcome,
    pub git: Option<Result<Output, Error>>,
}
pub struct CreatePlan {
    pub repository: String,
    /// Absolute, or relative to `repository` on the target machine.
    pub path: String,
    pub branch: String,
    pub new_branch: bool,
    pub placement: Placement,
    pub correlation: String,
}
impl Git {
    async fn checkout_path(&self, repository: &str, path: &str) -> Result<String, Error> {
        if path.is_empty() {
            return Err(Error::Protocol("checkout path is required".into()));
        }
        let result = self
            .exec(
                vec![
                    "sh".into(),
                    "-c".into(),
                    "case $(uname -s) in MINGW*|MSYS*|CYGWIN*) exit 1;; esac; case \"$1\" in /*) printf '%s' \"$1\";; *) checkout_base=$(pwd -P) && printf '%s/%s' \"$checkout_base\" \"$1\";; esac".into(),
                    "sh".into(),
                    path.into(),
                ],
                Some(repository),
            )
            .await;
        let result = match result {
            Ok(result) if result.code == Some(0) => result,
            _ => {
                let script = format!(
                    "[Console]::Write([IO.Path]::GetFullPath('{}'))",
                    path.replace('\'', "''")
                );
                self.exec(
                    vec![
                        "powershell.exe".into(),
                        "-NoProfile".into(),
                        "-EncodedCommand".into(),
                        STANDARD.encode(
                            script
                                .encode_utf16()
                                .flat_map(u16::to_le_bytes)
                                .collect::<Vec<_>>(),
                        ),
                    ],
                    Some(repository),
                )
                .await?
            }
        };
        if result.code != Some(0) {
            return Err(Error::Protocol("checkout path unavailable".into()));
        }
        String::from_utf8(result.stdout).map_err(|e| Error::Protocol(e.to_string()))
    }

    pub async fn create_space(
        &self,
        session: &mut Session,
        plan: CreatePlan,
    ) -> Result<CreatedSpace, Error> {
        let mut candidate = session.document(&self.machine)?;
        let path = self.checkout_path(&plan.repository, &plan.path).await?;
        plan.placement
            .apply(&mut candidate, "__pending", &path)
            .map_err(|e| Error::Protocol(e.to_string()))?;
        let git = self
            .create(&plan.repository, &path, &plan.branch, plan.new_branch)
            .await?;
        let workspace = if git.code == Some(0) {
            self.open(session, &path, plan.placement, plan.correlation)
                .await
        } else {
            Err(Error::Protocol("Git operation failed".into()))
        };
        Ok(CreatedSpace { git, workspace })
    }
    pub async fn remove_space(
        &self,
        session: &mut Session,
        removal: &Removal,
        close: crate::commands::CloseAssessment,
        accept_risks: bool,
    ) -> Result<RemovedSpace, Error> {
        if close.machine != self.machine
            || !removal.allowed(accept_risks)
            || *removal
                != self
                    .assess_remove(&removal.repository, &removal.checkout.path)
                    .await?
        {
            return Err(Error::Protocol("removal preconditions changed".into()));
        }
        let document = session.document_ref(&self.machine)?;
        let node = document
            .node(&close.target)
            .ok_or_else(|| Error::Protocol("space missing".into()))?;
        let folder = node["folder"].as_str().unwrap_or_default();
        let same = folder == removal.checkout.path
            || self
                .toplevel(folder)
                .await
                .is_ok_and(|top| top == removal.checkout.path);
        if !same {
            return Err(Error::Protocol(
                "the workspace folder is not this checkout".into(),
            ));
        }
        let workspace = session.close(close).await?;
        let git = if matches!(workspace.layout, crate::sync::WriteOutcome::Written) {
            Some(self.remove(removal, accept_risks).await)
        } else {
            None
        };
        Ok(RemovedSpace { workspace, git })
    }
}
