//! Profile pure engine stages using the architecture benchmark's synthetic catalog.
use libertty_engine::{
    history::history_candidates,
    repair::{command_names, repair},
    types::{Catalog, CommandMetadata},
};
use std::{hint::black_box, time::Instant};

fn measure<T>(mut operation: impl FnMut() -> T) -> f64 {
    black_box(operation());
    let mut samples = Vec::new();
    for _ in 0..101 {
        let start = Instant::now();
        black_box(operation());
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    samples[50]
}
fn main() {
    libertty_engine::initialize();
    let catalog = Catalog {
        cwd: "/fixture".into(),
        commands: ["git", "ls", "cd", "cat", "echo", "python3", "orchard"]
            .into_iter()
            .map(str::to_owned)
            .chain((0..3000).map(|i| format!("program{i}")))
            .collect(),
        paths: ["hello_world.py", "docs/", "git/", "big/"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        history: (0..4999)
            .map(|i| format!("program{} argument{i}", i % 3000))
            .chain(["git init".into()])
            .collect(),
        ..Default::default()
    };
    let json = serde_json::to_value(&catalog).unwrap();
    println!(
        "{}",
        serde_json::json!({"catalogCloneMs":measure(|| catalog.clone()),"catalogToValueMs":measure(|| serde_json::to_value(&catalog).unwrap()),"catalogFromValueMs":measure(|| <Catalog as serde::Deserialize>::deserialize(&json).unwrap())})
    );
    for input in [
        "Get in it.",
        "Git commit -m \"exact message\"",
        "LSL",
        "cd git/pebble-agent",
        "cat ~/docs/my notes dot txt",
    ] {
        println!(
            "{}",
            serde_json::json!({"input":input,"commandNamesMs":measure(|| command_names(input,&catalog)),"historyMs":measure(|| history_candidates(input,&catalog)),"repairMs":measure(|| repair(input,&catalog,None,&CommandMetadata::default()))})
        );
    }
}
