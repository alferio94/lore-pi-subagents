import test from "node:test";
import assert from "node:assert/strict";
import { expandAgentTools, LORE_MEMORY_TOOLS, readDelegation } from "../src/runtime/delegations.ts";

test("expandAgentTools expands lore memory bundle without enabling delegate", () => {
  assert.deepEqual(
    expandAgentTools(["read", "lore:*", "contact_supervisor"]),
    ["read", ...LORE_MEMORY_TOOLS, "contact_supervisor"],
  );
  assert.equal(expandAgentTools(["lore:*"]).includes("delegate"), false);
  assert.equal(expandAgentTools(["lore:*"]).includes("delegation_read"), false);
});

test("readDelegation rejects uppercase delegation ids", () => {
  assert.throws(
    () => readDelegation("dg-DEADBEEF"),
    /Invalid delegation id 'dg-DEADBEEF'\./,
  );
});
