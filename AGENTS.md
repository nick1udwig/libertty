# Repository instructions

Write all prose with one and only one sentence per line, including Markdown, comments, commit bodies, and user-facing text.
When a request contains multiple work items, complete them one at a time in the requested order.
For each item, implement it, run the applicable checks, fix any bugs and rerun the affected checks, then commit it before moving to the next item.
Keep unrelated existing changes out of each item's commit.
Do not credit Claude or any other AI assistant in commits or pull requests, so omit `Co-Authored-By` trailers and generated-by lines.

For requests to deploy or push, do not run tests unless the user explicitly requests them for that request.
This exception covers preparatory commits, merges, version bumps and packaging, and overrides testing requirements in this file, repository skills and operational guides.
Test suites, benchmarks and validation commands that execute tests are covered by this exception.
Run builds, artifact integrity checks and deployment health checks when needed to complete the requested operation.

## Repository skills

Read [.agents/skills/libertty-ops/SKILL.md](.agents/skills/libertty-ops/SKILL.md) for local deployment, systemd and Tailscale operations, version bumps, and release packaging.
The ops skill's [version bump reference](.agents/skills/libertty-ops/references/version-bumps.md) lists every active version field and the commands to find and verify them.
Read [.agents/skills/libertty-code-changes/SKILL.md](.agents/skills/libertty-code-changes/SKILL.md) for implementation guidance and all validation requirements, including performance and package checks.
Before any commit or merge, read the code changes skill and run the checks it requires for the current work item, applying the deploy or push exception above.
