# Apply Started: fix-child-mcp-adapter-loading

## Slice
- Tasks in scope: 2.1 Update builtin worker/SDD prompts; 2.2 Update README; 4.2 bounded manual/smoke arg-shape check if cheap.
- Tasks explicitly out of scope: runtime resolver changes; archive; verify; broad build.
- Expected files: `agents/lore-worker.md`, `agents/sdd-*.md`, `README.md`, `test/extension.test.ts`, `openspec/changes/fix-child-mcp-adapter-loading/tasks.md`, apply artifacts.
- Validation planned: focused prompt/docs test via `node --experimental-strip-types --test test/extension.test.ts`; optional bounded manual child launch/arg-shape smoke if feasible.
- Risk budget: low — wording/test updates only; smoke must remain bounded.

## Preconditions
- Proposal/spec/design/tasks read: yes
- Previous apply-progress merged: yes — prior slice completed 1.1, 1.2, 1.3, 3.1, 3.2, 3.3, 4.1
- Strict TDD mode: inactive (no `openspec/config.yaml`; standard apply mode)
- Persistence mode: OpenSpec fallback because no Lore MCP memory save tool is exposed to this worker.
