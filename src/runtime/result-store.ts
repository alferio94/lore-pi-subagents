import * as fs from "node:fs";
import * as path from "node:path";
import type { DelegationEnvelope, RunStatus } from "./envelopes.ts";
import { parseEnvelope } from "./envelopes.ts";

export interface CreateRunRecordInput {
  rootDir: string;
  delegationId: string;
  requestedAgent: string;
  canonicalAgent: string;
  cwd: string;
  modelRef?: string;
}

export interface RunRecord {
  id: string;
  requestedAgent: string;
  canonicalAgent: string;
  cwd: string;
  modelRef: string | null;
  startedAt: string;
  updatedAt: string;
  status: RunStatus;
  runDir: string;
  files: {
    record: string;
    status: string;
    result: string;
    rawOutput: string;
  };
}

export interface StoredRunStatus {
  status: RunStatus;
  updatedAt: string;
  summary?: string;
  envelopeKind?: "worker" | "sdd";
  parseError?: string;
}

export interface StoredRunResult {
  status: RunStatus;
  updatedAt: string;
  envelope?: DelegationEnvelope;
  rawOutputPath?: string;
  parseError?: string;
}

export interface RecoveredRun {
  record: RunRecord;
  status: StoredRunStatus | null;
  result: StoredRunResult | null;
  rawOutput: string | null;
}

const RECORD_FILE = "record.json";
const STATUS_FILE = "status.json";
const RESULT_FILE = "result.json";
const RAW_OUTPUT_FILE = "raw-output.txt";

export function createRunRecord(input: CreateRunRecordInput): RunRecord {
  const runDir = path.join(path.resolve(input.rootDir), input.delegationId);
  fs.mkdirSync(runDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const record: RunRecord = {
    id: input.delegationId,
    requestedAgent: input.requestedAgent,
    canonicalAgent: input.canonicalAgent,
    cwd: input.cwd,
    modelRef: input.modelRef ?? null,
    startedAt: timestamp,
    updatedAt: timestamp,
    status: "running",
    runDir,
    files: {
      record: path.join(runDir, RECORD_FILE),
      status: path.join(runDir, STATUS_FILE),
      result: path.join(runDir, RESULT_FILE),
      rawOutput: path.join(runDir, RAW_OUTPUT_FILE),
    },
  };

  writeJsonAtomic(record.files.record, record);
  writeJsonAtomic(record.files.status, {
    status: record.status,
    updatedAt: timestamp,
  } satisfies StoredRunStatus);

  return record;
}

export function storeRunOutput(record: RunRecord, rawOutput: string): StoredRunResult {
  writeTextAtomic(record.files.rawOutput, rawOutput);

  const timestamp = new Date().toISOString();
  const parsed = parseEnvelope(rawOutput);
  const status: StoredRunStatus = parsed.ok
    ? {
        status: parsed.envelope.status,
        updatedAt: timestamp,
        summary: parsed.envelope.summary,
        envelopeKind: parsed.kind,
      }
    : {
        status: "failed",
        updatedAt: timestamp,
        parseError: parsed.error,
      };

  const result: StoredRunResult = parsed.ok
    ? {
        status: parsed.envelope.status,
        updatedAt: timestamp,
        envelope: parsed.envelope,
        rawOutputPath: record.files.rawOutput,
      }
    : {
        status: "failed",
        updatedAt: timestamp,
        rawOutputPath: record.files.rawOutput,
        parseError: parsed.error,
      };

  writeJsonAtomic(record.files.status, status);
  writeJsonAtomic(record.files.result, result);
  updateRecordStatus(record.files.record, status.status, timestamp);

  return result;
}

export function recoverRun(runDir: string): RecoveredRun {
  const absoluteRunDir = path.resolve(runDir);
  const recordPath = path.join(absoluteRunDir, RECORD_FILE);
  const statusPath = path.join(absoluteRunDir, STATUS_FILE);
  const resultPath = path.join(absoluteRunDir, RESULT_FILE);
  const rawOutputPath = path.join(absoluteRunDir, RAW_OUTPUT_FILE);

  const record = readJson<RunRecord>(recordPath);
  const rawOutput = fs.existsSync(rawOutputPath) ? fs.readFileSync(rawOutputPath, "utf8") : null;
  let status = fs.existsSync(statusPath) ? readJson<StoredRunStatus>(statusPath) : null;
  let result = fs.existsSync(resultPath) ? readJson<StoredRunResult>(resultPath) : null;

  if ((!status || !result) && rawOutput) {
    const parsed = parseEnvelope(rawOutput);
    const updatedAt = new Date().toISOString();
    if (parsed.ok) {
      status ??= {
        status: parsed.envelope.status,
        updatedAt,
        summary: parsed.envelope.summary,
        envelopeKind: parsed.kind,
      };
      result ??= {
        status: parsed.envelope.status,
        updatedAt,
        envelope: parsed.envelope,
        rawOutputPath,
      };
    } else {
      status ??= {
        status: "failed",
        updatedAt,
        parseError: parsed.error,
      };
      result ??= {
        status: "failed",
        updatedAt,
        rawOutputPath,
        parseError: parsed.error,
      };
    }
  }

  return {
    record,
    status,
    result,
    rawOutput,
  };
}

function updateRecordStatus(recordPath: string, status: RunStatus, updatedAt: string): void {
  const record = readJson<RunRecord>(recordPath);
  writeJsonAtomic(recordPath, {
    ...record,
    status,
    updatedAt,
  } satisfies RunRecord);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath: string, value: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, value, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
