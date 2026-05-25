import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getBuiltinAgentContract,
  listBuiltinAgents,
  listContractAliases,
  resolveBuiltinAgentName,
} from "../src/runtime/contract.ts";
import {
  defaultBuiltinAgentDir,
  discoverAgentRegistry,
  findNearestProjectRoot,
  parseAgentDefinition,
} from "../src/runtime/agent-registry.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-"));
}

function writeAgent(dir: string, name: string, description: string, body: string, extraFrontmatter = ""): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nsystemPromptMode: replace\ninheritProjectContext: false\n${extraFrontmatter}---\n${body}\n`,
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
  const userDir = path.join(root, "user");
  const projectRoot = path.join(root, "project");
  const projectDir = path.join(projectRoot, ".pi", "agents");

  writeAgent(userDir, "lore-worker", "User worker", "user body");
  writeAgent(projectDir, "lore-worker", "Project worker", "project body");
  writeAgent(projectDir, "sdd-apply", "Project apply", "apply body");

  const registry = discoverAgentRegistry({
    cwd: projectRoot,
    builtinDir: defaultBuiltinAgentDir(),
    userDir,
    projectRoot,
  });

  assert.equal(registry.byName.get("lore-worker")?.description, "Project worker");
  assert.equal(registry.byName.get("lore-worker")?.source, "project");
  assert.equal(registry.byName.get("sdd-apply")?.body, "apply body\n");
});

test("discoverAgentRegistry resolves builtin < managed < user < project and can disable project agents", () => {
  const root = makeTempDir();
  const userDir = path.join(root, "user");
  const projectRoot = path.join(root, "project");
  const projectDir = path.join(projectRoot, ".pi", "agents");
  const managedFrontmatter = "managedBy: lore-cli\nmanagedLayer: global-overlay\nmanagedPackId: portable-agent-pack\n";

  writeAgent(userDir, "lore-worker", "User worker", "user body");
  writeAgent(userDir, "lore-worker", "Managed worker", "managed body", managedFrontmatter);
  writeAgent(projectDir, "lore-worker", "Project worker", "project body");

  const projectDisabled = discoverAgentRegistry({
    cwd: projectRoot,
    builtinDir: defaultBuiltinAgentDir(),
    userDir,
    projectRoot,
    projectAgentsMode: "disabled",
  });

  assert.equal(projectDisabled.byName.get("lore-worker")?.source, "user");
  assert.equal(projectDisabled.byName.get("lore-worker")?.description, "User worker");

  const projectEnabled = discoverAgentRegistry({
    cwd: projectRoot,
    builtinDir: defaultBuiltinAgentDir(),
    userDir,
    projectRoot,
    projectAgentsMode: "enabled",
  });

  assert.equal(projectEnabled.byName.get("lore-worker")?.source, "project");
  assert.equal(projectEnabled.byName.get("lore-worker")?.description, "Project worker");
});


test("parseAgentDefinition classifies Lore managed overlay frontmatter separately from user overrides", () => {
  const root = makeTempDir();
  const filePath = writeRawAgent(
    root,
    "lore-managed-lore-worker.md",
    `---\nname: lore-worker\ndescription: Managed overlay\nsystemPromptMode: replace\ninheritProjectContext: false\nmanagedBy: lore-cli\nmanagedLayer: global-overlay\nmanagedPackId: portable-agent-pack\n---\nmanaged body\n`,
  );

  const parsed = parseAgentDefinition(filePath, "user");

  assert.equal(parsed.source, "managed");
  assert.equal(parsed.metadata.managedBy, "lore-cli");
  assert.equal(parsed.metadata.managedLayer, "global-overlay");
});

test("discoverAgentRegistry attaches builtin contract metadata from the runtime manifest", () => {
  const root = makeTempDir();
  const registry = discoverAgentRegistry({
    cwd: root,
    builtinDir: defaultBuiltinAgentDir(),
    userDir: path.join(root, "user"),
    projectRoot: path.join(root, "project"),
  });

  const worker = registry.byName.get("lore-worker");
  const apply = registry.byName.get("sdd-apply");

  assert.equal(worker?.role, "worker");
  assert.equal(worker?.requiredEnvelope, "worker");
  assert.deepEqual(worker?.skillPolicy, { mode: "registry" });
  assert.equal(apply?.role, "sdd");
  assert.equal(apply?.phase, "apply");
  assert.equal(apply?.requiredEnvelope, "sdd");
  assert.deepEqual(apply?.skillPolicy, {
    mode: "explicit",
    files: [
      "~/.pi/agent/skills/sdd-apply/SKILL.md",
      "~/.pi/agent/skills/_shared/sdd-phase-common.md",
    ],
  });

  const builtinAgents = registry.agents.filter((agent) => agent.source === "builtin");
  assert.deepEqual(
    builtinAgents.map((agent) => agent.name),
    listBuiltinAgents().map((agent) => agent.name).sort(),
  );
  assert.equal(registry.byName.has("reviewer"), false);
});

test("discoverAgentRegistry keeps alias resolution in parity with the packaged contract", () => {
  const root = makeTempDir();
  const registry = discoverAgentRegistry({
    cwd: root,
    builtinDir: defaultBuiltinAgentDir(),
    userDir: path.join(root, "user"),
    projectRoot: path.join(root, "project"),
  });

  for (const alias of listContractAliases()) {
    assert.equal(resolveBuiltinAgentName(alias.alias), alias.target);
    assert.equal(registry.byName.has(alias.alias), false);
    assert.equal(registry.byName.get(alias.target)?.source, "builtin");
  }
});

test("discoverAgentRegistry rejects builtin files that are not declared in the manifest", () => {
  const root = makeTempDir();
  const builtinDir = path.join(root, "agents");

  writeAgent(builtinDir, "rogue-worker", "Rogue worker", "body");

  assert.throws(
    () => discoverAgentRegistry({ cwd: root, builtinDir, userDir: path.join(root, "user") }),
    /not declared in pi-runtime\.contract\.json/i,
  );
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

test("parseAgentDefinition rejects builtin frontmatter drift against the manifest", () => {
  const root = makeTempDir();
  const filePath = writeRawAgent(
    root,
    "lore-worker.md",
    `---\nname: lore-worker\ndescription: Canonical worker\nrole: sdd\nrequiredEnvelope: sdd\nphase: apply\nsystemPromptMode: replace\ninheritProjectContext: true\n---\nbody\n`,
  );

  assert.throws(
    () => parseAgentDefinition(filePath, "builtin", { builtinContract: getBuiltinAgentContract("lore-worker") }),
    /role drift/i,
  );
});

test("parseAgentDefinition accepts builtin frontmatter that matches each contract entry", () => {
  const builtinDir = defaultBuiltinAgentDir();

  for (const builtinContract of listBuiltinAgents()) {
    const filePath = path.resolve(path.dirname(builtinDir), builtinContract.promptFile);
    const parsed = parseAgentDefinition(filePath, "builtin", { builtinDir, builtinContract });

    assert.equal(parsed.name, builtinContract.name);
    assert.equal(parsed.role, builtinContract.role);
    assert.equal(parsed.phase, builtinContract.phase);
    assert.equal(parsed.requiredEnvelope, builtinContract.requiredEnvelope);
    assert.deepEqual(parsed.skillPolicy, builtinContract.skillPolicy);
    assert.deepEqual(parsed.contractFrontmatter, {
      role: builtinContract.role,
      ...(builtinContract.phase ? { phase: builtinContract.phase } : {}),
      requiredEnvelope: builtinContract.requiredEnvelope,
      skillPolicyMode: builtinContract.skillPolicy.mode,
      ...(builtinContract.skillPolicy.files ? { skillPolicyFiles: builtinContract.skillPolicy.files } : {}),
    });
  }
});
