# Apply Progress: fix-sdd-worker-lore-mcp-tools

## Status
- Mode: Standard
- Current slice: completed
- Completed tasks: 9/9

## Completed Tasks Cumulative
- [x] 1.1 Update runtime Lore MCP tool constants — split flat compatibility and observed prefixed constants, aggregate both, and exclude `lore_lore_memory_update`.
- [x] 1.2 Keep child isolation intact — no runtime isolation behavior changed; tests preserve explicit tools, `--no-extensions`, and child-only `contact_supervisor` behavior.
- [x] 2.1 Revise worker prompts — `agents/lore-worker.md` and all `agents/sdd-*.md` now recognize flat and observed MCP Lore Memory surfaces, prefer Lore before OpenSpec fallback for SDD, and avoid legacy/update dependencies.
- [x] 2.2 Update README — documented the dual child Lore Memory surface, project helpers, removed `lore-memory.ts`, and save/upsert semantics.
- [x] 3.1 Update delegation allowlist tests — asserted flat + observed MCP tools, uniqueness, no parent-only delegation tools, and no prefixed update tool.
- [x] 3.2 Update prompt tests — `test/extension.test.ts` now checks prompt text for dual surfaces, project helpers, OpenSpec fallback preference, save/upsert, removed extension, and canonical envelope wording.
- [x] 3.3 Update child-launch tests — asserted explicit `--tools` serialization/deduplication with an observed MCP tool while preserving launch invariants.
- [x] 4.1 Run targeted checks — direct Node focused test command passed for delegation, extension, and child-launch tests.
- [x] 4.2 Prompt/docs readback — grep/readback confirmed MCP/update/fallback wording in `agents/*.md` and `README.md`.

## Files Changed Cumulative
| File | Action | Task(s) | Notes |
|------|--------|---------|-------|
| `src/runtime/delegations.ts` | Modified | 1.1 | Added flat and observed-prefixed Lore MCP constants plus aggregate allowlist. |
| `test/delegations.test.ts` | Modified | 3.1 | Expanded allowlist/isolation assertions. |
| `test/extension.test.ts` | Modified | 1.2, 3.1, 3.2 | Updated launched child tool bundle assertion and prompt text regression coverage. |
| `test/child-launch.test.ts` | Modified | 1.2, 3.3 | Preserved `--no-extensions` and explicit tools serialization/deduplication coverage. |
| `agents/lore-worker.md` | Modified | 2.1 | Added dual Lore Memory surface guidance for general workers. |
| `agents/sdd-apply.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-archive.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-design.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-explore.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-init.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-propose.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-spec.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-tasks.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `agents/sdd-verify.md` | Modified | 2.1 | Added SDD Lore-before-OpenSpec MCP guidance. |
| `README.md` | Modified | 2.2 | Documented child Lore Memory tool surfaces and removed legacy dependency. |
| `openspec/changes/fix-sdd-worker-lore-mcp-tools/tasks.md` | Modified | apply protocol | Marked completed slice tasks. |

## Validation Cumulative
| Command | Scope | Result | Notes |
|---------|-------|--------|-------|
| `npm test -- test/delegations.test.ts test/child-launch.test.ts test/extension.test.ts` | Attempted focused tests | Failed (unrelated) | Slice 1 found package script prepends `test/*.test.ts`; failure was in unrelated `test/agent-registry.test.ts` lore-cli fixture compile errors (`isCodexConfigTomlManaged`, `codexConfigHasLoreMCPBlock`). |
| `node --experimental-strip-types --test test/delegations.test.ts test/child-launch.test.ts test/extension.test.ts` | Focused changed-file tests | Passed | 39/39 tests passed after slice 2. |
| `node --experimental-strip-types --test test/extension.test.ts` | Focused prompt/doc test | Passed | 18/18 tests passed after prompt assertions were updated. |
| `grep -R "lore_lore_memory_update\\|lore-memory.ts\\|lore_lore_project_activity\\|OpenSpec fallback\\|delegate\\|delegation_read\\|delegation_list" -n agents README.md | head -80` | Prompt/docs readback | Passed | Confirmed updated prompt/docs wording and child/parent boundary notes. |

## Deviations and Risks
- OpenSpec fallback used because this worker environment exposes no Lore MCP memory tools.
- `npm test -- ...` is not actually focused in this package; direct `node --test` was used for focused validation to avoid unrelated broad suite failures.

## Next Slice Recommendation
- Tasks: none.
- Why these next: all apply tasks are complete; proceed to SDD verify.
