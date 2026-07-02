# Proposal: Fix Child MCP Adapter Loading

## Intent

Child SDD workers run with `--no-extensions` and explicitly load only `lore-pi-runtime`; therefore installed `pi-mcp-adapter` never registers `mcp` or direct Lore MCP tools. Fix this while preserving explicit child isolation.

## Persistence Note

OpenSpec fallback was used because this worker exposes no Lore MCP save tool. Evidence: installed `~/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter/package.json` declares `pi.extensions=["./index.ts"]`.

## Scope

### In Scope
- Resolve and explicitly load approved `pi-mcp-adapter` entrypoints for child launches when installed/configured.
- Add gated `mcp` to the child allowlist while preserving existing flat and MCP-prefixed Lore tool names.
- Keep `--no-extensions`; no ambient extension loading.
- Add tests/docs/prompts for adapter loading, fallback, and parent-only tool exclusion.

### Out of Scope
- Loading arbitrary parent extensions.
- Full MCP server-level policy engine.
- New persistence backend.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `sdd-worker-lore-mcp-persistence`: child isolation now requires explicit approved MCP adapter loading.

## Approach

Extend child extension discovery to resolve installed Pi package metadata (`package.json.pi.extensions`) for approved `pi-mcp-adapter`, rather than relying on a single hardcoded file. Normalize/de-duplicate extension paths. If absent or unconfigured, launch still succeeds and workers use existing OpenSpec fallback. Add `mcp` only when adapter loading is selected/needed; keep parent delegation tools excluded.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/runtime/delegations.ts` | Modified | Gated `mcp` plus existing Lore MCP allowlist names. |
| `src/runtime/child-launch.ts` | Modified | Explicit adapter extension args under `--no-extensions`. |
| `src/extension/index.ts` | Verified | Runtime child extension stays minimal. |
| `test/*.test.ts` | Modified | Cover args, fallback, no parent-only tools. |
| `README.md`, `agents/*.md` | Modified | Document child MCP loading contract. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Broad `mcp` gateway | High | Gate to Lore-needed child runs; document; later prefer direct Lore tools. |
| Cold cache/config absent | Med | Treat adapter/tools as optional; fallback to OpenSpec. |
| Brittle package path | Med | Resolve metadata entries; avoid one fixed entrypoint. |
| Duplicate extension loading | Low | Normalize and de-duplicate. |
| Parent-only tool leak | Low | Test allowlist exclusions. |

## Rollback Plan

Revert child extension/tool allowlist changes plus docs/tests. Children return to runtime-only extensions and OpenSpec fallback.

## Dependencies

- Installed/configured `pi-mcp-adapter` and usable MCP/Lore configuration.

## Success Criteria

- [ ] Child launch keeps `--no-extensions` and includes resolved adapter extension when available.
- [ ] `mcp` is gated; Lore MCP names remain allowed.
- [ ] Absent adapter does not fail launch; OpenSpec fallback remains valid.
- [ ] Tests prove no parent delegation tools are exposed.
