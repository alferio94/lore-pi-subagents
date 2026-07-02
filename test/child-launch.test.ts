import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CHILD_CANONICAL_AGENT_ENV,
  CHILD_DELEGATION_ID_ENV,
  CHILD_DEPTH_ENV,
  CHILD_MARKER_ENV,
  CHILD_REQUESTED_AGENT_ENV,
  CHILD_RUN_DIR_ENV,
  launchChildProcess,
  prepareChildLaunch,
} from "../src/runtime/child-launch.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-child-"));
}

async function withCleanChildEnv<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.LORE_PI_DELEGATION_DEPTH;
  delete process.env.LORE_PI_DELEGATION_DEPTH;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LORE_PI_DELEGATION_DEPTH;
    else process.env.LORE_PI_DELEGATION_DEPTH = previous;
  }
}

test("prepareChildLaunch enforces depth=1, can disable project context, and deduplicates tool/extension filters", async () => {
  const root = makeTempDir();

  const prepared = await withCleanChildEnv(() => prepareChildLaunch({
    cwd: root,
    prompt: "Task: inspect repo",
    delegationId: "dg-123",
    requestedAgent: "reviewer",
    canonicalAgent: "lore-worker",
    runDir: path.join(root, "runs", "dg-123"),
    tools: ["read", "bash", "read", "mcp", "lore_lore_memory_save", "lore_lore_memory_save", "contact_supervisor"],
    extensionSources: ["./src/extension/index.ts", "./src/extension/index.ts", "./adapter/index.ts"],
    inheritProjectContext: false,
    model: "openai/gpt-5-mini",
    thinking: "low",
  }));

  assert.equal(prepared.command, "pi");
  assert.deepEqual(prepared.args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--extension",
    path.resolve("./src/extension/index.ts"),
    "--extension",
    path.resolve("./adapter/index.ts"),
    "--tools",
    "read,bash,mcp,lore_lore_memory_save,contact_supervisor",
    "--model",
    "openai/gpt-5-mini",
    "--thinking",
    "low",
    "Task: inspect repo",
  ]);
  assert.equal(prepared.env[CHILD_MARKER_ENV], "1");
  assert.equal(prepared.env[CHILD_DEPTH_ENV], "1");
  assert.equal(prepared.env[CHILD_DELEGATION_ID_ENV], "dg-123");
  assert.equal(prepared.env[CHILD_REQUESTED_AGENT_ENV], "reviewer");
  assert.equal(prepared.env[CHILD_CANONICAL_AGENT_ENV], "lore-worker");
  assert.equal(prepared.env[CHILD_RUN_DIR_ENV], path.resolve(root, "runs", "dg-123"));

  await prepared.cleanup();
});

test("prepareChildLaunch rejects nested delegation beyond max depth", async () => {
  await assert.rejects(
    () =>
      withCleanChildEnv(() => {
        process.env[CHILD_DEPTH_ENV] = "1";
        return prepareChildLaunch({
          cwd: makeTempDir(),
          prompt: "Task: recurse",
          delegationId: "dg-nested",
          requestedAgent: "lore-worker",
          canonicalAgent: "lore-worker",
          runDir: makeTempDir(),
        });
      }),
    /exceeds max depth/i,
  );
});

test("prepareChildLaunch preserves delegation identity over conflicting env overrides", async () => {
  const root = makeTempDir();

  const prepared = await withCleanChildEnv(() => prepareChildLaunch({
    cwd: root,
    prompt: "Task: inspect repo",
    delegationId: "dg-identity",
    requestedAgent: "reviewer",
    canonicalAgent: "lore-worker",
    runDir: path.join(root, "runs", "dg-identity"),
    env: {
      [CHILD_MARKER_ENV]: "0",
      [CHILD_DEPTH_ENV]: "999",
      [CHILD_RUN_DIR_ENV]: "/tmp/override-run-dir",
      [CHILD_DELEGATION_ID_ENV]: "dg-override",
      [CHILD_REQUESTED_AGENT_ENV]: "override-requested",
      [CHILD_CANONICAL_AGENT_ENV]: "override-canonical",
    },
  }));

  assert.equal(prepared.env[CHILD_MARKER_ENV], "1");
  assert.equal(prepared.env[CHILD_DEPTH_ENV], "1");
  assert.equal(prepared.env[CHILD_RUN_DIR_ENV], path.resolve(root, "runs", "dg-identity"));
  assert.equal(prepared.env[CHILD_DELEGATION_ID_ENV], "dg-identity");
  assert.equal(prepared.env[CHILD_REQUESTED_AGENT_ENV], "reviewer");
  assert.equal(prepared.env[CHILD_CANONICAL_AGENT_ENV], "lore-worker");

  await prepared.cleanup();
});

test("launchChildProcess passes constrained args/env to the child and cleans temp prompt files", async () => {
  const root = makeTempDir();
  const fakePi = path.join(root, "fake-pi.js");
  const outputPath = path.join(root, "child-output.json");
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CHILD_TEST_OUTPUT, JSON.stringify({ args: process.argv.slice(2), env: { child: process.env.${CHILD_MARKER_ENV}, depth: process.env.${CHILD_DEPTH_ENV}, runDir: process.env.${CHILD_RUN_DIR_ENV}, delegationId: process.env.${CHILD_DELEGATION_ID_ENV}, requestedAgent: process.env.${CHILD_REQUESTED_AGENT_ENV}, canonicalAgent: process.env.${CHILD_CANONICAL_AGENT_ENV} } }, null, 2));
`,
    { mode: 0o755 },
  );

  const launched = await withCleanChildEnv(() => launchChildProcess({
    cwd: root,
    prompt: "Task: do the thing",
    delegationId: "dg-456",
    requestedAgent: "sdd-apply",
    canonicalAgent: "sdd-apply",
    runDir: path.join(root, "runs", "dg-456"),
    tools: ["read", "write", "contact_supervisor"],
    extensionSources: ["./src/extension/index.ts"],
    systemPrompt: "You are a child runtime.",
    systemPromptMode: "replace",
    piCommand: fakePi,
    env: { CHILD_TEST_OUTPUT: outputPath },
  }));

  const exitCode = await launched.completion;
  assert.equal(exitCode, 0);

  const payload = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
    args: string[];
    env: Record<string, string>;
  };

  assert.deepEqual(payload.args, launched.prepared.args);
  assert.equal(payload.env.child, "1");
  assert.equal(payload.env.depth, "1");
  assert.equal(payload.env.runDir, path.resolve(root, "runs", "dg-456"));
  assert.equal(payload.env.delegationId, "dg-456");
  assert.equal(payload.env.requestedAgent, "sdd-apply");
  assert.equal(payload.env.canonicalAgent, "sdd-apply");
  assert.match(payload.args.join(" "), /--system-prompt/);
  assert.doesNotMatch(payload.args.join(" "), /--append-system-prompt/);
  assert.equal(launched.prepared.systemPromptPath ? fs.existsSync(launched.prepared.systemPromptPath) : false, false);
});

test("prepareChildLaunch uses append flag when systemPromptMode=append", async () => {
  const prepared = await withCleanChildEnv(() => prepareChildLaunch({
    cwd: makeTempDir(),
    prompt: "Task: inspect repo",
    delegationId: "dg-789",
    requestedAgent: "reviewer",
    canonicalAgent: "lore-worker",
    runDir: makeTempDir(),
    systemPrompt: "Extra instructions.",
    systemPromptMode: "append",
  }));

  assert.ok(prepared.systemPromptPath);
  assert.ok(prepared.args.includes("--append-system-prompt"));
  assert.equal(prepared.args.includes("--system-prompt"), false);

  await prepared.cleanup();
});
