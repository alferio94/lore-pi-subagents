import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunRecord, extractEnvelopeOutput, recoverRun, storeRunOutput } from "../src/runtime/result-store.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-store-"));
}

test("createRunRecord creates atomic record and running status files", () => {
  const rootDir = makeTempDir();
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-123",
    requestedAgent: "scribe",
    canonicalAgent: "lore-worker",
    cwd: "/repo",
    modelRef: "gpt-5",
  });

  assert.equal(record.status, "running");
  assert.equal(fs.existsSync(record.files.record), true);
  assert.equal(fs.existsSync(record.files.status), true);
});

test("storeRunOutput persists parsed SDD envelopes and updates run status", () => {
  const rootDir = makeTempDir();
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-456",
    requestedAgent: "sdd-apply",
    canonicalAgent: "sdd-apply",
    cwd: "/repo",
  });

  const result = storeRunOutput(
    record,
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

  assert.equal(result.status, "completed");
  assert.equal(result.envelope?.status, "completed");
  assert.equal(result.envelope && "phase" in result.envelope ? result.envelope.phase : null, "apply");

  const recovered = recoverRun(record.runDir);
  assert.equal(recovered.record.status, "completed");
  assert.equal(recovered.status?.summary, "Slice finished.");
  assert.equal(recovered.result?.envelope && "phase" in recovered.result.envelope ? recovered.result.envelope.phase : null, "apply");
});

test("recoverRun reconstructs result from raw output when result files are missing", () => {
  const rootDir = makeTempDir();
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-789",
    requestedAgent: "lore-worker",
    canonicalAgent: "lore-worker",
    cwd: "/repo",
  });

  const rawOutput = JSON.stringify({
    status: "needs_user_input",
    summary: "Need approval.",
    artifacts: ["memo-7"],
    next: null,
    question: "Ship it?",
    options: ["yes", "no"],
    risks: ["Could block rollout."],
    skill_resolution: "none",
  });

  fs.writeFileSync(record.files.rawOutput, rawOutput, "utf8");
  fs.rmSync(record.files.status);
  fs.rmSync(record.files.result, { force: true });

  const recovered = recoverRun(record.runDir);
  assert.equal(recovered.status?.status, "needs_user_input");
  assert.equal(recovered.result?.envelope?.question, "Ship it?");
});

test("storeRunOutput extracts final assistant envelope from Pi JSON event streams", () => {
  const rootDir = makeTempDir();
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-jsonl",
    requestedAgent: "lore-worker",
    canonicalAgent: "lore-worker",
    cwd: "/repo",
  });

  const envelope = JSON.stringify({
    status: "completed",
    summary: "smoke",
    artifacts: [],
    next: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });
  const rawOutput = [
    JSON.stringify({ type: "session", id: "session-1" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: envelope }] } }),
  ].join("\n");

  assert.equal(extractEnvelopeOutput(rawOutput), envelope);
  const result = storeRunOutput(record, rawOutput);
  assert.equal(result.status, "completed");
  assert.equal(result.envelope?.summary, "smoke");
  assert.equal(fs.readFileSync(record.files.rawOutput, "utf8"), rawOutput);
});

test("storeRunOutput preserves malformed raw output for recovery", () => {
  const rootDir = makeTempDir();
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-999",
    requestedAgent: "lore-worker",
    canonicalAgent: "lore-worker",
    cwd: "/repo",
  });

  const result = storeRunOutput(record, "not valid json");
  assert.equal(result.status, "failed");
  assert.match(result.parseError ?? "", /single JSON object/i);

  const recovered = recoverRun(record.runDir);
  assert.equal(recovered.status?.status, "failed");
  assert.equal(recovered.rawOutput, "not valid json");
});
