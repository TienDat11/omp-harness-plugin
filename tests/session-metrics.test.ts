import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionText, type RawEntry } from "../src/telemetry.ts";
import { activeWallMs, classifyStopBlocks, summarizeSessionMetrics } from "../src/session-metrics.ts";

// Synthetic builders: a linear chain unless parentId is overridden.
export function builder() {
  let n = 0;
  let last: string | undefined;
  let ts = Date.parse("2026-01-01T00:00:00Z");
  const push = (out: RawEntry[], body: RawEntry, stepMs = 1000, parentId?: string): RawEntry => {
    n += 1;
    ts += stepMs;
    const e: RawEntry = { ...body, id: `e${n}`, parentId: parentId ?? last, timestamp: new Date(ts).toISOString() };
    last = e.id as string;
    out.push(e);
    return e;
  };
  return { push, setLast: (id: string) => (last = id) };
}

const stop = { type: "custom_message", customType: "session-stop-continuation", content: "synthetic", display: false };
const user = { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
const asst = (blocks: RawEntry[], extra: RawEntry = {}) => ({
  type: "message",
  message: { role: "assistant", content: blocks, ...extra },
});
const call = (id: string, name: string, args: RawEntry = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, isError, content: [] },
});
const text = (t: string) => ({ type: "text", text: t });

test("verified_pass with no prior edit is unnecessary", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(es, asst([call("c1", "bash", { command: "npm test" })]));
  b.push(es, result("c1"));
  const r = classifyStopBlocks(es);
  assert.equal(r.blocks[0]?.label, "verified_pass");
  assert.equal(r.blocks[0]?.unnecessary, true);
  assert.equal(r.blocks[0]?.caught, false);
  assert.equal(r.counts.verified_pass, 1);
});

test("edit before a passing verify is not unnecessary; fail then pass is caught", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(es, asst([call("c1", "edit")]));
  b.push(es, result("c1"));
  b.push(es, asst([call("c2", "bash", { command: "npm test" })]));
  b.push(es, result("c2", true));
  b.push(es, asst([call("c3", "write")]));
  b.push(es, asst([call("c4", "bash", { command: "node --test" })]));
  b.push(es, result("c4"));
  const blk = classifyStopBlocks(es).blocks[0]!;
  assert.equal(blk.label, "verified_pass");
  assert.equal(blk.unnecessary, false);
  assert.equal(blk.caught, true);
  assert.equal(blk.editsAfter, 2);
  assert.equal(blk.verifies, 2);
});

test("last verify failing labels verified_fail", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(es, asst([call("c1", "bash", { command: "npm test" })]));
  b.push(es, result("c1", true));
  const blk = classifyStopBlocks(es).blocks[0]!;
  assert.equal(blk.label, "verified_fail");
  assert.equal(blk.caught, false);
});

test("declared_no_check (EN and VI), user_took_over, ignored", () => {
  for (const [msg, expected] of [
    ["There is no applicable check here.", "declared_no_check"],
    ["Không có kiểm tra nào áp dụng.", "declared_no_check"],
  ] as const) {
    const b = builder();
    const es: RawEntry[] = [];
    b.push(es, stop);
    b.push(es, asst([text(msg)]));
    assert.equal(classifyStopBlocks(es).blocks[0]?.label, expected);
  }
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(es, asst([text("done")]));
  b.push(es, user);
  assert.equal(classifyStopBlocks(es).blocks[0]?.label, "user_took_over");

  const b2 = builder();
  const es2: RawEntry[] = [];
  b2.push(es2, stop);
  b2.push(es2, asst([text("done")]));
  assert.equal(classifyStopBlocks(es2).blocks[0]?.label, "ignored");
});

test("two consecutive blocks: the first is ignored, the second verified", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(es, stop);
  b.push(es, asst([call("c1", "bash", { command: "npm test" })]));
  b.push(es, result("c1"));
  const r = classifyStopBlocks(es);
  assert.deepEqual(r.blocks.map((x) => x.label), ["ignored", "verified_pass"]);
  assert.deepEqual(r.counts, { ignored: 1, verified_pass: 1 });
});

test("custom isVerify is honoured", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(es, asst([call("c1", "bash", { command: "echo hi" })]));
  b.push(es, result("c1"));
  assert.equal(classifyStopBlocks(es, { isVerify: (c) => c === "echo hi" }).blocks[0]?.label, "verified_pass");
  assert.equal(classifyStopBlocks(es).blocks[0]?.label, "ignored");
});

test("forked branch: only the active branch counts", () => {
  const b = builder();
  const es: RawEntry[] = [];
  const root = b.push(es, user);
  b.push(es, stop); // abandoned sibling
  b.setLast(root.id as string);
  b.push(es, asst([text("fresh")]));
  assert.equal(classifyStopBlocks(es).blocks.length, 0);
  assert.equal(summarizeSessionMetrics(es).stopBlocks.total, 0);
});

test("activeWallMs skips a 2-day gap", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, user, 1000);
  b.push(es, asst([text("a")]), 2000);
  b.push(es, user, 2 * 24 * 3600 * 1000);
  b.push(es, asst([text("b")]), 3000);
  assert.equal(activeWallMs(es), 5000);
  assert.equal(activeWallMs(es, { idleGapMs: 1500 }), 0);
});

test("summarizeSessionMetrics reads provider/model/cache; malformed trailing line does not throw", () => {
  const b = builder();
  const es: RawEntry[] = [];
  b.push(es, stop);
  b.push(
    es,
    asst([text("ok")], { provider: "p1", model: "m1", usage: { input: 100, cacheRead: 300 } }),
  );
  const text0 = es.map((e) => JSON.stringify(e)).join("\n") + '\n{"type":"message","mess';
  const parsed = parseSessionText(text0);
  const s = summarizeSessionMetrics(parsed.entries);
  assert.equal(s.cache.provider, "p1");
  assert.equal(s.cache.model, "m1");
  assert.equal(s.cache.reuse, 0.75);
  assert.equal(s.stopBlocks.total, 1);
  assert.doesNotThrow(() => summarizeSessionMetrics([{ type: "message", message: 5 } as RawEntry, {}]));
});
