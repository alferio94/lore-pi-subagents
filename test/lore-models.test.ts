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
