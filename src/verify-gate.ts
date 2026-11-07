/**
 * verify-gate.ts — deterministic, advisory "did you re-run a check?" gate.
 *
 * WHY: a turn that edits files and never re-runs a check is the most common
 *   false "done". This gate counts file mutations and verification runs, and
 *   when a mutation is unverified it asks the session to continue with one
 *   advisory continuation. It is deterministic, main-session only, and never
 *   blocks, so it cannot loop or break a session.
 */
import { logHarnessCode } from "./state.ts";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface GateDeps {
  /** Injectable for tests; defaults to classifyVerifyCommand. */
  isVerifyCommand?: (command: string) => boolean;
  /** Max advisory continuations per session. Default 3. */
  maxContinuations?: number;
  /** When set (or OMP_HARNESS_LESSON_GATE=1), session_stop also gates on delivering a design lesson. */
  requireLessonOnStop?: boolean;
}

const VERIFY_RE =
  /\b(?:node\s+--test(?:-only)?|npm\s+(?:test|run\s+(?:test|verify|build|lint|typecheck))|pnpm\s+(?:run\s+)?(?:test|verify|build|lint|typecheck|check)|yarn\s+(?:run\s+)?(?:test|verify|build|lint|typecheck|check)|bun\s+(?:run\s+)?(?:test|verify|build|lint|typecheck|check)|npx\s+(?:tsc|vitest|jest|mocha|playwright|eslint|biome)|uv\s+run\s+(?:pytest|ruff|mypy)|poetry\s+run\s+(?:pytest|ruff|mypy)|python3?\s+-m\s+(?:pytest|unittest|mypy|ruff)|dotnet\s+(?:test|build)|vitest|jest|mocha|pytest|go\s+(?:test|vet|build)|cargo\s+(?:test|check|clippy)|tsc|eslint|ruff|mypy|mvn\s+test|gradle\s+test|playwright\s+test|make\s+(?:test|check)|verify\.mjs|run-probes\.mjs|swift\s+test|mix\s+test)\b/i;

export function classifyVerifyCommand(command: string): boolean {
  return VERIFY_RE.test(command ?? "");
}

export interface GateState {
  mutations: number;
  verifications: number;
  /** Continuations already requested. */
  prompts: number;
  /** Whether the last check run passed (null if none yet). */
  lastCheckPassed: boolean | null;
  /** Whether the last check run errored (null if none yet). */
  lastCheckError: boolean | null;
  mutatedFiles: string[];
  lessonDelivered: boolean;
  lessonPrompted: boolean;
}

export function createGateState(): GateState {
  return { mutations: 0, verifications: 0, prompts: 0, lastCheckPassed: null, lastCheckError: null, mutatedFiles: [], lessonDelivered: false, lessonPrompted: false };
}

export function recordMutation(state: GateState): void {
  state.mutations += 1;
}

export function recordVerification(state: GateState, isError = false): void {
  // Only a passing verification clears outstanding mutations. A failed check
  // still records that a check ran (lastCheckPassed/lastCheckError) but does
  // not mark the mutations as verified, so the gate keeps nagging.
  if (!isError) {
    state.verifications = state.mutations;
  }
  state.lastCheckPassed = !isError;
  state.lastCheckError = Boolean(isError);
}

/** Agent kinds whose `task` calls are read-only review/research and never mark a gate dirty. */
export const READ_ONLY_AGENTS = new Set([
  "scout",
  "reviewer",
  "security-reviewer",
  "architect",
  "plan-drafter",
  "plan-reviewer",
  "researcher",
  "seance",
  "harness-grader",
  "harness-proposer",
  "qa-verifier",
]);

function isReadOnlyAgent(agent?: string): boolean {
  if (!agent) return false;
  return READ_ONLY_AGENTS.has(agent) || agent.startsWith("egm-");
}

/**
 * True when a `task` tool call should mark the gate dirty: at least one task
 * is assigned to a mutating (non-read-only) agent. A payload with no `tasks`
 * array (direct `task` tool result or single task) defaults to mutating
 * unless its own `agent` is read-only.
 */
export function isMutatingTaskCall(input: unknown): boolean {
  const payload = input as { tasks?: Array<{ agent?: string; name?: string }>; agent?: string; name?: string } | undefined;
  // A vibe_spawn/vibe_send with a read-only agent name (Goldfish reviewer,
  // auditor, etc.) never marks the gate dirty; coding sessions do.
  if (typeof payload?.name === "string" && (isReadOnlyAgent(payload.name) || payload.name.includes("goldfish") || payload.name.includes("reviewer") || payload.name.includes("auditor"))) return false;
  const tasks = payload?.tasks;
  if (Array.isArray(tasks)) {
    if (tasks.length === 0) return false;
    return tasks.some((task) => !isReadOnlyAgent(task?.agent));
  }
  return !isReadOnlyAgent(payload?.agent);
}

/** True when a mutation happened and no verification has run since it. */
export function needsVerification(state: GateState): boolean {
  return state.mutations > state.verifications;
}

export function hasDesignLesson(text: string): boolean {
  const t = text ?? "";
  const hasWhy = /(?:why this design|vì sao thiết kế|tai sao thiet ke|decision record|vì sao thay đổi)/i.test(t);
  const hasCounter = /(?:avoid misconception|tránh lầm tưởng|tranh lam tuong|when not to use|case tương tự|case tuong tu|counter-?example)/i.test(t);
  return hasWhy && hasCounter;
}

export function buildPostSessionLessonPrompt(files: string[]): string {
  const fileList = files.length > 0 ? files.join(", ") : "no tracked mutated files";
  return [
    `harness lesson-gate: Before ending this coding session (${fileList}), teach the user concisely:`,
    "1. **Vì sao thiết kế này đúng (Why This Design Is Right)**: 3–5 lines covering Goal, Root Cause, Chosen Design vs Rejected Alternative, Tradeoff, and Verification Evidence with file:line citations.",
    "2. **Tránh lầm tưởng ở các case tương tự (When NOT To Use This Design)**: 2–3 look-alike cases where copying this pattern would be WRONG, explaining why it fails there and what pattern to use instead.",
    "Keep it concise, local/sanitized (no hidden CoT or secrets), and non-blocking (never a quiz gate).",
  ].join("\n");
}

export default function verifyGate(pi: ExtensionAPI, deps: GateDeps = {}): void {
  const states = new Map<string, GateState>();
  const mutatingTaskCallIds = new Set<string>();

  // Keyed per session, not per cwd: two sessions opened in the same directory
  // must not share one continuation budget, and a resumed session must not
  // inherit a spent budget from the run that wrote the transcript.
  type Ctx = { sessionManager?: { getSessionId?: () => string } } | undefined;

  function keyFor(cwd: string | undefined, ctx?: Ctx): string {
    const base = cwd ?? process.cwd();
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    return sessionId ? `${base}::${sessionId}` : base;
  }

  function getState(cwd: string | undefined, ctx?: Ctx): GateState {
    const key = keyFor(cwd, ctx);
    let state = states.get(key);
    if (!state) {
      state = createGateState();
      states.set(key, state);
    }
    return state;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    states.set(keyFor(ctx?.cwd, ctx), createGateState());
  });

  pi.on("tool_call", (event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    const call = event as { toolName?: string; input?: unknown; toolCallId?: string };
    if ((call.toolName === "task" || call.toolName === "vibe_spawn" || call.toolName === "vibe_send") && isMutatingTaskCall(call.input)) {
      const callId = call.toolCallId ?? "__pending_mutating_task__";
      mutatingTaskCallIds.add(callId);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    const state = getState(ctx?.cwd, ctx);
    const toolName = event?.toolName;
    // A check that ran and failed is still a check the model ran. Counting it
    // only when it passes would nag about work the model already verified, so
    // the verify branch runs before the error guard.
    if (toolName === "bash") {
      const command = String(event?.input?.command ?? "");
      const isVerify = (deps.isVerifyCommand ?? classifyVerifyCommand)(command);
      if (isVerify) recordVerification(state, Boolean(event?.isError));
    }
    if (event?.isError === true) return;
    if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") {
      recordMutation(state);
      const input = (event as { input?: unknown })?.input as Record<string, unknown> | undefined;
      const paths: string[] = [];
      if (typeof input?.path === "string" && input.path) paths.push(input.path);
      if (typeof input?.input === "string") {
        for (const m of input.input.matchAll(/\[([^\]#]+)#...\]|([^\s\[]+\.(?:ts|tsx|js|jsx|py|md|json|yml|yaml|toml|lock|txt))(?::[^\s]*)?/g)) {
          const p = (m[1] ?? m[2] ?? "").trim();
          if (p) paths.push(p);
        }
      }
      for (const p of paths) {
        if (!state.mutatedFiles.includes(p) && state.mutatedFiles.length < 12) state.mutatedFiles.push(p);
      }
      if (paths.length > 0) state.lessonDelivered = false;
    }
    if (toolName === "harness_record") {
      const input = (event as { input?: unknown })?.input as Record<string, unknown> | undefined;
      if (input?.lesson) state.lessonDelivered = true;
    }
    if (toolName === "task" || toolName === "vibe_spawn" || toolName === "vibe_send") {
      const result = event as { input?: unknown; toolCallId?: string };
      const isMutating =
        result.input !== undefined
          ? isMutatingTaskCall(result.input)
          : mutatingTaskCallIds.delete(result.toolCallId ?? "") ||
            mutatingTaskCallIds.delete("__pending_mutating_task__");
      if (isMutating) recordMutation(state);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    const state = getState(ctx?.cwd, ctx);
    const ev = event as { messages?: Array<unknown> };
    const msgs = ev?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string; content?: unknown } | undefined;
      if (!m || m.role !== "assistant") continue;
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) text = m.content.map((b) => typeof b === "object" && b !== null && "text" in b ? String((b as { text?: unknown }).text ?? "") : "").join("\n");
      if (hasDesignLesson(text)) state.lessonDelivered = true;
      break;
    }
  });

  pi.on("session_stop", async (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return undefined;
    const activeTools = (pi as { getActiveTools?: () => unknown }).getActiveTools?.();
    if (Array.isArray(activeTools) && activeTools.length > 0 && !activeTools.includes("bash")) {
      return undefined;
    }
    const state = getState(ctx?.cwd, ctx);
    if (needsVerification(state)) {
      const max = deps.maxContinuations ?? 3;
      if (state.prompts >= max) {
        logHarnessCode(String(ctx?.cwd ?? "."), `G1 rc=41 tl=stop n=${state.mutations}`);
        return undefined;
      }
      state.prompts += 1;
      const hadError = state.lastCheckError === true;
      recordVerification(state);
      logHarnessCode(String(ctx?.cwd ?? "."), `G1 rc=40 tl=stop n=${state.mutations}`);
      const reasonPrefix = hadError
        ? `harness verify-gate: the last verification command FAILED and ${state.mutations} file mutation(s) remain unverified.`
        : `harness verify-gate: ${state.mutations} file mutation(s) since the last check run.`;
      return {
        continue: true,
        additionalContext:
          `${reasonPrefix} Run the project's real verification (test/build/lint command or a scripted smoke run) and report what it printed, or state explicitly that no check applies. Once verified, also explain to the user (1) why your design/change is right and (2) which look-alike cases must NOT use this design.`,
      };
    }
    const lessonOptIn = deps.requireLessonOnStop === true || process.env.OMP_HARNESS_LESSON_GATE === "1";
    if (lessonOptIn && state.mutations > 0 && !state.lessonDelivered && !state.lessonPrompted) {
      state.lessonPrompted = true;
      logHarnessCode(String(ctx?.cwd ?? "."), `G1 rc=42 tl=stop n=${state.mutations}`);
      return { continue: true, additionalContext: buildPostSessionLessonPrompt(state.mutatedFiles) };
    }
    return undefined;
  });

  pi.registerCommand("harness-lesson", {
    description: "Show the latest recorded design lesson or a summary of mutated files: /harness-lesson [latest|on|off].",
    handler: async (args, ctx) => {
      const cwd = path.resolve(ctx.cwd ?? process.cwd());
      const raw = String(args ?? "").trim().toLowerCase();
      if (raw === "on") { process.env.OMP_HARNESS_LESSON_GATE = "1"; ctx.ui.notify("harness-lesson: lesson gate on", "info"); return; }
      if (raw === "off") { process.env.OMP_HARNESS_LESSON_GATE = "0"; ctx.ui.notify("harness-lesson: lesson gate off", "info"); return; }
      const lessonsFile = path.join(cwd, ".omp", "harness", "lessons.jsonl");
      if (existsSync(lessonsFile)) {
        const lines = readFileSync(lessonsFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
        if (lines.length > 0) { ctx.ui.notify(lines[lines.length - 1], "info"); return; }
      }
      const state = getState(cwd, ctx);
      const summary = state.mutatedFiles.length > 0 ? `harness-lesson: mutated files: ${state.mutatedFiles.join(", ")}\n${buildPostSessionLessonPrompt(state.mutatedFiles)}` : "harness-lesson: no lesson recorded and no mutated files tracked";
      ctx.ui.notify(summary, "info");
    },
  });
}
