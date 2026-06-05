import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXTENSION_NAME } from "../src/extension/index.ts";
import {
  defaultRuntimeContractPath,
  getAgentResolution,
  getEntrypoint,
  getInstallPolicy,
  getRuntimeInvariants,
  listBuiltinAgents,
  listContractAliases,
  loadRuntimeContract,
  resolveBuiltinAgentName,
} from "../src/runtime/contract.ts";
import { validateRuntimeContract, type RuntimeContract } from "../src/runtime/contract-schema.ts";

function cloneContract(contract: RuntimeContract): RuntimeContract {
  return JSON.parse(JSON.stringify(contract)) as RuntimeContract;
}

test("loadRuntimeContract parses the shipped manifest and exposes stable helpers", () => {
  const contract = loadRuntimeContract();

  assert.equal(defaultRuntimeContractPath(), path.resolve("pi-runtime.contract.json"));
  assert.equal(resolveBuiltinAgentName("reviewer", contract), "lore-worker");
  assert.equal(resolveBuiltinAgentName("lore-worker", contract), "lore-worker");
  assert.equal(getEntrypoint(contract).path, "./src/extension/index.ts");
  assert.equal(getInstallPolicy(contract).conflictPolicy, "non-destructive-warn");
  assert.equal(getRuntimeInvariants(contract).continuation.backgroundFollowUp.deliverAs, "followUp");
  assert.equal(getAgentResolution(contract).managedFilenamePrefix, "lore-managed-");
  assert.equal(getAgentResolution(contract).projectAgentsSettingPath, "lore.agent_resolution.project_agents");
});

test("shipped contract stays in sync with package metadata and keeps identities distinct", () => {
  const contract = loadRuntimeContract();
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    name: string;
    files: string[];
    pi: { extensions: string[]; runtimeContract: string };
  };

  assert.equal(packageJson.name, contract.packageIdentity.name);
  assert.equal(contract.packageIdentity.extensionName, EXTENSION_NAME);
  assert.deepEqual(packageJson.pi.extensions, [contract.entrypoint.path]);
  assert.equal(packageJson.pi.runtimeContract, "./pi-runtime.contract.json");
  assert.ok(packageJson.files.includes("pi-runtime.contract.json"));
  assert.notEqual(contract.sourceLocator.value, contract.packageIdentity.name);
  assert.notEqual(contract.sourceLocator.value, contract.entrypoint.path);
  assert.notEqual(contract.packageIdentity.name, contract.entrypoint.path);
});

test("install policy keeps retained and blocked extensions explicit with no overlap", () => {
  const contract = loadRuntimeContract();
  const policy = contract.installPolicy;
  const agentResolution = contract.agentResolution;

  assert.deepEqual(policy.retainedExtensions, ["lore-footer.ts"]);
  assert.deepEqual(policy.blockedLegacyExtensions, ["lore-delegation.ts"]);
  assert.equal(policy.managedExtensionsBookkeepingOnly, true);
  assert.deepEqual(
    policy.retainedExtensions.filter((extension) => policy.blockedLegacyExtensions.includes(extension)),
    [],
  );
  assert.equal(agentResolution.managedFilenamePrefix, "lore-managed-");
  assert.deepEqual(agentResolution.managedFrontmatter, {
    managedBy: "lore-cli",
    managedLayer: "global-overlay",
  });
  assert.deepEqual(agentResolution.precedence, ["builtin", "managed", "user", "project"]);
  assert.equal(agentResolution.projectAgentsDefault, "enabled");
  assert.equal(agentResolution.projectAgentsSettingPath, "lore.agent_resolution.project_agents");
});

test("install policy never lists the deprecated lore-memory extension in any active slot", () => {
  // Focused guard for the fix-pi-envelope-tolerance-and-remove-lore-memory
  // change: the deprecated `lore-memory.ts` extension MUST NOT be retained,
  // MUST NOT be blocked (it is not a legacy contract; the install policy
  // simply does not reference it), and MUST NOT appear anywhere in the
  // shipped runtime contract. The runtime has migrated memory operations
  // to the MCP `lore_memory_*` tool surface.
  const contract = loadRuntimeContract();
  const policy = contract.installPolicy;
  const serialized = JSON.stringify(contract);

  assert.equal(
    policy.retainedExtensions.includes("lore-memory.ts"),
    false,
    "retainedExtensions must not include the deprecated lore-memory.ts extension",
  );
  assert.equal(
    policy.blockedLegacyExtensions.includes("lore-memory.ts"),
    false,
    "blockedLegacyExtensions must not include lore-memory.ts; the deprecated extension is simply not part of the contract",
  );
  assert.equal(
    serialized.includes("lore-memory.ts"),
    false,
    "the shipped runtime contract must not reference the deprecated lore-memory.ts extension at all",
  );
});

test("agent catalog is complete for shipped builtin prompts and SDD phases", () => {
  const contract = loadRuntimeContract();
  const aliases = listContractAliases(contract);
  const agents = listBuiltinAgents(contract);
  const contractPromptFiles = new Set(agents.map((agent) => agent.promptFile));
  const shippedPromptFiles = new Set(
    fs.readdirSync("agents", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.posix.join("agents", entry.name)),
  );

  assert.deepEqual(aliases.map((alias) => alias.alias).sort(), ["general", "researcher", "reviewer", "scribe"]);
  assert.deepEqual(new Set(aliases.map((alias) => alias.alias)).size, aliases.length);
  assert.deepEqual([...contractPromptFiles].sort(), [...shippedPromptFiles].sort());
  assert.equal(agents.some((agent) => agent.name === "lore-worker" && agent.role === "worker"), true);
  assert.deepEqual(
    agents.filter((agent) => agent.role === "sdd").map((agent) => agent.phase).sort(),
    ["apply", "archive", "design", "explore", "init", "propose", "spec", "tasks", "verify"],
  );
});

test("validateRuntimeContract rejects alias collisions and unknown alias targets", () => {
  const invalid = cloneContract(loadRuntimeContract());
  invalid.builtinCatalog.aliases.push({ alias: "reviewer", target: "lore-worker" });

  assert.throws(
    () => validateRuntimeContract(invalid),
    /Alias 'reviewer' must be globally unique/i,
  );

  const missingTarget = cloneContract(loadRuntimeContract());
  missingTarget.builtinCatalog.aliases[0] = { alias: "reviewer", target: "missing-worker" };

  assert.throws(
    () => validateRuntimeContract(missingTarget),
    /points to unknown builtin agent 'missing-worker'/i,
  );
});

test("validateRuntimeContract rejects retained-blocked overlap and invalid explicit skill policy", () => {
  const overlappingPolicy = cloneContract(loadRuntimeContract());
  overlappingPolicy.installPolicy.blockedLegacyExtensions = ["lore-footer.ts"];

  assert.throws(
    () => validateRuntimeContract(overlappingPolicy),
    /conflicting retained\/blocked extensions: lore-footer\.ts/i,
  );

  const invalidSkillPolicy = cloneContract(loadRuntimeContract());
  const applyAgent = invalidSkillPolicy.builtinCatalog.agents.find((agent) => agent.name === "sdd-apply");
  assert.ok(applyAgent);
  applyAgent.skillPolicy.files = [];

  assert.throws(
    () => validateRuntimeContract(invalidSkillPolicy),
    /mode 'explicit' must declare one or more files/i,
  );
});

test("validateRuntimeContract rejects incompatible managed overlay agent resolution contract", () => {
  const missingPrecedence = cloneContract(loadRuntimeContract());
  missingPrecedence.agentResolution.precedence = ["builtin", "user", "project"];

  assert.throws(
    () => validateRuntimeContract(missingPrecedence),
    /agentResolution\.precedence/i,
  );

  const missingSettingPath = cloneContract(loadRuntimeContract());
  missingSettingPath.agentResolution.projectAgentsSettingPath = "";

  assert.throws(
    () => validateRuntimeContract(missingSettingPath),
    /agentResolution\.projectAgentsSettingPath/i,
  );
});
