import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, AgentRegistry } from "./types.ts";
import { isSddAgent, readModelRoutingConfig, resolveModelRoute } from "./model-routing.ts";
import { launchChildProcess } from "./child-launch.ts";
import { createRunRecord, recoverRun, storeRunOutput, type RecoveredRun, type RunRecord } from "./result-store.ts";
import type { DelegationEnvelope } from "./envelopes.ts";

export const LORE_MEMORY_EXTENSION_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "lore-memory.ts");
export const DEFAULT_DELEGATIONS_ROOT = path.join(os.homedir(), ".local", "share", "lore", "pi", "delegations");
export const DELEGATIONS_ROOT_ENV = "LORE_PI_RUNTIME_RUN_ROOT";
export const PI_COMMAND_ENV = "LORE_PI_RUNTIME_PI_COMMAND";

export const LORE_MEMORY_TOOL_BUNDLE = "lore:*";
export const LORE_MEMORY_TOOLS = [
  "lore_search",
  "lore_save",
  "lore_get_observation",
  "lore_context",
  "lore_project_list",
  "lore_project_create",
  "lore_project_get",
  "lore_skill_save",
  "lore_skill_list",
  "lore_skill_get",
] as const;

export interface StartDelegationInput {
  registry: AgentRegistry;
  requestedAgent?: string;
  task: string;
  cwd?: string;
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
  });

  const launch = await launchChildProcess({
    cwd,
    prompt: input.task,
    delegationId,
    requestedAgent: agentName,
    canonicalAgent: agent.name,
    runDir: record.runDir,
    tools: expandAgentTools([...(agent.tools ?? []), ...LORE_MEMORY_TOOLS, "contact_supervisor"]),
    extensionSources: discoverChildExtensions(),
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

export function listDelegations(status?: string, limit?: number): ListedDelegation[] {
  const rootDir = path.resolve(process.env[DELEGATIONS_ROOT_ENV] ?? DEFAULT_DELEGATIONS_ROOT);
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidDelegationId(entry.name))
    .map((entry) => recoverRun(resolveDelegationRunDir(rootDir, entry.name)))
    .filter((run) => !status || run.status?.status === status)
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
  const expanded: string[] = [];
  for (const tool of tools) {
    if (tool === LORE_MEMORY_TOOL_BUNDLE) {
      expanded.push(...LORE_MEMORY_TOOLS);
      continue;
    }
    expanded.push(tool);
  }
  return expanded;
}

function resolveAgent(registry: AgentRegistry, requestedAgent: string): AgentDefinition {
  const alias = AGENT_ALIASES[requestedAgent] ?? requestedAgent;
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

function buildChildSystemPrompt(agent: AgentDefinition): string {
  const base = agent.body.trim();
  const envelope = isSddAgent(agent.name)
    ? `Return ONLY one JSON object with exactly these keys: status, phase, summary, artifacts, next, question, options, risks, skill_resolution. phase must match the SDD phase. status must be one of: completed, running, needs_user_input, failed. skill_resolution must be one of: injected, fallback-registry, fallback-path, none. artifacts/options/risks must be string arrays. next/question must be string or null.`
    : `Return ONLY one JSON object with exactly these keys: status, summary, artifacts, next, question, options, risks, skill_resolution. Do not include prose, markdown fences, or extra keys. status must be one of: completed, running, needs_user_input, failed. skill_resolution must be one of: injected, fallback-registry, fallback-path, none. artifacts/options/risks must be string arrays. next/question must be string or null.`;
  const example = isSddAgent(agent.name)
    ? `Example shape: {"status":"completed","phase":"apply","summary":"...","artifacts":[],"next":null,"question":null,"options":[],"risks":[],"skill_resolution":"none"}`
    : `Example shape: {"status":"completed","summary":"...","artifacts":[],"next":null,"question":null,"options":[],"risks":[],"skill_resolution":"none"}`;
  return [base, "", "## Required final response contract", envelope, example].filter(Boolean).join("\n");
}

function discoverChildExtensions(): string[] {
  const currentExtensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension/index.ts");
  const extensions = [currentExtensionPath];
  if (fs.existsSync(LORE_MEMORY_EXTENSION_PATH)) {
    extensions.push(LORE_MEMORY_EXTENSION_PATH);
  }
  return extensions;
}

async function finalizeChildRun(
  record: RunRecord,
  stdout: NodeJS.ReadableStream,
  stderr: NodeJS.ReadableStream,
  completion: Promise<number>,
  onFinish?: (event: BackgroundDelegationEvent) => void,
): Promise<void> {
  const [stdoutText, stderrText] = await Promise.all([readStream(stdout), readStream(stderr), completion]);
  const rawOutput = stdoutText.trim() || stderrText.trim() || JSON.stringify({
    status: "failed",
    summary: "Child process exited without JSON output.",
    artifacts: [],
    next: null,
    question: null,
    options: [],
    risks: stderrText.trim() ? [stderrText.trim()] : [],
    skill_resolution: "none",
  });
  const result = storeRunOutput(record, rawOutput, stderrText);
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

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream) {
    output += chunk.toString();
  }
  return output;
}

const AGENT_ALIASES: Record<string, string> = {
  reviewer: "lore-worker",
  researcher: "lore-worker",
  scribe: "lore-worker",
  general: "lore-worker",
};
