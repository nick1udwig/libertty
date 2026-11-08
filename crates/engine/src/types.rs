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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(optional_fields))]
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
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<ValueSchema>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    #[default]
    Text,
    Path,
    Directory,
    InputFile,
    OutputPath,
    Choice,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ValueSchema {
    pub minimum: usize,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub maximum: Option<usize>,
    pub kind: ValueKind,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub choices: Option<Vec<String>>,
}
impl Flag {
    pub fn value_bounds(&self) -> (usize, Option<usize>) {
        self.value
            .as_ref()
            .map(|value| (value.minimum, value.maximum))
            .unwrap_or((
                usize::from(self.takes_value),
                Some(usize::from(self.takes_value)),
            ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub cwd: String,
    #[cfg_attr(feature = "ts", ts(as = "Vec<String>"))]
    pub commands: SharedList<String>,
    #[cfg_attr(feature = "ts", ts(as = "Vec<String>"))]
    pub paths: SharedList<String>,
    #[cfg_attr(feature = "ts", ts(as = "Vec<String>"))]
    pub history: SharedList<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<Vec<String>>"))]
    pub functions: Option<SharedList<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub history_cwds: Option<Arc<BTreeMap<String, String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(optional_fields))]
pub struct Candidate {
    pub command: String,
    pub score: f64,
    /// User-facing explanations of each change.
    #[cfg_attr(feature = "ts", ts(type = "string[]"))]
    pub changes: Vec<Change>,
    #[serde(skip)]
    pub evidence: Evidence,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub literal: Option<bool>,
}
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum CandidateSource {
    Literal,
    #[default]
    Repair,
    History,
    Path,
    Compound,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    pub source: CandidateSource,
    pub confidence: f64,
    pub validated: bool,
    pub resolved: bool,
    pub unresolved: usize,
}
impl Default for Evidence {
    fn default() -> Self {
        Self {
            source: CandidateSource::Repair,
            confidence: 100.0,
            validated: false,
            resolved: true,
            unresolved: 0,
        }
    }
}
impl Evidence {
    pub fn new(source: CandidateSource, confidence: f64) -> Self {
        Self {
            source,
            confidence: confidence.clamp(0.0, 100.0),
            validated: false,
            resolved: source != CandidateSource::Literal,
            unresolved: 0,
        }
    }
    pub fn compound(&self, other: &Self) -> Self {
        Self {
            source: CandidateSource::Compound,
            confidence: self.confidence.min(other.confidence),
            validated: false,
            resolved: self.resolved && other.resolved,
            unresolved: self.unresolved.saturating_add(other.unresolved),
        }
    }

    pub fn penalize(&mut self, amount: f64) {
        self.confidence = (self.confidence - amount.max(0.0)).clamp(0.0, 100.0);
    }
}
/// Semantic change kinds serialize to the existing user-facing explanation strings.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Command(String),
    Subcommand(String),
    Flag(String),
    File(String),
    Completion(String),
    History,
    Symbols,
    SymbolAlternative,
    Separator,
    Pipeline,
    SentencePunctuation,
    Boundary,
    VerifiedFile,
    VerifiedDirectory,
    Other(String),
}
impl std::fmt::Display for Change {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Command(value) => write!(f, "Command → {value}"),
            Self::Subcommand(value) => write!(f, "Subcommand → {value}"),
            Self::Flag(value) => write!(f, "Flag → {value}"),
            Self::File(value) => write!(f, "File → {value}"),
            Self::Completion(value) => write!(f, "Completion → {value}"),
            Self::History => f.write_str("Matches shell history"),
            Self::Symbols => f.write_str("Spoken symbols"),
            Self::SymbolAlternative => f.write_str("Spoken symbol alternative"),
            Self::Separator => f.write_str("Spoken command separator"),
            Self::Pipeline => f.write_str("Pipeline commands"),
            Self::SentencePunctuation => f.write_str("Remove dictation sentence punctuation"),
            Self::Boundary => f.write_str("Restore command/flag boundary"),
            Self::VerifiedFile => f.write_str("File path verified against the filesystem"),
            Self::VerifiedDirectory => f.write_str("Path verified against existing directories"),
            Self::Other(text) => f.write_str(text),
        }
    }
}
impl Serialize for Change {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for Change {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::from)
    }
}
impl From<String> for Change {
    fn from(text: String) -> Self {
        for (prefix, make) in [
            ("Command → ", Self::Command as fn(String) -> Self),
            ("Subcommand → ", Self::Subcommand),
            ("Flag → ", Self::Flag),
            ("File → ", Self::File),
            ("Completion → ", Self::Completion),
        ] {
            if let Some(value) = text.strip_prefix(prefix) {
                return make(value.into());
            }
        }
        match text.as_str() {
            "Matches shell history" => Self::History,
            "Spoken symbols" => Self::Symbols,
            "Spoken symbol alternative" => Self::SymbolAlternative,
            "Spoken command separator" => Self::Separator,
            "Pipeline commands" => Self::Pipeline,
            "Remove dictation sentence punctuation" => Self::SentencePunctuation,
            "Restore command/flag boundary" => Self::Boundary,
            "File path verified against the filesystem" => Self::VerifiedFile,
            "Path verified against existing directories" => Self::VerifiedDirectory,
            _ => Self::Other(text),
        }
    }
}
impl From<&str> for Change {
    fn from(text: &str) -> Self {
        Self::from(text.to_owned())
    }
}
impl Candidate {
    pub fn literal(input: &str) -> Self {
        Self {
            command: input.trim().into(),
            score: 0.0,
            changes: vec![],
            evidence: Evidence::new(CandidateSource::Literal, 0.0),
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
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub versions: Option<BTreeMap<String, String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub schemas: Option<BTreeMap<String, SchemaState>>,
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SchemaState {
    Complete,
    Partial,
    Unavailable,
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
        self.versions
            .get_or_insert_with(BTreeMap::new)
            .extend(other.versions.unwrap_or_default());
        self.schemas
            .get_or_insert_with(BTreeMap::new)
            .extend(other.schemas.unwrap_or_default());
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
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub version: Option<String>,
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

#[cfg(test)]
mod evidence_tests {
    use super::*;

    #[test]
    fn compound_evidence_preserves_uncertainty_and_requires_its_own_validation() {
        let left = Evidence {
            source: CandidateSource::History,
            confidence: 90.0,
            validated: true,
            resolved: false,
            unresolved: 2,
        };
        let right = Evidence {
            confidence: 80.0,
            validated: true,
            unresolved: 1,
            ..Evidence::default()
        };
        let combined = left.compound(&right);
        assert_eq!(
            combined,
            Evidence {
                source: CandidateSource::Compound,
                confidence: 80.0,
                validated: false,
                resolved: false,
                unresolved: 3,
            }
        );
        assert_eq!(combined, right.compound(&left));
        assert!(
            !Evidence::new(CandidateSource::Literal, 100.0)
                .compound(&right)
                .resolved
        );
    }

    #[test]
    fn compound_grouping_preserves_evidence_and_unresolved_counts_do_not_overflow() {
        let a = Evidence {
            confidence: 70.0,
            unresolved: 1,
            ..Evidence::default()
        };
        let b = Evidence {
            confidence: 90.0,
            resolved: false,
            unresolved: 2,
            ..Evidence::default()
        };
        let c = Evidence {
            confidence: 80.0,
            unresolved: usize::MAX,
            ..Evidence::default()
        };
        assert_eq!(a.compound(&b).compound(&c), a.compound(&b.compound(&c)));
        assert_eq!(a.compound(&c).unresolved, usize::MAX);
    }

    #[test]
    fn penalties_reduce_only_confidence_within_its_bounds() {
        let mut evidence = Evidence {
            source: CandidateSource::Path,
            confidence: 80.0,
            validated: true,
            resolved: false,
            unresolved: 2,
        };
        let original = evidence.clone();
        evidence.penalize(12.0);
        assert_eq!(
            evidence,
            Evidence {
                confidence: 68.0,
                ..original.clone()
            }
        );
        evidence.penalize(-10.0);
        assert_eq!(evidence.confidence, 68.0);
        evidence.penalize(1000.0);
        assert_eq!(
            evidence,
            Evidence {
                confidence: 0.0,
                ..original
            }
        );
    }
}
