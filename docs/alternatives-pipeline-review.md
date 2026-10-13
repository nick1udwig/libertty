# Dictation alternatives review and proposals

The shared Rust engine is a sound foundation, but the overall pipeline is only partly general: command repair, path repair, shell composition, history, and discovery use different rules for when to stop searching.
The best improvements are to reduce dependent network exchanges, make repair compose across shell syntax, and retain plausible candidates until validation has established which ones deserve the three visible slots.
Keep the shared engine and its effect boundary, and refactor the orchestration around them incrementally.

This review covers commit `fe09474`, including browser input, backend dictation, native and Wasm execution, SSH facts, Herdr, candidate generation, validation, ranking, and application to the shell line.
Only this report changes the repository.
The examples below were checked with the production native engine and disposable filesystem fixtures; the network analysis distinguishes observed engine dependencies from measured network latency.

**Overall assessment**

| Property | Assessment |
| --- | --- |
| Generality | Good for simple commands and known schemas, uneven across compound commands, wrappers, script invocation forms, and operand types |
| Maintainability | Strong shared engine and adapters, but overlapping parsers, command lists, numeric thresholds, and special routes make extensions interact unpredictably |
| Elegance | The pure engine and request-scoped fact cache are clean, while early returns and repeated string parsing obscure how the final candidate set is chosen |
| Efficiency | Good batching and caching already exist, but several independent operations remain sequential and remote execution placement adds avoidable network dependencies |
| Coverage | Existing tests protect valuable behavior, but combinations of supported features expose reproducible omissions |

The existing architecture deserves preservation in several respects.
Native and Wasm callers share the same Rust matching implementation, host operations are separated from interpretation, duplicate facts are coalesced within a request, and independent branches already run concurrently in several places.
Directory snapshots have freshness checks, help probes have route restrictions, Python inspection reads an AST without importing the script, and terminal edits have prompt and revision guards.
These mechanisms provide a useful base for improving coverage without weakening protections around shell input.

**How the current pipeline works**

1. Browser input handling identifies possible dictation through bulk insertion, replacement, and composition events, while clipboard paste and ordinary incremental composition follow separate paths.
   Backend microphone dictation forwards audio to Voxtype, accepts final text, inserts it into the terminal, and sends a `pasted` notification to the browser.
   Foreground applications receive literal text without command repair.
2. `InlineSuggestions` combines the transcript with the tracked prefix and suffix, or requests the real Readline buffer when tracking is unknown.
   Reading commands have their own preprocessing and can trigger a second suggestion request if the first interpretation produces no alternatives.
3. Native mode sends one `/api/suggest` request to a session-owned engine, whereas browser mode starts a worker that obtains context and invokes Wasm through `RemoteHost`.
   The worker delegates selected inputs back to native repair using `kind: repair`, based on a Python prefix or a word-count rule with command exclusions.
4. The engine first recognizes the special download pipeline, then ordinary pipes, then a restricted two-command semicolon form, then spoken-symbol interpretations.
   These routes do not all recurse through the same repair process.
5. A simple-command interpretation tries specialized file repair, strong history matches, directory repair, nearby paths, and static or cached schemas in that order.
   If those do not return early, it expands referenced paths, discovers help or Python flags, tries Bash completions, validates, ranks, and returns candidates plus the original transcript.
6. The browser chooses the leading parsed candidate, sends a separate replacement request, waits for acceptance, and exposes up to three alternatives alongside the original.
   Consequently, “one suggestion request” is not the complete user-visible network path.

The primary entry points are [inline-suggestions.ts](../src/inline-suggestions.ts), [suggestion-worker.ts](../src/suggestion-worker.ts), [suggestions.rs](../crates/engine/src/suggestions.rs), and [session.rs](../crates/server/src/session.rs).
Herdr uses the same repair library through a separate [suggestion adapter](../crates/server/src/herdr.rs).

**Where network round trips accumulate**

There are two distinct network boundaries: browser to backend, and backend to an SSH host.
Moving the engine to the backend removes browser fact exchanges, but it does not automatically remove SSH exchanges.
Likewise, putting multiple operations in one HTTP request helps only if the backend also avoids unnecessary dependent remote operations.

| Path | Current dependent work | Consequence |
| --- | --- | --- |
| Native suggestions with a known shell line | Suggestion response, then replacement acknowledgement | Normally two browser/backend round trips before the menu reaches its ready state |
| Unknown shell line | Readline snapshot before the preceding sequence | Another browser/backend round trip |
| Backend microphone transcript | Backend insertion and notification, browser suggestion request, browser replacement request | Repair orchestration travels back through the browser despite the transcript already being on the backend |
| Browser engine | Optional context fetch, dependent fact batches, optional directory retry, optional richer context and another search, then replacement | Latency follows dependency depth, even though each batch can contain many facts |
| Managed SSH | Browser execution is forced by `Session::start_remote`, with selective native delegation | Both network boundaries can sit on the critical path |
| Remote Herdr | Pane and process checks, executable enumeration, optional path scan, repair, final process check, then replacement | One browser suggestion request can conceal substantial remote work |

The SSH mode override is explicit in `Session::start_remote`, which ignores its requested engine mode and selects `client`.
The selective delegation rule in [compound-repair.ts](../src/compound-repair.ts) already acknowledges that some inputs benefit from coarse backend execution, but input length is an unreliable estimate of fact dependencies.
For example, `cat ~/docs/my-notes.txt` has only two words and can require a filesystem walk, while a long command with fully known options may need little discovery.

Tracing the current native runtime with real host facts produced the following dependency phases.
These are engine callback waves before browser cache shortcuts, context acquisition, SSH protocol exchanges, or replacement acknowledgements; they are not end-to-end timing measurements.
The trace held the engine's budget clock fixed to expose dependency order, so it does not measure timeout behavior.

| Input and fixture | Observed fact phases | Interpretation |
| --- | --- | --- |
| `ls alpha beta gamma`, with three existing files | Syntax plus `stat(alpha)` → `stat(beta)` → `stat(gamma)` | Three independent operand checks are serialized |
| `cat ~/docs/my-notes.txt`, with `docs/My Notes.txt` present | Whole-path stat → directory lookup → leaf lookup → matched-file stat | Four phases for a short input that bypasses coarse delegation |
| `orchard workspace`, with advertised nested help | Root help → child help → syntax | Discovery depends on the parent response |
| `python3 tool.py output result` | Describe script → completion with `ou` → completion with empty prefix → syntax plus script stat | Completion adds two phases even after the script option is discoverable |
| `cd projects/work-space/deep-folder` | Whole-path stat plus first lookup → syntax plus another stat | The two stats have different executable-check requirements and therefore different runtime cache keys |

Browser caches can eliminate or combine some of those phases, and Python inputs already use native delegation when that capability is advertised.
The serialized operand checks are directly visible in [validation.rs](../crates/engine/src/validation.rs), and the sequential completion fallback is in [completion.rs](../crates/engine/src/completion.rs).
At an assumed 150 ms browser/backend RTT, three dependent remote batches contribute about 450 ms of transport waiting, compared with about 150 ms for one batch, before server work and terminal application.

SSH adds costs that the browser request count does not reveal.
`SSHHost::snapshot` opens a directory and reads batches until completion, `paths` visits child directories sequentially, and `lookup` waits for a stat miss before listing the parent.
An executable stat can perform SFTP metadata lookup followed by a separate SSH `test -x` command, and every uncached help, syntax, description, or completion command opens an exec channel.
The specialized file walker requests executable information even when it only needs to establish that an operand is a file.
These operations are implemented in [ssh_facts.rs](../crates/server/src/ssh_facts.rs) and [ssh.rs](../crates/server/src/ssh.rs).

The client repair endpoint can also collect a broad path catalog before searching and reread used directory listings afterward to verify freshness.
On SSH, that verification can mean another enumeration, rather than a cheap local metadata check.
Periodic client context preparation also enumerates cwd and home, so background traffic and foreground repair can compete for the same remote host.

**Reproduced coverage gaps**

The fixtures used a small explicit command catalog, known files, and a synthetic `orchard` executable that advertised its nested commands through help.
Examples involving unavailable catalog paths are labeled because the production worker may recover by fetching a richer catalog and retrying, at additional cost.

| Case | Current result | Missing behavior and cause |
| --- | --- | --- |
| `cat my notes`, with both `my-notes` and `my_notes` present | Both filenames appear without history, but adding `cat my-notes` to history removes `cat my_notes` | A score-102 history result returns before path alternatives are considered |
| `cat notes`, with catalog entries `not-es`, `not_es`, `not.es`, and `no_tes`, but only `not.es` currently present | Only the original transcript survives | Generation selects three nonexistent candidates before validation and never refills from the valid fourth match |
| `Orchard work space recon cile target VALUE` | Correctly produces `orchard workspace reconcile --target VALUE` | Control case for discovery |
| The same input followed by `semicolon echo done` | Produces `orchard work space recon cile target VALUE; echo done` | The semicolon branch uses basic repair without the discovery that repaired the individual command |
| `Get status pipe cat` | Produces `git status \| cat` | Control case for pipe repair |
| `Get status pype cat` | Offers `git status pype cat` and `Get status \| cat`, but not `git status \| cat` | Fuzzy symbol recognition happens after structural routing and the resulting shell text bypasses recursive command repair |
| `Get status && echo done` or `Get status; echo done` | Only the literal input | AND lists are unsupported, and the semicolon recognizer requires whitespace around a literal separator |
| `Get status semicolon echo done semicolon echo end` | No fully repaired three-command sequence | Semicolon composition is limited to exactly two commands |
| `Get commit -m "$USER"` | Only the literal input | Shell metacharacters anywhere in the string disable ordinary repair, including an otherwise repairable command name |
| `python3 tool.py output result force`, with script options `--output` and `--force` | Produces `python3 tool.py --output result force` | After the first script option, candidate generation switches back to Python's option schema |
| `python3 tool.py --output result --force` with the same script | Only the literal input | The same schema-scope bug rejects an already valid two-option script command as a parsed candidate |
| `python3 -u tool.py output result` | Does not produce `--output` | Script discovery assumes the script occupies the second token |
| `less docs slash My Notes dot txt` or `cat -n docs slash My Notes dot txt`, with an empty path catalog | Only the literal input, while plain `cat docs slash My Notes dot txt` succeeds | Specialized live file traversal is restricted to particular command forms |
| `gti status` | Only the literal input | General command matching lacks the adjacent-transposition handling available to symbol matching |
| Help declaring `--output filename` or `--count number` | Both options are parsed as taking no value | Help extraction recognizes a restricted set of value placeholders |

The history and pruning examples are particularly significant because they lose an alternative that the existing matching rules already know how to generate.
They require orchestration changes, not a new fuzzy matcher.
Other validation failures can cause the same loss whenever they reject candidates after a provider has discarded its remaining matches.

The script option bug is in `push` in [repair.rs](../crates/engine/src/repair.rs): script flags are selected when the argument list reaches the script token, but subsequent transitions look up the interpreter scope again.
The special file traversal limits are in [file_repair.rs](../crates/engine/src/file_repair.rs), while directory traversal has its own parser, search bounds, and candidate scoring in [path_repair.rs](../crates/engine/src/path_repair.rs).

Compound validation also has a quality gap.
When `simple_words` cannot parse a candidate because it contains shell structure, `policy_valid` returns true and leaves Bash syntax as the remaining check.
Consequently, the broken `Get status | cat` symbol interpretation passes validation even though `Get` is not in the fixture command catalog.
Syntax validity and command/schema validity need distinct representation.

**Additional limitations visible in the implementation**

Command wrappers do not establish a nested command scope.
`sudo Get status` and `env FOO=bar Get status` were treated as ordinary operand completion and produced unrelated executable completions in the local environment, without producing the intended wrapped `git status`.
The exact wrong completions depend on the installed environment, but the missing wrapper model is structural.

Option values are largely opaque after a value-taking flag, so a path-valued option such as `--config`, a branch value, or an enumerated value does not receive the same repair as an ordinary operand.
The `Flag` model represents essentially zero versus one required following value, plus an optional attached value, and cannot describe fixed multi-value arguments, variadic arguments, choices, or path roles.
The Python AST adapter flattens options across the file without modeling subparser ownership, imports, or dynamically defined options.
Unsupported metadata should be represented as unknown instead of being mistaken for a complete schema.

There is also an interaction between static subcommand lists and spoken flags.
The repair loop handles a non-dash token as a subcommand whenever a scope has children, and can stop before interpreting that token as a spoken global option.
A structured scope and option model would let the two possibilities coexist until validation resolves them.

Discovery cache validity differs across layers.
The engine retains merged metadata by cwd and stable environment for ten minutes, while native help caching additionally checks executable identity and modification information.
The engine's fast cached-schema path can avoid the provider entirely, so a changed executable is not necessarily noticed merely because the provider has a stronger cache key.
Failed or uninformative help can also become an empty learned schema without expressing whether discovery was complete.

Herdr recreates a `NativeEngine` and local `HelpProvider` for each suggestion and constructs a catalog without the session history and function metadata available to direct sessions.
Remote Herdr additionally enumerates commands through a fresh Bash invocation and repeats process checks around repair.
This loses reuse and makes alternative quality depend on the terminal integration, even though the matching library is shared.
Herdr recognizes several shell types but the repair and completion infrastructure remains Bash-oriented, which should be an explicit capability distinction.

Failures and time limits can erase useful work.
Several concurrent groups collect into a single `Result`, so one failed optional discovery or validation branch can reject the entire result instead of retaining independently validated candidates.
The directory, file, completion, and discovery sub-budgets are approximately 1, 1.5, 1.5, and 2.5 seconds respectively, HTTP handlers have a five-second timeout, and the browser worker has a twelve-second outer timeout.
They do not currently form one explicit request budget with a shared policy for partial results.

At the speech boundary, repair receives one final text string rather than acoustic hypotheses or word-confidence information.
It can therefore recover only interpretations reachable from that string and the available command, history, path, and completion evidence.
Supporting alternate recognizer transcripts would be a separate extension if a provider exposes them; the present protocol should not be assumed to supply that information.

**Proposal 1: Make coarse backend repair the primary network boundary**

Use one session-scoped repair operation for network-dependent work, including managed SSH sessions.
The existing `kind: repair` endpoint provides a starting point, so this does not require replacing the Rust engine or designing a new inference service.
Remove the word-count and command-name placement rule as the long-term execution policy.
If browser-local repair is retained, limit it to work demonstrably answerable from valid local evidence, with a deliberate handoff when host facts are required.

The backend operation should acquire authoritative context itself, avoiding a prerequisite context round trip merely to obtain the keys needed to ask it to repair.
It should also start with lightweight context and fetch targeted paths or schemas as needed, rather than unconditionally scanning unrelated child directories.
Preserve context validation, cancellation, help-route verification, and freshness checks inside the operation.

For direct terminals, the expected benefit is one browser repair exchange regardless of the number of discovery and filesystem phases.
For SSH, this removes repeated browser/backend waits but leaves backend/SSH dependencies for Proposal 3.
The backend uses more CPU and owns more request state, but that is aligned with the stated priority of minimizing network latency.
Retain Wasm as a supported execution option if there is an independent product requirement for it, rather than paying for two equally complex orchestration policies by default.

**Proposal 2: Combine repair and guarded line application**

Introduce a dictation transaction that carries a request identifier, prompt, expected input revision, transcript, and enough line or insertion context to interpret the utterance correctly.
The server can obtain an authoritative line snapshot when necessary, compute alternatives, and apply the selected result only if the same revision is still current.
Return the alternatives, original text, actual selected text, application status, and resulting revision together.

This can remove the separate post-suggestion replacement round trip on the normal direct-terminal path.
For backend microphone dictation, initiate repair from the final transcript callback and publish the completed result instead of requiring the browser to request repair of text the backend just produced.
For Herdr, include the existing pane ownership and foreground-shell checks in its adapter and retain its restriction to replacing the latest dictated text.

The transaction must preserve edits that arrive while repair is running and reject obsolete results atomically.
It must not automatically send Enter, and it must keep the original transcript available as a user choice.
Represent reading and transfer intent explicitly so their frontend preprocessing does not accidentally apply a plain shell command where the user intended a reading action.
Cancellation and revision guards are essential to realizing the latency improvement without stale replacements.

**Proposal 3: Reduce dependencies inside host operations**

Start with the changes that have clear benefits without adding a remote installation requirement.

| Change | Expected benefit | Important constraint |
| --- | --- | --- |
| Gather all independent operand stats before awaiting them | Replace the demonstrated three validation phases with one | Resolve command scope and effective cwd first |
| Reuse stronger stat facts for weaker requests and stop requesting executable checks for ordinary operands | Avoid repeated metadata work and SSH `test -x` commands | Retain executable checks for command paths |
| Run the whole-file shortcut and first component lookup concurrently | Avoid an added phase when the shortcut misses | Apply the directory walker's existing approach to the file walker |
| Batch independent completion contexts | Reduce sequential completion waits | Preserve dependencies when a later context needs an earlier correction |
| Fuse narrow-prefix completion and its empty-prefix fallback behind the host boundary | Keep the fallback within one browser exchange | Bound returned candidates and probe time |
| Fetch targeted directories and read independent child listings concurrently with a limit | Reduce broad catalog scans and serial SSH enumeration | Keep enumeration bounds, symlink handling, and freshness guarantees |
| Retain Herdr engine and provider state per terminal context | Reuse learned metadata and help across requests | Invalidate on pane, shell, cwd, environment, and connection changes |

The narrow completion prefix also affects recall.
Today the unfiltered fallback runs only when the prefix query returns no values, so unrelated prefix matches can hide a phonetically appropriate value outside that prefix.
Fallback should depend on whether returned values explain the utterance, with bounded broader lookup where needed.

For larger SSH gains, evaluate a persistent, versioned remote fact worker that can perform a bounded directory walk, multiple stats, syntax checks, or verified discovery locally and return a structured result over one channel.
Reuse the same Rust traversal and discovery code where practical to avoid a second algorithm in shell scripts.
A remote engine would move even more dependencies next to the filesystem, but adds packaging, platform compatibility, lifecycle, and upgrade costs.
Treat it as a second-stage decision after tracing the remaining SSH critical path, with the current SFTP adapter as a compatibility fallback.

Do not count changing HTTP to WebSocket, compressing JSON, or increasing concurrent requests as equivalent to removing a dependent round trip.
Those changes can help other costs, but the fundamental improvement is doing dependent work on one side of an expensive connection.

**Proposal 4: Make candidate generation compose over a shared parsed representation**

Parse once into a limited shell structure that preserves original source spans, quoting, operators, command invocations, option values, and operands.
Keep unsupported constructs as opaque spans and repair only the portions whose meaning is understood.
This permits correcting `Get` while preserving `"$USER"` exactly, without attempting variable expansion or full shell evaluation.

Apply each plausible spoken-symbol interpretation to that structure, then send all resulting simple commands through the same repair process.
Use one bounded composition mechanism for pipelines, semicolon lists, AND/OR lists, and supported wrappers.
Carry effective cwd and other relevant context across commands when semantics require it, such as a successful `cd` followed by a relative path operation.
Independent pipeline branches can still run concurrently, but state-dependent command lists must not all be evaluated against the initial cwd.

Replace separate directory and file walkers with a shared path resolver parameterized by operand role, expected type, quoting, existing-path requirements, and completion rules.
Keep intentional distinctions such as existing input paths versus new output paths, and directory-only operands versus files.
This would make the successful plain-`cat` path logic available to `less`, `cat -n`, and schema-declared path options without duplicating command-specific parsers.

The schema should represent option cardinality, value kinds, subcommand ownership, interpreter/script boundaries, and wrapper behavior.
Static command knowledge, help extraction, Python AST inspection, and Bash completions should contribute evidence to the same schema rather than supplying separate parsing conventions.
Fix the confirmed script-scope bug before the larger schema refactor, and add interpreter-option handling as an explicit invocation rule.
Preserve conservative treatment of quoted free-form values, patterns, and deliberate shell syntax.

**Proposal 5: Separate search, evidence, validation, and display limits**

Use a candidate pool whose entries retain provenance, source spans, structured changes, available evidence, and unresolved requirements.
Providers should report whether they are inapplicable, complete, incomplete, failed, or exhausted, rather than returning an ambiguous empty vector.
An early result can stop expensive discovery when warranted without preventing cheap, relevant providers from contributing alternate interpretations.

History should influence ranking rather than automatically suppressing filesystem or schema candidates.
Keep a wider bounded search frontier, validate candidates in batches, and refill from the frontier when an earlier candidate is rejected.
Apply the three-choice display limit after validity filtering and deduplication, with a modest diversity preference so similar spellings do not crowd out a different plausible interpretation.
Unify score meanings and transformation penalties instead of directly comparing unrelated path, history, command, and compound scores.

Distinguish invalid candidates from candidates whose schema or facts are unknown.
For compound input, validate each understood command node instead of treating successful Bash parsing as complete policy validation.
Keep candidates that have already passed required checks when an optional provider fails, while propagating cancellation and failures of facts required to validate that specific candidate.

Replace control flow based on English explanation strings such as `File →` and `Completion →` with typed change kinds.
Generate user-facing explanations from those types at the presentation boundary.
This removes a hidden dependency between wording changes and validation behavior.

Give metadata a versioned identity and completeness state that survives both native and browser adapters.
Align engine metadata invalidation with executable and script changes, and make fallback work depend on unresolved evidence instead of whether every returned candidate happens to be literal.
The latter distinction matters because an unchanged but nonliteral candidate can currently prevent the worker's richer-context retry.

**Suggested implementation order**

1. Add regression cases for the reproduced omissions and lightweight tracing of request phases, then fix script-scope retention, premature truncation, and independent operand-stat sequencing.
2. Route SSH repair through a coarse session operation and remove unnecessary catalog work from that operation, measuring browser and SSH boundaries separately.
3. Add guarded repair-and-apply transactions for direct dictation, followed by the backend microphone and Herdr integrations.
4. Unify the parsed command representation and operand schema, then extend compound repair and path handling through that shared model.
5. Introduce the candidate evidence model, consistent budgets, cache invalidation, and partial-result policy, using the new regression corpus to preserve intended behavior.
6. Decide whether a persistent remote worker is justified by the remaining SSH dependency depth.

This ordering delivers useful latency and correctness improvements before the most invasive parsing work.
The parser and candidate refactors can proceed incrementally behind existing API shapes; a wholesale rewrite would create unnecessary parity and rollout risk.

**Acceptance criteria and measurement**

Measure time from committed transcript to accepted shell-line replacement and alternatives ready, including context acquisition, Readline snapshots, retries, and acknowledgement.
Record browser/backend request count, dependent fact phases, SSH operations, SSH dependency depth, provider cache hits, and time spent waiting for probes.
Count background context and prewarm work separately but include its effect under contention.
Avoid recording raw dictated arguments in routine telemetry because they can contain private command values.

Use cold and warm cases at several injected RTTs, including asymmetric browser/backend and backend/SSH latency.
Cover reloads, reconnects, changed files, changed executables, large directories, completion fallback, compound commands, interpreter options, and concurrent user edits.
Track intended-alternative recall separately from whether the highest-ranked candidate is appropriate for automatic insertion.
Return-list equality remains useful for refactors, but the confirmed bug cases should intentionally change their expected results.

The existing [architecture benchmark](../test/architecture-benchmark.ts) is a useful base, but its client orchestration does not exactly mirror the worker's current lightweight-first search and richer-context retry.
It also excludes terminal replacement and does not directly measure actual SSH protocol traffic.
Older performance tables in the repository describe historical architectures and should not be used as current end-to-end latency measurements.

The targeted native `native_engine`, `facts`, and `completion` suites passed all 17 tests during this review.
The four frontend test files for dictation alternatives, inline suggestions, compound placement, and remote facts also passed.
The additional production-engine probes reproduced the gaps above without changing implementation or test files.
Network savings remain estimates from dependency structure until the proposed end-to-end measurements are run.

The probes can be reproduced through `target/debug/examples/engine_host`, built with `cargo build --locked -p termai-server --example engine_host`.
It accepts one JSON request per line using `{"operation":"suggestWithStage","args":[text,catalog,environment]}`, where the catalog supplies `cwd`, `commands`, `paths`, and `history`.
For the history example, create both named files, supply both in `paths`, and compare an empty history with `["cat my-notes"]`.
For the pruning example, supply all four catalog spellings but create only `not.es`.
For the Python examples, create a script declaring `argparse` options `--output` with a value and `--force` with `action='store_true'`, and include `python3` plus the script path in the appropriate catalog fields.
For the nested-command example, have `orchard --help` advertise `workspace`, `orchard workspace --help` advertise `reconcile`, and `orchard workspace reconcile --help` advertise `--target NAME`.
Use a fresh engine process for each comparison to keep learned metadata from changing the result.
