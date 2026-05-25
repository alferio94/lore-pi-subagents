import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GLOBAL_LORE_MODELS_PATH } from "./constants.ts";

export const LORE_MODELS_PATH_ENV = "LORE_PI_RUNTIME_MODELS_PATH";

export interface ModelRoute {
  model?: string;
  thinking?: string;
}

export interface LoreModelRoutingConfig {
  version: 1;
  defaults: {
    nonSdd?: ModelRoute;
    sdd?: ModelRoute;
  };
  agents: Record<string, ModelRoute>;
}

export interface ResolveModelRouteInput {
  agentName: string;
  isSdd?: boolean;
  agentModel?: string;
  agentThinking?: string;
  sessionModel?: string;
  sessionThinking?: string;
  config?: LoreModelRoutingConfig;
}

export type RouteSource =
  | "agent-frontmatter"
  | "agent-route"
  | "default-sdd"
  | "default-non-sdd"
  | "session"
  | "none";

export interface ResolvedModelRoute {
  model?: string;
  thinking?: string;
  modelSource: RouteSource;
  thinkingSource: RouteSource;
}

export function createEmptyModelRoutingConfig(): LoreModelRoutingConfig {
  return {
    version: 1,
    defaults: {},
    agents: {},
  };
}

export async function readModelRoutingConfig(): Promise<LoreModelRoutingConfig> {
  const filePath = getGlobalLoreModelsPath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeModelRoutingConfig(JSON.parse(raw) as Partial<LoreModelRoutingConfig>);
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyModelRoutingConfig();
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse Lore model routing at '${filePath}': ${error.message}`);
    }
    throw error;
  }
}

export async function writeModelRoutingConfig(config: LoreModelRoutingConfig): Promise<LoreModelRoutingConfig> {
  const normalized = normalizeModelRoutingConfig(config);
  const filePath = getGlobalLoreModelsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function updateAgentRoute(agentName: string, route: ModelRoute | null): Promise<LoreModelRoutingConfig> {
  const config = await readModelRoutingConfig();
  const normalizedRoute = normalizeModelRoute(route ?? undefined);
  if (normalizedRoute) {
    config.agents[agentName] = normalizedRoute;
  } else {
    delete config.agents[agentName];
  }
  return writeModelRoutingConfig(config);
}

export async function updateDefaultRoute(kind: "nonSdd" | "sdd", route: ModelRoute | null): Promise<LoreModelRoutingConfig> {
  const config = await readModelRoutingConfig();
  const normalizedRoute = normalizeModelRoute(route ?? undefined);
  if (normalizedRoute) {
    config.defaults[kind] = normalizedRoute;
  } else {
    delete config.defaults[kind];
  }
  return writeModelRoutingConfig(config);
}

export async function clearModelRoutingConfig(): Promise<void> {
  try {
    await fs.rm(getGlobalLoreModelsPath(), { force: true });
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

export function normalizeModelRoutingConfig(input: Partial<LoreModelRoutingConfig> | null | undefined): LoreModelRoutingConfig {
  const defaults = {
    nonSdd: normalizeModelRoute(input?.defaults?.nonSdd),
    sdd: normalizeModelRoute(input?.defaults?.sdd),
  };
  const agents = Object.fromEntries(
    Object.entries(input?.agents ?? {})
      .map(([name, route]) => [name.trim(), normalizeModelRoute(route)])
      .filter((entry): entry is [string, ModelRoute] => Boolean(entry[0] && entry[1]))
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    version: 1,
    defaults: Object.fromEntries(
      Object.entries(defaults).filter((entry): entry is ["nonSdd" | "sdd", ModelRoute] => Boolean(entry[1])),
    ),
    agents,
  };
}

export function normalizeModelRoute(route: ModelRoute | null | undefined): ModelRoute | undefined {
  if (!route) return undefined;
  const model = normalizeString(route.model);
  const thinking = normalizeString(route.thinking);
  if (!model && !thinking) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function resolveModelRoute(input: ResolveModelRouteInput): ResolvedModelRoute {
  const config = normalizeModelRoutingConfig(input.config);
  const agentRoute = config.agents[input.agentName];
  const defaultRoute = input.isSdd ?? isSddAgent(input.agentName) ? config.defaults.sdd : config.defaults.nonSdd;

  const modelLayers = [
    { value: normalizeString(input.agentModel), source: "agent-frontmatter" },
    { value: agentRoute?.model, source: "agent-route" },
    { value: defaultRoute?.model, source: defaultRoute === config.defaults.sdd ? "default-sdd" : "default-non-sdd" },
    { value: normalizeString(input.sessionModel), source: "session" },
  ] as const;
  const thinkingLayers = [
    { value: normalizeString(input.agentThinking), source: "agent-frontmatter" },
    { value: agentRoute?.thinking, source: "agent-route" },
    { value: defaultRoute?.thinking, source: defaultRoute === config.defaults.sdd ? "default-sdd" : "default-non-sdd" },
    { value: normalizeString(input.sessionThinking), source: "session" },
  ] as const;

  const modelChoice = modelLayers.find((layer) => layer.value);
  const thinkingChoice = thinkingLayers.find((layer) => layer.value);

  return {
    ...(modelChoice?.value ? { model: modelChoice.value } : {}),
    ...(thinkingChoice?.value ? { thinking: thinkingChoice.value } : {}),
    modelSource: modelChoice?.source ?? "none",
    thinkingSource: thinkingChoice?.source ?? "none",
  };
}

export function formatModelRoute(route: ModelRoute | null | undefined): string {
  const normalized = normalizeModelRoute(route);
  if (!normalized) {
    return "inherit";
  }
  const parts = [];
  if (normalized.model) {
    parts.push(`model=${normalized.model}`);
  }
  if (normalized.thinking) {
    parts.push(`thinking=${normalized.thinking}`);
  }
  return parts.join(", ");
}

export function isSddAgent(agentName: string): boolean {
  return agentName.startsWith("sdd-");
}

function getGlobalLoreModelsPath(): string {
  return path.resolve(process.env[LORE_MODELS_PATH_ENV] ?? GLOBAL_LORE_MODELS_PATH);
}

function normalizeString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
