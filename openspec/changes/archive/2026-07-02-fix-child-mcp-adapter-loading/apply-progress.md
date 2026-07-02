# Apply Progress: fix-child-mcp-adapter-loading

## Status
- Mode: Standard
- Current slice: completed
- Completed tasks: 10/10

## Completed Tasks Cumulative
- [x] 1.1 Add approved MCP adapter resolver — implemented package metadata validation, extension normalization, file checks, escape prevention, de-dupe, and absent/invalid fallback.
- [x] 1.2 Merge runtime extension with resolved adapter and gate `mcp` — delegation launch now includes approved adapter entrypoints and only grants `mcp` when adapter resolution succeeds.
- [x] 1.3 Preserve child isolation — `--no-extensions` remains in child launch; parent-only tools remain excluded; missing adapter falls back to runtime-only launch.
- [x] 2.1 Update builtin prompts — `agents/sdd-*.md` and `agents/lore-worker.md` now document explicit adapter loading, `mcp` gateway calls, direct/prefixed and flat Lore tool compatibility, save/upsert semantics without `lore_lore_memory_update`, and OpenSpec/file fallback.
- [x] 2.2 Update README — runtime docs now state child launches keep ambient extensions disabled and use explicit approved adapter loading plus gateway/direct/flat Lore memory surfaces.
- [x] 3.1 Add resolver tests — covered manifest discovery, normalization/de-dupe, wrong package, absent adapter, and unreadable JSON.
- [x] 3.2 Extend child-launch tests — covered explicit extension de-dupe/serialization and `mcp` tool serialization without changing `--no-extensions`.
- [x] 3.3 Extend extension tests — covered adapter extension args, gated `mcp`, retained Lore names, parent-only tool exclusions, and prompt contract wording.
- [x] 4.1 Run targeted tests — focused runtime tests passed.
- [x] 4.2 Perform focused manual launch check — `prepareChildLaunch()` plans with and without installed adapter confirmed `--no-extensions`; installed adapter path resolved and `mcp` was present only in the with-adapter plan.

## Files Changed Cumulative
| File | Action | Task(s) | Notes |
|------|--------|---------|-------|
| `src/runtime/child-mcp-adapter.ts` | Created | 1.1 | Approved `pi-mcp-adapter` resolver from installed package manifest. |
| `src/runtime/delegations.ts` | Modified | 1.2, 1.3 | Discovery includes approved adapter; `mcp` gateway gated and separate from Lore direct tools. |
| `agents/lore-worker.md` | Modified | 2.1 | Worker prompt documents explicit adapter/gateway/direct/flat Lore MCP surfaces. |
| `agents/sdd-*.md` | Modified | 2.1 | SDD phase prompts document the same child Lore MCP contract. |
| `README.md` | Modified | 2.2 | README describes explicit adapter loading, disabled ambient extensions, gateway call shape, and update-free persistence. |
| `test/delegations.test.ts` | Modified | 3.1, 3.3 | Resolver and discovery tests. |
| `test/child-launch.test.ts` | Modified | 3.2 | Explicit child arg serialization test includes adapter and `mcp`. |
| `test/extension.test.ts` | Modified | 2.1, 3.3 | Prompt contract and delegate launch tests for absent/present adapter tool surfaces. |
| `openspec/changes/fix-child-mcp-adapter-loading/tasks.md` | Modified | apply protocol | Completed slice checkboxes marked. |
| `openspec/changes/fix-child-mcp-adapter-loading/apply-started.md` | Modified | apply protocol | Latest pre-mutation checkpoint. |
| `openspec/changes/fix-child-mcp-adapter-loading/apply-partial.md` | Modified | apply protocol | Latest slice checkpoint. |

## Validation Cumulative
| Command | Scope | Result | Notes |
|---------|-------|--------|-------|
| `node --experimental-strip-types --test test/delegations.test.ts test/child-launch.test.ts test/extension.test.ts` | Focused runtime/tests | Passed | Prior slice: 43 tests passed. |
| `node --experimental-strip-types --test test/extension.test.ts` | Focused prompt/runtime tests | Passed | Slice 2: 19 tests passed. |
| `node --experimental-strip-types --input-type=module - <<'NODE' ... prepareChildLaunch smoke ... NODE` | Manual arg-shape smoke | Passed | Installed adapter resolved to `/Users/alfonsocarmona/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter/index.ts`; with/without adapter plans kept `--no-extensions`; `mcp` appeared only in with-adapter plan. |

## Deviations and Risks
- OpenSpec fallback used because no Lore save tool is exposed in this worker.
- Broad `mcp` gateway remains intentionally exposed only when the approved adapter is explicitly loaded.
- Manual smoke validated resolver/launch arg shape only; it did not execute a live child MCP server call.
- Broad build/typecheck intentionally deferred to verify.

## Next Slice Recommendation
- Tasks: none — apply tasks are complete.
- Why these next: proceed to SDD verify for full validation and spec conformance review.
