## Exploration: fix-child-mcp-adapter-loading

### Current State
- Child delegations are launched from `src/runtime/delegations.ts` through `launchChildProcess()` in `src/runtime/child-launch.ts` with `pi --mode json -p --no-session --no-extensions` plus explicit `--extension` and `--tools` flags.
- `discoverChildExtensions()` currently returns only this package runtime extension (`src/extension/index.ts`). It does not discover or add installed Pi extensions such as `pi-mcp-adapter`.
- `startDelegation()` always appends `MCP_LORE_MEMORY_TOOLS` to the child tool allowlist, but those names only matter if the extension that registers them is loaded.
- The installed MCP adapter package at `~/.pi/agent/git/github.com/nicobailon/pi-mcp-adapter` declares `pi.extensions: ["./index.ts"]`; its `index.ts` registers the MCP gateway tool `mcp`, and may also register direct MCP tools from metadata cache when configured.
- Because child launch uses `--no-extensions`, ambient discovery is intentionally disabled. Without explicitly loading the MCP adapter extension, the child never receives `mcp` or any direct MCP tools, so Lore MCP access is absent even if names were added to the allowlist.
- This makes the previous `fix-sdd-worker-lore-mcp-tools` change insufficient for live MCP-only delegation after restart/resume: it fixed tool-name compatibility inside the allowlist/prompt contract, but not extension loading.
- In this worker environment no Lore MCP save tool is exposed, so persistence is done via OpenSpec fallback at `openspec/changes/fix-child-mcp-adapter-loading/exploration.md`.

### Affected Areas
- `src/runtime/delegations.ts` — child tool allowlist construction and child extension discovery entrypoint.
- `src/runtime/child-launch.ts` — enforces `--no-extensions`, explicit `--extension`, and explicit `--tools`.
- `src/extension/index.ts` — child runtime remains intentionally limited to `contact_supervisor`; should not absorb MCP adapter behavior.
- `test/delegations.test.ts` — current coverage assumes only runtime extension autoload and Lore tool-name allowlisting.
- `test/child-launch.test.ts` — coverage for explicit child args; likely needs assertions for added adapter extension/tool serialization.
- `test/extension.test.ts` — launch integration test already inspects child `--tools`; likely needs coverage for `mcp` and extension paths.
- `README.md` and agent prompts (`agents/*.md`) — should match the actual child MCP exposure model and fallback conditions.

### Approaches
1. **Explicitly load the installed MCP adapter in child launch** — extend child extension discovery to include the installed `pi-mcp-adapter` entrypoint, while keeping `--no-extensions`.
   - Pros: Fixes the real root cause; preserves explicit child isolation; keeps parent ambient extensions disabled.
   - Cons: Needs robust resolution of the adapter install path and failure handling when absent.
   - Effort: Medium.

2. **Also allow the `mcp` gateway tool for children that need Lore MCP** — add `mcp` to the child allowlist when the adapter is loaded.
   - Pros: Smallest viable way to expose Lore MCP through the adapter without requiring direct-tool registration.
   - Cons: `mcp` is a broad gateway; once exposed, a child can search/call any configured MCP server, not just Lore.
   - Effort: Low/Medium.

3. **Load adapter and configure/narrow direct Lore tools** — use adapter direct-tool support so children receive only specific Lore tools instead of the broad `mcp` gateway.
   - Pros: Stronger least-privilege story; better matches existing explicit tool allowlist model.
   - Cons: More moving parts: cache/config dependence, `MCP_DIRECT_TOOLS`/adapter behavior, possible restart/bootstrap edge cases.
   - Effort: Medium/High.

4. **Generic package-extension discovery from installed Pi packages** — detect installed packages with `package.json.pi.extensions` and selectively add approved extension entrypoints to child launch.
   - Pros: More future-proof than hardcoding one adapter path.
   - Cons: Larger surface and policy complexity; risks drifting toward ambient extension loading if not tightly scoped.
   - Effort: High.

### Recommendation
Prefer a minimal safe follow-up centered on explicit adapter loading plus explicit tool gating:
- Keep `--no-extensions`.
- Extend `discoverChildExtensions()` (or equivalent child-launch planning) to add the installed `pi-mcp-adapter` extension explicitly when present and approved.
- Add `mcp` to the child allowlist only for flows that require Lore MCP access, then document that this is a temporary broad gateway unless direct Lore-only tools are later constrained.
- In proposal/spec/design, consider a second slice for tighter scoping via adapter direct tools or a runtime-owned MCP policy layer if broad `mcp` exposure is too permissive.

This is the smallest change that addresses the observed live failure without re-enabling ambient extension discovery or loading unrelated parent extensions.

### Risks
- Exposing `mcp` gives child agents access to all configured MCP servers unless additional filtering is added.
- Hardcoding one installed adapter path may be brittle across installations or package layout changes.
- Generic extension discovery can accidentally widen child capabilities if the approval policy is underspecified.
- Direct-tool narrowing depends on adapter cache/config state; first-run or stale-cache behavior could still leave children without Lore tools.
- Prompt/docs/tests can drift again if runtime behavior changes without matching contract updates.

### Ready for Proposal
Yes — the failure mechanism is clear, the isolation constraints are explicit, and there is a reasonable minimal strategy to propose: explicit adapter loading under `--no-extensions`, explicit child tool gating, and test/doc updates that reflect the actual MCP exposure path.
