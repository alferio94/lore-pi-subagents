import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_DELEGATION_RETENTION_POLICY,
  DELEGATION_RETENTION_AUTO_COOLDOWN_MS_ENV,
  DELEGATION_RETENTION_CONFIG_PATH,
  DELEGATION_RETENTION_DRY_RUN_ENV,
  DELEGATION_RETENTION_ENABLED_ENV,
  DELEGATION_RETENTION_HEAVY_LOG_AGE_DAYS_ENV,
  DELEGATION_RETENTION_KEEP_LAST_ENV,
  DELEGATION_RETENTION_MAX_AGE_DAYS_ENV,
  DELEGATION_RETENTION_MAX_TOTAL_SIZE_ENV,
  DELEGATION_RETENTION_PATH_ENV,
  DELEGATION_RETENTION_ROOT_DIR_ENV,
} from "./constants.ts";
import type { RunStatus } from "./envelopes.ts";
import { HEAVY_ARTIFACT_FILES, RECORD_FILE, STATUS_FILE } from "./result-store.ts";

export type RetentionReason = "manual" | "auto-start" | "auto-finish";
export type RetentionActionKind = "delete-file" | "delete-dir";
export type RetentionProtectionReason = "running" | "needs_user_input" | "supervisor-request" | "non-dg" | "symlink" | "unreadable" | "unsafe-root";

export interface DelegationRetentionPolicy {
  enabled: boolean;
  dryRun: boolean;
  heavyLogAgeDays: number;
  maxAgeDays: number;
  keepLast: number;
  maxTotalSizeBytes: number;
  autoCooldownMs: number;
  maxScanEntries: number;
  rootDir?: string;
}

export type DelegationRetentionPolicyInput = Partial<DelegationRetentionPolicy> & {
  maxTotalSize?: string | number;
};

export interface RetentionRunEntry {
  id: string;
  runDir: string;
  status: RunStatus | "unknown";
  updatedAtMs: number;
  sizeBytes: number;
  heavyFiles: RetentionHeavyFile[];
  protected?: RetentionProtectionReason;
}

export interface RetentionHeavyFile {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RetentionPlanAction {
  kind: RetentionActionKind;
  path: string;
  runId: string;
  bytes: number;
  reason: "heavy-log-age" | "max-age" | "keep-last" | "max-total-size";
}

export interface RetentionPlan {
  rootDir: string;
  policy: DelegationRetentionPolicy;
  actions: RetentionPlanAction[];
  protected: Record<string, number>;
  skipped: Record<string, number>;
  scanned: { entries: number; runs: number; eligibleRuns: number; totalBytes: number };
}

export interface RetentionReport {
  rootDir: string;
  dryRun: boolean;
  reason: RetentionReason;
  protected: Record<string, number>;
  skipped: Record<string, number>;
  planned: { files: number; dirs: number; bytes: number };
  executed: { files: number; dirs: number; bytes: number };
  actions: Array<RetentionPlanAction & { executed: boolean; error?: string }>;
  errors: string[];
  durationMs: number;
}

const DG_RUN_PATTERN = /^dg-[0-9a-fA-F]{8}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeDelegationRetentionPolicy(input: DelegationRetentionPolicyInput = {}): DelegationRetentionPolicy {
  const defaults = DEFAULT_DELEGATION_RETENTION_POLICY;
  return {
    enabled: readBoolean(input.enabled, defaults.enabled),
    dryRun: readBoolean(input.dryRun, defaults.dryRun),
    heavyLogAgeDays: readNonNegativeNumber(input.heavyLogAgeDays, defaults.heavyLogAgeDays),
    maxAgeDays: readNonNegativeNumber(input.maxAgeDays, defaults.maxAgeDays),
    keepLast: Math.floor(readNonNegativeNumber(input.keepLast, defaults.keepLast)),
    maxTotalSizeBytes: readSizeBytes(input.maxTotalSizeBytes ?? input.maxTotalSize, defaults.maxTotalSizeBytes),
    autoCooldownMs: readNonNegativeNumber(input.autoCooldownMs, defaults.autoCooldownMs),
    maxScanEntries: Math.floor(readNonNegativeNumber(input.maxScanEntries, defaults.maxScanEntries)),
    ...(typeof input.rootDir === "string" && input.rootDir.trim() ? { rootDir: path.resolve(input.rootDir) } : {}),
  };
}

export function loadDelegationRetentionPolicy(input: DelegationRetentionPolicyInput = {}, env: NodeJS.ProcessEnv = process.env): DelegationRetentionPolicy {
  const configPath = env[DELEGATION_RETENTION_PATH_ENV] || DELEGATION_RETENTION_CONFIG_PATH;
  const filePolicy = readPolicyFile(configPath);
  return normalizeDelegationRetentionPolicy({
    ...filePolicy,
    ...input,
    ...envPolicy(env),
  });
}

export function scanDelegationRetentionRoot(rootDir: string, policy: DelegationRetentionPolicy, nowMs = Date.now()): RetentionPlan {
  const absoluteRoot = rootDir.trim() ? path.resolve(rootDir) : "";
  const empty = emptyPlan(absoluteRoot, policy);
  const rootSafety = isSafeRoot(rootDir) ?? isSafeRoot(absoluteRoot);
  if (rootSafety) {
    increment(empty.skipped, rootSafety);
    return empty;
  }

  let entries: fs.Dirent[];
  try {
    const rootStat = fs.lstatSync(absoluteRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      increment(empty.skipped, "unsafe-root");
      return empty;
    }
    entries = fs.readdirSync(absoluteRoot, { withFileTypes: true }).slice(0, policy.maxScanEntries);
  } catch {
    increment(empty.skipped, "unreadable");
    return empty;
  }

  const runs: RetentionRunEntry[] = [];
  for (const entry of entries) {
    empty.scanned.entries += 1;
    const childPath = path.join(absoluteRoot, entry.name);
    if (!DG_RUN_PATTERN.test(entry.name)) {
      increment(empty.skipped, "non-dg");
      continue;
    }

    const run = classifyRun(childPath, entry.name, absoluteRoot);
    empty.scanned.runs += 1;
    empty.scanned.totalBytes += run.sizeBytes;
    if (run.protected) {
      increment(empty.protected, run.protected);
      continue;
    }
    runs.push(run);
  }

  empty.scanned.eligibleRuns = runs.length;
  empty.actions.push(...planActions(absoluteRoot, policy, runs, nowMs));
  return empty;
}

export function pruneDelegationArtifacts(input: {
  rootDir: string;
  policy?: DelegationRetentionPolicyInput;
  reason?: RetentionReason;
  nowMs?: number;
}): RetentionReport {
  const started = Date.now();
  const policy = normalizeDelegationRetentionPolicy(input.policy);
  const plan = scanDelegationRetentionRoot(input.rootDir, policy, input.nowMs ?? started);
  const report: RetentionReport = {
    rootDir: plan.rootDir,
    dryRun: policy.dryRun,
    reason: input.reason ?? "manual",
    protected: plan.protected,
    skipped: plan.skipped,
    planned: summarizePlanned(plan.actions),
    executed: { files: 0, dirs: 0, bytes: 0 },
    actions: [],
    errors: [],
    durationMs: 0,
  };

  for (const action of plan.actions) {
    if (policy.dryRun) {
      report.actions.push({ ...action, executed: false });
      continue;
    }

    try {
      if (!isWithinRoot(action.path, plan.rootDir)) throw new Error("refused action outside retention root");
      if (action.kind === "delete-file") {
        const stat = fs.lstatSync(action.path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("refused non-file action target");
        fs.rmSync(action.path, { force: true });
        report.executed.files += 1;
      } else {
        const stat = fs.lstatSync(action.path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("refused non-directory action target");
        fs.rmSync(action.path, { recursive: true, force: true });
        report.executed.dirs += 1;
      }
      report.executed.bytes += action.bytes;
      report.actions.push({ ...action, executed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${action.path}: ${message}`);
      report.actions.push({ ...action, executed: false, error: message });
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}

function planActions(rootDir: string, policy: DelegationRetentionPolicy, runs: RetentionRunEntry[], nowMs: number): RetentionPlanAction[] {
  const heavyCutoff = nowMs - policy.heavyLogAgeDays * MS_PER_DAY;
  const maxAgeCutoff = nowMs - policy.maxAgeDays * MS_PER_DAY;
  const sorted = [...runs].sort(compareRunOldestFirst);
  const newestFirst = [...runs].sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id));
  const keepIds = new Set(newestFirst.slice(0, policy.keepLast).map((run) => run.id));
  const deleteDirIds = new Set<string>();

  for (const run of sorted) {
    if (run.updatedAtMs <= maxAgeCutoff) deleteDirIds.add(run.id);
  }
  for (const run of sorted) {
    if (!keepIds.has(run.id)) deleteDirIds.add(run.id);
  }

  let retainedBytes = runs.filter((run) => !deleteDirIds.has(run.id)).reduce((total, run) => total + run.sizeBytes, 0);
  for (const run of sorted) {
    if (retainedBytes <= policy.maxTotalSizeBytes) break;
    if (deleteDirIds.has(run.id)) continue;
    deleteDirIds.add(run.id);
    retainedBytes -= run.sizeBytes;
  }

  const actions: RetentionPlanAction[] = [];
  for (const run of sorted) {
    if (deleteDirIds.has(run.id)) continue;
    for (const file of run.heavyFiles.sort(compareHeavyFile)) {
      if (file.mtimeMs <= heavyCutoff) {
        actions.push({ kind: "delete-file", path: file.path, runId: run.id, bytes: file.sizeBytes, reason: "heavy-log-age" });
      }
    }
  }

  for (const run of sorted) {
    if (!deleteDirIds.has(run.id)) continue;
    const reason = run.updatedAtMs <= maxAgeCutoff ? "max-age" : keepIds.has(run.id) ? "max-total-size" : "keep-last";
    actions.push({ kind: "delete-dir", path: path.join(rootDir, run.id), runId: run.id, bytes: run.sizeBytes, reason });
  }

  return actions;
}

function classifyRun(runDir: string, id: string, rootDir: string): RetentionRunEntry {
  if (!isWithinRoot(runDir, rootDir)) return protectedRun(id, runDir, "unsafe-root");
  try {
    const stat = fs.lstatSync(runDir);
    if (stat.isSymbolicLink()) return protectedRun(id, runDir, "symlink");
    if (!stat.isDirectory()) return protectedRun(id, runDir, "non-dg");
  } catch {
    return protectedRun(id, runDir, "unreadable");
  }

  if (fs.existsSync(path.join(runDir, "supervisor-request.json"))) return protectedRun(id, runDir, "supervisor-request");
  const status = readRunStatus(runDir);
  if (status === "running" || status === "needs_user_input") return protectedRun(id, runDir, status);

  return {
    id,
    runDir,
    status,
    updatedAtMs: readUpdatedAtMs(runDir),
    sizeBytes: directorySize(runDir),
    heavyFiles: readHeavyFiles(runDir),
  };
}

function readRunStatus(runDir: string): RunStatus | "unknown" {
  for (const file of [STATUS_FILE, RECORD_FILE]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8")) as { status?: unknown };
      if (value.status === "completed" || value.status === "running" || value.status === "needs_user_input" || value.status === "failed") return value.status;
    } catch {
      // tolerate missing or malformed status sources; unknown runs are eligible by age/count/size only.
    }
  }
  return "unknown";
}

function readUpdatedAtMs(runDir: string): number {
  for (const file of [STATUS_FILE, RECORD_FILE]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8")) as { updatedAt?: unknown; startedAt?: unknown };
      const candidate = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : typeof value.startedAt === "string" ? Date.parse(value.startedAt) : NaN;
      if (Number.isFinite(candidate)) return candidate;
    } catch {
      // fall back to directory mtime.
    }
  }
  return fs.statSync(runDir).mtimeMs;
}

function readHeavyFiles(runDir: string): RetentionHeavyFile[] {
  return HEAVY_ARTIFACT_FILES.flatMap((name) => {
    const filePath = path.join(runDir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return [];
      return [{ path: filePath, name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
}

function directorySize(target: string): number {
  let total = 0;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    for (const entry of fs.readdirSync(target)) total += directorySize(path.join(target, entry));
  } catch {
    return total;
  }
  return total;
}

function protectedRun(id: string, runDir: string, protectedReason: RetentionProtectionReason): RetentionRunEntry {
  return { id, runDir, status: "unknown", updatedAtMs: 0, sizeBytes: 0, heavyFiles: [], protected: protectedReason };
}

function emptyPlan(rootDir: string, policy: DelegationRetentionPolicy): RetentionPlan {
  return { rootDir, policy, actions: [], protected: {}, skipped: {}, scanned: { entries: 0, runs: 0, eligibleRuns: 0, totalBytes: 0 } };
}

function summarizePlanned(actions: RetentionPlanAction[]): { files: number; dirs: number; bytes: number } {
  return actions.reduce((summary, action) => {
    if (action.kind === "delete-file") summary.files += 1;
    else summary.dirs += 1;
    summary.bytes += action.bytes;
    return summary;
  }, { files: 0, dirs: 0, bytes: 0 });
}

function envPolicy(env: NodeJS.ProcessEnv): DelegationRetentionPolicyInput {
  const policy: DelegationRetentionPolicyInput = {};
  assignIfSet(policy, "enabled", env[DELEGATION_RETENTION_ENABLED_ENV]);
  assignIfSet(policy, "dryRun", env[DELEGATION_RETENTION_DRY_RUN_ENV]);
  assignIfSet(policy, "heavyLogAgeDays", env[DELEGATION_RETENTION_HEAVY_LOG_AGE_DAYS_ENV]);
  assignIfSet(policy, "maxAgeDays", env[DELEGATION_RETENTION_MAX_AGE_DAYS_ENV]);
  assignIfSet(policy, "keepLast", env[DELEGATION_RETENTION_KEEP_LAST_ENV]);
  assignIfSet(policy, "maxTotalSize", env[DELEGATION_RETENTION_MAX_TOTAL_SIZE_ENV]);
  assignIfSet(policy, "autoCooldownMs", env[DELEGATION_RETENTION_AUTO_COOLDOWN_MS_ENV]);
  assignIfSet(policy, "rootDir", env[DELEGATION_RETENTION_ROOT_DIR_ENV]);
  return policy;
}

function assignIfSet(policy: DelegationRetentionPolicyInput, key: keyof DelegationRetentionPolicyInput, value: string | undefined): void {
  if (value !== undefined) {
    (policy as Record<string, unknown>)[key] = value;
  }
}

function readPolicyFile(configPath: string): DelegationRetentionPolicyInput {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as DelegationRetentionPolicyInput;
  } catch {
    return {};
  }
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function readSizeBytes(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "tb" ? 1024 ** 4 : unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.floor(amount * multiplier);
}

function isSafeRoot(rootDir: string): RetentionProtectionReason | null {
  if (!rootDir.trim()) return "unsafe-root";
  const parsed = path.parse(rootDir);
  if (rootDir === parsed.root) return "unsafe-root";
  return null;
}

function isWithinRoot(child: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function compareRunOldestFirst(left: RetentionRunEntry, right: RetentionRunEntry): number {
  return left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id);
}

function compareHeavyFile(left: RetentionHeavyFile, right: RetentionHeavyFile): number {
  return HEAVY_ARTIFACT_FILES.indexOf(left.name as (typeof HEAVY_ARTIFACT_FILES)[number]) - HEAVY_ARTIFACT_FILES.indexOf(right.name as (typeof HEAVY_ARTIFACT_FILES)[number]) || left.path.localeCompare(right.path);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}
