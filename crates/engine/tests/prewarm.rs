use serde_json::{Value, json};
use termai_engine::{
    Request,
    runtime::{Runtime, Step, message},
};
#[test]
fn prewarm_targets_and_context_expiration_match_the_reference_without_host_effects() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-migration/prewarm.json"
    ))
    .unwrap();
    let mut runtime = Runtime::default();
    for (index, step) in corpus["steps"].as_array().unwrap().iter().enumerate() {
        let call: Request = serde_json::from_value(step.clone()).unwrap();
        match runtime.start(index as u32 + 1, call, step["now"].as_f64().unwrap()) {
            Step::Complete { value, .. } => {
                assert_eq!(value, step["expected"], "prewarm step {index}")
            }
            _ => panic!("Prewarm target selection must not perform host operations"),
        }
    }
    runtime.reset();
    let first = &corpus["steps"][0];
    match runtime.start(
        corpus["steps"].as_array().unwrap().len() as u32 + 1,
        serde_json::from_value(first.clone()).unwrap(),
        600003.0,
    ) {
        Step::Complete { value, .. } => assert_eq!(value, first["expected"]),
        _ => panic!("Reset must forget warmed contexts"),
    }
}
#[test]
fn integral_json_numbers_accept_decimal_notation_and_reject_fractional_identifiers() {
    let mut decimals = Runtime::default();
    let decimal=message(&mut decimals,br#"{"request":1.0,"operation":"matches","args":[[{"value":"g","quoted":false}],0.0,["git"],3.0],"now":0.0}"#,false);
    assert!(matches!(&decimal, Step::Complete { .. }));
    let mut integers = Runtime::default();
    let integer=message(&mut integers,br#"{"request":1,"operation":"matches","args":[[{"value":"g","quoted":false}],0,["git"],3],"now":0}"#,false);
    assert_eq!(
        serde_json::to_value(decimal).unwrap(),
        serde_json::to_value(integer).unwrap()
    );
    let invalid = message(
        &mut decimals,
        br#"{"request":2.5,"operation":"tokens","args":["hello"],"now":0}"#,
        false,
    );
    assert!(matches!(invalid, Step::Error { .. }));
    let request: Request = serde_json::from_value(
        json!({"operation":"matches","args":[[{"value":"g","quoted":false}],0.0,["git"],3.0]}),
    )
    .unwrap();
    assert!(termai_engine::dispatch(&request).is_ok());
}
