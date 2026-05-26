import {
  formatModelRoute,
  isSddAgent,
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
    custom?: <T>(
      factory: (
        tui: { requestRender(): void },
        theme: {
          fg(color: string, text: string): string;
          bold(text: string): string;
        },
        keybindings: unknown,
        done: (value: T) => void,
      ) => {
        render(width: number): string[];
        handleInput(data: string): void;
        invalidate?(): void;
      },
      options?: {
        overlay?: boolean;
        overlayOptions?: {
          anchor?: string;
          width?: number | string;
          minWidth?: number;
          maxHeight?: number | string;
          margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
        };
      },
    ) => Promise<T>;
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
const OVERLAY_ROWS = 12;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type RouteTarget =
  | { kind: "default"; routeKind: "nonSdd" | "sdd"; label: string; description: string }
  | { kind: "agent"; agentName: string; label: string; description: string };

type LoreModelsMenuItem = {
  value: string;
  label: string;
  description?: string;
};

type LoreModelsMenuOptions = {
  subtitle?: string;
  width?: number | string;
  minWidth?: number;
  maxHeight?: number | string;
};

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

export function buildLoreModelsMenu(config: LoreModelRoutingConfig, agentNames: string[]): Array<RouteTarget | { kind: "agents"; label: string; description: string } | { kind: "close"; label: string; description: string }> {
  return [
    {
      kind: "default",
      routeKind: "nonSdd",
      label: `Default non-SDD: ${formatModelRoute(config.defaults.nonSdd)}`,
      description: formatModelRoute(config.defaults.nonSdd),
    },
    {
      kind: "default",
      routeKind: "sdd",
      label: `Default SDD: ${formatModelRoute(config.defaults.sdd)}`,
      description: formatModelRoute(config.defaults.sdd),
    },
    ...(agentNames.length > 0
      ? [{ kind: "agents" as const, label: `${AGENTS_LABEL} (${agentNames.length})`, description: `${agentNames.length} configured agents available` }]
      : []),
    { kind: "close" as const, label: DONE_LABEL, description: "Close the routing editor" },
  ];
}

async function chooseRouteTarget(
  ctx: LoreModelsUIContext,
  config: LoreModelRoutingConfig,
  agentNames: string[],
): Promise<RouteTarget | null> {
  while (true) {
    const menu = buildLoreModelsMenu(config, agentNames);
    const selectedValue = await chooseMenuItem(ctx, "/lore-models", menu.map((item) => ({
      value: item.label,
      label: item.label,
      description: item.description,
    })), {
      subtitle: "Global routing only · ~/.pi/agent/lore/models.json",
      width: "74%",
      minWidth: 68,
      maxHeight: "80%",
    });
    const selectedItem = menu.find((item) => item.label === selectedValue);

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
  const items = agentNames.map((agentName) => {
    const route = config.agents[agentName];
    const defaultKind = isSddAgent(agentName) ? "sdd" : "nonSdd";
    const defaultLabel = defaultKind === "sdd" ? "SDD" : "non-SDD";
    const hasOverride = Boolean(normalizeModelRoute(route));
    return {
      kind: "agent" as const,
      agentName,
      label: hasOverride
        ? `${agentName}: ${formatModelRoute(route)}`
        : `${agentName}: default ${defaultLabel} (${formatModelRoute(config.defaults[defaultKind])})`,
      description: hasOverride
        ? `Explicit override; otherwise this agent uses the default ${defaultLabel} route`
        : `No override; uses the default ${defaultLabel} route`,
    };
  });

  const selectedValue = await chooseMenuItem(ctx, AGENTS_LABEL, [
    ...items.map((item) => ({ value: item.label, label: item.label, description: item.description })),
    { value: BACK_LABEL, label: BACK_LABEL, description: "Return to global routes" },
  ], {
    subtitle: "Per-agent overrides inherit from the matching default route",
    width: "76%",
    minWidth: 68,
    maxHeight: "80%",
  });
  if (!selectedValue || selectedValue === BACK_LABEL) {
    return null;
  }

  return items.find((item) => item.label === selectedValue) ?? null;
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
    const selectedValue = await chooseMenuItem(ctx, `Model for ${label}`, [
      ...items.map((item) => ({ value: item.label, label: item.label, description: item.description })),
      { value: BACK_LABEL, label: BACK_LABEL, description: "Return without changing the model" },
    ], {
      subtitle: route.model ? `Current model: ${route.model}` : "Current model: inherit",
      width: "78%",
      minWidth: 72,
      maxHeight: "80%",
    });

    if (!selectedValue || selectedValue === BACK_LABEL) {
      return { kind: "back" };
    }

    const selectedItem = items.find((item) => item.label === selectedValue);
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
  | { kind: "manual"; label: string; description: string }
  | { kind: "preset"; model: string | undefined; label: string; description: string }
> {
  return [
    {
      kind: "preset",
      model: undefined,
      label: `${INHERIT_MODEL_LABEL}${route.model ? " (current uses custom model)" : " (current)"}`,
      description: route.model ? "Use the inherited default model" : "Current selection",
    },
    ...availableModels.map((model) => ({
      kind: "preset" as const,
      model,
      label: `${model}${route.model === model ? " (current)" : ""}`,
      description: route.model === model ? "Current selection" : "Available model",
    })),
    {
      kind: "manual",
      label: `${MANUAL_MODEL_LABEL}${route.model && !availableModels.includes(route.model) ? ` (${route.model})` : ""}`,
      description: route.model && !availableModels.includes(route.model) ? `Current custom model: ${route.model}` : "Type a provider/model id manually",
    },
  ];
}

async function chooseThinking(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute,
): Promise<{ kind: "selected"; thinking: string | undefined } | { kind: "back" }> {
  const items = THINKING_LEVELS.map((thinking) => ({
    value: thinking,
    label: thinking === "inherit"
      ? `Inherit thinking${route.thinking ? "" : " (current)"}`
      : `${thinking}${route.thinking === thinking ? " (current)" : ""}`,
    description: thinking === "inherit"
      ? (!route.thinking ? "Current selection" : "Use the inherited default thinking level")
      : route.thinking === thinking
        ? "Current selection"
        : "Set explicit thinking level",
  }));

  const selectedValue = await chooseMenuItem(ctx, `Thinking for ${label}`, [
    ...items,
    { value: BACK_LABEL, label: BACK_LABEL, description: "Return to model selection" },
  ], {
    subtitle: route.thinking ? `Current thinking: ${route.thinking}` : "Current thinking: inherit",
    width: 44,
    minWidth: 44,
    maxHeight: 18,
  });
  if (!selectedValue || selectedValue === BACK_LABEL) {
    return { kind: "back" };
  }

  return {
    kind: "selected",
    thinking: selectedValue === "inherit" ? undefined : selectedValue,
  };
}

async function chooseSaveAction(
  ctx: LoreModelsUIContext,
  label: string,
  route: ModelRoute,
): Promise<"save" | "clear" | "restart" | "cancel"> {
  const current = formatModelRoute(route);
  const selectedValue = await chooseMenuItem(ctx, `Save ${label}`, [
    { value: "save", label: `Save (${current})`, description: "Persist this route to the global routing file" },
    { value: "clear", label: CLEAR_ROUTE_LABEL, description: "Remove the explicit route and inherit defaults" },
    { value: "restart", label: START_OVER_LABEL, description: "Discard this draft and start again" },
    { value: "cancel", label: CANCEL_SAVE_LABEL, description: "Leave this route unchanged" },
  ], {
    subtitle: "Review the draft before writing ~/.pi/agent/lore/models.json",
    width: "70%",
    minWidth: 64,
    maxHeight: 18,
  });

  return (selectedValue as "save" | "clear" | "restart" | "cancel" | null) ?? "cancel";
}

async function chooseMenuItem(
  ctx: LoreModelsUIContext,
  title: string,
  items: LoreModelsMenuItem[],
  options?: LoreModelsMenuOptions,
): Promise<string | null> {
  if (!ctx.ui.custom) {
    const selectedLabel = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === selectedLabel)?.value ?? null;
  }

  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    let scrollOffset = 0;
    const rowCount = Math.min(Math.max(items.length, 6), OVERLAY_ROWS);
    const visibleRows = Math.max(6, rowCount);

    const moveSelection = (delta: number) => {
      selectedIndex = Math.min(items.length - 1, Math.max(0, selectedIndex + delta));
      if (selectedIndex < scrollOffset) {
        scrollOffset = selectedIndex;
      } else if (selectedIndex >= scrollOffset + visibleRows) {
        scrollOffset = selectedIndex - visibleRows + 1;
      }
      tui.requestRender();
    };

    return {
      render(width: number) {
        const innerWidth = Math.max(24, width - 2);
        const lines: string[] = [];
        const visibleItems = items.slice(scrollOffset, scrollOffset + visibleRows);
        const footer = `↑↓/jk navigate • Enter select • Esc close (${selectedIndex + 1}/${items.length})`;

        lines.push(color(theme, "accent", `╭${"─".repeat(innerWidth)}╮`));
        lines.push(borderLine(theme, innerWidth, color(theme, "accent", bold(theme, title))));
        if (options?.subtitle) {
          lines.push(borderLine(theme, innerWidth, color(theme, "muted", options.subtitle)));
        }
        lines.push(borderLine(theme, innerWidth, ""));

        for (const item of visibleItems) {
          const absoluteIndex = scrollOffset + visibleItems.indexOf(item);
          const selected = absoluteIndex === selectedIndex;
          const prefix = selected ? "› " : "  ";
          const label = `${prefix}${item.label}`;
          lines.push(borderLine(theme, innerWidth, selected ? color(theme, "accent", label) : label));
          if (item.description) {
            const descriptionPrefix = selected ? "  " : "  ";
            lines.push(borderLine(theme, innerWidth, color(theme, "muted", `${descriptionPrefix}${item.description}`)));
          }
        }

        for (let i = visibleItems.length; i < visibleRows; i += 1) {
          lines.push(borderLine(theme, innerWidth, ""));
        }

        lines.push(borderLine(theme, innerWidth, ""));
        lines.push(borderLine(theme, innerWidth, color(theme, "dim", footer)));
        lines.push(color(theme, "accent", `╰${"─".repeat(innerWidth)}╯`));
        return lines;
      },
      handleInput(data: string) {
        if (isUpKey(data)) {
          moveSelection(-1);
          return;
        }
        if (isDownKey(data)) {
          moveSelection(1);
          return;
        }
        if (isPageUpKey(data)) {
          moveSelection(-visibleRows);
          return;
        }
        if (isPageDownKey(data)) {
          moveSelection(visibleRows);
          return;
        }
        if (isEnterKey(data)) {
          done(items[selectedIndex]?.value ?? null);
          return;
        }
        if (isCancelKey(data)) {
          done(null);
        }
      },
      invalidate() {},
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: options?.width ?? "74%",
      minWidth: options?.minWidth ?? 64,
      maxHeight: options?.maxHeight ?? "80%",
      margin: 1,
    },
  });
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

function borderLine(
  theme: { fg(color: string, text: string): string },
  innerWidth: number,
  text: string,
): string {
  return color(theme, "accent", "│") + padLine(text, innerWidth) + color(theme, "accent", "│");
}

function padLine(text: string, width: number): string {
  const clean = truncateToWidth(text, width);
  const padding = Math.max(0, width - visibleWidth(clean));
  return clean + " ".repeat(padding);
}

function truncateToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) {
    return text;
  }

  const targetWidth = Math.max(0, width - 1);
  let currentWidth = 0;
  let output = "";
  for (let index = 0; index < text.length;) {
    const ansiMatch = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
    if (ansiMatch) {
      output += ansiMatch[0];
      index += ansiMatch[0].length;
      continue;
    }

    const char = text[index];
    if (!char) {
      break;
    }
    if (currentWidth + 1 > targetWidth) {
      break;
    }
    output += char;
    currentWidth += 1;
    index += char.length;
  }
  const reset = /\u001b\[/.test(output) ? "\u001b[0m" : "";
  return `${output}${reset}…`;
}

function visibleWidth(text: string): number {
  return text.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").length;
}

function color(theme: { fg(color: string, text: string): string }, colorName: string, text: string): string {
  try {
    return theme.fg(colorName, text);
  } catch {
    return text;
  }
}

function bold(theme: { bold(text: string): string }, text: string): string {
  try {
    return theme.bold(text);
  } catch {
    return text;
  }
}

function isUpKey(data: string): boolean {
  return data === "\u001b[A" || data === "k";
}

function isDownKey(data: string): boolean {
  return data === "\u001b[B" || data === "j";
}

function isPageUpKey(data: string): boolean {
  return data === "\u001b[5~";
}

function isPageDownKey(data: string): boolean {
  return data === "\u001b[6~";
}

function isEnterKey(data: string): boolean {
  return data === "\r" || data === "\n";
}

function isCancelKey(data: string): boolean {
  return data === "\u001b" || data === "q";
}
