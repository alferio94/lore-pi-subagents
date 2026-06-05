import test from "node:test";
import assert from "node:assert/strict";
import { extractEnvelopeCandidate, parseEnvelope, validateSddEnvelope, validateWorkerEnvelope } from "../src/runtime/envelopes.ts";

test("validateWorkerEnvelope accepts strict worker JSON with no phase", () => {
  const result = validateWorkerEnvelope({
    status: "completed",
    summary: "done",
    artifacts: ["memo-1"],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
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
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
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
      files: [],
      validations: [],
      next_step: "verify",
      continuation: "Resume from verify if requested.",
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
    assert.equal(result.envelope.next_step, "verify");
    assert.equal(result.envelope.continuation, "Resume from verify if requested.");
  }
});

test("parseEnvelope normalizes legacy next-based worker envelopes into the richer handoff shape", () => {
  const result = parseEnvelope(
    JSON.stringify({
      status: "completed",
      summary: "Legacy worker done.",
      artifacts: ["artifact-1"],
      next: "follow-up",
      question: null,
      options: [],
      risks: [],
      skill_resolution: "none",
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "worker");
    assert.deepEqual(result.envelope.files, []);
    assert.deepEqual(result.envelope.validations, []);
    assert.equal(result.envelope.next_step, "follow-up");
    assert.equal(result.envelope.continuation, null);
  }
});

test("validateWorkerEnvelope rejects phase leakage into worker envelopes", () => {
  const result = validateWorkerEnvelope({
    status: "completed",
    phase: "apply",
    summary: "done",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
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
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
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

test("validateWorkerEnvelope also requires question and options for needs_user_input", () => {
  const result = validateWorkerEnvelope({
    status: "needs_user_input",
    summary: "Need help.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: "",
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
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
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

const BASE_WORKER_ENVELOPE = {
  status: "completed",
  summary: "smoke",
  artifacts: [],
  files: [],
  validations: [],
  next_step: null,
  continuation: null,
  question: null,
  options: [],
  risks: [],
  skill_resolution: "none",
} as const;

function envelopeString(): string {
  return JSON.stringify(BASE_WORKER_ENVELOPE);
}

test("extractEnvelopeCandidate returns raw-json for strict single-object output", () => {
  const result = extractEnvelopeCandidate(envelopeString());
  assert.equal(result.source, "raw-json");
  assert.equal(result.text, envelopeString());
});

test("extractEnvelopeCandidate returns raw-json for strict SDD envelopes with phase", () => {
  const sddEnvelope = JSON.stringify({ ...BASE_WORKER_ENVELOPE, phase: "apply" });
  const result = extractEnvelopeCandidate(sddEnvelope);
  assert.equal(result.source, "raw-json");
  assert.equal(result.text, sddEnvelope);
});

test("extractEnvelopeCandidate returns pi-jsonl-assistant for Pi JSONL message streams", () => {
  const envelope = envelopeString();
  const raw = [
    JSON.stringify({ type: "session", id: "session-1" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: envelope }] } }),
  ].join("\n");
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "pi-jsonl-assistant");
  assert.equal(result.text, envelope);
});

test("extractEnvelopeCandidate returns fenced-json for a single fenced JSON block", () => {
  const envelope = envelopeString();
  const raw = `Here is the final answer:\n\n\`\`\`json\n${envelope}\n\`\`\`\n`;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "fenced-json");
  assert.equal(result.text, envelope);
});

test("extractEnvelopeCandidate returns fenced-json for a fenced block with no language tag", () => {
  const envelope = envelopeString();
  const raw = `\`\`\`\n${envelope}\n\`\`\``;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "fenced-json");
  assert.equal(result.text, envelope);
});

test("extractEnvelopeCandidate picks the last fenced JSON block when exactly one parses as an object", () => {
  const envelope = envelopeString();
  const raw = `\`\`\`json\n{"example": true}\n\`\`\`\n\nFinal result:\n\n\`\`\`json\n${envelope}\n\`\`\`\n`;
  const result = extractEnvelopeCandidate(raw);
  // Two fenced blocks: {"example": true} is not a valid envelope object but DOES parse as object, so the spec rejects (multiple).
  assert.equal(result.source, "none");
  assert.equal(result.text, "");
});

test("extractEnvelopeCandidate returns plain-text-fallback for harmless prose wrapping exactly one envelope", () => {
  const envelope = envelopeString();
  const raw = `Sure, here is the final envelope:\n\n${envelope}\n\nThanks!`;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "plain-text-fallback");
  assert.equal(result.text, envelope);
});

test("extractEnvelopeCandidate returns plain-text-fallback for prose with leading markdown", () => {
  const envelope = envelopeString();
  const raw = `# Summary\n\nAll done.\n\n${envelope}`;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "plain-text-fallback");
  assert.equal(result.text, envelope);
});

test("extractEnvelopeCandidate returns none for multiple top-level JSON objects in prose", () => {
  const envelope = envelopeString();
  const raw = `First draft: {"a":1}\nFinal: ${envelope}`;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "none");
  assert.equal(result.text, "");
});

test("extractEnvelopeCandidate returns none for multiple fenced JSON blocks that parse as objects", () => {
  const envelope = envelopeString();
  const raw = `\`\`\`json\n${envelope}\n\`\`\`\nThen:\n\`\`\`json\n${envelope}\n\`\`\`\n`;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "none");
  assert.equal(result.text, "");
});

test("extractEnvelopeCandidate returns fenced-json when a fenced block wins by priority even if prose also contains an object", () => {
  const envelope = envelopeString();
  const raw = `\`\`\`json\n${envelope}\n\`\`\`\nPlus extra prose with another object: ${envelope}`;
  // Priority: fenced-json wins when exactly one fenced block parses. Prose is not consulted after a fenced candidate resolves.
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "fenced-json");
  assert.equal(result.text, envelope);
});

test("extractEnvelopeCandidate returns none for malformed-only output", () => {
  const result = extractEnvelopeCandidate("not valid json");
  assert.equal(result.source, "none");
  assert.equal(result.text, "");
});

test("extractEnvelopeCandidate returns none for empty input", () => {
  const result = extractEnvelopeCandidate("   \n  ");
  assert.equal(result.source, "none");
  assert.equal(result.text, "");
});

test("extractEnvelopeCandidate tolerates JSON object containing braces inside string values", () => {
  const envelope = JSON.stringify({
    ...BASE_WORKER_ENVELOPE,
    summary: "code: {not: json} and more",
  });
  const raw = `Prose preamble.\n\n${envelope}\n\nClosing line.`;
  const result = extractEnvelopeCandidate(raw);
  assert.equal(result.source, "plain-text-fallback");
  assert.equal(result.text, envelope);
});

test("parseEnvelope still rejects a fenced JSON block (strict validator)", () => {
  const envelope = envelopeString();
  const result = parseEnvelope(`\`\`\`json\n${envelope}\n\`\`\``);
  // The schema validator is strict: it does not strip fences. Tolerance happens in the candidate extractor.
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /single JSON object/i);
  }
});

test("parseEnvelope still rejects harmless-wrapped envelope (strict validator)", () => {
  const envelope = envelopeString();
  const result = parseEnvelope(`Here it is:\n\n${envelope}\nThanks!`);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /single JSON object/i);
  }
});

test("parseEnvelope validates a candidate extracted by the new extractor end-to-end", () => {
  const envelope = JSON.stringify({ ...BASE_WORKER_ENVELOPE, phase: "apply" });
  const raw = `Here you go:\n\n\`\`\`json\n${envelope}\n\`\`\`\n\nDone.`;
  const candidate = extractEnvelopeCandidate(raw);
  const parsed = parseEnvelope(candidate.text);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.kind, "sdd");
    assert.equal(parsed.envelope.status, "completed");
  }
});
