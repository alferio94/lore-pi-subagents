# lore-pi-runtime

Greenfield Pi package scaffold for Lore-native delegation.

## Current slice
- Pi-installable package manifest
- Builtin markdown agents under `agents/`
- Frontmatter parser and merged agent discovery for builtin, user, and project agents
- Native `delegate`, `delegation_read`, and `delegation_list` runtime with persisted run records
- Child-only `contact_supervisor` escalation hook
- Global Lore model routing UI backed only by `~/.pi/agent/lore/models.json`, now using a step-by-step route → model → thinking → save flow
- Strict JSON envelope parsing for worker and SDD child results

## Install locally in Pi
```bash
pi install /Users/alfonsocarmona/personal/lore2/lore-pi-runtime
```

## Test
```bash
npm test
```

## Notes
- Parent runtimes expose `delegate`, `delegation_read`, and `delegation_list`; child runtimes expose only `contact_supervisor`.
- Global Lore model routing is reserved for `~/.pi/agent/lore/models.json`; project-local `.pi/lore/models.json` overrides are ignored.
- `/lore-models` edits one routing target at a time: choose default/agent, then model, then thinking, then save or back out.
- `delegation_list` now returns readable per-run id/agent/status/summary/updatedAt lines, and `delegation_read` points to persisted raw/stderr files when a child response is malformed.
- Child agents must return a single strict JSON envelope, including `skill_resolution`, so persisted runs remain machine-readable.
