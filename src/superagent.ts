/**
 * superagent.ts — omp-superagent-prototype (Router–Worker–Watchdog).
 *
 * Pure, deterministic state machine plus a thin ExtensionAPI wiring.
 *
 * Router: `openTicket` / `assignWorker` route goals to agents as tickets and
 * assignments. Worker: `recordWorkerReport` records worker outcomes and moves
 * ticket stages. Watchdog: `recordFileEdit`, `requeueExpiredTicket`, and
 * `inspectSubagentResult` emit `WatchdogAlert`s (edit-thrash,
 * retry-exhausted, waits-for-person, degraded-output).
 *
 * Cache safety: never touches `systemPrompt`, never rewrites conversation
 * history, and never blocks `bash` on the main session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizePathKey, logHarnessCode, writeTextFileAtomic } from "./state.ts";
import { classifyVerifyCommand, isMutatingTaskCall, READ_ONLY_AGENTS } from "./verify-gate.ts";
import { sessionStateKey } from "./skill-telemetry.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export type WorkerReportKind =
  | "progress"
  | "question"
  | "ready"
  | "dropped"
  | "failed"
  | "blocked";

export type TicketStage =
  | "planned"
  | "running"
  | "ready"
  | "blocked"
  | "failed"
  | "dropped"
  | "unavailable";

export interface Ticket {
  ticketId: string;
  goal: string;
  stage: TicketStage;
  waitsForPerson: boolean;
  retryCount: number;
  allowedPaths: string[];
  targetPaths: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Assignment {
  assignmentId: string;
  ticketId: string;
  agent: string;
  status: "active" | "completed" | "degraded" | "dropped" | "failed" | "spawned";
  startedAt: number;
  completedAt?: number;
}

export interface WorkerReport {
  kind: WorkerReportKind;
  ticketId: string;
  agent: string;
  summary?: string;
  degraded?: boolean;
  at: number;
}

export type WatchdogAlertKind =
  | "edit-thrash"
  | "degraded-output"
  | "waits-for-person"
  | "retry-exhausted"
  | "out-of-scope-edit";

export interface WatchdogAlert {
  alertId: string;
  kind: WatchdogAlertKind;
  ticketId: string;
  target: string;
  detail: string;
  at: number;
}

export type DegradedReason =
  | "abort-reason"
  | "cancelled"
  | "no-output"
  | "leaked-tool-call"
  | "premature-yield"
  | "unevidenced-ready";

export interface SubagentInspection {
  degraded: boolean;
  reason?: DegradedReason;
  signal?: string;
  recoveryHint?: string;
  alert?: WatchdogAlert;
  escalate?: { from: string; to: string; reason: DegradedReason; occurrences: number };
}

export interface SuperagentPacket {
  target: string;
  change: string;
  acceptance: string[];
  stop: string;
}

export interface SuperagentState {
  tickets: Map<string, Ticket>;
  assignments: Map<string, Assignment>;
  reports: WorkerReport[];
  alerts: WatchdogAlert[];
  editsSinceVerify: Map<string, number>;
  seq: number;
  degradedCounts: Record<string, number>; // key: `${ticketId}:${agent}:${reason}`
  escalateAfter: number;                  // default 2; 0 disables escalation entirely
  pendingInspections: SubagentInspection[];
}

export interface SuperagentDeps {
  now?: () => number;
  maxEditsWithoutVerify?: number;
  maxRetries?: number;
  maxSurgicalFiles?: number;
  persistState?: boolean;
}

const DEFAULT_NOW = () => Date.now();

export const DEFAULT_MAX_SURGICAL_FILES = 5;

export function createSuperagentState(): SuperagentState {
  return {
    tickets: new Map(),
    assignments: new Map(),
    reports: [],
    alerts: [],
    editsSinceVerify: new Map(),
    seq: 0,
    degradedCounts: {},
    escalateAfter: 2,
    pendingInspections: [],
  };
}

function nextSeq(state: SuperagentState): number {
  return (state.seq += 1);
}

const PACKET_SECTIONS: ReadonlyArray<keyof SuperagentPacket> = ["target", "change", "acceptance", "stop"];

function parsePacketSections(input: string): Partial<SuperagentPacket> {
  const packet: Partial<SuperagentPacket> = { acceptance: [] };
  let current: keyof SuperagentPacket | null = null;
  for (const rawLine of input.split("\n")) {
    const heading = rawLine.match(/^#\s+([^\n]+?)\s*$/)?.[1];
    if (heading !== undefined) {
      const name = heading.trim().toLowerCase();
      current = PACKET_SECTIONS.includes(name as keyof SuperagentPacket)
        ? (name as keyof SuperagentPacket)
        : null;
      continue;
    }
    if (current === null) continue;
    if (current === "acceptance") {
      const item = rawLine.trim().replace(/^[-*]\s+/, "");
      if (item !== "") (packet.acceptance as string[]).push(item);
    } else {
      const previous = packet[current] ?? "";
      packet[current] = previous === "" ? rawLine : `${previous}\n${rawLine}`;
    }
  }
  for (const key of ["target", "change", "stop"] as const) {
    const value = packet[key];
    packet[key] = value == null ? "" : String(value).trim();
  }
  return packet;
}

export type ValidatePacketResult =
  | { ok: true; packet: SuperagentPacket }
  | { ok: false; missing: string[] };

export function validatePacket(
  input: string | Partial<SuperagentPacket>,
): ValidatePacketResult {
  const packet: Partial<SuperagentPacket> =
    typeof input === "string"
      ? parsePacketSections(input)
      : { ...input, acceptance: input.acceptance ?? [] };

  const missing: string[] = [];
  if (!packet.target) missing.push("target");
  if (!packet.change) missing.push("change");
  if (!packet.acceptance || packet.acceptance.length === 0) missing.push("acceptance");
  if (!packet.stop) missing.push("stop");

  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    packet: {
      target: packet.target as string,
      change: packet.change as string,
      acceptance: [...(packet.acceptance as string[])],
      stop: packet.stop as string,
    },
  };
}

export function openTicket(
  state: SuperagentState,
  goal: string,
  allowedPaths: string[] = [],
  ticketId: string = `ticket-${nextSeq(state)}`,
  now: number = DEFAULT_NOW(),
): Ticket {
  const ticket: Ticket = {
    ticketId,
    goal,
    stage: "planned",
    waitsForPerson: false,
    retryCount: 0,
    allowedPaths: [...allowedPaths],
    targetPaths: extractTargetPaths(goal),
    createdAt: now,
    updatedAt: now,
  };
  state.tickets.set(ticketId, ticket);
  return ticket;
}

export function assignWorker(
  state: SuperagentState,
  ticketId: string,
  agent: string,
  now: number = DEFAULT_NOW(),
): Assignment {
  const ticket = state.tickets.get(ticketId);
  if (
    ticket !== undefined &&
    !ticket.waitsForPerson &&
    (ticket.stage === "planned" ||
      ticket.stage === "running" ||
      ticket.stage === "blocked" ||
      ticket.stage === "failed")
  ) {
    ticket.stage = "running";
    ticket.updatedAt = now;
  }
  const assignment: Assignment = {
    assignmentId: `assign-${nextSeq(state)}`,
    ticketId,
    agent,
    status: "active",
    startedAt: now,
  };
  state.assignments.set(assignment.assignmentId, assignment);
  return assignment;
}

export function requeueExpiredTicket(
  state: SuperagentState,
  ticketId: string,
  maxRetries: number = 2,
  now: number = DEFAULT_NOW(),
): Ticket {
  const ticket = state.tickets.get(ticketId);
  if (ticket === undefined) {
    throw new Error(`superagent: unknown ticket ${ticketId}`);
  }
  ticket.retryCount += 1;
  ticket.updatedAt = now;
  if (ticket.retryCount > maxRetries) {
    ticket.stage = "unavailable";
    state.alerts.push({
      alertId: `alert-${nextSeq(state)}`,
      kind: "retry-exhausted",
      ticketId,
      target: ticketId,
      detail: `ticket ${ticketId} exhausted ${ticket.retryCount} retries`,
      at: now,
    });
  }
  return ticket;
}

export function recordWorkerReport(
  state: SuperagentState,
  report: { kind: WorkerReportKind; ticketId: string; agent: string; summary?: string; degraded?: boolean },
  now: number = DEFAULT_NOW(),
): WorkerReport {
  const entry: WorkerReport = { ...report, at: now };
  state.reports.push(entry);

  const ticket = state.tickets.get(report.ticketId);
  if (ticket === undefined) return entry;
  ticket.updatedAt = now;

  switch (report.kind) {
    case "ready":
      ticket.stage = "ready";
      {
        const assignments = [...state.assignments.values()].reverse();
        const a = assignments.find(
          (x) => x.ticketId === report.ticketId && x.agent === report.agent && x.status === "active",
        );
        if (a) {
          a.status = "completed";
          a.completedAt = now;
        }
      }
      break;
    case "blocked":
      ticket.stage = "blocked";
      ticket.waitsForPerson = true;
      state.alerts.push({
        alertId: `alert-${nextSeq(state)}`,
        kind: "waits-for-person",
        ticketId: report.ticketId,
        target: report.ticketId,
        detail: report.summary ?? `worker ${report.agent} blocked on ticket ${report.ticketId}`,
        at: now,
      });
      {
        const assignments = [...state.assignments.values()].reverse();
        const a = assignments.find(
          (x) =>
            x.ticketId === report.ticketId &&
            x.agent === report.agent &&
            (x.status === "active" || x.status === "degraded"),
        );
        if (a) {
          a.status = "failed";
          a.completedAt = now;
        }
      }
      break;
    case "failed":
      ticket.stage = "failed";
      ticket.waitsForPerson = true;
      state.alerts.push({
        alertId: `alert-${nextSeq(state)}`,
        kind: "waits-for-person",
        ticketId: report.ticketId,
        target: report.ticketId,
        detail: report.summary ?? `worker ${report.agent} failed on ticket ${report.ticketId}`,
        at: now,
      });
      {
        const assignments = [...state.assignments.values()].reverse();
        const a = assignments.find(
          (x) =>
            x.ticketId === report.ticketId &&
            x.agent === report.agent &&
            (x.status === "active" || x.status === "degraded"),
        );
        if (a) {
          a.status = "failed";
          a.completedAt = now;
        }
      }
      break;
    case "dropped":
      ticket.stage = "dropped";
      {
        const assignments = [...state.assignments.values()].reverse();
        const a = assignments.find(
          (x) => x.ticketId === report.ticketId && x.agent === report.agent && x.status === "active",
        );
        if (a) {
          a.status = "dropped";
          a.completedAt = now;
        }
      }
      break;
    default:
      // "progress" and "question": no stage change.
      break;
  }
  return entry;
}

export function noteHumanTurn(state: SuperagentState): void {
  for (const ticket of state.tickets.values()) {
    ticket.waitsForPerson = false;
  }
}

export function recordFileEdit(
  state: SuperagentState,
  filePath: string,
  ticketId: string = "main",
  maxEdits: number = 4,
  now: number = DEFAULT_NOW(),
): WatchdogAlert | undefined {
  if (isInternalSchemePath(filePath)) return undefined;
  const key = normalizePathKey(filePath);
  const count = (state.editsSinceVerify.get(key) ?? 0) + 1;
  state.editsSinceVerify.set(key, count);
  if (count < maxEdits) return undefined;
  const alert: WatchdogAlert = {
    alertId: `alert-${nextSeq(state)}`,
    kind: "edit-thrash",
    ticketId,
    target: key,
    detail: `${count} edits on ${filePath} without a passing verify (limit ${maxEdits})`,
    at: now,
  };
  state.alerts.push(alert);
  state.editsSinceVerify.set(key, 1);
  return alert;
}

export function recordVerifyPass(state: SuperagentState): void {
  state.editsSinceVerify.clear();
  // A passing verification resets the surgical tracking: the ticket's target
  // and allowed scope no longer constrains edits until a new ticket defines paths.
  for (const ticket of state.tickets.values()) {
    ticket.targetPaths = [];
    ticket.allowedPaths = [];
  }
}
const PATH_EXT_RE = /\.(ts|js|mjs|json|md|yml|yaml|py|sh|css|html)(?:[?#].*)?$/i;
const STRIP_SCHEME_RE =
  /^(https?|skill|local|agent|proc|xd|out|cfg|memory|history|artifact|issue|pr|mcp|ssh|security|omp):\/\//i;

export function isInternalSchemePath(input: string): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^"|"$/g, "")
    .replace(/^'|'$/g, "")
    .replace(/^\[|]$/g, "")
    .trim();
  return STRIP_SCHEME_RE.test(trimmed);
}

function unwrapMarkdown(token: string): string {
  const m = token.match(/^\[([^\]]+)\]\([^)]*\)$/);
  if (m) return m[1].trim();
  let out = token;
  out = out.replace(/`/g, "");
  out = out.replace(/^\*{1,2}|^\_{1,2}|^~{1,2}/, "");
  out = out.replace(/[,;:]+$/, "");
  out = out.replace(/\*{1,2}$|\_{1,2}$|~{1,2}$/, "");
  out = out.replace(/^\[\[?/, "").replace(/\]\]?$/, "");
  out = out.replace(/^\(|\)$/g, "");
  out = out.replace(/^["'<]+|["'>]+$/g, "");
  out = out.replace(/[,;:]+$/, "");
  return out.trim();
}

function stripPathNoise(path: string): string {
  return unwrapMarkdown(path)
    .replace(/^\[|]$/g, "")
    .replace(/#.*$/, "")
    .replace(/(?::\d+(?:-\d+)?)$/, "")
    .trim();
}

function looksLikePath(input: string): boolean {
  if (!input || /[(|?*<>\\]/.test(input)) return false;
  if (/^[A-Za-z0-9_@.~-][A-Za-z0-9_./~-]*\.[A-Za-z0-9]{1,8}$/.test(input)) return true;
  const dirPrefixes = ["src/", "test/", "tests/", "scripts/", "skills/", "agents/", "docs/", "config/", ".omp/"];
  if (dirPrefixes.some((pre) => input.startsWith(pre))) return true;
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(input);
}

export function extractTargetPaths(input: string | Partial<SuperagentPacket>): string[] {
  const raw: string[] =
    typeof input === "string" ? [input] : (typeof input.target === "string" && input.target !== "" ? [input.target] : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    for (const token of item.split(/\s+/)) {
      const cleaned = stripPathNoise(token);
      if (!cleaned || !looksLikePath(cleaned)) continue;
      if (STRIP_SCHEME_RE.test(cleaned)) continue;
      const key = normalizePathKey(cleaned);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function recordTargetFiles(
  state: SuperagentState,
  ticketId: string,
  source: string[] | string | Partial<SuperagentPacket>,
  now: number = DEFAULT_NOW(),
): Ticket | undefined {
  const ticket = state.tickets.get(ticketId);
  if (ticket === undefined) return undefined;

  const incoming: string[] =
    Array.isArray(source)
      ? source.map((p) => normalizePathKey(stripPathNoise(p)))
      : extractTargetPaths(source);

  const merged = new Set<string>(ticket.targetPaths);
  for (const p of incoming) {
    if (!p || merged.has(p)) continue;
    merged.add(p);
  }
  ticket.targetPaths = [...merged];
  ticket.updatedAt = now;
  return ticket;
}

export function checkSurgicalScope(
  state: SuperagentState,
  filePath: string,
  ticketId: string = "main",
  maxSurgicalFiles: number = DEFAULT_MAX_SURGICAL_FILES,
  now: number = DEFAULT_NOW(),
): WatchdogAlert | undefined {
  if (isInternalSchemePath(filePath)) return undefined;
  const key = normalizePathKey(filePath);
  if (!key) return undefined;

  const ticket = state.tickets.get(ticketId);

  // Surgical fanout is a hard global limit on distinct unverified edited files,
  // regardless of whether the probed file is inside the ticket scope. Check it
  // first so a fanout block is reported before any per-file scope check.
  const distinctCount = state.editsSinceVerify.has(key)
    ? state.editsSinceVerify.size
    : state.editsSinceVerify.size + 1;
  if (distinctCount > maxSurgicalFiles) {
    const alert: WatchdogAlert = {
      alertId: `alert-${nextSeq(state)}`,
      kind: "out-of-scope-edit",
      ticketId,
      target: key,
      detail: `surgical fanout exceeded: ${distinctCount} distinct files edited without a passing verification run (max ${maxSurgicalFiles})`,
      at: now,
    };
    state.alerts.push(alert);
    return alert;
  }

  // The path-containment check fires only when the ticket exists and carries
  // targetPaths or allowedPaths.
  if (ticket !== undefined && (ticket.targetPaths.length > 0 || ticket.allowedPaths.length > 0)) {
    const allowed = [...ticket.targetPaths, ...ticket.allowedPaths].map(normalizePathKey);
    const inScope = allowed.some((p) => key === p || key.endsWith("/" + p) || p.endsWith("/" + key));
    if (!inScope) {
      const alert: WatchdogAlert = {
        alertId: `alert-${nextSeq(state)}`,
        kind: "out-of-scope-edit",
        ticketId,
        target: key,
        detail: `file "${key}" is outside ticket "${ticketId}" target scope`,
        at: now,
      };
      state.alerts.push(alert);
      return alert;
    }
  }

  return undefined;
}

/**
 * Open or update ticket "main" on `state.tickets` with the given `allowedPaths`,
 * so `checkSurgicalScope(state, target, "main", ...)` enforces Karpathy surgical scope.
 */
export function bindMainTicketPaths(
  state: SuperagentState,
  paths: string[],
  now: number = DEFAULT_NOW(),
): Ticket {
  let ticket = state.tickets.get("main");
  if (ticket === undefined) {
    ticket = openTicket(state, "main", paths, "main", now);
  } else {
    const merged = new Set<string>([...ticket.allowedPaths, ...paths].map((p) => normalizePathKey(p)));
    ticket.allowedPaths = [...merged];
    ticket.updatedAt = now;
  }
  return ticket;
}

export const SUPERAGENT_CONTRACT_TAG = "<superagent-worker-contract>";

/** Goldfish anti-drift contract tag and block, appended to subagent task/vibe_spawn inputs. */
export const GOLDFISH_CONTRACT_TAG = "<superagent-worker-contract>";
export const GOLDFISH_CONTRACT_BLOCK = [
  GOLDFISH_CONTRACT_TAG,
  "Keep `<superagent-worker-contract>` tag and existing rules, plus Karpathy's 4 rules adapted for autonomous subagents + Lauren Tan's `/interrogate` Goldfish self-check:",
  "1. Think Before Coding: Verify assumptions against `# Target`, `# Change`, and `# Acceptance` using read-only tools before editing; only emit `[SUPERAGENT-REPORT: question]` or `[SUPERAGENT-REPORT: blocked]` if a required prerequisite is unreachable from repo context (never pause for interactive human confirmation on normal tasks).",
  "2. Simplicity First: Write the minimum code that satisfies `# Acceptance`; zero speculative abstractions.",
  "3. Surgical Changes Only: Touch ONLY files listed in `# Target`; never reformat or modify unrelated adjacent code.",
  "4. Goal-Driven + `/interrogate` Self-Check: Write target deliverables before exploratory reads exhaust runtime budget, skip full-suite builds mid-wave when siblings run in parallel, verify touched files match `# Target` with zero unstated assumptions, and end with `[SUPERAGENT-REPORT: ready|blocked|failed|question]`.",
  "Write target deliverables before exploratory reads exhaust runtime budget (never end with `(no output)`).",
  "When running in a parallel wave (`tasks.length >= 2`), skip full-repo test/build suites mid-flight so sibling workers do not collide.",
  "Conclude with `[SUPERAGENT-REPORT: ready|blocked|failed|question]`.",
  "</superagent-worker-contract>",
].join("\n");

export function resolveSuperagentTaskInput(
  input: Record<string, unknown>,
  state?: SuperagentState,
): Record<string, unknown> | undefined {
  const tag = GOLDFISH_CONTRACT_TAG;
  const block = GOLDFISH_CONTRACT_BLOCK;

  const context = typeof input.context === "string" ? input.context : "";
  if (context.includes(tag)) return undefined;

  const next: Record<string, unknown> = { ...input };
  if (typeof input.context === "string") {
    next.context = context === "" ? block : `${context}\n\n${block}`;
    return next;
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks : undefined;
  if (tasks && tasks.length > 0) {
    const updatedTasks: Record<string, unknown>[] = [...(tasks as Record<string, unknown>[])];
    let changed = false;
    for (let i = 0; i < updatedTasks.length; i += 1) {
      const t = updatedTasks[i];
      if (!t || typeof t !== "object") continue;
      const tCopy = { ...t } as Record<string, unknown>;
      const taskField = typeof tCopy.task === "string" ? tCopy.task : "";
      const assignment = typeof tCopy.assignment === "string" ? tCopy.assignment : "";
      const description = typeof tCopy.description === "string" ? tCopy.description : "";
      const target = taskField || assignment || description;
      if (target.includes(tag)) continue;
      if (taskField !== "") {
        tCopy.task = `${taskField}\n\n${block}`;
      } else if (assignment !== "") {
        tCopy.assignment = assignment === "" ? block : `${assignment}\n\n${block}`;
      } else if (description !== "") {
        tCopy.description = description === "" ? block : `${description}\n\n${block}`;
      }
      updatedTasks[i] = tCopy;
      changed = true;
    }
    if (changed) {
      next.tasks = updatedTasks;
      return next;
    }
  }
  return undefined;
}

const ABORT_REASON_RE = /<abort-reason>/;
const CANCELLED_RE = /status="cancelled"/;
const NO_OUTPUT_RE = /\(no output\)/;

// DeepSeek failure modes (see #PLAN-CODER-A).
export const LEAKED_TOOL_CALL_RE = /<tool_call>[\s\S]*?<function=|<function=\w+>[\s\S]*?</i;
export const PREMATURE_YIELD_RE = /\b(I need to complete the remaining steps|Next actions to close the ticket|Let me execute\.)\s*$/i;

// `[SUPERAGENT-REPORT: ready]` marker used by the premature-yield / unevidenced-ready checks.
const SUPERAGENT_READY_RE = /\[SUPERAGENT-REPORT:\s*ready\]/;

// A command line followed by at least one non-empty output line.
export const EVIDENCE_TOKEN_RE = /^\$\s+\S[^\n]*\n(?!\s*$)\s*\S/m;

// One executed-command evidence line, or a recognised verify command with its result token.
function hasEvidenceToken(rawOutput: string): boolean {
  if (EVIDENCE_TOKEN_RE.test(rawOutput)) return true;
  if (/^evidence:\s*\S/m.test(rawOutput)) return true;
  if (classifyVerifyCommand(rawOutput) && /# pass \d+/.test(rawOutput)) return true;
  return false;
}

const RECOVERY_HINTS: Record<DegradedReason, string> = {
  "abort-reason":
    "Re-run the worker after clearing the abort; the previous run stopped before completing its steps.",
  cancelled:
    "Re-run the worker; the previous run was cancelled before it produced a report.",
  "no-output":
    "Re-run the worker; it returned no output at all.",
  "leaked-tool-call":
    "Re-emit the last worker turn with the tool call as a real tool invocation, not plain text.",
  "premature-yield":
    "Re-run the worker; emit [SUPERAGENT-REPORT: ready] only after all steps complete.",
  "unevidenced-ready":
    "Re-run the worker; 'ready' requires at least one executed command with observed output.",
};

function escalateTarget(agent: string): string | undefined {
  return agent === "task" || agent === "coder" ? "architect" : undefined;
}

export function inspectSubagentResult(
  state: SuperagentState,
  rawOutput: string,
  ticketId: string = "main",
  agent: string = "task",
  now: number = DEFAULT_NOW(),
): SubagentInspection {
  let reason: DegradedReason | undefined;
  let signal: string | undefined;

  if (ABORT_REASON_RE.test(rawOutput)) {
    reason = "abort-reason";
    signal = "<abort-reason>";
  } else if (CANCELLED_RE.test(rawOutput)) {
    reason = "cancelled";
    signal = 'status="cancelled"';
  } else if (NO_OUTPUT_RE.test(rawOutput)) {
    reason = "no-output";
    signal = "(no output)";
  } else if (LEAKED_TOOL_CALL_RE.test(rawOutput)) {
    reason = "leaked-tool-call";
    signal = LEAKED_TOOL_CALL_RE.source;
  } else if (!SUPERAGENT_READY_RE.test(rawOutput) && PREMATURE_YIELD_RE.test(rawOutput)) {
    reason = "premature-yield";
    signal = PREMATURE_YIELD_RE.source;
  } else if (
    SUPERAGENT_READY_RE.test(rawOutput) &&
    !hasEvidenceToken(rawOutput) &&
    isMutatingTaskCall({ agent }) &&
    !agent.startsWith("egm-")
  ) {
    reason = "unevidenced-ready";
    signal = "[SUPERAGENT-REPORT: ready]";
  }

  if (reason === undefined) return { degraded: false };

  let assignmentId: string | undefined;
  for (const assignment of [...state.assignments.values()].reverse()) {
    if (
      assignment.ticketId === ticketId &&
      assignment.agent === agent &&
      assignment.status === "active"
    ) {
      assignment.status = "degraded";
      assignment.completedAt = now;
      assignmentId = assignment.assignmentId;
      break;
    }
  }

  const alert: WatchdogAlert = {
    alertId: `alert-${nextSeq(state)}`,
    kind: "degraded-output",
    ticketId,
    target: assignmentId ?? agent,
    detail: `degraded output from ${agent} on ticket ${ticketId}: ${signal}`,
    at: now,
  };
  state.alerts.push(alert);

  const key = `${ticketId}:${agent}:${reason}`;
  const occurrences = (state.degradedCounts[key] ?? 0) + 1;
  state.degradedCounts[key] = occurrences;

  const escalateTo = escalateTarget(agent);
  let escalate: SubagentInspection["escalate"] | undefined;
  if (
    escalateTo !== undefined &&
    state.escalateAfter > 0 &&
    occurrences >= state.escalateAfter
  ) {
    escalate = {
      from: agent,
      to: escalateTo,
      reason,
      occurrences,
    };
    alert.detail += `; escalate ${agent} -> ${escalateTo} (${reason} x${occurrences}); do not re-run the same tier with the same spec`;
  }

  const result: SubagentInspection = {
    degraded: true,
    reason,
    signal,
    recoveryHint: RECOVERY_HINTS[reason],
    alert,
    escalate,
  };
  state.pendingInspections.push(result);
  return result;
}

const TICKET_STAGES: ReadonlyArray<TicketStage> = [
  "planned",
  "running",
  "ready",
  "blocked",
  "failed",
  "dropped",
  "unavailable",
];
const ASSIGNMENT_STATUSES: ReadonlyArray<Assignment["status"]> = [
  "active",
  "completed",
  "degraded",
  "dropped",
  "failed",
  "spawned",
];
const ALERT_KINDS: ReadonlyArray<WatchdogAlert["kind"]> = [
  "edit-thrash",
  "degraded-output",
  "waits-for-person",
  "retry-exhausted",
  "out-of-scope-edit",
];

function countBy<T>(items: Iterable<T>, keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function formatSuperagentStatus(state: SuperagentState): string {
  const stageCounts = countBy(state.tickets.values(), (t) => t.stage);
  const statusCounts = countBy(state.assignments.values(), (a) => a.status);
  const kindCounts = countBy(state.alerts.values(), (a) => a.kind);
  const waiting = [...state.tickets.values()].filter((t) => t.waitsForPerson).length;
  const edits = [...state.editsSinceVerify.values()].reduce((sum, n) => sum + n, 0);

  return [
    "superagent status",
    `tickets: ${state.tickets.size} (${TICKET_STAGES.map((s) => `${s}: ${stageCounts.get(s) ?? 0}`).join(", ")})`,
    `assignments: ${state.assignments.size} (${ASSIGNMENT_STATUSES.map((s) => `${s}: ${statusCounts.get(s) ?? 0}`).join(", ")})`,
    `reports: ${state.reports.length}`,
    `alerts: ${state.alerts.length} (${ALERT_KINDS.map((k) => `${k}: ${kindCounts.get(k) ?? 0}`).join(", ")})`,
    `waiting for person: ${waiting}`,
    `edits since verify: ${edits}`,
    `seq: ${state.seq}`,
  ].join("\n");
}
export function extractToolResultOutput(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const ev = event as Record<string, unknown>;
  if (typeof ev.content === "string" && ev.content !== "") return ev.content;
  if (Array.isArray(ev.content)) {
    const parts: string[] = [];
    for (const block of ev.content) {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    const joined = parts.join("\n");
    if (joined !== "") return joined;
  }
  if (typeof ev.output === "string" && ev.output !== "") return ev.output;
  const input =
    ev.input && typeof ev.input === "object"
      ? (ev.input as Record<string, unknown>)
      : undefined;
  if (input && typeof input.output === "string") return input.output;
  return "";
}

export function resolveTaskAgentName(
  input: Record<string, unknown> | null | undefined,
  fallback: string = "task",
): string {
  if (!input || typeof input !== "object") return fallback;
  if (typeof input.agent === "string" && input.agent.trim() !== "") {
    return input.agent.trim();
  }
  if (Array.isArray(input.tasks)) {
    const agents: string[] = [];
    for (const item of input.tasks) {
      if (item && typeof item === "object") {
        const a = (item as Record<string, unknown>).agent;
        if (typeof a === "string" && a.trim() !== "") agents.push(a.trim());
      }
    }
    const escalatable = agents.find((a) => a === "coder" || a === "task");
    if (escalatable) return escalatable;
    const mutating = agents.find((a) => !READ_ONLY_AGENTS.has(a) && !a.startsWith("egm-"));
    if (mutating) return mutating;
    if (agents.length > 0) return agents[0];
  }
  if (typeof input.name === "string" && input.name.trim() !== "") {
    return input.name.trim();
  }
  return fallback;
}

const STRIP_CONTRACT_BLOCK_RE =
  /<superagent-worker-contract>[\s\S]*?<\/superagent-worker-contract>/g;

function cleanGoalText(raw: string): string {
  return raw.replace(STRIP_CONTRACT_BLOCK_RE, "").trim();
}

export function resolveTaskGoal(
  input: Record<string, unknown> | null | undefined,
): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.goal === "string" && cleanGoalText(input.goal) !== "") {
    return cleanGoalText(input.goal);
  }
  if (typeof input.description === "string" && cleanGoalText(input.description) !== "") {
    return cleanGoalText(input.description);
  }
  if (Array.isArray(input.tasks)) {
    const parts: string[] = [];
    for (const item of input.tasks) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const raw =
          (typeof rec.task === "string" && rec.task) ||
          (typeof rec.assignment === "string" && rec.assignment) ||
          (typeof rec.description === "string" && rec.description) ||
          "";
        const cleaned = cleanGoalText(raw);
        if (cleaned !== "") parts.push(cleaned);
      }
    }
    if (parts.length > 0) return parts.join(" | ");
  }
  if (typeof input.prompt === "string" && cleanGoalText(input.prompt) !== "") {
    return cleanGoalText(input.prompt);
  }
  if (typeof input.context === "string" && cleanGoalText(input.context) !== "") {
    return cleanGoalText(input.context);
  }
  return "";
}

const WORKER_REPORT_TAG_RE =
  /\[SUPERAGENT-REPORT:\s*(ready|blocked|failed|question|dropped|progress)\s*\]/gi;
const INLINE_CODE_REPORT_RE = /`\[SUPERAGENT-REPORT:[^\]]*\]`/gi;

export function parseWorkerReportTag(rawOutput: string): WorkerReportKind | undefined {
  if (typeof rawOutput !== "string" || rawOutput === "") return undefined;
  const sanitized = rawOutput
    .replace(STRIP_CONTRACT_BLOCK_RE, "")
    .replace(INLINE_CODE_REPORT_RE, "");
  let chosen: WorkerReportKind | undefined;
  for (const match of sanitized.matchAll(WORKER_REPORT_TAG_RE)) {
    const kind = match[1]?.toLowerCase() as WorkerReportKind | undefined;
    if (!kind) continue;
    chosen = kind;
  }
  return chosen;
}

export function drainPendingInspections(state: SuperagentState): string | undefined {
  if (state.pendingInspections.length === 0) return undefined;
  const items = state.pendingInspections.splice(0, state.pendingInspections.length);
  const lines: string[] = ["<superagent-watchdog>"];
  for (const item of items) {
    const ticketId = item.alert?.ticketId ?? "main";
    const target = item.alert?.target ?? "task";
    lines.push(
      `- ticket=${ticketId} target=${target} reason=${item.reason} signal=${item.signal ?? ""}`,
    );
    if (item.recoveryHint) lines.push(`  recoveryHint: ${item.recoveryHint}`);
    if (item.escalate) {
      lines.push(
        `  escalate: ${item.escalate.from} -> ${item.escalate.to} (${item.escalate.reason} x${item.escalate.occurrences}); do not re-run the same tier with the same spec`,
      );
    }
  }
  lines.push("</superagent-watchdog>");
  return lines.join("\n");
}

export interface SuperagentHookContext {
  cwd?: string;
  agent?: { kind?: string };
  sessionManager?: { getSessionId?: () => string };
}

export interface SerializedSuperagentState {
  tickets: Array<[string, Ticket]>;
  assignments: Array<[string, Assignment]>;
  reports: WorkerReport[];
  alerts: WatchdogAlert[];
  editsSinceVerify: Array<[string, number]>;
  seq: number;
  degradedCounts: Record<string, number>;
  escalateAfter: number;
  pendingInspections: SubagentInspection[];
}

export interface SuperagentSnapshotFile {
  version: 1;
  updatedAt: number;
  sessions: Record<string, SerializedSuperagentState>;
}

const MAX_SNAPSHOT_SESSIONS = 16;

export function superagentSessionKey(
  cwd: string | undefined,
  ctx?: SuperagentHookContext,
): string {
  return sessionStateKey(cwd, ctx?.sessionManager?.getSessionId?.());
}

export function serializeSuperagentState(
  state: SuperagentState,
): SerializedSuperagentState {
  return {
    tickets: [...state.tickets.entries()],
    assignments: [...state.assignments.entries()],
    reports: [...state.reports],
    alerts: [...state.alerts],
    editsSinceVerify: [...state.editsSinceVerify.entries()],
    seq: state.seq,
    degradedCounts: { ...state.degradedCounts },
    escalateAfter: state.escalateAfter,
    pendingInspections: [...state.pendingInspections],
  };
}

export function hydrateSuperagentState(raw: unknown): SuperagentState {
  const base = createSuperagentState();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<SerializedSuperagentState>;
  if (Array.isArray(r.tickets)) {
    for (const entry of r.tickets) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) {
        base.tickets.set(entry[0], { ...entry[1] });
      }
    }
  }
  if (Array.isArray(r.assignments)) {
    for (const entry of r.assignments) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) {
        base.assignments.set(entry[0], { ...entry[1] });
      }
    }
  }
  if (Array.isArray(r.reports)) base.reports = [...r.reports];
  if (Array.isArray(r.alerts)) base.alerts = [...r.alerts];
  if (Array.isArray(r.editsSinceVerify)) {
    for (const entry of r.editsSinceVerify) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
        base.editsSinceVerify.set(entry[0], entry[1]);
      }
    }
  }
  if (typeof r.seq === "number") base.seq = r.seq;
  if (r.degradedCounts && typeof r.degradedCounts === "object") {
    base.degradedCounts = { ...r.degradedCounts };
  }
  if (typeof r.escalateAfter === "number") base.escalateAfter = r.escalateAfter;
  if (Array.isArray(r.pendingInspections)) {
    base.pendingInspections = [...r.pendingInspections];
  }
  return base;
}

function snapshotFilePath(cwd: string): string {
  return path.join(cwd, ".omp", "harness", "superagent-state.json");
}

export function saveSuperagentSnapshot(
  cwd: string,
  sessionKey: string,
  state: SuperagentState,
  now: number = DEFAULT_NOW(),
): void {
  try {
    const file = snapshotFilePath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    let existing: SuperagentSnapshotFile = { version: 1, updatedAt: now, sessions: {} };
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SuperagentSnapshotFile>;
      if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
        existing.sessions = { ...parsed.sessions };
      }
    }
    delete existing.sessions[sessionKey];
    existing.sessions[sessionKey] = serializeSuperagentState(state);
    const keys = Object.keys(existing.sessions);
    while (keys.length > MAX_SNAPSHOT_SESSIONS) {
      const oldest = keys.shift()!;
      delete existing.sessions[oldest];
    }
    existing.updatedAt = now;
    writeTextFileAtomic(file, JSON.stringify(existing, null, 2));
  } catch {
    // ignore filesystem errors in read-only or ephemeral environments
  }
}

export function loadSuperagentSnapshot(
  cwd: string,
  sessionKey: string,
): SuperagentState | undefined {
  try {
    const file = snapshotFilePath(cwd);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SuperagentSnapshotFile>;
    const raw = parsed?.sessions?.[sessionKey];
    if (!raw) return undefined;
    return hydrateSuperagentState(raw);
  } catch {
    return undefined;
  }
}


export function createSuperagent(pi: ExtensionAPI, deps: SuperagentDeps = {}): void {
  const states = new Map<string, SuperagentState>();
  const pendingToolCalls = new Map<string, { ticketId: string; agent: string }>();
  const pendingAnonCalls = new Map<string, Array<{ ticketId: string; agent: string }>>();
  const now = () => (deps.now ?? DEFAULT_NOW)();
  const maxEdits = deps.maxEditsWithoutVerify ?? 4;
  const maxSurgicalFiles = deps.maxSurgicalFiles ?? DEFAULT_MAX_SURGICAL_FILES;

  const isSubagent = (ctx: unknown): boolean =>
    (ctx as SuperagentHookContext | undefined)?.agent?.kind === "sub";

  const shouldPersist = (rawCwd: string | undefined): boolean => {
    if (deps.persistState === true) return true;
    if (deps.persistState === false) return false;
    return typeof rawCwd === "string" && rawCwd !== "." && path.isAbsolute(rawCwd);
  };

  const clearPendingCallsForSession = (key: string): void => {
    for (const k of [...pendingToolCalls.keys()]) {
      if (k.startsWith(`${key}::`)) pendingToolCalls.delete(k);
    }
    for (const k of [...pendingAnonCalls.keys()]) {
      if (k.startsWith(`${key}::`)) pendingAnonCalls.delete(k);
    }
  };

  const getState = (ctx: unknown): { key: string; cwd: string; rawCwd: string | undefined; state: SuperagentState } => {
    const c = ctx as SuperagentHookContext | undefined;
    const rawCwd = c?.cwd;
    const cwd = rawCwd ?? process.cwd();
    const key = superagentSessionKey(rawCwd, c);
    let state = states.get(key);
    if (!state) {
      state = createSuperagentState();
      states.set(key, state);
    }
    return { key, cwd, rawCwd, state };
  };

  pi.on("session_start", (event, ctx) => {
    if (isSubagent(ctx)) return;
    const c = ctx as SuperagentHookContext | undefined;
    const rawCwd = c?.cwd;
    const cwd = rawCwd ?? process.cwd();
    const key = superagentSessionKey(rawCwd, c);
    clearPendingCallsForSession(key);
    const reason = (event as { reason?: string } | undefined)?.reason;
    if (reason === "resume") {
      const restored = loadSuperagentSnapshot(cwd, key) ?? createSuperagentState();
      states.set(key, restored);
      return;
    }
    const fresh = createSuperagentState();
    states.set(key, fresh);
    if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, fresh, now());
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (isSubagent(ctx)) return undefined;
    const { key, cwd, rawCwd, state } = getState(ctx);
    noteHumanTurn(state);
    const advisory = drainPendingInspections(state);
    if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, state, now());
    if (advisory !== undefined) {
      return { message: { customType: "superagent-watchdog", content: advisory, display: false } };
    }
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    if (isSubagent(ctx)) return undefined;
    const { key, cwd, rawCwd, state } = getState(ctx);
    const toolName = String(event?.toolName ?? "");
    const input = (event as { input?: Record<string, unknown> | null | undefined })?.input ?? {};
    const target = String(input.path ?? input.filePath ?? "");

    if ((toolName === "edit" || toolName === "write" || toolName === "ast_edit") && target !== "" && !isInternalSchemePath(target)) {
      const alert = recordFileEdit(state, target, "main", maxEdits, now());
      if (alert && alert.kind === "edit-thrash") {
        logHarnessCode(rawCwd, `G1 rc=30 tl=${toolName} f=${path.basename(target)}`);
        logHarnessCode(rawCwd, `W2 k=30 f=${path.basename(target)} n=4`);
        return {
          block: true,
          reason: `blocked by superagent watchdog (edit-thrash): ${alert.target} edited ${maxEdits}+ times without a passing verification check. Run a test/verify command first.`,
        };
      }
      const scopeAlert = checkSurgicalScope(state, target, "main", maxSurgicalFiles, now());
      if (scopeAlert) {
        logHarnessCode(rawCwd, `G1 rc=31 tl=${toolName} f=${path.basename(target)}`);
        logHarnessCode(rawCwd, `W2 k=31 f=${path.basename(target)}`);
        return {
          block: true,
          reason: `blocked by superagent watchdog (${scopeAlert.kind}): ${scopeAlert.detail}. Run verification before touching more files.`,
        };
      }
      if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, state, now());
    }

    if (toolName === "task") {
      const requestedTicketId = typeof input.ticketId === "string" ? input.ticketId.trim() : "";
      const requestedGoal = resolveTaskGoal(input);
      const waitingTicket = [...state.tickets.values()].find(
        (t) =>
          t.waitsForPerson &&
          ((requestedTicketId !== "" && t.ticketId === requestedTicketId) ||
            (requestedGoal !== "" && t.goal === requestedGoal)),
      );
      if (waitingTicket) {
        logHarnessCode(rawCwd, `G1 rc=34 tl=${toolName}`);
        return {
          block: true,
          reason: `blocked by superagent watchdog (waits-for-person): ticket ${waitingTicket.ticketId} is waiting for human input (${waitingTicket.stage}). Wait for the next user turn before re-running.`,
        };
      }
      let paths = extractTargetPaths(input);
      const tasks = Array.isArray(input.tasks) ? input.tasks : undefined;
      if (tasks && tasks.length > 0) {
        for (const t of tasks) {
          if (t && typeof t === "object") {
            const tc = t as Record<string, unknown>;
            const assignment = typeof tc.assignment === "string" ? tc.assignment : "";
            const description = typeof tc.description === "string" ? tc.description : "";
            const taskPaths = extractTargetPaths(assignment || description);
            for (const p of taskPaths) {
              if (!paths.includes(p)) paths.push(p);
            }
          }
        }
      }
      if (paths.length > 0 && isMutatingTaskCall(input)) bindMainTicketPaths(state, paths, now());
      const agent = resolveTaskAgentName(input, "task");
      const allowedPaths = Array.isArray(input.allowedPaths) ? (input.allowedPaths as string[]) : [];
      let ticket =
        (requestedTicketId !== "" ? state.tickets.get(requestedTicketId) : undefined) ??
        (requestedGoal !== ""
          ? [...state.tickets.values()].find(
              (t) =>
                t.ticketId !== "main" &&
                t.goal === requestedGoal &&
                (t.stage === "planned" ||
                  t.stage === "running" ||
                  t.stage === "blocked" ||
                  t.stage === "failed"),
            )
          : undefined);
      if (ticket === undefined) {
        ticket = openTicket(
          state,
          requestedGoal,
          allowedPaths,
          requestedTicketId || undefined,
          now(),
        );
      } else if (allowedPaths.length > 0) {
        recordTargetFiles(state, ticket.ticketId, allowedPaths, now());
      }
      assignWorker(state, ticket.ticketId, agent, now());
      const callId =
        typeof (event as { toolCallId?: unknown })?.toolCallId === "string"
          ? String((event as { toolCallId?: string }).toolCallId)
          : "";
      if (callId !== "") {
        pendingToolCalls.set(`${key}::${callId}`, { ticketId: ticket.ticketId, agent });
      } else {
        const qKey = `${key}::task`;
        const q = pendingAnonCalls.get(qKey) ?? [];
        q.push({ ticketId: ticket.ticketId, agent });
        pendingAnonCalls.set(qKey, q);
      }
      if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, state, now());
      const updated = resolveSuperagentTaskInput(input, state);
      if (updated) return { input: updated };
    }

    if (toolName === "vibe_spawn" || toolName === "vibe_send") {
      const requestedTicketId = typeof input.ticketId === "string" ? input.ticketId.trim() : "";
      const requestedGoal = resolveTaskGoal(input);
      const waitingTicket = [...state.tickets.values()].find(
        (t) =>
          t.waitsForPerson &&
          ((requestedTicketId !== "" && t.ticketId === requestedTicketId) ||
            (requestedGoal !== "" && t.goal === requestedGoal) ||
            (requestedTicketId === "" && t.ticketId === "main")),
      );
      if (waitingTicket) {
        logHarnessCode(rawCwd, `G1 rc=34 tl=${toolName}`);
        return {
          block: true,
          reason: `blocked by superagent watchdog (waits-for-person): ticket ${waitingTicket.ticketId} is waiting for human input (${waitingTicket.stage}). Wait for the next user turn before re-running.`,
        };
      }
      const vibeAgent = resolveTaskAgentName(input, "vibe");
      const vibeTicketId = requestedTicketId || "main";
      const callId =
        typeof (event as { toolCallId?: unknown })?.toolCallId === "string"
          ? String((event as { toolCallId?: string }).toolCallId)
          : "";
      if (callId !== "") {
        pendingToolCalls.set(`${key}::${callId}`, { ticketId: vibeTicketId, agent: vibeAgent });
      } else {
        const qKey = `${key}::${toolName}`;
        const q = pendingAnonCalls.get(qKey) ?? [];
        q.push({ ticketId: vibeTicketId, agent: vibeAgent });
        pendingAnonCalls.set(qKey, q);
      }
      if (toolName === "vibe_spawn") {
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        if (prompt.trim() !== "") {
          const paths = extractTargetPaths(prompt);
          if (paths.length > 0 && isMutatingTaskCall(input)) bindMainTicketPaths(state, paths, now());
          if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, state, now());
          if (!prompt.includes(GOLDFISH_CONTRACT_TAG)) {
            return {
              input: { ...input, prompt: `${prompt.trim()}\n\n${GOLDFISH_CONTRACT_BLOCK}` },
            };
          }
        }
      }
    }

    // Intentionally never touches `bash`: unconditional blocking on the main
    // session breaks Tier-S flows and src/verify-gate.ts.
  });

  pi.on("tool_result", (event, ctx) => {
    if (isSubagent(ctx)) return undefined;
    const { key, cwd, rawCwd, state } = getState(ctx);
    const toolName = String(event?.toolName ?? "");
    const input = (event as { input?: Record<string, unknown> | null | undefined })?.input ?? {};

    if (toolName === "task" || toolName === "vibe_spawn" || toolName === "vibe_send") {
      const rawOutput = extractToolResultOutput(event);
      const callId =
        typeof (event as { toolCallId?: unknown })?.toolCallId === "string"
          ? String((event as { toolCallId?: string }).toolCallId)
          : "";
      let tracked: { ticketId: string; agent: string } | undefined;
      if (callId !== "") {
        tracked = pendingToolCalls.get(`${key}::${callId}`);
        pendingToolCalls.delete(`${key}::${callId}`);
      } else {
        const q = pendingAnonCalls.get(`${key}::${toolName}`);
        if (q && q.length > 0) tracked = q.shift();
      }
      if (!tracked) {
        const latestActive = [...state.assignments.values()]
          .reverse()
          .find((a) => a.status === "active");
        if (latestActive) {
          tracked = { ticketId: latestActive.ticketId, agent: latestActive.agent };
        }
      }
      const fallbackAgent = toolName === "task" ? "task" : "vibe";
      const details = (event as { details?: Record<string, unknown> | null | undefined })?.details ?? {};
      const pickStr = (v: unknown) => typeof v === "string" && v.trim() !== "" ? v.trim() : "";
      const vibeTicketId = toolName === "vibe_spawn"
        ? (pickStr(input.ticketId) || pickStr(input.name) || pickStr(input.id) || pickStr(input.agent) || pickStr(details.id) || pickStr(details.agentId) || `vibe-${state.seq + 1}`)
        : "";
      const ticketId =
        typeof input.ticketId === "string" && input.ticketId.trim() !== ""
          ? input.ticketId.trim()
          : (toolName === "vibe_spawn" ? vibeTicketId : (tracked?.ticketId ?? "main"));
      const agent = resolveTaskAgentName(input, tracked?.agent ?? fallbackAgent);
      const inspection = inspectSubagentResult(state, rawOutput, ticketId, agent, now());
      const reportKind = parseWorkerReportTag(rawOutput);
      const reportKindMap = { ready: 1, blocked: 2, failed: 3, dropped: 4, progress: 5, question: 6 } as Record<string, number>;
      const stCode = reportKindMap[reportKind ?? ""] ?? 0;
      logHarnessCode(rawCwd, `W1 a=${agent} st=${stCode} d=${inspection.degraded ? 1 : 0}`);
      if (inspection.degraded) {
        logHarnessCode(rawCwd, `W2 k=${inspection.escalate ? 36 : 33} f=${agent} n=${inspection.escalate?.occurrences ?? 0}`);
      }
      const isSpawnAck = toolName === "vibe_spawn" && reportKind === undefined && details?.status !== "completed";
      if (isSpawnAck) {
        if (!state.tickets.has(ticketId)) {
          openTicket(state, resolveTaskGoal(input) || ticketId, [], ticketId, now());
        }
        const assignment: Assignment = {
          assignmentId: `assign-${state.seq + 1}`,
          ticketId,
          agent,
          status: "spawned",
          startedAt: now(),
        };
        state.seq += 1;
        state.assignments.set(assignment.assignmentId, assignment);
      } else if (reportKind !== undefined && (!inspection.degraded || reportKind !== "ready")) {
        if (!state.tickets.has(ticketId)) {
          openTicket(state, resolveTaskGoal(input) || ticketId, [], ticketId, now());
        }
        recordWorkerReport(
          state,
          {
            kind: reportKind,
            ticketId,
            agent,
            summary: rawOutput.trim().slice(0, 240) || undefined,
            degraded: inspection.degraded,
          },
          now(),
        );
      }
      if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, state, now());
    }

    if (toolName === "bash" && event?.isError !== true) {
      const command = String(input.command ?? "");
      if (classifyVerifyCommand(command)) {
        recordVerifyPass(state);
        if (shouldPersist(rawCwd)) saveSuperagentSnapshot(cwd, key, state, now());
      }
    }
  });

  pi.registerCommand("superagent", {
    handler: (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const { state } = getState(ctx);
      const status = formatSuperagentStatus(state);
      ctx.ui.notify?.(status);
      return Promise.resolve();
    },
  });
}

export default function superagent(pi: ExtensionAPI, deps: SuperagentDeps = {}): void {
  createSuperagent(pi, deps);
}
