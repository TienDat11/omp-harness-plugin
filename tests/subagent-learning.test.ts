import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillTelemetryStore, getSkillTelemetryStore, closeSkillTelemetryStores,
  parentArmId, directionArmId, dispatchId, observationId, failureKey,
  normalizeScope, validateCandidateEnvelope, hashId, klUcbIndex, evaluateAssessment,
  applyFailureCooldown, pruneExpiredCooldowns, capCards,
  applyEvaluationToState, getSubagentPolicyMemory,
  evaluationOperationId, assessmentHash, subagentSessionKey,
  type Assessment, type Trace, type LearningStateJSON, type CommitBatchInput,
} from "../src/skill-telemetry.ts";
import { writeTextFileAtomic } from "../src/state.ts";
import { createSuperagent } from "../src/superagent.ts";
import tools from "../src/tools.ts";
import { fakePi, fakeCtx, type FakeToolDef } from "./_fake-pi.ts";

function tempCwd(): string { return mkdtempSync(join(tmpdir(), "learn-")); }
function dbPathFor(cwd: string): string {
  mkdirSync(join(cwd, ".omp/harness"), { recursive: true });
  return join(cwd, ".omp/harness/skill-telemetry.db");
}
function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  db.close();
  return rows.map((r) => r.name);
}

test("F1: new DB has existing and three learning tables, seeded generation 0", () => {
  const dbPath = dbPathFor(tempCwd());
  const store = new SkillTelemetryStore(dbPath);
  store.close();
  const names = tableNames(dbPath);
  for (const t of ["skill_runs", "skill_stats", "dispatch_traces", "observations", "learning_state"]) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  const reopened = new SkillTelemetryStore(dbPath);
  reopened.close();
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT generation FROM learning_state WHERE id=1").get() as { generation: number };
  assert.equal(row.generation, 0);
  db.close();
});

test("F1: reopen keeps existing state; corrupt row throws and is not reseeded", () => {
  const dbPath = dbPathFor(tempCwd());
  new SkillTelemetryStore(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE learning_state SET generation=5, payload_json=? WHERE id=1").run('{"generation":5,"arms":{},"opportunityCounters":{},"cooldowns":{},"cards":[],"memory":{"lessons":[],"targetCatalog":[]}}');
  raw.close();
  const s = new SkillTelemetryStore(dbPath);
  assert.equal((s as any).readLearningStateRow().generation, 5);
  s.close();
  const bad = new DatabaseSync(dbPath);
  bad.prepare("UPDATE learning_state SET payload_json='{not json' WHERE id=1").run();
  bad.close();
  const s2 = new SkillTelemetryStore(dbPath);
  assert.throws(() => (s2 as any).readLearningStateRow(), /learning_state corrupt/);
  s2.close();
  const chk = new DatabaseSync(dbPath);
  assert.equal((chk.prepare("SELECT payload_json p FROM learning_state WHERE id=1").get() as { p: string }).p, "{not json");
  chk.close();
});

test("F1: reopen with generation column differing from payload generation throws", () => {
  const dbPath = dbPathFor(tempCwd());
  new SkillTelemetryStore(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE learning_state SET generation=7, payload_json=? WHERE id=1").run('{"generation":5,"arms":{},"opportunityCounters":{},"cooldowns":{},"cards":[],"memory":{"lessons":[],"targetCatalog":[]}}');
  raw.close();
  const s = new SkillTelemetryStore(dbPath);
  assert.throws(() => (s as any).readLearningStateRow());
  s.close();
});

test("cache returns one shared instance per canonical cwd", () => {
  const cwd = tempCwd();
  const a = getSkillTelemetryStore(cwd);
  const b = getSkillTelemetryStore(join(cwd, "."));
  assert.ok(a);
  assert.equal(a, b);
  closeSkillTelemetryStores();
});

test("constructor failure returns null and is not cached", () => {
  const bad = join(tempCwd(), "file-not-dir");
  writeFileSync(bad, "x");
  assert.equal(getSkillTelemetryStore(bad), null);
  assert.equal(getSkillTelemetryStore(bad), null); // retried, not cached
  closeSkillTelemetryStores();
});

test("closeSkillTelemetryStores closes and clears; reopen works", () => {
  const cwd = tempCwd();
  const first = getSkillTelemetryStore(cwd);
  closeSkillTelemetryStores();
  const second = getSkillTelemetryStore(cwd);
  assert.notEqual(first, second);
  assert.ok(second);
  closeSkillTelemetryStores();
});

const okEnvelope = {
  version: 1,
  goalId: "g1",
  candidates: [
    { parentId: null, directionId: "d1", mechanism: "m1", change: "c1", scope: ["a.ts"], prompt: "do one" },
    { parentId: "p1", directionId: "d2", mechanism: "m2", change: "c2", scope: ["b.ts"], prompt: "do two" },
  ],
};
function withDuplicatePair(e: typeof okEnvelope) {
  return { ...e, candidates: [e.candidates[0], { ...e.candidates[0], mechanism: "other" }] };
}
function withPrompt(e: typeof okEnvelope, prompt: string) {
  return { ...e, candidates: [{ ...e.candidates[0], prompt }, e.candidates[1]] };
}
function withScope(e: typeof okEnvelope, n: number) {
  return { ...e, candidates: [{ ...e.candidates[0], scope: Array.from({ length: n }, (_, i) => `f${i}.ts`) }, e.candidates[1]] };
}

test("arm IDs are stable and null parent is a valid arm", () => {
  const a = parentArmId("g1", null);
  assert.equal(a, parentArmId("g1", null));
  assert.notEqual(a, parentArmId("g1", "p1"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(directionArmId("g1", null, "d"), directionArmId("g1", "p1", "d"));
  assert.notEqual(parentArmId("g1", "p1"), directionArmId("g1", "p1", "d"));
});

test("hashId is SHA-256 of JSON array; other ID domains differ", () => {
  assert.equal(hashId(["x", 1]), hashId(["x", 1]));
  assert.notEqual(hashId(["x", 1]), hashId(["x", "1"]));
  const d = dispatchId("s", "t", 0);
  assert.notEqual(d, dispatchId("s", "t", 1));
  const arm = parentArmId("g", null);
  assert.notEqual(observationId(d, "parent", arm), observationId(d, "direction", arm));
  const k = failureKey("g", null, "d", "m", "c", ["b.ts", "a.ts", "a.ts"]);
  assert.equal(k, failureKey("g", null, "d", "m", "c", ["a.ts", "b.ts"]));
});

test("ID functions match independently computed SHA-256 vectors", () => {
  const sha = (json: string) => createHash("sha256").update(json, "utf8").digest("hex");
  assert.equal(parentArmId("g1", null), sha('["parent-v1","g1",null]'));
  assert.equal(parentArmId("g1", "p1"), sha('["parent-v1","g1","p1"]'));
  assert.equal(directionArmId("g1", "p1", "d1"), sha('["arm-v1","g1","p1","d1"]'));
  assert.equal(directionArmId("g1", null, "d1"), sha('["arm-v1","g1",null,"d1"]'));
  assert.equal(dispatchId("s1", "t1", 2), sha('["dispatch-v1","s1","t1",2]'));
  const arm = parentArmId("g1", "p1");
  assert.equal(observationId("dx", "parent", arm), sha(`["observation-v1","dx","parent","${arm}"]`));
  assert.equal(
    failureKey("g1", "p1", "d1", "m", "c", ["b.ts", "./a/c.ts", "a/c.ts"]),
    sha('["failure-v1","g1","p1","d1","m","c",["a/c.ts","b.ts"]]'),
  );
  assert.equal(failureKey("g1", null, "d1", "m", "c", ["a.ts"]), sha('["failure-v1","g1",null,"d1","m","c",["a.ts"]]'));
});

test("scope normalization rejects traversal, absolute, drive and symlink-looking paths", () => {
  for (const bad of ["../x", "/abs/x", "C:/x", "C:\\x", "a/../../b", "", "x".repeat(1025)]) {
    assert.throws(() => normalizeScope([bad]), RangeError);
  }
  assert.deepEqual(normalizeScope(["b.ts", "a/c.ts", "a/c.ts"]), ["a/c.ts", "b.ts"]);
  assert.deepEqual(normalizeScope(["./a\\c.ts"]), ["a/c.ts"]);
});

test("envelope boundaries: version, count, duplicate pair, prompt length, scope count", () => {
  assert.doesNotThrow(() => validateCandidateEnvelope(okEnvelope));
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, version: 2 }), RangeError);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [] }), RangeError);
  assert.throws(() => validateCandidateEnvelope(withDuplicatePair(okEnvelope)), RangeError);
  assert.throws(() => validateCandidateEnvelope(withPrompt(okEnvelope, "x".repeat(4001))), RangeError);
  assert.throws(() => validateCandidateEnvelope(withScope(okEnvelope, 9)), RangeError);
  assert.doesNotThrow(() => validateCandidateEnvelope(withPrompt(okEnvelope, "x".repeat(4000))));
  assert.doesNotThrow(() => validateCandidateEnvelope(withScope(okEnvelope, 8)));
  const nine = { ...okEnvelope, candidates: Array.from({ length: 9 }, (_, i) => ({ ...okEnvelope.candidates[0], directionId: `d${i}` })) };
  assert.throws(() => validateCandidateEnvelope(nine), RangeError);
});

test("envelope rejects bad shapes and names the field", () => {
  assert.throws(() => validateCandidateEnvelope(null), /envelope/);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, goalId: "  " }), /goalId/);
  assert.throws(() => validateCandidateEnvelope(withPrompt(okEnvelope, "")), /prompt/);
  const c = okEnvelope.candidates[0];
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [{ ...c, parentId: "" }] }), /parentId/);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [{ ...c, parentId: 5 }] }), /parentId/);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [{ ...c, directionId: "d".repeat(513) }] }), /directionId/);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [{ ...c, mechanism: "m".repeat(513) }] }), /mechanism/);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [{ ...c, change: " " }] }), /change/);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [{ ...c, scope: ["../x"] }] }), /scope/);
});

test("validation returns normalized scope and trimmed IDs", () => {
  const env = validateCandidateEnvelope({ ...okEnvelope, goalId: " g1 ", candidates: [{ ...okEnvelope.candidates[0], directionId: " d1 ", scope: ["b.ts", "a.ts", "a.ts"] }] });
  assert.equal(env.goalId, "g1");
  assert.equal(env.candidates[0].directionId, "d1");
  assert.deepEqual(env.candidates[0].scope, ["a.ts", "b.ts"]);
});

test("prompt containing a closing envelope tag still validates as data", () => {
  const env = withPrompt(okEnvelope, "see </subagent-candidates> here");
  assert.doesNotThrow(() => validateCandidateEnvelope(env));
});

test("F2: KL-UCB values and domain checks", () => {
  assert.ok(Math.abs(klUcbIndex(0, 1, 1) - 0.704692) < 1e-5);
  assert.equal(klUcbIndex(1, 1, 1), 1);
  assert.equal(klUcbIndex(0, 0, 0), 1);
  for (const [s, n, T] of [[2, 0, 5], [0, 2, 1], [Number.NaN, 1, 1], [1, Number.POSITIVE_INFINITY, 2], [-1, 1, 1], [0.5, 1, 1]] as const) {
    assert.throws(() => klUcbIndex(s as number, n as number, T as number), RangeError);
  }
  assert.ok(klUcbIndex(8, 10, 20) > klUcbIndex(2, 10, 20));
});

// ---- Task 5: dispatch selection ----
const storePaths = new Map<SkillTelemetryStore, string>();
const storeCwds = new Map<SkillTelemetryStore, string>();
/** Test-only fault hooks (constructor option `__testHooks`, internal to the store module). */
type TestHooks = {
  afterFirstObservation?: () => void;
  beforeStateUpdate?: (db: DatabaseSync) => void;
  writeProjection?: (destination: string, content: string) => boolean;
  afterProjectionWrite?: () => void;
};
function openStore(hooks?: TestHooks, cwd: string = tempCwd()): SkillTelemetryStore {
  const dbPath = dbPathFor(cwd);
  const store = new (SkillTelemetryStore as any)(dbPath, hooks) as SkillTelemetryStore;
  storePaths.set(store, dbPath);
  storeCwds.set(store, cwd);
  return store;
}
function withRawDb<R>(store: SkillTelemetryStore, fn: (db: DatabaseSync) => R): R {
  const db = new DatabaseSync(storePaths.get(store)!);
  try { return fn(db); } finally { db.close(); }
}
function learningState(store: SkillTelemetryStore): any {
  return withRawDb(store, (db) => JSON.parse((db.prepare("SELECT payload_json p FROM learning_state WHERE id=1").get() as { p: string }).p));
}
function mutateState(store: SkillTelemetryStore, fn: (s: any) => void): void {
  withRawDb(store, (db) => {
    const s = JSON.parse((db.prepare("SELECT payload_json p FROM learning_state WHERE id=1").get() as { p: string }).p);
    fn(s);
    db.prepare("UPDATE learning_state SET payload_json=? WHERE id=1").run(JSON.stringify(s));
  });
}
function countObservations(store: SkillTelemetryStore): number {
  return withRawDb(store, (db) => (db.prepare("SELECT COUNT(*) c FROM observations").get() as { c: number }).c);
}
function countTraces(store: SkillTelemetryStore): number {
  return withRawDb(store, (db) => (db.prepare("SELECT COUNT(*) c FROM dispatch_traces").get() as { c: number }).c);
}
function spec(parentId: string | null, directionId: string) {
  return { parentId, directionId, mechanism: `m-${directionId}`, change: `c-${directionId}`, scope: ["a.ts"], prompt: `do ${directionId}` };
}
function envTwoParents() { return { version: 1 as const, goalId: "g1", candidates: [spec("p1", "d1"), spec("p2", "d1")] }; }
function envOneDirection() { return { version: 1 as const, goalId: "g1", candidates: [spec(null, "d1")] }; }
function dispatchInput(over: Record<string, unknown> = {}): any {
  return { sessionId: "s1", toolCallId: "t1", itemIndex: 0, ticketId: "tk", agent: "worker", envelope: envOneDirection(), inputHash: "h1", now: 1000, ...over };
}

test("F3: distinct parents produce distinct parentArmIds; cold tie resolves lexically", () => {
  const store = openStore();
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: envTwoParents() }));
  assert.equal(r.reason, "selected");
  assert.ok(r.selected);
  assert.notEqual(r.trace.candidates[0].parentArmId, r.trace.candidates[1].parentArmId);
  const arms = r.trace.candidates.map((c) => c.directionArmId).sort();
  assert.equal(r.selected!.directionArmId, arms[0]);
  assert.equal(r.trace.assessmentStatus, "pending");
  assert.match(r.trace.memoryRevision, /^[0-9a-f]{64}$/);
  assert.ok(r.trace.memoryText.includes(r.trace.memoryRevision));
  const again = store.prepareSubagentDispatch(dispatchInput({ toolCallId: "t2", envelope: envTwoParents() }));
  assert.equal(again.trace.candidates.length, 2);
  store.close();
});

test("selection: counters increment once per distinct parent and direction; higher parent index wins", () => {
  const store = openStore();
  const env = { version: 1 as const, goalId: "g1", candidates: [spec("p1", "d1"), spec("p1", "d2"), spec("p2", "d1")] };
  const pArm1 = parentArmId("g1", "p1");
  const pArm2 = parentArmId("g1", "p2");
  mutateState(store, (s) => { s.opportunityCounters[pArm1] = 5; s.arms[pArm1] = { successes: 0, n: 5 }; });
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: env }));
  assert.equal(r.selected!.parentArmId, pArm2); // cold parent index 1 beats failing p1
  const st = learningState(store);
  assert.equal(st.opportunityCounters[pArm1], 6);
  assert.equal(st.opportunityCounters[pArm2], 1);
  assert.equal(Object.keys(st.opportunityCounters).length, 2 + 3);
  assert.equal(st.generation, 1);
  store.close();
});

test("F5: same dispatchId and same inputHash replays without touching T or n", () => {
  const store = openStore();
  const a = store.prepareSubagentDispatch(dispatchInput({}));
  const before = learningState(store);
  const b = store.prepareSubagentDispatch(dispatchInput({}));
  assert.deepEqual(b.trace, a.trace);
  assert.equal(b.selected?.directionArmId, a.selected?.directionArmId);
  assert.deepEqual(learningState(store), before);
  assert.equal(countTraces(store), 1);
  store.close();
});

test("F5: same dispatchId with different inputHash rejects before any mutation", () => {
  const store = openStore();
  store.prepareSubagentDispatch(dispatchInput({}));
  const before = learningState(store);
  assert.throws(() => store.prepareSubagentDispatch(dispatchInput({ inputHash: "other" })), /dispatch conflict/);
  assert.deepEqual(learningState(store), before);
  store.close();
});

test("F6: all-excluded persists trace and counters, returns all_excluded, no observation", () => {
  const store = openStore();
  const dArm = directionArmId("g1", null, "d1");
  mutateState(store, (s) => { s.cooldowns[dArm] = { excludedThroughOpportunity: 100, failures: 1 }; });
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: envOneDirection() }));
  assert.equal(r.reason, "all_excluded");
  assert.equal(r.selected, null);
  assert.equal(r.trace.assessmentStatus, "not_dispatched");
  assert.equal(r.trace.selectedDirectionArmId, null);
  assert.equal(r.trace.selectedPrompt, "");
  assert.equal(countObservations(store), 0);
  assert.equal(countTraces(store), 1);
  const st = learningState(store);
  assert.equal(st.opportunityCounters[dArm], 1);
  assert.equal(st.generation, 1);
  const replay = store.prepareSubagentDispatch(dispatchInput({ envelope: envOneDirection() }));
  assert.equal(replay.reason, "all_excluded");
  assert.equal(learningState(store).opportunityCounters[dArm], 1);
  store.close();
});

test("cooldown: excluded while T <= excludedThroughOpportunity, eligible at next opportunity", () => {
  const store = openStore();
  const dArm = directionArmId("g1", null, "d1");
  mutateState(store, (s) => { s.cooldowns[dArm] = { excludedThroughOpportunity: 3, failures: 1 }; });
  const reasons = [1, 2, 3, 4].map((i) => store.prepareSubagentDispatch(dispatchInput({ toolCallId: `c${i}` })).reason);
  assert.deepEqual(reasons, ["all_excluded", "all_excluded", "all_excluded", "selected"]);
  assert.equal(learningState(store).cooldowns[dArm], undefined);
  store.close();
});

test("batch: any item all-excluded persists every item's selection and counters; none is dispatched", () => {
  const store = openStore();
  const dB = directionArmId("g1", null, "dB");
  mutateState(store, (s) => { s.cooldowns[dB] = { excludedThroughOpportunity: 100, failures: 1 }; });
  const itemA = dispatchInput({ itemIndex: 0, envelope: { version: 1, goalId: "g1", candidates: [spec(null, "dA")] } });
  const itemB = dispatchInput({ itemIndex: 1, envelope: { version: 1, goalId: "g1", candidates: [spec(null, "dB")] } });
  const results = store.prepareSubagentDispatchBatch([itemA, itemB]);
  assert.equal(results.length, 2);
  assert.equal(results[0].reason, "selected");
  assert.equal(results[1].reason, "all_excluded");
  assert.ok(results.every((x) => x.trace.assessmentStatus === "not_dispatched"));
  assert.equal(results[0].trace.selectedDirectionArmId, directionArmId("g1", null, "dA"));
  assert.equal(countTraces(store), 2);
  assert.equal(countObservations(store), 0);
  const st = learningState(store);
  assert.equal(st.generation, 1);
  assert.equal(st.opportunityCounters[parentArmId("g1", null)], 2);
  store.close();
});

test("batch: one invalid item rejects the whole batch before any write", () => {
  const store = openStore();
  const bad = dispatchInput({ itemIndex: 1, envelope: { version: 1, goalId: "g1", candidates: [] } });
  assert.throws(() => store.prepareSubagentDispatchBatch([dispatchInput({}), bad]), RangeError);
  assert.equal(countTraces(store), 0);
  assert.equal(learningState(store).generation, 0);
  store.close();
});

test("dispatch input guard: itemIndex must be a nonnegative safe integer", () => {
  const store = openStore();
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    assert.throws(() => store.prepareSubagentDispatch(dispatchInput({ itemIndex: bad })), RangeError);
  }
  assert.equal(countTraces(store), 0);
  store.close();
});

test("counter overflow rejects and rolls back", () => {
  const store = openStore();
  const dArm = directionArmId("g1", null, "d1");
  mutateState(store, (s) => { s.opportunityCounters[dArm] = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => store.prepareSubagentDispatch(dispatchInput({})), /safe integer/);
  const st = learningState(store);
  assert.equal(st.generation, 0);
  assert.equal(st.opportunityCounters[parentArmId("g1", null)], undefined);
  assert.equal(countTraces(store), 0);
  // the connection must be usable again (transaction was rolled back, not left open)
  mutateState(store, (s) => { delete s.opportunityCounters[dArm]; });
  assert.equal(store.prepareSubagentDispatch(dispatchInput({})).reason, "selected");
  store.close();
});

function envWith(over: Record<string, unknown>) {
  return { version: 1 as const, goalId: "g1", candidates: [{ ...spec(null, "d1"), ...over }] };
}

test("collision: same directionId with changed change text is rejected before any mutation", () => {
  const store = openStore();
  store.prepareSubagentDispatch(dispatchInput({}));
  const before = learningState(store);
  assert.throws(
    () => store.prepareSubagentDispatch(dispatchInput({ toolCallId: "t2", inputHash: "h2", envelope: envWith({ change: "different" }) })),
    /directionId d1/,
  );
  assert.deepEqual(learningState(store), before);
  assert.equal(countTraces(store), 1);
  store.close();
});

test("collision: identical metadata (scope in another order) is accepted", () => {
  const store = openStore();
  store.prepareSubagentDispatch(dispatchInput({ envelope: envWith({ scope: ["b.ts", "a/c.ts"] }) }));
  const r = store.prepareSubagentDispatch(dispatchInput({ toolCallId: "t2", inputHash: "h2", envelope: envWith({ scope: ["a/c.ts", "b.ts"], prompt: "new prompt" }) }));
  assert.equal(r.reason, "selected");
  assert.equal(countTraces(store), 2);
  store.close();
});

test("collision: same directionArmId with different scope inside one batch is rejected", () => {
  const store = openStore();
  const a = dispatchInput({ itemIndex: 0, envelope: envWith({ scope: ["a.ts"] }) });
  const b = dispatchInput({ itemIndex: 1, envelope: envWith({ scope: ["b.ts"] }) });
  assert.throws(() => store.prepareSubagentDispatchBatch([a, b]), /directionId d1/);
  assert.equal(countTraces(store), 0);
  assert.equal(learningState(store).generation, 0);
  store.close();
});

test("replay of a blocked batch returns selected null for every item", () => {
  const store = openStore();
  const dB = directionArmId("g1", null, "dB");
  mutateState(store, (s) => { s.cooldowns[dB] = { excludedThroughOpportunity: 100, failures: 1 }; });
  const items = [
    dispatchInput({ itemIndex: 0, envelope: { version: 1, goalId: "g1", candidates: [spec(null, "dA")] } }),
    dispatchInput({ itemIndex: 1, envelope: { version: 1, goalId: "g1", candidates: [spec(null, "dB")] } }),
  ];
  store.prepareSubagentDispatchBatch(items);
  const before = learningState(store);
  const replay = store.prepareSubagentDispatchBatch(items);
  assert.ok(replay.every((r) => r.selected === null && r.reason === "all_excluded"));
  assert.deepEqual(learningState(store), before);
  store.close();
});

// ---- Task 6: assessment gates ----
function seededWithDispatch(over: { parentId?: string | null } = {}): { store: SkillTelemetryStore; trace: Trace; dir: string; hooks: TestHooks } {
  const hooks: TestHooks = {};
  const store = openStore(hooks);
  const parentId = "parentId" in over ? over.parentId! : "p1";
  const env = { version: 1 as const, goalId: "g1", candidates: [spec(parentId, "d1")] };
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: env }));
  return { store, trace: r.trace, dir: storeCwds.get(store)!, hooks };
}
function assessment(trace: Trace, o: Partial<Assessment> & { candidatePass?: boolean[]; baselinePass?: boolean[] } = {}): Assessment {
  const { candidatePass = [true, true], baselinePass, ...rest } = o;
  const criterionIds = candidatePass.map((_, i) => `c${i + 1}`);
  return {
    dispatchId: trace.dispatchId, reportKind: "ready", followed: true, attributable: true,
    allChecksCompleted: true, measurementError: false,
    baseline: { criterionIds, passed: baselinePass ?? criterionIds.map(() => false) },
    candidate: { criterionIds, passed: candidatePass },
    evidenceRefs: [{ path: "x", sha256: "y" }], changedPaths: [], availableAt: 1, ...rest,
  };
}

test("F4: success yields exactly two observations with distinct IDs", () => {
  const { trace } = seededWithDispatch();
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "ready", candidatePass: [true, true] }));
  assert.equal(out.kind, "terminal_success");
  assert.equal(out.rows.length, 2);
  assert.notEqual(out.rows[0].observationId, out.rows[1].observationId);
  assert.deepEqual(out.rows.map((r) => r.target).sort(), ["direction", "parent"]);
  assert.ok(out.rows.every((r) => r.value === 1));
  assert.equal(out.delta, 1);
});

test("F4: failure yields two zero observations", () => {
  const { trace } = seededWithDispatch();
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "failed", candidatePass: [false, false] }));
  assert.equal(out.kind, "terminal_failure");
  assert.equal(out.rows.length, 2);
  assert.ok(out.rows.every((r) => r.value === 0));
});

test("F4: each false gate yields skip with no rows", () => {
  const gates: Array<Partial<Assessment>> = [
    { followed: false }, { attributable: false }, { allChecksCompleted: false }, { measurementError: true }, { evidenceRefs: [] },
  ];
  for (const g of gates) {
    const { trace } = seededWithDispatch();
    const out = evaluateAssessment(trace, assessment(trace, { reportKind: "ready", candidatePass: [true], ...g }));
    assert.equal(out.kind, "skip", JSON.stringify(g));
    assert.equal(out.rows.length, 0);
  }
});

test("F4: ready with a failed criterion is rejected", () => {
  const { trace } = seededWithDispatch();
  assert.throws(() => evaluateAssessment(trace, assessment(trace, { reportKind: "ready", candidatePass: [true, false] })), /ready with failed criterion/);
});

test("F4: partial improvement failure is terminal failure with positive delta", () => {
  const { trace } = seededWithDispatch();
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "failed", baselinePass: [false, false], candidatePass: [true, false] }));
  assert.equal(out.kind, "terminal_failure");
  assert.equal(out.delta, 0.5);
});

test("F4: null baseline parent is valid", () => {
  const { trace } = seededWithDispatch({ parentId: null });
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "ready", candidatePass: [true] }));
  assert.equal(out.kind, "terminal_success");
});

test("F4: blocked with valid evidence is terminal failure, not skip", () => {
  const { trace } = seededWithDispatch();
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "blocked", candidatePass: [true] }));
  assert.equal(out.kind, "terminal_failure");
});

test("F4: criterion set mismatches and foreign dispatch throw RangeError", () => {
  const { trace } = seededWithDispatch();
  const base = assessment(trace, { reportKind: "failed", candidatePass: [true, false] });
  const bad: Assessment[] = [
    { ...base, candidate: { criterionIds: ["c2", "c1"], passed: [true, false] } },
    { ...base, candidate: { criterionIds: ["c1", "c2"], passed: [true] } },
    { ...base, baseline: { criterionIds: ["c1", "c2"], passed: [true] } },
    { ...base, baseline: { criterionIds: [], passed: [] }, candidate: { criterionIds: [], passed: [] } },
    { ...base, dispatchId: "other" },
  ];
  for (const a of bad) assert.throws(() => evaluateAssessment(trace, a), RangeError);
});

function emptyState() {
  return { generation: 0, arms: {}, opportunityCounters: {}, cooldowns: {}, cards: [],
    memory: { lessons: [], targetCatalog: [] } } as import("../src/skill-telemetry.ts").LearningStateJSON;
}
const cardFields = { mechanism: "m", change: "c", scope: ["a.ts"] };

test("F6: failure sets cooldown T+3; prune keeps it through T+3 and drops at T+4", () => {
  const s = applyFailureCooldown(emptyState(), "d", "k", cardFields, 5, 100);
  assert.deepEqual(s.cooldowns.d, { excludedThroughOpportunity: 8, failures: 1 });
  for (const t of [6, 7, 8]) assert.ok(pruneExpiredCooldowns(s, t).cooldowns.d, `T=${t} excluded`);
  assert.equal(pruneExpiredCooldowns(s, 9).cooldowns.d, undefined);
});

test("F6: second NEW failure for same direction renews entry; input not mutated", () => {
  const s1 = applyFailureCooldown(emptyState(), "d", "k", cardFields, 5, 100);
  const snap = JSON.stringify(s1);
  const s2 = applyFailureCooldown(s1, "d", "k", cardFields, 6, 200);
  assert.deepEqual(s2.cooldowns.d, { excludedThroughOpportunity: 9, failures: 2 });
  assert.equal(JSON.stringify(s1), snap);
  assert.equal(s2.cards.length, 1);
  assert.equal(s2.cards[0].firstSeenAt, 100);
  assert.equal(s2.cards[0].lastSeenAt, 200);
});

test("F6: reducer renews unconditionally when called; duplicate suppression is the caller's job", () => {
  const s1 = applyFailureCooldown(emptyState(), "d", "k", cardFields, 5, 100);
  const s2 = applyFailureCooldown(s1, "d", "k", cardFields, 5, 100);
  assert.deepEqual(s2.cooldowns.d, { excludedThroughOpportunity: 8, failures: 2 });
  const s3 = applyFailureCooldown(s2, "d", "k", cardFields, 7, 100);
  assert.deepEqual(s3.cooldowns.d, { excludedThroughOpportunity: 10, failures: 3 });
});

test("F6: expired cooldown is replaced by a fresh one", () => {
  const s1 = applyFailureCooldown(emptyState(), "d", "k", cardFields, 5, 100);
  const s2 = applyFailureCooldown(s1, "d", "k2", cardFields, 9, 300);
  assert.deepEqual(s2.cooldowns.d, { excludedThroughOpportunity: 12, failures: 1 });
});

test("F6: card cap 50 evicts smallest lastSeenAt then lex-smallest key, never touches cooldowns", () => {
  let s = emptyState();
  for (let i = 0; i < 50; i += 1) s = applyFailureCooldown(s, `d${i}`, `k${String(i).padStart(2, "0")}`, cardFields, 1, 10);
  assert.equal(s.cards.length, 50);
  s = applyFailureCooldown(s, "dx", "kzz", cardFields, 1, 20);
  assert.equal(s.cards.length, 50);
  assert.ok(!s.cards.some((c) => c.failureKey === "k00"), "tie on lastSeenAt evicts lex-smallest");
  assert.ok(s.cards.some((c) => c.failureKey === "kzz"));
  assert.equal(Object.keys(s.cooldowns).length, 51);
  assert.ok(s.cooldowns.d0, "evicted card keeps its active cooldown");
  assert.equal(capCards(s.cards).length, 50);
});

// ---- Task 8: deterministic memory and bounded rendering ----
function memTrace(directionId: string, o: { goalId?: string; scope?: string[]; change?: string } = {}): Trace {
  const goalId = o.goalId ?? "g1";
  const c = {
    parentId: "p1", directionId, mechanism: "mech", change: o.change ?? `change-${directionId}`,
    scope: o.scope ?? ["src/a.ts"], prompt: "p",
    parentArmId: parentArmId(goalId, "p1"), directionArmId: directionArmId(goalId, "p1", directionId),
  };
  return { dispatchId: `disp-${directionId}`, goalId, candidates: [c], selectedDirectionArmId: c.directionArmId } as unknown as Trace;
}
function memAssessment(t: Trace, kind: "ready" | "failed", pass: boolean[], base: boolean[], changed: string[] = []): Assessment {
  const ids = pass.map((_, i) => `c${i + 1}`);
  return {
    dispatchId: t.dispatchId, reportKind: kind, followed: true, attributable: true, allChecksCompleted: true,
    measurementError: false, baseline: { criterionIds: ids, passed: base }, candidate: { criterionIds: ids, passed: pass },
    evidenceRefs: [{ path: "x", sha256: "y" }], changedPaths: changed, availableAt: 1,
  };
}
const successEval = (t: Trace) => memAssessment(t, "ready", [true, true], [false, false]);
const failureEval = (t: Trace) => memAssessment(t, "failed", [false, false], [false, false]);
const partialEval = (t: Trace) => memAssessment(t, "failed", [true, false], [false, false]);
const applyEvaluation = (s: LearningStateJSON, t: Trace, a: Assessment, now = 10) => applyEvaluationToState(s, t, a, now);
function extractBody(text: string): string {
  const lines = text.split("\n");
  assert.equal(lines[0], "<subagent-policy-memory>");
  assert.equal(lines[lines.length - 1], "</subagent-policy-memory>");
  assert.match(lines[1], /^revision:[0-9a-f]{64}$/);
  return lines.slice(2, -1).join("\n");
}
function applyMany(s: LearningStateJSON, n: number): LearningStateJSON {
  for (let i = 0; i < n; i += 1) {
    const t = memTrace(`d${i}`, { scope: [`src/f${i}.ts`, `src/g${i}.ts`] });
    s = applyEvaluation(s, t, successEval(t), 100 + i);
  }
  return s;
}
function bigState(): LearningStateJSON {
  let s = emptyState();
  for (let i = 0; i < 6; i += 1) {
    const t = memTrace(`d${i}`, { change: "x".repeat(400) + `<script>${i}`, scope: [`src/f${i}.ts`] });
    s = applyEvaluation(s, t, successEval(t), 100 + i);
  }
  for (let i = 0; i < 20; i += 1) s.cooldowns[`arm${i}` as never] = { excludedThroughOpportunity: 9, failures: 1 };
  return s;
}

test("F9: success, failure and conditional lessons with reinforce/contradict/retire", () => {
  const t = memTrace("d1");
  let s = applyEvaluation(emptyState(), t, successEval(t));
  assert.equal(s.memory.lessons[0].kind, "successful_pattern");
  assert.equal(s.memory.lessons[0].reinforceCount, 1);
  s = applyEvaluation(s, t, successEval(t), 11);
  assert.equal(s.memory.lessons[0].reinforceCount, 2);
  s = applyEvaluation(s, t, failureEval(t), 12);
  assert.equal(s.memory.lessons[0].contradictionCount, 1);
  s = applyEvaluation(s, t, failureEval(t), 13);
  assert.equal(s.memory.lessons.length, 0, "contradiction 2 >= reinforce 2 retires in this evaluation, not recreated");
  assert.equal(s.memory.targetCatalog.length, 0);
  const one = applyEvaluation(applyEvaluation(emptyState(), t, successEval(t)), t, failureEval(t), 12);
  assert.equal(one.memory.lessons.length, 0, "reinforce 1, contradiction 1 retires immediately");
  const reborn = applyEvaluation(one, t, successEval(t), 20);
  assert.equal(reborn.memory.lessons.length, 1);
  assert.equal(reborn.memory.lessons[0].reinforceCount, 1);
  assert.equal(reborn.memory.lessons[0].contradictionCount, 0);
  assert.equal(reborn.memory.lessons[0].firstSeenAt, 20, "new lesson, not resurrected");

  const f = applyEvaluation(emptyState(), t, failureEval(t));
  assert.equal(f.memory.lessons[0].kind, "failure_pattern");
  assert.equal(f.memory.lessons[0].recommendedChange, "Avoid change-d1; choose another direction");
  const c1 = applyEvaluation(emptyState(), t, partialEval(t));
  assert.equal(c1.memory.lessons[0].kind, "conditional_guidance");
  assert.equal(c1.memory.lessons[0].recommendedChange, "Improved some criteria; remaining criteria must pass: c2");
  const c2 = applyEvaluation(c1, t, partialEval(t), 20);
  assert.equal(c2.memory.lessons[0].reinforceCount, 2);
  const changed = memAssessment(t, "failed", [true, true, false], [false, false, false]);
  const c3 = applyEvaluation(c1, t, changed, 30);
  assert.equal(c3.memory.lessons[0].reinforceCount, 1, "new guidance resets");
  assert.match(c3.memory.lessons[0].recommendedChange, /c3$/);
});

test("F9: SKIP leaves memory untouched and reducer does not mutate input", () => {
  const t = memTrace("d1");
  const s0 = applyEvaluation(emptyState(), t, successEval(t));
  const snap = JSON.stringify(s0);
  const s1 = applyEvaluation(s0, t, { ...failureEval(t), followed: false });
  assert.equal(JSON.stringify(s1), snap);
  applyEvaluation(s0, t, failureEval(t), 50);
  assert.equal(JSON.stringify(s0), snap);
});

test("F9: cap 6 lessons and 8 targets; no dangling targetIndexes", () => {
  const s = applyMany(emptyState(), 10);
  assert.equal(s.memory.lessons.length, 6);
  assert.deepEqual(s.memory.lessons.map((l) => l.firstSeenAt).sort(), [104, 105, 106, 107, 108, 109]);
  assert.ok(s.memory.targetCatalog.length <= 8);
  for (const l of s.memory.lessons) for (const i of l.targetIndexes) assert.ok(i < s.memory.targetCatalog.length);
  const files = s.memory.targetCatalog.map((x) => x.file);
  assert.deepEqual(files, [...files].sort());
  const t = memTrace("big", { scope: Array.from({ length: 8 }, (_, i) => `a${i}.ts`) });
  const b = applyEvaluation(emptyState(), t, memAssessment(t, "ready", [true], [false], ["z1.ts", "z2.ts"]));
  assert.equal(b.memory.lessons[0].targets.length, 8);
});

test("F9: render within 8192 UTF-16 including tags, < escaped, valid JSON after trim", () => {
  const text = getSubagentPolicyMemory(bigState(), "g1", 8192);
  assert.ok(text.length <= 8192);
  assert.ok(!text.slice(text.indexOf("<subagent-policy-memory>") + 1).includes("<script"));
  assert.ok(text.includes("\\u003cscript"));
  assert.ok(!extractBody(text).includes("<"));
  const body = JSON.parse(extractBody(text));
  assert.ok(Array.isArray(body.lessons));
  assert.equal(body.cooldowns.length + body.excludedCount, 20);

  const small = getSubagentPolicyMemory(bigState(), "g1", 600);
  assert.ok(small.length <= 600);
  assert.ok(JSON.parse(extractBody(small)).lessons.length < 6);
  const fallback = getSubagentPolicyMemory(bigState(), "g1", 256);
  assert.ok(fallback.length <= 256);
  assert.equal(JSON.parse(extractBody(fallback)).lessons.length, 0);
  assert.equal(JSON.parse(extractBody(getSubagentPolicyMemory(bigState(), "other"))).lessons.length, 0);
  assert.throws(() => getSubagentPolicyMemory(bigState(), "g1", 100), RangeError);
});

test("F9: renderer lists only active cooldowns", () => {
  const s = emptyState();
  s.opportunityCounters["live" as never] = 5;
  s.opportunityCounters["dead" as never] = 6;
  s.cooldowns["live" as never] = { excludedThroughOpportunity: 5, failures: 1 };
  s.cooldowns["dead" as never] = { excludedThroughOpportunity: 5, failures: 1 };
  const body = JSON.parse(extractBody(getSubagentPolicyMemory(s, "g1")));
  assert.deepEqual(body.cooldowns, ["live"]);
  assert.equal(body.excludedCount, 0);
});

test("F9: same state renders the same revision and text", () => {
  assert.equal(getSubagentPolicyMemory(bigState(), "g1"), getSubagentPolicyMemory(bigState(), "g1"));
  const a = getSubagentPolicyMemory(emptyState(), "g1");
  const b = getSubagentPolicyMemory({ ...emptyState(), generation: 9 }, "g1");
  assert.equal(a, b, "generation-only change keeps revision");
});

test("F9: dispatch trace stores revision and text rendered from fresh state for the goal", () => {
  const store = openStore();
  const t = memTrace("d0");
  mutateState(store, (st) => { Object.assign(st, applyEvaluation(st, t, successEval(t))); });
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: { version: 1, goalId: "g1", candidates: [spec("p1", "d1")] } }));
  assert.equal(r.trace.memoryText, getSubagentPolicyMemory(learningState(store), "g1"));
  assert.match(r.trace.memoryText, /successful_pattern/);
  assert.match(r.trace.memoryRevision, /^[0-9a-f]{64}$/);
  assert.ok(r.trace.memoryText.includes(r.trace.memoryRevision));
});

// ---- Task 9: commit transaction, CAS, replay, outbox and drain (F5, F6 end-to-end, F7, F8) ----
function expectedOutcomeBytes(operationId: string): string {
  return `${JSON.stringify({ operationId, verdict: "recorded", notes: "<kept as data>" }, null, 2)}\n`;
}
function outcomePath(dir: string): string { return join(dir, ".omp/work/outcome.json"); }
function commitInput(dir: string, list: Assessment | Assessment[], over: Partial<CommitBatchInput> = {}): CommitBatchInput {
  const assessments = Array.isArray(list) ? list : [list];
  const sessionId = over.sessionId ?? "s1";
  const operationId = evaluationOperationId(sessionId, assessments.map((a) => a.dispatchId));
  return {
    operationId, sessionId, requestHash: hashId(["test-request", sessionId, assessments]),
    destination: outcomePath(dir), outcomeJson: expectedOutcomeBytes(operationId), assessments, now: 5000, ...over,
  };
}
const successAssessment = (t: Trace) => assessment(t, { reportKind: "ready", candidatePass: [true, true] });
const failureAssessment = (t: Trace) => assessment(t, { reportKind: "failed", candidatePass: [false, false] });
const skipAssessment = (t: Trace) => assessment(t, { reportKind: "ready", candidatePass: [true, true], followed: false });
function dispatchAnother(store: SkillTelemetryStore, toolCallId: string, directionId: string): Trace {
  return store.prepareSubagentDispatch(dispatchInput({
    toolCallId, inputHash: toolCallId, envelope: { version: 1, goalId: "g1", candidates: [spec("p1", directionId)] },
  })).trace;
}
function storedTrace(store: SkillTelemetryStore, id: string): Trace {
  return withRawDb(store, (db) => JSON.parse((db.prepare("SELECT payload_json p FROM dispatch_traces WHERE dispatch_id=?").get(id) as { p: string }).p));
}
function injectFailureAfterFirstObservation(hooks: TestHooks): void {
  hooks.afterFirstObservation = () => { throw new Error("injected fault after first observation"); };
}
function advanceGenerationBehindTheBack(hooks: TestHooks): void {
  // Another writer advances the generation between this transaction's read and its CAS UPDATE.
  hooks.beforeStateUpdate = (db) => {
    db.exec("UPDATE learning_state SET generation=generation+1, payload_json=json_set(payload_json,'$.generation',generation+1) WHERE id=1");
  };
}
function injectWriteFalseOnce(hooks: TestHooks, log: string[] = []): string[] {
  let failed = false;
  hooks.writeProjection = (destination, content) => {
    log.push(content);
    if (!failed) { failed = true; return false; }
    return writeTextFileAtomic(destination, content);
  };
  return log;
}
function pendingError(fn: () => unknown): Error & { code?: string; generation?: number; operationId?: string } {
  try { fn(); } catch (err) { return err as Error & { code?: string }; }
  assert.fail("expected PROJECTION_PENDING");
}

test("F5: replay of identical operation does not reapply; changed payload conflicts", () => {
  const { store, trace, dir } = seededWithDispatch();
  const input = commitInput(dir, successAssessment(trace));
  const a = store.commitSubagentEvaluationBatch(input);
  assert.deepEqual(a, { generation: 2, status: "flushed", replay: false });
  assert.equal(readFileSync(outcomePath(dir), "utf8"), input.outcomeJson);
  const before = learningState(store);
  const sel = trace.candidates[0];
  assert.deepEqual(before.arms[sel.parentArmId], { successes: 1, n: 1 });
  assert.deepEqual(before.arms[sel.directionArmId], { successes: 1, n: 1 });
  assert.equal(countObservations(store), 2);

  const b = store.commitSubagentEvaluationBatch({ ...input, outcomeJson: "fresh telemetry bytes from a second caller" });
  assert.deepEqual(b, { generation: a.generation, status: "flushed", replay: true });
  assert.deepEqual(learningState(store), before);
  assert.equal(countObservations(store), 2);
  assert.equal(readFileSync(outcomePath(dir), "utf8"), input.outcomeJson, "replay keeps original bytes");

  assert.throws(() => store.commitSubagentEvaluationBatch({ ...input, requestHash: "changed" }), /conflict/);
  assert.throws(() => store.commitSubagentEvaluationBatch({ ...input, destination: join(dir, "elsewhere.json") }), /conflict/);
  assert.throws(() => store.commitSubagentEvaluationBatch({ ...input, assessments: [{ ...input.assessments[0], availableAt: 2 }] }), /conflict/);
  assert.deepEqual(learningState(store), before);

  const t = storedTrace(store, trace.dispatchId);
  assert.equal(t.assessmentStatus, "applied");
  assert.equal(t.assessmentHash, assessmentHash(input.assessments[0]));
  assert.equal(t.evaluationOperationId, input.operationId);
  const proj = store.findEvaluationProjection(input.operationId, "s1");
  assert.ok(proj);
  assert.equal(proj!.outcomeJson, input.outcomeJson);
  assert.equal(proj!.status, "flushed");
  assert.equal(proj!.generation, 2);
  assert.equal(store.findEvaluationProjection(input.operationId, "s2"), null);
  assert.equal(store.findEvaluationProjection("nope", "s1"), null);
  store.close();
});

test("F5: skipped retry does not upgrade; mixed-terminal and unknown dispatch reject", () => {
  const { store, trace, dir } = seededWithDispatch();
  const r = store.commitSubagentEvaluationBatch(commitInput(dir, skipAssessment(trace)));
  assert.equal(r.replay, false);
  assert.equal(countObservations(store), 0);
  const skipped = storedTrace(store, trace.dispatchId);
  assert.equal(skipped.assessmentStatus, "skipped");
  assert.equal(skipped.assessmentHash, assessmentHash(skipAssessment(trace)));
  const st = learningState(store);
  assert.deepEqual([st.arms, st.cooldowns, st.cards, st.memory.lessons], [{}, {}, [], []]);
  assert.equal(st.generation, 2);

  // SKIP is never upgraded to ready on the same dispatch.
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment(trace))), /conflict/);
  // Mixed terminal + pending rejects the whole batch.
  const t2 = dispatchAnother(store, "t2", "d2");
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, [skipAssessment(trace), successAssessment(t2)])), /mixed/);
  assert.equal(storedTrace(store, t2.dispatchId).assessmentStatus, "pending");
  // Unknown dispatch, not-dispatched trace, foreign session, forged operationId, empty and duplicate batches reject.
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, { ...successAssessment(t2), dispatchId: "nope" })), /unknown dispatch/);
  const d3 = directionArmId("g1", "p1", "d3");
  mutateState(store, (s) => { s.cooldowns[d3] = { excludedThroughOpportunity: 100, failures: 1 }; });
  const t3 = dispatchAnother(store, "t3", "d3");
  assert.equal(t3.assessmentStatus, "not_dispatched");
  const afterBlocked = learningState(store);
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment({ ...t3, selectedDirectionArmId: d3 } as Trace))), /not dispatched/);
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment(t2), { sessionId: "s2" })), /session/);
  assert.throws(() => store.commitSubagentEvaluationBatch({ ...commitInput(dir, successAssessment(t2)), operationId: "forged" }), /operationId/);
  assert.throws(() => store.commitSubagentEvaluationBatch({ ...commitInput(dir, successAssessment(t2)), assessments: [] }), /assessments/);
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, [successAssessment(t2), successAssessment(t2)])), /duplicate/);
  assert.equal(countObservations(store), 0);
  assert.deepEqual(learningState(store), afterBlocked);
  assert.equal(afterBlocked.generation, 4, "only the two later dispatches advanced generation");
  store.close();
});

test("F5: an existing observation row for a pending trace is an invariant violation; no partial pair", () => {
  const { store, trace, dir } = seededWithDispatch();
  const sel = trace.candidates[0];
  const oid = observationId(trace.dispatchId, "direction", sel.directionArmId);
  withRawDb(store, (db) => db.prepare("INSERT INTO observations(observation_id, payload_json) VALUES (?, '{}')").run(oid));
  const before = learningState(store);
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment(trace))), /invariant/);
  assert.equal(countObservations(store), 1);
  assert.deepEqual(learningState(store), before);
  assert.equal(storedTrace(store, trace.dispatchId).assessmentStatus, "pending");
  store.close();
});

test("F5: batch evaluates in dispatchId order, one generation, owner trace holds the projection", () => {
  const { store, trace, dir } = seededWithDispatch();
  const t2 = dispatchAnother(store, "t2", "d2");
  const input = commitInput(dir, [successAssessment(t2), failureAssessment(trace)]);
  const r = store.commitSubagentEvaluationBatch(input);
  assert.equal(r.generation, 3);
  assert.equal(countObservations(store), 4);
  const [ownerId, otherId] = [trace.dispatchId, t2.dispatchId].sort();
  const owner = storedTrace(store, ownerId);
  assert.equal(owner.outcome?.operationId, input.operationId);
  assert.equal(owner.outcome?.status, "flushed");
  assert.equal(storedTrace(store, otherId).outcome, undefined);
  assert.equal(storedTrace(store, otherId).evaluationOperationId, input.operationId);
  const st = learningState(store);
  assert.deepEqual(st.arms[parentArmId("g1", "p1")], { successes: 1, n: 2 });
  assert.equal(st.generation, 3);
  store.close();
});

test("skip: failed/blocked/dropped with a false gate is SKIP with no rows (pure and through the store)", () => {
  const gates: Array<Partial<Assessment>> = [
    { followed: false }, { attributable: false }, { allChecksCompleted: false }, { measurementError: true }, { evidenceRefs: [] },
  ];
  const { store, trace, dir } = seededWithDispatch();
  for (const reportKind of ["failed", "blocked", "dropped"] as const) {
    for (const g of gates) {
      const out = evaluateAssessment(trace, assessment(trace, { reportKind, candidatePass: [false, false], ...g }));
      assert.equal(out.kind, "skip", `${reportKind} ${JSON.stringify(g)}`);
      assert.equal(out.rows.length, 0);
    }
  }
  store.commitSubagentEvaluationBatch(commitInput(dir, assessment(trace, { reportKind: "failed", candidatePass: [false, false], followed: false })));
  const st = learningState(store);
  assert.deepEqual([st.arms, st.cooldowns, st.cards, st.memory.lessons], [{}, {}, [], []]);
  assert.equal(countObservations(store), 0);
  store.close();
});

test("F7: failure after first observation and state update rolls back everything", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  const before = learningState(store);
  injectFailureAfterFirstObservation(hooks);
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment(trace))), /injected/);
  assert.equal(countObservations(store), 0);
  assert.deepEqual(learningState(store), before);
  assert.equal(learningState(store).generation, 1);
  const t = storedTrace(store, trace.dispatchId);
  assert.equal(t.assessmentStatus, "pending");
  assert.equal(t.assessmentHash, undefined);
  assert.equal(t.outcome, undefined);
  assert.equal(existsSync(outcomePath(dir)), false);
  // A retry after the fault applies exactly once.
  delete hooks.afterFirstObservation;
  const r = store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment(trace)));
  assert.equal(r.generation, 2);
  assert.equal(countObservations(store), 2);
  assert.deepEqual(learningState(store).arms[trace.candidates[0].directionArmId], { successes: 1, n: 1 });
  store.close();
});

test("F7: stale CAS rolls back observations, markers and state", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  const before = learningState(store);
  advanceGenerationBehindTheBack(hooks);
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, failureAssessment(trace))), /CAS_STALE_GENERATION/);
  assert.equal(countObservations(store), 0);
  assert.deepEqual(learningState(store), before, "the concurrent bump is rolled back with the transaction");
  assert.equal(storedTrace(store, trace.dispatchId).assessmentStatus, "pending");
  assert.equal(existsSync(outcomePath(dir)), false);
  delete hooks.beforeStateUpdate;
  store.commitSubagentEvaluationBatch(commitInput(dir, failureAssessment(trace)));
  const st = learningState(store);
  assert.deepEqual(st.arms[trace.candidates[0].directionArmId], { successes: 0, n: 1 });
  assert.deepEqual(st.cooldowns[trace.candidates[0].directionArmId], { excludedThroughOpportunity: 4, failures: 1 });
  store.close();
});

test("F8: file write returns false after commit → pending and PROJECTION_PENDING; reopen flushes exact bytes", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  injectWriteFalseOnce(hooks);
  const input = commitInput(dir, successAssessment(trace));
  const err = pendingError(() => store.commitSubagentEvaluationBatch(input));
  assert.match(err.message, /PROJECTION_PENDING/);
  assert.equal(err.code, "PROJECTION_PENDING");
  assert.equal(err.generation, 2);
  assert.equal(err.operationId, input.operationId);
  // Learning is committed; only the projection is pending.
  assert.equal(countObservations(store), 2);
  assert.equal(learningState(store).generation, 2);
  assert.equal(storedTrace(store, trace.dispatchId).outcome?.status, "pending");
  assert.equal(existsSync(outcomePath(dir)), false);
  store.close();
  const reopened = openStore(undefined, dir);
  reopened.drainPending();
  assert.equal(readFileSync(outcomePath(dir), "utf8"), expectedOutcomeBytes(input.operationId));
  assert.equal(storedTrace(reopened, trace.dispatchId).outcome?.status, "flushed");
  const replay = reopened.commitSubagentEvaluationBatch(input);
  assert.deepEqual(replay, { generation: 2, status: "flushed", replay: true });
  reopened.close();
});

test("F8: real writeTextFileAtomic returns false (destination is a directory) → PROJECTION_PENDING; reopen flushes exact bytes", () => {
  const cwd = tempCwd();
  const store = openStore(undefined, cwd); // no hooks: the default writer binding is the real helper
  const trace = dispatchAnother(store, "t1", "d1");
  const input = commitInput(cwd, successAssessment(trace));
  mkdirSync(outcomePath(cwd), { recursive: true }); // rename onto a directory fails → helper returns false
  const err = pendingError(() => store.commitSubagentEvaluationBatch(input)) as Error & { code?: string; generation?: number; operationId?: string; cause?: any };
  assert.equal(err.code, "PROJECTION_PENDING");
  assert.equal(err.generation, 2);
  assert.equal(err.operationId, input.operationId);
  // The drain failed on the boolean, not on a throw: its own error is PROJECTION_PENDING.
  assert.equal(err.cause?.code, "PROJECTION_PENDING", `drain cause was ${err.cause}`);
  assert.equal(learningState(store).generation, 2);
  assert.equal(countObservations(store), 2);
  assert.equal(storedTrace(store, trace.dispatchId).outcome?.status, "pending");
  store.close();
  rmSync(outcomePath(cwd), { recursive: true, force: true });
  const reopened = openStore(undefined, cwd);
  reopened.drainPending();
  assert.equal(readFileSync(outcomePath(cwd), "utf8"), storedTrace(reopened, trace.dispatchId).outcome?.outcomeJson);
  assert.equal(readFileSync(outcomePath(cwd), "utf8"), input.outcomeJson);
  assert.equal(storedTrace(reopened, trace.dispatchId).outcome?.status, "flushed");
  reopened.close();
});

test("F8: crash after rename before marker update replays identical bytes", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  let crashed = false;
  hooks.afterProjectionWrite = () => { if (!crashed) { crashed = true; throw new Error("crash after rename"); } };
  const input = commitInput(dir, successAssessment(trace));
  assert.throws(() => store.commitSubagentEvaluationBatch(input), /PROJECTION_PENDING/);
  assert.equal(readFileSync(outcomePath(dir), "utf8"), input.outcomeJson, "file renamed before the crash");
  assert.equal(storedTrace(store, trace.dispatchId).outcome?.status, "pending");
  store.close();
  const reopened = openStore(undefined, dir);
  reopened.drainPending();
  assert.equal(readFileSync(outcomePath(dir), "utf8"), input.outcomeJson);
  assert.equal(storedTrace(reopened, trace.dispatchId).outcome?.status, "flushed");
  reopened.drainPending(); // nothing pending: no-op
  reopened.close();
});

test("F8: two commits to the same destination do not stale-overwrite", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  const t2 = dispatchAnother(store, "t2", "d2");
  const writes = injectWriteFalseOnce(hooks);
  const op1 = commitInput(dir, successAssessment(trace));
  assert.throws(() => store.commitSubagentEvaluationBatch(op1), /PROJECTION_PENDING/);
  const op2 = commitInput(dir, successAssessment(t2));
  const r = store.commitSubagentEvaluationBatch(op2);
  assert.equal(r.status, "flushed");
  assert.deepEqual(writes, [op1.outcomeJson, op1.outcomeJson, op2.outcomeJson], "pending op1 drains before op2 is written");
  assert.equal(readFileSync(outcomePath(dir), "utf8"), op2.outcomeJson);
  assert.equal(storedTrace(store, trace.dispatchId).outcome?.status, "flushed");
  store.drainPending();
  assert.equal(readFileSync(outcomePath(dir), "utf8"), op2.outcomeJson, "a later drain never rewrites op1");
  assert.equal(writes.length, 3);
  store.close();
});

test("F8: commit drains pending projections before mutation; a failing drain learns nothing new", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  const t2 = dispatchAnother(store, "t2", "d2");
  let calls = 0;
  hooks.writeProjection = (d, c) => (++calls <= 2 ? false : writeTextFileAtomic(d, c));
  const op1 = commitInput(dir, successAssessment(trace));
  assert.throws(() => store.commitSubagentEvaluationBatch(op1), /PROJECTION_PENDING/);
  const before = learningState(store);
  const op2 = commitInput(dir, successAssessment(t2));
  const err = pendingError(() => store.commitSubagentEvaluationBatch(op2));
  assert.equal(err.operationId, op1.operationId, "the blocking projection is op1");
  assert.deepEqual(learningState(store), before, "op2 not learned while op1 cannot flush");
  assert.equal(storedTrace(store, t2.dispatchId).assessmentStatus, "pending");
  assert.equal(countObservations(store), 2);
  // Retrying op1 drains it inside the transaction and replays as flushed.
  assert.deepEqual(store.commitSubagentEvaluationBatch(op1), { generation: before.generation, status: "flushed", replay: true });
  assert.equal(readFileSync(outcomePath(dir), "utf8"), op1.outcomeJson);
  store.close();
});

test("F8: a pending projection that cannot be written blocks learning dispatch (fail closed)", () => {
  const { store, trace, dir, hooks } = seededWithDispatch();
  hooks.writeProjection = () => false;
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(dir, successAssessment(trace))), /PROJECTION_PENDING/);
  const before = learningState(store);
  const traces = countTraces(store);
  assert.throws(() => dispatchAnother(store, "t2", "d2"), /PROJECTION_PENDING/);
  assert.throws(() => store.drainPending(), /PROJECTION_PENDING/);
  assert.deepEqual(learningState(store), before);
  assert.equal(countTraces(store), traces);
  store.close();
});

test("F6: non-improving failure through the commit path sets cooldown T+3; next three excluded, fourth eligible", () => {
  const { store, trace, dir } = seededWithDispatch();
  const dArm = trace.selectedDirectionArmId!;
  store.commitSubagentEvaluationBatch(commitInput(dir, failureAssessment(trace)));
  const st = learningState(store);
  assert.deepEqual(st.cooldowns[dArm], { excludedThroughOpportunity: 4, failures: 1 });
  assert.equal(st.cards.length, 1);
  assert.equal(st.cards[0].failureKey, failureKey("g1", "p1", "d1", "m-d1", "c-d1", ["a.ts"]));
  assert.equal(st.memory.lessons[0].kind, "failure_pattern");
  const reasons = [1, 2, 3, 4].map((i) => store.prepareSubagentDispatch(dispatchInput({
    toolCallId: `n${i}`, inputHash: `n${i}`, envelope: { version: 1, goalId: "g1", candidates: [spec("p1", "d1")] },
  })).reason);
  assert.deepEqual(reasons, ["all_excluded", "all_excluded", "all_excluded", "selected"]);
  store.close();
});

test("F6: partial-improvement failure writes no card and no cooldown", () => {
  const { store, trace, dir } = seededWithDispatch();
  store.commitSubagentEvaluationBatch(commitInput(dir, assessment(trace, { reportKind: "failed", candidatePass: [true, false] })));
  const st = learningState(store);
  assert.deepEqual([st.cards, st.cooldowns], [[], {}]);
  assert.equal(st.memory.lessons[0].kind, "conditional_guidance");
  store.close();
});

test("F6: duplicate, SKIP and restart do not renew the cooldown", () => {
  const { store, trace, dir } = seededWithDispatch();
  const dArm = trace.selectedDirectionArmId!;
  const input = commitInput(dir, failureAssessment(trace));
  store.commitSubagentEvaluationBatch(input);
  const after = learningState(store);
  assert.equal(store.commitSubagentEvaluationBatch(input).replay, true);
  assert.deepEqual(learningState(store), after, "duplicate does not renew");
  const t2 = dispatchAnother(store, "t2", "d2");
  store.commitSubagentEvaluationBatch(commitInput(dir, { ...failureAssessment(t2), followed: false }));
  let st = learningState(store);
  assert.deepEqual(st.cooldowns[dArm], after.cooldowns[dArm], "SKIP does not renew");
  assert.equal(st.cooldowns[t2.selectedDirectionArmId!], undefined);
  assert.deepEqual(st.cards, after.cards);
  store.close();
  const reopened = openStore(undefined, dir);
  assert.equal(reopened.commitSubagentEvaluationBatch(input).replay, true);
  st = learningState(reopened);
  assert.deepEqual(st.cooldowns[dArm], after.cooldowns[dArm], "restart does not renew");
  assert.deepEqual(st.cards, after.cards);
  reopened.close();
});

test("F6: card cap 50 evicting the new card does not bypass its active cooldown", () => {
  const { store, trace, dir } = seededWithDispatch();
  const dArm = trace.selectedDirectionArmId!;
  mutateState(store, (s) => {
    s.cards = Array.from({ length: 50 }, (_, i) => ({
      failureKey: `k${String(i).padStart(2, "0")}`, directionArmId: `x${i}`, mechanism: "m", change: "c",
      scope: ["a.ts"], firstSeenAt: 9_000_000, lastSeenAt: 9_000_000,
    }));
  });
  store.commitSubagentEvaluationBatch(commitInput(dir, failureAssessment(trace), { now: 5000 }));
  const st = learningState(store);
  assert.equal(st.cards.length, 50);
  assert.ok(!st.cards.some((c: { directionArmId: string }) => c.directionArmId === dArm), "new card is the eviction victim");
  assert.deepEqual(st.cooldowns[dArm], { excludedThroughOpportunity: 4, failures: 1 });
  const next = store.prepareSubagentDispatch(dispatchInput({
    toolCallId: "n1", inputHash: "n1", envelope: { version: 1, goalId: "g1", candidates: [spec("p1", "d1")] },
  }));
  assert.equal(next.reason, "all_excluded");
  store.close();
});

// ---- Task 10: harness_record optional assessments (F12 path/evidence/session part) ----
function mountHarnessRecord(): FakeToolDef {
  const pi = fakePi();
  tools(pi as never);
  const def = pi.tools.get("harness_record");
  assert.ok(def, "harness_record tool registered");
  return def!;
}
type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
async function runHarnessRecord(ctx: unknown, params: Record<string, unknown>): Promise<ToolResult> {
  const def = mountHarnessRecord() as unknown as {
    execute: (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: unknown) => Promise<ToolResult>;
  };
  return def.execute("rec-1", params, undefined, undefined, ctx);
}
function sha256Of(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function plain<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function learningSnapshot(cwd: string, workDir: string) {
  const db = new DatabaseSync(join(cwd, ".omp/harness/skill-telemetry.db"));
  try {
    return plain({
      traces: db.prepare("SELECT dispatch_id, payload_json FROM dispatch_traces ORDER BY dispatch_id").all(),
      observations: db.prepare("SELECT observation_id, payload_json FROM observations ORDER BY observation_id").all(),
      state: db.prepare("SELECT generation, payload_json FROM learning_state").all(),
      outcome: existsSync(join(workDir, "outcome.json")),
      lesson: existsSync(join(workDir, "lesson.md")),
      lessons: existsSync(join(cwd, ".omp/harness/lessons.jsonl")),
    });
  } finally { db.close(); }
}
const TEST_SESSION = "test-session";
async function harnessRecordFixture() {
  closeSkillTelemetryStores();
  const cwd = realpathSync(tempCwd());
  const workDir = join(cwd, ".omp", "work", "2026-11-09", "task");
  mkdirSync(workDir, { recursive: true });
  const ctx = fakeCtx(cwd);
  const sessionId = subagentSessionKey(cwd, TEST_SESSION)!;
  const store = getSkillTelemetryStore(cwd)!;
  assert.ok(store);
  const trace = store.prepareSubagentDispatch(dispatchInput({
    sessionId, envelope: { version: 1, goalId: "g1", candidates: [spec("p1", "d1")] },
  })).trace;
  const evidence = join(cwd, "evidence.txt");
  writeFileSync(evidence, "c1 PASS\nc2 PASS\n");
  const fx = { cwd, workDir, ctx, store, trace, sessionId, sha: sha256Of(evidence), before: undefined as unknown, snapshot: () => learningSnapshot(cwd, workDir) };
  fx.before = fx.snapshot();
  return fx;
}
type Fixture = Awaited<ReturnType<typeof harnessRecordFixture>>;
function learningAssessment(fx: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...assessment(fx.trace, { reportKind: "ready", candidatePass: [true, true] }),
    evidenceRefs: [{ path: "evidence.txt", sha256: fx.sha }],
    changedPaths: ["a.ts"],
    ...over,
  };
}
function learningParams(fx: Fixture, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dir: fx.workDir, tier: "M", goal: "parent assessed d1",
    acceptance: [{ id: "A1", joint: "verify", check: "node --test", pass: true, evidence: "ok" }],
    models: ["m"], tokens: 1, wall_ms: 1,
    subagentEvaluations: [learningAssessment(fx, over)],
    ...extra,
  };
}
function legacyParams(dir: string): Record<string, unknown> {
  return { dir, tier: "M", goal: "legacy", acceptance: [{ id: "A1", joint: "verify", check: "c", pass: false, evidence: "e" }], models: ["m"], tokens: 3, wall_ms: 4 };
}
function mutateStateFor(cwd: string, fn: (s: any) => void): void {
  const db = new DatabaseSync(join(cwd, ".omp/harness/skill-telemetry.db"));
  try {
    const s = JSON.parse((db.prepare("SELECT payload_json p FROM learning_state WHERE id=1").get() as { p: string }).p);
    fn(s);
    db.prepare("UPDATE learning_state SET payload_json=? WHERE id=1").run(JSON.stringify(s));
  } finally { db.close(); }
}
function storedTraceFor(cwd: string, id: string): Trace {
  const db = new DatabaseSync(join(cwd, ".omp/harness/skill-telemetry.db"));
  try { return JSON.parse((db.prepare("SELECT payload_json p FROM dispatch_traces WHERE dispatch_id=?").get(id) as { p: string }).p); } finally { db.close(); }
}

type Case = { name: string; make: (fx: Fixture) => { ctx: unknown; params: Record<string, unknown> } };
const F12_CASES: Case[] = [
  { name: "evidence traversal", make: (fx) => {
    const name = `outside-${process.pid}-${Math.random().toString(36).slice(2)}.txt`;
    const outside = join(fx.cwd, "..", name);
    writeFileSync(outside, "x");
    return { ctx: fx.ctx, params: learningParams(fx, { evidenceRefs: [{ path: `../${name}`, sha256: sha256Of(outside) }] }) };
  } },
  { name: "evidence absolute path outside workspace", make: (fx) => {
    const outside = join(tempCwd(), "e.txt");
    writeFileSync(outside, "x");
    return { ctx: fx.ctx, params: learningParams(fx, { evidenceRefs: [{ path: outside, sha256: sha256Of(outside) }] }) };
  } },
  { name: "evidence through a junction component (target inside workspace)", make: (fx) => {
    const real = join(fx.cwd, "real");
    mkdirSync(real);
    writeFileSync(join(real, "evidence.txt"), "c1 PASS\nc2 PASS\n");
    symlinkSync(real, join(fx.cwd, "linked"), "junction");
    return { ctx: fx.ctx, params: learningParams(fx, { evidenceRefs: [{ path: "linked/evidence.txt", sha256: fx.sha }] }) };
  } },
  { name: "evidence is a directory, not a regular file", make: (fx) => {
    mkdirSync(join(fx.cwd, "evdir"));
    return { ctx: fx.ctx, params: learningParams(fx, { evidenceRefs: [{ path: "evdir", sha256: fx.sha }] }) };
  } },
  { name: "evidence hash mismatch", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { evidenceRefs: [{ path: "evidence.txt", sha256: "0".repeat(64) }] }) }) },
  { name: "evidence file missing", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { evidenceRefs: [{ path: "nope.txt", sha256: fx.sha }] }) }) },
  { name: "foreign session", make: (fx) => ({ ctx: { ...fx.ctx, sessionManager: { getSessionId: () => "other-session" } }, params: learningParams(fx) }) },
  { name: "changed proposal carried in the assessment", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { goalId: "g1", mechanism: "different", change: "different", scope: ["z.ts"] }) }) },
  { name: "subagent caller", make: (fx) => ({ ctx: { ...fx.ctx, agent: { kind: "sub" } }, params: learningParams(fx) }) },
  { name: "missing parent session identity", make: (fx) => ({ ctx: { ...fx.ctx, sessionManager: { getSessionId: () => "" } }, params: learningParams(fx) }) },
  { name: "no sessionManager", make: (fx) => ({ ctx: { cwd: fx.cwd }, params: learningParams(fx) }) },
  { name: "reportKind outside the enum", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { reportKind: "success" }) }) },
  { name: "passed array with a non-boolean", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { candidate: { criterionIds: ["c1", "c2"], passed: ["true", true] } }) }) },
  { name: "gate flag not boolean", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { followed: 1 }) }) },
  { name: "availableAt not a safe integer", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { availableAt: 1.5 }) }) },
  { name: "criterion IDs duplicated", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, {
    baseline: { criterionIds: ["c1", "c1"], passed: [false, false] }, candidate: { criterionIds: ["c1", "c1"], passed: [true, true] } }) }) },
  { name: "criterion IDs in a different order", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, {
    baseline: { criterionIds: ["c2", "c1"], passed: [false, false] } }) }) },
  { name: "empty criterion set", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, {
    baseline: { criterionIds: [], passed: [] }, candidate: { criterionIds: [], passed: [] } }) }) },
  { name: "ready with a failed criterion", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, {
    candidate: { criterionIds: ["c1", "c2"], passed: [true, false] } }) }) },
  { name: "changedPaths not normalized", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { changedPaths: ["b.ts", "./a.ts"] }) }) },
  { name: "changedPaths traversal", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { changedPaths: ["../x.ts"] }) }) },
  { name: "unknown dispatch", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, { dispatchId: "f".repeat(64) }) }) },
  { name: "duplicate dispatch in one request", make: (fx) => {
    const p = learningParams(fx);
    const list = p.subagentEvaluations as unknown[];
    return { ctx: fx.ctx, params: { ...p, subagentEvaluations: [list[0], list[0]] } };
  } },
  { name: "empty assessment list", make: (fx) => ({ ctx: fx.ctx, params: { ...learningParams(fx), subagentEvaluations: [] } }) },
  { name: "destination dir outside .omp/work (traversal)", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, {}, { dir: join(fx.workDir, "..", "..", "..", "..") }) }) },
  { name: "destination dir outside the workspace", make: (fx) => {
    const other = join(tempCwd(), ".omp", "work", "x");
    mkdirSync(other, { recursive: true });
    return { ctx: fx.ctx, params: learningParams(fx, {}, { dir: other }) };
  } },
  { name: "destination dir missing (not created here)", make: (fx) => ({ ctx: fx.ctx, params: learningParams(fx, {}, { dir: join(fx.cwd, ".omp", "work", "missing") }) }) },
  { name: "destination outcome.json is a directory (not a regular file)", make: (fx) => {
    mkdirSync(join(fx.workDir, "outcome.json"));
    return { ctx: fx.ctx, params: learningParams(fx) };
  } },
  { name: "destination outcome.json is a junction", make: (fx) => {
    const target = join(fx.cwd, "jt");
    mkdirSync(target);
    symlinkSync(target, join(fx.workDir, "outcome.json"), "junction");
    return { ctx: fx.ctx, params: learningParams(fx) };
  } },
  { name: "destination through a junction component", make: (fx) => {
    const target = join(fx.cwd, "elsewhere");
    mkdirSync(target);
    const link = join(fx.cwd, ".omp", "work", "linked");
    symlinkSync(target, link, "junction");
    return { ctx: fx.ctx, params: learningParams(fx, {}, { dir: link }) };
  } },
];

test("F12: path, symlink, evidence hash, session and proposal violations reject before any learning write", async () => {
  for (const c of F12_CASES) {
    const fx = await harnessRecordFixture();
    const { ctx, params } = c.make(fx);
    fx.before = fx.snapshot(); // after the case's own filesystem setup (e.g. an outcome.json directory)
    await assert.rejects(() => runHarnessRecord(ctx, params), (err: Error) => {
      assert.match(err.message, /^harness_record: subagentEvaluations rejected: /, `${c.name}: ${err.message}`);
      return true;
    }, c.name);
    assert.deepEqual(fx.snapshot(), fx.before, `no learning write: ${c.name}`);
  }
  closeSkillTelemetryStores();
});

test("F12: a missing destination dir is an error and is not created", async () => {
  const fx = await harnessRecordFixture();
  const missing = join(fx.cwd, ".omp", "work", "missing");
  await assert.rejects(() => runHarnessRecord(fx.ctx, learningParams(fx, {}, { dir: missing })), /no such|missing|not exist/i);
  assert.equal(existsSync(missing), false);
  closeSkillTelemetryStores();
});

test("F12: a not-dispatched (all-excluded) trace is rejected before any learning write", async () => {
  const fx = await harnessRecordFixture();
  mutateStateFor(fx.cwd, (s) => {
    s.cooldowns[fx.trace.selectedDirectionArmId!] = { excludedThroughOpportunity: 100, failures: 1 };
  });
  const blocked = fx.store.prepareSubagentDispatch(dispatchInput({
    sessionId: fx.sessionId, toolCallId: "t-blocked", inputHash: "hb",
    envelope: { version: 1, goalId: "g1", candidates: [spec("p1", "d1")] },
  }));
  assert.equal(blocked.reason, "all_excluded");
  const before = fx.snapshot();
  await assert.rejects(() => runHarnessRecord(fx.ctx, learningParams(fx, { dispatchId: blocked.trace.dispatchId })), /not dispatched/);
  assert.deepEqual(fx.snapshot(), before);
  closeSkillTelemetryStores();
});

test("harness_record learning branch commits once, writes the projection, then the lesson; replay reuses bytes", async () => {
  const fx = await harnessRecordFixture();
  const lesson = { why_this_design: "parent-attested evidence", avoid_misconceptions: [{ similar_case: "worker self-score", why_wrong_there: "not independent", right_pattern_instead: "parent assessment" }] };
  const params = learningParams(fx, {}, { lesson });
  const r = await runHarnessRecord(fx.ctx, params);
  const outcomeFile = join(fx.workDir, "outcome.json");
  const operationId = evaluationOperationId(fx.sessionId, [fx.trace.dispatchId]);
  const projection = fx.store.findEvaluationProjection(operationId, fx.sessionId);
  assert.ok(projection);
  assert.equal(projection!.status, "flushed");
  assert.equal(projection!.destination, outcomeFile);
  const bytes = readFileSync(outcomeFile, "utf8");
  assert.equal(bytes, projection!.outcomeJson);
  const outcome = JSON.parse(bytes);
  assert.equal(outcome.goal, "parent assessed d1");
  assert.equal(typeof outcome.recorded_at, "string");
  assert.equal(r.details.replay, false);
  assert.equal(r.details.generation, 2);
  assert.ok(existsSync(join(fx.workDir, "lesson.md")));
  const lessonsFile = join(fx.cwd, ".omp/harness/lessons.jsonl");
  assert.equal(readFileSync(lessonsFile, "utf8").trim().split("\n").length, 1);
  const stored = storedTraceFor(fx.cwd, fx.trace.dispatchId);
  assert.equal(stored.assessmentStatus, "applied");
  assert.equal(stored.evaluationOperationId, operationId);
  assert.equal(stored.goalId, "g1", "goal comes from the persisted trace");

  // Replay: same canonical params; fresh telemetry/recorded_at would differ, original bytes are reused.
  const after = fx.snapshot();
  await new Promise((res) => setTimeout(res, 5));
  const again = await runHarnessRecord(fx.ctx, params);
  assert.equal(again.details.replay, true);
  assert.equal(readFileSync(outcomeFile, "utf8"), bytes, "replay keeps original bytes");
  assert.deepEqual(fx.snapshot(), after);
  assert.equal(readFileSync(lessonsFile, "utf8").trim().split("\n").length, 1, "replay does not append a lesson");

  // Same operation, changed request (different lesson text) conflicts before any write.
  await assert.rejects(() => runHarnessRecord(fx.ctx, learningParams(fx, {}, { lesson: { ...lesson, why_this_design: "changed" } })), /conflict/);
  assert.deepEqual(fx.snapshot(), after);
  closeSkillTelemetryStores();
});

test("harness_record: own post-commit flush failure reports committed + pending; another operation's pending projection reports NOT committed", async () => {
  const fx = await harnessRecordFixture();
  // Dispatch B before any projection is pending (a pending projection blocks learning dispatch).
  const traceB = fx.store.prepareSubagentDispatch(dispatchInput({
    sessionId: fx.sessionId, toolCallId: "t-b", inputHash: "hb",
    envelope: { version: 1, goalId: "g1", candidates: [spec("p1", "d2")] },
  })).trace;
  // Test-only seam on the cached production store: every projection write fails.
  const hooks = (fx.store as any).testHooks as TestHooks;
  hooks.writeProjection = () => false;

  // (b) Operation A commits, then its own flush fails.
  const opA = evaluationOperationId(fx.sessionId, [fx.trace.dispatchId]);
  const a = await runHarnessRecord(fx.ctx, learningParams(fx));
  assert.equal(a.details.committed, true);
  assert.equal(a.details.projection, "pending");
  assert.equal(a.details.operationId, opA);
  assert.equal(a.details.generation, 3, "A's own committed generation (dispatch B was generation 2)");
  assert.match(a.content[0].text, /committed at generation 3 \(operation [0-9a-f]{64}\); outcome projection PENDING/);
  assert.equal(fx.store.findEvaluationProjection(opA, fx.sessionId)!.status, "pending");
  assert.equal(existsSync(join(fx.workDir, "outcome.json")), false);
  assert.equal(storedTraceFor(fx.cwd, fx.trace.dispatchId).assessmentStatus, "applied");

  // (a) Operation B: the store's pre-mutation drain fails on A, so B's transaction rolls back.
  const before = fx.snapshot();
  const traceBBefore = storedTraceFor(fx.cwd, traceB.dispatchId);
  const b = await runHarnessRecord(fx.ctx, learningParams(fx, { dispatchId: traceB.dispatchId }));
  const opB = evaluationOperationId(fx.sessionId, [traceB.dispatchId]);
  assert.equal(b.details.committed, false);
  assert.equal(b.details.rolledBack, true);
  assert.equal(b.details.operationId, opB);
  assert.equal(b.details.blockingOperationId, opA);
  assert.equal("generation" in b.details, false, "no generation reported for a rolled-back request");
  assert.match(b.content[0].text, /NOT committed \(rolled back\)/);
  assert.doesNotMatch(b.content[0].text, /committed at generation/);
  assert.ok(b.content[0].text.includes(opA));
  assert.deepEqual(storedTraceFor(fx.cwd, traceB.dispatchId), traceBBefore, "B's trace untouched");
  assert.deepEqual(fx.snapshot(), before, "no learning write for B");
  assert.equal(fx.store.findEvaluationProjection(opB, fx.sessionId), null);

  // Once writes work again, B commits and A's original bytes are flushed first.
  delete hooks.writeProjection;
  const b2 = await runHarnessRecord(fx.ctx, learningParams(fx, { dispatchId: traceB.dispatchId }));
  assert.equal(b2.details.committed, true);
  assert.equal(fx.store.findEvaluationProjection(opA, fx.sessionId)!.status, "flushed");
  closeSkillTelemetryStores();
});

test("harness_record learning branch accepts <cwd>/.omp/work itself as the destination dir", async () => {
  const fx = await harnessRecordFixture();
  const workRoot = join(fx.cwd, ".omp", "work");
  const r = await runHarnessRecord(fx.ctx, learningParams(fx, {}, { dir: workRoot }));
  assert.equal(r.details.file, join(workRoot, "outcome.json"));
  assert.ok(existsSync(join(workRoot, "outcome.json")));
  closeSkillTelemetryStores();
});

test("harness_record: a lesson write error is reported separately and does not undo learning", async () => {
  const fx = await harnessRecordFixture();
  mkdirSync(join(fx.workDir, "lesson.md")); // a directory in the way makes the lesson write fail after the flush
  const lesson = { why_this_design: "w", avoid_misconceptions: [{ similar_case: "a", why_wrong_there: "b", right_pattern_instead: "c" }] };
  const r = await runHarnessRecord(fx.ctx, learningParams(fx, {}, { lesson }));
  assert.equal(typeof r.details.lesson_error, "string");
  assert.equal(r.details.replay, false);
  assert.equal(storedTraceFor(fx.cwd, fx.trace.dispatchId).assessmentStatus, "applied");
  assert.ok(existsSync(join(fx.workDir, "outcome.json")));
  closeSkillTelemetryStores();
});

test("legacy harness_record without subagentEvaluations never touches the learning store (even from a subagent)", async () => {
  const fx = await harnessRecordFixture();
  const r = await runHarnessRecord({ ...fx.ctx, agent: { kind: "sub" } }, legacyParams(fx.workDir));
  assert.match(r.content[0].text, /acceptance: 1 total, 1 failed/);
  const outcome = JSON.parse(readFileSync(join(fx.workDir, "outcome.json"), "utf8"));
  assert.equal(outcome.goal, "legacy");
  assert.deepEqual({ ...(fx.snapshot() as object), outcome: false }, fx.before, "no learning table changed");
  closeSkillTelemetryStores();
});

// ---- Task 13 (F11): evaluate -> commit -> next dispatch smoke through the registered hooks ----
// Only the host is a stub (fakePi + a recorder of the input reaching the host tool boundary);
// the superagent hooks, harness_record and the SQLite store are production modules.
const F11_OPEN = "<subagent-policy-memory>";

function f11Envelope(): string {
  const candidates = ["dir-a", "dir-b"].map((d) => ({
    parentId: null, directionId: d, mechanism: `m-${d}`, change: `c-${d}`, scope: ["a.ts"], prompt: `prompt for ${d}`,
  }));
  return `<subagent-candidates>${JSON.stringify({ version: 1, goalId: "g1", candidates })}</subagent-candidates>`;
}

function f11Host() {
  closeSkillTelemetryStores();
  const cwd = realpathSync(tempCwd());
  const workDir = join(cwd, ".omp", "work", "2026-11-09", "task");
  mkdirSync(workDir, { recursive: true });
  const evidence = join(cwd, "evidence.txt");
  writeFileSync(evidence, "c1 FAIL\nc2 FAIL\n");
  const pi = fakePi();
  createSuperagent(pi as never);
  tools(pi as never);
  const ctx = fakeCtx(cwd);
  const sessionId = subagentSessionKey(cwd, TEST_SESSION)!;
  const dbFile = join(cwd, ".omp/harness/skill-telemetry.db");
  const readRows = <R>(fn: (db: DatabaseSync) => R): R => {
    const db = new DatabaseSync(dbFile);
    try { return fn(db); } finally { db.close(); }
  };
  const fire = async (name: string, event: unknown): Promise<any> => {
    const list = pi.handlers.get(name) ?? [];
    assert.ok(list.length > 0, `no handler for ${name}`);
    return list[0](event, ctx);
  };
  return {
    // Host tool boundary: the input that the hook hands to the `task` tool.
    async dispatchTask(toolCallId: string) {
      const original = { agent: "coder", task: `# Goal\nShip\n\n${f11Envelope()}` };
      const result = await fire("tool_call", { toolName: "task", toolCallId, input: original });
      assert.ok(result?.input, `dispatch must rewrite input: ${JSON.stringify(result)}`);
      const receivedInput = JSON.stringify(result.input);
      // Read the committed row from SQLite, not from any in-memory cache.
      const trace = readRows((db) => JSON.parse((db.prepare("SELECT payload_json p FROM dispatch_traces WHERE dispatch_id=?")
        .get(dispatchId(sessionId, toolCallId, 0)) as { p: string }).p)) as Trace;
      const selected = trace.candidates.find((c) => directionArmId("g1", null, c.directionId) === trace.selectedDirectionArmId);
      return { receivedInput, trace, selectedDirectionId: selected!.directionId };
    },
    async recordFailure(trace: Trace) {
      const def = pi.tools.get("harness_record") as unknown as {
        execute: (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: unknown) => Promise<ToolResult>;
      };
      const fx = { workDir, sha: sha256Of(evidence), trace } as unknown as Fixture;
      const params = learningParams(fx, { reportKind: "failed", candidate: { criterionIds: ["c1", "c2"], passed: [false, false] } });
      const r = await def.execute("rec-f11", params, undefined, undefined, ctx);
      assert.equal(r.details.committed, true);
      return r;
    },
    reopen() { closeSkillTelemetryStores(); },
    state: () => readRows((db) => JSON.parse((db.prepare("SELECT payload_json p FROM learning_state WHERE id=1").get() as { p: string }).p)),
  };
}

test("F11: evaluate -> commit -> next dispatch receives new revision and cooldown changes selection", async () => {
  const host = f11Host();
  const first = await host.dispatchTask("call-1");
  const failed = first.selectedDirectionId;
  const other = failed === "dir-a" ? "dir-b" : "dir-a";
  const armOrder = ["dir-a", "dir-b"].sort((x, y) => (directionArmId("g1", null, x) < directionArmId("g1", null, y) ? -1 : 1));
  assert.equal(failed, armOrder[0], "cold tie resolves to the lexically smallest direction arm id");
  assert.ok(first.receivedInput.includes(`prompt for ${failed}`));

  await host.recordFailure(first.trace);
  const failedArm = directionArmId("g1", null, failed);
  const cd = host.state().cooldowns[failedArm];
  assert.ok(cd, "failure committed a cooldown for the failed direction in SQLite");

  const second = await host.dispatchTask("call-2");
  assert.notEqual(second.receivedInput, first.receivedInput);
  assert.ok(second.receivedInput.includes(F11_OPEN));
  assert.notEqual(second.trace.memoryRevision, first.trace.memoryRevision, "next dispatch carries the new revision");
  assert.equal(second.selectedDirectionId, other, "failed direction is not selected during cooldown");
  assert.ok(!second.receivedInput.includes(`prompt for ${failed}`));
  assert.ok(second.receivedInput.includes(`prompt for ${other}`));

  // Close and reopen: the stub re-reads the persisted rows; the cooldown survived unchanged.
  host.reopen();
  assert.deepEqual(host.state().cooldowns[failedArm], cd, "cooldown persisted across reopen");
  const third = await host.dispatchTask("call-3");
  assert.ok(third.receivedInput.includes(F11_OPEN));
  // Persisted rows dictate: opportunity count is still <= excludedThroughOpportunity, so dir-b again.
  assert.equal(third.selectedDirectionId, other, "persisted cooldown still excludes the failed direction after reopen");
  assert.ok(!third.receivedInput.includes(`prompt for ${failed}`));
  closeSkillTelemetryStores();
});
