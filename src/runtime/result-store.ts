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
    stderr: string;
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
  stderrPath?: string;
  parseError?: string;
}

export interface RecoveredRun {
  record: RunRecord;
  status: StoredRunStatus | null;
  result: StoredRunResult | null;
  rawOutput: string | null;
  stderr: string | null;
}

const RECORD_FILE = "record.json";
const STATUS_FILE = "status.json";
const RESULT_FILE = "result.json";
const RAW_OUTPUT_FILE = "raw-output.txt";
const STDERR_FILE = "stderr.txt";
const MAX_RECOVERED_TEXT_BYTES = 1024 * 1024;

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
      stderr: path.join(runDir, STDERR_FILE),
    },
  };

  writeJsonAtomic(record.files.record, record);
  writeJsonAtomic(record.files.status, {
    status: record.status,
    updatedAt: timestamp,
  } satisfies StoredRunStatus);

  return record;
}

export function storeRunOutput(record: RunRecord, rawOutput: string, stderrText = ""): StoredRunResult {
  writeTextAtomic(record.files.rawOutput, rawOutput);
  if (stderrText.trim()) {
    writeTextAtomic(record.files.stderr, stderrText);
  } else if (fs.existsSync(record.files.stderr)) {
    fs.rmSync(record.files.stderr, { force: true });
  }

  const timestamp = new Date().toISOString();
  const stored = buildStoredRunArtifacts({
    rawOutput,
    updatedAt: timestamp,
    rawOutputPath: record.files.rawOutput,
    stderrPath: stderrText.trim() ? record.files.stderr : undefined,
  });

  writeJsonAtomic(record.files.status, stored.status);
  writeJsonAtomic(record.files.result, stored.result);
  updateRecordStatus(record.files.record, stored.status.status, timestamp);

  return stored.result;
}

export function recoverRun(runDir: string): RecoveredRun {
  const absoluteRunDir = path.resolve(runDir);
  const recordPath = path.join(absoluteRunDir, RECORD_FILE);
  const statusPath = path.join(absoluteRunDir, STATUS_FILE);
  const resultPath = path.join(absoluteRunDir, RESULT_FILE);
  const rawOutputPath = path.join(absoluteRunDir, RAW_OUTPUT_FILE);
  const stderrPath = path.join(absoluteRunDir, STDERR_FILE);

  const record = readJson<RunRecord>(recordPath);
  const rawOutput = fs.existsSync(rawOutputPath) ? readTextTail(rawOutputPath, MAX_RECOVERED_TEXT_BYTES) : null;
  const stderr = fs.existsSync(stderrPath) ? readTextTail(stderrPath, MAX_RECOVERED_TEXT_BYTES) : null;
  let status = fs.existsSync(statusPath) ? readJson<StoredRunStatus>(statusPath) : null;
  let result = fs.existsSync(resultPath) ? readJson<StoredRunResult>(resultPath) : null;

  if ((!status || !result) && rawOutput) {
    const updatedAt = new Date().toISOString();
    const stored = buildStoredRunArtifacts({
      rawOutput,
      updatedAt,
      rawOutputPath,
      stderrPath: stderr ? stderrPath : undefined,
    });
    status ??= stored.status;
    result ??= stored.result;
  }

  return {
    record,
    status,
    result,
    rawOutput,
    stderr,
  };
}

export function extractEnvelopeOutput(rawOutput: string): string {
  const direct = parseEnvelope(rawOutput);
  if (direct.ok) {
    return rawOutput;
  }

  const fromPiJSON = extractLastAssistantTextFromPiJSON(rawOutput);
  return fromPiJSON ?? rawOutput;
}

function extractLastAssistantTextFromPiJSON(rawOutput: string): string | null {
  let lastAssistantText: string | null = null;

  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(event) || event.type !== "message_end") continue;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const text = message.content
      .filter((part): part is { type: string; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (text) {
      lastAssistantText = text;
    }
  }

  return lastAssistantText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildStoredRunArtifacts(input: {
  rawOutput: string;
  updatedAt: string;
  rawOutputPath: string;
  stderrPath?: string;
}): { status: StoredRunStatus; result: StoredRunResult } {
  const parsed = parseEnvelope(extractEnvelopeOutput(input.rawOutput));
  const invalidFinalStateError = "Final child envelope cannot use status 'running'; use completed, needs_user_input, or failed.";

  if (parsed.ok && parsed.envelope.status !== "running") {
    return {
      status: {
        status: parsed.envelope.status,
        updatedAt: input.updatedAt,
        summary: parsed.envelope.summary,
        envelopeKind: parsed.kind,
      },
      result: {
        status: parsed.envelope.status,
        updatedAt: input.updatedAt,
        envelope: parsed.envelope,
        rawOutputPath: input.rawOutputPath,
        ...(input.stderrPath ? { stderrPath: input.stderrPath } : {}),
      },
    };
  }

  const parseError = parsed.ok ? invalidFinalStateError : parsed.error;
  return {
    status: {
      status: "failed",
      updatedAt: input.updatedAt,
      parseError,
    },
    result: {
      status: "failed",
      updatedAt: input.updatedAt,
      rawOutputPath: input.rawOutputPath,
      ...(input.stderrPath ? { stderrPath: input.stderrPath } : {}),
      parseError,
    },
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

function readTextTail(filePath: string, maxBytes: number): string {
  const stats = fs.statSync(filePath);
  if (stats.size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8");
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, stats.size - maxBytes);
    return `[file truncated; kept last ${maxBytes} bytes of ${stats.size}]\n${buffer.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}
