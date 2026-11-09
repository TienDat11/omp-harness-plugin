import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillTelemetryStore, getSkillTelemetryStore, closeSkillTelemetryStores,
  parentArmId, directionArmId, dispatchId, observationId, failureKey,
  normalizeScope, validateCandidateEnvelope, hashId,
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
