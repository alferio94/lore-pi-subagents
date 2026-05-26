export type ContractRole = "worker" | "sdd";
export type ContractEnvelope = "worker" | "sdd";
export type ContractPhase = "init" | "explore" | "propose" | "spec" | "design" | "tasks" | "apply" | "verify" | "archive";
export type SourceLocatorKind = "pi-settings-package";
export type ConflictPolicy = "non-destructive-warn" | "replace-on-refresh";
export type SkillPolicyMode = "registry" | "explicit" | "none";
export type AgentResolutionSource = "builtin" | "managed" | "user" | "project";
export type ProjectAgentsMode = "enabled" | "disabled";

export interface RuntimeContract {
  version: number;
  sourceLocator: {
    kind: SourceLocatorKind;
    value: string;
  };
  packageIdentity: {
    name: string;
    extensionName: string;
  };
  entrypoint: {
    path: string;
    source: string;
  };
  installPolicy: {
    mergeSettingsPackagesFirst: boolean;
    retainedExtensions: string[];
    blockedLegacyExtensions: string[];
    managedExtensionsBookkeepingOnly: boolean;
    conflictPolicy: ConflictPolicy;
  };
  builtinCatalog: {
    aliases: ContractAlias[];
    agents: BuiltinAgentContract[];
  };
  // Managed overlays are installer-owned global agent markdown files. Runtime keeps
  // builtin prompts canonical, lets managed overlays override builtins, lets user
  // globals override managed, and gates project-local `.pi/agents` behind the
  // documented settings toggle instead of installer-side file writes.
  agentResolution: {
    managedFilenamePrefix: string;
    managedFrontmatter: {
      managedBy: string;
      managedLayer: string;
    };
    precedence: AgentResolutionSource[];
    projectAgentsDefault: ProjectAgentsMode;
    projectAgentsSettingPath: string;
  };
  runtimeInvariants: {
    projectOverridesBuiltinPrompts: boolean;
    strictEnvelopes: {
      requireSkillResolution: boolean;
    };
    continuation: {
      needsUserInputMirrorsQuestionOptions: boolean;
      backgroundFollowUp: {
        triggerTurn: boolean;
        deliverAs: string;
      };
    };
    toolBoundaries: {
      parentOnly: string[];
      childOnly: string[];
    };
  };
}

export interface ContractAlias {
  alias: string;
  target: string;
}

export interface BuiltinAgentContract {
  name: string;
  role: ContractRole;
  phase?: ContractPhase;
  requiredEnvelope: ContractEnvelope;
  promptFile: string;
  skillPolicy: SkillPolicy;
}

export interface SkillPolicy {
  mode: SkillPolicyMode;
  files?: string[];
}

export function validateRuntimeContract(value: unknown): RuntimeContract {
  const contract = asObject(value, "contract");
  const version = asNumber(contract.version, "version");
  const sourceLocator = validateSourceLocator(contract.sourceLocator, "sourceLocator");
  const packageIdentity = validatePackageIdentity(contract.packageIdentity, "packageIdentity");
  const entrypoint = validateEntrypoint(contract.entrypoint, "entrypoint");
  const installPolicy = validateInstallPolicy(contract.installPolicy, "installPolicy");
  const builtinCatalog = validateBuiltinCatalog(contract.builtinCatalog, "builtinCatalog");
  const agentResolution = validateAgentResolution(contract.agentResolution, "agentResolution");
  const runtimeInvariants = validateRuntimeInvariants(contract.runtimeInvariants, "runtimeInvariants");

  if (version < 1) {
    throw new Error(`contract.version must be >= 1; received ${version}.`);
  }

  return {
    version,
    sourceLocator,
    packageIdentity,
    entrypoint,
    installPolicy,
    builtinCatalog,
    agentResolution,
    runtimeInvariants,
  };
}

function validateSourceLocator(value: unknown, path: string): RuntimeContract["sourceLocator"] {
  const node = asObject(value, path);
  const kind = asEnum(node.kind, pathDot(path, "kind"), ["pi-settings-package"] as const);
  const locator = asNonEmptyString(node.value, pathDot(path, "value"));
  return { kind, value: locator };
}

function validatePackageIdentity(value: unknown, path: string): RuntimeContract["packageIdentity"] {
  const node = asObject(value, path);
  return {
    name: asNonEmptyString(node.name, pathDot(path, "name")),
    extensionName: asNonEmptyString(node.extensionName, pathDot(path, "extensionName")),
  };
}

function validateEntrypoint(value: unknown, path: string): RuntimeContract["entrypoint"] {
  const node = asObject(value, path);
  return {
    path: asNonEmptyString(node.path, pathDot(path, "path")),
    source: asNonEmptyString(node.source, pathDot(path, "source")),
  };
}

function validateInstallPolicy(value: unknown, path: string): RuntimeContract["installPolicy"] {
  const node = asObject(value, path);
  const retainedExtensions = asUniqueStringArray(node.retainedExtensions, pathDot(path, "retainedExtensions"));
  const blockedLegacyExtensions = asUniqueStringArray(node.blockedLegacyExtensions, pathDot(path, "blockedLegacyExtensions"));
  const overlap = retainedExtensions.filter((extension) => blockedLegacyExtensions.includes(extension));
  if (overlap.length > 0) {
    throw new Error(`${path} contains conflicting retained/blocked extensions: ${overlap.join(", ")}.`);
  }

  return {
    mergeSettingsPackagesFirst: asBoolean(node.mergeSettingsPackagesFirst, pathDot(path, "mergeSettingsPackagesFirst")),
    retainedExtensions,
    blockedLegacyExtensions,
    managedExtensionsBookkeepingOnly: asBoolean(
      node.managedExtensionsBookkeepingOnly,
      pathDot(path, "managedExtensionsBookkeepingOnly"),
    ),
    conflictPolicy: asEnum(node.conflictPolicy, pathDot(path, "conflictPolicy"), [
      "non-destructive-warn",
      "replace-on-refresh",
    ] as const),
  };
}

function validateBuiltinCatalog(value: unknown, path: string): RuntimeContract["builtinCatalog"] {
  const node = asObject(value, path);
  const aliases = asArray(node.aliases, pathDot(path, "aliases")).map((item, index) =>
    validateAlias(item, `${path}.aliases[${index}]`),
  );
  const agents = asArray(node.agents, pathDot(path, "agents")).map((item, index) =>
    validateBuiltinAgent(item, `${path}.agents[${index}]`),
  );

  const agentNames = new Set<string>();
  for (const agent of agents) {
    if (agentNames.has(agent.name)) {
      throw new Error(`Duplicate builtin agent name '${agent.name}'.`);
    }
    agentNames.add(agent.name);
  }

  const aliasNames = new Set<string>();
  for (const alias of aliases) {
    if (agentNames.has(alias.alias) || aliasNames.has(alias.alias)) {
      throw new Error(`Alias '${alias.alias}' must be globally unique across aliases and canonical agent names.`);
    }
    if (!agentNames.has(alias.target)) {
      throw new Error(`Alias '${alias.alias}' points to unknown builtin agent '${alias.target}'.`);
    }
    aliasNames.add(alias.alias);
  }

  return { aliases, agents };
}

function validateAlias(value: unknown, path: string): ContractAlias {
  const node = asObject(value, path);
  return {
    alias: asNonEmptyString(node.alias, pathDot(path, "alias")),
    target: asNonEmptyString(node.target, pathDot(path, "target")),
  };
}

function validateBuiltinAgent(value: unknown, path: string): BuiltinAgentContract {
  const node = asObject(value, path);
  const role = asEnum(node.role, pathDot(path, "role"), ["worker", "sdd"] as const);
  const requiredEnvelope = asEnum(node.requiredEnvelope, pathDot(path, "requiredEnvelope"), ["worker", "sdd"] as const);
  const phase = node.phase === undefined ? undefined : asEnum(node.phase, pathDot(path, "phase"), [
    "init",
    "explore",
    "propose",
    "spec",
    "design",
    "tasks",
    "apply",
    "verify",
    "archive",
  ] as const);
  const skillPolicy = validateSkillPolicy(node.skillPolicy, pathDot(path, "skillPolicy"));

  if (role === "worker") {
    if (phase !== undefined) {
      throw new Error(`${path} is a worker agent and must not declare a phase.`);
    }
    if (requiredEnvelope !== "worker") {
      throw new Error(`${path} is a worker agent and must require the worker envelope.`);
    }
  }

  if (role === "sdd") {
    if (phase === undefined) {
      throw new Error(`${path} is an SDD agent and must declare a phase.`);
    }
    if (requiredEnvelope !== "sdd") {
      throw new Error(`${path} is an SDD agent and must require the SDD envelope.`);
    }
  }

  return {
    name: asNonEmptyString(node.name, pathDot(path, "name")),
    role,
    ...(phase ? { phase } : {}),
    requiredEnvelope,
    promptFile: asNonEmptyString(node.promptFile, pathDot(path, "promptFile")),
    skillPolicy,
  };
}

function validateSkillPolicy(value: unknown, path: string): SkillPolicy {
  const node = asObject(value, path);
  const mode = asEnum(node.mode, pathDot(path, "mode"), ["registry", "explicit", "none"] as const);
  const files = node.files === undefined ? undefined : asUniqueStringArray(node.files, pathDot(path, "files"));

  if (mode === "explicit" && (!files || files.length === 0)) {
    throw new Error(`${path} with mode 'explicit' must declare one or more files.`);
  }

  if (mode !== "explicit" && files !== undefined) {
    throw new Error(`${path} may only declare files when mode is 'explicit'.`);
  }

  return files ? { mode, files } : { mode };
}

function validateAgentResolution(value: unknown, path: string): RuntimeContract["agentResolution"] {
  const node = asObject(value, path);
  const managedFrontmatterNode = asObject(node.managedFrontmatter, pathDot(path, "managedFrontmatter"));
  const precedence = asArray(node.precedence, pathDot(path, "precedence")).map((item, index) =>
    asEnum(item, `${path}.precedence[${index}]`, ["builtin", "managed", "user", "project"] as const),
  );
  const expectedPrecedence: AgentResolutionSource[] = ["builtin", "managed", "user", "project"];
  if (precedence.length !== expectedPrecedence.length || precedence.some((value, index) => value !== expectedPrecedence[index])) {
    throw new Error(`${path}.precedence must be exactly: ${expectedPrecedence.join(", ")}.`);
  }
  return {
    managedFilenamePrefix: asNonEmptyString(node.managedFilenamePrefix, pathDot(path, "managedFilenamePrefix")),
    managedFrontmatter: {
      managedBy: asNonEmptyString(managedFrontmatterNode.managedBy, pathDot(pathDot(path, "managedFrontmatter"), "managedBy")),
      managedLayer: asNonEmptyString(managedFrontmatterNode.managedLayer, pathDot(pathDot(path, "managedFrontmatter"), "managedLayer")),
    },
    precedence,
    projectAgentsDefault: asEnum(node.projectAgentsDefault, pathDot(path, "projectAgentsDefault"), ["enabled", "disabled"] as const),
    projectAgentsSettingPath: asNonEmptyString(node.projectAgentsSettingPath, pathDot(path, "projectAgentsSettingPath")),
  };
}

function validateRuntimeInvariants(value: unknown, path: string): RuntimeContract["runtimeInvariants"] {
  const node = asObject(value, path);
  const strictEnvelopesNode = asObject(node.strictEnvelopes, pathDot(path, "strictEnvelopes"));
  const continuationNode = asObject(node.continuation, pathDot(path, "continuation"));
  const backgroundFollowUpNode = asObject(continuationNode.backgroundFollowUp, pathDot(pathDot(path, "continuation"), "backgroundFollowUp"));
  const toolBoundariesNode = asObject(node.toolBoundaries, pathDot(path, "toolBoundaries"));
  const parentOnly = asUniqueStringArray(toolBoundariesNode.parentOnly, pathDot(pathDot(path, "toolBoundaries"), "parentOnly"));
  const childOnly = asUniqueStringArray(toolBoundariesNode.childOnly, pathDot(pathDot(path, "toolBoundaries"), "childOnly"));
  const overlap = parentOnly.filter((tool) => childOnly.includes(tool));
  if (overlap.length > 0) {
    throw new Error(`${path}.toolBoundaries overlaps parent/child tool names: ${overlap.join(", ")}.`);
  }

  return {
    projectOverridesBuiltinPrompts: asBoolean(node.projectOverridesBuiltinPrompts, pathDot(path, "projectOverridesBuiltinPrompts")),
    strictEnvelopes: {
      requireSkillResolution: asBoolean(
        strictEnvelopesNode.requireSkillResolution,
        pathDot(pathDot(path, "strictEnvelopes"), "requireSkillResolution"),
      ),
    },
    continuation: {
      needsUserInputMirrorsQuestionOptions: asBoolean(
        continuationNode.needsUserInputMirrorsQuestionOptions,
        pathDot(pathDot(path, "continuation"), "needsUserInputMirrorsQuestionOptions"),
      ),
      backgroundFollowUp: {
        triggerTurn: asBoolean(
          backgroundFollowUpNode.triggerTurn,
          pathDot(pathDot(pathDot(path, "continuation"), "backgroundFollowUp"), "triggerTurn"),
        ),
        deliverAs: asNonEmptyString(
          backgroundFollowUpNode.deliverAs,
          pathDot(pathDot(pathDot(path, "continuation"), "backgroundFollowUp"), "deliverAs"),
        ),
      },
    },
    toolBoundaries: {
      parentOnly,
      childOnly,
    },
  };
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function asUniqueStringArray(value: unknown, path: string): string[] {
  const items = asArray(value, path).map((item, index) => asNonEmptyString(item, `${path}[${index}]`));
  const unique = new Set(items);
  if (unique.size !== items.length) {
    throw new Error(`${path} must not contain duplicate values.`);
  }
  return items;
}

function asEnum<const T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number] {
  const text = asNonEmptyString(value, path);
  if (!allowed.includes(text)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}. Received '${text}'.`);
  }
  return text;
}

function pathDot(parent: string, child: string): string {
  return `${parent}.${child}`;
}
