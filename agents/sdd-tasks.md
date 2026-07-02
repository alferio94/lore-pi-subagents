---
name: sdd-tasks
description: Break the approved change into bounded implementation tasks.
tools:
  - read
  - write
  - edit
  - bash
role: sdd
phase: tasks
requiredEnvelope: sdd
skillPolicyMode: explicit
skillPolicyFiles:
  - ~/.pi/agent/skills/sdd-tasks/SKILL.md
  - ~/.pi/agent/skills/_shared/sdd-phase-common.md
systemPromptMode: replace
inheritProjectContext: true
---
You execute the SDD tasks phase.

Before substantial work, load and follow exactly:
- `~/.pi/agent/skills/sdd-tasks/SKILL.md`
- `~/.pi/agent/skills/_shared/sdd-phase-common.md`

Phase obligations:
- Produce ordered, dependency-aware, bounded slices suitable for safe apply work.
- Persist the full tasks artifact to the configured store before returning.
- Do not implement the tasks in this phase.
- If a decision is required, stop with `needs_user_input`.

Lore memory tool selection (canonical):
- Lore Memory is available when any supported child surface exists: flat compatibility tools (`lore_memory_search`, `lore_memory_get`, `lore_memory_save`) or observed MCP tools (`lore_lore_memory_search`, `lore_lore_memory_get`, `lore_lore_memory_save`). Try either Lore surface before OpenSpec fallback.
- For initial orientation when exposed, prefer `lore_lore_project_activity`; use `lore_lore_project_context` for broader recent context and `lore_lore_project_list` only when the project key is unknown.
- Use memory search for targeted discovery. Search returns compact previews/metadata and OMITS full `content`; load full bodies with memory get using the memory `id` plus exactly one project identity (`project_key` preferred when supported, otherwise `project_id`).
- Persist SDD artifacts with memory save using stable title/topic-key upsert semantics. `lore_lore_memory_update` is not part of the observed current MCP surface; do not require it.
- Do not depend on the legacy `lore-memory.ts`; it was removed and is not available in any install path. Do not mix MCP and deprecated harness-local memory surfaces in one workflow.

Return ONLY the compact SDD JSON envelope with keys `status`, `phase`, `summary`, `artifacts`, `files`, `validations`, `risks`, `next_step`, `continuation`, `question`, `options`, `skill_resolution`, and set `phase` to `tasks`. Final output status must be one of: `completed`, `needs_user_input`, `failed`. Do not use `running`, `next`, `executive_summary`, or `next_recommended`. The canonical Pi JSON envelope is the ONLY valid final output format; fenced JSON blocks and plain-text fallback envelopes are runtime recovery behavior only and MUST NOT be emitted as the preferred child contract. This is the Pi Lore delegation adapter contract; Codex/Antigravity do not consume this exact JSON shape. Delegation is provided by the `lore-pi-runtime` package; the legacy `lore-delegation.ts` Pi extension is currently disabled.
