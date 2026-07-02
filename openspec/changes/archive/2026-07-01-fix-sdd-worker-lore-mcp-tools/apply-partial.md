# Apply Partial: fix-sdd-worker-lore-mcp-tools

## Completed in This Slice
- [x] 2.1 Prompt guidance — updated `agents/lore-worker.md` and all `agents/sdd-*.md` to recognize flat and observed MCP Lore Memory surfaces, prefer Lore before OpenSpec fallback for SDD, and avoid `lore_lore_memory_update`.
- [x] 2.2 README guidance — documented dual child Lore tool surfaces, removed legacy `lore-memory.ts` runtime dependency wording, and save/upsert semantics.
- [x] 3.2 Prompt tests — updated `test/extension.test.ts` prompt assertions for dual surfaces, project helpers, fallback wording, removed extension, and canonical envelope wording.
- [x] 4.1 Focused validation — ran direct Node focused tests for delegation/extension/child-launch.
- [x] 4.2 Readback — grep/readback confirmed updated MCP/OpenSpec/update wording in prompts and README.

## Files Changed So Far
| File | Action | Notes |
|------|--------|-------|
| `agents/lore-worker.md` | Modified | Dual Lore Memory surface guidance; no legacy memory dependency. |
| `agents/sdd-*.md` | Modified | Concise SDD Lore-before-OpenSpec guidance across all SDD workers. |
| `README.md` | Modified | Child Lore Memory surface and removed extension documentation. |
| `test/extension.test.ts` | Modified | Prompt-oriented regression coverage. |
| `openspec/changes/fix-sdd-worker-lore-mcp-tools/tasks.md` | Modified | Marked slice 2 tasks complete. |

## Validation So Far
- `node --experimental-strip-types --test test/extension.test.ts` → passed (18/18).
- `node --experimental-strip-types --test test/delegations.test.ts test/extension.test.ts test/child-launch.test.ts` → passed (39/39).
- `grep -R "lore_lore_memory_update\|lore-memory.ts\|lore_lore_project_activity\|OpenSpec fallback\|delegate\|delegation_read\|delegation_list" -n agents README.md | head -80` → passed/readback complete.

## Remaining in Current Slice
- None.

## Recovery Notes
- Safe resume point: proceed to SDD verify.
- Known risks/blockers: OpenSpec fallback used for apply artifacts because no Lore MCP memory tools are exposed in this worker environment; `npm test -- ...` remains intentionally avoided because package script expands to broad `test/*.test.ts` as observed in slice 1.
