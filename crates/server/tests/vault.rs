use rand::rngs::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};
use termai_server::vault::{KeyReference, Vault, inspect_private_key};
fn raw_key() -> String {
    PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
        .unwrap()
        .to_openssh(LineEnding::LF)
        .unwrap()
        .to_string()
}

#[test]
fn keychain_encrypts_keys_and_survives_restarts_without_exposing_private_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Vault::new(directory.path());
    assert!(vault.create("empty password", "", None, None).is_err());
    let short = vault.create("short", "x", None, None).unwrap();
    assert!(!vault.unlock(&short.id, "x").unwrap().is_empty());
    vault.remove(&short.id).unwrap();
    let key = vault
        .create("personal", "correct-passphrase", None, None)
        .unwrap();
    assert!(key.public_key.starts_with("ssh-ed25519 "));
    let metadata = serde_json::to_value(&key).unwrap();
    assert_eq!(metadata.as_object().unwrap().len(), 5);
    let disk = fs::read_to_string(directory.path().join("vault.json")).unwrap();
    assert!(!disk.contains("PRIVATE KEY"));
    assert!(!disk.contains("correct-passphrase"));
    assert_eq!(
        fs::metadata(directory.path().join("vault.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let restarted = Vault::new(directory.path());
    assert!(
        restarted
            .unlock(&key.id, "wrong-password")
            .unwrap_err()
            .to_string()
            .contains("Incorrect")
    );
    let unlocked = restarted.unlock(&key.id, "correct-passphrase").unwrap();
    assert!(PrivateKey::from_openssh(&*unlocked).is_ok());
    drop(unlocked);
    restarted.rename(&key.id, "renamed").unwrap();
    assert_eq!(restarted.list().unwrap().keys[0].name, "renamed");
    restarted.remove(&key.id).unwrap();
    assert!(restarted.list().unwrap().keys.is_empty());
}

#[test]
fn pins_and_serialized_concurrent_changes_are_retained() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Arc::new(Vault::new(directory.path()));
    std::thread::scope(|scope| {
        for (host, port, pin) in [("one", 22, "SHA256:first"), ("two", 2222, "SHA256:second")] {
            let vault = vault.clone();
            scope.spawn(move || vault.trust(host, port, pin).unwrap());
        }
    });
    assert_eq!(vault.list().unwrap().known_hosts.len(), 2);
    assert!(
        vault
            .trust("one", 22, "SHA256:changed")
            .unwrap_err()
            .to_string()
            .contains("Host key changed")
    );
    vault.forget("one", 22).unwrap();
    vault.trust("one", 22, "SHA256:changed").unwrap();
    assert_eq!(
        vault
            .list()
            .unwrap()
            .known_hosts
            .iter()
            .find(|host| host.host == "one")
            .unwrap()
            .fingerprint,
        "SHA256:changed"
    );
}

#[test]
fn backups_and_references_preserve_identity_and_inspection_does_not_persist() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Vault::new(directory.path());
    let raw = raw_key();
    let info = inspect_private_key(&raw, "x").unwrap();
    assert!(info.fingerprint.starts_with("SHA256:"));
    assert!(vault.list().unwrap().keys.is_empty());
    let first = vault.create("backup", "x", Some(&raw), None).unwrap();
    let refreshed = vault
        .create("renamed backup", "y", Some(&raw), Some(&first.id))
        .unwrap();
    assert_eq!(refreshed.id, first.id);
    assert_eq!(vault.list().unwrap().keys.len(), 1);
    assert!(vault.unlock(&first.id, "x").is_err());
    assert_eq!(&*vault.unlock(&first.id, "y").unwrap(), raw.as_bytes());
    assert!(
        vault
            .create("wrong identity", "x", Some(&raw_key()), Some(&first.id))
            .unwrap_err()
            .to_string()
            .contains("different SSH key")
    );
    let reference = KeyReference {
        kind: "agent".into(),
        path: "/fixture/key".into(),
    };
    let referenced = vault
        .reference(
            "external",
            &info.public_key,
            &info.fingerprint,
            reference.clone(),
        )
        .unwrap();
    assert_eq!(
        vault
            .reference("same", &info.public_key, &info.fingerprint, reference)
            .unwrap()
            .id,
        referenced.id
    );
    assert!(vault.unlock(&referenced.id, "x").is_err());
    assert!(
        vault
            .create("overwrite", "x", Some(&raw), Some(&referenced.id))
            .is_err()
    );
    assert!(
        vault
            .reference(
                "relative",
                &info.public_key,
                &info.fingerprint,
                KeyReference {
                    kind: "file".into(),
                    path: "relative".into()
                }
            )
            .is_err()
    );
}

#[test]
fn existing_typescript_vault_and_pairings_are_readable_and_writes_preserve_unknown_fields() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-migration/state.json"
    ))
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut data = fixture["vault"]["data"].clone();
    data["futureField"] = serde_json::json!("retained");
    data["knownHosts"][0]["futureHostField"] = serde_json::json!({"retained":true});
    fs::write(
        directory.path().join("vault.json"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
    let vault = Vault::new(directory.path());
    assert_eq!(serde_json::to_value(vault.list().unwrap()).unwrap(), {
        let mut listed = fixture["vault"]["listed"].clone();
        listed["knownHosts"][0]["futureHostField"] = serde_json::json!({"retained":true});
        listed
    });
    for case in fixture["vault"]["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let passphrase = case["passphrase"].as_str().unwrap();
        let raw = case["privateKey"].as_str().unwrap();
        assert_eq!(&*vault.unlock(id, passphrase).unwrap(), raw.as_bytes());
        assert!(vault.unlock(id, "wrong-password").is_err());
        let info = inspect_private_key(raw, passphrase).unwrap();
        assert_eq!(info.public_key, case["publicKey"]);
        assert_eq!(info.fingerprint, case["fingerprint"]);
        assert!(inspect_private_key(raw, "").is_err());
        if raw.contains("PRIVATE KEY") && passphrase.ends_with("true") {
            assert!(inspect_private_key(raw, "wrong-password").is_err());
        }
        vault
            .create("refresh", passphrase, Some(raw), Some(id))
            .unwrap();
        assert_eq!(&*vault.unlock(id, passphrase).unwrap(), raw.as_bytes());
    }
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("vault.json")).unwrap()).unwrap();
    assert_eq!(saved["futureField"], "retained");
    assert_eq!(
        saved["knownHosts"][0]["futureHostField"],
        serde_json::json!({"retained":true})
    );
    fs::write(
        directory.path().join("paired-clients.json"),
        serde_json::to_vec(&fixture["pairing"]["data"]).unwrap(),
    )
    .unwrap();
    let registry = termai_server::pairing::Pairings::open(
        directory.path(),
        fixture["pairing"]["token"].as_str().unwrap(),
    )
    .unwrap();
    assert!(registry.has(fixture["pairing"]["credential"].as_str().unwrap()));
}
