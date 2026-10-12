use serde_json::{Value, json};
use termai_engine::{Request, types::Catalog};
use termai_server::{
    engine::NativeEngine,
    facts::{self, Facts},
    help::HelpProvider,
    host::{HostServices, NativeHost},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let services = HostServices::new();
    let help = HelpProvider::new(services.pool.clone());
    let engine = NativeEngine::new()?;
    let mut facts = Facts::default();
    let mut benchmark_host: Option<NativeHost> = None;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let response: Result<Value, String> = async {
            let request: Request = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if request.operation == "benchReset" {
                engine.reset()?;
                facts = Facts::default();
                if let Some(host) = benchmark_host.as_mut() {
                    host.help.dispose();
                    host.help = HelpProvider::new(services.pool.clone());
                }
                return Ok(Value::Null);
            }
            if request.operation == "benchInitialize" {
                benchmark_host = Some(NativeHost::new(
                    services.clone(),
                    serde_json::from_value(request.args[0].clone()).map_err(|e| e.to_string())?,
                    serde_json::from_value::<std::collections::BTreeMap<String, String>>(
                        request.args[1].clone(),
                    )
                    .map_err(|e| e.to_string())?,
                    help.clone(),
                ));
                return Ok(Value::Null);
            }
            let owned_host = if request.operation.starts_with("bench") {
                None
            } else {
                let catalog: Catalog = serde_json::from_value(
                    request.args[if [
                        "seedMetadata",
                        "hostFacts",
                        "cachedMetadata",
                        "benchSuggest",
                        "benchContext",
                        "benchFacts",
                        "benchDirectory",
                    ]
                    .contains(&request.operation.as_str())
                    {
                        0
                    } else {
                        1
                    }]
                    .clone(),
                )
                .map_err(|e| e.to_string())?;
                let env: std::collections::BTreeMap<String, String> = serde_json::from_value(
                    request.args[if [
                        "seedMetadata",
                        "hostFacts",
                        "cachedMetadata",
                        "benchSuggest",
                        "benchContext",
                        "benchFacts",
                        "benchDirectory",
                    ]
                    .contains(&request.operation.as_str())
                    {
                        1
                    } else {
                        2
                    }]
                    .clone(),
                )
                .map_err(|e| e.to_string())?;
                Some(NativeHost::new(
                    services.clone(),
                    catalog,
                    env,
                    help.clone(),
                ))
            };
            let host = owned_host
                .as_ref()
                .or(benchmark_host.as_ref())
                .ok_or("Benchmark host is not initialized.")?;
            let cancel = CancellationToken::new();
            if request.operation == "benchSuggest" {
                let start = std::time::Instant::now();
                let value = engine
                    .suggest(
                        request.args[0].as_str().ok_or("Invalid benchmark input.")?,
                        host,
                        &cancel,
                    )
                    .await?;
                return Ok(
                    json!({"candidates":value,"elapsedMs":start.elapsed().as_secs_f64()*1000.0}),
                );
            }
            if request.operation == "benchContext" {
                let paths = request.args.get(1).is_none_or(|v| *v != false);
                let mut catalog = host.catalog.clone();
                if !paths {
                    catalog.paths.clear();
                }
                return Ok(facts.context(
                    1,
                    catalog,
                    &host.environment,
                    request.args.first().and_then(Value::as_str),
                    paths,
                ));
            }
            if request.operation == "benchDirectory" {
                return Ok(json!(
                    host.snapshot(
                        request.args[0].as_str().ok_or("Invalid directory.")?,
                        10000,
                        &cancel
                    )
                    .await?
                ));
            }
            if request.operation == "benchFacts" {
                if request.args[0].as_str()
                    != Some(&facts::context_key(1, &host.catalog, &host.environment))
                {
                    return Err("Shell context changed. Try again.".into());
                }
                let operations = facts::validate(&request.args[1])?;
                return Ok(json!(facts::read(host, operations, &cancel).await?));
            }
            if request.operation == "hostFacts" {
                let operations: Vec<Value> =
                    serde_json::from_value(request.args[2].clone()).map_err(|e| e.to_string())?;
                let values =
                    futures::future::join_all(operations.iter().map(|op| host.fact(op, &cancel)))
                        .await
                        .into_iter()
                        .collect::<Result<Vec<_>, _>>()?;
                Ok(json!(values))
            } else {
                engine.invoke(request, host, &cancel).await
            }
        }
        .await;
        let wire = match response {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        output
            .write_all(serde_json::to_string(&wire)?.as_bytes())
            .await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    help.dispose();
    Ok(())
}
