import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CHILD_MARKER_ENV,
  CHILD_RUN_DIR_ENV,
  CHILD_CANONICAL_AGENT_ENV,
  CHILD_DELEGATION_ID_ENV,
  CHILD_REQUESTED_AGENT_ENV,
} from "../runtime/child-launch.ts";
import { discoverAgentRegistry } from "../runtime/agent-registry.ts";
import {
  formatBackgroundNotification,
  startDelegation,
  listDelegations,
  readDelegation,
  type BackgroundDelegationEvent,
} from "../runtime/delegations.ts";
import { readModelRoutingConfig, writeModelRoutingConfig } from "../runtime/model-routing.ts";
import { openLoreModelsUI } from "../ui/lore-models.ts";
import { DELEGATION_TRACE_FILE, openDelegationViewer } from "../ui/delegations.ts";

export const EXTENSION_NAME = "lore-pi-runtime";
export const DELEGATE_TOOL_NAME = "delegate";
export const DELEGATION_READ_TOOL_NAME = "delegation_read";
export const DELEGATION_LIST_TOOL_NAME = "delegation_list";
export const CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";
export const LORE_MODELS_COMMAND = "lore-models";

interface AvailableModelDescriptor {
  provider: string;
  id: string;
  name?: string;
}

interface ToolExecuteContext {
  sessionManager?: {
    getSessionId(): string;
  };
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface SendMessageCapablePi {
  sendMessage?: (message: { customType: string; display: boolean; content: string; details?: Record<string, unknown> }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) => void;
}

interface ShortcutCapablePi {
  registerShortcut?: (shortcut: string, options: { description?: string; handler: (ctx: unknown) => Promise<void> | void }) => void;
}

interface EventCapablePi {
  on?: ExtensionAPI["on"];
}

type SubagentState = "running" | "completed" | "error";

const subagentStates = new Map<string, SubagentState>();

const DELEGATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    agent: { type: "string", description: "Requested agent name." },
    task: { type: "string", description: "Task to delegate to the child agent." },
    cwd: { type: "string", description: "Optional working directory override." },
    async: { type: "boolean", description: "Run in background when true." },
  },
  required: ["task"],
} as const;

const DELEGATION_READ_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Delegation id to inspect." },
  },
  required: ["id"],
} as const;

const DELEGATION_LIST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", description: "Optional status filter." },
    limit: { type: "number", description: "Optional max number of runs to return." },
  },
} as const;

const CONTACT_SUPERVISOR_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", description: "Why the child needs the supervisor." },
    message: { type: "string", description: "Decision or escalation request for the supervisor." },
    question: { type: "string", description: "Optional blocking question for the parent." },
    options: {
      type: "array",
      description: "Optional decision options.",
      items: { type: "string" },
    },
  },
  required: ["reason", "message"],
} as const;

export default function lorePiRuntime(pi: ExtensionAPI): void {
  if (!isChildRuntime()) {
    pi.registerTool({
      name: DELEGATE_TOOL_NAME,
      label: "Delegate",
      description: "Delegate one bounded task to a Lore child agent.",
      parameters: DELEGATE_PARAMETERS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx?: ToolExecuteContext) {
        try {
          const registry = discoverAgentRegistry({ cwd: typeof params.cwd === "string" ? params.cwd : process.cwd() });
          const started = await startDelegation({
            registry,
            requestedAgent: typeof params.agent === "string" ? params.agent : undefined,
            task: String(params.task),
            cwd: typeof params.cwd === "string" ? params.cwd : undefined,
            sessionId: ctx?.sessionManager?.getSessionId(),
            runInBackground: params.async === true,
            onBackgroundFinish: params.async === true
              ? (event) => {
                  updateSubagentStatus(ctx, event.delegationId, event.status === "completed" ? "completed" : "error");
                  const level = event.status === "completed" ? "info" : event.status === "needs_user_input" ? "warning" : "error";
                  ctx?.ui?.notify?.(formatBackgroundNotification(event), level);
                  sendBackgroundCompletionMessage(pi, event);
                }
              : undefined,
          });

          if (params.async === true) {
            updateSubagentStatus(ctx, started.record.id, "running");
          }

          const status = started.recovery.status?.status ?? started.record.status;
          const summary = started.recovery.status?.summary ?? `${started.record.canonicalAgent} started.`;
          return {
            content: [{ type: "text", text: `${started.record.id}: ${summary}` }],
            details: {
              id: started.record.id,
              status,
              requestedAgent: started.record.requestedAgent,
              canonicalAgent: started.record.canonicalAgent,
              runDir: started.record.runDir,
              envelope: started.recovery.result?.envelope ?? null,
              next: params.async === true ? DELEGATION_READ_TOOL_NAME : started.recovery.result?.envelope?.next_step ?? null,
              nextStep: params.async === true ? DELEGATION_READ_TOOL_NAME : started.recovery.result?.envelope?.next_step ?? null,
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: formatError(error) }],
            details: {
              id: "",
              status: "failed" as const,
              requestedAgent: "",
              canonicalAgent: "",
              runDir: "",
              envelope: null,
              next: null,
              nextStep: null,
            },
            isError: true,
          };
        }
      },
    });

    pi.registerTool({
      name: DELEGATION_READ_TOOL_NAME,
      label: "Delegation Read",
      description: "Read a persisted Lore delegation run by id.",
      parameters: DELEGATION_READ_PARAMETERS,
      async execute(_toolCallId, params) {
        try {
          const run = readDelegation(String(params.id));
          return {
            content: [{ type: "text", text: formatDelegationReadText(run) }],
            details: {
              id: run.record.id,
              status: run.status?.status ?? run.record.status,
              requestedAgent: run.record.requestedAgent,
              canonicalAgent: run.record.canonicalAgent,
              runDir: run.record.runDir,
              envelope: run.result?.envelope ?? null,
              parseError: run.result?.parseError ?? null,
              rawOutputPath: run.result?.rawOutputPath ?? run.record.files.rawOutput,
              stderrPath: run.result?.stderrPath ?? (run.stderr ? run.record.files.stderr : null),
              rawOutputPreview: previewText(run.rawOutput),
              stderrPreview: previewText(run.stderr),
              references: {
                recordPath: run.record.files.record,
                statusPath: run.record.files.status,
                resultPath: run.record.files.result,
                rawOutputPath: run.result?.rawOutputPath ?? run.record.files.rawOutput,
                stderrPath: run.result?.stderrPath ?? (run.stderr ? run.record.files.stderr : null),
              },
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: formatError(error) }],
            details: {
              id: String(params.id ?? ""),
              status: "failed" as const,
              requestedAgent: "",
              canonicalAgent: "",
              runDir: "",
              envelope: null,
              parseError: formatError(error),
              rawOutputPath: "",
              stderrPath: null,
              rawOutputPreview: null,
              stderrPreview: null,
              references: {
                recordPath: "",
                statusPath: "",
                resultPath: "",
                rawOutputPath: "",
                stderrPath: null,
              },
            },
            isError: true,
          };
        }
      },
    });

    pi.registerTool({
      name: DELEGATION_LIST_TOOL_NAME,
      label: "Delegation List",
      description: "List persisted Lore delegation runs.",
      parameters: DELEGATION_LIST_PARAMETERS,
      async execute(_toolCallId, params) {
        try {
          const runs = listDelegations(
            typeof params.status === "string" && params.status.trim() ? params.status : undefined,
            typeof params.limit === "number" ? params.limit : undefined,
          );
          return {
            content: [{ type: "text", text: formatDelegationListText(runs) }],
            details: { runs },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: formatError(error) }],
            details: { runs: [] },
            isError: true,
          };
        }
      },
    });

    pi.registerCommand(LORE_MODELS_COMMAND, {
      description: "Open the global /lore-models routing editor.",
      handler: async (_args, ctx) => {
        const registry = discoverAgentRegistry({ cwd: ctx.cwd });
        const availableModels = await getAvailableModelRefs(ctx);
        if (availableModels.length === 0) {
          ctx.ui.notify("No available Pi models detected; /lore-models will allow manual model entry only.", "warning");
        }
        await openLoreModelsUI(ctx as never, {
          availableModels,
          agentNames: registry.agents.map((agent) => agent.name),
          readConfig: readModelRoutingConfig,
          writeConfig: writeModelRoutingConfig,
        });
      },
    });

    const shortcutApi = pi as unknown as ShortcutCapablePi;
    shortcutApi.registerShortcut?.("ctrl+space", {
      description: "Open the Lore background delegation viewer.",
      handler: async (ctx) => {
        await openDelegationViewer(ctx as never, { listDelegations, readDelegation });
      },
    });
    return;
  }

  registerChildTraceHooks(pi);

  pi.registerTool({
    name: CONTACT_SUPERVISOR_TOOL_NAME,
    label: "Contact Supervisor",
    description: "Child-only escalation hook that writes a durable supervisor request for the parent runtime.",
    parameters: CONTACT_SUPERVISOR_PARAMETERS,
    async execute(_toolCallId, params) {
      const runDir = process.env[CHILD_RUN_DIR_ENV];
      if (!runDir) {
        return {
          content: [{ type: "text", text: "Child runtime is missing its run directory; cannot persist supervisor request." }],
          details: { persisted: false, requestPath: "" },
          isError: true,
        };
      }

      const request = {
        delegationId: process.env[CHILD_DELEGATION_ID_ENV] ?? null,
        requestedAgent: process.env[CHILD_REQUESTED_AGENT_ENV] ?? null,
        canonicalAgent: process.env[CHILD_CANONICAL_AGENT_ENV] ?? null,
        reason: params.reason,
        message: params.message,
        question: typeof params.question === "string" ? params.question : null,
        options: Array.isArray(params.options) ? params.options : [],
        createdAt: new Date().toISOString(),
      };

      const requestPath = path.join(runDir, "supervisor-request.json");
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

      return {
        content: [{ type: "text", text: `Supervisor request saved to ${requestPath}.` }],
        details: {
          persisted: true,
          requestPath,
        },
      };
    },
  });
}

async function getAvailableModelRefs(ctx: { modelRegistry?: { getAvailable?: (() => unknown) | undefined } | undefined }): Promise<string[]> {
  const registry = ctx.modelRegistry;
  if (!registry?.getAvailable) return [];
  try {
    const available = await Promise.resolve(registry.getAvailable.call(registry));
    if (!Array.isArray(available)) return [];
    return available
      .map((model: AvailableModelDescriptor) => formatModelRef(model))
      .filter((model): model is string => Boolean(model));
  } catch {
    return [];
  }
}

function formatModelRef(model: AvailableModelDescriptor): string | undefined {
  if (!model?.provider || !model?.id) return undefined;
  return `${model.provider}/${model.id}`;
}

function registerChildTraceHooks(pi: ExtensionAPI): void {
  const eventApi = pi as unknown as EventCapablePi;
  if (typeof eventApi.on !== "function") return;

  eventApi.on("agent_start", async (_event, ctx) => {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    await appendChildTrace("agent_start", model ? { summary: `model ${model}`, model } : {});
  });
  eventApi.on("agent_end", async () => appendChildTrace("agent_end"));
  eventApi.on("turn_start", async (event) => appendChildTrace("turn_start", { turnIndex: event.turnIndex, summary: `turn ${event.turnIndex}` }));
  eventApi.on("turn_end", async (event) => appendChildTrace("turn_end", { turnIndex: event.turnIndex, summary: `turn ${event.turnIndex}` }));
  eventApi.on("message_end", async (event) => {
    const message = event.message as { role?: string; content?: unknown; provider?: string; model?: string; usage?: { input?: number; output?: number; totalTokens?: number } };
    if (message.role !== "assistant") return;
    const model = message.provider && message.model ? `${message.provider}/${message.model}` : message.model;
    if (message.usage) {
      await appendChildTrace("token_usage", {
        model,
        input: message.usage.input ?? 0,
        output: message.usage.output ?? 0,
        totalTokens: message.usage.totalTokens ?? ((message.usage.input ?? 0) + (message.usage.output ?? 0)),
        summary: `${message.usage.input ?? 0} in / ${message.usage.output ?? 0} out`,
      });
    }
    await appendChildTrace("assistant_message", { summary: compactJson(message.content, 600) });
  });
  eventApi.on("tool_execution_start", async (event) => appendChildTrace("tool_start", { toolName: event.toolName, summary: compactJson(event.args, 700) }));
  eventApi.on("tool_execution_update", async (event) => appendChildTrace("tool_update", { toolName: event.toolName, summary: compactJson(event.partialResult, 700) }));
  eventApi.on("tool_execution_end", async (event) => appendChildTrace("tool_end", { toolName: event.toolName, status: event.isError ? "error" : "ok", summary: compactJson(event.result, 900) }));
}

async function appendChildTrace(type: string, details: Record<string, unknown> = {}): Promise<void> {
  const runDir = process.env[CHILD_RUN_DIR_ENV];
  if (!runDir) return;
  const traceFile = path.join(runDir, DELEGATION_TRACE_FILE);
  const record = { ts: new Date().toISOString(), type, ...details };
  await fs.mkdir(runDir, { recursive: true });
  await fs.appendFile(traceFile, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
}

function compactJson(value: unknown, max = 1000): string {
  try {
    return compactText(JSON.stringify(compactValue(value)), max);
  } catch {
    return compactText(String(value), max);
  }
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return compactText(value, 1200);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= 3) {
    return `[${Array.isArray(value) ? "array" : "object"} omitted]`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => compactValue(item, depth + 1));
    if (value.length > 20) items.push(`… ${value.length - 20} more items`);
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 30)) {
    output[key] = compactValue(child, depth + 1);
  }
  const extraKeys = Object.keys(value).length - Object.keys(output).length;
  if (extraKeys > 0) output.__truncatedKeys = extraKeys;
  return output;
}

function compactText(value: string, max: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function isChildRuntime(): boolean {
  return process.env[CHILD_MARKER_ENV] === "1";
}

function formatDelegationListText(
  runs: Array<{ id: string; agent: string; status: string; summary?: string; updatedAt: string }>,
): string {
  if (runs.length === 0) {
    return "No delegations found.";
  }

  return [
    `Delegations: ${runs.length}`,
    ...runs.map((run) => [
      `- id: ${run.id}`,
      `  agent: ${run.agent}`,
      `  status: ${run.status}`,
      `  summary: ${run.summary ?? "(none)"}`,
      `  updatedAt: ${run.updatedAt}`,
    ].join("\n")),
  ].join("\n");
}

function formatDelegationReadText(run: ReturnType<typeof readDelegation>): string {
  const lines = [
    `${run.record.id}: ${run.status?.summary ?? run.status?.status ?? run.record.status}`,
    `status: ${run.status?.status ?? run.record.status}`,
    `agent: ${run.record.requestedAgent === run.record.canonicalAgent ? run.record.canonicalAgent : `${run.record.requestedAgent} -> ${run.record.canonicalAgent}`}`,
    `runDir: ${run.record.runDir}`,
    `rawOutput: ${run.result?.rawOutputPath ?? run.record.files.rawOutput}`,
  ];

  if (run.result?.envelope) {
    lines.push(`artifacts: ${run.result.envelope.artifacts.length > 0 ? run.result.envelope.artifacts.join("; ") : "(none)"}`);
    lines.push(`files: ${run.result.envelope.files.length > 0 ? run.result.envelope.files.join("; ") : "(none)"}`);
    lines.push(`validations: ${run.result.envelope.validations.length > 0 ? run.result.envelope.validations.join("; ") : "(none)"}`);
    lines.push(`risks: ${run.result.envelope.risks.length > 0 ? run.result.envelope.risks.join("; ") : "(none)"}`);
    lines.push(`next_step: ${run.result.envelope.next_step ?? "(none)"}`);
    lines.push(`continuation: ${run.result.envelope.continuation ?? "(none)"}`);
  }

  if (run.result?.stderrPath ?? run.stderr) {
    lines.push(`stderr: ${run.result?.stderrPath ?? run.record.files.stderr}`);
  }
  if (run.result?.parseError) {
    lines.push(`parseError: ${run.result.parseError}`);
  }

  return lines.join("\n");
}

function updateSubagentStatus(ctx: ToolExecuteContext | undefined, delegationId: string, status: SubagentState): void {
  subagentStates.set(delegationId, status);

  let running = 0;
  let completed = 0;
  let error = 0;

  for (const value of subagentStates.values()) {
    if (value === "running") {
      running += 1;
    } else if (value === "completed") {
      completed += 1;
    } else {
      error += 1;
    }
  }

  ctx?.ui?.setStatus?.("subagents", `subagents ${running}⏳ ${completed}✓ ${error}✗`);
}

function sendBackgroundCompletionMessage(pi: ExtensionAPI, event: BackgroundDelegationEvent): void {
  const sender = pi as unknown as SendMessageCapablePi;
  if (typeof sender.sendMessage !== "function") return;

  sender.sendMessage({
    customType: "delegation-notification",
    display: true,
    content: formatBackgroundCompletionContent(event),
    details: {
      id: event.delegationId,
      status: event.status,
      agent: event.agent,
      runDir: event.runDir,
      envelope: event.envelope ?? null,
      parseError: event.parseError ?? null,
    },
  }, { triggerTurn: true, deliverAs: "followUp" });
}

function formatBackgroundCompletionContent(event: BackgroundDelegationEvent): string {
  const envelopeBlock = event.envelope
    ? formatEnvelopeBlock(event.envelope)
    : `Preview: ${event.parseError ?? "(no output preview)"}\nStructured envelope: missing or invalid`;

  return [
    `Delegation ${event.status}: ${event.delegationId}`,
    `Agent: ${event.agent}`,
    envelopeBlock,
    `Use delegation_read({"id":"${event.delegationId}"}) to view the full result.`,
    "",
    "Assistant action: acknowledge this completion and provide a brief summary only. Prefer the structured envelope above over raw output. Do not launch follow-up work unless the user explicitly requested automatic continuation or the active workflow state says execution mode auto.",
  ].join("\n");
}

function formatEnvelopeBlock(envelope: NonNullable<BackgroundDelegationEvent["envelope"]>): string {
  const lines = [
    `Envelope status: ${envelope.status}`,
    `Summary: ${envelope.summary}`,
    `Artifacts: ${envelope.artifacts.length > 0 ? envelope.artifacts.join("; ") : "(none)"}`,
    `Files: ${envelope.files.length > 0 ? envelope.files.join("; ") : "(none)"}`,
    `Validations: ${envelope.validations.length > 0 ? envelope.validations.join("; ") : "(none)"}`,
    `Risks: ${envelope.risks.length > 0 ? envelope.risks.join("; ") : "(none)"}`,
    `Next step: ${envelope.next_step || "(none)"}`,
    `Continuation: ${envelope.continuation || "(none)"}`,
    `Skill resolution: ${envelope.skill_resolution}`,
  ];

  if ("phase" in envelope) {
    lines.splice(1, 0, `Phase: ${envelope.phase}`);
  }

  if (envelope.status === "needs_user_input") {
    lines.push(`Question: ${envelope.question ?? "(none)"}`);
    lines.push(`Options: ${envelope.options.length > 0 ? envelope.options.join("; ") : "(none)"}`);
  }

  return lines.join("\n");
}

function previewText(value: string | null, max = 400): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
