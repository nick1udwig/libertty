use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub fn packaged_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let root = executable.parent()?.parent()?;
    (root.join("release.json").is_file() && root.join("dist").is_dir()).then(|| root.to_owned())
}
pub fn metadata() -> Option<Value> {
    let root = packaged_root()?;
    let value: Value =
        serde_json::from_slice(&std::fs::read(root.join("release.json")).ok()?).ok()?;
    let commit = value["commit"].as_str()?;
    if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if value["version"].as_str()? != env!("CARGO_PKG_VERSION") {
        return None;
    }
    Some(value)
}
pub fn configuration(file: &Path) -> Result<BTreeMap<String, String>, String> {
    let value: Value = serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let env = value["env"]
        .as_object()
        .ok_or("Invalid service environment.")?;
    env.iter()
        .map(|(name, value)| {
            let valid_name = !name.is_empty()
                && name.bytes().enumerate().all(|(i, b)| {
                    b == b'_' || b.is_ascii_uppercase() || (i > 0 && b.is_ascii_digit())
                });
            let value = value.as_str().filter(|v| !v.contains('\0'));
            if !valid_name || value.is_none() {
                return Err(format!("Invalid service environment setting: {name}"));
            }
            Ok((name.clone(), value.unwrap().to_owned()))
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_rejects_invalid_environment_and_preserves_values() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        std::fs::write(&file, r#"{"env":{"TERMAI_CWD":"/home with spaces","PORT":"7321","_CUSTOM2":"","PATH":"/bin"},"unknown":true}"#).unwrap();
        let env = configuration(&file).unwrap();
        assert_eq!(env["TERMAI_CWD"], "/home with spaces");
        assert_eq!(env["_CUSTOM2"], "");
        for raw in [
            r#"{"env":{"lowercase":"x"}}"#,
            r#"{"env":{"1INVALID":"x"}}"#,
            r#"{"env":{"VALID":1}}"#,
            r#"{"env":{"VALID":"bad\u0000value"}}"#,
            "{}",
        ] {
            std::fs::write(&file, raw).unwrap();
            assert!(configuration(&file).is_err(), "{raw}");
        }
    }
}
