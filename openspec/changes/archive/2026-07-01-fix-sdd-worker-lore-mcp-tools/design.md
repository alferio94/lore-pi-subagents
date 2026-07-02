# Design: Fix SDD Worker Lore MCP Tools

## Technical Approach

Use the existing child isolation model (`--no-extensions`, explicit `--tools`, child runtime registering only `contact_supervisor`) and fix the broken Lore contract by expanding the child tool allowlist plus updating prompts/docs/tests. No wrapper tools will be introduced in this slice. The design is based on `exploration.md`, `proposal.md`, and code inspection; no delta spec exists yet. Persistence note: this worker has no Lore MCP save tool exposed, so this design is persisted via OpenSpec fallback.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Constants location | Keep child Lore tool constants in `src/runtime/delegations.ts`; split into `FLAT_LORE_MCP_TOOLS`, `OBSERVED_PREFIXED_LORE_MCP_TOOLS`, and exported `MCP_LORE_MEMORY_TOOLS = [...flat, ...prefixed]`. | Move to contract JSON; duplicate in extension. | This is runtime launch behavior, not install metadata. Keeping the exported aggregate minimizes test/import churn while making prefix assumptions visible. |
| Allowlist additions | Add exactly `lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`, `lore_lore_project_list`, `lore_lore_project_context`, `lore_lore_project_activity`. Keep existing flat `lore_memory_*` entries for compatibility. Do not add `lore_lore_memory_update`. | Replace flat names; add every possible Lore tool; include `project_get`. | Minimal robust fix for observed MCP names. Avoids granting unobserved operations and avoids depending on absent update. |
| Wrapper aliases | Do not expose wrappers now. Whitelist observed MCP names directly and update prompts to recognize harness-prefixed MCP names. | Child `lore_memory_*` wrapper aliases that dispatch to MCP. | Wrappers would need reliable MCP discovery/dispatch in `src/extension/index.ts`, increasing surface area and weakening child isolation. Direct allowlisting is enough for the reported failure; wrapper/discovery can be a later portability change. |
| Prompt contract | Update `agents/*.md` and README to prefer Lore MCP tools by active tool description/name, mention harness prefixes, use project activity/context/search previews correctly, and persist with `memory_save` topic-key upsert. | Keep flat-only prompt guidance. | Child behavior must match the tools actually exposed. Prompts must not require deprecated `lore-memory.ts` or `memory_update`. |

## Data Flow

```text
parent delegate tool
  └─ startDelegation()
      ├─ agent.tools + MCP_LORE_MEMORY_TOOLS + contact_supervisor
      └─ launchChildProcess()
          ├─ pi --no-extensions --extension src/extension/index.ts --tools <allowlist>
          └─ child agent uses available Lore MCP name or OpenSpec fallback
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/runtime/delegations.ts` | Modify | Define flat and observed-prefixed Lore MCP constants; aggregate into child allowlist; update comments away from flat-only naming. |
| `src/runtime/child-launch.ts` | No behavior change | Preserve explicit `--tools` and `--no-extensions`; tests document the interaction. |
| `src/extension/index.ts` | No wrapper behavior | Keep child runtime limited to `contact_supervisor`. |
| `agents/*.md` | Modify | Replace flat-only memory guidance with MCP-prefix-aware guidance; remove `memory_update` requirements. |
| `README.md` | Modify | Document supported child Lore surfaces, no deprecated `lore-memory.ts`, and child isolation. |
| `test/delegations.test.ts` | Modify/Add | Lock allowlist contents and parent-only exclusion. |
| `test/extension.test.ts` | Modify/Add | Lock prompt guidance and delegate launch `--tools` list. |
| `test/child-launch.test.ts` | Modify/Add | Keep `--no-extensions` plus explicit tools invariant. |

## Interfaces / Contracts

```ts
export const FLAT_LORE_MCP_TOOLS = ["lore_memory_search", "lore_memory_get", "lore_memory_save", "lore_memory_update", "lore_memory_list_projects", "lore_memory_list_skills"] as const;
export const OBSERVED_PREFIXED_LORE_MCP_TOOLS = ["lore_lore_memory_search", "lore_lore_memory_get", "lore_lore_memory_save", "lore_lore_project_list", "lore_lore_project_context", "lore_lore_project_activity"] as const;
export const MCP_LORE_MEMORY_TOOLS = [...FLAT_LORE_MCP_TOOLS, ...OBSERVED_PREFIXED_LORE_MCP_TOOLS] as const;
```

Prompt contract: workers MAY use flat or harness-prefixed Lore MCP tools that are actually exposed; MUST use `memory_save` upsert for persistence; MUST fall back to OpenSpec when no usable Lore save/get/search surface exists.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Allowlist includes flat + observed prefixed tools, no `lore_lore_memory_update`, no parent tools. | Update `expandAgentTools` tests and add uniqueness assertions. |
| Launch integration | Child `--tools` contains agent tools, flat tools, observed prefixed tools, then `contact_supervisor`; no `delegate*`. | Update fake-Pi inspection test. |
| Prompt/docs | Builtin prompts and README mention prefix-aware Lore MCP usage, save/upsert, no deprecated extension, no required update. | Regex assertions in prompt/doc tests. |
| Isolation | Child runtime still registers only `contact_supervisor`; `--no-extensions` remains. | Existing extension/child-launch tests plus explicit assertions. |

## Migration / Rollout

No migration required. Ship as a runtime/prompt/docs/test update. Rollback is reverting the same files; OpenSpec fallback remains available.

## Open Questions

None.
