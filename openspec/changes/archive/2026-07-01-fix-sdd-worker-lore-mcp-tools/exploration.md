## Exploration: fix-sdd-worker-lore-mcp-tools

### Current State
- Delegated Pi children are launched from `src/runtime/delegations.ts` through `launchChildProcess()` in `src/runtime/child-launch.ts` with `--no-extensions` and an explicit `--tools` allowlist, so the child tool surface is whatever the runtime names there plus the runtime extension's child-only `contact_supervisor` tool.
- The runtime currently hardcodes `MCP_LORE_MEMORY_TOOLS` as flat names like `lore_memory_search`, `lore_memory_get`, `lore_memory_save`, `lore_memory_update`, `lore_memory_list_projects`, and `lore_memory_list_skills`.
- Repository prompts and tests are aligned to that same flat `lore_memory_*` assumption. README and shipped agent prompts teach `lore_memory_*` as the canonical child Lore surface.
- The reported active Lore MCP server exposes harness-prefixed names instead: `lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`, `lore_lore_project_list`, `lore_lore_project_context`, `lore_lore_project_activity`, etc. It does not expose `lore_lore_memory_update`.
- Because child launch whitelists exact tool names, a mismatch between runtime allowlist/prompt expectations and actual MCP-exposed names can leave child SDD agents without usable Lore persistence tools even though Lore is available in the parent runtime.
- In this repository checkout there is no available Lore memory tool surface in the current worker environment, so this exploration artifact is persisted via OpenSpec fallback only.

### Affected Areas
- `src/runtime/delegations.ts` — source of the child memory tool allowlist and system-prompt contract injection.
- `src/runtime/child-launch.ts` — enforces explicit `--tools` child exposure and disables ambient extensions.
- `src/extension/index.ts` — child runtime registers only `contact_supervisor`; it does not create Lore wrapper aliases.
- `agents/*.md` — shipped worker/SDD prompts currently teach the flat `lore_memory_*` surface and specific schemas.
- `README.md` — documents the old child Lore tool surface.
- `test/delegations.test.ts`, `test/extension.test.ts` — lock in current flat tool-name assumptions and deprecated expectations such as `memory_update`/`list_projects` naming.
- `pi-runtime.contract.json` — not the tool list itself, but part of the runtime contract story that should stay consistent with prompt/runtime behavior.

### Approaches
1. **Whitelist harness-prefixed MCP tool names directly** — Replace or expand the hardcoded child Lore allowlist to the actual active MCP-exposed names such as `lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`, `lore_lore_project_list`, `lore_lore_project_context`, and `lore_lore_project_activity`.
   - Pros: Small runtime change; matches the observed active server surface; preserves direct MCP usage in children.
   - Cons: Bakes one harness prefix into runtime code; may break on other harnesses/server aliases; still leaves prompts/tests needing updates; requires handling missing `memory_update`.
   - Effort: Low.

2. **Expose runtime wrapper aliases for a canonical child Lore API** — Keep child prompts/protocol stable around a canonical Lore API, but implement wrapper tools in the runtime extension that translate to whichever Lore MCP names are present in the active harness.
   - Pros: Decouples worker prompts from harness-specific prefixes; gives one runtime-owned compatibility layer; can adapt unsupported operations like missing `memory_update` deliberately.
   - Cons: More implementation surface; requires tool discovery/dispatch logic inside the extension; must avoid mixing incompatible schemas silently.
   - Effort: Medium/High.

3. **Combination: runtime supports both detection and prompt updates** — Make the runtime/tooling treat Lore MCP names as the real backend, pass through the names actually available to children, and update prompts/tests/docs so workers recognize MCP Lore tools as valid Lore mode without depending on native `lore_*` extensions.
   - Pros: Best fit to the observed failure: both exposure and protocol assumptions are wrong today; reduces future OpenSpec fallback when Lore MCP is present; lets proposal decide whether direct names or wrappers are the better mechanism.
   - Cons: Broader change touching runtime, prompts, docs, and tests; still needs a concrete compatibility strategy for varying MCP prefixes and missing operations.
   - Effort: Medium.

### Recommendation
Favor the combination path. The core problem is not just missing whitelist entries; it is a contract mismatch across runtime allowlisting, shipped prompts, and tests. Proposal work should center on making delegated workers treat Lore MCP tools as the valid Lore backend, then choose one of two implementation tactics: either pass through the actual MCP-exposed names dynamically, or provide runtime-owned wrapper aliases if stable canonical names are required. Directly hardcoding only `lore_lore_*` names looks expedient but is the least portable option unless the runtime explicitly decides to target that harness only.

### Risks
- Hardcoding one MCP namespace prefix may fail in other harnesses or future Lore server registrations.
- Prompt guidance currently encodes schemas that already drift from the observed server surface (`memory_update` absent, project tools renamed/exposed separately).
- Wrapper aliases could hide backend capability gaps unless unsupported operations fail explicitly.
- Lore persistence mode detection may still fall back incorrectly if detection logic keys off legacy/native names instead of actual MCP availability.
- Updating runtime allowlists without updating tests/docs/prompts will leave the contract internally inconsistent.

### Ready for Proposal
Yes — the problem statement and solution space are clear enough for a proposal focused on child Lore MCP exposure, backend detection, and prompt/test contract alignment.