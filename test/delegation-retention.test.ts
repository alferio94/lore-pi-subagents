import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadDelegationRetentionPolicy,
  normalizeDelegationRetentionPolicy,
  pruneDelegationArtifacts,
  scanDelegationRetentionRoot,
} from "../src/runtime/delegation-retention.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-retention-"));
}

function writeRun(root: string, id: string, input: { status?: string; updatedAt: string; heavyBytes?: number; traceBytes?: number; supervisor?: boolean }): string {
  const runDir = path.join(root, id);
  fs.mkdirSync(runDir, { recursive: true });
  const status = input.status ?? "completed";
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ status, updatedAt: input.updatedAt }), "utf8");
  fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify({ id, status, updatedAt: input.updatedAt }), "utf8");
  fs.writeFileSync(path.join(runDir, "result.json"), "{}", "utf8");
  if (input.heavyBytes) fs.writeFileSync(path.join(runDir, "raw-output.txt"), "x".repeat(input.heavyBytes), "utf8");
  if (input.traceBytes) fs.writeFileSync(path.join(runDir, "trace.jsonl"), "t".repeat(input.traceBytes), "utf8");
  if (input.supervisor) fs.writeFileSync(path.join(runDir, "supervisor-request.json"), "{}", "utf8");
  const mtime = new Date(input.updatedAt);
  for (const file of fs.readdirSync(runDir)) fs.utimesSync(path.join(runDir, file), mtime, mtime);
  fs.utimesSync(runDir, mtime, mtime);
  return runDir;
}

test("retention policy defaults and env overrides normalize aggressively but safely", () => {
  const defaults = normalizeDelegationRetentionPolicy();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.dryRun, true);
  assert.equal(defaults.heavyLogAgeDays, 3);
  assert.equal(defaults.maxAgeDays, 21);
  assert.equal(defaults.keepLast, 150);
  assert.equal(defaults.maxTotalSizeBytes, 5 * 1024 * 1024 * 1024);

  const loaded = loadDelegationRetentionPolicy({}, {
    LORE_PI_RUNTIME_RETENTION_ENABLED: "true",
    LORE_PI_RUNTIME_RETENTION_DRY_RUN: "false",
    LORE_PI_RUNTIME_RETENTION_HEAVY_LOG_AGE_DAYS: "7",
    LORE_PI_RUNTIME_RETENTION_MAX_TOTAL_SIZE: "1gb",
  });
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.dryRun, false);
  assert.equal(loaded.heavyLogAgeDays, 7);
  assert.equal(loaded.maxTotalSizeBytes, 1024 * 1024 * 1024);
});

test("scan refuses blank, filesystem, and symlink roots without planning deletes", () => {
  const policy = normalizeDelegationRetentionPolicy({ dryRun: true });
  assert.equal(scanDelegationRetentionRoot("", policy).skipped["unsafe-root"], 1);
  assert.equal(scanDelegationRetentionRoot(path.parse(process.cwd()).root, policy).skipped["unsafe-root"], 1);
  const root = makeTempDir();
  const link = path.join(os.tmpdir(), `lore-retention-root-link-${Date.now()}`);
  fs.symlinkSync(root, link);
  assert.equal(scanDelegationRetentionRoot(link, policy).skipped["unsafe-root"], 1);
});

test("protected and skipped classification preserves active, supervisor, symlink, and non-dg entries", () => {
  const root = makeTempDir();
  const now = Date.UTC(2026, 0, 30);
  writeRun(root, "dg-00000001", { status: "running", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 10 });
  writeRun(root, "dg-00000002", { status: "needs_user_input", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 10 });
  writeRun(root, "dg-00000003", { status: "failed", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 10 });
  writeRun(root, "dg-00000004", { status: "completed", updatedAt: "2026-01-01T00:00:00.000Z", supervisor: true, heavyBytes: 10 });
  fs.mkdirSync(path.join(root, "notes"));
  const symlinkTarget = path.join(root, "symlink-target");
  fs.mkdirSync(symlinkTarget);
  fs.symlinkSync(symlinkTarget, path.join(root, "dg-00000005"));

  const plan = scanDelegationRetentionRoot(root, normalizeDelegationRetentionPolicy({ maxAgeDays: 21, dryRun: true }), now);
  assert.equal(plan.protected.running, 1);
  assert.equal(plan.protected.needs_user_input, 1);
  assert.equal(plan.protected["supervisor-request"], 1);
  assert.equal(plan.protected.symlink, 1);
  assert.equal(plan.skipped["non-dg"], 2);
  assert.deepEqual(plan.actions.map((action) => action.runId), ["dg-00000003"]);
});

test("planning is deterministic: heavy files precede directory deletions and keepLast retains newest", () => {
  const root = makeTempDir();
  const now = Date.UTC(2026, 0, 30);
  writeRun(root, "dg-00000001", { updatedAt: "2026-01-25T00:00:00.000Z", heavyBytes: 50, traceBytes: 5 });
  writeRun(root, "dg-00000002", { updatedAt: "2026-01-20T00:00:00.000Z", heavyBytes: 50 });
  writeRun(root, "dg-00000003", { updatedAt: "2026-01-15T00:00:00.000Z", heavyBytes: 50 });

  const plan = scanDelegationRetentionRoot(root, normalizeDelegationRetentionPolicy({ heavyLogAgeDays: 3, maxAgeDays: 999, keepLast: 2, dryRun: true }), now);
  assert.deepEqual(plan.actions.map((action) => action.kind), ["delete-file", "delete-file", "delete-file", "delete-dir"]);
  assert.deepEqual(plan.actions.map((action) => action.runId), ["dg-00000002", "dg-00000001", "dg-00000001", "dg-00000003"]);
  assert.equal(plan.actions[0].path.endsWith("raw-output.txt"), true);
  assert.equal(plan.actions[2].path.endsWith("trace.jsonl"), true);
});

test("maxTotalSize trims oldest retained runs after heavy-file planning", () => {
  const root = makeTempDir();
  const now = Date.UTC(2026, 0, 30);
  writeRun(root, "dg-00000001", { updatedAt: "2026-01-29T00:00:00.000Z", heavyBytes: 30 });
  writeRun(root, "dg-00000002", { updatedAt: "2026-01-28T00:00:00.000Z", heavyBytes: 30 });
  writeRun(root, "dg-00000003", { updatedAt: "2026-01-27T00:00:00.000Z", heavyBytes: 30 });

  const plan = scanDelegationRetentionRoot(root, normalizeDelegationRetentionPolicy({ heavyLogAgeDays: 999, maxAgeDays: 999, keepLast: 10, maxTotalSizeBytes: 80, dryRun: true }), now);
  assert.equal(plan.actions.some((action) => action.kind === "delete-dir" && action.runId === "dg-00000003" && action.reason === "max-total-size"), true);
});

test("dry-run reports would-reclaim bytes without mutation; execution removes only planned artifacts", () => {
  const root = makeTempDir();
  const now = Date.UTC(2026, 0, 30);
  const runDir = writeRun(root, "dg-00000001", { updatedAt: "2026-01-20T00:00:00.000Z", heavyBytes: 12 });

  const dryRun = pruneDelegationArtifacts({ rootDir: root, nowMs: now, policy: { heavyLogAgeDays: 3, maxAgeDays: 999, dryRun: true } });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.planned.files, 1);
  assert.equal(dryRun.executed.files, 0);
  assert.equal(fs.existsSync(path.join(runDir, "raw-output.txt")), true);

  const execute = pruneDelegationArtifacts({ rootDir: root, nowMs: now, policy: { heavyLogAgeDays: 3, maxAgeDays: 999, dryRun: false } });
  assert.equal(execute.planned.files, 1);
  assert.equal(execute.executed.files, 1);
  assert.equal(execute.executed.bytes, 12);
  assert.equal(fs.existsSync(path.join(runDir, "raw-output.txt")), false);
  assert.equal(fs.existsSync(path.join(runDir, "result.json")), true);
});

test("execution preserves protected running, needs_user_input, supervisor, and non-dg artifacts", () => {
  const root = makeTempDir();
  const now = Date.UTC(2026, 0, 30);
  const runningDir = writeRun(root, "dg-00000001", { status: "running", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 7 });
  const waitingDir = writeRun(root, "dg-00000002", { status: "needs_user_input", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 8 });
  const supervisorDir = writeRun(root, "dg-00000003", { status: "completed", updatedAt: "2026-01-01T00:00:00.000Z", supervisor: true, heavyBytes: 9 });
  const eligibleDir = writeRun(root, "dg-00000004", { status: "failed", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 10 });
  const notesDir = path.join(root, "notes");
  fs.mkdirSync(notesDir);
  fs.writeFileSync(path.join(notesDir, "raw-output.txt"), "do-not-touch", "utf8");

  const report = pruneDelegationArtifacts({ rootDir: root, nowMs: now, policy: { heavyLogAgeDays: 3, maxAgeDays: 999, dryRun: false } });

  assert.equal(report.protected.running, 1);
  assert.equal(report.protected.needs_user_input, 1);
  assert.equal(report.protected["supervisor-request"], 1);
  assert.equal(report.skipped["non-dg"], 1);
  assert.equal(report.executed.files, 1);
  assert.equal(fs.existsSync(path.join(runningDir, "raw-output.txt")), true);
  assert.equal(fs.existsSync(path.join(waitingDir, "raw-output.txt")), true);
  assert.equal(fs.existsSync(path.join(supervisorDir, "raw-output.txt")), true);
  assert.equal(fs.existsSync(path.join(notesDir, "raw-output.txt")), true);
  assert.equal(fs.existsSync(path.join(eligibleDir, "raw-output.txt")), false);
});

test("manual and automatic reasons share identical pruning decisions", () => {
  const root = makeTempDir();
  const now = Date.UTC(2026, 0, 30);
  writeRun(root, "dg-00000001", { status: "completed", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 5 });
  writeRun(root, "dg-00000002", { status: "failed", updatedAt: "2026-01-02T00:00:00.000Z", heavyBytes: 6 });
  writeRun(root, "dg-00000003", { status: "running", updatedAt: "2026-01-01T00:00:00.000Z", heavyBytes: 7 });
  fs.mkdirSync(path.join(root, "not-a-run"));
  const policy = { heavyLogAgeDays: 3, maxAgeDays: 999, keepLast: 1, dryRun: true };

  const manual = pruneDelegationArtifacts({ rootDir: root, nowMs: now, policy, reason: "manual" });
  const automatic = pruneDelegationArtifacts({ rootDir: root, nowMs: now, policy, reason: "auto-start" });

  assert.equal(manual.reason, "manual");
  assert.equal(automatic.reason, "auto-start");
  assert.deepEqual(automatic.protected, manual.protected);
  assert.deepEqual(automatic.skipped, manual.skipped);
  assert.deepEqual(
    automatic.actions.map(({ kind, runId, reason, bytes }) => ({ kind, runId, reason, bytes })),
    manual.actions.map(({ kind, runId, reason, bytes }) => ({ kind, runId, reason, bytes })),
  );
});
