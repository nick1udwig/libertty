pub mod command_policy;
pub mod command_speech;
pub mod completion;
pub mod discovery;
pub mod file_repair;
pub mod help;
pub mod history;
pub mod host;
pub mod path;
pub mod path_repair;
pub mod pipeline;
pub mod repair;
pub mod runtime;
pub mod shell_structure;
pub mod speech;
pub mod suggestions;
pub mod transfer_command;
pub mod types;
mod util;
pub mod validation;
#[cfg(target_arch = "wasm32")]
mod wasm;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

pub const INPUT_LIMIT: usize = 64 * 1024 * 1024;

/// Prepare immutable language resources before accepting requests.
/// This performs no host callbacks and does not populate catalog or fact caches.
pub fn initialize() {
    command_policy::vocabulary();
    util::locale_cmp("", "");
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Request {
    pub operation: String,
    pub args: Vec<Value>,
}
fn argument<T: DeserializeOwned>(request: &Request, index: usize) -> Result<T, String> {
    let value = request
        .args
        .get(index)
        .ok_or_else(|| format!("Missing argument {index}."))?;
    deserialize(value).map_err(|error| format!("Invalid argument {index}: {error}"))
}
pub(crate) fn deserialize<T: DeserializeOwned>(value: &Value) -> Result<T, serde_json::Error> {
    T::deserialize(value).or_else(|original| {
        // JavaScript has one numeric type: JSON 1 and 1.0 are the same integer.
        fn normalize(value: &mut Value) {
            match value {
                Value::Number(number) if number.is_f64() => {
                    if let Some(number) = number.as_f64().filter(|n| {
                        n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0
                    }) {
                        *value = if number >= 0.0 {
                            Value::from(number as u64)
                        } else {
                            Value::from(number as i64)
                        };
                    }
                }
                Value::Array(values) => values.iter_mut().for_each(normalize),
                Value::Object(values) => values.values_mut().for_each(normalize),
                _ => {}
            }
        }
        let mut value = value.clone();
        normalize(&mut value);
        serde_json::from_value(value).map_err(|_| original)
    })
}
pub(crate) fn deserialize_bytes<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    serde_json::from_slice(bytes).or_else(|original| {
        serde_json::from_slice::<Value>(bytes)
            .and_then(|value| deserialize(&value))
            .map_err(|_| original)
    })
}
fn optional<T: DeserializeOwned>(request: &Request, index: usize) -> Result<Option<T>, String> {
    if request.args.get(index).is_none_or(Value::is_null) {
        Ok(None)
    } else {
        argument(request, index).map(Some)
    }
}
fn value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}
pub async fn dispatch_async(request: &Request, host: &dyn host::Host) -> Result<Value, String> {
    dispatch_with_discovery(request, host, &discovery::Discovery::default()).await
}
pub async fn dispatch_with_discovery(
    request: &Request,
    host: &dyn host::Host,
    discovery: &discovery::Discovery,
) -> Result<Value, String> {
    match request.operation.as_str() {
        "prewarmTargets" => value(discovery.prewarm_targets(
            &argument(request, 0)?,
            &argument(request, 1)?,
            host.now_ms(),
        )),
        "markWarmed" => {
            discovery.mark_warmed(
                &argument::<String>(request, 0)?,
                &argument(request, 1)?,
                &argument(request, 2)?,
                host.now_ms(),
            );
            Ok(Value::Null)
        }
        "seedMetadata" => {
            discovery.seed(
                &argument(request, 2)?,
                &argument(request, 0)?,
                &argument(request, 1)?,
                host.now_ms(),
            );
            Ok(Value::Null)
        }
        "suggest" | "suggestWithStage" => {
            let stage = std::cell::RefCell::new(None);
            let candidates = suggestions::suggest(
                &argument::<String>(request, 0)?,
                &argument(request, 1)?,
                &argument(request, 2)?,
                discovery,
                host,
                &stage,
            )
            .await?;
            if request.operation == "suggestWithStage" {
                Ok(
                    json!({"candidates":candidates,"source":stage.into_inner().unwrap_or_else(|| "schema".into())}),
                )
            } else {
                value(candidates)
            }
        }
        "discover" => value(
            discovery
                .discover(
                    &argument::<String>(request, 0)?,
                    &argument(request, 1)?,
                    &argument(request, 2)?,
                    host,
                )
                .await?,
        ),
        "cachedMetadata" => value(discovery.cached(
            &argument(request, 0)?,
            &argument(request, 1)?,
            host.now_ms(),
        )),
        "repairInputFile" => {
            let input: String = argument(request, 0)?;
            value(
                file_repair::repair_input_file(
                    &input,
                    &argument(request, 1)?,
                    &argument::<String>(request, 2)?,
                    host,
                    optional::<String>(request, 3)?.as_deref().unwrap_or(&input),
                    &types::CommandMetadata::default(),
                )
                .await?,
            )
        }
        "completeArguments" => value(
            completion::complete_arguments(
                &argument::<String>(request, 0)?,
                &argument(request, 1)?,
                &argument(request, 2)?,
                host,
                optional::<Vec<types::Flag>>(request, 3)?.as_deref(),
            )
            .await?,
        ),
        "candidateValid" => value(
            validation::candidate_valid(
                &argument::<String>(request, 0)?,
                &argument(request, 1)?,
                &argument(request, 2)?,
                &argument(request, 3)?,
                &argument(request, 4)?,
                host,
                optional::<Vec<types::Flag>>(request, 5)?.as_deref(),
            )
            .await?,
        ),
        "repairDirectory" => value(
            path_repair::repair_directory(
                &argument::<String>(request, 0)?,
                &argument(request, 1)?,
                &argument::<String>(request, 2)?,
                host,
            )
            .await?,
        ),
        _ => dispatch(request),
    }
}
pub fn dispatch(request: &Request) -> Result<Value, String> {
    let text = || argument::<String>(request, 0);
    match request.operation.as_str() {
        "tokens" => value(repair::tokens(&text()?)),
        "shellQuote" => value(repair::shell_quote(&text()?)),
        "similarity" => value(repair::similarity(
            &text()?,
            &argument::<String>(request, 1)?,
        )),
        "matches" => value(repair::matches(
            &argument::<Vec<types::Token>>(request, 0)?,
            argument(request, 1)?,
            &argument::<Vec<String>>(request, 2)?,
            argument(request, 3)?,
            optional(request, 4)?.unwrap_or(false),
        )),
        "commandNames" => value(repair::command_names(&text()?, &argument(request, 1)?)),
        "discoveryTarget" => value(repair::discovery_target(&text()?, &argument(request, 1)?)),
        "discoveryTargets" => value(repair::discovery_targets(&text()?, &argument(request, 1)?)),
        "repair" => value(repair::repair(
            &text()?,
            &argument(request, 1)?,
            optional::<Vec<types::Flag>>(request, 2)?.as_deref(),
            &optional(request, 3)?.unwrap_or_default(),
        )),
        "expandSymbols" => value(speech::expand_symbols(
            &text()?,
            optional(request, 1)?.unwrap_or(true),
        )),
        "symbolAlternatives" => value(speech::symbol_alternatives(&text()?)),
        "simpleWords" => value(validation::simple_words(&text()?)),
        "historyCandidates" => value(history::history_candidates(
            &text()?,
            &argument(request, 1)?,
        )),
        "directoryInput" => value(path_repair::directory_input(&text()?)),
        "pipelineParts" => value(pipeline::pipeline_parts(&text()?)),
        "transferAction" => value(transfer_command::transfer_action(&text()?)),
        "downloadPipeline" => value(transfer_command::download_pipeline(&text()?)),
        "flagsFromHelp" => value(help::flags_from_help(&text()?)),
        "commandsFromHelp" => value(help::commands_from_help(
            &text()?,
            optional::<String>(request, 1)?.as_deref(),
        )),
        "commandsFromManual" => value(help::commands_from_manual(&text()?)),
        "requiredFromHelp" => value(help::required_from_help(
            &text()?,
            &argument::<String>(request, 1)?,
        )),
        "hasCommandSlot" => value(help::has_command_slot(&text()?)),
        "optionArity" => value(command_policy::option_arity(
            &text()?,
            &argument::<Vec<types::Flag>>(request, 1)?,
        )),
        _ => Err("Unknown engine operation.".into()),
    }
}
/// Native and Wasm expose exactly the same JSON calling convention.
pub fn exchange(bytes: &[u8]) -> Vec<u8> {
    let response = if bytes.len() > INPUT_LIMIT {
        Err("Engine request exceeds 64 MiB.".to_owned())
    } else {
        serde_json::from_slice::<Request>(bytes)
            .map_err(|error| error.to_string())
            .and_then(|request| dispatch(&request))
    };
    serde_json::to_vec(&match response {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    })
    .expect("JSON response")
}
