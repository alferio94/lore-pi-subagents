import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunRecord, recoverRun, storeRunOutput } from "../src/runtime/result-store.ts";
import {
  extractUsageSummary,
  formatSnapshotBody,
  readDelegationSnapshot,
  type DelegationSnapshot,
} from "../src/ui/delegations.ts";

function snapshot(overrides: Partial<DelegationSnapshot>): DelegationSnapshot {
  return {
    id: "dg-feedbeef",
    agent: "lore-worker",
    status: "completed",
    modelRef: "provider/model",
    runDir: "/tmp/dg-feedbeef",
    rawOutputPath: "/tmp/dg-feedbeef/raw-output.txt",
    stderrPath: null,
    summary: null,
    envelope: null,
    parseError: null,
    parseSource: null,
    trace: "",
    rawOutput: "",
    stderr: "",
    traceMissing: false,
    rawOutputMissing: false,
    stderrMissing: false,
    usage: { input: 0, output: 0, totalTokens: 0, providerTotalTokens: 0, model: "provider/model" },
    ...overrides,
  };
}

test("delegation detail token total is input plus output, with provider total kept separate", () => {
  const usage = extractUsageSummary([
    JSON.stringify({ type: "token_usage", input: 10, output: 5, totalTokens: 100, model: "provider/a" }),
    JSON.stringify({ type: "token_usage", input: 3, output: 2, totalTokens: 50, model: "provider/b" }),
  ].join("\n"), "fallback/model");

  assert.deepEqual(usage, {
    input: 13,
    output: 7,
    totalTokens: 20,
    providerTotalTokens: 150,
    model: "provider/b",
  });
});

test("delegation detail body renders envelope snapshot instead of raw JSONL or prompt text", () => {
  const body = formatSnapshotBody(snapshot({
    summary: "done",
    envelope: {
      status: "completed",
      summary: "implemented UI detail",
      artifacts: ["artifact-a"],
      files: ["src/ui/delegations.ts"],
      validations: ["node --test test/ui-delegations.test.ts"],
      risks: [],
      next_step: null,
      continuation: null,
      question: null,
      options: [],
      skill_resolution: "none",
    },
    trace: "12:00:00 assistant_message — output updated",
    rawOutput: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL PROMPT should not render" }] } }),
  })).join("\n");

  assert.match(body, /Result/);
  assert.match(body, /summary: implemented UI detail/);
  assert.match(body, /files: src\/ui\/delegations\.ts/);
  assert.doesNotMatch(body, /Live trace/);
  assert.doesNotMatch(body, /\{"type":"message_end"/);
  assert.doesNotMatch(body, /ORIGINAL PROMPT/);
});

test("delegation detail body renders missing pruned artifacts as explicit placeholders", () => {
  const body = formatSnapshotBody(snapshot({
    status: "failed",
    parseError: "Could not extract an envelope.",
    rawOutputMissing: true,
    stderrPath: "/tmp/dg-feedbeef/stderr.txt",
    stderrMissing: true,
    traceMissing: true,
  })).join("\n");

  assert.match(body, /Final output\n\(raw output was pruned or is missing: \/tmp\/dg-feedbeef\/raw-output\.txt\)/);
  assert.match(body, /Recent activity\n\(trace log was pruned or is missing: \/tmp\/dg-feedbeef\/trace\.jsonl\)/);
  assert.match(body, /stderr\n\(stderr log was pruned or is missing: \/tmp\/dg-feedbeef\/stderr\.txt\)/);
  assert.doesNotMatch(body, /undefined/);
});

test("delegation snapshot keeps metadata result readable after heavy artifacts are pruned", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-ui-"));
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-feedbeef",
    requestedAgent: "sdd-apply",
    canonicalAgent: "sdd-apply",
    cwd: "/repo",
    modelRef: "provider/model",
  });

  storeRunOutput(record, JSON.stringify({
    status: "completed",
    phase: "apply",
    summary: "metadata remains",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  }), "stderr boom");
  fs.rmSync(record.files.rawOutput, { force: true });
  fs.rmSync(record.files.stderr, { force: true });

  const detail = await readDelegationSnapshot(record.id, (id) => {
    assert.equal(id, record.id);
    return recoverRun(record.runDir);
  });

  assert.equal(detail.envelope?.summary, "metadata remains");
  assert.equal(detail.rawOutputMissing, true);
  assert.equal(detail.stderrMissing, true);
  assert.equal(detail.traceMissing, true);
  assert.equal(formatSnapshotBody(detail).join("\n").includes("summary: metadata remains"), true);
});

test("delegation detail body extracts assistant final text from JSONL fallback without dumping events", () => {
  const rawOutput = [
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ORIGINAL PROMPT should not render" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Human readable final output" }] } }),
  ].join("\n");

  const body = formatSnapshotBody(snapshot({
    status: "failed",
    parseError: "Envelope missing required field.",
    rawOutput,
    trace: "12:00:00 assistant_message — output updated",
  })).join("\n");

  assert.match(body, /parseError: Envelope missing required field\./);
  assert.match(body, /Final output\nHuman readable final output/);
  assert.match(body, /Recent activity\n12:00:00 assistant_message/);
  assert.doesNotMatch(body, /\{"type":"message_end"/);
  assert.doesNotMatch(body, /ORIGINAL PROMPT/);
});
