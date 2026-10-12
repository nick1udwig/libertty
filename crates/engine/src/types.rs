use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ops::{Deref, DerefMut},
    sync::Arc,
};

/// Immutable catalog arrays share storage; edits copy only the changed array.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct SharedList<T>(Arc<Vec<T>>);
impl<T> Default for SharedList<T> {
    fn default() -> Self {
        Self(Arc::new(Vec::new()))
    }
}
impl<T> From<Vec<T>> for SharedList<T> {
    fn from(values: Vec<T>) -> Self {
        Self(Arc::new(values))
    }
}
impl<T> From<Arc<Vec<T>>> for SharedList<T> {
    fn from(values: Arc<Vec<T>>) -> Self {
        Self(values)
    }
}
impl<T> FromIterator<T> for SharedList<T> {
    fn from_iter<I: IntoIterator<Item = T>>(values: I) -> Self {
        Vec::from_iter(values).into()
    }
}
impl<T> Deref for SharedList<T> {
    type Target = Vec<T>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl<T: Clone> DerefMut for SharedList<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::make_mut(&mut self.0)
    }
}
impl<'a, T> IntoIterator for &'a SharedList<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
impl<T> SharedList<T> {
    pub fn shares_storage(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
#[cfg(test)]
mod shared_list_tests {
    use super::*;
    #[test]
    fn immutable_clones_share_storage_and_edits_leave_snapshots_unchanged() {
        let original: SharedList<String> = vec!["git".into()].into();
        let mut edited = original.clone();
        assert!(original.shares_storage(&edited));
        edited.push("ls".into());
        assert!(!original.shares_storage(&edited));
        assert_eq!(original.as_slice(), ["git"]);
        assert_eq!(edited.as_slice(), ["git", "ls"]);
        assert_eq!(
            serde_json::to_value(&edited).unwrap(),
            serde_json::json!(["git", "ls"])
        );
    }
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    pub name: String,
    pub takes_value: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub optional_value: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub cwd: String,
    pub commands: SharedList<String>,
    pub paths: SharedList<String>,
    pub history: SharedList<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub functions: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub history_cwds: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
    pub command: String,
    pub score: f64,
    pub changes: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub literal: Option<bool>,
}
impl Candidate {
    pub fn literal(input: &str) -> Self {
        Self {
            command: input.trim().into(),
            score: 0.0,
            changes: vec![],
            literal: Some(true),
        }
    }
    pub fn is_literal(&self) -> bool {
        self.literal == Some(true)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandMetadata {
    #[serde(default)]
    pub flags: BTreeMap<String, Vec<Flag>>,
    #[serde(default)]
    pub subcommands: BTreeMap<String, Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub required_positionals: Option<BTreeMap<String, usize>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub argument_values: Option<BTreeMap<String, Vec<String>>>,
}

impl CommandMetadata {
    pub fn empty() -> Self {
        Self {
            required_positionals: Some(BTreeMap::new()),
            ..Self::default()
        }
    }
    pub fn merge(&mut self, other: Self) {
        self.flags.extend(other.flags);
        self.subcommands.extend(other.subcommands);
        self.required_positionals
            .get_or_insert_with(BTreeMap::new)
            .extend(other.required_positionals.unwrap_or_default());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Help {
    pub flags: Vec<Flag>,
    pub subcommands: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub required: Option<usize>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub safe_subcommands: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub probe_subcommands: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub aliases: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Token {
    pub value: String,
    pub quoted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Word {
    pub value: String,
    pub home: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Match {
    pub value: String,
    pub consumed: usize,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileInfo {
    pub file: bool,
    pub directory: bool,
    pub executable: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub spelling: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectoryEntry {
    pub name: String,
    pub directory: bool,
    pub symlink: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectorySnapshot {
    pub version: String,
    pub entries: SharedList<DirectoryEntry>,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DirectoryLookup {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub info: Option<FileInfo>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub listing: Option<DirectorySnapshot>,
}
