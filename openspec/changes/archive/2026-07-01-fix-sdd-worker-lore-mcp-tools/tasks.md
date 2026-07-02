# Tasks: Fix SDD Worker Lore MCP Tools

## Phase 1: Runtime allowlist + contract
- [x] 1.1 Update `src/runtime/delegations.ts` to split flat and observed Lore MCP tool constants, add the observed `lore_lore_*` names, and keep `lore_memory_*` compatibility without adding `lore_lore_memory_update`.
- [x] 1.2 Keep child isolation intact in `src/runtime/child-launch.ts` and `src/extension/index.ts`: `--no-extensions` stays on, child tools stay explicit, and only `contact_supervisor` remains child-registered.

## Phase 2: Prompts and docs
- [x] 2.1 Revise `agents/lore-worker.md` and `agents/sdd-*.md` to treat observed MCP Lore tools as a valid backend before OpenSpec fallback, while still accepting flat `lore_memory_*` names.
- [x] 2.2 Update `README.md` to document the dual Lore tool surface, the removed `lore-memory.ts` path, and the absence of a required `memory_update` tool.

## Phase 3: Test coverage
- [x] 3.1 Update `test/delegations.test.ts` to assert the child allowlist includes flat + observed MCP tools, excludes `delegate*` / `delegation_*`, and does not include `lore_lore_memory_update`.
- [x] 3.2 Update `test/extension.test.ts` to verify shipped prompt text mentions MCP Lore before fallback, preserves child-only tool isolation, and keeps the canonical contract wording.
- [x] 3.3 Update `test/child-launch.test.ts` to lock `--no-extensions` plus explicit `--tools` serialization, deduplication, and child env preservation.

## Phase 4: Focused verification
- [x] 4.1 Run targeted checks only: `npm test -- test/delegations.test.ts test/extension.test.ts test/child-launch.test.ts`.
- [x] 4.2 If prompt wording changed broadly, do a final grep/readback on `agents/*.md` and `README.md`; skip any broad build or unrelated suites.
