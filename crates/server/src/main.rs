fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Some(index) = arguments.iter().position(|arg| arg == "--config") {
        use std::os::unix::process::CommandExt;
        let result = (|| -> Result<(), String> {
            let file = arguments
                .get(index + 1)
                .ok_or("Supply --config with the installed config.json.")?;
            let environment = libertty_server::release::configuration(std::path::Path::new(file))?;
            let mut command =
                std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
            command.args(
                arguments
                    .iter()
                    .enumerate()
                    .filter_map(|(i, arg)| (i != index && i != index + 1).then_some(arg)),
            );
            command.envs(environment);
            if let Some(root) = libertty_server::release::packaged_root() {
                command.current_dir(root);
            }
            Err(command.exec().to_string())
        })();
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    if std::env::args().any(|arg| arg == "--version") {
        let metadata = libertty_server::release::metadata();
        println!(
            "libertty {} ({})",
            env!("CARGO_PKG_VERSION"),
            metadata
                .as_ref()
                .and_then(|v| v["commit"].as_str())
                .or(option_env!("LIBERTTY_COMMIT"))
                .unwrap_or("source checkout")
        );
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Create server runtime");
    if let Err(error) = runtime.block_on(libertty_server::http::run()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
