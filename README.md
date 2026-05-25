# lore-pi-runtime

Greenfield Pi package scaffold for Lore-native delegation.

## Current slice
- Pi-installable package manifest
- Builtin markdown agents under `agents/`
- Frontmatter parser and merged agent discovery for builtin, user, and project agents
- Native `delegate`, `delegation_read`, and `delegation_list` runtime with persisted run records
- Child-only `contact_supervisor` escalation hook
- Global Lore model routing UI backed only by `~/.pi/agent/lore/models.json`, now using a step-by-step route → model → thinking → save flow
- Strict JSON envelope parsing for worker and SDD child results
- Lore memory tools are granted to all child agents by default; `lore:*` remains available as an explicit bundle alias

## Install locally in Pi
```bash
pi install /Users/alfonsocarmona/personal/lore2/lore-pi-runtime
```

## Test
```bash
npm test
```

## Runtime contract
- The package ships `pi-runtime.contract.json` as the machine-readable Pi runtime contract, and `package.json.pi.runtimeContract` points to it for discovery.
- The contract keeps package identity (`lore-pi-runtime`), package source locator (`git:github.com/alferio94/lore-pi-subagents`), and runtime entrypoint (`./src/extension/index.ts`) as separate concerns.
- Builtin aliases `reviewer`, `researcher`, `scribe`, and `general` all resolve to `lore-worker` through the packaged contract.

## Install policy notes
- Retained companion extensions: `lore-memory.ts` and `lore-footer.ts`.
- Legacy replacement policy: `lore-delegation.ts` is treated as a blocked legacy extension and is not re-declared as an active managed runtime extension.
- Installer integration is intentionally deferred: this package publishes the contract now, but does not implement `lore-cli install --target pi` consumption yet.

## Notes
- Parent runtimes expose `delegate`, `delegation_read`, and `delegation_list`; child runtimes expose only `contact_supervisor`.
- Global Lore model routing is reserved for `~/.pi/agent/lore/models.json`; project-local `.pi/lore/models.json` overrides are ignored.
- `/lore-models` edits one routing target at a time: choose default/agent, then model, then thinking, then save or back out.
- `delegation_list` now returns readable per-run id/agent/status/summary/updatedAt lines, and `delegation_read` points to persisted raw/stderr files when a child response is malformed.
- Child agents must return a single strict JSON envelope, including `skill_resolution`, so persisted runs remain machine-readable.
- Child agents always receive Lore memory tools: `lore_search`, `lore_save`, `lore_get_observation`, `lore_context`, project tools, and skill tools. This does not grant `delegate`, `delegation_read`, or `delegation_list` to child runtimes.
