# Delta for sdd-worker-lore-mcp-persistence

## Persistence Note

OpenSpec fallback was used because this worker exposes no Lore MCP memory save tool. The spec artifact is persisted at this change-scoped path.

## ADDED Requirements

### Requirement: Explicit MCP Adapter Loading Under Child Isolation

Delegated child launch MUST preserve `--no-extensions` and MUST explicitly load approved MCP adapter extension entrypoints when the adapter is installed/configured and the child needs Lore MCP access. The system MUST NOT ambient-load arbitrary parent extensions.

#### Scenario: Adapter loaded explicitly

- GIVEN an approved MCP adapter package is installed and configured
- WHEN a Lore-needed SDD child is launched
- THEN launch args MUST keep `--no-extensions`
- AND include the resolved adapter extension entrypoint explicitly

#### Scenario: Adapter absent does not block launch

- GIVEN the approved MCP adapter package or config is absent
- WHEN a delegated child is launched
- THEN launch MUST NOT fail solely due to the missing optional adapter
- AND the child MAY use the existing OpenSpec fallback path

### Requirement: MCP Gateway Availability and Compatibility

When adapter loading is selected and the adapter registers `mcp`, child launch MUST include `mcp` in the explicit tool allowlist. Existing flat Lore tool names and MCP-prefixed Lore tool names MUST remain allowed for compatibility. Broad `mcp` gateway access MUST be documented as intentional for this change; future work SHOULD narrow to direct Lore-only tools when reliable direct tools are available.

#### Scenario: MCP-only worker report succeeds

- GIVEN the child has the loaded adapter and the allowed `mcp` gateway but no direct Lore tools
- WHEN the worker performs an MCP-only report or persistence check
- THEN it MUST be able to call the configured MCP gateway successfully
- AND it MUST NOT fail with a missing-MCP-tool error

#### Scenario: Existing Lore names still allowed

- GIVEN flat `lore_memory_*` or MCP-prefixed `lore_lore_memory_*` tools are exposed
- WHEN an SDD child retrieves or saves artifacts
- THEN those names MUST remain usable without requiring renamed prompts

## MODIFIED Requirements

### Requirement: No Legacy Lore Extension Dependency

Delegated SDD Lore persistence MUST NOT depend on the deprecated `lore-memory.ts` extension or ambient child extensions. Under `--no-extensions`, an approved MCP adapter MAY be loaded only by explicit extension arguments, and this SHALL NOT re-enable ambient discovery.
(Previously: persistence prohibited legacy and ambient extension dependency but did not define the explicit MCP adapter exception.)

#### Scenario: Child launched with extensions disabled

- GIVEN child launch uses extension isolation
- WHEN the approved MCP adapter is explicitly loaded
- THEN SDD Lore retrieval and persistence MUST remain available through allowed MCP access
- AND unrelated ambient extensions MUST remain unavailable

### Requirement: Child Tool Isolation

The child tool surface MUST expose only required child-safe tools, including `contact_supervisor`, Lore memory/project tools, and the `mcp` gateway when the approved MCP adapter is explicitly loaded for Lore-needed work. It MUST NOT expose parent-only delegation tools.
(Previously: child-safe tools included Lore memory/project tools and `contact_supervisor`, with no explicit `mcp` gateway allowance.)

#### Scenario: Delegation tools stay unavailable

- GIVEN an SDD child is launched for any phase
- WHEN its explicit tool list is inspected
- THEN `delegate`, `delegation_read`, and `delegation_list` MUST be absent
- AND `mcp` MAY be present only when the approved adapter is explicitly loaded and gated for Lore-needed work
