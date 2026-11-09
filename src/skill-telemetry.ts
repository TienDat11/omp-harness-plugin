import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MIN_SHADOW_SAMPLES } from "./skill-specs.ts";
import { writeTextFileAtomic } from "./state.ts";

export interface SkillRunRecord {
  runId: string; sessionId: string; turnIndex: number; skillName: string;
  skillSha256: string; taskCategory: string; modelId: string;
  loadMode: "auto_injected" | "holdout_control" | "agent_read" | "pointer_only" | "l1_autoload";
  holdout: boolean; routerScore: number; mutations: number; toolCalls: number;
  toolErrors: number; verifyRan: boolean; verifyPassed: boolean;
  hardReverted: boolean; acceptancePassRate: number | null;
  manualRating: number | null; reward: number | null; recordedAt: string;
}

/**
 * TEST-ONLY fault-injection seam for F7/F8 (failure after the first observation, stale CAS,
 * projection writer returning false, crash after rename). Not exported, not part of
 * SubagentLearningStore; production callers never pass it.
 */
interface LearningStoreTestHooks {
  afterFirstObservation?: () => void;
  beforeStateUpdate?: (db: DatabaseSync) => void;
  writeProjection?: (destination: string, content: string) => boolean;
  afterProjectionWrite?: () => void;
}

/** Learning is committed but the outcome projection is still pending in the outbox. */
function projectionPendingError(operationId: string, generation: number, cause?: unknown): Error {
  const err = new Error(`PROJECTION_PENDING: learning committed at generation ${generation} for operation ${operationId}; outcome projection not yet written`, cause === undefined ? undefined : { cause });
  return Object.assign(err, { code: "PROJECTION_PENDING", operationId, generation });
}

export class SkillTelemetryStore {
  private db: DatabaseSync;
  private readonly testHooks: LearningStoreTestHooks;

  /** `__testHooks` is a test-only seam; see LearningStoreTestHooks. */
  constructor(dbPath: string, __testHooks?: LearningStoreTestHooks) {
    this.testHooks = __testHooks ?? {};
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS skill_runs(run_id TEXT PRIMARY KEY, session_id TEXT, turn_index INTEGER, skill_name TEXT, skill_sha256 TEXT, task_category TEXT, model_id TEXT, load_mode TEXT, holdout INTEGER, router_score REAL, mutations INTEGER, tool_calls INTEGER, tool_errors INTEGER, verify_ran INTEGER, verify_passed INTEGER, hard_reverted INTEGER, acceptance_pass_rate REAL, manual_rating REAL, reward REAL, recorded_at TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS skill_stats(skill_name TEXT, skill_sha256 TEXT, task_category TEXT, model_id TEXT, treatment_runs INTEGER DEFAULT 0, treatment_reward_sum REAL DEFAULT 0, control_runs INTEGER DEFAULT 0, control_reward_sum REAL DEFAULT 0, explicit_reads INTEGER DEFAULT 0, manual_overrides INTEGER DEFAULT 0, alpha REAL DEFAULT 2.0, beta REAL DEFAULT 2.0, lift REAL DEFAULT 0, last_used_at TEXT, PRIMARY KEY (skill_name, skill_sha256, task_category, model_id))`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS skill_runs_skill ON skill_runs(skill_name)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dispatch_traces (
  dispatch_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS learning_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL
)`);
    this.db.exec(`INSERT OR IGNORE INTO learning_state(id, generation, payload_json)
VALUES (1, 0, '{"generation":0,"arms":{},"opportunityCounters":{},"cooldowns":{},"cards":[],"memory":{"lessons":[],"targetCatalog":[]}}')`);
  }

  // Never reseeds: a missing, unparsable or generation-mismatched row is corruption.
  private readLearningStateRow(): { generation: number; payload: Record<string, unknown> & { generation: number } } {
    const row = this.db.prepare(`SELECT generation, payload_json FROM learning_state WHERE id=1`).get() as { generation: number; payload_json: string } | undefined;
    if (!row) throw new Error("learning_state corrupt");
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { throw new Error("learning_state corrupt"); }
    if (typeof payload !== "object" || payload === null || (payload as { generation?: unknown }).generation !== row.generation) {
      throw new Error("learning_state corrupt");
    }
    return { generation: row.generation, payload: payload as Record<string, unknown> & { generation: number } };
  }

  /** Single place for the dispatch memory trace values: rendered from the fresh state for the envelope goal. */
  private dispatchMemorySnapshot(state: LearningStateJSON, goalId: string): { memoryRevision: string; memoryText: string } {
    const { revision, text } = renderPolicyMemory(state, goalId, DEFAULT_MEMORY_CHARS);
    return { memoryRevision: revision, memoryText: text };
  }

  /**
   * Spec §7 step 5 / F8: flush every pending owner projection under the writer lock, ordered
   * generation asc then operationId. A false write throws PROJECTION_PENDING and rolls back markers.
   */
  drainPending(): void {
    this.runWriterTransaction(() => this.drainPendingWithinTransaction());
  }

  /** Caller holds BEGIN IMMEDIATE. Any failure throws so the caller's transaction rolls back. */
  private drainPendingWithinTransaction(): void {
    const rows = this.db.prepare(`SELECT dispatch_id, payload_json FROM dispatch_traces
WHERE json_extract(payload_json,'$.outcome.status')='pending'
ORDER BY json_extract(payload_json,'$.outcome.generation') ASC, json_extract(payload_json,'$.outcome.operationId') ASC`)
      .all() as Array<{ dispatch_id: string; payload_json: string }>;
    for (const row of rows) {
      const trace = JSON.parse(row.payload_json) as Trace;
      this.flushOutcomeProjection(trace);
    }
  }

  /** Write the stored bytes to the stored destination, then mark the owner flushed (same transaction). */
  private flushOutcomeProjection(owner: Trace): void {
    const projection = owner.outcome!;
    const write = this.testHooks.writeProjection ?? writeTextFileAtomic;
    if (write(projection.destination, projection.outcomeJson) !== true) {
      throw projectionPendingError(projection.operationId, projection.generation);
    }
    this.testHooks.afterProjectionWrite?.();
    const flushed: Trace = { ...owner, outcome: { ...projection, status: "flushed" } };
    this.db.prepare(`UPDATE dispatch_traces SET payload_json=? WHERE dispatch_id=?`).run(JSON.stringify(flushed), owner.dispatchId);
  }

  /** The only learning_state writer: CAS on the generation read at the start of this transaction. */
  private persistLearningStateWithinTransaction(state: LearningStateJSON, expectedGeneration: number): number {
    const nextGeneration = expectedGeneration + 1;
    if (!Number.isSafeInteger(nextGeneration)) throw new RangeError("generation would exceed safe integer");
    this.testHooks.beforeStateUpdate?.(this.db);
    const persisted = { ...state, generation: nextGeneration };
    const res = this.db.prepare(`UPDATE learning_state SET generation=?, payload_json=? WHERE id=1 AND generation=?`)
      .run(nextGeneration, JSON.stringify(persisted), expectedGeneration);
    if (Number(res.changes) !== 1) throw new Error("CAS_STALE_GENERATION: learning_state generation changed during the transaction");
    return nextGeneration;
  }

  /** Read-only lookup of an operation's original projection (spec §7 step 1). Foreign session returns null. */
  findEvaluationProjection(operationId: string, sessionId: string): OutcomeProjection | null {
    const row = this.db.prepare(`SELECT payload_json FROM dispatch_traces WHERE json_extract(payload_json,'$.outcome.operationId')=? LIMIT 1`)
      .get(operationId) as { payload_json: string } | undefined;
    if (!row) return null;
    const trace = JSON.parse(row.payload_json) as Trace;
    if (trace.sessionId !== sessionId || !trace.outcome) return null;
    return { ...trace.outcome };
  }

  /** Read-only trace lookup for boundary validation. Unknown dispatch or foreign session returns null. */
  findDispatchTrace(dispatchIdValue: string, sessionId: string): Trace | null {
    const row = this.db.prepare(`SELECT payload_json FROM dispatch_traces WHERE dispatch_id=?`)
      .get(dispatchIdValue) as { payload_json: string } | undefined;
    if (!row) return null;
    const trace = JSON.parse(row.payload_json) as Trace;
    return trace.sessionId === sessionId ? trace : null;
  }

  private static validateCommitInput(input: CommitBatchInput): CommitBatchInput {
    if (typeof input !== "object" || input === null) fail("commit", "must be an object");
    for (const key of ["operationId", "sessionId", "requestHash", "destination", "outcomeJson"] as const) {
      const v = input[key];
      if (typeof v !== "string" || v.length === 0) fail(key, "must be a nonempty string");
    }
    if (!Number.isSafeInteger(input.now)) fail("now", "must be a safe integer");
    if (!Array.isArray(input.assessments) || input.assessments.length === 0) fail("assessments", "must be a nonempty array");
    const ids = input.assessments.map((a, i) => {
      if (typeof a !== "object" || a === null || typeof a.dispatchId !== "string" || a.dispatchId.length === 0) {
        fail(`assessments[${i}].dispatchId`, "must be a nonempty string");
      }
      return a.dispatchId;
    });
    if (new Set(ids).size !== ids.length) fail("assessments", "duplicate dispatchId in one operation");
    if (input.operationId !== evaluationOperationId(input.sessionId, ids)) {
      fail("operationId", "does not match hash(['evaluation-v1', sessionId, sortedDispatchIds])");
    }
    return input;
  }

  /**
   * Spec §7: one writer transaction drains pending projections, decides replay by operationId,
   * dispatch identity and assessmentHash, applies a fully pending batch in dispatchId order and
   * CAS-saves one state generation. The projection is then flushed by drainPending(); a failed
   * write after COMMIT throws PROJECTION_PENDING and never rolls back committed learning.
   */
  commitSubagentEvaluationBatch(input: CommitBatchInput): CommitBatchResult {
    const valid = SkillTelemetryStore.validateCommitInput(input);
    const outcome = this.runWriterTransaction((): CommitBatchResult | { committed: number } => {
      this.drainPendingWithinTransaction();
      const getTrace = this.db.prepare(`SELECT payload_json FROM dispatch_traces WHERE dispatch_id=?`);
      const items = [...valid.assessments]
        .sort((a, b) => (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0))
        .map((a) => {
          const row = getTrace.get(a.dispatchId) as { payload_json: string } | undefined;
          if (!row) throw new RangeError(`unknown dispatch: ${a.dispatchId}`);
          const trace = JSON.parse(row.payload_json) as Trace;
          if (trace.sessionId !== valid.sessionId) throw new RangeError(`foreign session for dispatch ${a.dispatchId}`);
          if (trace.selectedDirectionArmId === null || trace.assessmentStatus === "not_dispatched") {
            throw new RangeError(`dispatch ${a.dispatchId} was not dispatched`);
          }
          return { assessment: a, trace, hash: assessmentHash(a) };
        });
      const terminal = items.filter((it) => it.trace.assessmentStatus === "applied" || it.trace.assessmentStatus === "skipped");
      const owner = items[0];
      if (terminal.length === items.length) {
        // Replay: every trace terminal under this operation with the same assessment payload.
        // The owner operationHash is covered by the per-trace assessmentHash, destination and
        // requestHash checks below; the stored outcomeJson is its only remaining input, and
        // replay always reuses those original bytes, so no operationHash comparison is needed.
        const projection = owner.trace.outcome;
        const same = items.every((it) => it.trace.evaluationOperationId === valid.operationId && it.trace.assessmentHash === it.hash) &&
          projection !== undefined && projection.operationId === valid.operationId &&
          projection.requestHash === valid.requestHash && projection.destination === valid.destination;
        if (!same) throw new Error("evaluation conflict: dispatch already has a different terminal assessment or operation");
        return { generation: projection!.generation, status: projection!.status, replay: true };
      }
      if (terminal.length > 0) throw new Error("evaluation conflict: mixed terminal and pending dispatches in one batch");

      const row = this.readLearningStateRow();
      let state = this.hydrateLearningState();
      const own = (rec: object, k: string): boolean => Object.prototype.hasOwnProperty.call(rec, k);
      const insertObservation = this.db.prepare(`INSERT OR IGNORE INTO observations(observation_id, payload_json) VALUES (?,?)`);
      let firstObservation = true;
      const updated: Trace[] = [];
      for (const { assessment, trace, hash } of items) {
        const ev = evaluateAssessment(trace, assessment);
        if (ev.kind !== "skip") {
          const selected = trace.candidates.find((c) => c.directionArmId === trace.selectedDirectionArmId)!;
          state = applyEvaluationToState(state, trace, assessment, valid.now);
          if (ev.kind === "terminal_failure" && ev.delta <= 0) {
            const arm = selected.directionArmId;
            const currentT = own(state.opportunityCounters, arm) ? state.opportunityCounters[arm] : 0;
            const key = failureKey(trace.goalId, selected.parentId, selected.directionId, selected.mechanism, selected.change, selected.scope);
            state = applyFailureCooldown(state, arm, key, { mechanism: selected.mechanism, change: selected.change, scope: selected.scope }, currentT, valid.now);
          }
          const arms = { ...state.arms };
          for (const obs of ev.rows) {
            // A pending trace never has rows: an existing row is an invariant violation, not a replay.
            const res = insertObservation.run(obs.observationId, JSON.stringify(obs));
            if (Number(res.changes) !== 1) throw new Error(`observation invariant violation: ${obs.observationId} exists for pending dispatch`);
            const prev = own(arms, obs.armId) ? arms[obs.armId] : { successes: 0, n: 0 };
            arms[obs.armId] = { successes: prev.successes + obs.value, n: prev.n + 1 };
            state = { ...state, arms };
            if (firstObservation) { firstObservation = false; this.testHooks.afterFirstObservation?.(); }
          }
        }
        updated.push({
          ...trace,
          assessmentStatus: ev.kind === "skip" ? "skipped" : "applied",
          assessmentHash: hash,
          evaluationOperationId: valid.operationId,
        });
      }
      const generation = this.persistLearningStateWithinTransaction(state, row.generation);
      updated[0] = {
        ...updated[0],
        outcome: {
          operationId: valid.operationId,
          requestHash: valid.requestHash,
          operationHash: operationHash(valid.assessments, valid.destination, valid.outcomeJson),
          destination: valid.destination,
          outcomeJson: valid.outcomeJson,
          generation,
          status: "pending",
        },
      };
      const updateTrace = this.db.prepare(`UPDATE dispatch_traces SET payload_json=? WHERE dispatch_id=?`);
      for (const t of updated) updateTrace.run(JSON.stringify(t), t.dispatchId);
      return { committed: generation };
    });
    if (!("committed" in outcome)) return outcome;
    // Learning is committed. The flush is a separate lock acquisition (spec §7 step 5).
    try {
      this.drainPending();
    } catch (err) {
      throw projectionPendingError(valid.operationId, outcome.committed, err);
    }
    return { generation: outcome.committed, status: "flushed", replay: false };
  }

  private runWriterTransaction<R>(fn: () => R): R {
    let started = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      started = true;
      const result = fn();
      this.db.exec("COMMIT");
      started = false;
      return result;
    } finally {
      if (started) {
        try { this.db.exec("ROLLBACK"); } catch { /* connection already rolled back */ }
      }
    }
  }

  private hydrateLearningState(): LearningStateJSON {
    const { payload } = this.readLearningStateRow();
    const isRecord = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!isRecord(payload.arms) || !isRecord(payload.opportunityCounters) || !isRecord(payload.cooldowns)) {
      throw new Error("learning_state corrupt");
    }
    const state = payload as unknown as LearningStateJSON;
    for (const v of Object.values(state.opportunityCounters)) {
      if (!Number.isSafeInteger(v) || v < 0) throw new Error("learning_state corrupt");
    }
    for (const a of Object.values(state.arms)) {
      if (!a || !Number.isSafeInteger(a.n) || !Number.isSafeInteger(a.successes) || a.n < 0 || a.successes < 0 || a.successes > a.n) {
        throw new Error("learning_state corrupt");
      }
    }
    for (const c of Object.values(state.cooldowns)) {
      if (!c || !Number.isSafeInteger(c.excludedThroughOpportunity) || !Number.isSafeInteger(c.failures)) {
        throw new Error("learning_state corrupt");
      }
    }
    return state;
  }

  private static validateDispatchInput(input: DispatchInput): DispatchInput {
    if (typeof input !== "object" || input === null) fail("dispatch", "must be an object");
    for (const key of ["sessionId", "toolCallId", "ticketId", "agent", "inputHash"] as const) {
      const v = input[key];
      if (typeof v !== "string" || v.length === 0) fail(key, "must be a nonempty string");
    }
    if (!Number.isSafeInteger(input.itemIndex) || input.itemIndex < 0) fail("itemIndex", "must be a nonnegative safe integer");
    if (!Number.isSafeInteger(input.now)) fail("now", "must be a safe integer");
    return { ...input, envelope: validateCandidateEnvelope(input.envelope) };
  }

  private selectSubagentDirection(state: LearningStateJSON, input: DispatchInput): DispatchResult {
    const own = (rec: object, k: string): boolean => Object.prototype.hasOwnProperty.call(rec, k);
    const bump = (arm: ArmId): number => {
      const cur = own(state.opportunityCounters, arm) ? state.opportunityCounters[arm] : 0;
      if (cur >= Number.MAX_SAFE_INTEGER) throw new RangeError("opportunity counter would exceed safe integer");
      state.opportunityCounters[arm] = cur + 1;
      return cur + 1;
    };
    const goalId = input.envelope.goalId;
    const memory = this.dispatchMemorySnapshot(state, goalId);
    const candidates: Candidate[] = input.envelope.candidates.map((c) => ({
      ...c,
      parentArmId: parentArmId(goalId, c.parentId),
      directionArmId: directionArmId(goalId, c.parentId, c.directionId),
    }));
    const tOf = new Map<ArmId, number>();
    for (const c of candidates) if (!tOf.has(c.parentArmId)) tOf.set(c.parentArmId, bump(c.parentArmId));
    for (const c of candidates) if (!tOf.has(c.directionArmId)) tOf.set(c.directionArmId, bump(c.directionArmId));

    const index = (arm: ArmId): number => {
      const a = own(state.arms, arm) ? state.arms[arm] : { successes: 0, n: 0 };
      return klUcbIndex(a.successes, a.n, tOf.get(arm)!);
    };
    const eligible: Array<{ c: Candidate; pi: number; di: number }> = [];
    for (const c of candidates) {
      const cd = own(state.cooldowns, c.directionArmId) ? state.cooldowns[c.directionArmId] : undefined;
      const t = tOf.get(c.directionArmId)!;
      if (cd && t > cd.excludedThroughOpportunity) delete state.cooldowns[c.directionArmId];
      else if (cd) continue;
      eligible.push({ c, pi: index(c.parentArmId), di: index(c.directionArmId) });
    }
    eligible.sort((x, y) => y.pi - x.pi || y.di - x.di ||
      (x.c.directionArmId < y.c.directionArmId ? -1 : x.c.directionArmId > y.c.directionArmId ? 1 : 0));
    const selected = eligible.length > 0 ? eligible[0].c : null;
    const trace: Trace = {
      dispatchId: dispatchId(input.sessionId, input.toolCallId, input.itemIndex),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      itemIndex: input.itemIndex,
      ticketId: input.ticketId,
      agent: input.agent,
      goalId,
      candidates,
      selectedDirectionArmId: selected ? selected.directionArmId : null,
      selectedPrompt: selected ? selected.prompt : "",
      inputHash: input.inputHash,
      memoryRevision: memory.memoryRevision,
      memoryText: memory.memoryText,
      createdAt: input.now,
      assessmentStatus: selected ? "pending" : "not_dispatched",
    };
    return { trace, selected, memoryText: memory.memoryText, reason: selected ? "selected" : "all_excluded" };
  }

  prepareSubagentDispatch(input: DispatchInput): DispatchResult {
    return this.prepareSubagentDispatchBatch([input])[0];
  }

  prepareSubagentDispatchBatch(inputs: DispatchInput[]): DispatchResult[] {
    if (!Array.isArray(inputs)) fail("inputs", "must be an array");
    const valid = inputs.map((i) => SkillTelemetryStore.validateDispatchInput(i));
    if (valid.length === 0) return [];
    return this.runWriterTransaction(() => {
      this.drainPendingWithinTransaction();
      const row = this.readLearningStateRow();
      const state = this.hydrateLearningState();
      const getTrace = this.db.prepare(`SELECT payload_json FROM dispatch_traces WHERE dispatch_id=?`);
      const results: Array<DispatchResult | null> = valid.map(() => null);
      const fresh = new Set<number>();
      valid.forEach((input, i) => {
        const id = dispatchId(input.sessionId, input.toolCallId, input.itemIndex);
        const existing = getTrace.get(id) as { payload_json: string } | undefined;
        if (existing) {
          const trace = JSON.parse(existing.payload_json) as Trace;
          if (trace.inputHash !== input.inputHash) throw new Error("dispatch conflict");
          // A blocked (not_dispatched) trace must never hand back a candidate to dispatch.
          const blocked = trace.selectedDirectionArmId === null || trace.assessmentStatus === "not_dispatched";
          const selected = blocked ? null : trace.candidates.find((c) => c.directionArmId === trace.selectedDirectionArmId) ?? null;
          results[i] = { trace, selected, memoryText: trace.memoryText, reason: selected ? "selected" : "all_excluded" };
        } else {
          fresh.add(i);
        }
      });
      if (fresh.size === 0) return results as DispatchResult[];
      this.checkCandidateCollisions(valid.filter((_, i) => fresh.has(i)));
      for (const i of fresh) results[i] = this.selectSubagentDirection(state, valid[i]);
      const out = results as DispatchResult[];
      if (out.some((r, i) => fresh.has(i) && r.reason === "all_excluded")) {
        // A blocked tool call dispatches nothing: keep every selection, mark unsent items not_dispatched.
        out.forEach((r, i) => { if (fresh.has(i)) r.trace.assessmentStatus = "not_dispatched"; });
      }
      const insert = this.db.prepare(`INSERT INTO dispatch_traces(dispatch_id, payload_json, created_at) VALUES (?,?,?)`);
      for (const i of fresh) {
        const t = out[i].trace;
        insert.run(t.dispatchId, JSON.stringify(t), t.createdAt);
      }
      this.persistLearningStateWithinTransaction(state, row.generation);
      return out;
    });
  }

  /** Same directionArmId must keep the same mechanism/change/scope across history and within the batch. */
  private checkCandidateCollisions(inputs: DispatchInput[]): void {
    const meta = (c: CandidateSpec): string => JSON.stringify([c.mechanism, c.change, normalizeScope(c.scope)]);
    const known = new Map<string, string>();
    const rows = this.db.prepare(`SELECT payload_json FROM dispatch_traces`).all() as Array<{ payload_json: string }>;
    for (const r of rows) {
      const t = JSON.parse(r.payload_json) as Trace;
      for (const c of t.candidates) if (!known.has(c.directionArmId)) known.set(c.directionArmId, meta(c));
    }
    for (const input of inputs) {
      for (const c of input.envelope.candidates) {
        const arm = directionArmId(input.envelope.goalId, c.parentId, c.directionId);
        const m = meta(c);
        const prior = known.get(arm);
        if (prior === undefined) known.set(arm, m);
        else if (prior !== m) fail(`directionId ${c.directionId}`, "metadata (mechanism/change/scope) differs from an earlier proposal with the same direction; use a new directionId");
      }
    }
  }

  recordRun(run: SkillRunRecord): void {
    this.db.prepare(`INSERT INTO skill_runs(run_id,session_id,turn_index,skill_name,skill_sha256,task_category,model_id,load_mode,holdout,router_score,mutations,tool_calls,tool_errors,verify_ran,verify_passed,hard_reverted,acceptance_pass_rate,manual_rating,reward,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.runId, run.sessionId, run.turnIndex, run.skillName, run.skillSha256, run.taskCategory, run.modelId, run.loadMode,
      run.holdout ? 1 : 0, run.routerScore, run.mutations, run.toolCalls, run.toolErrors,
      run.verifyRan ? 1 : 0, run.verifyPassed ? 1 : 0, run.hardReverted ? 1 : 0,
      run.acceptancePassRate, run.manualRating, run.reward, run.recordedAt,
    );

    this.db.prepare(`INSERT OR IGNORE INTO skill_stats(skill_name,skill_sha256,task_category,model_id,treatment_runs,treatment_reward_sum,control_runs,control_reward_sum,explicit_reads,manual_overrides,alpha,beta,lift,last_used_at) VALUES (?,?,?,?,0,0,0,0,0,0,2.0,2.0,0,?)`).run(
      run.skillName, run.skillSha256, run.taskCategory, run.modelId, run.recordedAt,
    );

    const row = this.db.prepare(`SELECT treatment_runs,treatment_reward_sum,control_runs,control_reward_sum,alpha,beta FROM skill_stats WHERE skill_name=? AND skill_sha256=? AND task_category=? AND model_id=?`).get(
      run.skillName, run.skillSha256, run.taskCategory, run.modelId,
    ) as { treatment_runs: number; treatment_reward_sum: number; control_runs: number; control_reward_sum: number; alpha: number; beta: number };

    let tRuns = row.treatment_runs;
    let tSum = row.treatment_reward_sum;
    let cRuns = row.control_runs;
    let cSum = row.control_reward_sum;
    let alpha = row.alpha;
    let beta = row.beta;
    const r = run.reward ?? 0;
    if (run.holdout) {
      cRuns += 1;
      cSum += r;
      beta += 1;
    } else {
      tRuns += 1;
      tSum += r;
      alpha += r;
      beta += (1 - r);
    }
    const tMean = tRuns > 0 ? tSum / tRuns : 0;
    const cMean = cRuns > 0 ? cSum / cRuns : 0;
    const lift = tMean - cMean;
    this.db.prepare(`UPDATE skill_stats SET treatment_runs=?,treatment_reward_sum=?,control_runs=?,control_reward_sum=?,alpha=?,beta=?,lift=?,last_used_at=? WHERE skill_name=? AND skill_sha256=? AND task_category=? AND model_id=?`).run(
      tRuns, tSum, cRuns, cSum, alpha, beta, lift, run.recordedAt,
      run.skillName, run.skillSha256, run.taskCategory, run.modelId,
    );
  }

  recordManualRating(skillName: string, skillSha256: string, rating01: number): void {
    const run = this.db.prepare(`SELECT run_id,holdout,reward,task_category,model_id FROM skill_runs WHERE skill_name=? AND skill_sha256=? ORDER BY recorded_at DESC, run_id DESC LIMIT 1`).get(skillName, skillSha256) as { run_id: string; holdout: number; reward: number | null; task_category: string; model_id: string } | undefined;
    const delta = run ? rating01 - (run.reward ?? 0) : 0;
    this.db.prepare(`UPDATE skill_runs SET manual_rating = ?, reward = ? WHERE run_id = (SELECT run_id FROM skill_runs WHERE skill_name=? AND skill_sha256=? ORDER BY recorded_at DESC, run_id DESC LIMIT 1)`).run(
      rating01, rating01, skillName, skillSha256,
    );
    this.db.prepare(`UPDATE skill_stats SET manual_overrides = manual_overrides + 1 WHERE skill_name=? AND skill_sha256=?`).run(
      skillName, skillSha256,
    );
    if (run && delta !== 0) {
      if (run.holdout) {
        this.db.prepare(`UPDATE skill_stats SET control_reward_sum = control_reward_sum + ? WHERE skill_name=? AND skill_sha256=? AND task_category=? AND model_id=?`).run(delta, skillName, skillSha256, run.task_category, run.model_id);
      } else {
        this.db.prepare(`UPDATE skill_stats SET treatment_reward_sum = treatment_reward_sum + ?, alpha = alpha + ?, beta = beta - ? WHERE skill_name=? AND skill_sha256=? AND task_category=? AND model_id=?`).run(delta, delta, delta, skillName, skillSha256, run.task_category, run.model_id);
      }
      const stats = this.db.prepare(`SELECT treatment_runs,treatment_reward_sum,control_runs,control_reward_sum FROM skill_stats WHERE skill_name=? AND skill_sha256=?`).all(skillName, skillSha256) as Array<{ treatment_runs: number; treatment_reward_sum: number; control_runs: number; control_reward_sum: number }>;
      let tRuns = 0, tSum = 0, cRuns = 0, cSum = 0;
      for (const s of stats) { tRuns += s.treatment_runs; tSum += s.treatment_reward_sum; cRuns += s.control_runs; cSum += s.control_reward_sum; }
      const tMean = tRuns > 0 ? tSum / tRuns : 0;
      const cMean = cRuns > 0 ? cSum / cRuns : 0;
      this.db.prepare(`UPDATE skill_stats SET lift = ? WHERE skill_name=? AND skill_sha256=?`).run(tMean - cMean, skillName, skillSha256);
    }
  }

  queryLift(skillName: string, skillSha256: string, taskCategory: string, modelId: string): { shadowMode: boolean; totalRuns: number; lift: number; posteriorMean: number } {
    const keys: Array<[string, string, string, string]> = [
      [skillName, skillSha256, taskCategory, modelId],
      [skillName, skillSha256, taskCategory, "*"],
      [skillName, skillSha256, "*", "*"],
    ];
    let row: { treatment_runs: number; control_runs: number; lift: number; alpha: number; beta: number } | undefined;
    for (const [a, b, c, d] of keys) {
      const r = this.db.prepare(`SELECT treatment_runs,control_runs,lift,alpha,beta FROM skill_stats WHERE skill_name=? AND skill_sha256=? AND task_category=? AND model_id=?`).get(a, b, c, d) as typeof row;
      if (r) { row = r; break; }
    }
    const treatmentRuns = row?.treatment_runs ?? 0;
    const controlRuns = row?.control_runs ?? 0;
    const totalRuns = treatmentRuns + controlRuns;
    const lift = row?.lift ?? 0;
    const alpha = row?.alpha ?? 2.0;
    const beta = row?.beta ?? 2.0;
    const posteriorMean = alpha / (alpha + beta);
    return { shadowMode: totalRuns < MIN_SHADOW_SAMPLES, totalRuns, lift, posteriorMean };
  }

  listStats(): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`SELECT * FROM skill_stats`).all() as Array<Record<string, unknown>>;
    return rows;
  }

  close(): void {
    this.db.close();
  }
}

export function computeReward(input: {
  mutations: number; verifyRan: boolean; verifyPassed: boolean; hardReverted: boolean;
  toolErrors: number; toolCalls: number; acceptancePassRate: number | null; manualRating: number | null;
}): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (input.manualRating !== null) {
    return clamp(input.manualRating);
  }
  let r = 0.5;
  if (input.verifyRan && input.verifyPassed) r += 0.2;
  if (input.verifyRan && !input.verifyPassed) r -= 0.3;
  if (input.hardReverted) r -= 0.5;
  r -= Math.min(0.2, input.toolErrors * 0.05);
  if (input.acceptancePassRate !== null) r += 0.3 * input.acceptancePassRate;
  return clamp(r);
}

export function isHardRevert(command: string): boolean {
  const c = command ?? "";
  if (/\bgit\s+revert\b/.test(c)) return true;
  if (/\bgit\s+checkout\s+--/.test(c)) return true;
  if (/\bgit\s+reset\s+--hard\b/.test(c)) return true;
  if (/\bgit\s+stash\s+drop\b/.test(c)) return true;
  if (/\bgit\s+restore\b(?!\s+--staged\b)/.test(c)) return true;
  return false;
}

const storeCache = new Map<string, SkillTelemetryStore>();

function canonicalCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

/** Shared per-cwd store. Constructor failure (locked or read-only workspace) returns null and is not cached. */
export function getSkillTelemetryStore(cwd: string): SkillTelemetryStore | null {
  const key = canonicalCwd(cwd);
  const cached = storeCache.get(key);
  if (cached) return cached;
  try {
    const dir = path.join(key, ".omp", "harness");
    mkdirSync(dir, { recursive: true });
    const store = new SkillTelemetryStore(path.join(dir, "skill-telemetry.db"));
    storeCache.set(key, store);
    return store;
  } catch (err) {
    console.error(`skill-telemetry: store unavailable for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function closeSkillTelemetryStores(): void {
  try {
    for (const store of storeCache.values()) {
      try {
        store.close();
      } catch {
        // Already closed.
      }
    }
  } finally {
    storeCache.clear();
  }
}

// ---- Subagent self-improvement: typed contract (spec §4) ----
export type ArmId = string & { readonly __brand: "ArmId" };
export type CriterionSet = { criterionIds: string[]; passed: boolean[] };
export type ReportKind = "ready" | "failed" | "blocked" | "dropped";
export interface CandidateSpec {
  parentId: string | null;
  directionId: string;
  mechanism: string;
  change: string;
  scope: string[];
  prompt: string;
}
export interface Candidate extends CandidateSpec {
  parentArmId: ArmId;
  directionArmId: ArmId;
}
export interface CandidateEnvelope {
  version: 1;
  goalId: string;
  candidates: CandidateSpec[];
}
export interface Assessment {
  dispatchId: string;
  reportKind: ReportKind;
  followed: boolean;
  attributable: boolean;
  allChecksCompleted: boolean;
  measurementError: boolean;
  baseline: CriterionSet;
  candidate: CriterionSet;
  evidenceRefs: Array<{ path: string; sha256: string }>;
  changedPaths: string[];
  availableAt: number;
}
export interface Observation {
  observationId: string;
  dispatchId: string;
  target: "parent" | "direction";
  armId: ArmId;
  value: 0 | 1;
  availableAt: number;
}
export interface FailureDirectionCard {
  failureKey: string;
  directionArmId: ArmId;
  mechanism: string;
  change: string;
  scope: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}
export interface Lesson {
  lessonKey: ArmId;
  kind: "successful_pattern" | "failure_pattern" | "conditional_guidance";
  goalId: string;
  appliesWhen: string;
  mechanism: string;
  recommendedChange: string;
  targets: Array<{ file: string; change: string }>;
  targetIndexes: number[];
  reinforceCount: number;
  contradictionCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}
export interface LearningStateJSON {
  generation: number;
  arms: Record<ArmId, { successes: number; n: number }>;
  opportunityCounters: Record<ArmId, number>;
  cooldowns: Record<ArmId, { excludedThroughOpportunity: number; failures: number }>;
  cards: FailureDirectionCard[];
  memory: {
    lessons: Lesson[];
    targetCatalog: Array<{ file: string; change: string }>;
  };
}
export interface OutcomeProjection {
  operationId: string;
  requestHash: string;
  operationHash: string;
  destination: string;
  outcomeJson: string;
  generation: number;
  status: "pending" | "flushed";
}
export interface Trace {
  dispatchId: string;
  sessionId: string;
  toolCallId: string;
  itemIndex: number;
  ticketId: string;
  agent: string;
  goalId: string;
  candidates: Candidate[];
  selectedDirectionArmId: ArmId | null;
  selectedPrompt: string;
  inputHash: string;
  memoryRevision: string;
  memoryText: string;
  createdAt: number;
  assessmentStatus: "pending" | "applied" | "skipped" | "not_dispatched";
  assessmentHash?: string;
  evaluationOperationId?: string;
  outcome?: OutcomeProjection;
}
export interface DispatchInput {
  sessionId: string;
  toolCallId: string;
  itemIndex: number;
  ticketId: string;
  agent: string;
  envelope: CandidateEnvelope;
  inputHash: string;
  now: number;
}
export interface DispatchResult {
  trace: Trace;
  selected: Candidate | null;
  memoryText: string;
  reason: "selected" | "all_excluded";
}
export interface CommitBatchInput {
  operationId: string;
  sessionId: string;
  requestHash: string;
  destination: string;
  outcomeJson: string;
  assessments: Assessment[];
  now: number;
}
export interface CommitBatchResult {
  generation: number;
  status: "pending" | "flushed";
  replay: boolean;
}
export interface SubagentLearningStore {
  prepareSubagentDispatch(input: DispatchInput): DispatchResult;
  prepareSubagentDispatchBatch(inputs: DispatchInput[]): DispatchResult[];
  findEvaluationProjection(operationId: string, sessionId: string): OutcomeProjection | null;
  commitSubagentEvaluationBatch(input: CommitBatchInput): CommitBatchResult;
  drainPending(): void;
}

// ---- IDs: SHA-256 (hex) of UTF-8 JSON.stringify(array); first element is a domain tag ----
export function hashId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}
export function parentArmId(goalId: string, parentId: string | null): ArmId {
  return hashId(["parent-v1", goalId, parentId]) as ArmId;
}
export function directionArmId(goalId: string, parentId: string | null, directionId: string): ArmId {
  return hashId(["arm-v1", goalId, parentId, directionId]) as ArmId;
}
export function dispatchId(sessionId: string, toolCallId: string, itemIndex: number): string {
  return hashId(["dispatch-v1", sessionId, toolCallId, itemIndex]);
}
export function observationId(dispatchIdValue: string, target: "parent" | "direction", armId: ArmId): string {
  return hashId(["observation-v1", dispatchIdValue, target, armId]);
}
export function failureKey(
  goalId: string, parentId: string | null, directionId: string,
  mechanism: string, change: string, scope: string[],
): string {
  return hashId(["failure-v1", goalId, parentId, directionId, mechanism, change, normalizeScope(scope)]);
}
/** Spec §7: operationId = hash(['evaluation-v1', sessionId, sortedDispatchIds]). */
export function evaluationOperationId(sessionId: string, dispatchIds: string[]): string {
  return hashId(["evaluation-v1", sessionId, [...dispatchIds].sort()]);
}
/**
 * Spec §9: the one session-key derivation shared by superagent getState and harness_record.
 * Base is the raw ctx cwd (process.cwd() when absent); a host session id is appended when present.
 */
export function sessionStateKey(cwd: string | undefined, sessionId: string | undefined): string {
  const base = cwd ?? process.cwd();
  return sessionId ? `${base}::${sessionId}` : base;
}
/** Learning session identity: the getState key, or null when the host session id is missing. */
export function subagentSessionKey(cwd: string | undefined, sessionId: string | undefined): string | null {
  return sessionId ? sessionStateKey(cwd, sessionId) : null;
}
/** Recursively sort object keys so a hash covers content, not key insertion order. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) if (rec[k] !== undefined) out[k] = canonicalValue(rec[k]);
    return out;
  }
  return value;
}
/** Spec §6: hash of the full canonical assessment payload (evidence and time included). */
export function assessmentHash(assessment: Assessment): string {
  return hashId(["assessment-v1", canonicalValue(assessment)]);
}
/** Spec §7: operationHash = hash of canonical assessments (dispatchId order) + destination + outcomeJson. */
function operationHash(assessments: Assessment[], destination: string, outcomeJson: string): string {
  const sorted = [...assessments].sort((a, b) => (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0));
  return hashId(["operation-v1", sorted.map(canonicalValue), destination, outcomeJson]);
}

// ---- Validation boundary (pure, no DB) ----
export const MAX_CANDIDATES = 8;
export const MAX_PROMPT_UNITS = 4000;
export const MAX_FIELD_UNITS = 512;
export const MAX_SCOPE_PATHS = 8;
export const MAX_SCOPE_PATH_UNITS = 1024;

function fail(field: string, why: string): never {
  throw new RangeError(`${field}: ${why}`);
}

/** Repo-relative, slash-separated, no "..", unique, lexicographically sorted. */
export function normalizeScope(scope: unknown, field = "scope"): string[] {
  if (!Array.isArray(scope)) fail(field, "must be an array");
  const out = new Set<string>();
  for (const raw of scope) {
    if (typeof raw !== "string") fail(field, "paths must be strings");
    if (raw.length > MAX_SCOPE_PATH_UNITS) fail(field, `path exceeds ${MAX_SCOPE_PATH_UNITS} code units`);
    if (raw.includes("\0")) fail(field, "path contains NUL");
    const slashed = raw.replace(/\\/g, "/");
    if (slashed.startsWith("/")) fail(field, `path must be repo-relative: ${raw}`);
    if (/^[A-Za-z]:/.test(slashed)) fail(field, `path must not carry a drive: ${raw}`);
    const segments: string[] = [];
    for (const seg of slashed.split("/")) {
      if (seg === "..") fail(field, `path must not traverse upward: ${raw}`);
      if (seg === "" || seg === ".") continue;
      segments.push(seg);
    }
    if (segments.length === 0) fail(field, "path must be nonempty");
    out.add(segments.join("/"));
  }
  return [...out].sort();
}

function boundedString(value: unknown, field: string, max: number, trim: boolean): string {
  if (typeof value !== "string") fail(field, "must be a string");
  const v = trim ? value.trim() : value;
  if (v.trim().length === 0) fail(field, "must be nonempty");
  if (v.length > max) fail(field, `exceeds ${max} UTF-16 code units`);
  return v;
}

export function validateCandidateSpec(raw: unknown, field = "candidate"): CandidateSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(field, "must be an object");
  const r = raw as Record<string, unknown>;
  const parentId = r.parentId === null ? null : boundedString(r.parentId, `${field}.parentId`, MAX_FIELD_UNITS, true);
  const directionId = boundedString(r.directionId, `${field}.directionId`, MAX_FIELD_UNITS, true);
  const mechanism = boundedString(r.mechanism, `${field}.mechanism`, MAX_FIELD_UNITS, false);
  const change = boundedString(r.change, `${field}.change`, MAX_FIELD_UNITS, false);
  const prompt = boundedString(r.prompt, `${field}.prompt`, MAX_PROMPT_UNITS, false);
  if (!Array.isArray(r.scope)) fail(`${field}.scope`, "must be an array");
  if (r.scope.length > MAX_SCOPE_PATHS) fail(`${field}.scope`, `exceeds ${MAX_SCOPE_PATHS} paths`);
  const scope = normalizeScope(r.scope, `${field}.scope`);
  return { parentId, directionId, mechanism, change, scope, prompt };
}

export function validateCandidateEnvelope(raw: unknown): CandidateEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("envelope", "must be an object");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) fail("version", "must be 1");
  const goalId = boundedString(r.goalId, "goalId", MAX_FIELD_UNITS, true);
  if (!Array.isArray(r.candidates)) fail("candidates", "must be an array");
  if (r.candidates.length < 1 || r.candidates.length > MAX_CANDIDATES) {
    fail("candidates", `must contain 1-${MAX_CANDIDATES} items`);
  }
  const seen = new Set<string>();
  const candidates = r.candidates.map((c, i) => {
    const spec = validateCandidateSpec(c, `candidates[${i}]`);
    const key = JSON.stringify([spec.parentId, spec.directionId]);
    if (seen.has(key)) fail(`candidates[${i}]`, "duplicate (parentId, directionId)");
    seen.add(key);
    return spec;
  });
  return { version: 1, goalId, candidates };
}

export function klUcbIndex(
  successes: number, n: number, T: number,
  c = 1, tolerance = 1e-8, maxIterations = 100,
): number {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(n) ||
      !Number.isSafeInteger(T) || n < 0 || successes < 0 || successes > n || T < n) {
    throw new RangeError("invalid counts: require 0 <= successes <= n <= T");
  }
  if (!Number.isFinite(c) || c < 0 || !Number.isFinite(tolerance) || tolerance <= 0 ||
      !Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError("invalid solver parameters");
  }
  if (n === 0) return 1;
  const p = successes / n;
  if (p === 1) return 1;
  const budget = Math.log1p(T) + c * Math.log1p(Math.log1p(T));
  const kl = (q: number): number =>
    (p > 0 ? p * Math.log(p / q) : 0) + (1 - p) * Math.log((1 - p) / (1 - q));
  let low = p;
  let high = 1;
  for (let i = 0; i < maxIterations && high - low > tolerance; i += 1) {
    const mid = (low + high) / 2;
    if (n * kl(mid) <= budget) low = mid;
    else high = mid;
  }
  return low;
}

// ---- Assessment gates (spec §6): pure, no DB access. Rows are inserted by the commit transaction. ----
export function evaluateAssessment(
  trace: Pick<Trace, "dispatchId" | "candidates" | "selectedDirectionArmId">,
  assessment: Assessment,
): { kind: "terminal_success" | "terminal_failure" | "skip"; delta: number; rows: Observation[] } {
  if (assessment.dispatchId !== trace.dispatchId) throw new RangeError("assessment dispatchId does not match trace");
  const dirArm = trace.selectedDirectionArmId;
  if (dirArm === null) throw new RangeError("trace has no selected direction");
  const selected = trace.candidates.find((c) => c.directionArmId === dirArm);
  if (!selected) throw new RangeError("selected direction not in trace candidates");
  if (!Number.isSafeInteger(assessment.availableAt)) throw new RangeError("availableAt must be a safe integer");

  const { baseline, candidate } = assessment;
  const ids = baseline.criterionIds;
  const n = ids.length;
  if (n === 0) throw new RangeError("criterion set must be nonempty");
  if (candidate.criterionIds.length !== n || candidate.criterionIds.some((id, i) => id !== ids[i])) {
    throw new RangeError("criterion IDs must be identical and in the same order");
  }
  if (new Set(ids).size !== n || ids.some((id) => typeof id !== "string" || id === "")) {
    throw new RangeError("criterion IDs must be unique nonempty strings");
  }
  if (baseline.passed.length !== n || candidate.passed.length !== n) {
    throw new RangeError("passed arrays must match criterion IDs length");
  }
  const candidateAllPass = candidate.passed.every((p) => p === true);
  if (assessment.reportKind === "ready" && !candidateAllPass) throw new RangeError("ready with failed criterion");

  const count = (p: boolean[]) => p.reduce((a, b) => a + (b ? 1 : 0), 0);
  const delta = (count(candidate.passed) - count(baseline.passed)) / n;

  const valid = assessment.allChecksCompleted && !assessment.measurementError && assessment.evidenceRefs.length > 0;
  if (!(assessment.followed && assessment.attributable && valid && Number.isFinite(delta))) {
    return { kind: "skip", delta, rows: [] };
  }
  const success = assessment.reportKind === "ready";
  const value: 0 | 1 = success ? 1 : 0;
  const mk = (target: "parent" | "direction", armId: ArmId): Observation => ({
    observationId: observationId(trace.dispatchId, target, armId),
    dispatchId: trace.dispatchId, target, armId, value, availableAt: assessment.availableAt,
  });
  return {
    kind: success ? "terminal_success" : "terminal_failure",
    delta,
    rows: [mk("parent", selected.parentArmId), mk("direction", selected.directionArmId)],
  };
}

export const CARD_CAP = 50;
export const COOLDOWN_OPPORTUNITIES = 3;

/** Evict from cards only (never cooldowns): smallest lastSeenAt, then lex-smallest failureKey. Pure. */
export function capCards(cards: FailureDirectionCard[]): FailureDirectionCard[] {
  const sorted = [...cards].sort((a, b) =>
    b.lastSeenAt - a.lastSeenAt || (a.failureKey < b.failureKey ? 1 : a.failureKey > b.failureKey ? -1 : 0));
  return sorted.slice(0, CARD_CAP).map((c) => ({ ...c, scope: [...c.scope] }));
}

/** Remove cooldown entries whose excludedThroughOpportunity < currentT (T exceeded it). Pure. */
export function pruneExpiredCooldowns(state: LearningStateJSON, currentT: number): LearningStateJSON {
  const cooldowns: LearningStateJSON["cooldowns"] = {};
  for (const [arm, cd] of Object.entries(state.cooldowns)) {
    if (!(cd.excludedThroughOpportunity < currentT)) cooldowns[arm] = { ...cd };
  }
  return { ...state, cooldowns };
}

/**
 * Record an eligible non-improving terminal failure. Upserts the card by failureKey
 * (firstSeenAt kept, lastSeenAt updated), caps cards, and sets the direction cooldown to
 * currentT + 3 and increments failures (a live entry is renewed; an expired one restarts at 1).
 * Every call is a NEW failure: duplicate, replay, SKIP and restart suppression is the CALLER's
 * responsibility (Task 9 gates calls on dispatch/assessment identity); this reducer never detects
 * duplicates from its own state. Pure.
 */
export function applyFailureCooldown(
  state: LearningStateJSON,
  directionArm: ArmId,
  key: string,
  card: { mechanism: string; change: string; scope: string[] },
  currentT: number,
  now: number,
): LearningStateJSON {
  const existing = state.cards.some((c) => c.failureKey === key);
  const upserted: FailureDirectionCard[] = existing
    ? state.cards.map((c) => (c.failureKey === key ? { ...c, lastSeenAt: now } : c))
    : [...state.cards, {
        failureKey: key, directionArmId: directionArm, mechanism: card.mechanism,
        change: card.change, scope: [...card.scope], firstSeenAt: now, lastSeenAt: now,
      }];
  const cooldowns = { ...state.cooldowns };
  const cur = Object.prototype.hasOwnProperty.call(cooldowns, directionArm) ? cooldowns[directionArm] : undefined;
  const live = cur !== undefined && !(cur.excludedThroughOpportunity < currentT);
  cooldowns[directionArm] = {
    excludedThroughOpportunity: currentT + COOLDOWN_OPPORTUNITIES,
    failures: live ? cur.failures + 1 : 1,
  };
  return { ...state, cards: capCards(upserted), cooldowns };
}

// ---- Deterministic memory (spec §8): pure reducer and renderer, no DB access ----
export const LESSON_CAP = 6;
export const TARGETS_PER_LESSON = 8;
export const TARGET_CATALOG_CAP = 8;
export const DEFAULT_MEMORY_CHARS = 8192;
export const MIN_MEMORY_CHARS = 256;
const MEMORY_COOLDOWNS_MAX = 8;
const MEMORY_OPEN_TAG = "<subagent-policy-memory>";
const MEMORY_CLOSE_TAG = "</subagent-policy-memory>";

const lexCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const newestFirst = (a: Lesson, b: Lesson): number => b.lastSeenAt - a.lastSeenAt || lexCmp(a.lessonKey, b.lessonKey);

/** Rebuild targetCatalog and targetIndexes from retained lessons (file-lex indexes, no dangling). Pure. */
function rebuildTargetCatalog(lessons: Lesson[]): { lessons: Lesson[]; targetCatalog: Array<{ file: string; change: string }> } {
  const byFile = new Map<string, string>();
  for (const l of [...lessons].sort(newestFirst)) {
    for (const t of l.targets) if (!byFile.has(t.file)) byFile.set(t.file, t.change);
  }
  const files = [...byFile.keys()].sort(lexCmp).slice(0, TARGET_CATALOG_CAP);
  const index = new Map(files.map((f, i) => [f, i]));
  const targetCatalog = files.map((file) => ({ file, change: byFile.get(file)! }));
  const out = lessons.map((l) => ({
    ...l,
    targets: l.targets.map((t) => ({ ...t })),
    targetIndexes: [...new Set(l.targets.map((t) => t.file))].sort(lexCmp)
      .filter((f) => index.has(f)).map((f) => index.get(f)!),
  }));
  return { lessons: out, targetCatalog };
}

/**
 * Apply one assessment to the lesson memory (spec §8). SKIP returns the state unchanged. Only
 * memory.lessons/targetCatalog change; arms, cards and cooldowns are the caller's (Task 9). Pure.
 */
export function applyEvaluationToState(
  state: LearningStateJSON,
  trace: Pick<Trace, "dispatchId" | "candidates" | "selectedDirectionArmId" | "goalId">,
  assessment: Assessment,
  now: number,
): LearningStateJSON {
  const ev = evaluateAssessment(trace, assessment);
  if (ev.kind === "skip") return state;
  const selected = trace.candidates.find((c) => c.directionArmId === trace.selectedDirectionArmId)!;
  let kind: Lesson["kind"];
  let guidance: string;
  if (ev.kind === "terminal_success") {
    kind = "successful_pattern";
    guidance = `Use ${selected.change}`;
  } else if (ev.delta > 0) {
    kind = "conditional_guidance";
    const failed = assessment.candidate.criterionIds.filter((_, i) => !assessment.candidate.passed[i]);
    guidance = `Improved some criteria; remaining criteria must pass: ${failed.join(", ")}`;
  } else {
    kind = "failure_pattern";
    guidance = `Avoid ${selected.change}; choose another direction`;
  }
  const key = selected.directionArmId;
  const existing = state.memory.lessons.find((l) => l.lessonKey === key);
  const others = state.memory.lessons.filter((l) => l.lessonKey !== key);

  let next: Lesson | null;
  if (existing && existing.contradictionCount > 0 && existing.contradictionCount >= existing.reinforceCount) {
    next = null; // guard only: a state loaded from disk already in the retired condition
  } else {
    const files = [...new Set([...selected.scope, ...assessment.changedPaths])].sort(lexCmp).slice(0, TARGETS_PER_LESSON);
    const fresh: Lesson = {
      lessonKey: key, kind, goalId: trace.goalId,
      appliesWhen: `parent ${selected.parentId ?? "none"}; direction ${selected.directionId}`,
      mechanism: selected.mechanism, recommendedChange: guidance,
      targets: files.map((file) => ({ file, change: selected.change })), targetIndexes: [],
      reinforceCount: 1, contradictionCount: 0, firstSeenAt: now, lastSeenAt: now,
    };
    if (!existing) next = fresh;
    else if (existing.kind === kind && existing.recommendedChange === guidance) {
      next = { ...fresh, firstSeenAt: existing.firstSeenAt, reinforceCount: existing.reinforceCount + 1, contradictionCount: existing.contradictionCount };
    } else if (kind === "conditional_guidance" && existing.kind === "conditional_guidance") {
      next = fresh; // guidance changed: reset as a new lesson
    } else {
      // Opposite outcome: keep the established lesson, count the contradiction.
      const contradictions = existing.contradictionCount + 1;
      // Retire in THIS evaluation when contradictions reach reinforcements; never recreate it here.
      next = contradictions >= existing.reinforceCount
        ? null
        : { ...existing, targets: existing.targets.map((t) => ({ ...t })), contradictionCount: contradictions, lastSeenAt: now };
    }
  }
  const all = (next ? [...others, next] : others).sort(newestFirst).slice(0, LESSON_CAP);
  const rebuilt = rebuildTargetCatalog(all);
  return { ...state, memory: { lessons: rebuilt.lessons, targetCatalog: rebuilt.targetCatalog } };
}

function serializeMemoryBody(body: unknown): string {
  return JSON.stringify(body).replace(/</g, "\\u003c");
}

function renderPolicyMemory(state: LearningStateJSON, goalId: string, maxChars: number): { revision: string; text: string } {
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_MEMORY_CHARS) throw new RangeError("maxChars must be an integer >= 256");
  const catalog = state.memory.targetCatalog;
  const lessons = state.memory.lessons.filter((l) => l.goalId === goalId).sort(newestFirst).map((l) => ({
    kind: l.kind, appliesWhen: l.appliesWhen, mechanism: l.mechanism, recommendedChange: l.recommendedChange,
    targets: l.targetIndexes.filter((i) => i < catalog.length).map((i) => ({ file: catalog[i].file, change: catalog[i].change })),
  }));
  const own = (rec: object, k: string): boolean => Object.prototype.hasOwnProperty.call(rec, k);
  const allCooldowns = Object.keys(state.cooldowns).filter((arm) =>
    (own(state.opportunityCounters, arm) ? state.opportunityCounters[arm as ArmId] : 0) <= state.cooldowns[arm as ArmId].excludedThroughOpportunity,
  ).sort(lexCmp);
  let cooldowns = allCooldowns.slice(0, MEMORY_COOLDOWNS_MAX);
  const build = (): { revision: string; text: string } => {
    const body = serializeMemoryBody({ lessons, cooldowns, excludedCount: allCooldowns.length - cooldowns.length });
    const revision = hashId(["policy-memory-v1", body]);
    return { revision, text: `${MEMORY_OPEN_TAG}\nrevision:${revision}\n${body}\n${MEMORY_CLOSE_TAG}` };
  };
  let out = build();
  while (out.text.length > maxChars && lessons.length > 0) { lessons.pop(); out = build(); }
  while (out.text.length > maxChars && cooldowns.length > 0) { cooldowns = cooldowns.slice(0, -1); out = build(); }
  return out;
}

/**
 * Pure bounded renderer: <= maxChars UTF-16 units including tags and revision; `<` escaped as <.
 * Cooldowns are not goal-scoped: their keys are opaque arm hashes and the state cannot map them to a goal.
 */
export function getSubagentPolicyMemory(state: LearningStateJSON, goalId: string, maxChars: number = DEFAULT_MEMORY_CHARS): string {
  return renderPolicyMemory(state, goalId, maxChars).text;
}
