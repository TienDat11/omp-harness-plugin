# Subagent Self-Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let omp-harness choose parent and direction for subagent dispatch from independently assessed outcomes, and inject the learned policy memory into the next worker input, with transactional and restart-safe state (acceptance F1–F12).

**Architecture:** One `SkillTelemetryStore` per canonical cwd owns a SQLite file with three new tables (`dispatch_traces`, `observations`, `learning_state`) next to the existing `skill_runs`/`skill_stats`. Selection is hierarchical KL-UCB (parent first, then direction). Only the parent coordinator submits `subagentEvaluations`; every write runs in one `BEGIN IMMEDIATE` transaction with a generation CAS, and `outcome.json` is a pending projection drained under the same lock. Superagent hooks parse a candidate envelope, replace it with the selected prompt, and inject a bounded memory block.

**Tech Stack:** TypeScript ESM, Node >=24 (`node:sqlite` `DatabaseSync`), `node:test`, zod (existing in `src/tools.ts`), existing `writeTextFileAtomic` (`src/state.ts`), existing `computeAcceptedTaskCost` (`src/telemetry.ts`).

**Spec:** `D:\omp-harness\SUBAGENT_SELF_IMPROVED.md` (untracked, Vietnamese; read §1–§12 at G0. Copy it into the worktree as `docs/superpowers/specs/SUBAGENT_SELF_IMPROVED.md` in Task 0 so the plan and spec travel together.) Plan revision = SHA-256 of that file, recorded in Task 0.

## Global Constraints

- No new dependency, no second database, no embedding, no zeromem migration, no retry framework, no model routing change.
- Do not change the three existing tables (`skill_runs`, `skill_stats` and their indexes) or the `recordRun`/`queryLift` behavior (F1).
- Do not change `src/state.ts`, `src/policy.ts`, `src/read-budget.ts`, `src/memory.ts`, `src/telemetry.ts`, `package.json`, lockfile or `harness.manifest.json` semantics. Reuse `writeTextFileAtomic` (boolean return) and `computeAcceptedTaskCost` as-is.
- Learning tables are seeded with `INSERT OR IGNORE` (never reset existing state).
- Limits: candidates 1–8; unique `(parentId, directionId)`; strings nonempty; prompt ≤ 4000 UTF-16 code units; IDs/mechanism/change ≤ 512; scope ≤ 8 paths, each ≤ 1024; memory `maxChars` integer ≥ 256, default 8192 UTF-16 including tags and revision; cooldown = 3 opportunities; card cap 50; lessons cap 6; targets per lesson ≤ 8; targetCatalog ≤ 8 files.
- Legacy `harness_record` (no `subagentEvaluations`) and legacy dispatch (no envelope) keep existing behavior byte-for-byte where the spec says so.
- Every commit message ends with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.
- Before editing any exported symbol: LSP references; before editing or deleting a function: `ua_impact`.
- Verification command for each phase: `node --test tests/skill-telemetry.test.ts tests/stack-router.test.ts tests/subagent-learning.test.ts tests/superagent.test.ts`. Full `npm test` and `npm run verify` only in Task 14.

## Review Focus

Five input classes the spec implies but no task exercises by default; each line is pinned by a test in the owning task.

1. Scope or evidence path with `..`, an absolute path, a drive letter, or a symlink component → rejected before any learning write (Task 3, Task 10).
2. Candidate prompt or memory text containing `</subagent-candidates>` or `<` → candidate JSON still parses; memory output escapes `<` as `\u003c` (Task 3, Task 8).
3. Corrupt `learning_state.payload_json` (invalid JSON or generation mismatch with the row) → learning fails closed and the DB is not reseeded (Task 2, Task 9).
4. Task item with no supported string field (`task`, `assignment`, `description`), or a single-task input with a non-string `task` → legacy behavior, no crash, no trace (Task 11).
5. Envelope present both in shared `input.context` and in a batch item → ambiguous batch, rejected (Task 11).

---

## Phase P1 — Store and cache

### Task 0: Baseline and spec capture

**Files:**
- Create: `docs/superpowers/specs/SUBAGENT_SELF_IMPROVED.md` (copy of the spec)
- Create: `docs/superpowers/plans/2026-11-09-subagent-self-improvement.md` (this file; already present)

**Interfaces:**
- Consumes: none
- Produces: recorded baseline counts used by every later phase gate

- [ ] **Step 1: Record the spec hash and baseline**

Run: `node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('docs/superpowers/specs/SUBAGENT_SELF_IMPROVED.md')).digest('hex'))"`
Expected: a 64-character hex digest. Write it into the plan header as the plan revision.

- [ ] **Step 2: Record the existing test baseline**

Run: `npm test`
Expected: pass count recorded (last known: 382 pass, 0 fail). If the count differs, record the new number as the baseline; do not proceed if there are failures.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/SUBAGENT_SELF_IMPROVED.md docs/superpowers/plans/2026-11-09-subagent-self-improvement.md
git commit -m "docs: add subagent self-improvement spec and plan" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 1: Three learning tables and idempotent seed

**Files:**
- Modify: `src/skill-telemetry.ts` (constructor at lines ~14–22, after existing DDL)
- Test: `tests/subagent-learning.test.ts` (create)

**Interfaces:**
- Consumes: existing `SkillTelemetryStore` constructor and `close()`
- Produces: tables `dispatch_traces`, `observations`, `learning_state` (DDL exactly as spec §4); `learning_state` row `id=1` with `generation=0`. Later tasks use the private accessor `readLearningStateRow(): { generation: number; payload: LearningStateJSON }` (throws on malformed row or generation mismatch).

- [ ] **Step 1: Write the failing test (F1 part)**

```ts
// tests/subagent-learning.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillTelemetryStore } from "../src/skill-telemetry.ts";

function tempCwd(): string { return mkdtempSync(join(tmpdir(), "learn-")); }
function tableNames(cwd: string): string[] {
  const db = new DatabaseSync(join(cwd, ".omp/harness/skill-telemetry.db"));
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  db.close();
  return rows.map((r) => r.name);
}

test("F1: new DB has existing and three learning tables, seeded generation 0", () => {
  const cwd = tempCwd();
  const store = new SkillTelemetryStore(cwd);
  store.close();
  const names = tableNames(cwd);
  for (const t of ["skill_runs", "skill_stats", "dispatch_traces", "observations", "learning_state"]) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  const reopened = new SkillTelemetryStore(cwd);
  reopened.close();
  const db = new DatabaseSync(join(cwd, ".omp/harness/skill-telemetry.db"));
  const row = db.prepare("SELECT generation FROM learning_state WHERE id=1").get() as { generation: number };
  assert.equal(row.generation, 0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL with `missing dispatch_traces`.

- [ ] **Step 3: Add the three DDL statements verbatim from spec §4 to the constructor**

Execute the DDL block from spec §4 (CREATE TABLE ×3 plus the `INSERT OR IGNORE` seed) after the existing `skill_runs`/`skill_stats` statements, in the same `exec` call sequence. Do not rename or alter existing tables. Add the `readLearningStateRow()` private accessor: it parses `payload_json`, requires `payload.generation === row.generation`, and throws `Error("learning_state corrupt")` otherwise. It never reseeds.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-learning.test.ts tests/skill-telemetry.test.ts`
Expected: PASS. Existing `skill-telemetry` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): add dispatch, observation and learning state tables" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 2: Per-cwd cache, close, and stack-router migration

**Files:**
- Modify: `src/skill-telemetry.ts` (export `getSkillTelemetryStore(cwd: string): SkillTelemetryStore | null`, `closeSkillTelemetryStores(): void`)
- Modify: `src/stack-router.ts:589` (remove private `const stores` Map), `:601–608` (`storeFor` becomes a thin call to `getSkillTelemetryStore`), callers at `:621`, `:953`, `:1006`, shutdown at `:990–997`
- Test: `tests/stack-router.test.ts` (modify)

**Interfaces:**
- Consumes: Task 1 constructor
- Produces: `getSkillTelemetryStore(cwd)` returns the same instance for the same canonical cwd; returns `null` on constructor failure (logged) and does not cache the null; `closeSkillTelemetryStores()` closes all and clears the map in `finally`.

- [ ] **Step 1: Write failing tests**

```ts
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
```

Add to `tests/stack-router.test.ts`: a regression that the shutdown path still returns early for subagent processes (`isSub`) and that legacy telemetry still reports null semantics when `getSkillTelemetryStore` returns null.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts tests/stack-router.test.ts`
Expected: FAIL with `getSkillTelemetryStore is not a function` or equivalent.

- [ ] **Step 3: Implement the cache**

Canonical cwd = `path.resolve` plus `realpathSync` when the path exists. Module-level `Map<string, SkillTelemetryStore>`. Migrate every `storeFor` caller to the export; delete the private Map and its shutdown clear in `stack-router.ts` and call `closeSkillTelemetryStores()` in a `try/finally` at the same place, keeping the `isSub` early return.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts tests/stack-router.test.ts tests/skill-telemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts src/stack-router.ts tests/subagent-learning.test.ts tests/stack-router.test.ts
git commit -m "refactor(telemetry): share per-cwd skill telemetry store cache" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

**P1 gate:** all four focused test files pass; `storeFor` callers counted by LSP references equal the callers migrated; no reference to the removed Map remains.

---

## Phase P2 — Learning core

### Task 3: Types, hashing, IDs and boundary validation

**Files:**
- Modify: `src/skill-telemetry.ts` (types from spec §4; `hashId(parts: unknown[]): string`; `normalizeScope`; `validateCandidateEnvelope(raw: unknown): CandidateEnvelope`; `validateCandidateSpec`)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: spec §4 types verbatim
- Produces: `parentArmId(goalId, parentId)`, `directionArmId(goalId, parentId, directionId)`, `dispatchId(sessionId, toolCallId, itemIndex)`, `observationId(dispatchId, target, armId)`, `failureKey(goalId, parentId, directionId, mechanism, change, scope)`, `validateCandidateEnvelope(raw): CandidateEnvelope` (throws `RangeError` with a field name)

- [ ] **Step 1: Write failing tests**

```ts
test("arm IDs are stable and null parent is a valid arm", () => {
  const a = parentArmId("g1", null);
  assert.equal(a, parentArmId("g1", null));
  assert.notEqual(a, parentArmId("g1", "p1"));
});

test("scope normalization rejects traversal, absolute, drive and symlink-looking paths", () => {
  for (const bad of ["../x", "/abs/x", "C:/x", "C:\\x", "a/../../b"]) {
    assert.throws(() => normalizeScope([bad]), RangeError);
  }
  assert.deepEqual(normalizeScope(["b.ts", "a/c.ts", "a/c.ts"]), ["a/c.ts", "b.ts"]);
});

test("envelope boundaries: version, count, duplicate pair, prompt length, scope count", () => {
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, version: 2 }), RangeError);
  assert.throws(() => validateCandidateEnvelope({ ...okEnvelope, candidates: [] }), RangeError);
  assert.throws(() => validateCandidateEnvelope(withDuplicatePair(okEnvelope)), RangeError);
  assert.throws(() => validateCandidateEnvelope(withPrompt(okEnvelope, "x".repeat(4001))), RangeError);
  assert.throws(() => validateCandidateEnvelope(withScope(okEnvelope, 9)), RangeError);
});

test("prompt containing a closing envelope tag still validates as data", () => {
  const env = withPrompt(okEnvelope, "see </subagent-candidates> here");
  assert.doesNotThrow(() => validateCandidateEnvelope(env));
});
```

`okEnvelope` is a valid envelope with two candidates; define it in the test file with `parentId` values `null` and `"p1"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement**

Hash = SHA-256 of UTF-8 `JSON.stringify(array)`, hex. Domain tags are the first element as in spec §4. Validation is a pure function; it does not touch the DB.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): add typed candidate envelope validation and IDs" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 4: KL-UCB math (F2)

**Files:**
- Modify: `src/skill-telemetry.ts` (export `klUcbIndex` exactly as spec §5)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `klUcbIndex(successes, n, T, c?, tolerance?, maxIterations?): number`

- [ ] **Step 1: Write failing tests (F2)**

```ts
test("F2: KL-UCB values and domain checks", () => {
  assert.ok(Math.abs(klUcbIndex(0, 1, 1) - 0.704692) < 1e-5);
  assert.equal(klUcbIndex(1, 1, 1), 1);
  assert.equal(klUcbIndex(0, 0, 0), 1);
  for (const [s, n, T] of [[2, 0, 5], [0, 2, 1], [Number.NaN, 1, 1], [1, Number.POSITIVE_INFINITY, 2], [-1, 1, 1], [0.5, 1, 1]] as const) {
    assert.throws(() => klUcbIndex(s as number, n as number, T as number), RangeError);
  }
  assert.ok(klUcbIndex(8, 10, 20) > klUcbIndex(2, 10, 20));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL (`klUcbIndex is not a function`).

- [ ] **Step 3: Implement by copying the spec §5 function body**

The spec body is the algorithm; copy it verbatim with the `export` keyword. Do not change the bisection.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): add hierarchical KL-UCB index" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 5: Dispatch selection, batch, replay and all-excluded (F3, F5 dispatch part, F6 all-excluded)

**Files:**
- Modify: `src/skill-telemetry.ts` (`prepareSubagentDispatch(input: DispatchInput): DispatchResult`, `prepareSubagentDispatchBatch(inputs: DispatchInput[]): DispatchResult[]`, private `selectSubagentDirection` and a private transaction helper used by both)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: Task 3 IDs/validation, Task 4 `klUcbIndex`, Task 1 `readLearningStateRow()`
- Produces: `DispatchResult` (spec §4); trace row written to `dispatch_traces` with `assessmentStatus` `pending` or `not_dispatched`

Selection order (spec §5): drain pending first (Task 9 provides `drainPending`; in this task drain is a no-op stub that Task 9 fills), load fresh state, replay check, increment `opportunityCounters[T]` once per distinct supplied parent and distinct supplied direction, drop direction whose `excludedThroughOpportunity >= T`... precisely: exclude while `T <= excludedThroughOpportunity`; sort parent index desc, direction index desc, `directionArmId` lex asc; choose first.

- [ ] **Step 1: Write failing tests**

```ts
test("F3: distinct parents produce distinct parentArmIds; cold tie resolves lexically", () => {
  const store = openStore();
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: envTwoParents() }));
  assert.equal(r.reason, "selected");
  assert.ok(r.selected);
  assert.notEqual(r.trace.candidates[0].parentArmId, r.trace.candidates[1].parentArmId);
  const again = store.prepareSubagentDispatch(dispatchInput({ toolCallId: "t2", envelope: envTwoParents() }));
  assert.equal(again.trace.candidates.length, 2);
});

test("F5: same dispatchId and same inputHash replays without touching T or n", () => {
  const store = openStore();
  const a = store.prepareSubagentDispatch(dispatchInput({}));
  const counters = store.debugLearningState().opportunityCounters; // test-only accessor
  const b = store.prepareSubagentDispatch(dispatchInput({}));
  assert.deepEqual(b.trace.selectedDirectionArmId, a.trace.selectedDirectionArmId);
  assert.deepEqual(store.debugLearningState().opportunityCounters, counters);
});

test("F5: same dispatchId with different inputHash rejects before any mutation", () => {
  const store = openStore();
  store.prepareSubagentDispatch(dispatchInput({}));
  assert.throws(() => store.prepareSubagentDispatch(dispatchInput({ inputHash: "other" })), /dispatch conflict/);
});

test("F6: all-excluded persists trace and counters, returns all_excluded, no observation", () => {
  // Arrange: one direction with excludedThroughOpportunity far ahead (seeded via debug accessor)
  const store = openStoreWithCooldown(singleDirection(), 100);
  const r = store.prepareSubagentDispatch(dispatchInput({ envelope: envOneDirection() }));
  assert.equal(r.reason, "all_excluded");
  assert.equal(r.selected, null);
  assert.equal(r.trace.assessmentStatus, "not_dispatched");
  assert.equal(r.trace.selectedDirectionArmId, null);
  assert.equal(store.countObservations(), 0);
});

test("batch: any item all-excluded persists every item's selection and counters; none is dispatched", () => {
  const store = openStore();
  const results = store.prepareSubagentDispatchBatch([itemA(), itemBExcluded()]);
  assert.equal(results.length, 2);
  assert.ok(results.some((x) => x.reason === "all_excluded"));
});

test("counter overflow rejects and rolls back", () => {
  const store = openStoreWithT(Number.MAX_SAFE_INTEGER);
  assert.throws(() => store.prepareSubagentDispatch(dispatchInput({})), /safe integer/);
  assert.equal(store.debugLearningState().generation, 0);
});
```

`debugLearningState()`, `countObservations()`, `openStoreWithCooldown`, `openStoreWithT` are test helpers that write the DB through the store's own private accessor (a `@internal` method guarded by `NODE_ENV==="test"`-free design: expose them as exported test helpers from `skill-telemetry.ts` named `__testOnly*`). Declare the helpers in the test file itself, reading the SQLite row directly with `DatabaseSync`; do not add public API for them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL (`prepareSubagentDispatch is not a function`).

- [ ] **Step 3: Implement**

One private helper `runWriterTransaction(fn)` (BEGIN IMMEDIATE, `started` flag, ROLLBACK only if `started`, COMMIT, `started=false`) used by single and batch. Batch: normalize/validate every item before any write; then one transaction; one generation CAS for the batch. Replay: look up trace by `dispatchId`; same `inputHash` → return recorded trace; different → `throw new Error("dispatch conflict")` before mutation. Trace persists `memoryRevision` and `memoryText` as computed at the time of selection (memory rendering comes from Task 8; until Task 8 lands, use `""` and `memoryRevision = "none"`, replaced in Task 8).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): select parent and direction for subagent dispatch" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 6: Assessment gates, observations and materialized arms (F4)

**Files:**
- Modify: `src/skill-telemetry.ts` (private `evaluateAssessment(trace, assessment): { kind: "terminal_success" | "terminal_failure" | "skip"; delta: number; rows: Observation[] }`, and the arm update used inside the commit transaction of Task 9)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: Task 5 trace shape; `Assessment` (spec §4)
- Produces: `evaluateAssessment(...)` pure; observations inserted only by the Task 9 commit helper

Gate rules (spec §6): followed && attributable && valid && statistic defined. `valid = allChecksCompleted && !measurementError && evidenceRefs.length > 0`. `statistic = (candidatePassCount − baselinePassCount)/N`. Criterion sets must have the same ordered IDs, equal length N>0. Terminal success requires `reportKind === "ready"` and candidate all-pass; terminal failure requires the four gates true and reportKind in failed/blocked/dropped; `ready` with a failed criterion → reject (throw); any gate false/unknown → skip. Partial improvement failure (delta > 0) → terminal failure with no card (Task 7). Evidence file-level validation (paths, SHA) is Task 10; here `evidenceRefs` are taken as already validated.

- [ ] **Step 1: Write failing tests (F4)**

```ts
test("F4: success writes exactly two observations with distinct IDs", () => {
  const { store, trace } = seededWithDispatch();
  const out = store.evaluateOnlyForTest(assessment(trace, { reportKind: "ready", candidatePass: [true, true] }));
  assert.equal(out.kind, "terminal_success");
  assert.equal(out.rows.length, 2);
  assert.notEqual(out.rows[0].observationId, out.rows[1].observationId);
  assert.deepEqual(out.rows.map((r) => r.target).sort(), ["direction", "parent"]);
});

test("F4: failure writes two zero observations", () => {
  const { trace, store } = seededWithDispatch();
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "failed", candidatePass: [false, false] }));
  assert.equal(out.kind, "terminal_failure");
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

test("F4: partial improvement failure writes zero rows-as-failure but no card", () => {
  const { trace } = seededWithDispatch();
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "failed", baselinePass: [false, false], candidatePass: [true, false] }));
  assert.equal(out.kind, "terminal_failure");
  assert.equal(out.delta > 0, true);
});

test("F4: null baseline parent is valid", () => {
  const { trace } = seededWithDispatch({ parentId: null });
  const out = evaluateAssessment(trace, assessment(trace, { reportKind: "ready", candidatePass: [true] }));
  assert.equal(out.kind, "terminal_success");
});
```

`seededWithDispatch` builds a store with one dispatch via Task 5 and returns the trace; `assessment(trace, overrides)` builds a valid `Assessment` with `evidenceRefs: [{ path: "x", sha256: "y" }]`, `followed: true`, `attributable: true`, `allChecksCompleted: true`, `measurementError: false`, `availableAt: 1`, and `criterionIds: ["c1","c2"]`. Define these helpers in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL (`evaluateAssessment` not defined).

- [ ] **Step 3: Implement the pure evaluator and the arm delta logic**

Keep `evaluateAssessment` pure (no DB access). Arms are updated only by the Task 9 transaction, using `successes += value; n += 1` for each new row.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): evaluate independent assessment gates" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 7: Failure cards and cooldown (F6)

**Files:**
- Modify: `src/skill-telemetry.ts` (private `recordFailureCard(state, trace, delta)`, `pruneCooldowns(state)`, card eviction)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: Task 6 `evaluateAssessment` kind/delta; Task 5 selection filter
- Produces: state mutations on `LearningStateJSON` (`cards`, `cooldowns`), applied inside the Task 9 transaction

Rules (spec §6): eligible non-improving failure (terminal failure with delta ≤ 0) creates or updates card by `failureKey`; increments `cooldowns[directionArmId].failures` and sets `excludedThroughOpportunity = currentT + 3`. Duplicate/SKIP/restart never renews. Card cap 50, evict smallest `lastSeenAt`, tie lex smallest `failureKey`; eviction never deletes an active cooldown. Before selection: delete cooldown entries where `T > excludedThroughOpportunity`.

- [ ] **Step 1: Write failing tests (F6)**

```ts
test("F6: failure sets cooldown T+3 and excludes next three opportunities only", () => {
  const store = openStore();
  const d0 = store.prepareSubagentDispatch(dispatchInput({ toolCallId: "a", envelope: envOneDirection() }));
  store.commitFailureFor(d0.trace.dispatchId); // Task 9 commit helper through public commit API
  const excluded: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const r = store.prepareSubagentDispatch(dispatchInput({ toolCallId: `n${i}`, envelope: envOneDirection() }));
    excluded.push(r.reason);
  }
  assert.deepEqual(excluded, ["all_excluded", "all_excluded", "all_excluded", "selected"]);
});

test("F6: duplicate failure and restart do not renew cooldown", () => {
  // commit the same failure twice (replay) and reopen store; excludedThroughOpportunity unchanged
});

test("F6: card cap 50 keeps active cooldown", () => {
  // fill 51 failures; the one whose cooldown is active is never evicted from cooldowns
});
```

Write the three tests fully with the helper names used in Task 5/9 (`openStore`, `dispatchInput`, `envOneDirection`, `commitFailureFor` as a test helper that calls the Task 9 public `commitSubagentEvaluationBatch` with a failure assessment). Replace the comment bodies with the concrete asserts before running.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL (cooldown not set).

- [ ] **Step 3: Implement**

`pruneCooldowns` runs at the start of selection (Task 5 path), after drain. `recordFailureCard` updates `firstSeenAt` only on insert. Eviction sorts cards by `(lastSeenAt asc, failureKey lex asc)` and removes from `cards` only. Cooldowns live in a separate map (`cooldowns`), so evicting a card never touches an active cooldown entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): record failure direction cards and cooldown" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 8: Deterministic memory and bounded rendering (F9)

**Files:**
- Modify: `src/skill-telemetry.ts` (`getSubagentPolicyMemory(state, goalId, maxChars = 8192): string` pure; lesson update helper `updateLessons(state, evaluation, now)`; target catalog rebuild)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: `LearningStateJSON.memory` (spec §4); Task 6 evaluation kind and failed criterion IDs
- Produces: `getSubagentPolicyMemory(state, goalId, maxChars)`; `memoryRevision` = SHA-256 of final JSON body; Task 5 trace uses this revision and text

Rules (spec §8): lessonKey = directionArmId. Success → `successful_pattern`; non-improving failure → `failure_pattern` with `recommendedChange` `Avoid <change>; choose another direction`; partial improvement → `conditional_guidance` with `Improved some criteria; remaining criteria must pass: <failed criterion IDs>`. Reinforce/contradict/retire rules as spec. Lesson cap 6 (drop lowest `lastSeenAt`, tie lex). Targets = selected scope ∪ changedPaths, sorted, ≤8. targetCatalog = union of retained lesson targets, keep 8 lex-smallest files. Renderer: body `{lessons, cooldowns, excludedCount}`, escape `<` as `\u003c`, drop oldest lesson then cooldown entries until ≤ maxChars including tags and revision; fallback body keeps the cap.

- [ ] **Step 1: Write failing tests (F9)**

```ts
test("F9: success, failure and conditional lessons with reinforce/contradict/retire", () => {
  const state = emptyState();
  let s = applyEvaluation(state, successEval("d1"));
  assert.equal(s.memory.lessons[0].kind, "successful_pattern");
  assert.equal(s.memory.lessons[0].reinforceCount, 1);
  s = applyEvaluation(s, failureEval("d1"));
  assert.equal(s.memory.lessons[0].contradictionCount, 1);
  // contradiction >= reinforce and > 0 retires on the following evaluation
});

test("F9: cap 6 lessons and 8 targets; no dangling targetIndexes", () => {
  const s = applyMany(emptyState(), 10);
  assert.ok(s.memory.lessons.length <= 6);
  for (const l of s.memory.lessons) for (const i of l.targetIndexes) assert.ok(i < s.memory.targetCatalog.length);
});

test("F9: render within 8192 UTF-16 including tags, < escaped, valid JSON after trim", () => {
  const text = getSubagentPolicyMemory(bigState(), "g1", 8192);
  assert.ok(text.length <= 8192);
  assert.ok(!text.slice(text.indexOf("<subagent-policy-memory>") + 1).includes("<script"));
  const body = JSON.parse(extractBody(text)); // strips tags
  assert.ok(Array.isArray(body.lessons));
});

test("F9: same state renders the same revision and text", () => {
  assert.equal(getSubagentPolicyMemory(bigState(), "g1"), getSubagentPolicyMemory(bigState(), "g1"));
});
```

`applyEvaluation`, `applyMany`, `bigState`, `extractBody`, `emptyState`, `successEval`, `failureEval` are test helpers in the test file that call the pure functions from Task 8; `applyEvaluation(state, eval)` is the pure state reducer `applyEvaluationToState(state, trace, assessment, now): LearningStateJSON` that Task 9 also calls.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the pure reducer and renderer**

The reducer takes an in-memory state and returns a new state (no DB). The renderer is pure. Escape `<` in every string value before JSON serialization via a replacer on the final string, so the body JSON itself contains no raw `<`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): render bounded deterministic policy memory" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 9: Commit transaction, CAS, replay, outbox and drain (F5, F7, F8)

**Files:**
- Modify: `src/skill-telemetry.ts` (`commitSubagentEvaluationBatch(input: CommitBatchInput): CommitBatchResult`, `findEvaluationProjection(operationId, sessionId)`, `drainPending()`, private `persistLearningStateWithinTransaction`, `flushOutcomeProjection`)
- Test: `tests/subagent-learning.test.ts`

**Interfaces:**
- Consumes: Task 5 `runWriterTransaction`, Task 6 `evaluateAssessment`, Task 7 cooldown/card updates, Task 8 `applyEvaluationToState`/`getSubagentPolicyMemory`, `writeTextFileAtomic` from `src/state.ts` (boolean return)
- Produces: `CommitBatchResult`; `OutcomeProjection` stored on the owner trace (lex smallest dispatchId in the operation)

Rules (spec §7): `operationId = hash(['evaluation-v1', sessionId, sortedDispatchIds])`; the store checks replay under BEGIN IMMEDIATE. Drain pending projections first (ordered by generation asc, operationId). Replay of all-terminal same operation returns recorded generation. Mixed terminal+pending → reject. Pending batch: evaluate in dispatchId lex order, insert observations (`INSERT OR IGNORE` only on identical replay, else invariant violation → rollback), update arms, cards, cooldowns, memory, save state generation+1 via `UPDATE learning_state SET generation=?,payload_json=? WHERE id=1 AND generation=?`; changes=0 → throw `CAS_STALE_GENERATION` and rollback. Then write the projection file with `writeTextFileAtomic` under the same lock; if the boolean is false, rollback markers, keep pending, throw `PROJECTION_PENDING` with committed generation/operationId; if true, mark owner flushed and COMMIT. Note: spec §7 step 5 says the file write happens under BEGIN IMMEDIATE before marker update; implement that ordering, and keep a crash-after-rename replay that rewrites identical bytes.

- [ ] **Step 1: Write failing tests**

```ts
test("F5: replay of identical operation does not reapply; changed payload conflicts", () => {
  const { store, trace } = seededWithDispatch();
  const input = commitInput(trace, successAssessment(trace));
  const a = store.commitSubagentEvaluationBatch(input);
  const b = store.commitSubagentEvaluationBatch(input);
  assert.equal(b.replay, true);
  assert.equal(b.generation, a.generation);
  assert.throws(() => store.commitSubagentEvaluationBatch({ ...input, requestHash: "changed" }), /conflict/);
});

test("F5: skipped retry does not upgrade; mixed-terminal and unknown dispatch reject", () => {
  // SKIP first, then ready assessment for same dispatch → conflict; mixed batch → reject; unknown dispatchId → reject
});

test("F7: failure after first observation and state update rolls back everything", () => {
  const { store, trace } = seededWithDispatch();
  injectFailureAfterFirstObservation(store); // test-only fault injector
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(trace, successAssessment(trace))), /injected/);
  assert.equal(store.countObservations(), 0);
  assert.equal(store.debugLearningState().generation, 0);
});

test("F7: stale CAS rolls back observations, markers and state", () => {
  const { store, trace } = seededWithDispatch();
  advanceGenerationBehindTheBack(store); // direct SQL update to generation 1 without payload change
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(trace, successAssessment(trace))), /CAS_STALE_GENERATION/);
  assert.equal(store.countObservations(), 0);
});

test("F8: file write returns false after commit → pending and PROJECTION_PENDING; reopen flushes exact bytes", () => {
  const { store, trace, dir } = seededWithDispatch();
  injectWriteFalseOnce(store); // makes the projection writer return false once
  assert.throws(() => store.commitSubagentEvaluationBatch(commitInput(trace, successAssessment(trace))), /PROJECTION_PENDING/);
  store.close();
  const reopened = new SkillTelemetryStore(dir);
  reopened.drainPending();
  assert.equal(readFileSync(join(dir, ".omp/work/outcome.json"), "utf8"), expectedOutcomeBytes(trace));
  reopened.close();
});

test("F8: two commits to the same destination do not stale-overwrite", () => {
  // first commit op1 flushed; second commit op2 drains op1 first, final file equals op2 bytes
});
```

The helper names (`injectFailureAfterFirstObservation`, `injectWriteFalseOnce`, `advanceGenerationBehindTheBack`, `expectedOutcomeBytes`, `commitInput`, `successAssessment`) live in the test file. Implement them with a test-only injected writer/hook argument on a test-only subclass or constructor option `__testHooks` that is not exported from the package entry; keep it internal.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Use one `runWriterTransaction` helper. The `started` flag guards ROLLBACK: after COMMIT fails, do not rollback learning already committed; file failure after COMMIT keeps learning committed and reports pending. `drainPending()` acquires BEGIN IMMEDIATE, reads pending owner traces, writes bytes from stored `outcomeJson`, marks flushed, commits; file false → throw `PROJECTION_PENDING`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-telemetry.ts tests/subagent-learning.test.ts
git commit -m "feat(learning): commit evaluations transactionally with outcome outbox" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

**P2 gate:** `node --test tests/skill-telemetry.test.ts tests/stack-router.test.ts tests/subagent-learning.test.ts` passes; F1–F9 tests pass against the real store (no mocked DB).

---

## Phase P3 — Integration

### Task 10: `harness_record` optional assessments (F12 evidence and session part)

**Files:**
- Modify: `src/tools.ts` (schema at ~:182–199 gains optional `subagentEvaluations`; execute at ~:213–249 gains a learning branch; legacy branch unchanged)
- Test: `tests/subagent-learning.test.ts` (F12 path/evidence/session cases); `tests/superagent.test.ts` (legacy regression)

**Interfaces:**
- Consumes: Task 9 `commitSubagentEvaluationBatch`, Task 9 `findEvaluationProjection`, `getSkillTelemetryStore` (Task 2)
- Produces: learning branch of `harness_record`; rejects before any write when the request is invalid

Rules (spec §6, §7): learning branch only when `subagentEvaluations` is present. Reject unless `ctx.agent?.kind === "sub"` is false and session identity derives from the same session-file normalization used by superagent `getState`; derive goal/candidate from persisted trace (not caller); validate criterion IDs unique/ordered/equal length N>0, `availableAt` safe integer, evidence paths inside workspace, regular file, SHA-256 equal to bytes now, changedPaths normalized; destination is `<cwd>/.omp/work/outcome.json` with symlink-component rejection; missing dir → error. Legacy branch unchanged.

- [ ] **Step 1: Write failing tests (F12 part)**

```ts
test("F12: traversal, symlink, hash mismatch, foreign session reject before writes", async () => {
  for (const make of [traversalEvidence, symlinkEvidence, hashMismatchEvidence, foreignSessionAssessment]) {
    const { ctx, store, before } = await harnessRecordFixture();
    await assert.rejects(() => runHarnessRecord(ctx, make(ctx)));
    assert.deepEqual(store.snapshotForTest(), before); // no learning writes
  }
});

test("legacy harness_record without subagentEvaluations is unchanged", async () => {
  const { ctx } = await harnessRecordFixture();
  const r = await runHarnessRecord(ctx, legacyParams());
  assert.equal(r.ok, true);
});
```

`runHarnessRecord`, `harnessRecordFixture`, `legacyParams`, `snapshotForTest` are test helpers that build the production tool with the current `ctx` shape (see `tests/superagent.test.ts` for the existing ctx builder; copy that helper). Replace the placeholders with real calls before running.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL (learning branch absent).

- [ ] **Step 3: Implement**

Add the zod schema for `subagentEvaluations` as an optional array of the `Assessment` shape from spec §4. Derive session key with the same helper superagent `getState` uses (`ctx.sessionManager.getSessionFile`). Compute `requestHash` over canonical caller params before attaching telemetry; call `findEvaluationProjection` before building outcome bytes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/subagent-learning.test.ts tests/superagent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/subagent-learning.test.ts tests/superagent.test.ts
git commit -m "feat(tools): accept parent-attested subagent assessments in harness_record" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 11: Superagent dispatch envelope, selection and memory adapters (F10)

**Files:**
- Modify: `src/superagent.ts` (`tool_call` learning branch at ~:1180 and task path near :1281; `resolveSuperagentTaskInput` at :606–649 gains optional internal memory context argument; spawn/send at :1304–1327)
- Test: `tests/superagent.test.ts`

**Interfaces:**
- Consumes: Task 5 `prepareSubagentDispatch`/`prepareSubagentDispatchBatch`, Task 8 memory text, `getSkillTelemetryStore`
- Produces: `resolveSuperagentTaskInput(input, state, memoryContext?: { revision: string; text: string })`

Rules (spec §9): session key from `getState(ctx)` and `event.toolCallId`; stable ticketId/agent; missing session/call ID → learning block (legacy continues). Single task: envelope in `input.context` only if no tasks batch; field precedence `task` → `assignment` → `description`, first nonempty string. Batch: each item carries its own envelope; shared context must not contain an envelope (reject ambiguous batch). Selected prompt replaces the envelope inside the item's text; own memory/contract block appended to item text; keep `<parent-read-ledger>`. Spawn/send: replace envelope in `prompt`/`message`, keep prefix/suffix, add static contract if missing. Malformed/duplicate own tags on learning branch → block.

- [ ] **Step 1: Write failing tests (F10)**

```ts
test("F10: single task context receives selected prompt and memory, prefix kept", () => {
  const out = resolveSuperagentTaskInput(taskInput({ context: prefix + envelopeTag() }), state, mem);
  assert.ok(out.includes(selectedPrompt));
  assert.ok(out.includes("<subagent-policy-memory>"));
  assert.ok(out.startsWith(prefix));
});

test("F10: tasks[].task, assignment, description precedence", () => {
  const out = resolveSuperagentTaskInput(batchInput([{ assignment: envelopeTag() }]), state, mem);
  assert.ok(out.includes(selectedPrompt));
});

test("F10: spawn.prompt and send.message receive selected prompt", () => {
  // prefix/suffix preserved, static contract once
});

test("F10: ambiguous envelope in shared context and item rejects batch", () => {
  assert.throws(() => resolveSuperagentTaskInput(batchInput([{ task: envelopeTag() }], { context: envelopeTag() }), state, mem), /ambiguous/);
});

test("F10: no-envelope legacy task with no supported string field keeps legacy behavior", () => {
  const out = resolveSuperagentTaskInput(taskInput({ task: undefined, context: "plain" }), state, undefined);
  assert.equal(typeof out, "string");
});

test("F10: two extension orders keep ledger block and memory block", () => {
  // ledger-before-memory and memory-before-ledger produce the same set of blocks
});

test("F10: malformed envelope fails learning, legacy path still returns input", () => {
  // invalid JSON in envelope → learning block; legacy input still returned
});
```

The helpers `taskInput`, `batchInput`, `envelopeTag`, `prefix`, `selectedPrompt`, `mem` live in `tests/superagent.test.ts`. Build them from the existing test helpers in that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/superagent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Keep the static `<superagent-worker-contract>` text unchanged. Own-block detection checks the full block (open and close tag), not just the opening tag. Same revision → byte-identical, no duplicate; different revision → replace own block only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/superagent.test.ts`
Expected: PASS, including the pre-existing superagent tests.

- [ ] **Step 5: Commit**

```bash
git add src/superagent.ts tests/superagent.test.ts
git commit -m "feat(superagent): dispatch selected candidate prompt with bounded memory" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 12: Startup drain and legacy regression

**Files:**
- Modify: `src/superagent.ts` (`pi.on("session_start")` at ~:1150: parent only, `getSkillTelemetryStore(cwd)`, `drainPending()` in try/catch with diagnostic)
- Test: `tests/superagent.test.ts`

**Interfaces:**
- Consumes: Task 9 `drainPending`, Task 2 `getSkillTelemetryStore`
- Produces: startup drain; a failed drain logs and keeps pending, never crashes the session or blocks legacy tools

- [ ] **Step 1: Write failing tests**

```ts
test("startup drain runs for parent only and does not throw on failure", () => {
  // parent session_start → drain called once; sub session_start → not called; drain throws → logged, handler resolves
});

test("legacy dispatch is not blocked by pending outbox and creates no trace", () => {
  // pending projection present; legacy task with no envelope proceeds; dispatch_traces count unchanged
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/superagent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Use the existing `session_start` handler; add the drain after existing parent-only logic. Keep the `isSub` guards and watchdog logic unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/superagent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent.ts tests/superagent.test.ts
git commit -m "feat(superagent): drain learning outbox on parent session start" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

**P3 gate:** `node --test tests/skill-telemetry.test.ts tests/stack-router.test.ts tests/subagent-learning.test.ts tests/superagent.test.ts` passes; no-envelope legacy regression passes with the DB or disk artificially failed (F10).

---

## Phase P4 — Acceptance

### Task 13: Actual next-dispatch smoke (F11)

**Files:**
- Test: `tests/subagent-learning.test.ts` (F11 case)

**Interfaces:**
- Consumes: registered superagent hooks (`tool_call`, `session_start`), `harness_record` tool, production store
- Produces: a test that drives the real hooks with a stub host that records the input it receives

- [ ] **Step 1: Write the failing test**

```ts
test("F11: evaluate → commit → next dispatch receives new revision and cooldown changes selection", async () => {
  const host = stubHostWithRegisteredHooks(tempCwd()); // records the input the host tool receives
  const first = await host.dispatchTask(envelopeTwoDirections());
  await host.recordAssessment(first, failureAssessment());
  const second = await host.dispatchTask(envelopeTwoDirections());
  assert.notEqual(second.receivedInput, first.receivedInput);
  assert.ok(second.receivedInput.includes("<subagent-policy-memory>"));
  host.reopen(); // close and reopen store
  const third = await host.dispatchTask(envelopeTwoDirections());
  assert.equal(third.selectedDirectionId, second.selectedDirectionId ?? third.selectedDirectionId);
});
```

Replace the placeholder with concrete asserts: the failed direction must not be selected during its cooldown window, and the stub must read the actual SQLite rows after reopen.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/subagent-learning.test.ts`
Expected: FAIL until the stub host is wired.

- [ ] **Step 3: Implement the stub host**

Use the existing harness test host (see `tests/superagent.test.ts` for how hooks are registered). It captures the `input` that reaches the host tool boundary. It is a host stub, not a substitute protocol: the hooks and the store are the production modules.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/subagent-learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/subagent-learning.test.ts
git commit -m "test(learning): cover evaluate-commit-next-dispatch smoke" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

### Task 14: Docs, changelog and final verification

**Files:**
- Modify: `docs/OMP-HARNESS-UPGRADE-CONTRACTS.md` (contract, failure semantics, limits)
- Modify: `CHANGELOG.md` (only bullets that map to live code)

**Interfaces:**
- Consumes: all previous tasks
- Produces: final AC evidence table

- [ ] **Step 1: Run the full suite and verify**

Run: `npm test`
Expected: pass count ≥ baseline from Task 0 plus the new learning tests; 0 fail.

Run: `npm run verify`
Expected: 12/12 checks ok (or the new count if verify gained checks), exit 0.

- [ ] **Step 2: Write the AC evidence table**

For each F1–F12 record `pass|fail|not-run` with the command, exit code, and revision. Any `not-run` is stated as not-run; do not mark it pass.

- [ ] **Step 3: Update docs and changelog**

Describe only what runs. State the limits from spec §7 and §11 (process-crash/reopen guarantee; no power-loss fsync claim; upgrade measurement not run unless §11 evaluation was performed).

- [ ] **Step 4: Commit**

```bash
git add docs/OMP-HARNESS-UPGRADE-CONTRACTS.md CHANGELOG.md
git commit -m "docs: document subagent learning contract and limits" -m "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

**P4 gate:** the coordinator's evidence table has every F-row marked; independent review happens once, then one grouped repair at most (spec §2.3).

---

## Self-Review Notes

- Spec coverage: §1 goals → Tasks 4–9, 11; §2 contracts → Task 0 and the agentic workflow; §3 touchpoints → Tasks 1–2, 10–12; §4 storage/types → Tasks 1, 3, 5; §5 KL-UCB → Tasks 4–5; §6 assessment/cooldown → Tasks 6–7; §7 transaction/outbox → Tasks 9–10; §8 memory → Task 8; §9 hooks/adapters → Tasks 2, 10–12; §10 phases → P1–P4; §11 AC → F1 (Task 1), F2 (Task 4), F3 (Task 5), F4 (Task 6), F5 (Tasks 5, 9), F6 (Tasks 5, 7), F7 (Task 9), F8 (Task 9), F9 (Task 8), F10 (Tasks 11–12), F11 (Task 13), F12 (Tasks 2, 10); §12 reporting → Task 14.
- Known gap to resolve at G0: the exact existing test names in `tests/skill-telemetry.test.ts` and `tests/superagent.test.ts` and the ctx builder used there; confirm before Task 10.
- Test helpers (`openStore`, `seededWithDispatch`, `__testHooks`, etc.) are declared in the test files, not in the package API; the spec forbids adding public API for them.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-09-subagent-self-improvement.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

**For this plan I recommend Subagent-driven**, because the 14 tasks share interfaces in `src/skill-telemetry.ts` across P1–P2 and a shipped mistake in the commit transaction would corrupt learning state. Does the plan capture what you want, and which approach should we use?
