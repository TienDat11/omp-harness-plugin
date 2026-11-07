import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { allowDestructive, allowSecret, writeTextFileAtomic } from "./state.ts";
import { summarizeSessionFile, resolveSessionFile, type SessionTotals } from "./telemetry.ts";
import { judge, parseReadinessBlock, readiness } from "./decisions.ts";

type Acceptance = { id: string; joint: string; check: string; pass: boolean; evidence: string; };
type Outcome = { task: string; dir: string; tier: string; goal: string; acceptance: Acceptance[]; models: string[]; tokens: number; wall_ms: number; notes: string; sessionTelemetry?: SessionTotals; recorded_at: string; };

export interface DesignMisconception {
  similar_case: string;
  why_wrong_there: string;
  right_pattern_instead: string;
}

export interface DesignLesson {
  why_this_design: string;
  avoid_misconceptions: DesignMisconception[];
  files?: string[];
  reflection_question?: string;
}

export function sanitizeLessonText(text: string): string {
  return (text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(?:api[_-]?key|secret|password|passwd|token|credential)\s*[:=]\s*["']?[^\s"',}]{8,}/gi, (m) => m.split(/[:=]/)[0] + "=[redacted]")
    .trim();
}

export function formatDesignLesson(lesson: DesignLesson, meta?: { dir?: string; tier?: string; goal?: string }): string {
  const lines: string[] = [];
  lines.push("## 1. Vì sao thiết kế & thay đổi này đúng (Why This Design Is Right)");
  lines.push(sanitizeLessonText(lesson.why_this_design));
  lines.push("");
  lines.push("## 2. Tránh lầm tưởng ở các case tương tự (When NOT To Use This Design)");
  for (const m of lesson.avoid_misconceptions ?? []) {
    lines.push(`- ${sanitizeLessonText(m.similar_case)}: ${sanitizeLessonText(m.why_wrong_there)} → ${sanitizeLessonText(m.right_pattern_instead)}`);
  }
  const files = lesson.files?.map((f) => sanitizeLessonText(f)).filter(Boolean) ?? [];
  if (files.length > 0) { lines.push(""); lines.push(`Files: ${files.join(", ")}`); }
  if (lesson.reflection_question) { lines.push(""); lines.push(sanitizeLessonText(lesson.reflection_question)); }
  return lines.join("\n");
}

interface TelemetryRollup {
  outcomesWithTelemetry: number;
  avgCacheHitRate: number;
  totalToolErrors: number;
  totalToolCalls: number;
  totalSubagentSpawns: number;
  byTask: Array<{
    task: string;
    cacheHitRate: number;
    toolErrors: number;
    subagentSpawns: number;
  }>;
}

function hasTelemetry(o: Outcome): o is Outcome & { sessionTelemetry: SessionTotals } {
  return o.sessionTelemetry !== undefined;
}

function rollupTelemetry(outcomes: Outcome[]): TelemetryRollup {
  const withTelemetry = outcomes.filter(hasTelemetry);
  const outcomesWithTelemetry = withTelemetry.length;
  const avgCacheHitRate =
    outcomesWithTelemetry === 0
      ? 0
      : withTelemetry.reduce((sum, o) => sum + o.sessionTelemetry.cacheHitRate, 0) / outcomesWithTelemetry;
  return {
    outcomesWithTelemetry,
    avgCacheHitRate,
    totalToolErrors: withTelemetry.reduce((sum, o) => sum + o.sessionTelemetry.toolErrors, 0),
    totalToolCalls: withTelemetry.reduce((sum, o) => sum + o.sessionTelemetry.toolCalls, 0),
    totalSubagentSpawns: withTelemetry.reduce((sum, o) => sum + o.sessionTelemetry.subagentSpawns, 0),
    byTask: withTelemetry.map((o) => ({
      task: o.task,
      cacheHitRate: o.sessionTelemetry.cacheHitRate,
      toolErrors: o.sessionTelemetry.toolErrors,
      subagentSpawns: o.sessionTelemetry.subagentSpawns,
    })),
  };
}

const HARNESS_DIR = path.join(".omp", "harness");

async function readJsonl<T>(file: string, parse: (raw: unknown) => T | null): Promise<T[]> {
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parse(JSON.parse(trimmed) as unknown);
      if (parsed !== null) out.push(parsed);
    } catch {
      // ignore
    }
  }
  return out;
}

async function findOutcomes(root: string, sinceDays: number): Promise<Outcome[]> {
  const workDir = path.join(root, ".omp", "work");
  if (!existsSync(workDir)) return [];
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const out: Outcome[] = [];
  for (const day of await readdir(workDir)) {
    const dayDir = path.join(workDir, day);
    let entries: string[];
    try {
      entries = await readdir(dayDir);
    } catch {
      continue;
    }
    for (const slug of entries) {
      const file = path.join(dayDir, slug, "outcome.json");
      if (!existsSync(file)) continue;
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as Outcome;
        const stamp = Date.parse(parsed.recorded_at ?? day);
        if (Number.isFinite(stamp) && stamp < cutoff) continue;
        out.push(parsed);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function slugify(title: string): string {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "task";
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function claimDir(parent: string, base: string): Promise<string | null> {
  await mkdir(parent, { recursive: true });
  for (let n = 1; n <= 10; n++) {
    const candidate = path.join(parent, n === 1 ? base : `${base}-${n}`);
    if (existsSync(candidate)) continue;
    try {
      await mkdir(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return null;
}

export default function tools(pi: ExtensionAPI) {
  const z = pi.zod;
  const DecisionRecordSchema = z.object({
    candidate_id: z.string(),
    target: z.string(),
    surface: z.string(),
    change: z.string(),
    accepted: z.boolean(),
    decided_at: z.string(),
  }).passthrough();
  type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
  const parseDecision = (raw: unknown): DecisionRecord | null => {
    const parsed = DecisionRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };

  pi.registerTool({
    name: "harness_record",
    label: "Harness: record outcome",
    description: "Write outcome.json into a task's intake folder: tier, goal, per-acceptance pass/fail with the joint it tests, models used, tokens, wall time. Call once at the end of every M/L/XL task, before review. This is the only evidence the harness loop mines; a task with no outcome.json is invisible to it.",
    parameters: z.object({
      dir: z.string().describe("Intake folder path returned by intake_open"),
      tier: z.enum(["S", "M", "L", "XL"]),
      goal: z.string().describe("One-sentence observable goal"),
      acceptance: z.array(z.object({
        id: z.string().describe("Acceptance criterion id from the goal, e.g. A1"),
        joint: z.enum(["intake", "explore", "plan", "execute", "review", "verify", "memory", "recovery", "delegation", "cost"]).describe("Which harness joint this criterion tests"),
        check: z.string().describe("The command or observation that decides pass/fail"),
        pass: z.boolean(),
        evidence: z.string().describe("One line of observed output; never a paraphrase"),
      })).describe("One entry per acceptance criterion in the goal"),
      models: z.array(z.string()).describe("Model selectors actually used"),
      tokens: z.number().describe("Total tokens for the task, 0 if unknown"),
      wall_ms: z.number().describe("Wall time in milliseconds, 0 if unknown"),
      notes: z.string().optional().describe("Deviation from plan, open items"),
      lesson: z.object({
        why_this_design: z.string().describe("3-5 concise lines teaching the user WHY these code changes and design choices are right (goal, root cause, chosen vs rejected alternative, tradeoff, verification evidence + file:line citations)"),
        avoid_misconceptions: z.array(z.object({
          similar_case: z.string().describe("Look-alike scenario where someone might be tempted to copy this design"),
          why_wrong_there: z.string().describe("Why this design fails or is the wrong tradeoff in that look-alike scenario"),
          right_pattern_instead: z.string().describe("What design or pattern to use instead in that scenario"),
        })).min(1).describe("Counter-examples to prevent false generalization in similar-looking cases"),
        files: z.array(z.string()).optional(),
        reflection_question: z.string().optional().describe("Optional 1-2 sentence non-blocking reflection prompt for the user (never a quiz blocker)"),
      }).optional(),
    }),
    approval: "write",
    loadMode: "deferred",
    strict: true,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dir = path.resolve(params.dir);
      if (!existsSync(dir)) throw new Error(`harness_record: no such intake dir: ${dir}`);
      const ompWorkSeg = `${path.sep}.omp${path.sep}work${path.sep}`;
      const ompIdx = dir.indexOf(ompWorkSeg);
      const root =
        ompIdx > 0 ? dir.slice(0, ompIdx) : ((ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd());
      const ctxSessionFile = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)?.sessionManager?.getSessionFile?.();
      const sessionFile = resolveSessionFile(ctxSessionFile, root);
      let tokens = params.tokens;
      let sessionTelemetry: SessionTotals | undefined;
      if (sessionFile !== "") {
        sessionTelemetry = summarizeSessionFile(sessionFile);
        if (tokens === 0 && sessionTelemetry.combined.totalTokens > 0) tokens = sessionTelemetry.combined.totalTokens;
      }
      const attachTelemetry = sessionTelemetry !== undefined && (sessionTelemetry.combined.totalTokens > 0 || sessionTelemetry.toolCalls > 0);
      const outcome: Outcome = { task: path.basename(dir), dir, tier: params.tier, goal: params.goal, acceptance: params.acceptance, models: params.models, tokens, wall_ms: params.wall_ms, notes: params.notes ?? "", sessionTelemetry: attachTelemetry ? sessionTelemetry : undefined, recorded_at: new Date().toISOString() };
      const file = path.join(dir, "outcome.json");
      writeTextFileAtomic(file, JSON.stringify(outcome, null, 2));
      const failed = outcome.acceptance.filter((a) => !a.pass).length;
      let lessonText = "";
      const lesson = (params as { lesson?: DesignLesson }).lesson;
      const shouldWriteLesson = Boolean(lesson) || process.env.OMP_HARNESS_ARTIFACT_DELIVERY === "1";
      if (shouldWriteLesson && lesson) {
        const formatted = formatDesignLesson(lesson, { dir, tier: params.tier, goal: params.goal });
        writeTextFileAtomic(path.join(dir, "lesson.md"), formatted);
        lessonText = formatted;
        const lessonsFile = path.join(root, ".omp", "harness", "lessons.jsonl");
        try {
          await mkdir(path.dirname(lessonsFile), { recursive: true });
          await appendFile(lessonsFile, JSON.stringify({ recorded_at: new Date().toISOString(), dir, tier: params.tier, goal: params.goal, files: lesson.files ?? [], why_this_design: lesson.why_this_design, avoid_misconceptions: lesson.avoid_misconceptions, reflection_question: lesson.reflection_question }) + "\n", "utf8");
        } catch {}
      }
      const base = `harness_record: ${file}\nacceptance: ${outcome.acceptance.length} total, ${failed} failed`;
      const body = lessonText ? `${base}\n\n${lessonText}` : base;
      const details: Record<string, unknown> = { file, failed };
      if (!lesson) details.lesson_cue = "Teach the user (1) why this design is right and (2) which look-alike cases must NOT use this design.";
      return { content: [{ type: "text" as const, text: body }], details };
    },
  });

  pi.registerTool({
    name: "harness_mine",
    label: "Harness: mine failures",
    description: "Read every outcome.json under <root>/.omp/work within the window, group failed acceptance entries by signature (joint + criterion id), and return a compact evidence bundle: cluster size, representative evidence lines, and the rejected edits already logged so the proposer does not repeat them. Deterministic, no model call. Use before proposing any harness edit.",
    parameters: z.object({
      cwd: z.string().optional().describe("Project root (defaults to session cwd)"),
      since_days: z.number().optional().describe("Window in days, default 14"),
      min_support: z.number().optional().describe("Minimum cluster size to report, default 2"),
    }),
    approval: "read",
    loadMode: "deferred",
    strict: true,
    async execute(_id, params) {
      const root = params.cwd ?? process.cwd();
      const since = params.since_days ?? 14;
      const minSupport = params.min_support ?? 2;
      const outcomes = await findOutcomes(root, since);
      const clusters = new Map<string, { joint: string; criterion: string; count: number; tiers: Set<string>; evidence: string[]; tasks: string[] }>();
      let failedTasks = 0;
      for (const o of outcomes) {
        const failed = Array.isArray(o.acceptance) ? o.acceptance.filter((a) => !a.pass) : [];
        if (failed.length > 0) failedTasks++;
        for (const a of failed) {
          const key = `${a.joint}::${a.id}`;
          const c = clusters.get(key) ?? { joint: a.joint, criterion: a.id, count: 0, tiers: new Set<string>(), evidence: [], tasks: [] };
          c.count++;
          c.tiers.add(o.tier);
          if (a.evidence && c.evidence.length < 4) c.evidence.push(a.evidence.slice(0, 240));
          if (c.tasks.length < 4) c.tasks.push(o.task);
          clusters.set(key, c);
        }
      }
      const rejected = await readJsonl(path.join(root, HARNESS_DIR, "rejected.jsonl"), parseDecision);
      const lessonsFile = path.join(root, HARNESS_DIR, "lessons.md");
      const lessons = existsSync(lessonsFile) ? (await readFile(lessonsFile, "utf8")).slice(0, 4000) : "";
      const telemetry = rollupTelemetry(outcomes);
      const ordered = [...clusters.values()].filter((c) => c.count >= minSupport).sort((a, b) => b.count - a.count).map((c) => ({ signature: `${c.joint}::${c.criterion}`, joint: c.joint, count: c.count, tiers: [...c.tiers], tasks: c.tasks, evidence: c.evidence }));
      const bundle = { window_days: since, outcomes: outcomes.length, failed_tasks: failedTasks, clusters: ordered, rejected_recent: rejected.slice(-15), lessons_excerpt: lessons, telemetry };
      const text = [`harness_mine: ${outcomes.length} outcomes, ${failedTasks} with failures, ${ordered.length} clusters (support >= ${minSupport})`, ...ordered.map((c) => `- ${c.signature} x${c.count} [${c.tiers.join(",")}] :: ${c.evidence[0] ?? "(no evidence line)"}`), `telemetry: ${telemetry.outcomesWithTelemetry} outcomes with telemetry, avg cache hit ${(telemetry.avgCacheHitRate * 100).toFixed(1)}%, ${telemetry.totalToolCalls} tool calls, ${telemetry.totalToolErrors} tool errors, ${telemetry.totalSubagentSpawns} subagent spawns`, ordered.length === 0 ? "- no cluster reached the support threshold" : ""].filter(Boolean).join("\n");
      return { content: [{ type: "text" as const, text }], details: bundle };
    },
  });

  pi.registerTool({
    name: "harness_gate",
    label: "Harness: admission gate",
    description: "Apply the admission rule to one candidate edit's split scores. Accept only when both splits do not degrade and at least one improves: d_in >= 0 AND d_ho >= 0 AND max(d_in, d_ho) > 0. Writes the decision to .omp/harness/decisions.jsonl and, when accepted, appends the edit to accepted.jsonl. A rejected edit is appended to rejected.jsonl so it is never proposed again.",
    parameters: z.object({
      cwd: z.string().optional().describe("Project root (defaults to session cwd)"),
      candidate_id: z.string().describe("Stable id, e.g. h-20261019-a"),
      target: z.string().describe("Failure signature this edit addresses"),
      surface: z.string().describe("File or config key the edit changes"),
      change: z.string().describe("The edit in one line"),
      in_before: z.number().describe("Held-in passes before"),
      in_after: z.number().describe("Held-in passes after"),
      ho_before: z.number().describe("Held-out passes before"),
      ho_after: z.number().describe("Held-out passes after"),
      repeats: z.number().optional().describe("Evaluation repeats; >1 means aggregate pass counts"),
    }),
    approval: "write",
    loadMode: "deferred",
    strict: true,
    async execute(_id, params) {
      const root = params.cwd ?? process.cwd();
      const dIn = params.in_after - params.in_before;
      const dHo = params.ho_after - params.ho_before;
      const accepted = dIn >= 0 && dHo >= 0 && Math.max(dIn, dHo) > 0;
      const record = { candidate_id: params.candidate_id, target: params.target, surface: params.surface, change: params.change, in_before: params.in_before, in_after: params.in_after, ho_before: params.ho_before, ho_after: params.ho_after, d_in: dIn, d_ho: dHo, repeats: params.repeats ?? 1, accepted, decided_at: new Date().toISOString() };
      const base = path.join(root, HARNESS_DIR);
      await mkdir(base, { recursive: true });
      await appendFile(path.join(base, "decisions.jsonl"), JSON.stringify(record) + "\n", "utf8");
      await appendFile(path.join(base, accepted ? "accepted.jsonl" : "rejected.jsonl"), JSON.stringify(record) + "\n", "utf8");
      return { content: [{ type: "text" as const, text: `harness_gate: ${accepted ? "ACCEPT" : "REJECT"} ${params.candidate_id} (d_in=${dIn >= 0 ? "+" : ""}${dIn}, d_ho=${dHo >= 0 ? "+" : ""}${dHo})` }], details: record };
    },
  });

  pi.registerTool({
    name: "intake_open",
    label: "Intake: open",
    description: "Create <project>/.omp/work/<YYYY-MM-DD>/<slug>/ for tier M, L or XL and write 00-requirement.md (verbatim request) plus 01-clarify.md when questions are given. Tier S is skipped: creates nothing, the change is done directly. Use at the start of every task that changes files at tier M, L or XL. Returns the folder path.",
    parameters: z.object({
      tier: z.enum(["S", "M", "L", "XL"]).describe("Task tier from task-intake; S is skipped (no folder), M/L/XL create the folder"),
      title: z.string().describe("Short task title; becomes the folder slug"),
      requirement: z.string().describe("The user's request, verbatim"),
      questions: z.array(z.string()).optional().describe("Clarifying questions to seed 01-clarify.md"),
      date: z.string().optional().describe("Override YYYY-MM-DD (defaults to today)"),
      cwd: z.string().optional().describe("Project root (defaults to session cwd)"),
      kind: z.enum(["code", "product"]).optional().describe("Requirement kind; labels the requirement file header"),
      source: z.object({ kind: z.enum(["text", "issue", "pr", "document"]), locator: z.string() }).optional().describe("Source context for the requirement"),
      acceptance: z.array(z.object({ id: z.string(), check: z.string() })).optional().describe("Acceptance criteria"),
    }),
    approval: "write",
    loadMode: "deferred",
    strict: true,
    async execute(_id, params) {
      const root = params.cwd ?? process.cwd();
      if (params.tier === "S") return { content: [{ type: "text" as const, text: "intake: skipped (tier S — làm thẳng)" }], details: { skipped: true } };
      const day = params.date ?? today();
      const base = slugify(params.title);
      const dir = await claimDir(path.join(root, ".omp", "work", day), base);
      if (!dir) throw new Error(`intake: không tạo được folder cho slug "${base}" (đã có -2..-10)`);
      const requirementFile = path.join(dir, "00-requirement.md");
      const requirementBody = `# 00 — Requirement (verbatim)\n\nNgày: ${day}\nTitle: ${params.title}\nKind: ${params.kind ?? "code"}\n\n## Yêu cầu gốc\n\n> ${params.requirement.replace(/\n/g, "\n> ")}\n`;
      await writeFile(requirementFile, requirementBody, { encoding: "utf8", flag: "wx" });
      const written = [requirementFile];
      if (params.questions && params.questions.length > 0) {
        const clarifyFile = path.join(dir, "01-clarify.md");
        const body = params.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
        await writeFile(clarifyFile, `# 01 — Clarify\n\n## Câu hỏi\n\n${body}\n\n## Giả định\n\n## Chưa rõ\n`, { encoding: "utf8", flag: "wx" });
        written.push(clarifyFile);
      }
      let sourceSection = "";
      if (params.source) sourceSection = `\n## Source\n\nKind: ${params.source.kind}\nLocator: ${params.source.locator}\n`;
      let acceptanceSection = "";
      if (params.acceptance) acceptanceSection = `\n## Acceptance\n\n${params.acceptance.map((a) => `- ${a.id}: ${a.check}`).join("\n")}\n`;
      if (params.source) await appendFile(requirementFile, sourceSection, "utf8");
      if (params.acceptance) await appendFile(requirementFile, acceptanceSection, "utf8");
      let gitignore = "skipped";
      const gitignoreFile = path.join(root, ".gitignore");
      if (existsSync(path.join(root, ".git"))) {
        const current = existsSync(gitignoreFile) ? await readFile(gitignoreFile, "utf8") : "";
        const lines = current.split(/\r?\n/).map((line) => line.trim());
        if (!lines.includes(".omp/work/") && !lines.includes(".omp/work")) {
          const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
          await writeFile(gitignoreFile, `${current}${prefix}.omp/work/\n`, "utf8");
          gitignore = "added";
        } else {
          gitignore = "present";
        }
      }
      return { content: [{ type: "text" as const, text: `intake: ${dir}\nwrote: ${written.map((f) => path.basename(f)).join(", ")}\ngitignore: ${gitignore}` }], details: { dir, written, gitignore } };
    },
  });

  pi.registerTool({
    name: "harness_decide",
    label: "Harness: decide",
    description: "Ask the bounded TypeSafe Jev endpoint for a semantic judgment. For \"intake\", \"requirement\", and \"priority\", the complete supplied state leaves the machine for the configured TypeSafe endpoint; this tool is advisory. For \"readiness\", the block is evaluated locally.",
    parameters: z.object({
      kind: z.enum(["intake", "requirement", "priority", "readiness"]),
      state: z.string().optional(),
      candidates: z.array(z.object({ id: z.string(), description: z.string().optional() })).optional(),
      path: z.string().optional(),
      cwd: z.string().optional(),
    }),
    approval: "read",
    loadMode: "deferred",
    strict: true,
    async execute(_id, params, signal, _ctx) {
      if (params.kind === "readiness") {
        let block: unknown;
        let parseFailed = false;
        if (params.path) {
          const text = await readFile(params.path, "utf8");
          block = parseReadinessBlock(text);
          if (block === null) parseFailed = true;
        } else if (params.state) {
          try {
            block = JSON.parse(params.state);
          } catch {
            block = null;
            parseFailed = true;
          }
        }
        if (parseFailed) return { content: [{ type: "text" as const, text: "harness_decide: readiness\nverdict: needs-clarification\nok: false\nreason: readiness block could not be parsed\nproblems: parse-error" }], details: { verdict: "needs-clarification", ok: false, reason: "readiness block could not be parsed", problems: ["parse-error"] } };
        const result = readiness(block);
        const text = ["harness_decide: readiness", `verdict: ${result.verdict}`, `declared: ${result.declared}`, `ok: ${result.ok}`, `reason: ${result.reason}`, `problems: ${result.problems.join(", ")}`].join("\n");
        return { content: [{ type: "text" as const, text }], details: result };
      }
      if (!params.state) throw new Error("harness_decide: state is required for remote kinds");
      if (params.candidates && params.candidates.length > 12) throw new Error("harness_decide: more than 12 candidates supplied");
      let state: Record<string, unknown> | string = params.state;
      try {
        state = JSON.parse(params.state) as Record<string, unknown> | string;
      } catch {
        state = params.state;
      }
      const answer = await judge({ kind: params.kind, state, candidates: params.candidates, cwd: params.cwd ?? process.cwd(), signal }, {});
      if (answer.status === "unavailable") {
        const reason = answer.reason;
        if (reason?.startsWith("state exceeds") || reason?.startsWith("state contains")) throw new Error(`harness_decide: ${reason}`);
      }
      const primaryLines = Object.entries(answer.answers ?? {}).map(([key, value]) => `primary ${key}: ${JSON.stringify(value)}`);
      const reasonLines = answer.reason ? [`reason: ${answer.reason}`] : [];
      const text = ["harness_decide: remote", `status: ${answer.status}`, ...reasonLines, ...primaryLines, `receipt: ${answer.receiptId ?? "n/a"}`, `fallback: ${answer.fallback}`].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: answer.status,
          receiptId: answer.receiptId ?? null,
          fallback: answer.fallback,
          ...(answer.reason ? { reason: answer.reason } : {}),
        },
      };
    },
  });

  pi.registerCommand("harness-allow-secret", {
    description: "Authorize one secret-bearing path for this session.",
    handler: async (args, ctx) => {
      const raw = typeof args === "string" ? args : String(args?.path ?? "");
      const root = path.resolve(ctx.cwd ?? process.cwd());
      const resolved = path.resolve(root, raw);
      const inside = resolved === root || resolved.startsWith(root + path.sep);
      if (!inside) {
        ctx.ui.notify(`harness-allow-secret: outside root ${root}`, "error");
        return;
      }
      const normalized = allowSecret(resolved);
      ctx.ui.notify(`harness-allow-secret: ${normalized}`, "info");
    },
  });

  pi.registerCommand("harness-allow-destructive", {
    description: "Authorize one exact destructive command for this session.",
    handler: async (args, ctx) => {
      const raw = typeof args === "string" ? args : String(args?.command ?? args?.exact_command ?? "");
      const normalized = allowDestructive(raw);
      ctx.ui.notify(`harness-allow-destructive: ${normalized}`, "info");
      ctx.ui.notify("harness-allow-destructive: session-only authorization", "info");
    },
  });
}
