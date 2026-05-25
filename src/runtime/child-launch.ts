import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SystemPromptMode } from "./types.ts";

export const CHILD_MARKER_ENV = "LORE_PI_CHILD";
export const CHILD_DEPTH_ENV = "LORE_PI_DELEGATION_DEPTH";
export const CHILD_RUN_DIR_ENV = "LORE_PI_RUN_DIR";
export const CHILD_DELEGATION_ID_ENV = "LORE_PI_DELEGATION_ID";
export const CHILD_REQUESTED_AGENT_ENV = "LORE_PI_REQUESTED_AGENT";
export const CHILD_CANONICAL_AGENT_ENV = "LORE_PI_CANONICAL_AGENT";
export const DEFAULT_MAX_DELEGATION_DEPTH = 1;

export interface PrepareChildLaunchInput {
  cwd: string;
  prompt: string;
  delegationId: string;
  requestedAgent: string;
  canonicalAgent: string;
  runDir: string;
  tools?: string[];
  extensionSources?: string[];
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  inheritProjectContext?: boolean;
  model?: string;
  thinking?: string;
  env?: NodeJS.ProcessEnv;
  maxDepth?: number;
  piCommand?: string;
}

export interface PreparedChildLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  systemPromptPath?: string;
  cleanup: () => Promise<void>;
}

export interface LaunchedChild {
  child: ChildProcessByStdio<null, Readable, Readable>;
  prepared: PreparedChildLaunch;
  completion: Promise<number>;
}

export async function prepareChildLaunch(input: PrepareChildLaunchInput): Promise<PreparedChildLaunch> {
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const parentEnv = { ...process.env, ...input.env };
  const nextDepth = parseDepth(parentEnv[CHILD_DEPTH_ENV]) + 1;
  if (nextDepth > maxDepth) {
    throw new Error(`Delegation depth ${nextDepth} exceeds max depth ${maxDepth}.`);
  }

  const extensions = normalizeList(input.extensionSources, path.resolve);
  const tools = normalizeList(input.tools);
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    [CHILD_MARKER_ENV]: "1",
    [CHILD_DEPTH_ENV]: String(nextDepth),
    [CHILD_RUN_DIR_ENV]: path.resolve(input.runDir),
    [CHILD_DELEGATION_ID_ENV]: input.delegationId,
    [CHILD_REQUESTED_AGENT_ENV]: input.requestedAgent,
    [CHILD_CANONICAL_AGENT_ENV]: input.canonicalAgent,
  };

  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  if (input.inheritProjectContext === false) {
    args.push("--no-context-files");
  }
  for (const extensionSource of extensions) {
    args.push("--extension", extensionSource);
  }
  if (tools.length > 0) {
    args.push("--tools", tools.join(","));
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.thinking) {
    args.push("--thinking", input.thinking);
  }

  let systemPromptPath: string | undefined;
  if (input.systemPrompt?.trim()) {
    systemPromptPath = await writeTempPromptFile(input.systemPrompt);
    args.push(input.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", systemPromptPath);
  }

  args.push(input.prompt);

  return {
    command: input.piCommand ?? "pi",
    args,
    cwd: path.resolve(input.cwd),
    env,
    systemPromptPath,
    cleanup: async () => {
      if (!systemPromptPath) return;
      await fs.rm(path.dirname(systemPromptPath), { recursive: true, force: true });
    },
  };
}

export async function launchChildProcess(input: PrepareChildLaunchInput): Promise<LaunchedChild> {
  const prepared = await prepareChildLaunch(input);
  const child = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const completion = new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = async (result: () => void) => {
      if (settled) return;
      settled = true;
      try {
        await prepared.cleanup();
      } finally {
        result();
      }
    };

    child.once("error", (error) => {
      void finish(() => reject(error));
    });
    child.once("close", (code) => {
      void finish(() => resolve(code ?? 0));
    });
  });

  return { child, prepared, completion };
}

function normalizeList(items: string[] | undefined, transform?: (value: string) => string): string[] {
  if (!items) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const value = transform ? transform(trimmed) : trimmed;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function parseDepth(rawDepth: string | undefined): number {
  if (!rawDepth) return 0;
  const parsed = Number.parseInt(rawDepth, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function writeTempPromptFile(content: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lore-pi-runtime-prompt-"));
  const filePath = path.join(directory, "system-prompt.md");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}
