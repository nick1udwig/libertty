# Repository instructions

Write all prose with one and only one sentence per line, including Markdown, comments, commit bodies, and user-facing text.
When a request contains multiple work items, complete them one at a time in the requested order.
For each item, implement it, test it, fix any bugs and rerun the affected checks, then commit it before moving to the next item.
Keep unrelated existing changes out of each item's commit.

## Repository skills

Read [.agents/skills/termai-ops/SKILL.md](.agents/skills/termai-ops/SKILL.md) for local deployment, systemd and Tailscale operations, version bumps, and release packaging.
The ops skill's [version bump reference](.agents/skills/termai-ops/references/version-bumps.md) lists every active version field and the commands to find and verify them.
Read [.agents/skills/termai-code-changes/SKILL.md](.agents/skills/termai-code-changes/SKILL.md) for implementation guidance and all validation requirements, including performance and package checks.
Before any commit or merge, read the code changes skill and run every check it requires for the current work item.
