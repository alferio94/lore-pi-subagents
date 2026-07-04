import test from "node:test";
import assert from "node:assert/strict";
import { openLoreModelsUI } from "../src/ui/lore-models.ts";
import type { LoreModelRoutingConfig } from "../src/runtime/model-routing.ts";

function makeConfig(): LoreModelRoutingConfig {
  return {
    version: 1,
    defaults: {},
    agents: {},
  };
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("openLoreModelsUI uses route -> model -> thinking -> save flow for agent routes", async () => {
  const selections = [
    "Agent routes (2)",
    "lore-worker: default non-SDD (inherit)",
    "openai/gpt-5",
    "medium",
    "Save (model=openai/gpt-5, thinking=medium)",
    "Done",
  ];
  let saved = makeConfig();

  const result = await openLoreModelsUI({
    ui: {
      async select(_title, items) {
        const next = selections.shift();
        assert.ok(next, `unexpected select items: ${items.join(", ")}`);
        assert.ok(items.includes(next), `selection ${next} missing from ${items.join(", ")}`);
        return next;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify() {},
    },
  }, {
    availableModels: ["openai/gpt-5"],
    agentNames: ["lore-worker", "sdd-apply"],
    readConfig: async () => saved,
    writeConfig: async (config) => {
      saved = config;
      return config;
    },
  });

  assert.deepEqual(result.agents["lore-worker"], { model: "openai/gpt-5", thinking: "medium" });
});

test("openLoreModelsUI switches Orchestrator model and thinking without writing worker routing config", async () => {
  const selectedModel = { provider: "openai", id: "gpt-5" };
  let currentModel = "anthropic/old";
  let currentThinking = "medium";
  let writeCount = 0;
  const setModels: unknown[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const selections = [
    "Orchestrator/current session: model=anthropic/old, thinking=medium",
    "Model: anthropic/old",
    "openai/gpt-5",
    "Thinking: medium",
    "off",
    "Back",
    "Done",
  ];

  const result = await openLoreModelsUI({
    ui: {
      async select(_title, items) {
        const next = selections.shift();
        assert.ok(next, `unexpected select items: ${items.join(", ")}`);
        assert.ok(items.includes(next), `selection ${next} missing from ${items.join(", ")}`);
        return next;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  }, {
    availableModels: ["openai/gpt-5"],
    agentNames: [],
    orchestrator: {
      getCurrentModel: () => currentModel,
      resolveModel: (modelRef) => modelRef === "openai/gpt-5" ? selectedModel : undefined,
      async setModel(model) {
        setModels.push(model);
        currentModel = "openai/gpt-5";
        return true;
      },
      getThinkingLevel: () => currentThinking,
      setThinkingLevel(level) {
        currentThinking = level;
      },
    },
    readConfig: async () => makeConfig(),
    writeConfig: async (config) => {
      writeCount += 1;
      return config;
    },
  });

  assert.equal(writeCount, 0);
  assert.deepEqual(result, makeConfig());
  assert.deepEqual(setModels, [selectedModel]);
  assert.equal(currentThinking, "off");
  assert.deepEqual(notifications.map((entry) => entry.level), ["info", "info"]);
});

test("openLoreModelsUI surfaces Orchestrator setModel false as an auth failure", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const selections = [
    "Orchestrator/current session: model=anthropic/old, thinking=medium",
    "Model: anthropic/old",
    "openai/gpt-5",
    "Back",
    "Done",
  ];

  await openLoreModelsUI({
    ui: {
      async select(_title, items) {
        const next = selections.shift();
        assert.ok(next, `unexpected select items: ${items.join(", ")}`);
        assert.ok(items.includes(next), `selection ${next} missing from ${items.join(", ")}`);
        return next;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  }, {
    availableModels: ["openai/gpt-5"],
    agentNames: [],
    orchestrator: {
      getCurrentModel: () => "anthropic/old",
      resolveModel: () => ({ provider: "openai", id: "gpt-5" }),
      async setModel() {
        return false;
      },
      getThinkingLevel: () => "medium",
      setThinkingLevel() {},
    },
    readConfig: async () => makeConfig(),
    writeConfig: async (config) => config,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
  assert.match(notifications[0].message, /unavailable auth|setModel returned false/);
});

test("openLoreModelsUI allows backing out without saving", async () => {
  const selections = ["Default non-SDD: inherit", "Back", "Done"];
  let writeCount = 0;

  const result = await openLoreModelsUI({
    ui: {
      async select(_title, items) {
        const next = selections.shift();
        assert.ok(next, `unexpected select items: ${items.join(", ")}`);
        assert.ok(items.includes(next), `selection ${next} missing from ${items.join(", ")}`);
        return next;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify() {},
    },
  }, {
    availableModels: ["openai/gpt-5"],
    agentNames: [],
    readConfig: async () => makeConfig(),
    writeConfig: async (config) => {
      writeCount += 1;
      return config;
    },
  });

  assert.equal(writeCount, 0);
  assert.deepEqual(result, makeConfig());
});

test("openLoreModelsUI shows inherited agent routes as matching defaults", async () => {
  const customSelections = ["Agent routes (2)", "Back", "Done"];
  const agentLines: string[] = [];

  await openLoreModelsUI({
    ui: {
      async select(_title, items) {
        const next = customSelections.shift();
        assert.ok(next, `unexpected select items: ${items.join(", ")}`);
        assert.ok(items.includes(next), `selection ${next} missing from ${items.join(", ")}`);
        if (_title === "Agent routes") {
          agentLines.push(...items);
        }
        return next;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify() {},
    },
  }, {
    availableModels: [],
    agentNames: ["lore-worker", "sdd-apply"],
    readConfig: async () => ({
      version: 1,
      defaults: {
        nonSdd: { model: "openai/gpt-5", thinking: "medium" },
        sdd: { model: "openai/gpt-5", thinking: "high" },
      },
      agents: {},
    }),
    writeConfig: async (config) => config,
  });

  assert.ok(agentLines.includes("lore-worker: default non-SDD (model=openai/gpt-5, thinking=medium)"));
  assert.ok(agentLines.includes("sdd-apply: default SDD (model=openai/gpt-5, thinking=high)"));
});

test("openLoreModelsUI prefers the centered custom overlay when available", async () => {
  const customSelections = ["Done"];
  const overlayCalls: Array<{ lines: string[]; options: unknown }> = [];
  let selectCalls = 0;

  const result = await openLoreModelsUI({
    ui: {
      async select() {
        selectCalls += 1;
        return null;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify() {},
      async custom<T>(
        factory: (
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(text: string): string },
          keybindings: unknown,
          done: (value: T) => void,
        ) => { render(width: number): string[]; handleInput(data: string): void; invalidate?(): void },
        options?: unknown,
      ) {
        const next = (customSelections.shift() ?? null) as T;
        const renderer = factory(
          { requestRender() {} },
          {
            fg(_color: string, text: string) { return text; },
            bold(text: string) { return text; },
          },
          null,
          (() => {}) as (value: T) => void,
        );
        overlayCalls.push({ lines: renderer.render(80), options });
        return next;
      },
    },
  }, {
    availableModels: ["openai/gpt-5"],
    agentNames: ["lore-worker"],
    readConfig: async () => makeConfig(),
    writeConfig: async (config) => config,
  });

  assert.equal(selectCalls, 0);
  assert.deepEqual(result, makeConfig());
  assert.equal(overlayCalls.length, 1);
  assert.match(overlayCalls[0].lines.join("\n"), /Global routing only/);
  assert.deepEqual(overlayCalls[0].options, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "74%",
      minWidth: 68,
      maxHeight: "80%",
      margin: 1,
    },
  });
});

test("openLoreModelsUI custom overlay closes on Pi cancel binding, Esc variants, and q", async () => {
  const inputs = ["pi-cancel", "\u001b[27~", "q"];

  for (const input of inputs) {
    const result = await openLoreModelsUI({
      ui: {
        async select() {
          throw new Error("select fallback not expected");
        },
        async input() {
          throw new Error("manual input not expected");
        },
        notify() {},
        async custom<T>(
          factory: (
            tui: { requestRender(): void },
            theme: { fg(color: string, text: string): string; bold(text: string): string },
            keybindings: unknown,
            done: (value: T) => void,
          ) => { render(width: number): string[]; handleInput(data: string): void; invalidate?(): void },
        ) {
          return await new Promise<T>((resolve) => {
            const renderer = factory(
              { requestRender() {} },
              {
                fg(_color: string, text: string) { return text; },
                bold(text: string) { return text; },
              },
              {
                matches(data: string, binding: string) {
                  return data === "pi-cancel" && binding === "tui.select.cancel";
                },
              },
              resolve,
            );
            renderer.handleInput(input);
          });
        },
      },
    }, {
      availableModels: [],
      agentNames: [],
      readConfig: async () => makeConfig(),
      writeConfig: async (config) => config,
    });

    assert.deepEqual(result, makeConfig());
  }
});

test("openLoreModelsUI keeps colored custom overlay borders aligned", async () => {
  const overlayLines: string[][] = [];

  await openLoreModelsUI({
    ui: {
      async select() {
        return null;
      },
      async input() {
        throw new Error("manual input not expected");
      },
      notify() {},
      async custom<T>(
        factory: (
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(text: string): string },
          keybindings: unknown,
          done: (value: T) => void,
        ) => { render(width: number): string[]; handleInput(data: string): void; invalidate?(): void },
      ) {
        const renderer = factory(
          { requestRender() {} },
          {
            fg(color: string, text: string) { return `\u001b[3${color.length % 8}m${text}\u001b[0m`; },
            bold(text: string) { return `\u001b[1m${text}\u001b[22m`; },
          },
          null,
          (() => {}) as (value: T) => void,
        );
        overlayLines.push(renderer.render(42));
        return "Done" as T;
      },
    },
  }, {
    availableModels: [],
    agentNames: [],
    readConfig: async () => ({
      version: 1,
      defaults: {
        nonSdd: { model: "openai-codex/gpt-5.4", thinking: "medium" },
        sdd: { model: "openai-codex/gpt-5.4", thinking: "medium" },
      },
      agents: {},
    }),
    writeConfig: async (config) => config,
  });

  assert.equal(overlayLines.length, 1);
  const visibleLines = overlayLines[0].map(stripAnsi);
  const width = visibleLines[0].length;
  assert.ok(width > 0);
  for (const line of visibleLines) {
    assert.equal(line.length, width, line);
    assert.match(line, /^[╭│╰].*[╮│╯]$/);
  }
});
