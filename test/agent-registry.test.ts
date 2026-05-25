import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgentRegistry, findNearestProjectRoot, parseAgentDefinition } from "../src/runtime/agent-registry.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-"));
}

function writeAgent(dir: string, name: string, description: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nsystemPromptMode: replace\ninheritProjectContext: false\n---\n${body}\n`,
    "utf8",
  );
}

function writeRawAgent(dir: string, fileName: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("discoverAgentRegistry merges builtin, user, and project agents with project precedence", () => {
  const root = makeTempDir();
  const builtinDir = path.join(root, "builtin");
  const userDir = path.join(root, "user");
  const projectRoot = path.join(root, "project");
  const projectDir = path.join(projectRoot, ".pi", "agents");

  writeAgent(builtinDir, "lore-worker", "Builtin worker", "builtin body");
  writeAgent(userDir, "lore-worker", "User worker", "user body");
  writeAgent(projectDir, "lore-worker", "Project worker", "project body");
  writeAgent(projectDir, "sdd-apply", "Project apply", "apply body");

  const registry = discoverAgentRegistry({
    cwd: projectRoot,
    builtinDir,
    userDir,
    projectRoot,
  });

  assert.equal(registry.agents.length, 2);
  assert.equal(registry.byName.get("lore-worker")?.description, "Project worker");
  assert.equal(registry.byName.get("lore-worker")?.source, "project");
  assert.equal(registry.byName.get("sdd-apply")?.body, "apply body\n");
});

test("findNearestProjectRoot picks the closest ancestor with .pi/agents", () => {
  const root = makeTempDir();
  const outer = path.join(root, "outer");
  const inner = path.join(outer, "inner");
  const nested = path.join(inner, "deeper");

  fs.mkdirSync(path.join(outer, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(inner, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(findNearestProjectRoot(nested), inner);
});

test("parseAgentDefinition rejects deprecated defaultContext frontmatter", () => {
  const root = makeTempDir();
  const filePath = writeRawAgent(
    root,
    "deprecated-agent.md",
    `---\nname: lore-worker\ndescription: Deprecated agent\ndefaultContext: true\n---\nbody\n`,
  );

  assert.throws(
    () => parseAgentDefinition(filePath, "project"),
    /unsupported frontmatter field\(s\): defaultContext\./,
  );
});

test("parseAgentDefinition rejects unsupported frontmatter fields", () => {
  const root = makeTempDir();
  const filePath = writeRawAgent(
    root,
    "unknown-agent.md",
    `---\nname: lore-worker\ndescription: Unknown field agent\nlaunchContract: strict\ntyopField: value\n---\nbody\n`,
  );

  assert.throws(
    () => parseAgentDefinition(filePath, "project"),
    /unsupported frontmatter field\(s\): launchContract, tyopField\./,
  );
});
