use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use termai_server::{system_ssh, vault};
use tokio_util::sync::CancellationToken;

#[test]
fn addresses_reject_shell_controls_and_invalid_ports() {
    let address =
        system_ssh::address(&json!({"host":" ::1 ","username":" nick ","port":22.0})).unwrap();
    assert_eq!(
        (address.host, address.username, address.port),
        ("::1".into(), "nick".into(), 22)
    );
    for value in [
        json!({"host":"host; touch /tmp/no","username":"nick"}),
        json!({"host":"host","username":"nick","port":0}),
        json!({"host":"host","username":"nick","port":22.5}),
        json!({"host":"host","username":"bad\nname"}),
        json!({"host":"host","username":"nick","port":"22"}),
    ] {
        assert!(system_ssh::address(&value).is_err());
    }
}
#[tokio::test]
async fn config_resolution_external_references_and_locked_keys_preserve_identity() {
    let directory = tempfile::tempdir().unwrap();
    let dir = directory.path().to_string_lossy().into_owned();
    let private =
        ssh_key::PrivateKey::random(&mut rand::rngs::OsRng, ssh_key::Algorithm::Ed25519).unwrap();
    let raw = private.to_openssh(ssh_key::LineEnding::LF).unwrap();
    let public = private.public_key().to_openssh().unwrap();
    let identity = format!("{dir}/identity");
    tokio::fs::write(&identity, raw.as_bytes()).await.unwrap();
    let config = format!("{dir}/config");
    tokio::fs::write(&config,format!("Host fixture\n HostName 127.0.0.1\n User example\n Port 2222\n IdentityFile {identity}\n IdentitiesOnly yes\n IdentityAgent none\n UserKnownHostsFile {dir}/known\n GlobalKnownHostsFile /dev/null\n")).await.unwrap();
    let env = std::env::vars().collect();
    let cancel = CancellationToken::new();
    let info = system_ssh::resolve(
        &format!("ssh -F {config} fixture"),
        &env,
        &dir,
        None,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(info.address.host, "127.0.0.1");
    assert_eq!(info.address.port, 2222);
    assert_eq!(info.address.username, "example");
    assert_eq!(info.identities.len(), 1);
    assert_eq!(info.identities[0].public_key, public);
    let vault = vault::Vault::new(&directory.path().join("vault"));
    let key = &info.identities[0];
    let first = vault
        .reference(
            "Fixture key",
            &key.public_key,
            &key.fingerprint,
            key.reference.clone(),
        )
        .unwrap();
    assert_eq!(
        vault
            .reference(
                "Same key",
                &key.public_key,
                &key.fingerprint,
                key.reference.clone()
            )
            .unwrap()
            .id,
        first.id
    );
    let bytes = tokio::fs::read_to_string(directory.path().join("vault/vault.json"))
        .await
        .unwrap();
    assert!(bytes.contains(&identity));
    assert!(!bytes.contains("PRIVATE KEY"));
    assert!(!bytes.contains("ciphertext"));
    assert!(
        vault
            .unlock(&first.id, "irrelevant")
            .unwrap_err()
            .to_string()
            .contains("external reference")
    );
    vault.remove(&first.id).unwrap();
    assert_eq!(
        tokio::fs::read_to_string(&identity).await.unwrap(),
        raw.as_str()
    );
    for setting in [
        "ProxyJump jump.example",
        "LocalForward 8080 localhost:80",
        "ForwardAgent yes",
        "RemoteCommand uptime",
        "CertificateFile /tmp/certificate",
        "ControlPath /tmp/control",
        "UserKnownHostsFile \"/tmp/known hosts\"",
    ] {
        let file = format!("{dir}/native-config");
        tokio::fs::write(&file, format!("Host *\n {setting}\n"))
            .await
            .unwrap();
        assert!(
            system_ssh::resolve(&format!("ssh -F {file} target"), &env, &dir, None, &cancel)
                .await
                .err()
                .unwrap()
                .native,
            "{setting}"
        );
    }
    let passphrase = "synthetic-passphrase";
    let encrypted = private.encrypt(&mut rand::rngs::OsRng, passphrase).unwrap();
    tokio::fs::write(
        &identity,
        encrypted
            .to_openssh(ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .await
    .unwrap();
    tokio::fs::write(identity.clone() + ".pub", &public)
        .await
        .unwrap();
    let info = system_ssh::resolve(
        &format!("ssh -F {config} fixture"),
        &env,
        &dir,
        None,
        &cancel,
    )
    .await
    .unwrap();
    assert!(info.locked);
    assert!(info.identities.is_empty());
    assert!(
        system_ssh::read_identity(&identity, Some(passphrase))
            .await
            .unwrap()
            .is_some()
    );
}
#[tokio::test]
async fn configured_agent_keys_keep_preference_and_agent_order() {
    let directory = tempfile::tempdir().unwrap();
    let dir = directory.path().to_string_lossy().into_owned();
    let socket = format!("{dir}/agent.sock");
    let mut agent = tokio::process::Command::new("/usr/bin/ssh-agent")
        .args(["-D", "-a", &socket])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if tokio::fs::metadata(&socket).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let mut public = Vec::new();
    for name in ["other", "configured"] {
        let key = ssh_key::PrivateKey::random(&mut rand::rngs::OsRng, ssh_key::Algorithm::Ed25519)
            .unwrap();
        let path = format!("{dir}/{name}");
        tokio::fs::write(
            &path,
            key.to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes(),
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .unwrap();
        public.push(key.public_key().to_openssh().unwrap());
    }
    let status = tokio::process::Command::new("/usr/bin/ssh-add")
        .args([format!("{dir}/other"), format!("{dir}/configured")])
        .env("SSH_AUTH_SOCK", &socket)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let config = format!("{dir}/config");
    tokio::fs::write(&config,format!("Host *\n IdentityFile {dir}/configured\n IdentityAgent {socket}\n IdentitiesOnly no\n UserKnownHostsFile /dev/null\n GlobalKnownHostsFile /dev/null\n")).await.unwrap();
    let mut env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    env.insert("SSH_AUTH_SOCK".into(), socket);
    let result = system_ssh::resolve(
        &format!("ssh -F {config} example.invalid"),
        &env,
        &dir,
        None,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        result
            .identities
            .iter()
            .map(|i| i.reference.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["agent", "agent", "file"]
    );
    assert_eq!(result.identities[0].public_key, public[1]);
    assert_eq!(result.identities[1].public_key, public[0]);
    assert_eq!(result.identities[2].public_key, public[1]);
    agent.kill().await.unwrap();
    agent.wait().await.unwrap();
}
