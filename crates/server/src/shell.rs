use std::{collections::BTreeMap, path::Path};

pub fn local_bash(env: &BTreeMap<String, String>) -> Result<String, String> {
    if let Some(bash) = env.get("TERMAI_BASH").filter(|v| !v.is_empty()) {
        if !Path::new(bash).is_absolute() {
            return Err("TERMAI_BASH must be an absolute path to Bash 4.4 or newer.".into());
        }
        return Ok(bash.clone());
    }
    if cfg!(target_os = "macos") {
        for candidate in ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"] {
            if Path::new(candidate).exists() {
                return Ok(candidate.into());
            }
        }
        return Err(
            "Install modern Bash with brew install bash, or set TERMAI_BASH to Bash 4.4 or newer."
                .into(),
        );
    }
    Ok("/bin/bash".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_modern_bash_is_absolute_and_does_not_replace_system_bash() {
        assert_eq!(
            local_bash(&BTreeMap::from([(
                "TERMAI_BASH".into(),
                "/opt/homebrew/bin/bash".into()
            )]))
            .unwrap(),
            "/opt/homebrew/bin/bash"
        );
        assert!(
            local_bash(&BTreeMap::from([("TERMAI_BASH".into(), "bash".into())]))
                .unwrap_err()
                .contains("absolute path")
        );
        if cfg!(target_os = "linux") {
            assert_eq!(local_bash(&BTreeMap::new()).unwrap(), "/bin/bash");
        }
    }
}
