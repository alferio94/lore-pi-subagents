import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_AGENT_DIRNAME, USER_AGENT_DIR } from "./constants.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type {
  AgentDefinition,
  AgentRegistry,
  AgentSource,
  DiscoverAgentsOptions,
  FrontmatterValue,
  SystemPromptMode,
} from "./types.ts";

export function defaultBuiltinAgentDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../agents");
}

export function findNearestProjectRoot(startCwd: string): string | undefined {
  let current = path.resolve(startCwd);
  while (true) {
    if (fs.existsSync(path.join(current, PROJECT_AGENT_DIRNAME))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function discoverAgentRegistry(options: DiscoverAgentsOptions = {}): AgentRegistry {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const builtinDir = path.resolve(options.builtinDir ?? defaultBuiltinAgentDir());
  const userDir = path.resolve(options.userDir ?? USER_AGENT_DIR);
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : findNearestProjectRoot(cwd);
  const projectDir = projectRoot ? path.join(projectRoot, PROJECT_AGENT_DIRNAME) : undefined;

  const agents = mergeAgentDefinitions([
    ...loadAgentDefinitions(builtinDir, "builtin"),
    ...loadAgentDefinitions(userDir, "user"),
    ...loadAgentDefinitions(projectDir, "project"),
  ]);

  return {
    agents,
    byName: new Map(agents.map((agent) => [agent.name, agent])),
    builtinDir,
    userDir,
    projectDir,
    projectRoot,
  };
}

export function loadAgentDefinitions(dir: string | undefined, source: AgentSource): AgentDefinition[] {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => parseAgentDefinition(path.join(dir, entry.name), source));
}

export function parseAgentDefinition(filePath: string, source: AgentSource): AgentDefinition {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(raw);

  const name = asRequiredString(data.name, "name", filePath);
  const description = asRequiredString(data.description, "description", filePath);
  const systemPromptMode = asSystemPromptMode(data.systemPromptMode);
  const inheritProjectContext = asBoolean(data.inheritProjectContext, false);
  const tools = asStringArray(data.tools);
  const model = asOptionalString(data.model);
  const thinking = asOptionalString(data.thinking);

  const unsupportedFields = Object.keys(data).filter((key) => !KNOWN_AGENT_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Agent '${filePath}' has unsupported frontmatter field(s): ${unsupportedFields.sort().join(", ")}.`,
    );
  }

  return {
    name,
    description,
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    systemPromptMode,
    inheritProjectContext,
    body,
    source,
    filePath,
    metadata: {},
  };
}

export function mergeAgentDefinitions(agents: AgentDefinition[]): AgentDefinition[] {
  const order: AgentSource[] = ["builtin", "user", "project"];
  const sorted = [...agents].sort((left, right) => {
    const sourceDelta = order.indexOf(left.source) - order.indexOf(right.source);
    if (sourceDelta !== 0) return sourceDelta;
    return left.filePath.localeCompare(right.filePath);
  });

  const merged = new Map<string, AgentDefinition>();
  for (const agent of sorted) {
    merged.set(agent.name, agent);
  }

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const KNOWN_AGENT_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "thinking",
  "systemPromptMode",
  "inheritProjectContext",
]);

function asRequiredString(value: FrontmatterValue | undefined, key: string, filePath: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`Agent '${filePath}' is missing required string frontmatter field '${key}'.`);
}

function asOptionalString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  throw new Error("Expected a string array frontmatter value.");
}

function asBoolean(value: FrontmatterValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asSystemPromptMode(value: FrontmatterValue | undefined): SystemPromptMode {
  if (value === "append" || value === "replace") {
    return value;
  }
  return "replace";
}

