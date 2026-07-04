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

## Delegation artifact retention and pruning

Delegation runs are stored under the runtime delegation root as `dg-*` directories. To prevent unbounded disk growth, the runtime includes a shared pruning engine used by both manual cleanup and optional automatic cleanup.

Default retention policy:
- Automatic pruning is disabled by default (`enabled: false`).
- Manual pruning is dry-run by default (`dryRun: true`).
- Heavy diagnostics (`raw-output.txt`, `stderr.txt`, `trace.jsonl`) are eligible after 3 days.
- Whole run directories are eligible after 21 days, when older than the most recent 150 eligible runs, or when needed to get under 5 GB total retained size.
- Protected entries are never modified: `running` runs, `needs_user_input` runs, runs with `supervisor-request.json`, non-`dg-*` directories, symlinks, unreadable runs, and unsafe roots.
- `failed` runs are treated the same as `completed` runs.

Manual dry-run first:
```text
/delegation-prune --root ~/.local/share/lore/pi/delegations
```

Execute only after reviewing the dry-run report:
```text
/delegation-prune --root ~/.local/share/lore/pi/delegations --execute
```

The parent tool is also available as `delegation_prune`; its `dryRun` option defaults to `true`, even if environment defaults say otherwise. Pass `dryRun: false` explicitly to delete planned artifacts.

Optional config file: `~/.pi/agent/lore/delegation-retention.json`
```json
{
  "enabled": false,
  "dryRun": true,
  "heavyLogAgeDays": 3,
  "maxAgeDays": 21,
  "keepLast": 150,
  "maxTotalSize": "5gb",
  "autoCooldownMs": 3600000,
  "rootDir": "/Users/you/.local/share/lore/pi/delegations"
}
```

Environment overrides:
```bash
export LORE_PI_RUNTIME_RETENTION_PATH="$HOME/.pi/agent/lore/delegation-retention.json"
export LORE_PI_RUNTIME_RETENTION_ENABLED=true        # opt in to automatic lifecycle pruning
export LORE_PI_RUNTIME_RETENTION_DRY_RUN=true        # manual APIs still default dry-run unless explicitly false
export LORE_PI_RUNTIME_RETENTION_HEAVY_LOG_AGE_DAYS=3
export LORE_PI_RUNTIME_RETENTION_MAX_AGE_DAYS=21
export LORE_PI_RUNTIME_RETENTION_KEEP_LAST=150
export LORE_PI_RUNTIME_RETENTION_MAX_TOTAL_SIZE=5gb
export LORE_PI_RUNTIME_RETENTION_AUTO_COOLDOWN_MS=3600000
export LORE_PI_RUNTIME_RETENTION_ROOT_DIR="$HOME/.local/share/lore/pi/delegations"
```

Automatic pruning only runs when `enabled`/`LORE_PI_RUNTIME_RETENTION_ENABLED` is explicitly true. It is single-flight, cooldown-gated, and non-blocking for normal delegation execution; failures are logged/reported rather than failing the delegation.

## Runtime contract
- The package ships `pi-runtime.contract.json` as the machine-readable Pi runtime contract, and `package.json.pi.runtimeContract` points to it for discovery.
- The contract keeps package identity (`lore-pi-runtime`), package source locator (`git:github.com/alferio94/lore-pi-subagents`), and runtime entrypoint (`./src/extension/index.ts`) as separate concerns.
- Builtin aliases `reviewer`, `researcher`, `scribe`, and `general` all resolve to `lore-worker` through the packaged contract.

## Install policy notes
- Retained companion extension: `lore-footer.ts`.
- Removed/blocked legacy extensions: `lore-memory.ts` and `lore-delegation.ts` are not active runtime dependencies.
- Installer integration is intentionally deferred: this package publishes the contract now, but does not implement `lore-cli install --target pi` consumption yet.

## Notes
- Parent runtimes expose `delegate`, `delegation_read`, and `delegation_list`; child runtimes expose only `contact_supervisor`.
- Global Lore model routing is reserved for `~/.pi/agent/lore/models.json`; project-local `.pi/lore/models.json` overrides are ignored.
- `/lore-models` edits one routing target at a time: choose default/agent, then model, then thinking, then save or back out.
- `delegation_list` now returns readable per-run id/agent/status/summary/updatedAt lines, and `delegation_read` points to persisted raw/stderr files when a child response is malformed.
- Child agents must return a single strict JSON envelope, including `skill_resolution`, so persisted runs remain machine-readable.
- Child launches keep `--no-extensions`; the runtime explicitly loads only approved child extensions, including `pi-mcp-adapter` when installed for Lore MCP access.
- Child agents prefer Lore Memory before OpenSpec when any supported surface exists: MCP gateway `mcp` with server `lore`, direct/prefixed tools (`lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`), or flat compatibility tools (`lore_memory_search`, `lore_memory_get`, `lore_memory_save`). Gateway calls use `mcp({ server: "lore", tool: "lore_lore_memory_save", args: "{...}" })` with `args` as a JSON string. Project helpers may include `lore_lore_project_list`, `lore_lore_project_context`, and `lore_lore_project_activity`. `lore_lore_memory_update` is not currently observed; workers use save/new-artifact/upsert semantics as supported. This does not grant parent delegation-management tools to child runtimes.
