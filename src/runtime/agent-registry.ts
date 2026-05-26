import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentResolution, getBuiltinAgentContract, getSourceLocator, listBuiltinAgents } from "./contract.ts";
import {
  MANAGED_AGENT_SETTING_DISABLED,
  MANAGED_AGENT_SETTING_ENABLED,
  PI_AGENT_SETTINGS_PATH,
  PROJECT_AGENT_DIRNAME,
  USER_AGENT_DIR,
} from "./constants.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type {
  AgentContractFrontmatter,
  AgentDefinition,
  AgentRegistry,
  AgentRegistryDiagnostic,
  AgentSource,
  DiscoverAgentsOptions,
  FrontmatterValue,
  ProjectAgentsMode,
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
  const { mode: projectAgentsMode, diagnostics } = resolveProjectAgentsMode(options);
  const ignoredProjectAgents = projectAgentsMode === "disabled" ? loadAgentDefinitions(projectDir, "project") : [];

  const agents = mergeAgentDefinitions([
    ...loadAgentDefinitions(builtinDir, "builtin"),
    ...loadAgentDefinitions(userDir, "user"),
    ...(projectAgentsMode === "enabled" ? loadAgentDefinitions(projectDir, "project") : []),
  ]);

  return {
    agents,
    byName: new Map(agents.map((agent) => [agent.name, agent])),
    builtinDir,
    userDir,
    projectDir,
    projectRoot,
    projectAgentsMode,
    ignoredProjectAgents,
    diagnostics,
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
  const metadata = readManagedMetadata(data);
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

  const resolvedSource = source === "user" && isManagedOverlayMetadata(metadata) ? "managed" : source;

  return {
    name,
    description,
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    systemPromptMode,
    inheritProjectContext,
    body,
    source: resolvedSource,
    filePath,
    metadata,
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
  const order: AgentSource[] = ["builtin", "managed", "user", "project"];
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
  "managedBy",
  "managedLayer",
  "managedPackId",
]);

function isManagedOverlayMetadata(metadata: Record<string, FrontmatterValue>): boolean {
  const agentResolution = getAgentResolution();
  return metadata.managedBy === agentResolution.managedFrontmatter.managedBy
    && metadata.managedLayer === agentResolution.managedFrontmatter.managedLayer;
}

function readManagedMetadata(data: Record<string, FrontmatterValue>): Record<string, FrontmatterValue> {
  const metadata: Record<string, FrontmatterValue> = {};
  for (const key of ["managedBy", "managedLayer", "managedPackId"] as const) {
    if (data[key] !== undefined) {
      metadata[key] = data[key];
    }
  }
  return metadata;
}

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

function resolveProjectAgentsMode(options: DiscoverAgentsOptions): { mode: ProjectAgentsMode; diagnostics: AgentRegistryDiagnostic[] } {
  if (options.projectAgentsMode) {
    return { mode: options.projectAgentsMode, diagnostics: [] };
  }

  const settingsResult = readSettingsJson(options.settingsPath ? path.resolve(options.settingsPath) : PI_AGENT_SETTINGS_PATH);
  const explicitMode = readProjectAgentsModeSetting(settingsResult.settings);
  if (explicitMode) {
    return { mode: explicitMode, diagnostics: settingsResult.diagnostics };
  }

  if (hasLoreManagedPackage(settingsResult.settings)) {
    return { mode: MANAGED_AGENT_SETTING_DISABLED, diagnostics: settingsResult.diagnostics };
  }

  return { mode: getAgentResolution().projectAgentsDefault, diagnostics: settingsResult.diagnostics };
}

function readSettingsJson(settingsPath: string): { settings: unknown; diagnostics: AgentRegistryDiagnostic[] } {
  if (!fs.existsSync(settingsPath)) {
    return { settings: undefined, diagnostics: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return {
      settings: undefined,
      diagnostics: [buildSettingsDiagnostic("settings-json-unreadable", settingsPath)],
    };
  }

  try {
    return {
      settings: JSON.parse(raw) as unknown,
      diagnostics: [],
    };
  } catch {
    return {
      settings: undefined,
      diagnostics: [buildSettingsDiagnostic("settings-json-invalid", settingsPath)],
    };
  }
}

function buildSettingsDiagnostic(
  code: AgentRegistryDiagnostic["code"],
  settingsPath: string,
): AgentRegistryDiagnostic {
  const verb = code === "settings-json-invalid" ? "parse" : "read";
  return {
    level: "warning",
    code,
    path: settingsPath,
    message: `Could not ${verb} '${settingsPath}'; falling back to runtime contract defaults.`,
  };
}

function readProjectAgentsModeSetting(settings: unknown): ProjectAgentsMode | undefined {
  const node = getNestedValue(settings, getAgentResolution().projectAgentsSettingPath.split("."));
  if (node === MANAGED_AGENT_SETTING_ENABLED || node === MANAGED_AGENT_SETTING_DISABLED) {
    return node;
  }
  return undefined;
}

function hasLoreManagedPackage(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") {
    return false;
  }

  const packages = (settings as { packages?: unknown }).packages;
  return Array.isArray(packages) && packages.includes(getSourceLocator().value);
}

function getNestedValue(input: unknown, keys: string[]): unknown {
  let current = input;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
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
  if (value === "proposal") {
    return "propose";
  }
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
