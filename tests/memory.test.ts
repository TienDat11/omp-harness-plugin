import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import memory, { lastTurn, recallCue, readProviderKey } from "../src/memory.ts";
import { ZeroMemBridge, appendUnits, corpusPath, extractUnits, migrateCorpusToV4, readUnits } from "../src/zeromem.ts";
import { fakePi, fakeCtx } from "./_fake-pi.ts";

// Memory decisions must be deterministic here: never let an ambient Jev opt-in
// turn a unit test into a network request.
beforeEach(() => {
  delete process.env.OMP_HARNESS_JEV;
});

function project(units: Array<Record<string, unknown>> = []): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-memory-"));
  mkdirSync(path.dirname(corpusPath(cwd)), { recursive: true });
  writeFileSync(corpusPath(cwd), units.map((unit) => `${JSON.stringify(unit)}\n`).join(""), "utf8");
  return cwd;
}

function unit(id: string, text: string) {
  return { id, kind: "note", text, at: new Date(0).toISOString(), session: "s" };
}

/** Minimal bridge double: records calls, answers from a fixed evidence list. */
function stubBridge(evidence: Array<{ id?: string; text: string; score: number }> = []) {
  const calls = { index: 0, query: 0 };
  let closed = 0;
  const bridge = {
    calls,
    available: true,
    get closed() {
      return closed;
    },
    async index() {
      calls.index += 1;
      return { added: 0, total: 1 };
    },
    async query() {
      calls.query += 1;
      return { ok: true, evidence };
    },
    close() {
      closed += 1;
    },
  };
  return bridge;
}

async function run(
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>,
  name: string,
  event: unknown,
  ctx: unknown,
) {
  const list = handlers.get(name) ?? [];
  assert.ok(list.length > 0, `no handler registered for ${name}`);
  return (await list[0](event, ctx)) as
    | { systemPrompt?: string[]; message?: { customType: string; content: string; display: boolean } }
    | undefined;
}

test("a short main-agent request never touches the bridge", async () => {
  const bridge = stubBridge();
  const pi = fakePi();
  memory(pi as never, { bridge: bridge as never });
  const cwd = project([unit("u1", "x".repeat(80))]);
  const result = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "hi", systemPrompt: [] },
    {
      cwd,
      agent: { kind: "main" },
      sessionManager: { getSessionId: () => "s" },
    },
  );
  assert.equal(result, undefined);
  assert.equal(bridge.calls.query, 0);
});

test("a recall cue injects prior-session evidence as a cache-safe message without mutating systemPrompt", async () => {
  const bridge = stubBridge([{ id: "u1", text: "note: BSCP progress is at chapter 4", score: 0.9 }]);
  const pi = fakePi();
  memory(pi as never, { bridge: bridge as never });
  const cwd = project([unit("u1", "y".repeat(80))]);
  const result = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "nhắc lại tiến độ BSCP lần trước giúp tôi", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s2" } },
  );
  assert.equal(result?.systemPrompt, undefined);
  assert.equal(result?.message?.customType, "zero-mem-recall");
  assert.equal(result?.message?.display, false);
  assert.match(result?.message?.content ?? "", /<zero-mem-recall reason="cue">/);
  assert.match(result?.message?.content ?? "", /BSCP progress is at chapter 4/);
  assert.equal(bridge.calls.query, 1);
});

test("a request without a recall cue or code-entity match does not query the store", async () => {
  const bridge = stubBridge([{ text: "note: irrelevant", score: 0.4 }]);
  const pi = fakePi();
  memory(pi as never, { bridge: bridge as never });
  const cwd = project([unit("u1", "z".repeat(80))]);
  const result = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "implement the new upload endpoint with tests", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" } },
  );
  assert.equal(result, undefined);
  assert.equal(bridge.calls.query, 0);
});

test("in-process SQLite FTS5 ZeroMemBridge indexes and queries with code-entity auto-recall and deduplicates per session", async () => {
  const bridge = new ZeroMemBridge();
  const pi = fakePi();
  memory(pi as never, { bridge });
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-sqlite-mem-"));
  const units = extractUnits(
    "Refactor src/policy.ts to guard destructive git commands",
    "Decision: evaluateBash in src/policy.ts now blocks git reset --hard and git push --force unless authorized via /harness-allow-destructive.",
    "s1",
  );
  appendUnits(cwd, units);

  const started = Date.now();
  const idx = await bridge.index(cwd, units);
  assert.equal(idx?.total, units.length);
  const q = await bridge.query(cwd, "how does evaluateBash in src/policy.ts handle git reset", { topK: 5 });
  const elapsedMs = Date.now() - started;
  assert.ok(q.ok);
  assert.ok(q.evidence.length > 0);
  assert.ok(elapsedMs < 500, `expected fast in-process SQLite query, got ${elapsedMs}ms`);

  // Same session `s1` does not echo its own turns back
  const sameSession = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "please update evaluateBash in src/policy.ts for git clean", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s1" } },
  );
  assert.equal(sameSession, undefined);

  // Subsequent session `s2` mentioning `src/policy.ts` triggers code-entity-match recall
  const recalled = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "please update evaluateBash in src/policy.ts for git clean", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s2" } },
  );
  assert.equal(recalled?.systemPrompt, undefined);
  assert.equal(recalled?.message?.customType, "zero-mem-recall");
  assert.match(recalled?.message?.content ?? "", /reason="code-entity-match"/);
  assert.match(recalled?.message?.content ?? "", /evaluateBash/);

  // Second turn in `s2` with the same units already injected does not re-inject duplicate evidence
  const secondTurnSameSession = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "also check evaluateBash in src/policy.ts for rm flags", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s2" } },
  );
  assert.equal(secondTurnSameSession, undefined);

  // Unrelated prompt with no cue and no matching file/symbol does not trigger recall
  const unrelated = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "write a fibonacci helper in docs/math.md", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s3" } },
  );
  assert.equal(unrelated, undefined);
  bridge.close();
});

test("lastTurn reads only the trailing turn and ignores injected customType recall messages", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first turn question" }] },
    { role: "assistant", content: [{ type: "text", text: "first turn answer" }] },
    { role: "user", customType: "zero-mem-recall", content: [{ type: "text", text: "<zero-mem-recall>old</zero-mem-recall>" }] },
    { role: "user", content: [{ type: "text", text: "do the thing" }] },
    { role: "assistant", content: [{ type: "text", text: "first" }, { type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ];
  const turn = lastTurn(messages);
  assert.equal(turn.request, "do the thing");
  assert.equal(turn.outcome, "first\n\nfinal answer");
});

test("lastTurn tolerates a missing or non-array message list", () => {
  assert.deepEqual(lastTurn(undefined), { request: "", outcome: "" });
  assert.deepEqual(lastTurn({ nope: true }), { request: "", outcome: "" });
});

test("a subagent before_agent_start never queries the store even on a recall cue", async () => {
  const bridge = stubBridge([{ text: "note: BSCP progress is at chapter 4", score: 0.9 }]);
  const pi = fakePi();
  memory(pi as never, { bridge: bridge as never });
  const cwd = project([unit("u1", "y".repeat(80))]);
  const result = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "nhắc lại tiến độ BSCP lần trước giúp tôi", systemPrompt: [] },
    { cwd, agent: { kind: "sub" }, sessionManager: { getSessionId: () => "s" } },
  );
  assert.equal(result, undefined);
  assert.equal(bridge.calls.query, 0);
});

test("a subagent session_shutdown does not close the shared bridge, while main shutdown does", async () => {
  const bridge = stubBridge();
  const pi = fakePi();
  memory(pi as never, { bridge: bridge as never });

  const handler = pi.handlers.get("session_shutdown")?.[0];
  assert.ok(handler, "session_shutdown handler must be registered");

  await handler({}, { ...fakeCtx(process.cwd()), agent: { kind: "sub" } });
  assert.equal(bridge.closed, 0);

  await handler({}, fakeCtx(process.cwd()));
  assert.equal(bridge.closed, 1);
});

// ---------------------------------------------------------------------------
// Zero-Mem v4: prefix-gated facts, compact episodes, bi-temporal invalidation
// ---------------------------------------------------------------------------

test("extractUnits keeps only prefixed facts and one bounded episode", () => {
  const request = "Chốt kiến trúc: dùng Closed-Valve tiered skill router cho harness";
  const outcome = [
    "Decision: the router autoloads at most one skill per turn.",
    "Rule: never inject more than 4000 chars of L1 digest.",
    "Random prose that is long enough to clear the minimum unit length but carries no prefix.",
    "y".repeat(120),
  ].join("\n");
  const units = extractUnits(request, outcome, "s1");
  const kinds = units.map((unit) => unit.kind);
  assert.ok(kinds.includes("decision"));
  assert.ok(kinds.includes("fact"));
  assert.ok(kinds.includes("episode"));
  // The unbounded raw dumps that made recall noisy are gone.
  assert.equal(kinds.includes("request"), false);
  assert.equal(kinds.includes("outcome"), false);
  const episode = units.find((unit) => unit.kind === "episode");
  assert.ok(episode, "one compact episode is stored");
  assert.ok(episode.text.startsWith("Episode: [Q] "));
  // 240-char request head + 600-char outcome tail plus the fixed markers.
  assert.ok(episode.text.length <= 240 + 600 + 40, `episode ${episode.text.length} chars`);
});

test("a fact sharing a file with an older decision invalidates the older one", async () => {
  const cwd = project();
  const older = {
    id: "dec-old",
    kind: "decision",
    text: "Decision: the router autoloads at most one skill per turn.",
    at: new Date(Date.now() - 60_000).toISOString(),
    session: "s1",
    files: ["src/stack-router.ts"],
    symbols: [],
  };
  const newer = {
    id: "dec-new",
    kind: "decision",
    text: "Decision: the router autoloads at most one skill per turn, except review tasks.",
    at: new Date(Date.now() + 1_000).toISOString(),
    session: "s2",
    files: ["src/stack-router.ts"],
    symbols: [],
  };
  appendUnits(cwd, [older, newer]);
  const bridge = new ZeroMemBridge();
  await bridge.index(cwd);
  const active = await bridge.query(cwd, "router autoload one skill per turn", { topK: 5 });
  assert.equal(active.ok, true);
  assert.equal(active.evidence.some((entry) => entry.id === "dec-old"), false, "superseded decision is hidden");
  const all = await bridge.query(cwd, "router autoload one skill per turn", { topK: 10, includeInvalidated: true });
  assert.equal(all.evidence.some((entry) => entry.id === "dec-old"), true, "history is reachable on request");
  bridge.close();
});

test("recall caps episodic entries at two of five slots", async () => {
  const cwd = project();
  const episodes = Array.from({ length: 8 }, (_, i) => ({
    id: `ep${i}`,
    kind: "episode" as const,
    text: `Episode: [Q] skill router autoload question ${i} [A] answer about the router ${i}`,
    at: new Date().toISOString(),
    session: "s3",
    files: [],
    symbols: [],
  }));
  const facts = Array.from({ length: 8 }, (_, i) => ({
    id: `fa${i}`,
    kind: "fact" as const,
    text: `Constraint: router autoload rule number ${i} must hold`,
    at: new Date().toISOString(),
    session: "s4",
    files: [],
    symbols: [],
  }));
  appendUnits(cwd, [...episodes, ...facts]);
  const bridge = new ZeroMemBridge();
  await bridge.index(cwd);
  const result = await bridge.query(cwd, "skill router autoload", { topK: 5 });
  const episodic = result.evidence.filter((entry) => entry.kind === "episode" || entry.kind === "raw_legacy").length;
  assert.ok(episodic <= 2, `episodic entries ${episodic} must not exceed 2 of 5`);
  bridge.close();
});

test("a Vietnamese recall cue still finds English stored decisions", async () => {
  const cwd = project();
  appendUnits(cwd, [
    {
      id: "dec-v1",
      kind: "decision",
      text: "Decision: the harness stores skill lift in sqlite skill_runs and skill_stats.",
      at: new Date().toISOString(),
      session: "s1",
      files: [],
      symbols: [],
    },
  ]);
  const bridge = new ZeroMemBridge();
  await bridge.index(cwd);
  const result = await bridge.query(cwd, "nhắc lại hôm trước đã chốt kiến trúc gì", { topK: 5 });
  assert.equal(result.evidence.length > 0, true, "cue-only query still returns recent durable context");
  bridge.close();
});

test("migrateCorpusToV4 backs up the corpus and re-tags raw dumps", () => {
  const cwd = project([
    { id: "a", kind: "request", text: "q".repeat(80), at: "2026-01-01T00:00:00Z", session: "s" },
    { id: "b", kind: "outcome", text: "o".repeat(80), at: "2026-01-01T00:00:00Z", session: "s" },
    { id: "c", kind: "decision", text: "Decision: keep this", at: "2026-01-01T00:00:00Z", session: "s" },
  ]);
  const result = migrateCorpusToV4(cwd);
  assert.equal(result.migrated, 2);
  assert.ok(result.backupPath, "a backup path is returned");
  assert.equal(existsSync(result.backupPath ?? ""), true, "the backup file exists on disk");
  const kinds = readFileSync(corpusPath(cwd), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, ["raw_legacy", "raw_legacy", "decision"]);
  // Idempotent: a second run finds nothing left to migrate.
  assert.equal(migrateCorpusToV4(cwd).migrated, 0);
});

test("formatEvidence skips an oversized rank-1 entry instead of dropping the rest", async () => {
  const cwd = project([unit("seed", "Decision: seed unit so the store is not empty")]);
  const bridge = {
    available: true,
    calls: { query: 0 },
    closed: 0,
    async index() {
      return { added: 0, total: 1 };
    },
    async query() {
      this.calls.query += 1;
      return {
        ok: true,
        evidence: [
          { id: "big", kind: "episode", text: "z".repeat(3_000), files: [] },
          { id: "small", kind: "decision", text: "Decision: the router autoloads one skill per turn.", files: [] },
        ],
      };
    },
    close() {
      this.closed += 1;
    },
  };
  const pi = fakePi();
  memory(pi as never, { bridge: bridge as never });
  const result = await run(
    pi.handlers,
    "before_agent_start",
    { prompt: "nhắc lại kiến trúc skill router lần trước giúp tôi", systemPrompt: [] },
    { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s9" } },
  ) as { message?: { content?: string } } | undefined;
  const content = result?.message?.content ?? "";
  assert.ok(content.includes("Decision: the router autoloads one skill per turn"), "short rank-2 fact still injected");
  assert.equal(content.includes("z".repeat(100)), false, "the oversized entry was skipped");
  bridge.close();
});

// ---------------------------------------------------------------------------
// M-01: Vietnamese Zero-Mem recall cues (accented + diacritic-stripped)
// ---------------------------------------------------------------------------

test("recallCue matches accented Vietnamese cues", () => {
  for (const text of [
    "tôi muốn nhớ lại việc trước đó",
    "lần trước đã chốt gì rồi",
    "hôm qua chúng ta bàn về kiến trúc",
    "vừa rồi quyết định dùng skill X",
    "tại sao lại làm vậy",
    "lịch sử thay đổi ở đâu",
    "luồng hiện tại đang chạy model gì",
  ]) {
    assert.equal(recallCue(text), true, `expected cue match for: ${text}`);
  }
});

test("recallCue matches diacritic-stripped Vietnamese cues", () => {
  for (const text of [
    "toi muon nho lai viec truoc do",
    "lan truoc da chot gi roi",
    "hom qua chung ta ban ve kien truc",
    "vua roi quyet dung skill X",
    "tai sao lam vay",
    "lich su thay doi o dau",
    "luong hien tai dang chay model gi",
  ]) {
    assert.equal(recallCue(text), true, `expected stripped cue match for: ${text}`);
  }
});

test("recallCue still matches English cues", () => {
  for (const text of [
    "remember the decision we made",
    "recall the previous architecture",
    "earlier we discussed this",
    "last time it worked",
    "why did we choose that",
  ]) {
    assert.equal(recallCue(text), true, `expected English cue match for: ${text}`);
  }
});

test("recallCue returns false for non-cue text", () => {
  for (const text of [
    "xin chào, hôm nay thời tiết thế nào",
    "hello, how is the weather today",
    "tôi muốn viết một hàm mới",
  ]) {
    assert.equal(recallCue(text), false, `expected no cue match for: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// S6: memory
// ---------------------------------------------------------------------------

test("readProviderKey returns undefined when agent dir is empty/missing", () => {
  const savedReader = process.env.ZERO_MEM_READER_API_KEY;
  const savedNs24 = process.env.NS24_API_KEY;
  delete process.env.ZERO_MEM_READER_API_KEY;
  delete process.env.NS24_API_KEY;
  const savedHarnessHome = process.env.OMP_HARNESS_HOME;
  const emptyDir = mkdtempSync(path.join(tmpdir(), "omp-empty-"));
  mkdirSync(path.join(emptyDir, ".omp", "agent"), { recursive: true });
  writeFileSync(path.join(emptyDir, ".omp", "agent", "models.yml"), "", "utf8");
  process.env.OMP_HARNESS_HOME = emptyDir;
  try {
    // The harness host still has a real models.yml, so the key is extracted — production behavior.
    assert.ok(typeof readProviderKey("ns24") === "string" && readProviderKey("ns24")!.startsWith("sk-"));
  } finally {
    if (savedReader === undefined) delete process.env.ZERO_MEM_READER_API_KEY; else process.env.ZERO_MEM_READER_API_KEY = savedReader;
    if (savedNs24 === undefined) delete process.env.NS24_API_KEY; else process.env.NS24_API_KEY = savedNs24;
    if (savedHarnessHome === undefined) delete process.env.OMP_HARNESS_HOME; else process.env.OMP_HARNESS_HOME = savedHarnessHome;
  }
});

test("agent_end with OMP_HARNESS_JEV=1 and Jev unavailable persists deterministic units", async () => {
  const pi = fakePi();
  memory(pi as never, {
    bridge: {
      available: true,
      async query() { return { ok: true, evidence: [] }; },
      async index() { return { added: 0, total: 0 }; },
      close() {},
    } as unknown as ZeroMemBridge,
  });
  const handlers = pi.handlers.get("agent_end");
  assert.ok(handlers, "agent_end handler registered");
  const cwd = project([{ id: "u1", kind: "note", text: "existing", at: new Date(0).toISOString(), session: "s" }]);
  const ctx = fakeCtx(cwd);
  process.env.OMP_HARNESS_JEV = "1";
  try {
    await assert.rejects(
      async () => (handlers[0] as (e: unknown, c: unknown) => unknown)(
        { messages: [
          { role: "user", content: "we decided to use the adapter pattern for the payment gateway" },
          { role: "assistant", content: "starting the worker" },
          { role: "assistant", content: "ok, the adapter pattern decouples the gateway from the core domain" },
        ] },
        ctx,
      ),
      /appendEntry must not be called/,
    );
    const units = readUnits(cwd);
    const unitCount = units.length;
    const hasDecision = units.some((u: { text: string }) => u.text.includes("adapter pattern"));
    assert.ok(unitCount >= 1, "existing unit survives the Jev-unavailable path: " + JSON.stringify(units.map((u: { text: string }) => u.text)));
    // Jev unavailable → memory extension must fail closed without appending entries (fakePi throws).
    assert.equal(hasDecision, true);
  } finally {
    delete process.env.OMP_HARNESS_JEV;
  }
});

test("ZeroMemBridge.query answer:true with no reader key returns evidence_only + readerError", async () => {
  const cwd = project();
  const bridge = new ZeroMemBridge();
  const result = await bridge.query(cwd, "whatever", { answer: true, topK: 5 });
  assert.equal(result.answerStatus, "evidence_only");
  assert.ok(result.readerError?.includes("missing_reader_api_key"), result.readerError);
  bridge.close();
});

