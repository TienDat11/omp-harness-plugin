import { DatabaseSync } from "node:sqlite";
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
