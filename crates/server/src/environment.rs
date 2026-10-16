use std::{collections::BTreeMap, env::VarError, ffi::OsString, path::PathBuf};

pub fn var_os(name: &str) -> Option<OsString> {
    std::env::var_os(name).or_else(|| {
        name.strip_prefix("LIBERTTY_")
            .and_then(|suffix| std::env::var_os(format!("TERMAI_{suffix}")))
    })
}

pub fn var(name: &str) -> Result<String, VarError> {
    var_os(name)
        .ok_or(VarError::NotPresent)?
        .into_string()
        .map_err(VarError::NotUnicode)
}

pub fn normalize(mut environment: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let legacy: Vec<_> = environment
        .iter()
        .filter_map(|(name, value)| {
            name.strip_prefix("TERMAI_")
                .map(|suffix| (format!("LIBERTTY_{suffix}"), value.clone()))
        })
        .collect();
    for (name, value) in legacy {
        environment.entry(name).or_insert(value);
    }
    environment
}

pub fn vars() -> std::collections::btree_map::IntoIter<String, String> {
    normalize(std::env::vars().collect()).into_iter()
}

pub fn data_directory(home: &str) -> PathBuf {
    let root = PathBuf::from(home).join(".local/share");
    let current = root.join("libertty");
    let legacy = root.join("termai");
    if !current.exists() && legacy.is_dir() {
        legacy
    } else {
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_settings_override_legacy_aliases() {
        let values = normalize(BTreeMap::from([
            ("TERMAI_CWD".into(), "/old".into()),
            ("LIBERTTY_CWD".into(), "/new".into()),
            ("TERMAI_TOKEN".into(), "saved-pairing-token".into()),
        ]));
        assert_eq!(values["LIBERTTY_CWD"], "/new");
        assert_eq!(values["LIBERTTY_TOKEN"], "saved-pairing-token");
    }

    #[test]
    fn existing_data_remains_available_and_new_installs_use_libertty() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".local/share");
        let home = home.path().to_str().unwrap();
        assert_eq!(data_directory(home), root.join("libertty"));
        std::fs::create_dir_all(root.join("termai")).unwrap();
        assert_eq!(data_directory(home), root.join("termai"));
        std::fs::create_dir(root.join("libertty")).unwrap();
        assert_eq!(data_directory(home), root.join("libertty"));
    }
}
