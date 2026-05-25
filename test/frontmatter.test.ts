import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/runtime/frontmatter.ts";

test("parseFrontmatter returns empty metadata when the document has no header", () => {
  const parsed = parseFrontmatter("Hello world\n");
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, "Hello world\n");
});

test("parseFrontmatter parses strings, booleans, inline arrays, block arrays, and body", () => {
  const parsed = parseFrontmatter(`---
name: lore-worker
description: Canonical worker
inheritProjectContext: true
tools:
  - read
  - edit
tags: [runtime, worker]
---
Body text\n`);

  assert.equal(parsed.data.name, "lore-worker");
  assert.equal(parsed.data.description, "Canonical worker");
  assert.equal(parsed.data.inheritProjectContext, true);
  assert.deepEqual(parsed.data.tools, ["read", "edit"]);
  assert.deepEqual(parsed.data.tags, ["runtime", "worker"]);
  assert.equal(parsed.body, "Body text\n");
});
