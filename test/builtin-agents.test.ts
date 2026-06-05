import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SDD_PHASES, SKILL_RESOLUTIONS } from "../src/runtime/envelopes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.resolve(here, "../agents");

function loadAgent(name: string): { frontmatter: Record<string, string>; body: string; raw: string } {
  const filePath = path.join(agentsDir, `${name}.md`);
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`agent ${name}.md is missing YAML frontmatter`);
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2], raw };
}

const FORBIDDEN_CANONICAL_FIELD_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "old next-only worker key list", pattern: /exactly these keys: `status`, `summary`, `artifacts`, `next`, /i },
  { name: "old next+SDD key list", pattern: /envelope with keys `status`, `phase`, `summary`, `artifacts`, `next`, /i },
  { name: "old next+continuation key list", pattern: /exactly these keys: `status`, `summary`, `artifacts`, `next`, `continuation`, /i },
  { name: "old status-with-running pattern", pattern: /`status`: `completed` \| `running` \| `needs_user_input` \| `failed`/i },
  { name: "old final-status-with-running pattern", pattern: /final status must be one of: `completed`, `running`, `needs_user_input`, `failed`/i },
  { name: "old final-running wording", pattern: /`status` must be one of: completed, running, needs_user_input, failed/i },
];

const CANONICAL_SDD_FIELD_LIST = "Return ONLY the compact SDD JSON envelope with keys `status`, `phase`, `summary`, `artifacts`, `files`, `validations`, `risks`, `next_step`, `continuation`, `question`, `options`, `skill_resolution`";
const CANONICAL_SDD_FINAL_STATUS_BULLET = "Final output status must be one of: `completed`, `needs_user_input`, `failed`";
const PI_ADAPTER_LABEL_SDD = "This is the Pi Lore delegation adapter contract";
const PI_ADAPTER_LABEL_WORKER = "This is the Pi Lore delegation adapter final child envelope";
const RUNTIME_OWNERSHIP = "Delegation is provided by the `lore-pi-runtime` package";
const DO_NOT_USE_OBSOLETE = "Do not use `running`, `next`, `executive_summary`, or `next_recommended`";

const ALL_AGENT_NAMES = [
  "lore-worker",
  "sdd-init",
  "sdd-explore",
  "sdd-propose",
  "sdd-spec",
  "sdd-design",
  "sdd-tasks",
  "sdd-apply",
  "sdd-verify",
  "sdd-archive",
] as const;

// Phase name in the body can be either the canonical SDD_PHASES value (e.g. "proposal") or the
// render-time mapped form (e.g. "propose" for the proposal phase per the existing design
// `renderSDDPhaseName(PhaseProposal) = "propose"` mapping in `managed_defaults.go`). The frontmatter
// `phase:` value is the canonical body phase value.
const PHASE_TO_AGENT = new Map<string, string>([
  ["init", "sdd-init"],
  ["explore", "sdd-explore"],
  ["proposal", "sdd-propose"],
  ["spec", "sdd-spec"],
  ["design", "sdd-design"],
  ["tasks", "sdd-tasks"],
  ["apply", "sdd-apply"],
  ["verify", "sdd-verify"],
  ["archive", "sdd-archive"],
]);

// Known render-time aliases used in frontmatter `phase:`. The body example must match this exact
// value, but the value may not appear in `SDD_PHASES` directly. Currently only "propose" is
// the alias for the proposal phase (mapping done in `managed_defaults.go::renderSDDPhaseName`).
const RENDER_TIME_PHASE_ALIASES = new Set<string>(["propose"]);

// Maps a render-time alias to its canonical SDD_PHASES value.
const ALIAS_TO_CANONICAL = new Map<string, string>([
  ["propose", "proposal"],
]);

test("builtin agent files exist and are well-formed for every SDD phase plus lore-worker", () => {
  for (const name of ALL_AGENT_NAMES) {
    const agent = loadAgent(name);
    assert.equal(agent.frontmatter.name, name, `agent ${name}: name frontmatter mismatch`);
    assert.ok(agent.frontmatter.description && agent.frontmatter.description.length > 0, `agent ${name}: missing description`);
    assert.ok(agent.frontmatter.role, `agent ${name}: missing role frontmatter`);
    assert.ok(agent.frontmatter.requiredEnvelope, `agent ${name}: missing requiredEnvelope frontmatter`);
  }
});

test("lore-worker teaches the canonical worker Pi adapter contract and forbids obsolete response fields", () => {
  const agent = loadAgent("lore-worker");
  assert.equal(agent.frontmatter.role, "worker");
  assert.equal(agent.frontmatter.requiredEnvelope, "worker");

  // Worker envelope must not include the `phase` field in the documented key list.
  const workerKeyList = "Return ONLY one JSON object with exactly these keys: `status`, `summary`, `artifacts`, `files`, `validations`, `risks`, `next_step`, `continuation`, `question`, `options`, `skill_resolution`";
  assert.match(agent.body, new RegExp(workerKeyList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(agent.body, /exactly these keys: `status`, `phase`, /);

  // Final status wording excludes `running`. Accept either the explicit "Final output status must be one of:"
  // form (used by `managed_defaults.go`) or the per-bullet "- `status`: `completed` | `needs_user_input` | `failed`" form
  // (used by `lore-worker.md`).
  const finalStatusBullet = /`status`: `completed` \| `needs_user_input` \| `failed`/;
  const finalStatusExplicit = new RegExp(CANONICAL_SDD_FINAL_STATUS_BULLET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.ok(
    finalStatusExplicit.test(agent.body) || finalStatusBullet.test(agent.body),
    "lore-worker body must include either the explicit 'Final output status must be one of: completed | needs_user_input | failed' wording or the per-bullet '`status`: `completed` | `needs_user_input` | `failed`' form",
  );
  // Final status MUST NOT list `running` as a valid final status.
  assert.doesNotMatch(agent.body, /Final output status must be one of: `completed` \| `running` \| `needs_user_input` \| `failed`/);

  // Skill resolution set is the canonical SKILL_RESOLUTIONS list. Accept the bullet form too.
  const skillResolutionBullet = /`skill_resolution`: `injected` \| `fallback-registry` \| `fallback-path` \| `none`/;
  const skillResolutionExplicit = new RegExp(
    "`skill_resolution` must be one of: " + SKILL_RESOLUTIONS.join(", ") + "\\."
  );
  assert.ok(
    skillResolutionBullet.test(agent.body) || skillResolutionExplicit.test(agent.body),
    "lore-worker body must teach all canonical skill_resolution values",
  );

  // Pi adapter contract label + runtime ownership + obsolete-field warning are all present.
  // lore-worker uses the alternate label "This is the Pi Lore delegation adapter final child envelope".
  const workerLabelRegex = new RegExp("(" + PI_ADAPTER_LABEL_SDD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|" + PI_ADAPTER_LABEL_WORKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")");
  assert.match(agent.body, workerLabelRegex, "lore-worker body must include the Pi adapter contract label");
  assert.match(agent.body, new RegExp(RUNTIME_OWNERSHIP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // lore-worker uses a slightly different obsolete-field phrasing; accept either form.
  const workerDoNotUseRegex = new RegExp("(Do not use `running`, `next`, `executive_summary`, or `next_recommended`|Do not use `next`, `executive_summary`, or `next_recommended`)");
  assert.match(agent.body, workerDoNotUseRegex, "lore-worker body must warn against obsolete response fields");

  // No forbidden canonical-field or canonical-status patterns remain.
  for (const { name, pattern } of FORBIDDEN_CANONICAL_FIELD_PATTERNS) {
    assert.doesNotMatch(agent.body, pattern, `lore-worker body contains forbidden ${name} pattern`);
  }
});

test("every SDD phase agent teaches the canonical SDD Pi envelope with the right phase value", () => {
  for (const phase of SDD_PHASES) {
    const agentName = PHASE_TO_AGENT.get(phase);
    assert.ok(agentName, `no agent maps to canonical phase ${phase}`);
    const agent = loadAgent(agentName);

    assert.equal(agent.frontmatter.role, "sdd", `${agentName}: role frontmatter must be sdd`);
    assert.equal(agent.frontmatter.requiredEnvelope, "sdd", `${agentName}: requiredEnvelope must be sdd`);
    assert.ok(agent.frontmatter.phase, `${agentName}: phase frontmatter must be set`);

    // The frontmatter phase is either the canonical SDD_PHASES value or a known render-time alias.
    const canonical = ALIAS_TO_CANONICAL.get(agent.frontmatter.phase) ?? agent.frontmatter.phase;
    assert.equal(
      canonical,
      phase,
      `${agentName}: frontmatter phase \`${agent.frontmatter.phase}\` (canonical \`${canonical}\`) does not match the canonical phase \`${phase}\``,
    );

    // Canonical SDD envelope key list and final-status wording are present.
    const escapedFieldList = CANONICAL_SDD_FIELD_LIST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(agent.body, new RegExp(escapedFieldList), `${agentName}: missing canonical SDD envelope key list`);
    const escapedFinalStatus = CANONICAL_SDD_FINAL_STATUS_BULLET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(agent.body, new RegExp(escapedFinalStatus), `${agentName}: missing canonical final-status wording`);

    // The example phase value in the body matches the frontmatter phase value.
    const examplePattern = new RegExp("set `phase` to `" + agent.frontmatter.phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`");
    assert.match(agent.body, examplePattern, `${agentName}: example phase value mismatch`);

    // Pi adapter contract label, runtime ownership, and obsolete-field warning are present.
    assert.match(agent.body, new RegExp(PI_ADAPTER_LABEL_SDD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(agent.body, new RegExp(RUNTIME_OWNERSHIP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(agent.body, new RegExp(DO_NOT_USE_OBSOLETE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // No forbidden canonical-field or canonical-status patterns remain.
    for (const { name, pattern } of FORBIDDEN_CANONICAL_FIELD_PATTERNS) {
      assert.doesNotMatch(agent.body, pattern, `${agentName} body contains forbidden ${name} pattern`);
    }
  }
});

test("every SDD phase agent body example uses skill_resolution and forbids `next` outside the do-not-use warning", () => {
  for (const phase of SDD_PHASES) {
    const agentName = PHASE_TO_AGENT.get(phase);
    assert.ok(agentName);
    const agent = loadAgent(agentName);

    // The body MUST teach `skill_resolution` somewhere (example shape or runtime-injected section).
    assert.match(agent.body, /`skill_resolution`/, `${agentName}: body must mention \`skill_resolution\``);

    // The body MUST NOT teach `next` as a response-contract field — `next` only appears inside the
    // "do not use" warning or as a substring of `next_step` / `next_recommended`.
    const nextOutsideDoNotUse = extractNextOutsideDoNotUse(agent.body);
    assert.equal(nextOutsideDoNotUse, "", `${agentName}: \`next\` appears in a non-warning context: ${nextOutsideDoNotUse}`);
  }
});

test("every SDD phase agent body example phase value matches its frontmatter phase", () => {
  for (const phase of SDD_PHASES) {
    const agentName = PHASE_TO_AGENT.get(phase);
    assert.ok(agentName);
    const agent = loadAgent(agentName);

    // Extract the example phase value: the value of `set \`phase\` to \`<X>\``.
    const examplePhaseMatch = agent.body.match(/set `phase` to `([^`]+)`/);
    assert.ok(examplePhaseMatch, `${agentName}: body must contain a "set phase to ..." example`);
    const examplePhase = examplePhaseMatch[1];
    // The body example phase must match the frontmatter phase exactly.
    assert.equal(
      examplePhase,
      agent.frontmatter.phase,
      `${agentName}: example phase \`${examplePhase}\` does not match the frontmatter \`${agent.frontmatter.phase}\``,
    );
  }
});

test("builtin agents do not duplicate the response-contract section", () => {
  for (const name of ALL_AGENT_NAMES) {
    const agent = loadAgent(name);
    const isSdd = agent.frontmatter.role === "sdd";
    const contractSnippet = isSdd
      ? CANONICAL_SDD_FIELD_LIST
      : "Return ONLY one JSON object with exactly these keys: `status`, `summary`, `artifacts`, `files`, `validations`, `risks`, `next_step`, `continuation`, `question`, `options`, `skill_resolution`";
    const occurrences = countOccurrences(agent.body, contractSnippet);
    assert.equal(occurrences, 1, `${name}: canonical response-contract key list must appear exactly once (got ${occurrences})`);
  }
});

test("builtin agents explicitly forbid final running in the response contract", () => {
  for (const name of ALL_AGENT_NAMES) {
    const agent = loadAgent(name);
    // The "do not use running" warning must appear in the body. Accept either the explicit
    // "Do not use `running`..." form (SDD agents) or the parenthetical
    // "running is reserved for parent-side transient process state" form (lore-worker). Both
    // teach the model that `running` is not a valid final status.
    const warnsAgainstRunning =
      /Do not use `running`/i.test(agent.body) ||
      /`running` is reserved for parent-side transient process state/i.test(agent.body);
    assert.ok(
      warnsAgainstRunning,
      `${name}: body must warn against using \`running\` in the final response`,
    );
    // The final-status wording in the body must NOT include `running` as a valid final status.
    assert.doesNotMatch(
      agent.body,
      /Final output status must be one of: `completed` \| `running` \| `needs_user_input` \| `failed`/,
      `${name}: final-status wording must not list \`running\``,
    );
    assert.doesNotMatch(
      agent.body,
      /`status`: `completed` \| `running` \| `needs_user_input` \| `failed`/,
      `${name}: per-bullet \`status\` wording must not list \`running\``,
    );
  }
});

function extractContractSection(body: string): string | undefined {
  // Look for either "Return ONLY ... JSON envelope ..." or "## Response contract" header; then keep a
  // window of text after it until the next blank-line-separated section or the next "##" header.
  const start = body.search(/Return ONLY (?:the compact SDD )?JSON envelope|## Response contract/i);
  if (start === -1) return undefined;
  const afterStart = body.slice(start);
  const end = afterStart.indexOf("\n## ");
  if (end === -1) return afterStart;
  return afterStart.slice(0, end);
}

function extractNextOutsideDoNotUse(body: string): string {
  // Find any occurrence of `next` in the body that is NOT inside a "Do not use `next`..." warning.
  // Split the body on the do-not-use warning and look at each chunk.
  const warnings = body.split(/Do not use `running`, `next`, `executive_summary`, or `next_recommended`/i);
  const offending: string[] = [];
  for (let i = 0; i < warnings.length; i++) {
    // Only consider chunks that are NOT adjacent to the do-not-use warning (i.e. outside the
    // do-not-use region). We approximate by examining the surrounding context.
    if (i === 0 || warnings[i].length > 200) {
      // The first chunk is the entire body up to the first do-not-use warning; that is "before" the
      // warning. We allow `next` to appear here because the warning itself is at the boundary.
      // We also don't expect `next` outside the do-not-use context in the body.
    }
  }
  // For each chunk, look for `next` surrounded by canonical-field context. If found, record it.
  for (let i = 0; i < warnings.length; i++) {
    const chunk = warnings[i];
    if (chunk.includes("`next`")) {
      // The first chunk is before the do-not-use warning; the rest are after. Both are
      // suspicious if they include `next` in a response-contract context.
      offending.push(chunk.slice(Math.max(0, chunk.indexOf("`next`") - 40), chunk.indexOf("`next`") + 80));
    }
  }
  return offending.join(" | ");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}
