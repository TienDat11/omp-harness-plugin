/**
 * policy.ts — omp extension entrypoint: tool-call policy, failure dedup, telemetry.
 *
 * WHY this module exists: deterministic local guardrails that never touch the
 * provider prompt cache. Only narrow local decision events are subscribed;
 * anything that would mutate prompt or conversation history stays unsubscribed.
 *
 * Handlers are synchronous except one bounded local appendFileSync per telemetry
 * event. Telemetry failures are swallowed: a write error must never block a call.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  isDestructiveAllowed,
  isSecretAllowed,
  logHarnessCode,
  normalizeCommandKey,
  normalizePathKey,
  rememberReadStat,
  resolveHomeDir,
} from "./state.ts";
import { evaluateRead, expandHome, extractWriteTargets, resolveTaskInput, splitPathAndSelector } from "./read-budget.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Rule 1 — secret file access (read / write / edit / bash)
// ---------------------------------------------------------------------------

const SECRET_BASENAMES: Record<string, true> = {
  ".env": true,
  ".netrc": true,
  ".git-credentials": true,
  "id_rsa": true,
  "id_dsa": true,
  "id_ecdsa": true,
  "id_ed25519": true,
};

const SECRET_BASENAME_EXTENSIONS: Record<string, true> = {
  pem: true,
  key: true,
  p12: true,
  pfx: true,
};

const NON_SECRET_ENV_NAMES: Record<string, true> = {
  example: true,
  sample: true,
  template: true,
};

function isSecretBasename(basename: string): boolean {
  const base = basename.toLowerCase();
  if (base === ".env") return true;
  if (base.startsWith(".env.")) {
    const name = base.slice(5);
    // .env.example / .env.sample / .env.template are documentation, not secrets.
    return name.length > 0 && !Object.hasOwn(NON_SECRET_ENV_NAMES, name);
  }
  if (Object.hasOwn(SECRET_BASENAMES, base)) return true;
  // id_*.pub is the public half; only the private halves are secrets.
  if (base.startsWith("id_") && base.endsWith(".pub")) return false;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (Object.hasOwn(SECRET_BASENAME_EXTENSIONS, ext)) return true;
  }
  return false;
}

// A trailing read selector (`:50`, `:1-5`, `:1..5`, `:L1-L5`, `:-60`, `:19,59`, `:50+150`, `:raw`, `:img`, `:conflicts`) addresses lines, not the file name.
const READ_SELECTOR_RE = /:(?:[l\d+,.:-]*|raw|img|conflicts)(?::(?:[l\d+,.:-]+|raw))?$/i;

function resolveTargetPath(rawPath: string, cwd: string): string {
  const stripped = splitPathAndSelector(rawPath, cwd).path.replace(READ_SELECTOR_RE, "");
  return path.resolve(cwd, expandHome(stripped));
}

/** True when the path's basename is a conventional secret file. */
export function isSecretTarget(rawPath: string, cwd: string): boolean {
  return isSecretBasename(path.basename(resolveTargetPath(rawPath, cwd)));
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const API_KEY_RE = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/;
const SECRET_FIELD_RE = /\b(?:api[_-]?key|secret|password|passwd|token|credential)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/;
const AWS_ACCESS_KEY_RE = /AKIA[0-9A-Z]{16}/;
const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{20,}/;
const SLACK_TOKEN_RE = /xox[baprs]-[A-Za-z0-9-]{10,}/;

/**
 * Narrow credential-shape detector. WHY narrow: every pattern requires a
 * high-entropy prefix/separators or a field separator, so prose and the bare
 * word "token" never match.
 */
export function looksLikeSecret(value: string): boolean {
  const text = value;
  if (
    PRIVATE_KEY_RE.test(text) ||
    API_KEY_RE.test(text) ||
    BEARER_RE.test(text) ||
    SECRET_FIELD_RE.test(text) ||
    AWS_ACCESS_KEY_RE.test(text) ||
    GITHUB_TOKEN_RE.test(text) ||
    SLACK_TOKEN_RE.test(text)
  ) {
    return true;
  }
  const tokens = text.split(/[\s"'`]+/);
  for (const token of tokens) {
    const base = token.split(/[\\/]/).pop() ?? token;
    if (isSecretBasename(base)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule 3 — repeated identical failing calls
// ---------------------------------------------------------------------------

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Pre-execution identity of a call: tool + canonical input. Error text is NOT
 * part of this key; it is only classified for telemetry.
 */
export function failureKey(toolName: string, input: unknown): string {
  return `${toolName}|${stableJsonStringify(input)}`;
}

const failureCounts = new Map<string, number>();

export function recordFailure(key: string, isError: boolean): void {
  failureCounts.set(key, isError ? (failureCounts.get(key) ?? 0) + 1 : 0);
}

export function nextFailureDecision(key: string): { block: boolean; reason?: string } {
  const count = failureCounts.get(key) ?? 0;
  if (count >= 2) {
    return { block: true, reason: "change approach; the same call already failed twice" };
  }
  return { block: false };
}

export function resetFailureCounters(scopePrefix?: string): void {
  if (!scopePrefix) {
    failureCounts.clear();
    return;
  }
  for (const key of failureCounts.keys()) {
    if (key.startsWith(scopePrefix)) failureCounts.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Rule 2 — destructive bash
// ---------------------------------------------------------------------------

/**
 * Path args for `git reset` start after `--`; HEAD is a rev, not a path. For
 * `git clean` every non-flag token after the subcommand is a path (clean takes
 * only paths). The subcommand is located by name so `git -C <path> reset --hard`
 * still resolves to reset.
 */
function gitSubcommandHasPathArg(command: string): boolean {
  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  if (tokens[0] !== "git") return false;
  const subIndex = tokens.findIndex((token) => token === "reset" || token === "clean");
  if (subIndex === -1) return false;
  const sub = tokens[subIndex];
  if (sub === "reset") {
    const dashIndex = tokens.indexOf("--");
    const pathTokens = dashIndex === -1 ? [] : tokens.slice(dashIndex + 1);
    const realArgs = pathTokens.filter((token) => token !== "--" && !token.startsWith("-"));
    return realArgs.length > 0;
  }
  const pathTokens = tokens
    .slice(subIndex + 1)
    .filter((token) => !token.startsWith("-") && token !== "--");
  return pathTokens.length > 0;
}

/**
 * Splits tokens, skips `git` global options (`-C <path>`, `-c <key=val>`,
 * `--git-dir=...`, `--work-tree=...`, `--no-pager`, `--bare`), and returns
 * `true` when the git subcommand token is `"push"`.
 */
function isGitPushCommand(command: string): boolean {
  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  if (tokens[0] !== "git") return false;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "-C" || token === "-c") {
      i += 2;
      continue;
    }
    if (token === "--no-pager" || token === "--bare") {
      i += 1;
      continue;
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    return token === "push";
  }
  return false;
}

export function evaluateBash(command: string, cwd: string): { block: boolean; reason?: string } {
  const segments = command
    .split(/[;|&\n\r]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
  for (const segment of segments) {
    const segTokens = segment.split(/\s+/).filter((t) => t.length > 0);
    const cmd = (segTokens[0] ?? "").toLowerCase();
    const READERS: Record<string, true> = { cat: true, head: true, tail: true, less: true, more: true, type: true, "get-content": true, gc: true, sed: true, awk: true, grep: true, rg: true, base64: true, xxd: true, strings: true, cp: true, mv: true, curl: true, wget: true };
    if (READERS[cmd]) {
      for (const rawArg of segTokens.slice(1)) {
        const arg = rawArg.replace(/^['"`]+|['"`\])]+$/g, "");
        if (!arg || arg.startsWith("-")) continue;
        const base = arg.split(/[\\/]/).pop() ?? arg;
        if (/^\.env\.(example|sample|template)$/i.test(base)) continue;
        try { if (isSecretTarget(arg, cwd)) return { block: true, reason: `blocked: bash command reads protected path (${base}); inspect non-secret config or ask the user.` }; } catch {}
        if (/\.pem$/i.test(arg) || /\.key$/i.test(arg) || /\/\.aws\/credentials$/i.test(arg) || /\/\.gnupg\//i.test(arg) || /models\.yml$/i.test(arg)) return { block: true, reason: `blocked: bash command reads protected path (${arg}); inspect non-secret config or ask the user.` };
      }
    }
    const ENV_DUMP_RE = /^\s*(env|printenv|set|export\s+-p|get-childitem\s+env:|gci\s+env:|dir\s+env:)\s*$/i;
    const API_KEY_ECHO_RE = /\$(?:TYPESAFE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|NS24_API_KEY)\b/;
    const isEnvAssignment = segTokens.some((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!isEnvAssignment && ENV_DUMP_RE.test(segment)) {
      return { block: true, reason: "blocked: bash command dumps environment variables that may contain credentials; check specific non-secret variables instead." };
    }
    if (!isEnvAssignment && API_KEY_ECHO_RE.test(segment) && /^(echo|printf)\b/i.test(segment)) {
      return { block: true, reason: "blocked: bash command dumps environment variables that may contain credentials; check specific non-secret variables instead." };
    }
    // 2a — force push; only a block is terminal, keep scanning other segments.
    const isGitPush = isGitPushCommand(segment);
    const pushForce = isGitPush && /(?:^|\s)(?:--force|-f)(?:\s|=|$)/.test(segment);
    const pushSafe = isGitPush && /(?:^|\s)--force-with-lease\b/.test(segment);
    if (pushForce && !pushSafe && !isDestructiveAllowed(normalizeCommandKey(segment))) {
      return {
        block: true,
        reason:
          "blocked: git push --force; use --force-with-lease, or ask the user to run /harness-allow-destructive <exact command> for this session",
      };
    }
    const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
    const subIndex = tokens.findIndex((token) => token === "reset" || token === "clean");
    const sub = subIndex === -1 ? undefined : tokens[subIndex];
    const resetHard = sub === "reset" && /(?:^|\s)--hard(?:\s|$)/.test(segment);
    const cleanForced = sub === "clean" && tokens.some((token) => token.startsWith("-") && token.toLowerCase().includes("f"));
    if ((resetHard || cleanForced) && !gitSubcommandHasPathArg(segment)) {
      if (!isDestructiveAllowed(normalizeCommandKey(segment))) {
        const subName = sub === "reset" ? "reset" : "clean";
        return {
          block: true,
          reason: `blocked: git ${subName} without a path targets the whole workspace; ask the user to run /harness-allow-destructive <exact command> for this session`,
        };
      }
    }
    // 2c — recursive delete.
    const head = tokens[0];
    const headLower = head.toLowerCase();
    const dashFlags = tokens.slice(1).filter((token) => token.startsWith("-"));
    const flagNames = dashFlags.map((token) => token.replace(/^-+/, "").toLowerCase());
    const slashFlags = tokens
      .slice(1)
      .filter((token) => token.startsWith("/"))
      .map((token) => token.replace(/^\/+/, "").toLowerCase());
    const isRmRf =
      headLower === "rm" &&
      (flagNames.includes("recursive") || flagNames.some((name) => name.includes("r"))) &&
      (flagNames.includes("force") || flagNames.some((name) => name.includes("f")));
    const isDelWithSub =
      (headLower === "del" || headLower === "rd" || headLower === "rmdir") && slashFlags.includes("s");
    const isRemoveItem =
      headLower === "remove-item" && flagNames.includes("recurse") && flagNames.includes("force");
    if (!isRmRf && !isDelWithSub && !isRemoveItem) continue;
    const targetTokens = isDelWithSub
      ? tokens.slice(1).filter((token) => !token.startsWith("/") && !token.startsWith("-"))
      : tokens.slice(1).filter((token) => !token.startsWith("-"));
    for (const rawTarget of targetTokens) {
      const target = rawTarget.replace(/^['"]+|['"]+$/g, "");
      if (target.length === 0) continue;
      const homeDir = resolveHomeDir();
      const expandedTarget = target === "~" ? homeDir : target.startsWith("~/") ? (homeDir ? `${homeDir}/${target.slice(2)}` : target) : target;
      const msys = /^[a-zA-Z]:[\\/]/.test(cwd) ? /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(expandedTarget) : null;
      const normalizedTarget = msys ? `${msys[1]}:${msys[2] || "/"}` : expandedTarget;
      const resolved = path.resolve(cwd, normalizedTarget);
      const resolvedKey = normalizePathKey(resolved);
      const cwdKey = normalizePathKey(cwd);
      const homeKey = homeDir ? normalizePathKey(homeDir) : "";
      const isFsRoot = resolvedKey === "/" || resolvedKey.endsWith("/");
      const isHome = resolvedKey.length > 0 && resolvedKey === homeKey;
      const isCwd = resolvedKey === cwdKey;
      const pathSegments = resolvedKey.split("/");
      const isGitPath = pathSegments.includes(".git") || resolvedKey.includes("/.git/");
      const isWildcard =
        target === "*" || target.endsWith("/*") || target.endsWith("\\*") || pathSegments.includes("*");
      const isOutsideCwd = resolvedKey !== cwdKey && !resolvedKey.startsWith(`${cwdKey}/`);
      if (isFsRoot) {
        return { block: true, reason: `blocked: ${headLower} ${target} targets a filesystem root` };
      }
      if (isHome) {
        return { block: true, reason: `blocked: ${headLower} ${target} targets the user home directory` };
      }
      if (isCwd) {
        return { block: true, reason: `blocked: ${headLower} ${target} targets the workspace root` };
      }
      if (isGitPath) {
        return { block: true, reason: `blocked: ${headLower} ${target} targets a git metadata path` };
      }
      if (isWildcard) {
        return { block: true, reason: `blocked: ${headLower} ${target} has a literal wildcard target` };
      }
      if (isOutsideCwd) {
        return { block: true, reason: `blocked: ${headLower} ${target} targets a path outside the workspace` };
      }
    }
  }
  return { block: false };
}

// ---------------------------------------------------------------------------
// Rule 4 — telemetry
// ---------------------------------------------------------------------------

function writeTelemetry(cwd: string, sessionId: string, event: string, fields: Record<string, unknown>): void {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event,
    session_id: sessionId,
    pid: process.pid,
    ...fields,
  };
  try {
    mkdirSync(path.join(cwd, ".omp", "harness"), { recursive: true });
    appendFileSync(path.join(cwd, ".omp", "harness", "telemetry.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // Telemetry is best-effort; never block a tool or throw into the session.
  }
}

function extractErrorText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function errorClass(isError: boolean, errorText: string): string {
  if (!isError) return "none";
  const text = errorText.slice(0, 200).toLowerCase();
  if (text.includes("enoent")) return "ENOENT";
  if (text.includes("abort")) return "aborted";
  return "error";
}

/** Numeric telemetry code for a read/tool error message. */
export function errorCodeNum(errorText: string): number {
  const text = errorText.slice(0, 300).toLowerCase();
  if (text.includes("enoent")) return 1;
  if (
    text.includes("never displayed") ||
    text.includes("boundary row") ||
    text.includes("restates") ||
    text.includes("anchor")
  )
    return 2;
  if (text.includes("abort")) return 3;
  if (text.includes("blocked")) return 4;
  return 9;
}

// ---------------------------------------------------------------------------
// Rule 5 — todo task-name matching
// omp's `todo` tool finds a task only by exact `content` (todo.ts
// findTaskByContent) and rejects `append` with a singular `task` and no
// `items`. Models often retype task text without Vietnamese diacritics. These
// helpers rewrite such calls to the stored text before the tool runs.
// ---------------------------------------------------------------------------

const TODO_TASK_OPS: Record<string, true> = { start: true, done: true, block: true, unblock: true, rm: true, drop: true };

/** Folds todo text so texts differing only by diacritics, `đ`, case, punctuation or spacing collide. */
function foldTodoText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Persisted todo phase as omp writes it (`TodoPhase`); omp validates the shape before storing. */
interface TodoPhaseLike {
  name: string;
  tasks: { content: string }[];
}

/** Session entry fields the todo lookup reads. */
interface TodoBranchEntry {
  type: string;
  customType?: string;
  data?: { phases?: unknown };
  message?: { role: string; toolName?: string; isError?: boolean; details?: { op?: string; phases?: unknown } };
}

/** Phases of the latest committed `todo` state on a session branch (mirrors omp getLatestTodoPhasesFromEntries). */
function latestTodoPhases(branch: readonly unknown[]): readonly TodoPhaseLike[] {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as TodoBranchEntry;
    if (entry.type === "custom" && entry.customType === "user_todo_edit") {
      const phases = entry.data?.phases;
      if (Array.isArray(phases)) return phases as TodoPhaseLike[];
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || message === undefined) continue;
    if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
    if (message.details?.op === "view") continue;
    const phases = message.details?.phases;
    if (Array.isArray(phases)) return phases as TodoPhaseLike[];
  }
  return [];
}

/**
 * Rewrites a `todo` call so its task text names the stored task, or returns
 * undefined to leave the call unchanged. A task matches only when exactly one
 * stored task folds to the same text and the text is not already an exact
 * match. `append` with a singular `task` and no `items` becomes `items: [task]`.
 * `append` with no `phase` joins the only existing phase; with several or none it is unchanged.
 */
export function resolveTodoInput(
  input: Record<string, unknown>,
  phases: readonly TodoPhaseLike[],
): Record<string, unknown> | undefined {
  if (input.op === "init") {
    const next = { ...input };
    if (Array.isArray(input.list)) {
      const normalized: Array<{ phase: string; items: string[] }> = [];
      for (const [idx, entry] of input.list.entries()) {
        let phase = "";
        let items: string[] = [];
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          const p = e.phase;
          phase = typeof p === "string" ? p.trim() : "";
          if (!phase) phase = idx === 0 ? "Tasks" : `Phase ${idx + 1}`;
          const rawItems = e.items ?? e.tasks;
          if (Array.isArray(rawItems)) {
            for (const it of rawItems) {
              if (typeof it === "string" && it.trim() !== "") {
                items.push(it.trim());
              } else if (it && typeof it === "object") {
                const o = it as Record<string, unknown>;
                const content = o.content ?? o.task;
                if (typeof content === "string" && content.trim() !== "") items.push(content.trim());
              }
            }
          }
        }
        normalized.push({ phase, items });
      }
      // Drop empty-item phases only when at least one non-empty phase remains.
      const nonEmpty = normalized.filter((p) => p.items.length > 0);
      if (nonEmpty.length === 0) nonEmpty.push(...normalized.filter((p) => p.items.length === 0));
      next.list = nonEmpty;
      delete next.items;
      delete next.task;
      return { ...next, op: "init" };
    }
    // No list: wrap a top-level non-empty items array into a single default phase.
    if (!Array.isArray(input.list) && Array.isArray(input.items) && input.items.length > 0) {
      const items = input.items
        .filter((it): it is string => typeof it === "string" && it.trim() !== "")
        .map((it) => it.trim());
      if (items.length > 0) {
        next.list = [{ phase: "Tasks", items }];
        delete next.items;
        delete next.task;
        return { ...next, op: "init" };
      }
    }
    // task-only init with neither list nor items.
    if (
      !Array.isArray(input.list) &&
      !Array.isArray(input.items) &&
      typeof input.task === "string" &&
      input.task.trim() !== ""
    ) {
      delete next.task;
      return { ...next, op: "init", items: [input.task.trim()] };
    }
    return undefined;
  }
  if (input.op === "append") {
    const next: Record<string, unknown> = { ...input };
    const hasItems = Array.isArray(input.items) && input.items.length > 0;
    if (!hasItems && typeof input.task === "string" && input.task !== "") {
      delete next.task;
      next.items = [input.task];
    }
    const hasPhase = typeof input.phase === "string" && input.phase !== "";
    if (!hasPhase && phases.length === 1) next.phase = phases[0].name;
    return next.items === input.items && next.phase === input.phase ? undefined : next;
  }
  if (typeof input.op !== "string" || !Object.hasOwn(TODO_TASK_OPS, input.op)) return undefined;
  const fromItems =
    typeof input.task !== "string" &&
    Array.isArray(input.items) &&
    input.items.length === 1 &&
    typeof input.items[0] === "string";
  let taskText: string | undefined;
  if (typeof input.task === "string") {
    taskText = input.task;
  } else if (Array.isArray(input.items) && input.items.length === 1 && typeof input.items[0] === "string") {
    taskText = input.items[0];
  }
  if (taskText === undefined) return undefined;
  const next: Record<string, unknown> = { ...input };
  delete next.items;
  const stored = phases.flatMap((phase) => phase.tasks.map((t) => t.content));
  if (!fromItems && stored.includes(taskText)) return undefined;
  const folded = foldTodoText(taskText);
  if (folded === "") return undefined;
  const matches = stored.filter((text) => foldTodoText(text) === folded);
  if (matches.length !== 1) return undefined;
  return { ...next, task: matches[0] };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function policy(pi: ExtensionAPI): void {
  const effectiveInputs = new Map<string, unknown>();
  pi.on("tool_call", async (event, ctx) => {
    const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    const todoInput = event.toolName === "todo" ? resolveTodoInput(event.input, latestTodoPhases(branch)) : undefined;
    const taskInput = event.toolName === "task" || event.toolName === "vibe_spawn" ? resolveTaskInput(event.input, branch, ctx.cwd) : undefined;
    let readInput: Record<string, unknown> | undefined;
    if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
      const rawPaths =
        event.toolName === "read"
          ? Array.isArray(event.input.paths)
            ? event.input.paths.map((entry) => String(entry))
            : [String(event.input.path ?? "")]
          : extractWriteTargets(event.toolName, event.input);
      for (const rawPath of rawPaths) {
        const resolved = resolveTargetPath(rawPath, ctx.cwd);
        if (isSecretBasename(path.basename(resolved)) && !isSecretAllowed(resolved)) {
          const basename = path.basename(resolved).toLowerCase();
          logHarnessCode(ctx.cwd, `G1 rc=21 tl=${event.toolName} f=${basename}`);
          return {
            block: true,
            reason: `blocked: ${basename} is a conventional secret file; ask the user to run /harness-allow-secret <path> for this session`,
          };
        }
      }
      if (event.toolName === "read") {
        for (const rawPath of rawPaths) {
          const verdict = evaluateRead(rawPath, ctx.cwd, branch);
          if (!verdict) continue;
          if (verdict.block) {
            logHarnessCode(ctx.cwd, `G1 rc=10 tl=read f=${path.basename(rawPath)}`);
            return { block: true, reason: verdict.block };
          }
          // Only a single-path read can carry its selector back as one string.
          if (verdict.rewrite !== undefined && rawPaths.length === 1) {
            logHarnessCode(ctx.cwd, `G1 rc=11 tl=read f=${path.basename(rawPath)}`);
            readInput = { ...event.input, path: verdict.rewrite };
          }
        }
      }
    }
    const rewrittenInput = todoInput ?? taskInput ?? readInput;
    const effectiveInput = rewrittenInput ?? event.input;
    if (typeof event.toolCallId === "string" && event.toolCallId !== "") {
      if (effectiveInputs.size >= 1024) {
        const oldest = effectiveInputs.keys().next().value;
        if (oldest !== undefined) effectiveInputs.delete(oldest);
      }
      effectiveInputs.set(event.toolCallId, effectiveInput);
    }
    const failure = nextFailureDecision(failureKey(event.toolName, effectiveInput));
    if (failure.block) {
      logHarnessCode(ctx.cwd, `G1 rc=20 tl=${event.toolName}`);
      return { block: true, reason: failure.reason ?? "change approach; the same call already failed twice" };
    }
    if (event.toolName === "bash") {
      const command = String(event.input.command ?? "");
      const tokens = command.split(/[\s;&|()<>\"'`]+/g);
      for (const token of tokens) {
        const candidate = token.trim();
        if (candidate.length === 0) continue;
        const resolved = resolveTargetPath(candidate, ctx.cwd);
        if (isSecretBasename(path.basename(resolved)) && !isSecretAllowed(resolved)) {
          const basename = path.basename(resolved).toLowerCase();
          logHarnessCode(ctx.cwd, `G1 rc=21 tl=${event.toolName} f=${basename}`);
          return {
            block: true,
            reason: `blocked: ${basename} is a conventional secret file; ask the user to run /harness-allow-secret <path> for this session`,
          };
        }
      }
      const bash = evaluateBash(command, ctx.cwd);
      if (bash.block) {
        logHarnessCode(ctx.cwd, `G1 rc=22 tl=bash`);
        return { block: true, reason: bash.reason };
      }
    }
    return rewrittenInput ? { input: rewrittenInput } : undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const errorText = extractErrorText(event.content);
    if (event.isError === true) {
      logHarnessCode(ctx.cwd, `E1 tl=${event.toolName} ec=${errorCodeNum(errorText)}`);
    }
    writeTelemetry(ctx.cwd, ctx.sessionManager.getSessionId(), "tool_result", {
      tool: event.toolName,
      ok: event.isError !== true,
      error_class: errorClass(event.isError === true, errorText),
    });
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const effectiveInput = (callId !== "" ? effectiveInputs.get(callId) : undefined) ?? event.input;
    if (callId !== "") effectiveInputs.delete(callId);
    recordFailure(failureKey(event.toolName, effectiveInput), event.isError === true);
    if (event.toolName === "read" && event.isError !== true) {
      // Baseline for the duplicate-read guard: the file as it was when this result arrived.
      const resolved = resolveTargetPath(String(event.input.path ?? ""), ctx.cwd);
      try {
        const stat = statSync(resolved);
        if (stat.isFile()) rememberReadStat(event.toolCallId, stat.mtimeMs, stat.size);
      } catch {
        // Missing path: nothing to remember, and the next read is allowed anyway.
      }
    }
  });

  pi.on("retry_fallback_applied", async (event, ctx) => {
    writeTelemetry(ctx.cwd, ctx.sessionManager.getSessionId(), "retry_fallback_applied", {
      from: String(event.from ?? ""),
      to: String(event.to ?? ""),
      role: String(event.role ?? ""),
    });
  });

  pi.on("auto_retry_start", async (event, ctx) => {
    writeTelemetry(ctx.cwd, ctx.sessionManager.getSessionId(), "auto_retry_start", {});
  });

  pi.on("auto_compaction_start", async (event, ctx) => {
    writeTelemetry(ctx.cwd, ctx.sessionManager.getSessionId(), "auto_compaction_start", {});
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    resetFailureCounters();
    try {
      mkdirSync(path.join(ctx.cwd, ".omp", "harness"), { recursive: true });
      appendFileSync(path.join(ctx.cwd, ".omp", "harness", "telemetry.jsonl"), `${JSON.stringify({ event: "session_shutdown" })}\n`);
    } catch {
      // Best-effort shutdown telemetry; never throw into the session.
    }
  });
}
