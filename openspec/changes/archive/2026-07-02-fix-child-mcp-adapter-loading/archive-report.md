# Archive Report: fix-child-mcp-adapter-loading

## Summary
- Status: archived
- Artifact store: OpenSpec fallback
- Source of truth updated: `openspec/specs/sdd-worker-lore-mcp-persistence/spec.md`

## Spec Sync
- Added requirements:
  - Explicit MCP Adapter Loading Under Child Isolation
  - MCP Gateway Availability and Compatibility
- Modified requirements:
  - No Legacy Lore Extension Dependency
  - Child Tool Isolation
- Preserved requirements:
  - Lore MCP Backend Recognition
  - Dual Lore Tool Name Compatibility
  - Save-Based Upsert Without Memory Update
  - Contract Coverage in Tests, Docs, and Prompts

## Verification Evidence
- Verdict: PASS WITH WARNINGS
- Focused tests: `node --experimental-strip-types --test test/delegations.test.ts test/child-launch.test.ts test/extension.test.ts` (43 passed)
- Typecheck: `npm run typecheck` passed
- Bounded launch smoke: prepared child launch evidence confirmed `--no-extensions`, explicit adapter extension loading when present, and `mcp` gating; no full live MCP server-call smoke was executed

## Archive Location
- `openspec/changes/archive/2026-07-02-fix-child-mcp-adapter-loading/`
