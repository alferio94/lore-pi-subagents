import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

async function importModelRouting(homeDir: string) {
  const previousHome = process.env.HOME;
  const previousModelsPath = process.env.LORE_PI_RUNTIME_MODELS_PATH;
  process.env.HOME = homeDir;
  process.env.LORE_PI_RUNTIME_MODELS_PATH = path.join(homeDir, ".pi", "agent", "lore", "models.json");
  try {
    return await import(`${pathToFileURL(path.resolve("./src/runtime/model-routing.ts")).href}?home=${Date.now()}-${Math.random()}`);
  } finally {
    process.env.HOME = previousHome;
    if (previousModelsPath === undefined) {
      delete process.env.LORE_PI_RUNTIME_MODELS_PATH;
    } else {
      process.env.LORE_PI_RUNTIME_MODELS_PATH = previousModelsPath;
    }
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-models-"));
}

async function withModelsEnv<T>(homeDir: string, run: () => Promise<T> | T): Promise<T> {
  const previousHome = process.env.HOME;
  const previousModelsPath = process.env.LORE_PI_RUNTIME_MODELS_PATH;
  process.env.HOME = homeDir;
  process.env.LORE_PI_RUNTIME_MODELS_PATH = path.join(homeDir, ".pi", "agent", "lore", "models.json");
  try {
    return await run();
  } finally {
    process.env.HOME = previousHome;
    if (previousModelsPath === undefined) {
      delete process.env.LORE_PI_RUNTIME_MODELS_PATH;
    } else {
      process.env.LORE_PI_RUNTIME_MODELS_PATH = previousModelsPath;
    }
  }
}

test("read/write model routing persists only to the global lore models path", async () => {
  const homeDir = makeTempDir();
  const modelRouting = await importModelRouting(homeDir);

  await withModelsEnv(homeDir, async () => {
    const written = await modelRouting.writeModelRoutingConfig({
      version: 1,
      defaults: { nonSdd: { model: "openai/gpt-5-mini", thinking: "low" } },
      agents: { reviewer: { model: "anthropic/claude-sonnet-4" } },
    });

    const expectedPath = path.join(homeDir, ".pi", "agent", "lore", "models.json");
    assert.equal(modelRouting.GLOBAL_LORE_MODELS_PATH ?? expectedPath, expectedPath);
    assert.equal(fs.existsSync(expectedPath), true);
    assert.deepEqual(written, await modelRouting.readModelRoutingConfig());
    assert.equal(fs.existsSync(path.join(homeDir, ".pi", "lore", "models.json")), false);
  });
});

test("readModelRoutingConfig ignores project-local .pi/lore/models.json overrides", async () => {
  const homeDir = makeTempDir();
  const projectDir = makeTempDir();
  const modelRouting = await importModelRouting(homeDir);
  const previousCwd = process.cwd();

  const globalPath = path.join(homeDir, ".pi", "agent", "lore", "models.json");
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(
    globalPath,
    `${JSON.stringify({ version: 1, defaults: { nonSdd: { model: "global/model" } }, agents: {} }, null, 2)}\n`,
    "utf8",
  );

  const projectLocalPath = path.join(projectDir, ".pi", "lore", "models.json");
  fs.mkdirSync(path.dirname(projectLocalPath), { recursive: true });
  fs.writeFileSync(
    projectLocalPath,
    `${JSON.stringify({ version: 1, defaults: { nonSdd: { model: "project-local/model" } }, agents: {} }, null, 2)}\n`,
    "utf8",
  );

  process.chdir(projectDir);
  try {
    await withModelsEnv(homeDir, async () => {
      assert.deepEqual(await modelRouting.readModelRoutingConfig(), {
        version: 1,
        defaults: { nonSdd: { model: "global/model" } },
        agents: {},
      });
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("resolveModelRoute honors frontmatter, agent route, defaults, and session fallback order", async () => {
  const homeDir = makeTempDir();
  const modelRouting = await importModelRouting(homeDir);

  const config = modelRouting.normalizeModelRoutingConfig({
    defaults: {
      nonSdd: { model: "openai/gpt-5-mini", thinking: "low" },
      sdd: { model: "openai/gpt-5", thinking: "high" },
    },
    agents: {
      reviewer: { model: "anthropic/claude-sonnet-4" },
    },
  });

  assert.deepEqual(
    modelRouting.resolveModelRoute({
      agentName: "reviewer",
      config,
      sessionModel: "session/model",
      sessionThinking: "medium",
    }),
    {
      model: "anthropic/claude-sonnet-4",
      thinking: "low",
      modelSource: "agent-route",
      thinkingSource: "default-non-sdd",
    },
  );

  assert.deepEqual(
    modelRouting.resolveModelRoute({
      agentName: "sdd-apply",
      config,
      agentModel: "frontmatter/model",
      sessionThinking: "medium",
    }),
    {
      model: "frontmatter/model",
      thinking: "high",
      modelSource: "agent-frontmatter",
      thinkingSource: "default-sdd",
    },
  );

  assert.deepEqual(
    modelRouting.resolveModelRoute({
      agentName: "scribe",
      config: modelRouting.createEmptyModelRoutingConfig(),
      sessionModel: "session/model",
      sessionThinking: "medium",
    }),
    {
      model: "session/model",
      thinking: "medium",
      modelSource: "session",
      thinkingSource: "session",
    },
  );
});

test("normalizeModelRoutingConfig trims routes and drops empty entries", async () => {
  const homeDir = makeTempDir();
  const modelRouting = await importModelRouting(homeDir);

  assert.deepEqual(
    modelRouting.normalizeModelRoutingConfig({
      defaults: { nonSdd: { model: "  ", thinking: " low " } },
      agents: {
        " reviewer ": { model: " anthropic/claude-sonnet-4 ", thinking: " " },
        empty: { model: " ", thinking: " " },
      },
    }),
    {
      version: 1,
      defaults: { nonSdd: { thinking: "low" } },
      agents: { reviewer: { model: "anthropic/claude-sonnet-4" } },
    },
  );
});
