/**
 * session-metrics.ts — pure measurement over one parsed omp session.
 *
 * No I/O and not an extension. Classifies what happened after each
 * `session-stop-continuation` advisory block, sums active (non-idle) wall time
 * and reads cache reuse. Callers pass entries from `parseSessionText`; every
 * function tolerates missing or malformed fields and never throws.
 */
import { cacheReuse, resolveBranch, type RawEntry, type UsageTotals } from "./telemetry.ts";
import { classifyVerifyCommand } from "./verify-gate.ts";

export type StopLabel = "verified_pass" | "verified_fail" | "declared_no_check" | "user_took_over" | "ignored";

export interface StopBlock {
  label: StopLabel;
  unnecessary: boolean;
  caught: boolean;
  editsAfter: number;
  verifies: number;
}

export interface StopClassification {
  blocks: StopBlock[];
  counts: Record<string, number>;
}

const EDIT_TOOLS = new Set(["write", "edit", "ast_edit"]);
const NO_CHECK_RE =
  /no (applicable )?(check|test|verification)|nothing to verify|không có (check|test|kiểm (tra|chứng))/i;

function obj(value: unknown): RawEntry | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawEntry) : undefined;
}

function isStopBlock(entry: RawEntry): boolean {
  return entry.type === "custom_message" && entry.customType === "session-stop-continuation";
}

function isUserMessage(entry: RawEntry): boolean {
  return entry.type === "message" && obj(entry.message)?.role === "user";
}

/** Classify the outcome of each stop-continuation block on the active branch. */
export function classifyStopBlocks(
  entries: RawEntry[],
  opts: { isVerify?: (cmd: string) => boolean } = {},
): StopClassification {
  const isVerify = opts.isVerify ?? classifyVerifyCommand;
  let branch: RawEntry[] = [];
  try {
    branch = resolveBranch(entries);
  } catch {
    branch = [];
  }
  const blocks: StopBlock[] = [];
  const counts: Record<string, number> = {};

  for (let i = 0; i < branch.length; i++) {
    if (!isStopBlock(branch[i]!)) continue;
    let end = branch.length;
    let endsWithUser = false;
    for (let j = i + 1; j < branch.length; j++) {
      const e = branch[j]!;
      if (isStopBlock(e)) {
        end = j;
        break;
      }
      if (isUserMessage(e)) {
        end = j;
        endsWithUser = true;
        break;
      }
    }

    // Ordered events inside the window: edits and verifies (resolved by result).
    const verifyCalls = new Map<string, number>(); // toolCallId -> event index
    const events: Array<{ kind: "edit" } | { kind: "verify"; pass: boolean | undefined }> = [];
    let text = "";
    for (let j = i + 1; j < end; j++) {
      const msg = obj(branch[j]!.message);
      if (!msg || branch[j]!.type !== "message") continue;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const raw of msg.content) {
          const b = obj(raw);
          if (!b) continue;
          if (b.type === "text" && typeof b.text === "string") text += `${b.text}\n`;
          if (b.type !== "toolCall" || typeof b.name !== "string") continue;
          if (EDIT_TOOLS.has(b.name)) events.push({ kind: "edit" });
          else if (b.name === "bash") {
            const command = obj(b.arguments)?.command;
            if (typeof command === "string" && isVerify(command)) {
              events.push({ kind: "verify", pass: undefined });
              if (typeof b.id === "string") verifyCalls.set(b.id, events.length - 1);
            }
          }
        }
      } else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
        const idx = verifyCalls.get(msg.toolCallId);
        if (idx !== undefined) {
          const ev = events[idx];
          if (ev && ev.kind === "verify") ev.pass = !isFailedResult(msg);
        }
      }
    }

    const verifies = events.filter((e) => e.kind === "verify") as Array<{ kind: "verify"; pass: boolean | undefined }>;
    const editsAfter = events.length - verifies.length;
    let label: StopLabel;
    if (verifies.length > 0) label = verifies[verifies.length - 1]!.pass === false ? "verified_fail" : "verified_pass";
    else if (NO_CHECK_RE.test(text)) label = "declared_no_check";
    else if (endsWithUser) label = "user_took_over";
    else label = "ignored";

    const firstVerifyIdx = events.findIndex((e) => e.kind === "verify");
    const unnecessary =
      firstVerifyIdx >= 0 &&
      (events[firstVerifyIdx] as { pass: boolean | undefined }).pass !== false &&
      !events.slice(0, firstVerifyIdx).some((e) => e.kind === "edit");
    let caught = false;
    let sawFail = false;
    for (const v of verifies) {
      if (v.pass === false) sawFail = true;
      else if (sawFail) caught = true;
    }

    blocks.push({ label, unnecessary, caught, editsAfter, verifies: verifies.length });
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return { blocks, counts };
}

function isFailedResult(msg: RawEntry): boolean {
  if (msg.isError === true) return true;
  const details = obj(msg.details);
  for (const v of [msg.exitCode, details?.exitCode, details?.exit_code]) {
    if (typeof v === "number" && v !== 0) return true;
  }
  return false;
}

/** Sum deltas between consecutive timestamped active-branch entries, skipping idle gaps. */
export function activeWallMs(entries: RawEntry[], opts: { idleGapMs?: number } = {}): number {
  const idleGapMs = opts.idleGapMs ?? 300_000;
  let total = 0;
  let prev: number | undefined;
  for (const entry of resolveBranch(entries)) {
    const t = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(t)) continue;
    if (prev !== undefined) {
      const delta = t - prev;
      if (delta >= 0 && delta <= idleGapMs) total += delta;
    }
    prev = t;
  }
  return total;
}

export interface SessionMetrics {
  stopBlocks: { total: number; counts: Record<string, number>; unnecessary: number; caught: number };
  activeWallMs: number;
  cache: { provider?: string; model?: string; reuse: number };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function summarizeSessionMetrics(entries: RawEntry[]): SessionMetrics {
  const { blocks, counts } = classifyStopBlocks(entries);
  const branch = resolveBranch(entries);
  let provider: string | undefined;
  let model: string | undefined;
  const usage: Pick<UsageTotals, "input" | "cacheRead"> = { input: 0, cacheRead: 0 };
  for (const entry of branch) {
    if (entry.type === "model_change" && typeof entry.model === "string" && model === undefined) {
      const slash = entry.model.indexOf("/");
      if (slash > 0) {
        provider = provider ?? entry.model.slice(0, slash);
        model = entry.model.slice(slash + 1);
      } else model = entry.model;
    }
    const msg = obj(entry.message);
    if (entry.type !== "message" || msg?.role !== "assistant") continue;
    if (typeof msg.provider === "string") provider = msg.provider;
    if (typeof msg.model === "string") model = msg.model;
    const u = obj(msg.usage);
    if (u) {
      usage.input += num(u.input);
      usage.cacheRead += num(u.cacheRead);
    }
  }
  return {
    stopBlocks: {
      total: blocks.length,
      counts,
      unnecessary: blocks.filter((b) => b.unnecessary).length,
      caught: blocks.filter((b) => b.caught).length,
    },
    activeWallMs: activeWallMs(entries),
    cache: { ...(provider ? { provider } : {}), ...(model ? { model } : {}), reuse: cacheReuse(usage) },
  };
}
