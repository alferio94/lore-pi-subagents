import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import runtimeExtension, {
  CONTACT_SUPERVISOR_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  DELEGATION_LIST_TOOL_NAME,
  DELEGATION_PRUNE_COMMAND,
  DELEGATION_PRUNE_TOOL_NAME,
  DELEGATION_READ_TOOL_NAME,
  EXTENSION_NAME,
  LORE_MODELS_COMMAND,
} from "../src/extension/index.ts";
import { getRuntimeInvariants } from "../src/runtime/contract.ts";
import { buildChildSystemPrompt } from "../src/runtime/delegations.ts";
import type { AgentDefinition } from "../src/runtime/types.ts";

async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-extension-"));
}

function makeFakePi() {
  const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>();
  const commands: Array<{ name: string; definition: { handler?: (args: string, ctx: unknown) => Promise<void> } }> = [];
  const shortcuts: Array<{ shortcut: string; definition: { handler?: (ctx: unknown) => Promise<void> | void } }> = [];
  const sentMessages: Array<{
    message: { customType: string; display: boolean; content: string; details?: Record<string, unknown> };
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
  }> = [];
  return {
    tools,
    commands,
    shortcuts,
    sentMessages,
    api: {
      registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(definition.name, definition);
      },
      registerCommand(name: string, definition: { handler?: (args: string, ctx: unknown) => Promise<void> }) {
        commands.push({ name, definition });
      },
      registerShortcut(shortcut: string, definition: { handler?: (ctx: unknown) => Promise<void> | void }) {
        shortcuts.push({ shortcut, definition });
      },
      sendMessage(message: { customType: string; display: boolean; content: string; details?: Record<string, unknown> }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) {
        sentMessages.push({ message, options });
      },
    },
  };
}

function writeFakePi(homeDir: string, stdoutPayload: unknown): string {
  const scriptPath = path.join(homeDir, "fake-pi.js");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(stdoutPayload))});\n`,
    { mode: 0o755 },
  );
  return scriptPath;
}

function writeInspectableFakePi(homeDir: string, outputPath: string, stdoutPayload: unknown): string {
  const scriptPath = path.join(homeDir, "fake-pi-inspect.js");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ args: process.argv.slice(2) }, null, 2));
process.stdout.write(${JSON.stringify(JSON.stringify(stdoutPayload))});
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("extension entrypoint exports the expected runtime name", () => {
  assert.equal(EXTENSION_NAME, "lore-pi-runtime");
  assert.equal(typeof runtimeExtension, "function");
});

test("parent runtime registers delegate tools and the lore-models command", async () => {
  await withEnv({ LORE_PI_CHILD: undefined, LORE_PI_RUN_DIR: undefined }, async () => {
    const fake = makeFakePi();
    runtimeExtension(fake.api as never);

    assert.deepEqual([...fake.tools.keys()], [DELEGATE_TOOL_NAME, DELEGATION_READ_TOOL_NAME, DELEGATION_LIST_TOOL_NAME, DELEGATION_PRUNE_TOOL_NAME]);
    assert.deepEqual(fake.commands.map((command) => command.name), [DELEGATION_PRUNE_COMMAND, LORE_MODELS_COMMAND]);
    assert.deepEqual(fake.shortcuts.map((shortcut) => shortcut.shortcut), ["ctrl+space"]);
  });
});

test("manual delegation prune tool defaults to dry-run and reports would-delete artifacts", async () => {
  const rootDir = makeTempDir();
  const runDir = path.join(rootDir, "dg-00000001");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ status: "failed", updatedAt: "2020-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(runDir, "raw-output.txt"), "heavy");
  fs.utimesSync(path.join(runDir, "raw-output.txt"), new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

  await withEnv({ LORE_PI_CHILD: undefined, LORE_PI_RUNTIME_RETENTION_DRY_RUN: "false" }, async () => {
    const fake = makeFakePi();
    runtimeExtension(fake.api as never);
    const tool = fake.tools.get(DELEGATION_PRUNE_TOOL_NAME);
    assert.ok(tool);

    const result = await tool.execute("call-1", {
      rootDir,
      heavyLogAgeDays: 0,
      maxAgeDays: 99999,
      keepLast: 999,
      maxTotalSize: "999gb",
    }) as { content: Array<{ text: string }>; details: { report: { dryRun: boolean; planned: { files: number; bytes: number } } } };

    assert.equal(result.details.report.dryRun, true);
    assert.equal(result.details.report.planned.files, 1);
    assert.match(result.content[0].text, /wouldReclaimBytes: 5/);
    assert.match(result.content[0].text, /would-delete file/);
    assert.equal(fs.existsSync(path.join(runDir, "raw-output.txt")), true);
  });
});

test("manual delegation prune tool executes only with dryRun false and reports reclaimed bytes", async () => {
  const rootDir = makeTempDir();
  const runDir = path.join(rootDir, "dg-00000002");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ status: "completed", updatedAt: "2020-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(runDir, "stderr.txt"), "heavy");
  fs.utimesSync(path.join(runDir, "stderr.txt"), new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  fs.mkdirSync(path.join(rootDir, "notes"));

  await withEnv({ LORE_PI_CHILD: undefined, LORE_PI_RUNTIME_RETENTION_DRY_RUN: "true" }, async () => {
    const fake = makeFakePi();
    runtimeExtension(fake.api as never);
    const tool = fake.tools.get(DELEGATION_PRUNE_TOOL_NAME);
    assert.ok(tool);

    const result = await tool.execute("call-2", {
      rootDir,
      dryRun: false,
      heavyLogAgeDays: 0,
      maxAgeDays: 99999,
      keepLast: 999,
      maxTotalSize: "999gb",
    }) as { content: Array<{ text: string }>; details: { report: { dryRun: boolean; planned: { files: number; bytes: number }; executed: { files: number; bytes: number }; skipped: Record<string, number> } } };

    assert.equal(result.details.report.dryRun, false);
    assert.equal(result.details.report.planned.files, 1);
    assert.equal(result.details.report.executed.files, 1);
    assert.equal(result.details.report.executed.bytes, 5);
    assert.equal(result.details.report.skipped["non-dg"], 1);
    assert.match(result.content[0].text, /reclaimedBytes: 5/);
    assert.match(result.content[0].text, /deleted file/);
    assert.equal(fs.existsSync(path.join(runDir, "stderr.txt")), false);
  });
});

test("delegation-prune command requires --execute before deleting planned artifacts", async () => {
  const rootDir = makeTempDir();
  const runDir = path.join(rootDir, "dg-00000003");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ status: "completed", updatedAt: "2020-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(runDir, "stderr.txt"), "heavy");
  fs.utimesSync(path.join(runDir, "stderr.txt"), new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

  await withEnv({ LORE_PI_CHILD: undefined, LORE_PI_RUNTIME_RETENTION_DRY_RUN: "true" }, async () => {
    const fake = makeFakePi();
    runtimeExtension(fake.api as never);
    const command = fake.commands.find((candidate) => candidate.name === DELEGATION_PRUNE_COMMAND);
    assert.ok(command?.definition.handler);

    const ctx = { ui: { notify() {} } };
    await command.definition.handler(`--root ${rootDir} --heavy-log-age-days=0 --max-age-days=99999 --keep-last=999 --max-total-size=999gb`, ctx);
    assert.equal(fs.existsSync(path.join(runDir, "stderr.txt")), true);

    await command.definition.handler(`--root ${rootDir} --execute --heavy-log-age-days=0 --max-age-days=99999 --keep-last=999 --max-total-size=999gb`, ctx);
    assert.equal(fs.existsSync(path.join(runDir, "stderr.txt")), false);
    assert.match(fake.sentMessages.at(-1)?.message.content ?? "", /deleted file/);
  });
});

test("lore-models command lists available Pi models from the model registry", async () => {
  const homeDir = makeTempDir();
  const projectDir = makeTempDir();

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, ".pi", "agent", "lore", "models.json"),
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const command = fake.commands.find((candidate) => candidate.name === LORE_MODELS_COMMAND);
      assert.ok(command?.definition.handler);

      const selections = [
        "Agent routes (10)",
        "lore-worker: default non-SDD (inherit)",
        "openai-codex/gpt-5.5",
        "Inherit thinking (current)",
        "Save (model=openai-codex/gpt-5.5)",
        "Done",
      ];
      const ctx = {
        cwd: projectDir,
        modelRegistry: {
          getAvailable() {
            return [
              { provider: "openai-codex", id: "gpt-5.5" },
              { provider: "anthropic", id: "claude-sonnet-4-5" },
            ];
          },
        },
        ui: {
          async select(_title: string, items: string[]) {
            const next = selections.shift();
            assert.ok(next, `unexpected select call with items: ${items.join(", ")}`);
            assert.ok(items.includes(next), `selection ${next} not found in ${items.join(", ")}`);
            return next;
          },
          async input() {
            throw new Error("manual model input should not be requested when models are available");
          },
          notify() {},
        },
      };

      await command.definition.handler("", ctx);

      const saved = JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "agent", "lore", "models.json"), "utf8")) as {
        agents: Record<string, { model?: string }>;
      };
      assert.equal(saved.agents["lore-worker"].model, "openai-codex/gpt-5.5");
    },
  );
});

test("lore-models command switches Orchestrator through Pi registry without writing worker routes", async () => {
  const homeDir = makeTempDir();
  const projectDir = makeTempDir();
  const selectedModel = { provider: "openai", id: "gpt-5" };
  const setModels: unknown[] = [];
  let thinking = "medium";

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, ".pi", "agent", "lore", "models.json"),
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
    },
    async () => {
      const fake = makeFakePi();
      (fake.api as { setModel?: (model: unknown) => Promise<boolean> }).setModel = async (model) => {
        setModels.push(model);
        return true;
      };
      (fake.api as { getThinkingLevel?: () => string }).getThinkingLevel = () => thinking;
      (fake.api as { setThinkingLevel?: (level: string) => void }).setThinkingLevel = (level) => {
        thinking = level;
      };
      runtimeExtension(fake.api as never);
      const command = fake.commands.find((candidate) => candidate.name === LORE_MODELS_COMMAND);
      assert.ok(command?.definition.handler);

      const selections = [
        "Orchestrator/current session: model=anthropic/claude-sonnet-4-5, thinking=medium",
        "Model: anthropic/claude-sonnet-4-5",
        "openai/gpt-5",
        "Thinking: medium",
        "off",
        "Back",
        "Done",
      ];
      const ctx = {
        cwd: projectDir,
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        modelRegistry: {
          getAvailable() {
            return [selectedModel];
          },
          find(provider: string, modelId: string) {
            return provider === "openai" && modelId === "gpt-5" ? selectedModel : undefined;
          },
        },
        ui: {
          async select(_title: string, items: string[]) {
            const next = selections.shift();
            assert.ok(next, `unexpected select call with items: ${items.join(", ")}`);
            assert.ok(items.includes(next), `selection ${next} not found in ${items.join(", ")}`);
            return next;
          },
          async input() {
            throw new Error("manual model input should not be requested");
          },
          notify() {},
        },
      };

      await command.definition.handler("", ctx);

      assert.deepEqual(setModels, [selectedModel]);
      assert.equal(thinking, "off");
      assert.equal(fs.existsSync(path.join(homeDir, ".pi", "agent", "lore", "models.json")), false);
    },
  );
});

test("child runtime only registers contact_supervisor", async () => {
  await withEnv({ LORE_PI_CHILD: "1", LORE_PI_RUN_DIR: "/tmp/lore-run" }, async () => {
    const fake = makeFakePi();
    runtimeExtension(fake.api as never);

    assert.deepEqual([...fake.tools.keys()], [CONTACT_SUPERVISOR_TOOL_NAME]);
    assert.deepEqual(fake.commands, []);
  });
});

test("contact_supervisor persists a child-only supervisor request envelope", async () => {
  const runDir = makeTempDir();

  await withEnv(
    {
      LORE_PI_CHILD: "1",
      LORE_PI_RUN_DIR: runDir,
      LORE_PI_DELEGATION_ID: "dg-321",
      LORE_PI_REQUESTED_AGENT: "reviewer",
      LORE_PI_CANONICAL_AGENT: "lore-worker",
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);

      const tool = fake.tools.get(CONTACT_SUPERVISOR_TOOL_NAME);
      assert.ok(tool);

      const response = (await tool.execute("tool-supervisor", {
        reason: "Need product decision",
        message: "Two approaches remain viable.",
        question: "Which one should continue?",
        options: ["A", "B"],
      })) as { details: { persisted: boolean; requestPath: string } };

      assert.equal(response.details.persisted, true);
      const saved = JSON.parse(fs.readFileSync(response.details.requestPath, "utf8")) as {
        delegationId: string;
        requestedAgent: string;
        canonicalAgent: string;
        reason: string;
        message: string;
        question: string;
        options: string[];
      };

      assert.equal(saved.delegationId, "dg-321");
      assert.equal(saved.requestedAgent, "reviewer");
      assert.equal(saved.canonicalAgent, "lore-worker");
      assert.equal(saved.reason, "Need product decision");
      assert.equal(saved.message, "Two approaches remain viable.");
      assert.equal(saved.question, "Which one should continue?");
      assert.deepEqual(saved.options, ["A", "B"]);
    },
  );
});

test("contact_supervisor persists null question and empty options when omitted", async () => {
  const runDir = makeTempDir();

  await withEnv(
    {
      LORE_PI_CHILD: "1",
      LORE_PI_RUN_DIR: runDir,
      LORE_PI_DELEGATION_ID: "dg-654",
      LORE_PI_REQUESTED_AGENT: "sdd-apply",
      LORE_PI_CANONICAL_AGENT: "sdd-apply",
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);

      const tool = fake.tools.get(CONTACT_SUPERVISOR_TOOL_NAME);
      assert.ok(tool);

      const response = (await tool.execute("tool-supervisor-defaults", {
        reason: "Need a supervisor checkpoint",
        message: "Waiting on a parent decision.",
      })) as { details: { persisted: boolean; requestPath: string } };

      const saved = JSON.parse(fs.readFileSync(response.details.requestPath, "utf8")) as {
        question: string | null;
        options: string[];
      };

      assert.equal(response.details.persisted, true);
      assert.equal(saved.question, null);
      assert.deepEqual(saved.options, []);
    },
  );
});

test("delegate runs a child, then delegation_read and delegation_list recover the persisted result", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePi = writeFakePi(homeDir, {
    status: "completed",
    summary: "Child finished.",
    artifacts: ["artifact-1"],
    files: ["src/runtime/envelopes.ts"],
    validations: ["npm test -- test/envelopes.test.ts"],
    next_step: "verify",
    continuation: "Continue with verification if the parent wants a follow-up.",
    question: null,
    options: [],
    risks: [],
    skill_resolution: "injected",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);

      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      const read = fake.tools.get(DELEGATION_READ_TOOL_NAME);
      const list = fake.tools.get(DELEGATION_LIST_TOOL_NAME);
      assert.ok(delegate);
      assert.ok(read);
      assert.ok(list);

      const delegated = (await delegate.execute(
        "tool-1",
        {
          agent: "lore-worker",
          task: "Inspect the repo.",
          cwd: homeDir,
        },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-123" } },
      )) as { details: { id: string; status: string; envelope: { summary: string } } };

      assert.match(delegated.details.id, /^dg-/);
      assert.equal(delegated.details.status, "completed");
      assert.equal(delegated.details.envelope.summary, "Child finished.");

      const recordPath = path.join(runRoot, delegated.details.id, "record.json");
      const storedRecord = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { sessionId?: string };
      assert.equal(storedRecord.sessionId, "session-123");

      const readBack = (await read.execute("tool-2", { id: delegated.details.id })) as {
        content: Array<{ text: string }>;
        details: { status: string; envelope: { summary: string; next_step: string; continuation: string; files: string[]; validations: string[] }; rawOutputPath: string; rawOutputPreview: string };
      };
      assert.equal(readBack.details.status, "completed");
      assert.equal(readBack.details.envelope.summary, "Child finished.");
      assert.equal(readBack.details.envelope.next_step, "verify");
      assert.equal(readBack.details.envelope.continuation, "Continue with verification if the parent wants a follow-up.");
      assert.deepEqual(readBack.details.envelope.files, ["src/runtime/envelopes.ts"]);
      assert.deepEqual(readBack.details.envelope.validations, ["npm test -- test/envelopes.test.ts"]);
      assert.match(readBack.content[0].text, /rawOutput:/);
      assert.match(readBack.content[0].text, /files: src\/runtime\/envelopes\.ts/);
      assert.match(readBack.content[0].text, /validations: npm test -- test\/envelopes\.test\.ts/);
      assert.match(readBack.content[0].text, /next_step: verify/);
      assert.match(readBack.details.rawOutputPath, /raw-output\.txt$/);
      assert.match(readBack.details.rawOutputPreview, /Child finished\./);

      const listed = (await list.execute("tool-3", {})) as {
        content: Array<{ text: string }>;
        details: { runs: Array<{ id: string; agent: string; status: string; summary: string }> };
      };
      assert.equal(listed.details.runs.length, 1);
      assert.equal(listed.details.runs[0].id, delegated.details.id);
      assert.equal(listed.details.runs[0].agent, "lore-worker");
      assert.equal(listed.details.runs[0].status, "completed");
      assert.equal(listed.details.runs[0].summary, "Child finished.");
      assert.match(listed.content[0].text, /agent: lore-worker/);
    },
  );
});

test("delegation_read rejects invalid delegation ids before path resolution", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const read = fake.tools.get(DELEGATION_READ_TOOL_NAME);
      assert.ok(read);

      const response = (await read.execute("tool-invalid-id", { id: "../escape" })) as {
        content: Array<{ text: string }>;
        details: { status: string; parseError: string };
        isError?: boolean;
      };

      assert.equal(response.isError, true);
      assert.equal(response.details.status, "failed");
      assert.match(response.details.parseError, /invalid delegation id/i);
      assert.match(response.content[0].text, /invalid delegation id/i);
    },
  );
});

test("delegate persists needs_user_input envelopes without widening child runtime tools", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePi = writeFakePi(homeDir, {
    status: "needs_user_input",
    summary: "Need approval.",
    artifacts: ["artifact-2"],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: "Ship it?",
    options: ["yes", "no"],
    risks: ["Could block rollout."],
    skill_resolution: "injected",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      const delegated = (await delegate.execute("tool-4", {
        agent: "sdd-apply",
        task: "Need a decision.",
        cwd: homeDir,
      })) as { details: { status: string; envelope: { question: string; options: string[] } } };

      assert.equal(delegated.details.status, "needs_user_input");
      assert.equal(delegated.details.envelope.question, "Ship it?");
      assert.deepEqual(delegated.details.envelope.options, ["yes", "no"]);
    },
  );
});

test("ctrl+space viewer lists only delegations from the current session", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePi = writeFakePi(homeDir, {
    status: "completed",
    summary: "Child finished.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      const shortcut = fake.shortcuts.find((candidate) => candidate.shortcut === "ctrl+space");
      assert.ok(delegate);
      assert.ok(shortcut?.definition.handler);

      const runWithSession = await delegate.execute(
        "tool-session-a",
        { agent: "lore-worker", task: "Inspect the repo.", cwd: homeDir },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-a" } },
      ) as { details: { id: string } };
      await delegate.execute(
        "tool-session-b",
        { agent: "lore-worker", task: "Inspect the repo.", cwd: homeDir },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-b" } },
      );

      const selections: Array<{ title: string; items: string[] }> = [];
      await shortcut.definition.handler({
        hasUI: true,
        sessionManager: { getSessionId: () => "session-a" },
        ui: {
          async select(title: string, items: string[]) {
            selections.push({ title, items });
            return items[0] ?? null;
          },
          notify() {},
        },
      });

      assert.equal(selections.length, 2);
      assert.equal(selections[0].title, "Subagents");
      assert.equal(selections[0].items.length, 1);
      assert.match(selections[0].items[0], new RegExp(runWithSession.details.id));
      assert.equal(selections[1].title, `Delegation ${runWithSession.details.id}`);
    },
  );
});

test("delegate async notifies the parent UI when a background child completes", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePi = writeFakePi(homeDir, {
    status: "completed",
    summary: "Child finished with spaced\nsummary.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const notifications: Array<{ message: string; level?: string }> = [];
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      const delegated = (await delegate.execute(
        "tool-async-1",
        { agent: "lore-worker", task: "Inspect the repo.", cwd: homeDir, async: true },
        undefined,
        undefined,
        { ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } } },
      )) as { details: { id: string; status: string } };

      assert.equal(delegated.details.status, "running");
      await waitFor(() => notifications.length === 1);
      assert.equal(notifications[0].level, "info");
      assert.match(notifications[0].message, new RegExp(`Background delegation ${delegated.details.id} \\(lore-worker\\) completed: Child finished with spaced summary\\.`));
    },
  );
});

test("delegate async notifies needs_user_input as a warning and preserves SDD decision text in follow-up content", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePi = writeFakePi(homeDir, {
    status: "needs_user_input",
    phase: "apply",
    summary: "Approval needed.",
    artifacts: ["sdd/change/apply-report"],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: "Ship it?",
    options: ["yes", "no"],
    risks: [],
    skill_resolution: "none",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const notifications: Array<{ message: string; level?: string }> = [];
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      const delegated = (await delegate.execute(
        "tool-async-needs-input",
        { agent: "sdd-apply", task: "Need a decision.", cwd: homeDir, async: true },
        undefined,
        undefined,
        { ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } } },
      )) as { details: { id: string } };

      await waitFor(() => notifications.length === 1 && fake.sentMessages.length === 1);
      const continuation = getRuntimeInvariants();
      assert.equal(notifications[0].level, "warning");
      assert.match(notifications[0].message, new RegExp(`Background delegation ${delegated.details.id} \\(sdd-apply\\) needs_user_input: Approval needed\\.`));
      assert.equal(fake.sentMessages[0].options?.triggerTurn, continuation.continuation.backgroundFollowUp.triggerTurn);
      assert.equal(fake.sentMessages[0].options?.deliverAs, continuation.continuation.backgroundFollowUp.deliverAs);
      assert.equal(fake.sentMessages[0].message.customType, "delegation-notification");
      assert.equal(fake.sentMessages[0].message.details?.status, "needs_user_input");
      assert.deepEqual(fake.sentMessages[0].message.details?.envelope, {
        status: "needs_user_input",
        phase: "apply",
        summary: "Approval needed.",
        artifacts: ["sdd/change/apply-report"],
        files: [],
        validations: [],
        next_step: null,
        continuation: null,
        question: "Ship it?",
        options: ["yes", "no"],
        risks: [],
        skill_resolution: "none",
      });
      assert.match(fake.sentMessages[0].message.content, /Phase: apply/);
      assert.match(fake.sentMessages[0].message.content, /Question: Ship it\?/);
      assert.match(fake.sentMessages[0].message.content, /Options: yes; no/);
    },
  );
});

test("child prompt forbids final running envelopes", () => {
  const workerAgent: AgentDefinition = {
    name: "lore-worker",
    description: "worker",
    systemPromptMode: "replace",
    inheritProjectContext: true,
    body: "Base worker prompt.",
    source: "builtin",
    filePath: "/tmp/lore-worker.md",
    metadata: {},
    requiredEnvelope: "worker",
  };
  const sddAgent: AgentDefinition = {
    ...workerAgent,
    name: "sdd-apply",
    phase: "apply",
    requiredEnvelope: "sdd",
  };

  const workerPrompt = buildChildSystemPrompt(workerAgent);
  const sddPrompt = buildChildSystemPrompt(sddAgent);

  assert.match(workerPrompt, /Do not use running in the final response/i);
  assert.match(workerPrompt, /files, validations, risks, next_step, continuation/i);
  assert.match(sddPrompt, /Do not use running in the final response/i);
  assert.match(sddPrompt, /files, validations, risks, next_step, continuation/i);
  assert.doesNotMatch(workerPrompt, /status must be one of: completed, running, needs_user_input, failed/i);
  assert.doesNotMatch(sddPrompt, /status must be one of: completed, running, needs_user_input, failed/i);
});

test("shipped builtin prompts teach dual Lore MCP surfaces before fallback without legacy dependencies", () => {
  const promptFiles = fs
    .readdirSync("agents", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join("agents", entry.name))
    .sort();

  assert.ok(promptFiles.length > 0, "expected shipped builtin prompts under agents/");

  for (const promptFile of promptFiles) {
    const body = fs.readFileSync(promptFile, "utf8");

    for (const tool of [
      "lore_memory_search",
      "lore_memory_get",
      "lore_memory_save",
      "lore_lore_memory_search",
      "lore_lore_memory_get",
      "lore_lore_memory_save",
      "lore_lore_project_activity",
      "lore_lore_project_context",
      "lore_lore_project_list",
    ]) {
      assert.ok(body.includes(`\`${tool}\``), `${promptFile} must mention ${tool}`);
    }

    if (promptFile.includes(`sdd-`)) {
      assert.match(body, /Try either Lore surface before OpenSpec fallback/i, `${promptFile} must prefer Lore before OpenSpec fallback`);
    }

    assert.match(body, /approved `pi-mcp-adapter` is explicitly loaded/i, `${promptFile} must describe explicit MCP adapter loading`);
    assert.match(body, /`mcp` gateway with server `lore`/i, `${promptFile} must prefer the Lore MCP gateway when present`);
    assert.match(body, /mcp\(\{ server: "lore", tool: "lore_lore_memory_save", args: "\{\.\.\.\}" \}\)/, `${promptFile} must document gateway call shape with JSON-string args`);
    assert.match(body, /stable title\/topic-key upsert semantics/i, `${promptFile} must teach save/upsert persistence`);
    assert.match(body, /`lore_lore_memory_update` is not part of the observed current MCP surface/i, `${promptFile} must not require prefixed memory update`);
    assert.match(body, /save a new artifact or use backend-supported upsert semantics/i, `${promptFile} must explain update-free persistence`);
    assert.match(body, /`lore-memory\.ts`;? it was removed and is not available/i, `${promptFile} must explicitly mark lore-memory.ts as removed`);
    assert.doesNotMatch(body, /MUST use `lore-memory\.ts`|use `lore-memory\.ts` for|load `lore-memory\.ts`/i, `${promptFile} must not advertise lore-memory.ts as active`);
    assert.doesNotMatch(body, /`delegate`|`delegation_read`|`delegation_list`/, `${promptFile} must not expose parent-only delegation tools in child guidance`);

    // The canonical Pi JSON envelope is the only valid final output format.
    assert.match(
      body,
      /canonical Pi JSON envelope is the ONLY valid final output format/i,
      `${promptFile} must teach the canonical Pi JSON envelope as the only valid final output format`,
    );
    // Fenced JSON and plain-text fallback envelopes are recovery behavior only.
    assert.match(
      body,
      /fenced JSON blocks? (and|or) plain-text fallback .* are runtime recovery behavior/i,
      `${promptFile} must call out fenced JSON / plain-text fallback as recovery behavior only`,
    );
  }
});

test("delegate persists failed result when child output ends with status running", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePi = writeFakePi(homeDir, {
    status: "running",
    summary: "Still working.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      const delegated = (await delegate.execute("tool-final-running", {
        agent: "lore-worker",
        task: "Inspect the repo.",
        cwd: homeDir,
      })) as { details: { id: string; status: string; envelope: unknown } };

      assert.equal(delegated.details.status, "failed");
      assert.equal(delegated.details.envelope, null);

      const read = fake.tools.get(DELEGATION_READ_TOOL_NAME);
      assert.ok(read);
      const readBack = (await read.execute("tool-final-running-read", { id: delegated.details.id })) as {
        details: { status: string; parseError: string; envelope: unknown };
      };
      assert.equal(readBack.details.status, "failed");
      assert.equal(readBack.details.envelope, null);
      assert.match(readBack.details.parseError, /cannot use status 'running'/i);
    },
  );
});

test("delegate async notifies parse errors without exposing raw output", async () => {
  const homeDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const fakePiPath = path.join(homeDir, "fake-pi-bad.js");
  fs.writeFileSync(
    fakePiPath,
    "#!/usr/bin/env node\nprocess.stdout.write('not json\\nSECRET_TOKEN_123');\n",
    { mode: 0o755 },
  );

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePiPath,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const notifications: Array<{ message: string; level?: string }> = [];
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      const delegated = (await delegate.execute(
        "tool-async-2",
        { agent: "lore-worker", task: "Inspect the repo.", cwd: homeDir, async: true },
        undefined,
        undefined,
        { ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } } },
      )) as { details: { id: string } };

      await waitFor(() => notifications.length === 1);
      assert.equal(notifications[0].level, "error");
      assert.match(notifications[0].message, new RegExp(`Background delegation ${delegated.details.id} \\(lore-worker\\) failed:`));
      assert.doesNotMatch(notifications[0].message, /SECRET_TOKEN_123/);
      assert.match(notifications[0].message, /Could not extract a single envelope JSON object/i);
    },
  );
});

test("delegate grants lore memory tools to every child before launching", async () => {
  const homeDir = makeTempDir();
  const projectDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const childArgsPath = path.join(homeDir, "child-args.json");
  const fakePi = writeInspectableFakePi(homeDir, childArgsPath, {
    status: "completed",
    summary: "Child finished.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      await delegate.execute("tool-lore-bundle", {
        agent: "lore-worker",
        task: "Use memory.",
        cwd: projectDir,
      });

      const recorded = JSON.parse(fs.readFileSync(childArgsPath, "utf8")) as { args: string[] };
      const toolsFlagIndex = recorded.args.indexOf("--tools");
      assert.notEqual(toolsFlagIndex, -1);
      const tools = recorded.args[toolsFlagIndex + 1].split(",");
      assert.deepEqual(tools, [
        "read",
        "write",
        "edit",
        "bash",
        "lore_memory_search",
        "lore_memory_get",
        "lore_memory_save",
        "lore_memory_update",
        "lore_memory_list_projects",
        "lore_memory_list_skills",
        "lore_lore_memory_search",
        "lore_lore_memory_get",
        "lore_lore_memory_save",
        "lore_lore_project_list",
        "lore_lore_project_context",
        "lore_lore_project_activity",
        "contact_supervisor",
      ]);
      assert.equal(tools.includes("lore_lore_memory_update"), false);
      assert.equal(tools.includes("mcp"), false);
      assert.equal(tools.includes("lore:*"), false);
      assert.equal(tools.includes("delegate"), false);
      assert.equal(tools.includes("delegation_read"), false);
      assert.equal(tools.includes("delegation_list"), false);
      // The deprecated Pi-native memory tools must not be granted to children.
      for (const deprecated of [
        "lore_search",
        "lore_save",
        "lore_get_observation",
        "lore_context",
        "lore_project_list",
        "lore_project_create",
        "lore_project_get",
        "lore_skill_save",
        "lore_skill_list",
        "lore_skill_get",
      ]) {
        assert.equal(tools.includes(deprecated), false, `child tool surface must not include deprecated ${deprecated}`);
      }
    },
  );
});

test("delegate explicitly loads approved MCP adapter and gates mcp tool when installed", async () => {
  const homeDir = makeTempDir();
  const projectDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const adapterDir = path.join(homeDir, ".pi", "agent", "git", "github.com", "nicobailon", "pi-mcp-adapter");
  fs.mkdirSync(adapterDir, { recursive: true });
  const adapterPath = path.join(adapterDir, "index.ts");
  fs.writeFileSync(adapterPath, "// adapter\n", "utf8");
  fs.writeFileSync(path.join(adapterDir, "package.json"), JSON.stringify({
    name: "pi-mcp-adapter",
    pi: { extensions: ["./index.ts"] },
  }), "utf8");

  const childArgsPath = path.join(homeDir, "child-args.json");
  const fakePi = writeInspectableFakePi(homeDir, childArgsPath, {
    status: "completed",
    summary: "Child finished.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_MODELS_PATH: path.join(homeDir, "models.json"),
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      await delegate.execute("tool-mcp-adapter", {
        agent: "lore-worker",
        task: "Use MCP.",
        cwd: projectDir,
      });

      const recorded = JSON.parse(fs.readFileSync(childArgsPath, "utf8")) as { args: string[] };
      assert.ok(recorded.args.includes("--no-extensions"));
      const extensionIndexes = recorded.args.flatMap((arg, index) => arg === "--extension" ? [index] : []);
      const extensions = extensionIndexes.map((index) => recorded.args[index + 1]);
      assert.ok(extensions.some((extensionPath) => extensionPath.endsWith(path.join("src", "extension", "index.ts"))));
      assert.ok(extensions.includes(adapterPath));

      const toolsFlagIndex = recorded.args.indexOf("--tools");
      assert.notEqual(toolsFlagIndex, -1);
      const tools = recorded.args[toolsFlagIndex + 1].split(",");
      assert.equal(tools.includes("mcp"), true);
      assert.equal(tools.includes("lore_lore_memory_save"), true);
      assert.equal(tools.includes("lore_memory_save"), true);
      assert.equal(tools.includes("delegate"), false);
      assert.equal(tools.includes("delegation_read"), false);
      assert.equal(tools.includes("delegation_list"), false);
    },
  );
});

test("delegate ignores project-local .pi/lore/models.json overrides and uses the global route store", async () => {
  const homeDir = makeTempDir();
  const projectDir = makeTempDir();
  const runRoot = path.join(homeDir, "runs");
  const childArgsPath = path.join(homeDir, "child-args.json");
  const fakePi = writeInspectableFakePi(homeDir, childArgsPath, {
    status: "completed",
    summary: "Child finished.",
    artifacts: [],
    files: [],
    validations: [],
    next_step: null,
    continuation: null,
    question: null,
    options: [],
    risks: [],
    skill_resolution: "none",
  });

  const globalModelsPath = path.join(homeDir, ".pi", "agent", "lore", "models.json");
  fs.mkdirSync(path.dirname(globalModelsPath), { recursive: true });
  fs.writeFileSync(
    globalModelsPath,
    `${JSON.stringify({ version: 1, defaults: { nonSdd: { model: "global/non-sdd-model" } }, agents: {} }, null, 2)}\n`,
    "utf8",
  );

  const projectLocalModelsPath = path.join(projectDir, ".pi", "lore", "models.json");
  fs.mkdirSync(path.dirname(projectLocalModelsPath), { recursive: true });
  fs.writeFileSync(
    projectLocalModelsPath,
    `${JSON.stringify({ version: 1, defaults: { nonSdd: { model: "project-local-model" } }, agents: {} }, null, 2)}\n`,
    "utf8",
  );

  await withEnv(
    {
      HOME: homeDir,
      LORE_PI_RUNTIME_RUN_ROOT: runRoot,
      LORE_PI_RUNTIME_PI_COMMAND: fakePi,
      LORE_PI_RUNTIME_MODELS_PATH: globalModelsPath,
      LORE_PI_CHILD: undefined,
      LORE_PI_RUN_DIR: undefined,
      LORE_PI_DELEGATION_DEPTH: undefined,
    },
    async () => {
      const fake = makeFakePi();
      runtimeExtension(fake.api as never);
      const delegate = fake.tools.get(DELEGATE_TOOL_NAME);
      assert.ok(delegate);

      await delegate.execute("tool-5", {
        agent: "lore-worker",
        task: "Inspect the repo.",
        cwd: projectDir,
      });

      const recorded = JSON.parse(fs.readFileSync(childArgsPath, "utf8")) as { args: string[] };
      const modelFlagIndex = recorded.args.indexOf("--model");
      assert.notEqual(modelFlagIndex, -1);
      assert.equal(recorded.args[modelFlagIndex + 1], "global/non-sdd-model");
      assert.equal(recorded.args.includes("project-local-model"), false);
    },
  );
});
