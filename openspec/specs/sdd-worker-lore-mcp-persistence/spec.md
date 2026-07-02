# sdd-worker-lore-mcp-persistence Specification

## Purpose

Delegated SDD workers persist and retrieve SDD artifacts through available Lore MCP memory/project tools before falling back to OpenSpec, while keeping child tool exposure minimal.

## Persistence Note

This spec was persisted via OpenSpec fallback because this worker's active tool surface exposed no usable Lore MCP memory save tool.

## Requirements

### Requirement: Lore MCP Backend Recognition

The runtime and SDD worker prompts MUST treat observed Lore MCP memory tools as a valid Lore backend when `lore_lore_memory_search`, `lore_lore_memory_get`, and `lore_lore_memory_save` are exposed to the child.

#### Scenario: MCP Lore selected before OpenSpec
- GIVEN a delegated SDD child has the observed `lore_lore_memory_*` tools
- WHEN the child determines artifact persistence mode
- THEN it MUST use Lore persistence
- AND it MUST NOT fall back to OpenSpec solely because flat `lore_memory_*` names are absent

#### Scenario: No usable save tool
- GIVEN a child has no Lore MCP or flat memory save tool
- WHEN it persists an SDD artifact
- THEN it MUST use OpenSpec fallback
- AND it MUST state the missing Lore tool evidence in its compact result or artifact note

### Requirement: Dual Lore Tool Name Compatibility

Delegated SDD child launch MUST allow both existing flat compatibility names and observed MCP-prefixed Lore tool names for memory retrieval, memory save, and project orientation.

#### Scenario: Flat compatibility remains valid
- GIVEN a child environment exposes `lore_memory_search`, `lore_memory_get`, and `lore_memory_save`
- WHEN an SDD phase reads or writes Lore artifacts
- THEN the worker MUST be able to complete using those flat names

#### Scenario: Observed MCP names are valid
- GIVEN a child environment exposes `lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`, `lore_lore_project_activity`, `lore_lore_project_context`, and `lore_lore_project_list`
- WHEN an SDD phase performs project orientation and artifact persistence
- THEN the worker MUST be able to use those MCP-prefixed names without legacy extensions

### Requirement: Save-Based Upsert Without Memory Update

SDD Lore persistence MUST NOT require `memory_update`; it SHALL use memory save with stable topic keys as the supported upsert mechanism, or explicitly report unsupported backend capability.

#### Scenario: Update tool absent
- GIVEN Lore MCP exposes memory save but no `lore_lore_memory_update`
- WHEN a worker persists `sdd/{change}/spec`
- THEN it MUST save with the stable topic key
- AND it MUST NOT fail merely because memory update is unavailable

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

### Requirement: No Legacy Lore Extension Dependency

Delegated SDD Lore persistence MUST NOT depend on the deprecated `lore-memory.ts` extension or ambient child extensions. Under `--no-extensions`, an approved MCP adapter MAY be loaded only by explicit extension arguments, and this SHALL NOT re-enable ambient discovery.

#### Scenario: Child launched with extensions disabled
- GIVEN child launch uses extension isolation
- WHEN the approved MCP adapter is explicitly loaded
- THEN SDD Lore retrieval and persistence MUST remain available through allowed MCP access
- AND unrelated ambient extensions MUST remain unavailable

### Requirement: Child Tool Isolation

The child tool surface MUST expose only required child-safe tools, including `contact_supervisor`, Lore memory/project tools, and the `mcp` gateway when the approved MCP adapter is explicitly loaded for Lore-needed work. It MUST NOT expose parent-only delegation tools.

#### Scenario: Delegation tools stay unavailable
- GIVEN an SDD child is launched for any phase
- WHEN its explicit tool list is inspected
- THEN `delegate`, `delegation_read`, and `delegation_list` MUST be absent
- AND `mcp` MAY be present only when the approved adapter is explicitly loaded and gated for Lore-needed work

### Requirement: Contract Coverage in Tests, Docs, and Prompts

Tests, documentation, and injected SDD guidance MUST describe MCP Lore as a valid backend, preserve flat-name compatibility, document absent `memory_update`, and define OpenSpec fallback conditions.

#### Scenario: Regression coverage blocks old fallback bug
- GIVEN automated tests cover child tool allowlisting and backend detection
- WHEN only observed `lore_lore_*` Lore MCP tools are available
- THEN tests MUST assert Lore mode is selected before OpenSpec fallback

#### Scenario: User-facing guidance matches runtime
- GIVEN a worker reads shipped SDD prompt/protocol documentation
- WHEN it chooses how to retrieve and persist artifacts
- THEN the guidance MUST mention both flat and observed MCP-prefixed names
- AND it MUST prohibit relying on the legacy extension
