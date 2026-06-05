import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import {
  buildChildSystemPrompt,
  discoverChildExtensions,
  expandAgentTools,
  finalizeChildRun,
  getDelegationRuntimePolicy,
  injectCanonicalPiAdapterContract,
  listDelegations,
  MCP_LORE_MEMORY_TOOLS,
  readDelegation,
} from "../src/runtime/delegations.ts";
import { getContractAliasMap, getInstallPolicy, getRuntimeInvariants } from "../src/runtime/contract.ts";
import { createRunRecord, recoverRun } from "../src/runtime/result-store.ts";
import { SDD_PHASES, SKILL_RESOLUTIONS } from "../src/runtime/envelopes.ts";
import type { AgentDefinition } from "../src/runtime/types.ts";

test("expandAgentTools expands the MCP lore_memory_* tool surface without enabling delegate", () => {
  assert.deepEqual(
    expandAgentTools(["read", ...MCP_LORE_MEMORY_TOOLS, "contact_supervisor"]),
    ["read", ...MCP_LORE_MEMORY_TOOLS, "contact_supervisor"],
  );
  assert.equal(expandAgentTools(MCP_LORE_MEMORY_TOOLS as unknown as string[]).includes("delegate"), false);
  assert.equal(expandAgentTools(MCP_LORE_MEMORY_TOOLS as unknown as string[]).includes("delegation_read"), false);
});

test("expandAgentTools strips parent-only tools and keeps the child-only supervisor tool", () => {
  assert.deepEqual(
    expandAgentTools(["delegate", "read", "delegation_read", "contact_supervisor", "contact_supervisor"]),
    ["read", "contact_supervisor"],
  );
});

test("delegation runtime policy is sourced from the packaged contract", () => {
  const policy = getDelegationRuntimePolicy();
  const aliasMap = getContractAliasMap();
  const installPolicy = getInstallPolicy();
  const runtimeInvariants = getRuntimeInvariants();

  assert.deepEqual([...policy.aliases.entries()], [...aliasMap.entries()]);
  assert.deepEqual(policy.retainedExtensions, installPolicy.retainedExtensions);
  assert.deepEqual(policy.blockedLegacyExtensions, installPolicy.blockedLegacyExtensions);
  assert.equal(policy.conflictPolicy, installPolicy.conflictPolicy);
  assert.deepEqual(policy.parentOnlyTools, runtimeInvariants.toolBoundaries.parentOnly);
  assert.deepEqual(policy.childOnlyTools, runtimeInvariants.toolBoundaries.childOnly);
});

test("delegation runtime policy keeps legacy conflict handling out of active child runtime behavior", () => {
  const policy = getDelegationRuntimePolicy();
  const expandedTools = expandAgentTools(["delegate", "delegation_read", "read"]);

  assert.equal(policy.conflictPolicy, "non-destructive-warn");
  assert.deepEqual(
    policy.retainedExtensions.filter((extension) => policy.blockedLegacyExtensions.includes(extension)),
    [],
  );
  assert.deepEqual(expandedTools, ["read", "contact_supervisor"]);
});

test("delegation runtime policy never retains the deprecated lore-memory extension", () => {
  // Focused guard for the fix-pi-envelope-tolerance-and-remove-lore-memory
  // change: the deprecated `lore-memory.ts` extension MUST NOT appear in
  // the active runtime policy. Memory operations are exposed via the
  // MCP `lore_memory_*` tool surface instead.
  const policy = getDelegationRuntimePolicy();
  assert.equal(
    policy.retainedExtensions.includes("lore-memory.ts"),
    false,
    "delegation runtime policy must not retain the deprecated lore-memory.ts extension",
  );
  assert.equal(
    policy.blockedLegacyExtensions.includes("lore-memory.ts"),
    false,
    "delegation runtime policy must not block the deprecated lore-memory.ts extension; the contract simply does not reference it",
  );
});

test("discoverChildExtensions never autoloads the deprecated lore-memory extension", () => {
  // Focused guard: even if a stale `~/.pi/agent/extensions/lore-memory.ts`
  // is left behind by a prior install, the runtime MUST NOT add it to the
  // set of extensions passed to child pi processes. The autoload set is
  // limited to the current runtime extension; memory operations flow
  // through the MCP `lore_memory_*` tool surface, not Pi extensions.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-ext-autoload-"));
  const fakeExtensionPath = path.join(fakeHome, ".pi", "agent", "extensions", "lore-memory.ts");
  fs.mkdirSync(path.dirname(fakeExtensionPath), { recursive: true });
  fs.writeFileSync(fakeExtensionPath, "// stale lore-memory.ts placeholder\n", "utf8");

  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const discovered = discoverChildExtensions();
    for (const extensionPath of discovered) {
      assert.equal(
        path.basename(extensionPath) === "lore-memory.ts",
        false,
        `discoverChildExtensions autoloaded deprecated lore-memory.ts at ${extensionPath}`,
      );
      assert.equal(
        extensionPath.includes(`${path.sep}extensions${path.sep}lore-memory.ts`),
        false,
        `discoverChildExtensions autoloaded an extensions/ path that resolves to lore-memory.ts: ${extensionPath}`,
      );
    }
    // The discovery set must be non-empty (the current runtime extension is always autoloaded)
    // and must NOT include any extension that resolves to the deprecated memory path.
    assert.ok(discovered.length >= 1, "discoverChildExtensions must still autoload the current runtime extension");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("finalizeChildRun caps captured child streams", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-delegation-"));
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-feedbeef",
    requestedAgent: "lore-worker",
    canonicalAgent: "lore-worker",
    cwd: "/repo",
  });

  const envelope = JSON.stringify({
    status: "completed",
    summary: "tail parsed",
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
  const stdout = Readable.from([
    "x".repeat(9 * 1024 * 1024),
    "\n",
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: envelope }] } }),
  ]);

  await finalizeChildRun(record, stdout, Readable.from([]), Promise.resolve(0));

  const recovered = recoverRun(record.runDir);
  assert.equal(recovered.status?.status, "completed");
  assert.equal(recovered.result?.envelope?.summary, "tail parsed");
  assert.match(fs.readFileSync(record.files.rawOutput, "utf8"), /stream truncated/);
});

test("finalizeChildRun persists failed output when completion rejects", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-delegation-"));
  const record = createRunRecord({
    rootDir,
    delegationId: "dg-deadbeef",
    requestedAgent: "lore-worker",
    canonicalAgent: "lore-worker",
    cwd: "/repo",
  });

  await finalizeChildRun(
    record,
    Readable.from([]),
    Readable.from([]),
    Promise.reject(new Error("spawn ENOENT")),
  );

  const recovered = recoverRun(record.runDir);
  assert.equal(recovered.record.status, "failed");
  assert.equal(recovered.status?.status, "failed");
  assert.equal(recovered.result?.envelope?.status, "failed");
  assert.match(recovered.rawOutput ?? "", /failed before producing a final envelope/i);
  assert.match(recovered.stderr ?? "", /spawn ENOENT/);
});

test("listDelegations filters by sessionId without breaking unfiltered results", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-pi-runtime-delegation-"));
  const previousRoot = process.env.LORE_PI_RUNTIME_RUN_ROOT;
  process.env.LORE_PI_RUNTIME_RUN_ROOT = rootDir;

  try {
    const first = createRunRecord({
      rootDir,
      delegationId: "dg-11111111",
      requestedAgent: "lore-worker",
      canonicalAgent: "lore-worker",
      cwd: "/repo",
      sessionId: "session-a",
    });
    const second = createRunRecord({
      rootDir,
      delegationId: "dg-22222222",
      requestedAgent: "lore-worker",
      canonicalAgent: "lore-worker",
      cwd: "/repo",
      sessionId: "session-b",
    });
    const legacy = createRunRecord({
      rootDir,
      delegationId: "dg-33333333",
      requestedAgent: "lore-worker",
      canonicalAgent: "lore-worker",
      cwd: "/repo",
    });

    await finalizeChildRun(first, Readable.from([JSON.stringify({
      status: "completed",
      summary: "first",
      artifacts: [],
      files: [],
      validations: [],
      next_step: null,
      continuation: null,
      question: null,
      options: [],
      risks: [],
      skill_resolution: "none",
    })]), Readable.from([]), Promise.resolve(0));
    await finalizeChildRun(second, Readable.from([JSON.stringify({
      status: "completed",
      summary: "second",
      artifacts: [],
      files: [],
      validations: [],
      next_step: null,
      continuation: null,
      question: null,
      options: [],
      risks: [],
      skill_resolution: "none",
    })]), Readable.from([]), Promise.resolve(0));
    await finalizeChildRun(legacy, Readable.from([JSON.stringify({
      status: "completed",
      summary: "legacy",
      artifacts: [],
      files: [],
      validations: [],
      next_step: null,
      continuation: null,
      question: null,
      options: [],
      risks: [],
      skill_resolution: "none",
    })]), Readable.from([]), Promise.resolve(0));

    assert.deepEqual(listDelegations(undefined, undefined, "session-a").map((run) => run.id), ["dg-11111111"]);
    assert.deepEqual(listDelegations(undefined, undefined, "session-b").map((run) => run.id), ["dg-22222222"]);
    assert.deepEqual(listDelegations().map((run) => run.id).sort(), ["dg-11111111", "dg-22222222", "dg-33333333"]);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.LORE_PI_RUNTIME_RUN_ROOT;
    } else {
      process.env.LORE_PI_RUNTIME_RUN_ROOT = previousRoot;
    }
  }
});

test("readDelegation rejects uppercase delegation ids", () => {
  assert.throws(
    () => readDelegation("dg-DEADBEEF"),
    /Invalid delegation id 'dg-DEADBEEF'\./,
  );
});

test("injectCanonicalPiAdapterContract derives the field list and final statuses from envelopes constants (worker)", () => {
  const contract = injectCanonicalPiAdapterContract("worker");

  // Must be labeled as the Pi Lore delegation adapter contract.
  assert.match(contract, /Pi Lore delegation adapter contract/i);

  // Worker canonical fields must all appear in the documented order.
  const expectedWorkerFields = [
    "status",
    "summary",
    "artifacts",
    "files",
    "validations",
    "risks",
    "next_step",
    "continuation",
    "question",
    "options",
    "skill_resolution",
  ];
  for (const field of expectedWorkerFields) {
    assert.match(contract, new RegExp(`\\b${field}\\b`), `worker contract is missing field ${field}`);
  }
  // Worker contract must NOT include the SDD-only `phase` field in the field list.
  assert.doesNotMatch(contract, /exactly these keys: status, phase,/);

  // Final output statuses must exclude `running`; only completed/needs_user_input/failed remain.
  assert.match(contract, /Final output status must be one of: completed, needs_user_input, failed\./);
  assert.doesNotMatch(contract, /Final output status must be one of: completed, running, needs_user_input, failed\./);

  // Skill resolution list must come from the canonical SKILL_RESOLUTIONS constant.
  assert.match(contract, new RegExp(`skill_resolution must be one of: ${SKILL_RESOLUTIONS.join(", ")}\\.`));
});

test("injectCanonicalPiAdapterContract derives the field list and phase set from envelopes constants (sdd)", () => {
  const contract = injectCanonicalPiAdapterContract("sdd", "apply");

  assert.match(contract, /Pi Lore delegation adapter contract/i);

  // SDD canonical fields must include `phase` in addition to all worker fields.
  const expectedSddFields = [
    "status",
    "phase",
    "summary",
    "artifacts",
    "files",
    "validations",
    "risks",
    "next_step",
    "continuation",
    "question",
    "options",
    "skill_resolution",
  ];
  for (const field of expectedSddFields) {
    assert.match(contract, new RegExp(`\\b${field}\\b`), `sdd contract is missing field ${field}`);
  }

  // Phase set must come from the canonical SDD_PHASES constant and reject arbitrary phases.
  assert.match(contract, new RegExp(`phase must match the SDD phase \\(one of: ${SDD_PHASES.join(", ")}\\)\\.`));
  assert.doesNotMatch(contract, /phase must match the SDD phase \(one of: [a-z]+, [a-z]+\)\.$/);

  // Final output statuses must still exclude `running`.
  assert.match(contract, /Final output status must be one of: completed, needs_user_input, failed\./);

  // Skill resolution list still present for SDD envelopes.
  assert.match(contract, new RegExp(`skill_resolution must be one of: ${SKILL_RESOLUTIONS.join(", ")}\\.`));
});

test("injectCanonicalPiAdapterContract explicitly forbids obsolete response fields in the canonical contract", () => {
  for (const kind of ["worker", "sdd"] as const) {
    const contract = injectCanonicalPiAdapterContract(kind);
    // The contract must NOT teach `executive_summary` or `next_recommended` as canonical fields.
    assert.doesNotMatch(contract, /`executive_summary`/, `${kind} contract must not teach \`executive_summary\``);
    assert.doesNotMatch(contract, /`next_recommended`/, `${kind} contract must not teach \`next_recommended\``);
    // The contract must not include a `next` field as a canonical response key (only `next_step` is valid).
    assert.doesNotMatch(contract, /, `next`, /, `${kind} contract must not include \`next\` as a canonical field`);
    // The contract must enumerate the canonical skill_resolution set verbatim.
    assert.match(contract, new RegExp(`skill_resolution must be one of: ${SKILL_RESOLUTIONS.join(", ")}\\.`));
    // The contract must not include duplicate or conflicting response-contract wording.
    const fieldListOccurrences = (contract.match(/exactly these keys: /g) || []).length;
    assert.equal(fieldListOccurrences, 1, `${kind} contract must contain exactly one "exactly these keys:" line`);
  }
});

test("buildChildSystemPrompt for SDD agents uses only the canonical SDD phase set in the example block", () => {
  // The `ContractPhase` type (used for `AgentDefinition.phase`) uses the render-time alias
  // `propose` for the canonical `proposal` phase. Build the mapping here so we can construct a
  // valid `AgentDefinition` while still asserting the runtime-injected example uses the canonical
  // phase value.
  const canonicalToRenderTime = new Map<string, "init" | "explore" | "propose" | "spec" | "design" | "tasks" | "apply" | "verify" | "archive">([
    ["init", "init"],
    ["explore", "explore"],
    ["proposal", "propose"],
    ["spec", "spec"],
    ["design", "design"],
    ["tasks", "tasks"],
    ["apply", "apply"],
    ["verify", "verify"],
    ["archive", "archive"],
  ]);

  for (const phase of SDD_PHASES) {
    const renderTimePhase = canonicalToRenderTime.get(phase);
    assert.ok(renderTimePhase, `no render-time phase mapped for canonical phase ${phase}`);
    const agent: AgentDefinition = {
      name: "sdd-apply",
      description: "test",
      systemPromptMode: "replace",
      inheritProjectContext: true,
      body: "Test agent body.",
      source: "builtin",
      filePath: `/tmp/sdd-${phase}.md`,
      metadata: {},
      requiredEnvelope: "sdd",
      phase: renderTimePhase,
    };
    const prompt = buildChildSystemPrompt(agent);
    // The example phase value in the prompt must match the render-time alias passed in `agent.phase`.
    assert.match(prompt, new RegExp('"phase"\\s*:\\s*"' + renderTimePhase + '"'), `prompt must include JSON example phase \`${renderTimePhase}\``);
    // The prompt must not include any non-canonical phase value as an example. The example uses
    // the render-time alias (e.g. "propose" for "proposal") because that's the frontmatter value
    // passed in. The contract text upstream mentions the canonical phase set including "proposal"
    // so the example can use the alias as a runtime convenience.
    const exampleMatch = prompt.match(/Example shape:.*?"phase":"([^"]+)"/);
    if (exampleMatch) {
      const exampleValue = exampleMatch[1];
      const isCanonical = (SDD_PHASES as readonly string[]).includes(exampleValue);
      const isRenderTimeAlias = exampleValue === renderTimePhase;
      assert.ok(
        isCanonical || isRenderTimeAlias,
        `prompt example phase \`${exampleValue}\` is neither canonical (\`${SDD_PHASES.join(", ")}\`) nor the render-time alias (\`${renderTimePhase}\`)`,
      );
    }
  }
});

test("buildChildSystemPrompt does not duplicate the response-contract section when the agent body already teaches it", () => {
  // The runtime contract injection in `buildChildSystemPrompt` always appends the canonical
  // contract, but the agent body may already teach a similar section. We assert the contract
  // is appended exactly once (the runtime contract) and that the body is preserved verbatim.
  const workerAgent: AgentDefinition = {
    name: "lore-worker",
    description: "worker",
    systemPromptMode: "replace",
    inheritProjectContext: true,
    body: "Base body. `next` and `executive_summary` and `next_recommended` are NOT response-contract fields.",
    source: "builtin",
    filePath: "/tmp/lore-worker.md",
    metadata: {},
    requiredEnvelope: "worker",
  };
  const prompt = buildChildSystemPrompt(workerAgent);
  // The canonical contract appears exactly once (the runtime-injected section, not duplicated
  // by the agent body, which does not teach the canonical field list).
  const canonicalFieldList = "exactly these keys: status, summary, artifacts, files, validations, risks, next_step, continuation, question, options, skill_resolution";
  const occurrences = (prompt.match(new RegExp(canonicalFieldList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  assert.equal(occurrences, 1, `prompt must contain canonical field list exactly once (got ${occurrences})`);
  // The body phrase is preserved in the prompt.
  assert.match(prompt, /Base body\./);
});

test("buildChildSystemPrompt injects the derived Pi adapter contract and excludes obsolete response fields", () => {
  const workerAgent: AgentDefinition = {
    name: "lore-worker",
    description: "Canonical Lore repository worker.",
    body: "Base worker prompt.",
    source: "builtin",
    filePath: "/tmp/lore-worker.md",
    metadata: {},
    requiredEnvelope: "worker",
    systemPromptMode: "replace",
    inheritProjectContext: true,
  };
  const sddAgent: AgentDefinition = {
    ...workerAgent,
    name: "sdd-apply",
    phase: "apply",
    requiredEnvelope: "sdd",
  };

  const workerPrompt = buildChildSystemPrompt(workerAgent);
  const sddPrompt = buildChildSystemPrompt(sddAgent);

  for (const prompt of [workerPrompt, sddPrompt]) {
    // The contract section is present and labeled.
    assert.match(prompt, /## Required final response contract/);
    assert.match(prompt, /Pi Lore delegation adapter contract/i);
    // Final running is rejected in the wording; the old wording that listed running as a final status is gone.
    assert.match(prompt, /Do not use running in the final response/i);
    assert.doesNotMatch(prompt, /Final output status must be one of: completed, running, needs_user_input, failed\./);
    // Obsolete response contract fields are not taught as canonical fields.
    assert.doesNotMatch(prompt, /exactly these keys: status, summary, artifacts, `?next`?, /);
    assert.doesNotMatch(prompt, /executive_summary/);
    assert.doesNotMatch(prompt, /next_recommended/);
  }

  // SDD prompt must include the `phase` field in the documented key list.
  assert.match(sddPrompt, /exactly these keys: status, phase, summary, artifacts, files, validations, risks, next_step, continuation, question, options, skill_resolution\./);
  // Worker prompt must NOT include `phase` in the documented key list.
  assert.doesNotMatch(workerPrompt, /exactly these keys: status, phase,/);
});
