/**
 * telemetry.ts — read-only aggregation of omp session JSONL (format v3).
 *
 * Tolerant by construction:
 *  - a final incomplete line (a session still being written) is dropped, never
 *    parsed as a torn record;
 *  - the 256-byte physical title slot that current files begin with is skipped;
 *  - unknown entry types and unknown fields are preserved, not rejected;
 *  - the selected branch is followed by `parentId` links from the leaf, so a
 *    branched session aggregates the live path rather than every sibling;
 *  - live session files are only ever read, never written.
 *
 * `parentId` is conversation lineage. It is NOT a parent/child worker
 * relationship; workers are counted from sibling `<AgentName>.jsonl` files in
 * the parent session's artifact directory. Never infer spawn counts from it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAgentDir } from "./state.ts";

export type RawEntry = Record<string, unknown>;

export interface ParseResult {
  entries: RawEntry[];
  skipped: number;
  droppedFinalLine: boolean;
}

/** Parse session JSONL text. Never throws on malformed input. */
export function parseSessionText(text: string): ParseResult {
  const entries: RawEntry[] = [];
  let skipped = 0;
  const endsWithNewline = /\n$/.test(text);
  const lines = text.split(/\r?\n/);
  // An unterminated tail is a line the writer has not finished flushing.
  const complete = endsWithNewline ? lines : lines.slice(0, -1);
  const droppedFinalLine = !endsWithNewline && lines[lines.length - 1] !== "";
  for (const line of complete) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    const entry = parsed as RawEntry;
    // Fixed-width title slot written before the logical header.
    if (entry.type === "title") continue;
    entries.push(entry);
  }
  return { entries, skipped, droppedFinalLine };
}

export function sessionHeader(entries: RawEntry[]): RawEntry | undefined {
  const first = entries[0];
  return first && first.type === "session" ? first : undefined;
}

/** Root-to-leaf path following parentId, with a cycle bound. */
export function resolveBranch(entries: RawEntry[], leafId?: string): RawEntry[] {
  const byId = new Map<string, RawEntry>();
  for (const entry of entries) {
    const id = entry.id;
    if (typeof id === "string") byId.set(id, entry);
  }
  let leaf: RawEntry | undefined;
  if (leafId !== undefined) leaf = byId.get(leafId);
  else leaf = entries[entries.length - 1];
  if (!leaf) return [];
  const chain: RawEntry[] = [];
  const seen = new Set<string>();
  let current: RawEntry | undefined = leaf;
  while (current) {
    const id = typeof current.id === "string" ? current.id : undefined;
    if (id) {
      if (seen.has(id)) break; // corrupt cycle
      seen.add(id);
    }
    chain.push(current);
    const parent = current.parentId;
    current = typeof parent === "string" ? byId.get(parent) : undefined;
    if (chain.length > 1_000_000) break;
  }
  return chain.reverse();
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface Aggregates {
  requests: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  compactions: number;
  fallbacks: number;
  spawns: number;
  assistantModels: string[];
  fallbackModels: string[];
  usage: UsageTotals;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Aggregate one resolved branch. Pure; no I/O. */
export function aggregate(entries: RawEntry[]): Aggregates {
  const out: Aggregates = {
    requests: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    compactions: 0,
    fallbacks: 0,
    spawns: 0,
    assistantModels: [],
    fallbackModels: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 },
  };
  for (const entry of entries) {
    if (entry.type === "compaction") out.compactions += 1;
    if (entry.type === "spawn") out.spawns += 1;
    if (entry.type === "model_change") {
      const model = typeof entry.model === "string" ? entry.model : undefined;
      if (entry.resolvedModelIsFallback === true) {
        out.fallbacks += 1;
        if (model) out.fallbackModels.push(model);
      }
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as RawEntry;
    const role = msg.role;
    if (role === "toolResult") {
      out.toolResults += 1;
      if (msg.isError === true) out.toolErrors += 1;
      continue;
    }
    if (role !== "assistant") continue;
    out.requests += 1;
    const model = typeof msg.model === "string" ? msg.model : undefined;
    if (model) out.assistantModels.push(model);
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as RawEntry).type === "toolCall") {
          out.toolCalls += 1;
          if ((block as RawEntry).name === "vibe_spawn") out.spawns += 1;
        }
      }
    }
    const usage = msg.usage;
    if (usage && typeof usage === "object") {
      const u = usage as RawEntry;
      out.usage.input += num(u.input);
      out.usage.output += num(u.output);
      out.usage.cacheRead += num(u.cacheRead);
      out.usage.cacheWrite += num(u.cacheWrite);
      out.usage.totalTokens += num(u.totalTokens);
      out.usage.reasoningTokens += num(u.reasoningTokens);
    }
  }
  return out;
}

export interface SessionTotals {
  main: UsageTotals;
  workers: Record<string, UsageTotals>;
  combined: UsageTotals;
  cacheHitRate: number;
  peakWindowTokens: number;
  toolCalls: number;
  toolErrors: number;
  subagentSpawns: number;
}

function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/**
 * Roll up one resolved main branch plus sibling worker sessions into
 * session-level totals. Pure; no I/O. Worker keys are agent names from
 * sibling `<AgentName>.jsonl` files, never `parentId` lineage.
 */
export function sessionTotals(
  mainEntries: RawEntry[],
  workerEntriesByAgent: Record<string, RawEntry[]> = {},
): SessionTotals {
  const mainBranch = resolveBranch(mainEntries);
  const mainAgg = aggregate(mainBranch);

  const workers: Record<string, UsageTotals> = {};
  let combined: UsageTotals = { ...mainAgg.usage };
  let peakWindowTokens = 0;
  let toolCalls = mainAgg.toolCalls;
  let toolErrors = mainAgg.toolErrors;

  const observePeakWindow = (entries: RawEntry[]): void => {
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;
      const msg = message as RawEntry;
      if (msg.role !== "assistant") continue;
      const usage = msg.usage;
      if (!usage || typeof usage !== "object") continue;
      const u = usage as RawEntry;
      const window = num(u.input) + num(u.cacheRead) + num(u.cacheWrite) + num(u.output);
      if (window > peakWindowTokens) peakWindowTokens = window;
    }
  };
  observePeakWindow(mainBranch);

  let workerSpawns = 0;
  for (const [agentName, wEntries] of Object.entries(workerEntriesByAgent)) {
    const wAgg = aggregate(wEntries);
    workers[agentName] = wAgg.usage;
    combined = sumUsage(combined, wAgg.usage);
    toolCalls += wAgg.toolCalls;
    toolErrors += wAgg.toolErrors;
    workerSpawns += wAgg.spawns;
    observePeakWindow(wEntries);
  }

  return {
    main: mainAgg.usage,
    workers,
    combined,
    cacheHitRate: cacheReuse(combined),
    peakWindowTokens,
    toolCalls,
    toolErrors,
    subagentSpawns: Math.max(mainAgg.spawns + workerSpawns, Object.keys(workerEntriesByAgent).length),
  };
}

/**
 * Read one session JSONL plus its sibling worker artifact files and roll them
 * up. Returns zeroed totals when the session file is missing or unreadable.
 */
export function summarizeSessionFile(sessionJsonlPath: string): SessionTotals {
  let text: string;
  try {
    text = readFileSync(sessionJsonlPath, "utf8");
  } catch {
    return sessionTotals([]);
  }
  const mainParsed = parseSessionText(text);
  const artifactDir = sessionJsonlPath.replace(/\.jsonl$/i, "");
  const workerEntriesByAgent: Record<string, RawEntry[]> = {};
  for (const name of listWorkerSessions(artifactDir)) {
    const workerPath = join(artifactDir, name);
    let workerText: string;
    try {
      workerText = readFileSync(workerPath, "utf8");
    } catch {
      continue;
    }
    const agentName = name.replace(/\.jsonl$/i, "");
    workerEntriesByAgent[agentName] = parseSessionText(workerText).entries;
  }
  return sessionTotals(mainParsed.entries, workerEntriesByAgent);
}

/**
 * Cache reuse over turn two onwards.
 *
 * `input` excludes cached tokens in every omp provider payload inspected so
 * far (turn 2 of a real session reports input 5,816 with cacheRead 32,384), so
 * `cacheRead / (input + cacheRead)` is the fraction of prompt tokens served
 * from cache. It is an approximation, never a universal "cache hit
 * percentage": callers must keep reporting the four raw counters beside it.
 */
export function cacheReuse(usage: Pick<UsageTotals, "input" | "cacheRead">): number {
  const denominator = usage.input + usage.cacheRead;
  if (denominator <= 0) return 0;
  return usage.cacheRead / denominator;
}

export interface AcceptedCostAttempt {
  accepted: boolean;
  costUsd?: number | null;
  billingKind?: "per-token" | "per-request" | "unknown";
  requests?: number;
  tokens?: number;
}

export interface AcceptedCostSummary {
  status: "OK" | "UNDEFINED" | "UNKNOWN";
  acceptedCount: number;
  totalAttempts: number;
  totalTokenCostUsd: number | null;
  perRequestCalls: number;
  costPerAcceptedUsd: number | null;
}

export function computeAcceptedTaskCost(attempts: readonly AcceptedCostAttempt[]): AcceptedCostSummary {
  const totalAttempts = attempts.length;
  let acceptedCount = 0;
  let unknown = false;
  let totalTokenCostUsd = 0;
  let perRequestCalls = 0;
  for (const a of attempts) {
    if (a.accepted) acceptedCount += 1;
    const kind = a.billingKind ?? "unknown";
    if (kind === "unknown") unknown = true;
    if (kind === "per-request") {
      perRequestCalls += a.requests !== undefined && a.requests !== null ? Number(a.requests) : 1;
      if (a.costUsd === null || a.costUsd === undefined || !Number.isFinite(a.costUsd)) unknown = true;
      continue;
    }
    if (a.costUsd === null || a.costUsd === undefined || !Number.isFinite(a.costUsd)) { unknown = true; continue; }
    totalTokenCostUsd += a.costUsd;
  }
  if (acceptedCount === 0) return { status: "UNDEFINED", acceptedCount, totalAttempts, totalTokenCostUsd: null, perRequestCalls, costPerAcceptedUsd: null };
  if (unknown) return { status: "UNKNOWN", acceptedCount, totalAttempts, totalTokenCostUsd: null, perRequestCalls, costPerAcceptedUsd: null };
  return { status: "OK", acceptedCount, totalAttempts, totalTokenCostUsd, perRequestCalls, costPerAcceptedUsd: totalTokenCostUsd / acceptedCount };
}

/** Worker sessions are sibling `<AgentName>.jsonl` files in the artifact dir. */
export function listWorkerSessions(artifactDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(artifactDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => name !== "__advisor.jsonl")
    .filter((name) => !name.startsWith("__"))
    .sort();
}

/** Actual routing for one child session: declared role plus observed models. */
export function childRouting(entries: RawEntry[]): { roles: string[]; models: string[] } {
  const roles: string[] = [];
  const models: string[] = [];
  for (const entry of entries) {
    if (entry.type === "model_change" && typeof entry.role === "string" && entry.role.startsWith("subagent:")) {
      roles.push(entry.role);
    }
    if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message !== "object") continue;
      const msg = message as RawEntry;
      if (msg.role === "assistant" && typeof msg.model === "string") models.push(msg.model);
    }
  }
  return { roles, models };
}

/**
 * Resolve the omp session JSONL file for telemetry backfill.
 * 1. explicitOrEnv if it exists on disk;
 * 2. process.env.OMP_SESSION_FILE if it exists on disk;
 * 3. otherwise derive the newest top-level .jsonl under the omp agent sessions dir.
 */
export function resolveSessionFile(explicitOrEnv?: string, cwd?: string): string {
  if (typeof explicitOrEnv === "string" && explicitOrEnv.length > 0 && existsSync(explicitOrEnv)) {
    return explicitOrEnv;
  }
  const envFile = process.env.OMP_SESSION_FILE;
  if (typeof envFile === "string" && envFile.length > 0 && existsSync(envFile)) {
    return envFile;
  }
  const agentDir = resolveAgentDir();
  if (!agentDir) return "";
  const resolved = resolve(cwd ?? process.cwd());
  const sessionDirs = [
    join(agentDir, "sessions", `--${resolved.replace(/[:\\/]/g, "-")}--`),
    join(agentDir, "sessions", `--${resolved.replace(/[:\\/]+/g, "-")}--`),
  ];
  let latest: string | undefined;
  let latestMtime = -1;
  try {
    for (const sessionDir of sessionDirs) {
      let names: string[];
      try {
        names = readdirSync(sessionDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^\d{4}-\d{2}-\d{2}T.*\.jsonl$/i.test(name)) continue;
        const full = join(sessionDir, name);
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latest = full;
          }
        } catch {
          // skip unreadable entries
        }
      }
    }
  } catch {
    // session dir missing: fall through to ""
  }
  return latest ?? "";
}
