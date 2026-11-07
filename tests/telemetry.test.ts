import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpDir } from "./_fake-pi.ts";
import {
  parseSessionText,
  resolveBranch,
  aggregate,
  cacheReuse,
  listWorkerSessions,
  childRouting,
} from "../src/telemetry.ts";

test("parseSessionText preserves unknown entry types and unknown fields", () => {
  const result = parseSessionText(JSON.stringify({ id: "e1", type: "weird", customField: "keep-me" }) + "\n");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.type, "weird");
  assert.equal((result.entries[0] as Record<string, unknown>)["customField"], "keep-me");
  assert.equal(result.skipped, 0);
  assert.equal(result.droppedFinalLine, false);
});

test("resolveBranch follows parentId from the leaf and returns only the live path", () => {
  const entries = [
    { id: "e1", type: "session", parentId: undefined },
    { id: "e2", type: "message", parentId: "e1" },
    { id: "e3", type: "message", parentId: "e1" },
  ];
  const branch = resolveBranch(entries, "e3");
  assert.equal(branch.length, 2);
  assert.equal(branch[0]?.id, "e1");
  assert.equal(branch[1]?.id, "e3");
});

test("parseSessionText drops an incomplete final line and reports it", () => {
  const result = parseSessionText('{"id":"e1","type":"session"}\n{"id":"e2","type":"message",');
  assert.equal(result.droppedFinalLine, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.id, "e1");
});

test("parseSessionText reports no dropped final line for a complete file", () => {
  const result = parseSessionText('{"id":"e1","type":"session"}\n');
  assert.equal(result.droppedFinalLine, false);
  assert.equal(result.entries.length, 1);
});

test("parseSessionText skips malformed lines and counts them", () => {
  const result = parseSessionText('{"id":"e1","type":"session"}\nnot-json\n{"id":"e2","type":"message"}\n');
  assert.equal(result.entries.length, 2);
  assert.equal(result.skipped, 1);
});

test("parseSessionText skips the fixed-width title first line", () => {
  const result = parseSessionText('{"type":"title","title":"t"}\n{"id":"e1","type":"session"}\n');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.id, "e1");
  assert.equal(result.skipped, 0);
});

test("aggregate sums usage and counts tool and model events", () => {
  const entries = [
    {
      id: "e1",
      type: "message",
      message: {
        role: "assistant",
        model: "jev-1.14.0",
        content: [{ type: "toolCall", id: "tc1" }],
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, reasoningTokens: 2 },
      },
    },
    { id: "e2", type: "message", message: { role: "toolResult", isError: true } },
    { id: "e3", type: "compaction" },
    { id: "e4", type: "model_change", model: "jev-1.14.1", resolvedModelIsFallback: true, role: "primary" },
  ];
  const agg = aggregate(entries);
  assert.equal(agg.requests, 1);
  assert.equal(agg.toolCalls, 1);
  assert.equal(agg.toolResults, 1);
  assert.equal(agg.toolErrors, 1);
  assert.equal(agg.compactions, 1);
  assert.equal(agg.fallbacks, 1);
  assert.deepEqual(agg.assistantModels, ["jev-1.14.0"]);
  assert.deepEqual(agg.fallbackModels, ["jev-1.14.1"]);
  assert.equal(agg.usage.input, 10);
  assert.equal(agg.usage.output, 5);
  assert.equal(agg.usage.cacheRead, 2);
  assert.equal(agg.usage.cacheWrite, 1);
  assert.equal(agg.usage.totalTokens, 18);
});

test("cacheReuse returns cacheRead over input plus cacheRead", () => {
  assert.equal(cacheReuse({ input: 5, cacheRead: 10 }), 10 / 15);
  assert.equal(cacheReuse({ input: 0, cacheRead: 0 }), 0);
});

test("listWorkerSessions returns only sibling agent jsonl files", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/A.jsonl`, "{}\n");
  writeFileSync(`${dir}/B.jsonl`, "{}\n");
  writeFileSync(`${dir}/__advisor.jsonl`, "{}\n");
  writeFileSync(`${dir}/notes.md`, "notes\n");
  assert.deepEqual(listWorkerSessions(dir), ["A.jsonl", "B.jsonl"]);
});

test("childRouting extracts subagent roles and assistant models", () => {
  const entries = [
    { type: "model_change", role: "subagent:reviewer", model: "jev-1.14.0" },
    { type: "message", message: { role: "assistant", model: "jev-1.14.0" } },
  ];
  const routing = childRouting(entries);
  assert.deepEqual(routing.roles, ["subagent:reviewer"]);
  assert.deepEqual(routing.models, ["jev-1.14.0"]);
});

test("resolveBranch terminates on a cyclic parent chain", () => {
  const entries = [
    { id: "loop", type: "message", parentId: "loop" },
  ];
  const branch = resolveBranch(entries, "loop");
  assert.equal(branch.length, 1);
});
