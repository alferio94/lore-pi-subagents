# Apply Partial: fix-child-mcp-adapter-loading

## Completed in This Slice
- [x] 2.1 Prompt guidance updated — builtin SDD agents and `lore-worker` now document explicit approved `pi-mcp-adapter` loading, `mcp` Lore gateway preference, direct/prefixed and flat compatibility tools, JSON-string gateway args, update-free save/upsert semantics, and fallback behavior.
- [x] 2.2 README updated — child MCP exposure contract now states `--no-extensions` stays enabled and only approved child extensions are explicitly loaded.
- [x] 4.2 Bounded manual arg-shape smoke completed — resolver found the installed adapter path; prepared launch with adapter kept `--no-extensions` and allowed `mcp`; prepared launch without adapter kept `--no-extensions` with no adapter extension/tools.

## Files Changed So Far
| File | Action | Notes |
|------|--------|-------|
| `agents/lore-worker.md` | Modified | Canonical child Lore MCP gateway/direct/flat guidance. |
| `agents/sdd-*.md` | Modified | Same canonical SDD Lore MCP guidance across SDD phase prompts. |
| `README.md` | Modified | Runtime contract documents explicit adapter and gateway call shape. |
| `test/extension.test.ts` | Modified | Prompt/docs contract assertions updated for adapter/gateway semantics. |
| `openspec/changes/fix-child-mcp-adapter-loading/tasks.md` | Modified | Marked slice 2 tasks complete. |

## Validation So Far
- `node --experimental-strip-types --test test/extension.test.ts` → passed (19 tests).
- Manual arg-shape smoke via `prepareChildLaunch()`/`resolveApprovedChildMcpAdapterExtensions()` → passed; installed adapter resolved to `/Users/alfonsocarmona/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter/index.ts`; with-adapter and without-adapter plans both kept `--no-extensions`.

## Remaining in Current Slice
- None.

## Recovery Notes
- Safe resume point: proceed to verify for the completed change.
- Known risks/blockers: no live child MCP server call was executed; smoke validated resolver/launch shape only.
