/**
 * state.ts — the sole owner of module-level, session-local mutable state.
 *
 * Contract:
 *  - Imported library, never an omp factory. It must NOT appear in
 *    package.json#omp.extensions or harness.manifest.json#entrypoints, and it
 *    registers nothing: no `pi.on`, no `pi.register*`.
 *  - Nothing here is persisted. Every value dies with the process, so an
 *    approval granted in one session can never leak into the next.
 *  - Ownership is narrow on purpose:
 *      policy.ts      imports isSecretAllowed, isDestructiveAllowed, rememberReadStat, normalize*
 *      read-budget.ts imports getReadStat, normalizePathKey
 *      tools.ts       calls only the mutators (explicit user commands)
 *      intake.ts      reads/writes only Jev permission and clears it on shutdown
 *
 * omp rebinds extension factories per session but module-level variables stay
 * shared across parent and child sessions in one process (see the extensions
 * doc). That is exactly what "session-local" means here: one process, and
 * cleared on session_shutdown.
 */
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";

/** Absolute, forward-slash, case-folded on Windows, for stable comparison. */
export function normalizePathKey(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Normalized command signature used for one-shot destructive authorizations. */
export function normalizeCommandKey(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

const allowedSecrets = new Set<string>();
const allowedDestructive = new Set<string>();
let jevInputAllowed = false;
let suggestion: unknown = null;
let lastReceipt: unknown = null;
let submissions = 0;

/** Record one exact workspace-relative-or-absolute secret path as readable. */
export function allowSecret(p: string): string {
  const key = normalizePathKey(p);
  allowedSecrets.add(key);
  return key;
}

export function isSecretAllowed(p: string): boolean {
  return allowedSecrets.has(normalizePathKey(p));
}

/** Record one exact normalized command signature as authorized this session. */
export function allowDestructive(command: string): string {
  const key = normalizeCommandKey(command);
  allowedDestructive.add(key);
  return key;
}

export function isDestructiveAllowed(command: string): boolean {
  return allowedDestructive.has(normalizeCommandKey(command));
}

/** Input-egress permission for the Jev decision service. Never persisted. */
export function setJevInputAllowed(value: boolean): void {
  jevInputAllowed = value;
}

export function isJevInputAllowed(): boolean {
  return jevInputAllowed;
}

/** Bounded shadow suggestion. Only ever surfaced by /harness-decision status. */
export function setSuggestion(value: unknown): void {
  suggestion = value;
}

export function getSuggestion(): unknown {
  return suggestion;
}

/** Latest sanitized receipt (no raw state, no credentials). */
export function setLastReceipt(value: unknown): void {
  lastReceipt = value;
}

export function getLastReceipt(): unknown {
  return lastReceipt;
}

/** Counts top-level submissions so automatic classification runs once per task. */
export function noteSubmission(): number {
  submissions += 1;
  return submissions;
}

export function submissionCount(): number {
  return submissions;
}

/**
 * File identity captured when a `read` result arrives, keyed by tool-call id.
 * The duplicate-read guard compares the current stat against this baseline, so
 * a file changed outside the session is never mistaken for one already in
 * context. Missing entry (resumed session, cleared ledger) means "cannot prove
 * it is unchanged" and the read is allowed.
 */
const readStats = new Map<string, { mtimeMs: number; size: number }>();

export function rememberReadStat(toolCallId: string, mtimeMs: number, size: number): void {
  if (readStats.size >= 1024 && !readStats.has(toolCallId)) {
    const oldest = readStats.keys().next().value;
    if (oldest !== undefined) readStats.delete(oldest);
  }
  readStats.set(toolCallId, { mtimeMs, size });
}

export function getReadStat(toolCallId: string): { mtimeMs: number; size: number } | undefined {
  return readStats.get(toolCallId);
}

export function clearSessionState(): void {
  allowedSecrets.clear();
  allowedDestructive.clear();
  jevInputAllowed = false;
  suggestion = null;
  lastReceipt = null;
  submissions = 0;
  readStats.clear();
}

/** Maximum size of a harness log before rotation. */
export const MAX_HARNESS_LOG_BYTES = 512 * 1024;
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.HOME || env.USERPROFILE || "").trim();
  if (home) return home;
  try {
    const fallback = os.homedir().trim();
    return fallback || "";
  } catch {
    return "";
  }
}
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.PI_CODING_AGENT_DIR || "").trim();
  if (override) return path.resolve(override);
  const home = resolveHomeDir(env);
  return home ? path.join(home, ".omp", "agent") : "";
}
export function resolveUserHarnessDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.OMP_HARNESS_HOME || "").trim();
  if (override) return path.resolve(override);
  const home = resolveHomeDir(env);
  return home ? path.join(home, ".omp", "harness") : "";
}
export function writeTextFileAtomic(filePath: string, content: string): boolean {
  if (!filePath) return false;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/** Global harness log path, overridable via OMP_HARNESS_LOG_PATH. */
export function globalHarnessLogPath(): string {
  if (process.env.OMP_HARNESS_LOG_PATH) return process.env.OMP_HARNESS_LOG_PATH;
  const dir = resolveUserHarnessDir();
  return dir ? path.join(dir, "harness.log") : "";
}

/** Repo slug used to tag per-repo lines in the shared global harness log. */
export function repoSlug(cwd: string): string {
  return (path.basename(path.resolve(cwd || ".")) || "root").replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** Create parent dir, rotate once at the cap, then append one log entry. */
export function appendBoundedLog(filePath: string, entry: string): void {
  if (!filePath) return;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (existsSync(filePath) && statSync(filePath).size >= MAX_HARNESS_LOG_BYTES) {
      renameSync(filePath, `${filePath}.1`);
    }
    appendFileSync(filePath, entry, "utf8");
  } catch {
    // Telemetry never breaks a turn.
  }
}

/** Inject per-repo `p=` tag after the 2-char event code and write the line to the global harness log. */
export function logHarnessCode(cwd: string, line: string): void {
  if (!process.env.OMP_HARNESS_LOG_PATH && (process.env.OMP_HARNESS_TEST === "1" || process.execArgv.some((a) => a.includes("--test")) || process.env.NODE_TEST_CONTEXT !== undefined || (process.argv[1] ?? "").match(/(test|verify|run-probes)\.(mjs|js)$/i))) return;
  try {
    const formatted = /\bp=/.test(line) ? line : line.replace(/^([A-Z]\d) /, `$1 p=${repoSlug(cwd)} `);
    appendBoundedLog(globalHarnessLogPath(), `${formatted}\n`);
    if (cwd && path.join(cwd, ".omp", "harness") && existsSync(path.join(cwd, ".omp", "harness"))) {
      const localLogPath = path.join(cwd, ".omp", "harness", "harness.log");
      if (path.resolve(localLogPath) !== path.resolve(globalHarnessLogPath())) {
        appendBoundedLog(localLogPath, `${formatted}\n`);
      }
    }
  } catch {
    // Telemetry never breaks a turn.
  }
}

/**
 * Summarize compact global harness telemetry.
 * Parses lines starting with S1, M1, W1, W2, E1, G1.
 */
export function summarizeHarnessLog(text: string): string {
  const lines = text.split(/\r?\n/);
  const counts: Record<string, number> = {};
  const byKey: Record<string, Record<string, number>> = {};
  let sumMut = 0;
  let sumCalls = 0;
  let sumErr = 0;
  let sumR = 0;
  let m1Count = 0;
  let verify1 = 0;
  let deg = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([SMWEGC]\d)\s/.exec(line);
    if (!m) continue;
    const code = m[1];
    counts[code] = (counts[code] ?? 0) + 1;
    const fields = Object.fromEntries(line.slice(code.length + 1).match(/([a-z]+)=([^\s]+)/g)?.map((f) => f.split("=")) ?? []);
    if (code === "M1") {
      m1Count += 1;
      const mut = Number(fields.mut ?? 0);
      const calls = Number(fields.calls ?? 0);
      const err = Number(fields.err ?? 0);
      const r = Number(fields.r ?? 0);
      sumMut += Number.isFinite(mut) ? mut : 0;
      sumCalls += Number.isFinite(calls) ? calls : 0;
      sumErr += Number.isFinite(err) ? err : 0;
      sumR += Number.isFinite(r) ? r : 0;
      if (fields.v === "1") verify1 += 1;
    }
    if (code === "S1" || code === "W1" || code === "W2" || code === "E1" || code === "G1") {
      const k = fields.skill ?? fields.k ?? fields.rc ?? fields.ec ?? fields.s ?? fields.st ?? "";
      if (k !== "") {
        if (!byKey[code]) byKey[code] = {};
        byKey[code][String(k)] = (byKey[code][String(k)] ?? 0) + 1;
      }
      if (code === "W1" && fields.d === "1") deg += 1;
    }
  }
  const avgR = m1Count > 0 ? sumR / m1Count : 0;
  const w1Map = byKey["W1"] ?? {};
  const ecMap = byKey["E1"] ?? {};
  const rcMap = byKey["G1"] ?? {};
  const kMap = byKey["W2"] ?? {};
  let ready = 0;
  let fail = 0;
  for (const [k, v] of Object.entries(w1Map)) {
    if (k === "1") ready += v;
    else if (k === "2" || k === "3") fail += v;
  }
  const ecSummary = Object.entries(ecMap).map(([k, v]) => `${k}=${v}`).join(", ");
  const rcSummary = Object.entries(rcMap).map(([k, v]) => `${k}=${v}`).join(", ");
  const kSummary = Object.entries(kMap).map(([k, v]) => `${k}=${v}`).join(", ");
  return [
    `turns=${counts.M1 ?? 0} mut=${sumMut} calls=${sumCalls} err=${sumErr} verify=${verify1}/${m1Count} avgR=${avgR.toFixed(2)}`,
    `skills: s1=${counts.S1 ?? 0} | workers: w1=${counts.W1 ?? 0} ready=${ready} fail=${fail} deg=${deg}`,
    `errors(E1)=${ecSummary} | guards(G1)=${rcSummary} | alerts(W2)=${kSummary} | cache(C1)=${counts.C1 ?? 0}`,
  ].join("\n");
}
