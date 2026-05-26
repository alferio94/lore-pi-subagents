import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import {
  expandAgentTools,
  finalizeChildRun,
  getDelegationRuntimePolicy,
  LORE_MEMORY_TOOLS,
  readDelegation,
} from "../src/runtime/delegations.ts";
import { getContractAliasMap, getInstallPolicy, getRuntimeInvariants } from "../src/runtime/contract.ts";
import { createRunRecord, recoverRun } from "../src/runtime/result-store.ts";

test("expandAgentTools expands lore memory bundle without enabling delegate", () => {
  assert.deepEqual(
    expandAgentTools(["read", "lore:*", "contact_supervisor"]),
    ["read", ...LORE_MEMORY_TOOLS, "contact_supervisor"],
  );
  assert.equal(expandAgentTools(["lore:*"]).includes("delegate"), false);
  assert.equal(expandAgentTools(["lore:*"]).includes("delegation_read"), false);
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

test("readDelegation rejects uppercase delegation ids", () => {
  assert.throws(
    () => readDelegation("dg-DEADBEEF"),
    /Invalid delegation id 'dg-DEADBEEF'\./,
  );
});
