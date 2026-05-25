import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvelope, validateSddEnvelope, validateWorkerEnvelope } from "../src/runtime/envelopes.ts";

test("validateWorkerEnvelope accepts strict worker JSON with no phase", () => {
  const result = validateWorkerEnvelope({
    status: "completed",
    summary: "done",
    artifacts: ["memo-1"],
    next: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "worker");
    assert.equal(result.envelope.status, "completed");
  }
});

test("validateSddEnvelope accepts SDD needs_user_input envelopes", () => {
  const result = validateSddEnvelope({
    status: "needs_user_input",
    phase: "apply",
    summary: "Need a decision.",
    artifacts: ["sdd/change/apply-report"],
    next: null,
    question: "Which path should apply continue with?",
    options: ["A", "B"],
    risks: ["Scope could widen."],
    skill_resolution: "injected",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "sdd");
    assert.equal(result.envelope.phase, "apply");
    assert.equal(result.envelope.status, "needs_user_input");
  }
});

test("parseEnvelope rejects trailing prose and malformed JSON", () => {
  const result = parseEnvelope('{"status":"completed"}\nextra');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /single JSON object/i);
  }
});

test("parseEnvelope accepts strict SDD envelopes with skill_resolution", () => {
  const result = parseEnvelope(
    JSON.stringify({
      status: "completed",
      phase: "apply",
      summary: "Slice finished.",
      artifacts: ["sdd/change/apply-report"],
      next: "verify",
      question: null,
      options: [],
      risks: [],
      skill_resolution: "injected",
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "sdd");
    assert.equal(result.envelope.skill_resolution, "injected");
  }
});

test("validateWorkerEnvelope rejects phase leakage into worker envelopes", () => {
  const result = validateWorkerEnvelope({
    status: "completed",
    phase: "apply",
    summary: "done",
    artifacts: [],
    next: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /phase/i);
  }
});

test("validateSddEnvelope requires question and options for needs_user_input", () => {
  const result = validateSddEnvelope({
    status: "needs_user_input",
    phase: "apply",
    summary: "Need help.",
    artifacts: [],
    next: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "fallback-path",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /question/i);
  }
});

test("validateSddEnvelope rejects unsupported keys for strict contracts", () => {
  const result = validateSddEnvelope({
    status: "completed",
    phase: "apply",
    summary: "done",
    artifacts: [],
    next: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "fallback-registry",
    extra: true,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unsupported keys/i);
  }
});
