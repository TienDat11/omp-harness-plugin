import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MIN_SHADOW_SAMPLES } from "./skill-specs.ts";

export interface SkillRunRecord {
  runId: string; sessionId: string; turnIndex: number; skillName: string;
  skillSha256: string; taskCategory: string; modelId: string;
  loadMode: "auto_injected" | "holdout_control" | "agent_read" | "pointer_only" | "l1_autoload";
  holdout: boolean; routerScore: number; mutations: number; toolCalls: number;
  toolErrors: number; verifyRan: boolean; verifyPassed: boolean;
  hardReverted: boolean; acceptancePassRate: number | null;
  manualRating: number | null; reward: number | null; recordedAt: string;
}

export class SkillTelemetryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
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
