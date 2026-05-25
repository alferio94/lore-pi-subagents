import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinAgentContract, listBuiltinAgents } from "./contract.ts";
import { PROJECT_AGENT_DIRNAME, USER_AGENT_DIR } from "./constants.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type {
  AgentContractFrontmatter,
  AgentDefinition,
  AgentRegistry,
  AgentSource,
  DiscoverAgentsOptions,
  FrontmatterValue,
  SystemPromptMode,
} from "./types.ts";
import type { BuiltinAgentContract, ContractEnvelope, ContractPhase, ContractRole, SkillPolicy } from "./contract-schema.ts";

interface ParseAgentDefinitionOptions {
  builtinDir?: string;
  builtinContract?: BuiltinAgentContract;
}

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

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(dir, entry.name));

  if (source !== "builtin") {
    return files.map((filePath) => parseAgentDefinition(filePath, source));
  }

  const builtinDir = path.resolve(dir);
  const contractAgents = listBuiltinAgents();
  const contractByPromptFile = new Map(contractAgents.map((agent) => [normalizeRelativePromptFile(agent.promptFile), agent]));
  const loadedPromptFiles = new Set<string>();

  const agents = files.map((filePath) => {
    const relativePromptFile = normalizeRelativePromptFile(path.relative(path.dirname(builtinDir), filePath));
    const builtinContract = contractByPromptFile.get(relativePromptFile);
    if (!builtinContract) {
      throw new Error(`Builtin agent file '${relativePromptFile}' is not declared in pi-runtime.contract.json.`);
    }
    loadedPromptFiles.add(relativePromptFile);
    return parseAgentDefinition(filePath, source, { builtinDir, builtinContract });
  });

  const missingPromptFiles = contractAgents
    .map((agent) => normalizeRelativePromptFile(agent.promptFile))
    .filter((promptFile) => !loadedPromptFiles.has(promptFile));
  if (missingPromptFiles.length > 0) {
    throw new Error(`pi-runtime.contract.json declares builtin prompt file(s) that are missing on disk: ${missingPromptFiles.join(", ")}.`);
  }

  return agents;
}

export function parseAgentDefinition(
  filePath: string,
  source: AgentSource,
  options: ParseAgentDefinitionOptions = {},
): AgentDefinition {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(raw);

  const name = asRequiredString(data.name, "name", filePath);
  const description = asRequiredString(data.description, "description", filePath);
  const systemPromptMode = asSystemPromptMode(data.systemPromptMode);
  const inheritProjectContext = asBoolean(data.inheritProjectContext, false);
  const tools = asStringArray(data.tools);
  const model = asOptionalString(data.model);
  const thinking = asOptionalString(data.thinking);
  const contractFrontmatter = readContractFrontmatter(data, filePath);

  const unsupportedFields = Object.keys(data).filter((key) => !KNOWN_AGENT_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Agent '${filePath}' has unsupported frontmatter field(s): ${unsupportedFields.sort().join(", ")}.`,
    );
  }

  const builtinContract = source === "builtin"
    ? options.builtinContract ?? getBuiltinAgentContract(name)
    : undefined;

  if (source === "builtin") {
    if (!builtinContract) {
      throw new Error(`Builtin agent '${name}' is missing a contract entry in pi-runtime.contract.json.`);
    }
    validateBuiltinAgentParity(filePath, name, options.builtinDir, builtinContract, contractFrontmatter);
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
    ...(contractFrontmatter ? { contractFrontmatter } : {}),
    ...(builtinContract ? {
      role: builtinContract.role,
      ...(builtinContract.phase ? { phase: builtinContract.phase } : {}),
      requiredEnvelope: builtinContract.requiredEnvelope,
      skillPolicy: builtinContract.skillPolicy,
    } : {}),
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
  "role",
  "phase",
  "requiredEnvelope",
  "skillPolicyMode",
  "skillPolicyFiles",
]);

function validateBuiltinAgentParity(
  filePath: string,
  name: string,
  builtinDir: string | undefined,
  builtinContract: BuiltinAgentContract,
  contractFrontmatter: AgentContractFrontmatter | undefined,
): void {
  if (name !== builtinContract.name) {
    throw new Error(`Builtin agent '${filePath}' must match contract name '${builtinContract.name}'.`);
  }

  if (builtinDir) {
    const relativePromptFile = normalizeRelativePromptFile(path.relative(path.dirname(path.resolve(builtinDir)), filePath));
    if (relativePromptFile !== normalizeRelativePromptFile(builtinContract.promptFile)) {
      throw new Error(
        `Builtin agent '${name}' prompt file drift: contract expects '${builtinContract.promptFile}' but loaded '${relativePromptFile}'.`,
      );
    }
  }

  if (!contractFrontmatter) {
    return;
  }

  if (contractFrontmatter.role && contractFrontmatter.role !== builtinContract.role) {
    throw new Error(`Builtin agent '${name}' role drift: expected '${builtinContract.role}', received '${contractFrontmatter.role}'.`);
  }
  if (contractFrontmatter.phase !== undefined && contractFrontmatter.phase !== builtinContract.phase) {
    throw new Error(
      `Builtin agent '${name}' phase drift: expected '${builtinContract.phase ?? "none"}', received '${contractFrontmatter.phase}'.`,
    );
  }
  if (
    contractFrontmatter.requiredEnvelope
    && contractFrontmatter.requiredEnvelope !== builtinContract.requiredEnvelope
  ) {
    throw new Error(
      `Builtin agent '${name}' envelope drift: expected '${builtinContract.requiredEnvelope}', received '${contractFrontmatter.requiredEnvelope}'.`,
    );
  }

  const frontmatterSkillPolicy = readSkillPolicyFromFrontmatter(contractFrontmatter, filePath);
  if (!frontmatterSkillPolicy) {
    return;
  }

  if (frontmatterSkillPolicy.mode !== builtinContract.skillPolicy.mode) {
    throw new Error(
      `Builtin agent '${name}' skill policy drift: expected mode '${builtinContract.skillPolicy.mode}', received '${frontmatterSkillPolicy.mode}'.`,
    );
  }

  const expectedFiles = builtinContract.skillPolicy.files ?? [];
  const actualFiles = frontmatterSkillPolicy.files ?? [];
  if (expectedFiles.length !== actualFiles.length || expectedFiles.some((file, index) => file !== actualFiles[index])) {
    throw new Error(
      `Builtin agent '${name}' skill policy file drift: expected '${expectedFiles.join(", ")}', received '${actualFiles.join(", ")}'.`,
    );
  }
}

function readContractFrontmatter(
  data: Record<string, FrontmatterValue>,
  filePath: string,
): AgentContractFrontmatter | undefined {
  const role = asOptionalRole(data.role, filePath);
  const phase = asOptionalPhase(data.phase, filePath);
  const requiredEnvelope = asOptionalEnvelope(data.requiredEnvelope, filePath);
  const skillPolicyMode = asOptionalSkillPolicyMode(data.skillPolicyMode, filePath);
  const skillPolicyFiles = data.skillPolicyFiles === undefined ? undefined : asStringArray(data.skillPolicyFiles);

  if (
    role === undefined
    && phase === undefined
    && requiredEnvelope === undefined
    && skillPolicyMode === undefined
    && skillPolicyFiles === undefined
  ) {
    return undefined;
  }

  return {
    ...(role ? { role } : {}),
    ...(phase ? { phase } : {}),
    ...(requiredEnvelope ? { requiredEnvelope } : {}),
    ...(skillPolicyMode ? { skillPolicyMode } : {}),
    ...(skillPolicyFiles ? { skillPolicyFiles } : {}),
  };
}

function readSkillPolicyFromFrontmatter(
  contractFrontmatter: AgentContractFrontmatter,
  filePath: string,
): SkillPolicy | undefined {
  if (!contractFrontmatter.skillPolicyMode && !contractFrontmatter.skillPolicyFiles) {
    return undefined;
  }

  if (!contractFrontmatter.skillPolicyMode) {
    throw new Error(`Agent '${filePath}' must declare skillPolicyMode when skillPolicyFiles are present.`);
  }

  if (contractFrontmatter.skillPolicyMode === "explicit") {
    if (!contractFrontmatter.skillPolicyFiles || contractFrontmatter.skillPolicyFiles.length === 0) {
      throw new Error(`Agent '${filePath}' must declare skillPolicyFiles when skillPolicyMode is 'explicit'.`);
    }
    return {
      mode: "explicit",
      files: contractFrontmatter.skillPolicyFiles,
    };
  }

  if (contractFrontmatter.skillPolicyFiles) {
    throw new Error(`Agent '${filePath}' may only declare skillPolicyFiles when skillPolicyMode is 'explicit'.`);
  }

  return { mode: contractFrontmatter.skillPolicyMode };
}

function normalizeRelativePromptFile(value: string): string {
  return value.replaceAll(path.sep, "/");
}

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

function asOptionalRole(value: FrontmatterValue | undefined, filePath: string): ContractRole | undefined {
  if (value === undefined) return undefined;
  if (value === "worker" || value === "sdd") return value;
  throw new Error(`Agent '${filePath}' must declare role as 'worker' or 'sdd'.`);
}

function asOptionalPhase(value: FrontmatterValue | undefined, filePath: string): ContractPhase | undefined {
  if (value === undefined) return undefined;
  if (value === "init" || value === "explore" || value === "propose" || value === "spec" || value === "design" || value === "tasks" || value === "apply" || value === "verify" || value === "archive") {
    return value;
  }
  throw new Error(`Agent '${filePath}' declares unsupported phase '${String(value)}'.`);
}

function asOptionalEnvelope(value: FrontmatterValue | undefined, filePath: string): ContractEnvelope | undefined {
  if (value === undefined) return undefined;
  if (value === "worker" || value === "sdd") return value;
  throw new Error(`Agent '${filePath}' must declare requiredEnvelope as 'worker' or 'sdd'.`);
}

function asOptionalSkillPolicyMode(value: FrontmatterValue | undefined, filePath: string): SkillPolicy["mode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "registry" || value === "explicit" || value === "none") return value;
  throw new Error(`Agent '${filePath}' declares unsupported skillPolicyMode '${String(value)}'.`);
}
