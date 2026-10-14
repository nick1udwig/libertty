use serde::Deserialize;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    DeleteWorktree {
        workspace_id: String,
        path: Option<String>,
        #[serde(default)]
        force: bool,
    },
    ListWorktrees {
        workspace_id: String,
    },
    NewWorktree {
        workspace_id: String,
        branch: String,
    },
    OpenWorktree {
        workspace_id: String,
        path: String,
    },
    Split {
        workspace_id: String,
        terminal_id: String,
        direction: Direction,
    },
    CreateSpace {
        workspace_id: Option<String>,
        terminal_id: Option<String>,
    },
    MoveSpace {
        workspace_id: String,
        before_workspace_id: Option<String>,
    },
    Create {
        workspace_id: String,
        name: String,
        kind: String,
        cwd: Option<String>,
    },
    RenameSpace {
        workspace_id: String,
        name: String,
    },
    CloseSpace {
        workspace_id: String,
    },
    Rename {
        terminal_id: String,
        name: String,
    },
    Close {
        terminal_id: String,
    },
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Right,
    Down,
}
impl Action {
    pub fn workspace(&self) -> Option<&str> {
        match self {
            Self::DeleteWorktree { workspace_id, .. }
            | Self::ListWorktrees { workspace_id }
            | Self::NewWorktree { workspace_id, .. }
            | Self::OpenWorktree { workspace_id, .. }
            | Self::Split { workspace_id, .. }
            | Self::MoveSpace { workspace_id, .. }
            | Self::Create { workspace_id, .. }
            | Self::RenameSpace { workspace_id, .. }
            | Self::CloseSpace { workspace_id } => Some(workspace_id),
            Self::CreateSpace { workspace_id, .. } => workspace_id.as_deref(),
            _ => None,
        }
    }
}
