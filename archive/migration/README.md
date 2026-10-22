# Migration archive

The old benchmark results, design mockups, initial specification, assertion inventory, migration-only generators, and hand-written JSON contracts remain available in Git history at commit `0ef573a`.
The historical client architecture, Rust migration, directory optimization, alternatives review and transport performance reports remain in Git history before their removal.
The browser wire types are now generated from the Rust types into `src/generated/protocol.ts`.
The engine vocabulary generator remains active as `scripts/engine-vocabulary.mjs`.
The saved-state interoperability fixture remains active because it verifies the current encrypted storage format with an independent cryptographic reader.
