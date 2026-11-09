import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, fakePi, fakeCtx, type FakeCtx } from "./_fake-pi.ts";
import cacheAlert from "../src/cache-alert.ts";
import { summarizeHarnessLog } from "../src/state.ts";

function setup() {
  const logPath = join(tmpDir(), "harness.log");
  process.env.OMP_HARNESS_LOG_PATH = logPath;
  delete process.env.OMP_HARNESS_CACHE_ALERT;
  delete process.env.OMP_HARNESS_CACHE_ALERT_THRESHOLDS;
  const pi = fakePi();
  cacheAlert(pi as never);
  const handler = pi.handlers.get("message_end")![0];
  const ctx = fakeCtx(tmpDir());
  const lines = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => l.startsWith("C1 ")) : []);
  return { handler, ctx, lines };
}

const turn = (provider: string, input: number, cacheRead: number) => ({ type: "message_end", message: { role: "assistant", provider, usage: { input, cacheRead } } });
const notifies = (ctx: FakeCtx) => ctx.ui.notify.calls.length;

test("fewer than 5 turns gives no alert", async () => {
  const { handler, ctx, lines } = setup();
  for (let i = 0; i < 4; i++) await handler(turn("ns24", 100, 0), ctx);
  assert.equal(lines().length, 0);
  assert.equal(notifies(ctx), 0);
});

test("a drop below threshold gives exactly one C1 line and one notify, and a second drop gives none", async () => {
  const { handler, ctx, lines } = setup();
  for (let i = 0; i < 12; i++) await handler(turn("ns24", 100, 10), ctx);
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /^C1 p=\S+ pv=ns24 r=0\.091 t=0\.675$/);
  assert.equal(notifies(ctx), 1);
});

test("healthy reuse gives no alert", async () => {
  const { handler, ctx, lines } = setup();
  for (let i = 0; i < 8; i++) await handler(turn("ns24", 10, 90), ctx);
  assert.equal(lines().length, 0);
});

test("a subagent session is skipped", async () => {
  const { handler, ctx, lines } = setup();
  const sub = { ...ctx, agent: { kind: "sub" } };
  for (let i = 0; i < 8; i++) await handler(turn("ns24", 100, 0), sub);
  assert.equal(lines().length, 0);
  assert.equal(notifies(ctx), 0);
});

test("an unknown provider uses the 0.80 fallback", async () => {
  const { handler, ctx, lines } = setup();
  // reuse 0.75 is above every ns24-style default but below 0.80
  for (let i = 0; i < 5; i++) await handler(turn("mystery", 25, 75), ctx);
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /pv=mystery r=0\.750 t=0\.800$/);
});

test("OMP_HARNESS_CACHE_ALERT=0 disables and thresholds env overrides", async () => {
  const a = setup();
  process.env.OMP_HARNESS_CACHE_ALERT = "0";
  for (let i = 0; i < 6; i++) await a.handler(turn("ns24", 100, 0), a.ctx);
  assert.equal(a.lines().length, 0);
  const b = setup();
  process.env.OMP_HARNESS_CACHE_ALERT_THRESHOLDS = JSON.stringify({ ns24: 0.05 });
  for (let i = 0; i < 6; i++) await b.handler(turn("ns24", 100, 10), b.ctx);
  assert.equal(b.lines().length, 0);
  delete process.env.OMP_HARNESS_CACHE_ALERT_THRESHOLDS;
});

test("summarizeHarnessLog counts C1", () => {
  const out = summarizeHarnessLog("C1 p=repo pv=ns24 r=0.100 t=0.675\nC1 p=repo pv=vilao r=0.100 t=0.432\n");
  assert.match(out, /cache\(C1\)=2/);
});
