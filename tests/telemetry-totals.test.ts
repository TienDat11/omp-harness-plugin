import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpDir, fakePi, type FakePi } from "./_fake-pi.ts";
import tools from "../src/tools.ts";
import {
  cacheReuse,
  resolveSessionFile,
  sessionTotals,
  summarizeSessionFile,
  type SessionTotals,
  computeAcceptedTaskCost,
} from "../src/telemetry.ts";

function mountTools(): FakePi {
  const pi = fakePi();
  tools(pi as never);
  return pi;
}

async function harnessRecord(pi: FakePi, dir: string, params: Record<string, unknown>) {
  const def = pi.tools.get("harness_record");
  assert.ok(def, "harness_record tool not registered");
  return (def as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }).execute("rec-1", { ...params, dir });
}

function writeJsonl(file: string, lines: string[]): string {
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

test("sessionTotals rolls up main + multiple worker sessions", () => {
  const main = [
    { id: "s1", type: "session" },
    { id: "sp", type: "spawn", parentId: "s1" },
    {
      id: "m1",
      type: "message",
      parentId: "sp",
      message: {
        role: "assistant",
        model: "model-a",
        content: [{ type: "toolCall", id: "c1" }],
        usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, totalTokens: 360, reasoningTokens: 5 },
      },
    },
    { id: "m2", type: "message", parentId: "m1", message: { role: "toolResult", isError: true } },
    {
      id: "m3",
      type: "message",
      parentId: "m2",
      message: {
        role: "assistant",
        model: "model-a",
        content: [{ type: "toolCall", id: "c2" }, { type: "toolCall", id: "c3" }],
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, reasoningTokens: 0 },
      },
    },
  ];
  const workers = {
    Reviewer: [
      { id: "ws1", type: "session" },
      {
        id: "wm1",
        type: "message",
        parentId: "ws1",
        message: {
          role: "assistant",
          model: "model-b",
          usage: { input: 30, output: 10, cacheRead: 40, cacheWrite: 0, totalTokens: 80, reasoningTokens: 0 },
        },
      },
    ],
    Planner: [
      { id: "ps1", type: "session" },
      { id: "pe1", type: "message", parentId: "ps1", message: { role: "toolResult", isError: true } },
      {
        id: "pm1",
        type: "message",
        parentId: "ps1",
        message: {
          role: "assistant",
          model: "model-c",
          usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, reasoningTokens: 0 },
        },
      },
    ],
  };
  const totals = sessionTotals(main, workers);

  assert.deepEqual(totals.main, { input: 120, output: 55, cacheRead: 200, cacheWrite: 10, totalTokens: 385, reasoningTokens: 5 });
  assert.deepEqual(totals.workers.Reviewer, { input: 30, output: 10, cacheRead: 40, cacheWrite: 0, totalTokens: 80, reasoningTokens: 0 });
  assert.deepEqual(totals.workers.Planner, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, reasoningTokens: 0 });
  assert.deepEqual(totals.combined, { input: 157, output: 68, cacheRead: 240, cacheWrite: 10, totalTokens: 475, reasoningTokens: 5 });
  assert.equal(totals.cacheHitRate, cacheReuse(totals.combined));
  assert.equal(totals.cacheHitRate, 240 / 397);
  assert.equal(totals.peakWindowTokens, 360);
  assert.equal(totals.toolCalls, 3);
  assert.equal(totals.toolErrors, 2);
  assert.equal(totals.subagentSpawns, 2);
});

test("sessionTotals with no workers derives everything from main", () => {
  const totals = sessionTotals([
    { id: "s1", type: "session" },
    {
      id: "m1",
      type: "message",
      parentId: "s1",
      message: { role: "assistant", model: "model-a", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, reasoningTokens: 0 } },
    },
  ]);
  assert.deepEqual(totals.combined, totals.main);
  assert.deepEqual(totals.workers, {});
  assert.equal(totals.cacheHitRate, 0);
  assert.equal(totals.peakWindowTokens, 7);
  assert.equal(totals.subagentSpawns, 0);
});

test("summarizeSessionFile reads session + sibling worker jsonl files", () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "session.jsonl"), [
    JSON.stringify({ id: "s1", type: "session" }),
    JSON.stringify({ id: "m1", type: "message", message: { role: "assistant", model: "model-a", content: [{ type: "toolCall", id: "c1" }], usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37, reasoningTokens: 0 } } }),
  ]);
  const artifactDir = join(root, "session");
  mkdirSync(artifactDir, { recursive: true });
  writeJsonl(join(artifactDir, "Reviewer.jsonl"), [
    JSON.stringify({ id: "w1", type: "session" }),
    JSON.stringify({ id: "w2", type: "message", message: { role: "assistant", model: "model-b", usage: { input: 4, output: 1, cacheRead: 8, cacheWrite: 0, totalTokens: 13, reasoningTokens: 0 } } }),
  ]);
  writeJsonl(join(artifactDir, "Planner.jsonl"), [JSON.stringify({ id: "p1", type: "session" })]);
  writeJsonl(join(artifactDir, "__advisor.jsonl"), [JSON.stringify({ type: "advisor" })]);

  const totals = summarizeSessionFile(sessionFile);
  assert.deepEqual(totals.combined, { input: 14, output: 6, cacheRead: 28, cacheWrite: 2, totalTokens: 50, reasoningTokens: 0 });
  assert.equal(totals.cacheHitRate, 28 / 42);
  assert.equal(totals.peakWindowTokens, 37);
  assert.equal(totals.toolCalls, 1);
  assert.equal(totals.toolErrors, 0);
  assert.equal(totals.subagentSpawns, 2);
  assert.deepEqual(totals.workers, {
    Reviewer: { input: 4, output: 1, cacheRead: 8, cacheWrite: 0, totalTokens: 13, reasoningTokens: 0 },
    Planner: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 },
  });
});

test("summarizeSessionFile ignores missing artifact dir and missing session file", () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "session.jsonl"), [JSON.stringify({ id: "s1", type: "session" })]);
  const totals = summarizeSessionFile(sessionFile);
  assert.deepEqual(totals.workers, {});
  assert.equal(totals.combined.totalTokens, 0);

  const missing = summarizeSessionFile(join(tmpDir(), "does-not-exist.jsonl"));
  const zeroed: SessionTotals = {
    main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 },
    workers: {},
    combined: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 },
    cacheHitRate: 0,
    peakWindowTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    subagentSpawns: 0,
  };
  assert.deepEqual(missing, zeroed);
});

test("harness_record backfills tokens and writes sessionTelemetry when OMP_SESSION_FILE is set", async () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "session.jsonl"), [
    JSON.stringify({ id: "s1", type: "session" }),
    JSON.stringify({ id: "m1", type: "message", message: { role: "assistant", model: "model-a", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37, reasoningTokens: 0 } } }),
  ]);
  const dir = tmpDir();

  const prev = process.env.OMP_SESSION_FILE;
  process.env.OMP_SESSION_FILE = sessionFile;
  try {
    const pi = mountTools();
    await harnessRecord(pi, dir, { tier: "S", goal: "g", acceptance: [], models: [], tokens: 0, wall_ms: 0 });
    const outcome = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")) as { tokens: number; wall_ms: number; sessionTelemetry?: SessionTotals };
    assert.equal(outcome.tokens, 37);
    assert.ok(outcome.sessionTelemetry);
    assert.equal(outcome.sessionTelemetry!.combined.totalTokens, 37);
    assert.equal(outcome.sessionTelemetry!.peakWindowTokens, 37);
  } finally {
    if (prev === undefined) delete process.env.OMP_SESSION_FILE;
    else process.env.OMP_SESSION_FILE = prev;
  }
});

test("harness_record includes sessionTelemetry when OMP_SESSION_FILE is set even with positive tokens and wall_ms", async () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "session.jsonl"), [
    JSON.stringify({ id: "s1", type: "session" }),
    JSON.stringify({ id: "m1", type: "message", message: { role: "assistant", model: "model-a", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37, reasoningTokens: 0 } } }),
  ]);
  const dir = tmpDir();

  const prev = process.env.OMP_SESSION_FILE;
  process.env.OMP_SESSION_FILE = sessionFile;
  try {
    const pi = mountTools();
    await harnessRecord(pi, dir, { tier: "S", goal: "g", acceptance: [], models: [], tokens: 1000, wall_ms: 5000 });
    const outcome = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")) as { tokens: number; wall_ms: number; sessionTelemetry?: SessionTotals };
    assert.equal(outcome.tokens, 1000);
    assert.equal(outcome.wall_ms, 5000);
    assert.ok(outcome.sessionTelemetry);
    assert.equal(outcome.sessionTelemetry!.combined.totalTokens, 37);
  } finally {
    if (prev === undefined) delete process.env.OMP_SESSION_FILE;
    else process.env.OMP_SESSION_FILE = prev;
  }
});

test("harness_record preserves fields unchanged when tokens and wall_ms are positive and no session file is set", async () => {
  const dir = tmpDir();
  const prev = process.env.OMP_SESSION_FILE;
  delete process.env.OMP_SESSION_FILE;
  try {
    const pi = mountTools();
    await harnessRecord(pi, dir, { tier: "S", goal: "g", acceptance: [], models: [], tokens: 1000, wall_ms: 5000 });
    const outcome = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")) as { tokens: number; wall_ms: number; sessionTelemetry?: unknown };
    assert.equal(outcome.tokens, 1000);
    assert.equal(outcome.wall_ms, 5000);
  } finally {
    if (prev === undefined) delete process.env.OMP_SESSION_FILE;
    else process.env.OMP_SESSION_FILE = prev;
  }
});

// ---------------------------------------------------------------------------
// F-05: vibe_spawn spawn counting + sessionTotals worker spawn sum
// ---------------------------------------------------------------------------

test("sessionTotals counts vibe_spawn spawn entries in main", () => {
  const main = [
    { id: "s1", type: "session" },
    { id: "sp1", type: "spawn", parentId: "s1", name: "task" },
    {
      id: "m1",
      type: "message",
      parentId: "sp1",
      message: {
        role: "assistant",
        model: "model-a",
        content: [{ type: "toolCall", id: "c1", name: "vibe_spawn" }],
      },
    },
    { id: "sp2", type: "spawn", parentId: "m1", name: "vibe_spawn" },
  ];
  const totals = sessionTotals(main);
  assert.equal(totals.subagentSpawns, 3);
});

test("sessionTotals sums worker spawns into subagentSpawns", () => {
  const main = [{ id: "s1", type: "session" }];
  const workers = {
    Reviewer: [
      { id: "ws1", type: "session" },
      { id: "wp1", type: "spawn", parentId: "ws1", name: "vibe_spawn" },
      { id: "wp2", type: "spawn", parentId: "ws1", name: "vibe_spawn" },
    ],
  };
  const totals = sessionTotals(main, workers);
  assert.equal(totals.subagentSpawns, 2);
});

// ---------------------------------------------------------------------------
// F-06: resolveSessionFile resolution precedence
// ---------------------------------------------------------------------------

test("resolveSessionFile returns explicit path when it exists", () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "session.jsonl"), [JSON.stringify({ id: "s1", type: "session" })]);
  assert.equal(resolveSessionFile(sessionFile, root), sessionFile);
});

test("resolveSessionFile falls back to OMP_SESSION_FILE env when it exists", () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "env-session.jsonl"), [JSON.stringify({ id: "s1", type: "session" })]);
  const prev = process.env.OMP_SESSION_FILE;
  process.env.OMP_SESSION_FILE = sessionFile;
  try {
    assert.equal(resolveSessionFile(undefined, root), sessionFile);
  } finally {
    if (prev === undefined) delete process.env.OMP_SESSION_FILE;
    else process.env.OMP_SESSION_FILE = prev;
  }
});

test("resolveSessionFile returns empty string when nothing exists", () => {
  assert.equal(resolveSessionFile("/absolutely/does/not/exist.jsonl", tmpDir()), "");
});

// ---------------------------------------------------------------------------
// F-06: harness_record resolves session file via ctx.sessionManager
// ---------------------------------------------------------------------------

test("harness_record uses ctx sessionManager.getSessionFile when set", async () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "ctx-session.jsonl"), [
    JSON.stringify({ id: "s1", type: "session" }),
    JSON.stringify({ id: "m1", type: "message", message: { role: "assistant", model: "model-a", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37, reasoningTokens: 0 } } }),
  ]);
  const dir = tmpDir();

  const pi = mountTools();
  const def = pi.tools.get("harness_record");
  assert.ok(def, "harness_record tool not registered");
  const exe = def as { execute: (id: string, params: Record<string, unknown>, _s: unknown, _u: unknown, ctx: unknown) => Promise<unknown> };
  await exe.execute("rec-1", { ...{ tier: "S", goal: "g", acceptance: [], models: [], tokens: 0, wall_ms: 0 }, dir }, undefined, undefined, {
    sessionManager: { getSessionFile: () => sessionFile },
  });

  const outcome = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")) as { tokens: number; sessionTelemetry?: SessionTotals };
  assert.equal(outcome.tokens, 37);
  assert.ok(outcome.sessionTelemetry);
  assert.equal(outcome.sessionTelemetry!.combined.totalTokens, 37);
});

test("harness_record omits sessionTelemetry when all totals are zero", async () => {
  const root = tmpDir();
  const sessionFile = writeJsonl(join(root, "empty-session.jsonl"), [JSON.stringify({ id: "s1", type: "session" })]);
  const dir = tmpDir();

  const pi = mountTools();
  const def = pi.tools.get("harness_record");
  const exe = def as { execute: (id: string, params: Record<string, unknown>, _s: unknown, _u: unknown, ctx: unknown) => Promise<unknown> };
  await exe.execute("rec-1", { ...{ tier: "S", goal: "g", acceptance: [], models: [], tokens: 0, wall_ms: 0 }, dir }, undefined, undefined, {
    sessionManager: { getSessionFile: () => sessionFile },
  });

  const outcome = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")) as { tokens: number; sessionTelemetry?: SessionTotals };
  assert.equal(outcome.tokens, 0);
  assert.equal(outcome.sessionTelemetry, undefined);
});

// ---------------------------------------------------------------------------
// S6: computeAcceptedTaskCost
// ---------------------------------------------------------------------------

test("computeAcceptedTaskCost is UNDEFINED when acceptedCount is 0", () => {
  const out = computeAcceptedTaskCost([
    { accepted: false, costUsd: 1, billingKind: "per-token" },
    { accepted: false, costUsd: 2, billingKind: "per-token" },
  ]);
  assert.equal(out.status, "UNDEFINED");
  assert.equal(out.acceptedCount, 0);
  assert.equal(out.totalAttempts, 2);
  assert.equal(out.totalTokenCostUsd, null);
  assert.equal(out.costPerAcceptedUsd, null);
});

test("computeAcceptedTaskCost is UNKNOWN when token-billed costUsd is null", () => {
  const out = computeAcceptedTaskCost([
    { accepted: true, costUsd: null, billingKind: "per-token" },
  ]);
  assert.equal(out.status, "UNKNOWN");
  assert.equal(out.acceptedCount, 1);
  assert.equal(out.totalTokenCostUsd, null);
});

test("computeAcceptedTaskCost includes failed attempts in the numerator (totalAttempts)", () => {
  const out = computeAcceptedTaskCost([
    { accepted: true, costUsd: 10, billingKind: "per-token" },
    { accepted: false, costUsd: 4, billingKind: "per-token" },
    { accepted: true, costUsd: 6, billingKind: "per-token" },
  ]);
  assert.equal(out.status, "OK");
  assert.equal(out.acceptedCount, 2);
  assert.equal(out.totalAttempts, 3);
  assert.equal(out.totalTokenCostUsd, 20);
  assert.equal(out.costPerAcceptedUsd, 10);
});

test("computeAcceptedTaskCost separates perRequestCalls from totalTokenCostUsd", () => {
  const out = computeAcceptedTaskCost([
    { accepted: true, costUsd: 10, billingKind: "per-token" },
    { accepted: true, costUsd: null, billingKind: "per-request", requests: 3 },
  ]);
  assert.equal(out.status, "UNKNOWN");
  assert.equal(out.acceptedCount, 2);
  assert.equal(out.totalTokenCostUsd, null);
});

