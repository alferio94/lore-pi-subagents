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

test("openLoreModelsUI uses route -> model -> thinking -> save flow for agent routes", async () => {
  const selections = [
    "Agent routes (2)",
    "lore-worker: inherit",
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
