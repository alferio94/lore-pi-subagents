# Tasks: Fix Child MCP Adapter Loading

_OpenSpec fallback note: no Lore save tool was available in this session._

## Phase 1: Child MCP adapter resolution and gating

- [x] 1.1 Add `src/runtime/child-mcp-adapter.ts` to resolve the approved `pi-mcp-adapter` manifest at `~/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter`, normalize/de-dupe `pi.extensions`, and reject mismatched or unreadable metadata.
- [x] 1.2 Update `src/runtime/delegations.ts` so `discoverChildExtensions()` merges the runtime extension with resolved adapter entrypoints, and only adds `mcp` to child tools when adapter loading succeeds.
- [x] 1.3 Keep child isolation intact in `src/runtime/delegations.ts`/`src/runtime/child-launch.ts`: preserve `--no-extensions`, exclude `delegate|delegation_read|delegation_list`, and let missing adapter/config fall back to runtime-only launch.

## Phase 2: Prompts and docs

- [x] 2.1 Update `agents/sdd-*.md` and `agents/lore-worker.md` to describe the explicit adapter load path, `mcp` gateway preference, flat/MCP Lore compatibility names, and OpenSpec fallback when the adapter is absent.
- [x] 2.2 Update `README.md` to match the child MCP exposure contract and state that ambient extension loading stays disabled.

## Phase 3: Focused tests

- [x] 3.1 Add resolver tests in `test/delegations.test.ts` for manifest discovery, `pi.extensions` normalization/de-dupe, wrong-package rejection, and absent-adapter fallback.
- [x] 3.2 Extend `test/child-launch.test.ts` to assert child args keep `--no-extensions`, include the resolved adapter `--extension`, and serialize `mcp` only when the adapter is present.
- [x] 3.3 Extend `test/extension.test.ts` to verify child tool lists still exclude parent delegation tools, preserve existing Lore names, and expose `mcp` only under the gated adapter path.

## Phase 4: Live smoke / verify

- [x] 4.1 Run the targeted tests: `node --experimental-strip-types --test test/delegations.test.ts test/child-launch.test.ts test/extension.test.ts`.
- [x] 4.2 Perform a focused manual launch check with the installed adapter path and without it to confirm arg shape, no ambient extensions, and OpenSpec fallback on absence.
