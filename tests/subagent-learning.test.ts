import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillTelemetryStore, getSkillTelemetryStore, closeSkillTelemetryStores } from "../src/skill-telemetry.ts";

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
