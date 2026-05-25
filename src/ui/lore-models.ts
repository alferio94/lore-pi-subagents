import {
  formatModelRoute,
  normalizeModelRoute,
  readModelRoutingConfig,
  type LoreModelRoutingConfig,
  type ModelRoute,
} from "../runtime/model-routing.ts";

export interface LoreModelsUIContext {
  ui: {
    select(title: string, items: string[]): Promise<string | null>;
    input(title: string, placeholder?: string): Promise<string | null>;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

export interface LoreModelsUIOptions {
  availableModels?: string[];
  agentNames?: string[];
  readConfig?: () => Promise<LoreModelRoutingConfig>;
  writeConfig: (config: LoreModelRoutingConfig) => Promise<LoreModelRoutingConfig>;
}

const THINKING_LEVELS = ["inherit", "minimal", "low", "medium", "high", "xhigh"] as const;
const BACK_LABEL = "Back";
const DONE_LABEL = "Done";
const AGENTS_LABEL = "Agent routes";
const CLEAR_ROUTE_LABEL = "Clear route";
const START_OVER_LABEL = "Start over";
const CANCEL_SAVE_LABEL = "Back without saving";
const MANUAL_MODEL_LABEL = "Enter custom model id";
const INHERIT_MODEL_LABEL = "Inherit model";

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type RouteTarget =
  | { kind: "default"; routeKind: "nonSdd" | "sdd"; label: string }
  | { kind: "agent"; agentName: string; label: string };

export async function openLoreModelsUI(
  ctx: LoreModelsUIContext,
  options: LoreModelsUIOptions,
): Promise<LoreModelRoutingConfig> {
  const readConfig = options.readConfig ?? readModelRoutingConfig;
  const availableModels = dedupeSorted(options.availableModels ?? []);
  const agentNames = dedupeSorted(options.agentNames ?? []);
  let config = await readConfig();

  while (true) {
    const selectedTarget = await chooseRouteTarget(ctx, config, agentNames);
    if (!selectedTarget) {
      return config;
    }

    const currentRoute = selectedTarget.kind === "default"
      ? config.defaults[selectedTarget.routeKind]
      : config.agents[selectedTarget.agentName];

    const updated = await editRouteWizard(ctx, selectedTarget.label, currentRoute, availableModels);
    if (updated === undefined) {
      continue;
    }

    config = await saveRouteConfig(config, options.writeConfig, selectedTarget.kind === "default"
      ? { kind: "default", routeKind: selectedTarget.routeKind, route: updated }
      : { kind: "agent", agentName: selectedTarget.agentName, route: updated });
  }
}

export function buildLoreModelsMenu(config: LoreModelRoutingConfig, agentNames: string[]): Array<RouteTarget | { kind: "agents"; label: string } | { kind: "close"; label: string }> {
  return [
    {
      kind: "default",
      routeKind: "nonSdd",
      label: `Default non-SDD: ${formatModelRoute(config.defaults.nonSdd)}`,
    },
    {
      kind: "default",
      routeKind: "sdd",
      label: `Default SDD: ${formatModelRoute(config.defaults.sdd)}`,
    },
    ...(agentNames.length > 0 ? [{ kind: "agents" as const, label: `${AGENTS_LABEL} (${agentNames.length})` }] : []),
    { kind: "close" as const, label: DONE_LABEL },
  ];
}

async function chooseRouteTarget(
  ctx: LoreModelsUIContext,
  config: LoreModelRoutingConfig,
  agentNames: string[],
): Promise<RouteTarget | null> {
  while (true) {
    const menu = buildLoreModelsMenu(config, agentNames);
    const selectedLabel = await ctx.ui.select("/lore-models", menu.map((item) => item.label));
    const selectedItem = menu.find((item) => item.label === selectedLabel);

    if (!selectedItem || selectedItem.kind === "close") {
      return null;
    }

    if (selectedItem.kind === "agents") {
      const agentTarget = await chooseAgentTarget(ctx, config, agentNames);
      if (!agentTarget) {
        continue;
      }
      return agentTarget;
    }

    return selectedItem;
  }
}

async function chooseAgentTarget(
  ctx: LoreModelsUIContext,
  config: LoreModelRoutingConfig,
  agentNames: string[],
): Promise<RouteTarget | null> {
  const items = agentNames.map((agentName) => ({
    kind: "agent" as const,
    agentName,
    label: `${agentName}: ${formatModelRoute(config.agents[agentName])}`,
  }));

  const selectedLabel = await ctx.ui.select(AGENTS_LABEL, [...items.map((item) => item.label), BACK_LABEL]);
  if (!selectedLabel || selectedLabel === BACK_LABEL) {
    return null;
  }

  return items.find((item) => item.label === selectedLabel) ?? null;
}

async function editRouteWizard(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute | undefined,
  availableModels: string[],
): Promise<ModelRoute | null | undefined> {
  let draft = normalizeModelRoute(route) ?? {};

  while (true) {
    const modelChoice = await chooseModel(ctx, label, draft, availableModels);
    if (modelChoice.kind === "back") {
      return undefined;
    }
    draft = { ...draft, model: modelChoice.model };

    const thinkingChoice = await chooseThinking(ctx, label, draft);
    if (thinkingChoice.kind === "back") {
      continue;
    }
    draft = { ...draft, thinking: thinkingChoice.thinking };

    const saveChoice = await chooseSaveAction(ctx, label, draft);
    if (saveChoice === "save") {
      return normalizeModelRoute(draft) ?? null;
    }
    if (saveChoice === "clear") {
      return null;
    }
    if (saveChoice === "restart") {
      draft = normalizeModelRoute(route) ?? {};
      continue;
    }
    if (saveChoice === "cancel") {
      return undefined;
    }
  }
}

async function chooseModel(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute,
  availableModels: string[],
): Promise<{ kind: "selected"; model: string | undefined } | { kind: "back" }> {
  while (true) {
    const items = buildModelItems(route, availableModels);
    const selectedLabel = await ctx.ui.select(`Model for ${label}`, [...items.map((item) => item.label), BACK_LABEL]);

    if (!selectedLabel || selectedLabel === BACK_LABEL) {
      return { kind: "back" };
    }

    const selectedItem = items.find((item) => item.label === selectedLabel);
    if (!selectedItem) {
      return { kind: "back" };
    }

    if (selectedItem.kind === "manual") {
      const value = await ctx.ui.input("Model id", route.model ?? "");
      if (value === null) {
        continue;
      }
      return { kind: "selected", model: value.trim() || undefined };
    }

    return { kind: "selected", model: selectedItem.model };
  }
}

function buildModelItems(route: ModelRoute, availableModels: string[]): Array<
  | { kind: "manual"; label: string }
  | { kind: "preset"; model: string | undefined; label: string }
> {
  return [
    {
      kind: "preset",
      model: undefined,
      label: `${INHERIT_MODEL_LABEL}${route.model ? " (current uses custom model)" : " (current)"}`,
    },
    ...availableModels.map((model) => ({
      kind: "preset" as const,
      model,
      label: `${model}${route.model === model ? " (current)" : ""}`,
    })),
    {
      kind: "manual",
      label: `${MANUAL_MODEL_LABEL}${route.model && !availableModels.includes(route.model) ? ` (${route.model})` : ""}`,
    },
  ];
}

async function chooseThinking(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute,
): Promise<{ kind: "selected"; thinking: string | undefined } | { kind: "back" }> {
  const items = THINKING_LEVELS.map((thinking) => ({
    thinking,
    label: thinking === "inherit"
      ? `Inherit thinking${route.thinking ? "" : " (current)"}`
      : `${thinking}${route.thinking === thinking ? " (current)" : ""}`,
  }));

  const selectedLabel = await ctx.ui.select(`Thinking for ${label}`, [...items.map((item) => item.label), BACK_LABEL]);
  if (!selectedLabel || selectedLabel === BACK_LABEL) {
    return { kind: "back" };
  }

  const selectedItem = items.find((item) => item.label === selectedLabel);
  if (!selectedItem) {
    return { kind: "back" };
  }

  return {
    kind: "selected",
    thinking: selectedItem.thinking === "inherit" ? undefined : selectedItem.thinking,
  };
}

async function chooseSaveAction(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute,
): Promise<"save" | "clear" | "restart" | "cancel"> {
  const current = formatModelRoute(route);
  const selectedLabel = await ctx.ui.select(`Save ${label}`, [
    `Save (${current})`,
    CLEAR_ROUTE_LABEL,
    START_OVER_LABEL,
    CANCEL_SAVE_LABEL,
  ]);

  if (!selectedLabel || selectedLabel === CANCEL_SAVE_LABEL) {
    return "cancel";
  }
  if (selectedLabel === CLEAR_ROUTE_LABEL) {
    return "clear";
  }
  if (selectedLabel === START_OVER_LABEL) {
    return "restart";
  }
  return "save";
}

async function saveRouteConfig(
  current: LoreModelRoutingConfig,
  writeConfig: (config: LoreModelRoutingConfig) => Promise<LoreModelRoutingConfig>,
  update:
    | { kind: "default"; routeKind: "nonSdd" | "sdd"; route: ModelRoute | null }
    | { kind: "agent"; agentName: string; route: ModelRoute | null },
): Promise<LoreModelRoutingConfig> {
  const next: LoreModelRoutingConfig = {
    version: 1,
    defaults: { ...current.defaults },
    agents: { ...current.agents },
  };

  if (update.kind === "default") {
    if (update.route) {
      next.defaults[update.routeKind] = update.route;
    } else {
      delete next.defaults[update.routeKind];
    }
  } else if (update.route) {
    next.agents[update.agentName] = update.route;
  } else {
    delete next.agents[update.agentName];
  }

  return writeConfig(next);
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
