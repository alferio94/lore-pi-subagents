# Design: Fix Child MCP Adapter Loading

## Technical Approach

Preserve child isolation (`pi --no-extensions`) and explicitly add the installed `pi-mcp-adapter` extension only when its approved package manifest is present. Child launches will then allow the adapter gateway tool `mcp` alongside existing Lore direct-tool names. If the adapter is absent or unusable, launch still succeeds and SDD workers fall back to OpenSpec. Persistence note: this design is written via OpenSpec fallback because this worker exposes no Lore MCP save tool.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Adapter resolution | Add a testable resolver, preferably `src/runtime/child-mcp-adapter.ts`, with constants for `pi-mcp-adapter`, locator `git:github.com/nicobailon/pi-mcp-adapter`, and default package dir `~/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter`. Resolve `package.json.pi.extensions` to absolute files. | Hardcode `index.ts`; scan all extensions. | Manifest resolution matches Pi package metadata and avoids ambient extension loading. |
| Installed package discovery | First read the deterministic manifest path; optionally confirm/derive from `~/.pi/agent/settings.json.packages` when present. Reject mismatched `package.json.name` and missing/non-file extension entries. | Generic discovery of every package manifest. | Keeps the allowlist package-specific and avoids loading unrelated installed packages. |
| Deduplication | Return normalized absolute extension paths from the resolver; keep `prepareChildLaunch()` dedupe as a second guard. | Rely only on child-launch dedupe. | Prevents duplicate `--extension` args when runtime and adapter paths overlap or resolver inputs repeat. |
| Fallback | Missing adapter, unreadable manifest, or invalid manifest returns only the runtime extension and records no hard failure. | Throw and fail delegation. | Artifact persistence already has OpenSpec fallback; absence of MCP must not block child execution. |
| `mcp` tool placement | Introduce `CHILD_MCP_GATEWAY_TOOLS = ["mcp"]` and include it in child tools only when the adapter resolver found an extension. Keep `MCP_LORE_MEMORY_TOOLS` for direct/compat Lore names. | Add `mcp` to `MCP_LORE_MEMORY_TOOLS`; create full server policy now. | `mcp` is a broad gateway, not a Lore memory tool. A separate child gateway allowlist makes the risk visible and keeps future server-level policy separable. |

## Data Flow

```text
startDelegation()
  ├─ discoverChildExtensions()
  │   ├─ runtime extension
  │   └─ resolveApprovedChildMcpAdapterExtensions()
  ├─ tools = agent + MCP_LORE_MEMORY_TOOLS + (adapter ? CHILD_MCP_GATEWAY_TOOLS : []) + contact_supervisor
  └─ launchChildProcess(): pi --no-extensions --extension <runtime> --extension <adapter> --tools <deduped>
child
  └─ use mcp({server:"lore", tool:"lore_lore_memory_save", args:"{...}"}) when gateway exists; otherwise direct Lore names or OpenSpec fallback
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/runtime/child-mcp-adapter.ts` | Create | Approved adapter constants, manifest parsing, extension resolution, normalization/dedupe helpers. |
| `src/runtime/delegations.ts` | Modify | Use resolver in `discoverChildExtensions()`; add `CHILD_MCP_GATEWAY_TOOLS`; gate `mcp` on adapter presence; keep parent-only exclusions. |
| `src/runtime/child-launch.ts` | Verify | Preserve `--no-extensions`, absolute extension normalization, and dedupe. |
| `agents/*.md`, `README.md` | Modify | Prefer MCP gateway calls when available; document fallback and no legacy `lore-memory.ts`. |
| `test/delegations.test.ts`, `test/child-launch.test.ts`, `test/extension.test.ts` | Modify/Add | Cover resolver, tools, extension args, prompt/docs contract. |

## Interfaces / Contracts

```ts
export const CHILD_MCP_GATEWAY_TOOLS = ["mcp"] as const;
export function resolveApprovedChildMcpAdapterExtensions(env?: NodeJS.ProcessEnv): string[];
export function discoverChildExtensions(): string[]; // runtime + approved adapter extensions only
```

Worker prompt contract: when `mcp` is exposed, prefer `mcp({ server: "lore", tool: "lore_lore_memory_save", args: "{...}" })` for Lore persistence; call only configured Lore server tools; fall back to direct Lore names or OpenSpec if unavailable.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Resolver reads manifest, rejects wrong package, ignores missing adapter, normalizes/dedupes entries. | Temp HOME/settings/package fixtures in `test/delegations.test.ts` or new resolver test. |
| Launch | Child keeps `--no-extensions`; includes runtime and adapter `--extension`; omits adapter when absent. | Extend `test/child-launch.test.ts` / fake Pi arg inspection. |
| Isolation | `mcp` appears only when adapter extension is loaded; `delegate*` never appears. | Extend delegation/extension tests. |
| Contract/docs | Prompts/README mention gateway preference, direct-name fallback, OpenSpec fallback. | Regex assertions in `test/extension.test.ts`. |

## Migration / Rollout

No migration required. Rollback reverts resolver, `mcp` allowlist, docs, and tests; children continue using OpenSpec fallback.

## Open Questions

None.
