use serde_json::{Value, json};
use termai_engine::{
    Request,
    runtime::{Runtime, Step, message},
};
#[test]
fn prewarm_targets_expire_and_remain_scoped_to_their_context_without_host_effects() {
    let mut runtime = Runtime::default();
    let catalog = json!({"cwd":"/fixture","commands":["git","ls"],"paths":[],"history":["git status","rm -rf /"]});
    let env = json!({"HOME":"/fixture"});
    let targets = || Request {
        operation: "prewarmTargets".into(),
        args: vec![catalog.clone(), env.clone()],
    };
    let complete =
        |runtime: &mut Runtime, request, call, now| match runtime.start(request, call, now) {
            Step::Complete { value, .. } => value,
            _ => panic!("Prewarm selection must complete without host operations"),
        };
    let expected = json!([
        "git",
        "git status",
        "git init",
        "git add",
        "git commit",
        "ls"
    ]);
    assert_eq!(complete(&mut runtime, 1, targets(), 0.0), expected);
    let mark = Request {
        operation: "markWarmed".into(),
        args: vec![json!("git"), catalog.clone(), env.clone()],
    };
    assert_eq!(complete(&mut runtime, 2, mark, 1.0), Value::Null);
    let warm = json!(["git status", "git init", "git add", "git commit", "ls"]);
    assert_eq!(complete(&mut runtime, 3, targets(), 600000.0), warm);
    assert_eq!(complete(&mut runtime, 4, targets(), 600001.0), expected);
    let mut changed = targets();
    changed.args[0]["cwd"] = json!("/other");
    assert_eq!(complete(&mut runtime, 5, changed, 2.0), expected);
    runtime.reset();
    assert_eq!(complete(&mut runtime, 6, targets(), 2.0), expected);
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
