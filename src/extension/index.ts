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
import { startDelegation, listDelegations, readDelegation } from "../runtime/delegations.ts";
import { readModelRoutingConfig, writeModelRoutingConfig } from "../runtime/model-routing.ts";
import { openLoreModelsUI } from "../ui/lore-models.ts";

export const EXTENSION_NAME = "lore-pi-runtime";
export const DELEGATE_TOOL_NAME = "delegate";
export const DELEGATION_READ_TOOL_NAME = "delegation_read";
export const DELEGATION_LIST_TOOL_NAME = "delegation_list";
export const CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";
export const LORE_MODELS_COMMAND = "lore-models";

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
      async execute(_toolCallId, params) {
        try {
          const registry = discoverAgentRegistry({ cwd: typeof params.cwd === "string" ? params.cwd : process.cwd() });
          const started = await startDelegation({
            registry,
            requestedAgent: typeof params.agent === "string" ? params.agent : undefined,
            task: String(params.task),
            cwd: typeof params.cwd === "string" ? params.cwd : undefined,
            runInBackground: params.async === true,
          });

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
              next: params.async === true ? DELEGATION_READ_TOOL_NAME : started.recovery.result?.envelope?.next ?? null,
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
            content: [{ type: "text", text: `${run.record.id}: ${run.status?.summary ?? run.status?.status ?? run.record.status}` }],
            details: {
              id: run.record.id,
              status: run.status?.status ?? run.record.status,
              requestedAgent: run.record.requestedAgent,
              canonicalAgent: run.record.canonicalAgent,
              runDir: run.record.runDir,
              envelope: run.result?.envelope ?? null,
              parseError: run.result?.parseError ?? null,
              rawOutput: run.rawOutput,
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
              rawOutput: null,
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
            content: [{ type: "text", text: runs.length === 0 ? "No delegations found." : `${runs.length} delegation(s) found.` }],
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
        await openLoreModelsUI(ctx as never, {
          agentNames: registry.agents.map((agent) => agent.name),
          readConfig: readModelRoutingConfig,
          writeConfig: writeModelRoutingConfig,
        });
      },
    });
    return;
  }

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

function isChildRuntime(): boolean {
  return process.env[CHILD_MARKER_ENV] === "1";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
