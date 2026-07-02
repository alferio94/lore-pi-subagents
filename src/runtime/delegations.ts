import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getInstallPolicy, getRuntimeInvariants, resolveBuiltinAgentName } from "./contract.ts";
import type { AgentDefinition, AgentRegistry } from "./types.ts";
import { isSddAgent, readModelRoutingConfig, resolveModelRoute } from "./model-routing.ts";
import { launchChildProcess } from "./child-launch.ts";
import { resolveApprovedChildMcpAdapterExtensions } from "./child-mcp-adapter.ts";
import { createRunRecord, recoverRun, storeRunOutput, type RecoveredRun, type RunRecord } from "./result-store.ts";
import {
  RUN_STATUSES,
  SDD_PHASES,
  SKILL_RESOLUTIONS,
  type DelegationEnvelope,
  type EnvelopeKind,
} from "./envelopes.ts";

export const DEFAULT_DELEGATIONS_ROOT = path.join(os.homedir(), ".local", "share", "lore", "pi", "delegations");
export const DELEGATIONS_ROOT_ENV = "LORE_PI_RUNTIME_RUN_ROOT";
export const PI_COMMAND_ENV = "LORE_PI_RUNTIME_PI_COMMAND";
export const MAX_CAPTURED_STREAM_BYTES = 8 * 1024 * 1024;

/**
 * Canonical flat MCP Lore Server compatibility tool names. The runtime no
 * longer autoloads the deprecated Pi-native `lore-memory.ts` extension;
 * memory operations are exposed to child agents through explicitly allowed
 * MCP tools instead.
 */
export const FLAT_LORE_MCP_TOOLS = [
  "lore_memory_search",
  "lore_memory_get",
  "lore_memory_save",
  "lore_memory_update",
  "lore_memory_list_projects",
  "lore_memory_list_skills",
] as const;

/**
 * Observed harness-prefixed Lore MCP tool names used by the active Lore MCP
 * server for SDD artifact persistence and project orientation. Do not add
 * `lore_lore_memory_update`: the observed MCP surface uses save/topic-key
 * upsert semantics instead.
 */
export const OBSERVED_PREFIXED_LORE_MCP_TOOLS = [
  "lore_lore_memory_search",
  "lore_lore_memory_get",
  "lore_lore_memory_save",
  "lore_lore_project_list",
  "lore_lore_project_context",
  "lore_lore_project_activity",
] as const;

export const MCP_LORE_MEMORY_TOOLS = [
  ...FLAT_LORE_MCP_TOOLS,
  ...OBSERVED_PREFIXED_LORE_MCP_TOOLS,
] as const;

/**
 * Broad MCP gateway exposed only when the approved pi-mcp-adapter extension is
 * explicitly loaded for a child. Kept separate from direct Lore tool names so
 * the wider capability is visible and can be narrowed later.
 */
export const CHILD_MCP_GATEWAY_TOOLS = ["mcp"] as const;

export interface StartDelegationInput {
  registry: AgentRegistry;
  requestedAgent?: string;
  task: string;
  cwd?: string;
  sessionId?: string;
  runInBackground?: boolean;
  onBackgroundFinish?: (event: BackgroundDelegationEvent) => void;
}

export interface StartedDelegation {
  record: RunRecord;
  recovery: RecoveredRun;
}

export interface ListedDelegation {
  id: string;
  agent: string;
  status: string;
  requestedAgent: string;
  canonicalAgent: string;
  summary?: string;
  updatedAt: string;
  runDir: string;
}

export interface BackgroundDelegationEvent {
  delegationId: string;
  agent: string;
  requestedAgent: string;
  canonicalAgent: string;
  status: RunRecord["status"];
  summary?: string;
  parseError?: string;
  envelope?: DelegationEnvelope;
  runDir: string;
}

export interface DelegationRuntimePolicy {
  aliases: ReadonlyMap<string, string>;
  retainedExtensions: string[];
  blockedLegacyExtensions: string[];
  conflictPolicy: string;
  parentOnlyTools: string[];
  childOnlyTools: string[];
}

const activeBackgroundRuns = new Map<string, Promise<void>>();

export async function startDelegation(input: StartDelegationInput): Promise<StartedDelegation> {
  const agentName = normalizeRequestedAgent(input.requestedAgent);
  const agent = resolveAgent(input.registry, agentName);
  const delegationId = createDelegationId();
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const runRoot = path.resolve(process.env[DELEGATIONS_ROOT_ENV] ?? DEFAULT_DELEGATIONS_ROOT);

  const modelConfig = await readModelRoutingConfig();
  const route = resolveModelRoute({
    agentName: agent.name,
    isSdd: isSddAgent(agent.name),
    agentModel: agent.model,
    agentThinking: agent.thinking,
    config: modelConfig,
  });

  const record = createRunRecord({
    rootDir: runRoot,
    delegationId,
    requestedAgent: agentName,
    canonicalAgent: agent.name,
    cwd,
    modelRef: route.model,
    sessionId: input.sessionId,
  });

  const childPolicy = getDelegationRuntimePolicy();
  const approvedAdapterExtensions = resolveApprovedChildMcpAdapterExtensions();
  const childExtensions = dedupePaths([...discoverChildExtensions(), ...approvedAdapterExtensions]);
  const hasMcpAdapter = approvedAdapterExtensions.length > 0;
  const childTools = expandAgentTools([
    ...(agent.tools ?? []),
    ...MCP_LORE_MEMORY_TOOLS,
    ...(hasMcpAdapter ? CHILD_MCP_GATEWAY_TOOLS : []),
    ...childPolicy.childOnlyTools,
  ]);

  const launch = await launchChildProcess({
    cwd,
    prompt: input.task,
    delegationId,
    requestedAgent: agentName,
    canonicalAgent: agent.name,
    runDir: record.runDir,
    tools: childTools,
    extensionSources: childExtensions,
    systemPrompt: buildChildSystemPrompt(agent),
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    model: route.model,
    thinking: route.thinking,
    piCommand: process.env[PI_COMMAND_ENV] ?? undefined,
  });

  const completion = finalizeChildRun(record, launch.child.stdout, launch.child.stderr, launch.completion, input.onBackgroundFinish);

  if (input.runInBackground) {
    activeBackgroundRuns.set(record.id, completion.finally(() => activeBackgroundRuns.delete(record.id)));
    return {
      record,
      recovery: recoverRun(record.runDir),
    };
  }

  await completion;
  return {
    record,
    recovery: recoverRun(record.runDir),
  };
}

export function listDelegations(status?: string, limit?: number, sessionId?: string): ListedDelegation[] {
  const rootDir = path.resolve(process.env[DELEGATIONS_ROOT_ENV] ?? DEFAULT_DELEGATIONS_ROOT);
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidDelegationId(entry.name))
    .map((entry) => recoverRun(resolveDelegationRunDir(rootDir, entry.name)))
    .filter((run) => !status || run.status?.status === status)
    .filter((run) => !sessionId || run.record.sessionId === sessionId)
    .map((run) => ({
      id: run.record.id,
      agent: formatListedAgent(run.record.requestedAgent, run.record.canonicalAgent),
      status: run.status?.status ?? run.record.status,
      requestedAgent: run.record.requestedAgent,
      canonicalAgent: run.record.canonicalAgent,
      summary: run.status?.summary,
      updatedAt: run.status?.updatedAt ?? run.record.updatedAt,
      runDir: run.record.runDir,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    return entries.slice(0, limit);
  }
  return entries;
}

export function readDelegation(id: string): RecoveredRun {
  const rootDir = path.resolve(process.env[DELEGATIONS_ROOT_ENV] ?? DEFAULT_DELEGATIONS_ROOT);
  return recoverRun(resolveDelegationRunDir(rootDir, id));
}

export function getDelegationRuntimePolicy(): DelegationRuntimePolicy {
  const installPolicy = getInstallPolicy();
  const runtimeInvariants = getRuntimeInvariants();
  const aliases = new Map<string, string>();
  for (const alias of ["reviewer", "researcher", "scribe", "general"]) {
    aliases.set(alias, resolveBuiltinAgentName(alias));
  }

  return {
    aliases,
    retainedExtensions: [...installPolicy.retainedExtensions],
    blockedLegacyExtensions: [...installPolicy.blockedLegacyExtensions],
    conflictPolicy: installPolicy.conflictPolicy,
    parentOnlyTools: [...runtimeInvariants.toolBoundaries.parentOnly],
    childOnlyTools: [...runtimeInvariants.toolBoundaries.childOnly],
  };
}

function resolveDelegationRunDir(rootDir: string, delegationId: string): string {
  if (!isValidDelegationId(delegationId)) {
    throw new Error(`Invalid delegation id '${delegationId}'.`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const runDir = path.resolve(resolvedRoot, delegationId);
  const relative = path.relative(resolvedRoot, runDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Delegation id '${delegationId}' escapes the delegations root.`);
  }

  return runDir;
}

function isValidDelegationId(value: string): boolean {
  return /^dg-[0-9a-f]{8}$/.test(value);
}

export function expandAgentTools(tools: string[]): string[] {
  const policy = getDelegationRuntimePolicy();
  const parentOnly = new Set(policy.parentOnlyTools);
  const childOnly = new Set(policy.childOnlyTools);
  const expanded: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    for (const candidate of [tool]) {
      if (parentOnly.has(candidate)) {
        continue;
      }
      if (!seen.has(candidate)) {
        expanded.push(candidate);
        seen.add(candidate);
      }
    }
  }

  for (const tool of childOnly) {
    if (!seen.has(tool)) {
      expanded.push(tool);
      seen.add(tool);
    }
  }

  return expanded;
}

function resolveAgent(registry: AgentRegistry, requestedAgent: string): AgentDefinition {
  const alias = resolveBuiltinAgentName(requestedAgent);
  const agent = registry.byName.get(alias);
  if (agent) return agent;
  throw new Error(`Unknown Lore agent '${requestedAgent}'.`);
}

function normalizeRequestedAgent(requestedAgent: string | undefined): string {
  return typeof requestedAgent === "string" && requestedAgent.trim() ? requestedAgent.trim() : "lore-worker";
}

function createDelegationId(): string {
  return `dg-${randomUUID().split("-")[0]}`;
}

export function buildChildSystemPrompt(agent: AgentDefinition): string {
  const base = agent.body.trim();
  const isSdd = agent.requiredEnvelope === "sdd" || (agent.phase !== undefined) || isSddAgent(agent.name);
  const envelope = isSdd
    ? injectCanonicalPiAdapterContract("sdd", agent.phase)
    : injectCanonicalPiAdapterContract("worker");
  const example = isSdd
    ? `Example shape: {"status":"completed","phase":"${agent.phase ?? "apply"}","summary":"...","artifacts":[],"files":[],"validations":[],"risks":[],"next_step":null,"continuation":null,"question":null,"options":[],"skill_resolution":"none"}`
    : `Example shape: {"status":"completed","summary":"...","artifacts":[],"files":[],"validations":[],"risks":[],"next_step":null,"continuation":null,"question":null,"options":[],"skill_resolution":"none"}`;
  return [base, "", "## Required final response contract", envelope, example].filter(Boolean).join("\n");
}

/**
 * Build the canonical Pi Lore delegation adapter final response contract. The
 * field list, status set, phase set, and skill_resolution set are derived
 * directly from `envelopes.ts` so the runtime validator and the prompt stay
 * in lockstep. The wording is explicitly labeled as the Pi adapter contract;
 * core SDD behavior remains harness-agnostic and other harnesses (Codex,
 * Antigravity) are NOT required to consume this exact JSON envelope.
 */
export function injectCanonicalPiAdapterContract(kind: EnvelopeKind, defaultPhase?: string): string {
  const fieldList = canonicalPiFields(kind);
  const finalStatuses = canonicalFinalStatuses();
  const skillResolutions = SKILL_RESOLUTIONS.join(", ");

  const lines: string[] = [
    "Pi Lore delegation adapter contract (final child JSON envelope).",
    `Return ONLY one JSON object with exactly these keys: ${fieldList}.`,
  ];
  if (kind === "sdd") {
    lines.push(`phase must match the SDD phase (one of: ${SDD_PHASES.join(", ")}).`);
  }
  lines.push(
    "summary should stay concise.",
    "artifacts/files/validations/options/risks must be string arrays.",
    "next_step/continuation/question must be a string or null.",
    `Final output status must be one of: ${finalStatuses}.`,
    "Do not use running in the final response; running is reserved for parent-side transient process state while the child is still alive.",
    `skill_resolution must be one of: ${skillResolutions}.`,
  );
  // defaultPhase is exposed via example shape in buildChildSystemPrompt; the contract line itself
  // intentionally documents the phase set so the model cannot substitute a custom value.
  void defaultPhase;
  return lines.join(" ");
}

function canonicalPiFields(kind: EnvelopeKind): string {
  const workerFields = [
    "status",
    "summary",
    "artifacts",
    "files",
    "validations",
    "risks",
    "next_step",
    "continuation",
    "question",
    "options",
    "skill_resolution",
  ];
  if (kind === "sdd") {
    return ["status", "phase", ...workerFields.slice(1)].join(", ");
  }
  return workerFields.join(", ");
}

function canonicalFinalStatuses(): string {
  // Final child envelope statuses: completed, needs_user_input, failed.
  // `running` is intentionally excluded — runtime finalization rejects it.
  return RUN_STATUSES.filter((status) => status !== "running").join(", ");
}

export function discoverChildExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  // The Pi-native `lore-memory.ts` extension was removed from active runtime
  // paths. Memory operations are exposed to child agents through the approved
  // MCP adapter when installed, or through OpenSpec fallback when absent. The
  // current runtime extension is always loaded explicitly; ambient Pi extension
  // discovery remains disabled by child-launch's `--no-extensions` flag.
  const currentExtensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension/index.ts");
  return dedupePaths([currentExtensionPath, ...resolveApprovedChildMcpAdapterExtensions(env)]);
}

function dedupePaths(paths: string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    const value = path.resolve(item);
    if (seen.has(value)) continue;
    seen.add(value);
    resolved.push(value);
  }
  return resolved;
}

export async function finalizeChildRun(
  record: RunRecord,
  stdout: NodeJS.ReadableStream,
  stderr: NodeJS.ReadableStream,
  completion: Promise<number>,
  onFinish?: (event: BackgroundDelegationEvent) => void,
): Promise<void> {
  let result: ReturnType<typeof storeRunOutput>;

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readStreamTail(stdout, MAX_CAPTURED_STREAM_BYTES),
      readStreamTail(stderr, MAX_CAPTURED_STREAM_BYTES),
      completion,
    ]);
    const rawOutput = stdoutText.trim() || stderrText.trim() || JSON.stringify({
      status: "failed",
      summary: exitCode === 0 ? "Child process exited without JSON output." : `Child process exited with code ${exitCode} without JSON output.`,
      artifacts: [],
      files: [],
      validations: [],
      risks: stderrText.trim() ? [stderrText.trim()] : [],
      next_step: null,
      continuation: null,
      question: null,
      options: [],
      skill_resolution: "none",
    });
    result = storeRunOutput(record, rawOutput, stderrText);
  } catch (error) {
    const stderrText = formatError(error);
    result = storeRunOutput(record, JSON.stringify({
      status: "failed",
      summary: "Child process failed before producing a final envelope.",
      artifacts: [],
      files: [],
      validations: [],
      risks: [stderrText],
      next_step: null,
      continuation: null,
      question: null,
      options: [],
      skill_resolution: "none",
    }), stderrText);
  }

  onFinish?.({
    delegationId: record.id,
    agent: formatListedAgent(record.requestedAgent, record.canonicalAgent),
    requestedAgent: record.requestedAgent,
    canonicalAgent: record.canonicalAgent,
    status: result.status,
    summary: result.envelope?.summary,
    parseError: result.parseError,
    envelope: result.envelope,
    runDir: record.runDir,
  });
}

function formatListedAgent(requestedAgent: string, canonicalAgent: string): string {
  return requestedAgent === canonicalAgent ? canonicalAgent : `${requestedAgent} -> ${canonicalAgent}`;
}

export function formatBackgroundNotification(event: BackgroundDelegationEvent): string {
  const detail = sanitizeNotificationText(event.parseError ?? event.summary) ?? "No summary provided.";
  return `Background delegation ${event.delegationId} (${event.agent}) ${event.status}: ${detail}`;
}

function sanitizeNotificationText(value: string | undefined, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStreamTail(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  let output = "";
  let truncatedBytes = 0;

  for await (const chunk of stream) {
    output += chunk.toString();
    if (Buffer.byteLength(output, "utf8") <= maxBytes) continue;

    const overflow = Buffer.byteLength(output, "utf8") - maxBytes;
    truncatedBytes += overflow;
    output = trimUtf8Start(output, maxBytes);
  }

  if (truncatedBytes === 0) return output;
  return `[stream truncated; kept last ${maxBytes} bytes, dropped at least ${truncatedBytes} bytes]\n${output}`;
}

function trimUtf8Start(value: string, maxBytes: number): string {
  let output = value;
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    const excess = Buffer.byteLength(output, "utf8") - maxBytes;
    output = output.slice(Math.max(1, excess));
  }
  return output;
}
