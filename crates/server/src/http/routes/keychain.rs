use super::*;
use crate::protocol::KeychainAction;

pub(super) async fn api_keychain(
    State(app): State<Arc<App>>,
    _ctx: OwnerContext,
    mut req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    let input = if *req.method() == Method::GET {
        None
    } else {
        Some(typed_body::<KeychainAction>(&mut req, 16384).await?)
    };
    let vault = app.vault.clone();
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Value> {
        if let Some(input) = input {
            match input {
                KeychainAction::Delete { id } => vault.remove(&id)?,
                KeychainAction::Rename { id, name } => vault.rename(&id, &name)?,
                KeychainAction::Forget { host, port } => {
                    let address =
                        system_ssh::address(&json!({"host":host,"port":port,"username":"unused"}))
                            .map_err(std::io::Error::other)?;
                    vault.forget(&address.host, address.port)?;
                }
                KeychainAction::Inspect {
                    private_key,
                    passphrase,
                } => {
                    return Ok(serde_json::to_value(inspect_private_key(
                        &private_key,
                        &passphrase,
                    )?)?);
                }
                KeychainAction::Create {
                    name,
                    passphrase,
                    private_key,
                } => {
                    return Ok(serde_json::to_value(vault.create(
                        &name,
                        &passphrase,
                        private_key.as_deref(),
                        None,
                    )?)?);
                }
                KeychainAction::Backup {
                    name,
                    passphrase,
                    private_key,
                    replace_id,
                } => {
                    return Ok(serde_json::to_value(vault.create(
                        &name,
                        &passphrase,
                        private_key.as_deref(),
                        replace_id.as_deref(),
                    )?)?);
                }
                KeychainAction::Export { id, passphrase } => {
                    let raw = vault.unlock(&id, &passphrase)?;
                    let mut info = serde_json::to_value(
                        vault
                            .list()?
                            .keys
                            .into_iter()
                            .find(|key| key.id == id)
                            .ok_or_else(|| std::io::Error::other("SSH key not found."))?,
                    )?;
                    info["privateKey"] = json!(String::from_utf8_lossy(&raw));
                    return Ok(info);
                }
            }
        }
        Ok(serde_json::to_value(vault.list()?)?)
    })
    .await
    .map_err(|_| fail("Vault operation failed."))?
    .map_err(|error| fail(error.to_string()))?;
    ok(result)
}
