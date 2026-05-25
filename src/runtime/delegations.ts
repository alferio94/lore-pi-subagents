import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, AgentRegistry } from "./types.ts";
import { isSddAgent, readModelRoutingConfig, resolveModelRoute } from "./model-routing.ts";
import { launchChildProcess } from "./child-launch.ts";
import { createRunRecord, recoverRun, storeRunOutput, type RecoveredRun, type RunRecord } from "./result-store.ts";

export const LORE_MEMORY_EXTENSION_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "lore-memory.ts");
export const DEFAULT_DELEGATIONS_ROOT = path.join(os.homedir(), ".local", "share", "lore", "pi", "delegations");
export const DELEGATIONS_ROOT_ENV = "LORE_PI_RUNTIME_RUN_ROOT";
export const PI_COMMAND_ENV = "LORE_PI_RUNTIME_PI_COMMAND";

export interface StartDelegationInput {
  registry: AgentRegistry;
  requestedAgent?: string;
  task: string;
  cwd?: string;
  runInBackground?: boolean;
}

export interface StartedDelegation {
  record: RunRecord;
  recovery: RecoveredRun;
}

export interface ListedDelegation {
  id: string;
  status: string;
  requestedAgent: string;
  canonicalAgent: string;
  summary?: string;
  updatedAt: string;
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
    tools: [...(agent.tools ?? []), "contact_supervisor"],
    extensionSources: discoverChildExtensions(),
    systemPrompt: agent.body,
    model: route.model,
    thinking: route.thinking,
    piCommand: process.env[PI_COMMAND_ENV] ?? undefined,
  });

  const completion = finalizeChildRun(record, launch.child.stdout, launch.child.stderr, launch.completion);

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
    .filter((entry) => entry.isDirectory())
    .map((entry) => recoverRun(path.join(rootDir, entry.name)))
    .filter((run) => !status || run.status?.status === status)
    .map((run) => ({
      id: run.record.id,
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
  return recoverRun(path.join(rootDir, id));
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
  storeRunOutput(record, rawOutput);
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
