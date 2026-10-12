use std::{fs, os::unix::fs::PermissionsExt};
use termai_server::pairing::{Pairings, pairing_token, token_matches};

#[test]
fn private_tokens_are_reused_and_invalid_configuration_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("data");
    let token = pairing_token(&directory, None).unwrap();
    assert_eq!(token.len(), 64);
    assert_eq!(
        fs::metadata(directory.join("pairing-token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(pairing_token(&directory, Some("")).unwrap(), token);
    assert_eq!(pairing_token(&directory, None).unwrap(), token);
    assert_eq!(
        pairing_token(&directory, Some("explicit-pairing-token-123456789")).unwrap(),
        "explicit-pairing-token-123456789"
    );
    assert_eq!(pairing_token(&directory, None).unwrap(), token);
    for bad in [
        "short",
        "                        ",
        "123456789012345678901234\n",
    ] {
        assert!(pairing_token(&directory, Some(bad)).is_err());
    }
    fs::write(directory.join("pairing-token"), "").unwrap();
    assert!(pairing_token(&directory, None).is_err());
    assert!(token_matches("same", "same"));
    assert!(!token_matches("same", "different"));
}

#[test]
fn credentials_survive_restarts_and_rotation_irrevocably_revokes_them() {
    let directory = tempfile::tempdir().unwrap();
    let code = "original-pairing-code-123456789";
    let mut registry = Pairings::open(directory.path(), code).unwrap();
    let first = registry.issue().unwrap();
    let second = registry.issue().unwrap();
    assert_ne!(first, second);
    let restored = Pairings::open(directory.path(), code).unwrap();
    assert!(restored.has(&first));
    assert!(restored.has(&second));
    assert!(!restored.has(&"0".repeat(64)));
    assert!(!restored.has(code));
    let disk = fs::read_to_string(directory.path().join("paired-clients.json")).unwrap();
    assert!(!disk.contains(&first));
    assert!(!disk.contains(&second));
    assert!(!disk.contains(code));
    let stored: serde_json::Value = serde_json::from_str(&disk).unwrap();
    for hash in stored["credentials"].as_array().unwrap() {
        assert!(!restored.has(hash.as_str().unwrap()));
    }
    assert_eq!(
        fs::metadata(directory.path().join("paired-clients.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(
        !Pairings::open(&directory.path().join("other"), code)
            .unwrap()
            .has(&first)
    );
    assert!(
        !Pairings::open(directory.path(), "replacement-pairing-code-123456789")
            .unwrap()
            .has(&first)
    );
    assert!(!Pairings::open(directory.path(), code).unwrap().has(&first));
    fs::write(directory.path().join("paired-clients.json"), "{}").unwrap();
    assert!(Pairings::open(directory.path(), code).is_err());
}

#[test]
fn reference_pairings_and_limit_are_compatible() {
    use termai_server::pairing::digest;
    let directory = tempfile::tempdir().unwrap();
    let code = "synthetic-reference-pairing-code";
    let credential = "1".repeat(64);
    let reference = serde_json::json!({"version":1,"tokenHash":digest(code),"credentials":[digest(&credential)],"futureField":"ignored"});
    fs::write(
        directory.path().join("paired-clients.json"),
        reference.to_string(),
    )
    .unwrap();
    let mut registry = Pairings::open(directory.path(), code).unwrap();
    assert!(registry.has(&credential));
    registry.issue().unwrap();
    let stored: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("paired-clients.json")).unwrap())
            .unwrap();
    assert_eq!(stored["version"], 1);
    assert_eq!(stored["tokenHash"], digest(code));
    let full = serde_json::json!({"version":1,"tokenHash":digest(code),"credentials":(0..256).map(|i|digest(&i.to_string())).collect::<Vec<_>>()});
    fs::write(
        directory.path().join("paired-clients.json"),
        full.to_string(),
    )
    .unwrap();
    assert!(
        Pairings::open(directory.path(), code)
            .unwrap()
            .issue()
            .is_err()
    );
}
