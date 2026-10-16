use libertty_server::vault::{KeyReference, Vault, inspect_private_key};
use rand::rngs::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};
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
fn persisted_data_writes_preserve_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Vault::new(directory.path());
    let key = vault
        .create("original", "synthetic-passphrase", Some(&raw_key()), None)
        .unwrap();
    vault
        .trust("fixture.example", 22, "SHA256:synthetic-host-pin")
        .unwrap();
    let file = directory.path().join("vault.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    data["futureField"] = serde_json::json!("retained");
    data["keys"][0]["futureKeyField"] = serde_json::json!({"retained":true});
    data["knownHosts"][0]["futureHostField"] = serde_json::json!({"retained":true});
    fs::write(&file, serde_json::to_vec(&data).unwrap()).unwrap();
    let restarted = Vault::new(directory.path());
    restarted.rename(&key.id, "renamed").unwrap();
    assert!(
        !restarted
            .unlock(&key.id, "synthetic-passphrase")
            .unwrap()
            .is_empty()
    );
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["keys"][0]["name"], "renamed");
    assert_eq!(saved["futureField"], "retained");
    assert_eq!(
        saved["keys"][0]["futureKeyField"],
        serde_json::json!({"retained":true})
    );
    assert_eq!(
        saved["knownHosts"][0]["futureHostField"],
        serde_json::json!({"retained":true})
    );
}
