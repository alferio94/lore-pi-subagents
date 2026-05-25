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

export async function openLoreModelsUI(
  ctx: LoreModelsUIContext,
  options: LoreModelsUIOptions,
): Promise<LoreModelRoutingConfig> {
  const readConfig = options.readConfig ?? readModelRoutingConfig;
  const availableModels = dedupeSorted(options.availableModels ?? []);
  const agentNames = dedupeSorted(options.agentNames ?? []);
  let config = await readConfig();

  while (true) {
    const menu = buildLoreModelsMenu(config, agentNames);
    const selectedLabel = await ctx.ui.select("/lore-models", menu.map((item) => item.label));
    const selectedItem = menu.find((item) => item.label === selectedLabel);

    if (!selectedItem || selectedItem.kind === "close") {
      return config;
    }

    if (selectedItem.kind === "default") {
      const updated = await editRoute(ctx, selectedItem.label, config.defaults[selectedItem.routeKind], availableModels);
      config = await saveRouteConfig(config, options.writeConfig, { kind: "default", routeKind: selectedItem.routeKind, route: updated });
      continue;
    }

    const updated = await editRoute(ctx, selectedItem.label, config.agents[selectedItem.agentName], availableModels);
    config = await saveRouteConfig(config, options.writeConfig, {
      kind: "agent",
      agentName: selectedItem.agentName,
      route: updated,
    });
  }
}

export function buildLoreModelsMenu(config: LoreModelRoutingConfig, agentNames: string[]): Array<
  | { kind: "default"; routeKind: "nonSdd" | "sdd"; label: string }
  | { kind: "agent"; agentName: string; label: string }
  | { kind: "close"; label: string }
> {
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
    ...agentNames.map((agentName) => ({
      kind: "agent" as const,
      agentName,
      label: `${agentName}: ${formatModelRoute(config.agents[agentName])}`,
    })),
    { kind: "close" as const, label: "Done" },
  ];
}

async function editRoute(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute | undefined,
  availableModels: string[],
): Promise<ModelRoute | null> {
  let draft = normalizeModelRoute(route) ?? {};

  while (true) {
    const actions = buildRouteActions(label, draft, availableModels);
    const selection = await ctx.ui.select(label, actions.map((action) => action.label));
    const action = actions.find((candidate) => candidate.label === selection);

    if (!action || action.kind === "done") {
      return normalizeModelRoute(draft) ?? null;
    }

    if (action.kind === "clear") {
      return null;
    }

    if (action.kind === "manual-model") {
      const value = await ctx.ui.input("Model id", draft.model ?? "");
      draft = {
        ...draft,
        model: value?.trim() || undefined,
      };
      continue;
    }

    if (action.kind === "pick-model") {
      draft = {
        ...draft,
        model: action.model || undefined,
      };
      continue;
    }

    draft = {
      ...draft,
      thinking: action.thinking === "inherit" ? undefined : action.thinking,
    };
  }
}

function buildRouteActions(label: string, route: ModelRoute, availableModels: string[]): Array<
  | { kind: "manual-model"; label: string }
  | { kind: "pick-model"; model: string | null; label: string }
  | { kind: "thinking"; thinking: (typeof THINKING_LEVELS)[number]; label: string }
  | { kind: "clear"; label: string }
  | { kind: "done"; label: string }
> {
  const modelActions = availableModels.length > 0
    ? availableModels.map((model) => ({
        kind: "pick-model" as const,
        model,
        label: `Use model: ${model}${route.model === model ? " (current)" : ""}`,
      }))
    : [{ kind: "manual-model" as const, label: `Edit model manually (${route.model ?? "inherit"})` }];

  return [
    ...modelActions,
    ...(availableModels.length > 0 ? [{ kind: "manual-model" as const, label: `Enter custom model id (${route.model ?? "inherit"})` }] : []),
    { kind: "pick-model", model: null, label: "Clear model" },
    ...THINKING_LEVELS.map((thinking) => ({
      kind: "thinking" as const,
      thinking,
      label: `Thinking: ${thinking}${route.thinking === thinking ? " (current)" : ""}`,
    })),
    { kind: "clear", label: `Clear route for ${label}` },
    { kind: "done", label: `Done (${formatModelRoute(route)})` },
  ];
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
