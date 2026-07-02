# Verification Report: fix-child-mcp-adapter-loading

**Change**: fix-child-mcp-adapter-loading
**Version**: N/A
**Mode**: Standard
**Artifact store**: OpenSpec fallback; this verify child exposes no Lore MCP memory save tool, so the report is persisted to `openspec/changes/fix-child-mcp-adapter-loading/verify-report.md`.

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 10 |
| Tasks complete | 10 |
| Tasks incomplete | 0 |

All tasks in `tasks.md` are marked complete.

---

## Build & Tests Execution

**Build / Typecheck**: ✅ Passed

```text
npm run typecheck
> lore-pi-runtime@0.1.0 typecheck
> tsc --noEmit
Exit code: 0
```

**Focused tests**: ✅ 43 passed / 0 failed / 0 skipped

```text
node --experimental-strip-types --test test/delegations.test.ts test/child-launch.test.ts test/extension.test.ts
ℹ tests 43
ℹ pass 43
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 2718.148667
```

**Coverage**: ➖ Not available; no coverage command or threshold was configured for this change.

**Bounded launch smoke**: ✅ Passed via prepared child launch inspection

```text
Installed-adapter plan:
- adapterExtensions: /Users/alfonsocarmona/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter/index.ts
- --no-extensions: present
- --extension: runtime extension and approved adapter extension present
- --tools includes mcp: true
- --tools excludes delegate, delegation_read, delegation_list: true

Absent-adapter plan using temporary HOME:
- adapterExtensions: []
- --no-extensions: present
- --extension: runtime extension only
- --tools includes mcp: false
```

A first smoke attempt inherited `LORE_PI_DELEGATION_DEPTH` from the verify child and failed with the expected max-depth guard; the bounded smoke was rerun with that environment variable unset. A full live model-backed child MCP call was not run because prepared child launch was sufficient for the requested capability exposure check and avoids nested live delegation side effects from within verify.

---

## Spec Compliance Matrix

| Requirement | Scenario | Test / Evidence | Result |
|-------------|----------|-----------------|--------|
| Explicit MCP Adapter Loading Under Child Isolation | Adapter loaded explicitly | `test/extension.test.ts > delegate explicitly loads approved MCP adapter and gates mcp tool when installed`; prepared smoke confirmed runtime + adapter `--extension` args with `--no-extensions` | ✅ COMPLIANT |
| Explicit MCP Adapter Loading Under Child Isolation | Adapter absent does not block launch | `test/delegations.test.ts > approved child MCP adapter resolver rejects absent...`; `test/extension.test.ts > delegate grants lore memory tools to every child before launching`; absent-adapter smoke confirmed runtime-only extension and no `mcp` | ✅ COMPLIANT |
| MCP Gateway Availability and Compatibility | MCP-only worker report succeeds | `test/extension.test.ts > delegate explicitly loads approved MCP adapter and gates mcp tool when installed`; prepared smoke confirmed `mcp` in the child allowlist when adapter is present. Full live MCP server call not executed in verify. | ⚠️ PARTIAL |
| MCP Gateway Availability and Compatibility | Existing Lore names still allowed | `test/delegations.test.ts > expandAgentTools expands flat and observed MCP Lore tool surfaces...`; `test/extension.test.ts > delegate grants lore memory tools to every child before launching` | ✅ COMPLIANT |
| No Legacy Lore Extension Dependency | Child launched with extensions disabled | `test/delegations.test.ts > discoverChildExtensions never autoloads the deprecated lore-memory extension`; `test/extension.test.ts > shipped builtin prompts teach dual Lore MCP surfaces before fallback without legacy dependencies` | ✅ COMPLIANT |
| Child Tool Isolation | Delegation tools stay unavailable | `test/delegations.test.ts > expandAgentTools strips parent-only tools...`; `test/extension.test.ts > delegate explicitly loads approved MCP adapter and gates mcp tool when installed`; prepared smoke confirmed parent-only tools absent | ✅ COMPLIANT |
| Main spec: Lore MCP Backend Recognition | MCP Lore selected before OpenSpec / no usable save tool fallback | `test/extension.test.ts > shipped builtin prompts teach dual Lore MCP surfaces before fallback without legacy dependencies`; prompt/docs grep confirms Lore Memory before OpenSpec and OpenSpec fallback | ✅ COMPLIANT |
| Main spec: Dual Lore Tool Name Compatibility | Flat compatibility and observed MCP names valid | `test/delegations.test.ts > expandAgentTools expands flat and observed MCP Lore tool surfaces...`; `test/extension.test.ts > delegate grants lore memory tools to every child before launching` | ✅ COMPLIANT |
| Main spec: Save-Based Upsert Without Memory Update | Update tool absent | `test/delegations.test.ts` asserts `lore_lore_memory_update` is absent; `test/extension.test.ts` asserts prompt guidance for save/topic-key upsert and update-free persistence | ✅ COMPLIANT |
| Main spec: Contract Coverage in Tests, Docs, and Prompts | Regression and user guidance coverage | `test/extension.test.ts > shipped builtin prompts teach dual Lore MCP surfaces before fallback without legacy dependencies`; README and agents mention gateway/direct/flat surfaces and legacy removal | ✅ COMPLIANT |

**Compliance summary**: 9/10 scenario groups compliant, 1/10 partial due no full live MCP server call from verify.

---

## Correctness (Static — Structural Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| Explicit approved adapter loading | ✅ Implemented | `src/runtime/child-mcp-adapter.ts` reads the deterministic approved package manifest, validates `name === pi-mcp-adapter`, normalizes manifest extension entries, rejects escapes/missing files, and de-duplicates paths. |
| Preserve `--no-extensions` | ✅ Implemented | `src/runtime/child-launch.ts` still unconditionally includes `--no-extensions`; extensions are explicit `--extension` args only. |
| Adapter absence fallback | ✅ Implemented | Resolver catches absent/unreadable/invalid manifest and returns `[]`; launch planning continues with runtime extension only. |
| Gate broad `mcp` | ✅ Implemented | `CHILD_MCP_GATEWAY_TOOLS = ["mcp"]` is separate from Lore direct tool names; `startDelegation()` adds it only when approved adapter resolution returns extension paths. |
| Keep direct/flat Lore tool names | ✅ Implemented | `MCP_LORE_MEMORY_TOOLS` includes flat compatibility names and observed `lore_lore_*` names; `lore_lore_memory_update` remains excluded. |
| Exclude parent-only tools | ✅ Implemented | `expandAgentTools()` filters runtime parent-only tools; tests cover `delegate`, `delegation_read`, and `delegation_list` absence. |
| Prompt/docs contract | ✅ Implemented | README and all shipped agent prompts document explicit adapter loading, gateway call shape, direct/flat compatibility, OpenSpec fallback, save/upsert semantics, and no `lore-memory.ts` dependency. |

---

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Adapter resolver in `src/runtime/child-mcp-adapter.ts` | ✅ Yes | Constants and manifest-based extension resolution were implemented. |
| Deterministic installed package discovery | ✅ Yes | Uses `~/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter/package.json`; settings-based discovery was optional and not required. |
| Normalize and de-duplicate entries | ✅ Yes | Resolver and child launch both de-dupe. |
| Missing/invalid adapter should not fail launch | ✅ Yes | Resolver returns `[]`; tests and smoke cover absent adapter. |
| Separate `mcp` gateway allowlist | ✅ Yes | `CHILD_MCP_GATEWAY_TOOLS` is distinct from Lore direct tools and gated by adapter presence. |
| File change table | ✅ Yes | Runtime, prompt/doc, test, and OpenSpec task/apply artifacts match the design scope. |

---

## Issues Found

**CRITICAL**: None.

**WARNING**:
- The MCP-only live server-call scenario was not fully executed from verify; verification used focused tests plus prepared child launch evidence for capability exposure. This is acceptable for archive if the orchestrator does not require a live model-backed smoke.

**SUGGESTION**:
- Future work should narrow the broad `mcp` gateway to direct Lore-only tools or server-level policy once that path is reliable.
- `startDelegation()` calls the adapter resolver directly and via `discoverChildExtensions()`; this is harmless because paths are de-duplicated, but could be simplified later.

---

## Verdict

PASS WITH WARNINGS

The implementation matches the approved spec/design/tasks, focused tests and typecheck pass, child isolation is preserved, the approved MCP adapter is explicitly loaded when present, adapter absence remains non-blocking, `mcp` is deliberately gated, and prompts/docs prefer MCP/Lore Memory before OpenSpec without depending on legacy `lore-memory.ts`.
