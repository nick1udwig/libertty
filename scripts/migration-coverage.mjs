// Every retained backend assertion names the unchanged artifact or frontend owner.
const pure = 'crates/engine/tests/reference.rs#reference_corpus_preserves_complete_outputs';
const host = 'crates/engine/tests/host_reference.rs#native_bash_and_filesystem_reference_results_match';
const pty = 'crates/server/tests/session.rs#pty_contracts_run_in_an_isolated_shell_environment';
const native = 'crates/server/tests/native_engine.rs';
const retained = (equivalent, justification) => ({ status: 'retained', equivalent, justification });
const ported = (...equivalent) => ({ status: 'ported', equivalent, justification: 'The named native tests preserve these assertions; reference corpora compare complete values and recorded host operations in native Rust and Chromium Wasm.' });
const shell = retained(['test/migration-contracts.test.mjs'], 'Retain the original Bash assertions and Node PTY driver because the shell utility is unchanged; the contract test proves the Rust executable embeds its exact bytes, and native PTY tests cover its marker and session integration.');
const frontend = retained([], 'This assertion belongs to an unchanged TypeScript frontend or browser asset; retain its original harness, with backend interoperability additionally covered by the native and Rust browser suites.');

export const coverage = {
  'assets.test.ts': ported('crates/server/tests/assets.rs', 'crates/server/tests/http.rs'),
  'browser-key.test.ts': frontend,
  'catalog-scope.test.ts': ported('crates/server/tests/session.rs#light_catalog_does_not_poison_full_paths_and_nested_changes_refresh'),
  'completion.test.ts': ported(host, native, 'crates/server/tests/ssh.rs', pty, 'test/browser.mjs'),
  'context.test.ts': [
    ported('crates/server/tests/session.rs#light_catalog_does_not_poison_full_paths_and_nested_changes_refresh'),
    ported('crates/server/src/context.rs#prompts_coalesce_and_reuse_unchanged_parsed_files'),
    ported('crates/engine/src/history.rs#refresh_reuses_parsed_entries_while_adding_and_evicting_commands'),
  ],
  'dictation.test.ts': [
    ported('crates/server/tests/dictation.rs#capability_negotiation_and_binary_opus_validation_reject_older_or_malformed_inputs'),
    ported('crates/server/tests/dictation.rs#authenticated_daemon_negotiation_inserts_only_final_safe_transcripts_and_cancels_failures'),
    ported('crates/server/src/session.rs#paste_guards_brackets_and_program_input_target_match_reference'),
    ported('crates/server/src/session.rs#program_dictation_respects_paste_mode_edits_captures_and_shell_lifecycle'),
    ported('crates/server/src/session.rs#paste_guards_brackets_and_program_input_target_match_reference'),
    frontend,
    ported('crates/server/src/session.rs#stale_recording_controls_and_malformed_targets_do_not_start_or_finish_recordings'),
    frontend,
  ],
  'directories.test.ts': ported(native, host),
  'directory-optimization.test.ts': ported(host, 'test/architecture-benchmark.ts'),
  'discovery.test.ts': ported(pure, host, native, 'crates/engine/tests/prewarm.rs'),
  'facts.test.ts': retained(['crates/server/tests/facts.rs', 'crates/server/tests/http.rs', native, 'test/architecture-benchmark.ts', 'test/browser.mjs'], 'Retain the unchanged TypeScript ContextCache, DirectoryCache and RemoteHost orchestration assertions with the reference host as an independent oracle; native fact contracts and the Rust/Wasm architecture and browser harnesses exercise the replacement behind those same frontend adapters.'),
  'files-stream.test.ts': ported('crates/server/tests/files.rs#uploads_are_exclusive_accept_empty_files_and_remove_cancelled_writes', 'crates/server/tests/ssh.rs'),
  'herdr-capture.test.ts': shell,
  'herdr-notifications.test.ts': [
    ported('crates/server/tests/herdr.rs#boundaries_match_unchanged_reference_fixtures'), frontend, frontend,
    ported('crates/server/tests/notifications.rs#only_browser_services_with_valid_encryption_keys_are_accepted_and_delivery_is_encrypted'),
    ported('crates/server/tests/notifications.rs#only_browser_services_with_valid_encryption_keys_are_accepted_and_delivery_is_encrypted'),
    ported('crates/server/tests/notifications.rs#alerts_preserve_ownership_focus_acknowledgements_previews_and_restart_watches'),
    ported('crates/server/tests/notifications.rs#expired_devices_and_revoked_pairings_stop_deliveries_and_recycled_panes_have_no_preview'),
  ],
  'herdr-spaces.test.ts': [frontend, ported('crates/server/tests/herdr.rs', 'test/herdr-spaces-browser.mjs')],
  'herdr-terminal-stream.test.ts': ported('crates/server/tests/herdr_terminal_stream.rs', 'test/rust-herdr.mjs', 'test/herdr-resize-native.mjs', 'test/herdr-app-scroll-native.mjs'),
  'herdr.test.ts': ported('crates/server/tests/herdr.rs', 'test/rust-herdr.mjs', 'test/herdr-browser.mjs'),
  'history-shell.test.ts': [shell, ported('crates/server/tests/session.rs#large_readline_and_private_utilities_run_in_isolated_home')],
  'history.test.ts': [
    ported('crates/server/src/history.rs#source_precedence_regular_files_and_explicit_overrides'),
    ported('crates/server/tests/session.rs#large_readline_and_private_utilities_run_in_isolated_home'),
    ported('crates/server/tests/ssh.rs#remote_authentication_pins_facts_and_bounded_channels'),
  ],
  'markers.test.ts': ported('crates/server/tests/markers.rs'),
  'matching.test.ts': ported(pure, 'test/architecture-benchmark.ts'),
  'output.test.ts': [
    ported('crates/server/src/session.rs#output_window_preserves_all_duplicate_partial_and_invalid_acknowledgements'),
    ported('crates/server/src/session.rs#stream_changes_replay_from_the_start_even_with_overlapping_sequences'),
  ],
  'pairing.test.ts': ported('crates/server/tests/pairing.rs', 'crates/server/tests/http.rs', 'test/browser.mjs', 'test/pairing-browser.mjs'),
  'paste-mode.test.ts': [ported('crates/server/tests/paste_mode.rs'), frontend],
  'path-repair.test.ts': ported(host, 'test/browser.mjs'),
  'path-spelling.test.ts': ported(host, native, 'crates/server/tests/ssh.rs'),
  'pipeline.test.ts': ported(pure, host),
  'probes.test.ts': ported('crates/server/tests/probes.rs', native),
  'reading-shell.test.ts': shell,
  'reading.test.ts': [frontend, retained([pure, host, 'test/reading-browser.mjs'], 'Reading phrase selection belongs to the unchanged frontend; complete engine repair corpora and the mounted Rust Reading Mode harness preserve its backend path behavior.'), ported('crates/server/tests/files.rs'), frontend, ported('crates/server/tests/files.rs#reading_snapshots_preserve_binary_strip_terminal_codes_and_bound_retention')],
  'release.test.ts': [ported('crates/server/src/shell.rs#explicit_modern_bash_is_absolute_and_does_not_replace_system_bash'), ported('crates/server/tests/http.rs', 'scripts/smoke-release.mjs')],
  'repair.test.ts': ported(pure, 'test/architecture-benchmark.ts'),
  'shared-engine.test.ts': ported('crates/engine/tests/runtime.rs', host, 'test/rust-engine-browser.mjs'),
  'speech.test.ts': ported(pure),
  'ssh-capture.test.ts': shell,
  'suggestions.test.ts': ported(host, 'crates/engine/tests/prewarm.rs', native, 'test/architecture-benchmark.ts'),
  'system-ssh.test.ts': ported('crates/server/tests/system_ssh.rs'),
  'terminal-input.test.ts': [ported('crates/server/src/session.rs#control_d_keeps_the_prompt_and_input_snapshots_reject_stale_revisions'), ported(pty)],
  'transfer-suggestions.test.ts': ported(host, 'crates/server/tests/ssh.rs'),
  'transfers.test.ts': [shell, shell, ported('crates/server/tests/markers.rs'), ported('crates/server/tests/files.rs#transfers_replay_until_acknowledged_and_clean_captured_files_on_eviction_and_drop')],
  'validation.test.ts': [ported('crates/server/src/history.rs', 'crates/server/tests/ssh.rs'), ported(native), ported(host), ported(host, native), ported(host)],
  'vault.test.ts': [ported('crates/server/tests/vault.rs'), ported('crates/server/tests/vault.rs', 'crates/server/tests/system_ssh.rs', 'test/rust-state-compat.mjs'), ported('crates/server/tests/vault.rs'), frontend, ported('crates/server/tests/vault.rs')],
};

export const modules = {
  'server/directory-host.ts': ['crates/server/src/directories.rs', 'Local and SSH directory adapters are supplied through NativeHost and have real filesystem and SFTP integration coverage.'],
  'server/herdr-notification-preview.ts': ['crates/server/src/herdr.rs', 'Response previews match the independent Herdr corpus and notification delivery assertions.'],
  'server/history-shell.ts': ['crates/server/assets/bashrc.sh', 'The embedded history utility is byte-identical to the retained Bash assertion harness and passes native large-history PTYs.'],
  'server/host.ts': ['crates/server/src/host.rs', 'The native adapter boundary keeps filesystem and subprocess effects outside the shared engine.'],
  'server/pairing-page.ts': ['crates/server/src/dev.rs', 'Rust embeds the byte-identical pairing page and authenticates loopback Vite assets and HMR upgrades; the mounted development browser retains every original assertion.'],
  'server/path-repair.ts': ['crates/engine/src/path_repair.rs', 'The reference wrapper delegates to shared engine operations covered by complete native and browser Wasm fixtures.'],
  'server/validation.ts': ['crates/engine/src/validation.rs', 'The reference wrapper delegates to shared engine operations covered by complete native and browser Wasm fixtures.'],
  'server/release.ts': ['crates/server/src/release.rs', 'Native release metadata, config loading, direct launchers and Node rollback pass package and installer smoke assertions.'],
};
