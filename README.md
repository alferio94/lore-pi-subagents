# lore-pi-runtime

Greenfield Pi package scaffold for Lore-native delegation.

## Current slice
- Pi-installable package manifest
- Builtin markdown agents under `agents/`
- Frontmatter parser and merged agent discovery for builtin, user, and project agents
- Native `delegate`, `delegation_read`, and `delegation_list` runtime with persisted run records
- Child-only `contact_supervisor` escalation hook
- Global Lore model routing UI backed only by `~/.pi/agent/lore/models.json`
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
- Child agents must return a single strict JSON envelope, including `skill_resolution`, so persisted runs remain machine-readable.
