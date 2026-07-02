# Proposal: Fix SDD Worker Lore MCP Tools

## Intent

Delegated SDD workers should persist artifacts to Lore when Lore MCP tools are available. Today child launch uses `--no-extensions` plus an explicit allowlist of legacy flat `lore_memory_*` names, while the active MCP server exposes `lore_lore_*` names. Workers therefore fall back to OpenSpec.

## Scope

### In Scope
- Expose minimal observed Lore MCP persistence/project tools to children.
- Preserve flat `lore_memory_*` compatibility where supported.
- Update SDD prompts/protocol/tests/docs so MCP Lore tools are valid Lore backends.
- Handle absent `memory_update` via save/upsert semantics or explicit unsupported-operation behavior.

### Out of Scope
- Re-enabling legacy `lore-memory.ts` or deprecated Pi extension dependencies.
- Adding parent-only delegation tools to child workers.
- Full MCP tool discovery redesign.

## Capabilities

### New Capabilities
- `sdd-worker-lore-mcp-persistence`: Delegated SDD workers use available Lore MCP memory/project tools for artifact retrieval and persistence.

### Modified Capabilities
None.

## Approach

Expand the child Lore allowlist to include observed MCP names: `lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`, plus project tools such as `lore_lore_project_activity`, `lore_lore_project_context`, `lore_lore_project_get`, and `lore_lore_project_list`. Keep existing flat `lore_memory_*` entries for compatibility. Update injected SDD guidance to prefer MCP Lore tools, recognize harness-prefixed names, avoid `memory_update`, and use OpenSpec only when no usable Lore surface exists. Update tests/docs to lock the dual-name contract and child-only boundary.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/runtime/delegations.ts` | Modified | Child Lore allowlist and injected protocol text |
| `src/runtime/child-launch.ts` | Modified | Preserve intentional `--no-extensions` plus explicit tools behavior |
| `agents/*.md` | Modified | MCP Lore backend guidance |
| `README.md` | Modified | Supported child Lore tool surfaces |
| `test/*.test.ts` | Modified | MCP-prefixed tools, flat compatibility, absent update |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Hardcoded `lore_lore_*` prefix is not portable | Med | Keep flat compatibility; document observed prefix; defer discovery/wrappers |
| `--no-extensions` hides legacy/native tools | High | Treat MCP allowlist as authoritative child surface |
| `memory_update` absent | High | Use `memory_save` topic-key upsert or fail explicitly |
| Parent-only delegation tools leak into children | Low | Add only Lore memory/project tools plus `contact_supervisor` |

## Rollback Plan

Revert runtime allowlist, prompts, docs, and tests. OpenSpec fallback remains functional.

## Dependencies

- Active Lore MCP server exposing observed `lore_lore_*` memory/project tools.
- No dependency on legacy `lore-memory.ts`.

## Success Criteria

- [ ] Delegated SDD workers receive usable Lore MCP persistence tools when available.
- [ ] Flat `lore_memory_*` compatibility remains tested.
- [ ] Prompts/docs do not require deprecated extensions or `memory_update`.
- [ ] Tests prevent parent-only delegation tools from being added to children.
