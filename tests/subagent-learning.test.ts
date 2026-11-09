import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillTelemetryStore, getSkillTelemetryStore, closeSkillTelemetryStores,
  parentArmId, directionArmId, dispatchId, observationId, failureKey,
  normalizeScope, validateCandidateEnvelope, hashId, klUcbIndex, evaluateAssessment,
  applyFailureCooldown, pruneExpiredCooldowns, capCards,
  applyEvaluationToState, getSubagentPolicyMemory,
  type Assessment, type Trace, type LearningStateJSON,
} from "../src/skill-telemetry.ts";

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
function openStore(): SkillTelemetryStore {
  const dbPath = dbPathFor(tempCwd());
  const store = new SkillTelemetryStore(dbPath);
  storePaths.set(store, dbPath);
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
function seededWithDispatch(over: { parentId?: string | null } = {}): { store: SkillTelemetryStore; trace: Trace } {
  const store = openStore();
  const parentId = "parentId" in over ? over.parentId! : "p1";
  const env = { version: 1 as const, goalId: "g1", candidates: [spec(parentId, "d1")] };
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: env }));
  return { store, trace: r.trace };
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
  assert.equal(s.memory.lessons[0].contradictionCount, 2);
  s = applyEvaluation(s, t, failureEval(t), 14);
  assert.equal(s.memory.lessons.length, 0, "retire only, not recreated by the same assessment");
  assert.equal(s.memory.targetCatalog.length, 0);

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
