# Apply Started: fix-sdd-worker-lore-mcp-tools

## Slice
- Tasks in scope: 2.1 revise worker prompts, 2.2 update README, 3.2 update prompt-oriented tests, 4.1 run focused checks where cheap, 4.2 grep/readback prompt/docs wording.
- Tasks explicitly out of scope: runtime allowlist implementation from slice 1; archive/verify phases.
- Expected files: `agents/lore-worker.md`, `agents/sdd-*.md`, `README.md`, `test/extension.test.ts`, `openspec/changes/fix-sdd-worker-lore-mcp-tools/tasks.md`, apply artifacts.
- Validation planned: focused prompt/doc test(s) only; likely `node --experimental-strip-types --test test/extension.test.ts` plus grep/readback.
- Risk budget: low — prompt/docs/test wording changes only; no runtime behavior intended.

## Preconditions
- Proposal/spec/design/tasks read: yes
- Previous apply-progress merged: yes
- Strict TDD mode: inactive
- Artifact backend: OpenSpec fallback; this worker environment exposes no Lore MCP memory tools, only filesystem/shell tools.
