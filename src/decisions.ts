/**
 * decisions.ts — optional, bounded TypeSafe Jev decision layer.
 *
 * This module is a LIBRARY. It registers no omp events and no tools; intake.ts,
 * tools.ts and the tests import it. It must never subscribe to `tool_call`,
 * `tool_result`, `context`, `before_agent_start`, `before_provider_request`,
 * any compaction event, or `agent_end`.
 *
 * Hard scope limits:
 *  - advisory only. No model switch, no tool activation, no compaction choice,
 *    no prompt/history mutation, no permission grant.
 *  - `OMP_HARNESS_JEV=0` or unset: no client construction, no network request.
 *  - one request per decision, `maxRetries: 0`, no fallback to a paid chat model.
 *  - a failed or ambiguous response returns `unavailable`/`abstain` with
 *    `fallback: "deterministic"`; it never fails the caller's user request.
 *  - `readiness()` is pure local code. It never calls the network.
 *
 * Credentials come from `TYPESAFE_API_KEY` only. Nothing here reads a key from
 * models.yml, MCP config, sessions, or logs.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { looksLikeSecret } from "./policy.ts";
import { resolveUserHarnessDir, writeTextFileAtomic } from "./state.ts";

export const JEV_QUESTION_SET_INTAKE = "intake-routing-v1";
export const JEV_QUESTION_SET_REQUIREMENT = "requirement-v1";
export const JEV_QUESTION_SET_PRIORITY = "priority-v1";
export const JEV_QUESTION_SET_MEMORY_WRITE = "memory-write-v1";
export const JEV_QUESTION_SET_MEMORY_RECALL = "memory-recall-v1";

export const TYPESAFE_DEFAULT_ENDPOINT = "https://api.typesafe.ai";
export const TYPESAFE_DEFAULT_MODEL = "jev-1.14.0";
export const NS24_ENDPOINT = "https://api.ns24.io";
export const NS24_MODEL = "jev-latest";

/**
 * Per-attempt timeout. One request, no retry, so this bounds the whole call.
 * Measured cold-start latency on the operator's gateway is ~1.7 s, so the old
 * 2 s cap failed the first call of a session; 5 s keeps the call bounded while
 * leaving headroom.
 */
const REQUEST_TIMEOUT_MS = 5_000;
/** Below this the answer is not actionable and the caller falls back. */
const MIN_CONFIDENCE = 0.5;
const MAX_STATE_BYTES = 16_000;
const MAX_CANDIDATES = 12;
const PROBABILITY_SUM_TOLERANCE = 0.02;

export function defaultProbesDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveUserHarnessDir(env);
  return dir ? path.join(dir, "probes") : "";
}
const PROBES_DIR = fileURLToPath(new URL("../probes/", import.meta.url));

export type DecisionStatus = "answered" | "abstain" | "unavailable";
export type DecisionKind =
  | "intake"
  | "requirement"
  | "priority"
  | "readiness"
  | "memory-write"
  | "memory-recall";

export interface DecisionAnswer {
  status: DecisionStatus;
  fallback: "deterministic" | "none";
  kind: DecisionKind;
  questionSet: string;
  answers: Record<string, unknown>;
  receiptId?: string;
  requestedModel?: string;
  actualModel?: string;
  latencyMs?: number;
  reason?: string;
}

/** The minimal SDK surface this module depends on; tests inject a fake. */
export interface SystemOneClient {
  systemOne(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface JudgeDeps {
  client?: SystemOneClient;
  /** Injected clock for deterministic receipts in tests. */
  now?: () => number;
  /** Overrides the on-disk probe directory; tests point this at a temp dir. */
  probesDir?: string;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** True only when the operator explicitly opted in with OMP_HARNESS_JEV=1. */
export function jevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMP_HARNESS_JEV === "1";
}

export function jevEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TYPESAFE_BASE_URL?.trim();
  return (raw && raw.length > 0 ? raw : TYPESAFE_DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return "";
  }
}

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

export function probeFileFor(endpoint: string, probesDir: string = defaultProbesDir()): string {
  return path.join(probesDir, `jev-probe-${hostOf(endpoint).replace(/[^a-z0-9.-]/g, "_")}.json`);
}

export interface EndpointProbe {
  endpoint: string;
  ok: boolean;
  /** Model string the endpoint answered with, when one was observed. */
  model?: string;
  /** Model string the probe asked for. */
  requested?: string;
  at?: string;
  expiresAt?: string;
  /** Failure diagnostic; carries the observed model or the gateway's own error text. */
  reason?: string;
}

export function readEndpointProbe(
  endpoint: string,
  probesDir: string = defaultProbesDir(),
  now: () => number = Date.now,
): EndpointProbe | null {
  try {
    const raw = JSON.parse(readFileSync(probeFileFor(endpoint, probesDir), "utf8")) as EndpointProbe;
    if (!raw || typeof raw !== "object") return null;
    if (normalizeEndpoint(raw.endpoint ?? "") !== normalizeEndpoint(endpoint)) return null;
    if (typeof raw.model !== "string" || raw.model.length === 0) return null;
    if (typeof raw.expiresAt === "string" && Date.parse(raw.expiresAt) < now()) return null;
    const ttlRaw = process.env.OMP_HARNESS_PROBE_TTL_MS;
    const ttl = ttlRaw !== undefined && ttlRaw !== "" ? Number(ttlRaw) : NaN;
    if (typeof raw.at === "string" && Number.isFinite(ttl) && Number.isInteger(ttl) && ttl > 0) {
      if (Date.parse(raw.at) + ttl < now()) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * The model a probe should ASK an endpoint for: the explicit operator override,
 * else the host default, else `jev-latest`.
 *
 * This is deliberately independent of any probe file, so `/harness-decision
 * probe` can bootstrap a route that has never been probed.
 */
export function requestedModelFor(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.OMP_HARNESS_JEV_MODEL?.trim();
  if (override && override.length > 0) return override;
  const host = hostOf(endpoint);
  if (host === "api.typesafe.ai") return TYPESAFE_DEFAULT_MODEL;
  return NS24_MODEL;
}

/**
 * The model this endpoint is allowed to answer with.
 *
 * `null` means "not enabled": an endpoint with no passing probe is refused
 * rather than trusted, so an alias change cannot silently become the decider.
 * The default TypeSafe endpoint is trusted by host identity; every other host
 * (including ns24) must first record a passing probe.
 */
export function expectedModelFor(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
  probesDir: string = PROBES_DIR,
): string | null {
  const host = hostOf(endpoint);
  const override = env.OMP_HARNESS_JEV_MODEL?.trim();
  const hasOverride = typeof override === "string" && override.length > 0;
  if (host === "api.typesafe.ai") return hasOverride ? (override as string) : TYPESAFE_DEFAULT_MODEL;
  const probe = readEndpointProbe(endpoint, probesDir);
  if (!probe?.ok) return null;
  if (typeof probe.model !== "string" || probe.model.length === 0) return null;
  return hasOverride ? (override as string) : probe.model;
}

// ---------------------------------------------------------------------------
// Local readiness (pure, no network)
// ---------------------------------------------------------------------------

export type ReadinessVerdict = "go" | "needs-clarification" | "kill";

export interface ReadinessBlock {
  problem_defined: string;
  evidence_strength: string;
  measurable_outcome: string;
  concept: string;
  recommended_option: string;
  verdict: string;
  reason: string;
}

export interface ReadinessResult {
  verdict: ReadinessVerdict;
  declared: string | null;
  ok: boolean;
  reason: string;
  problems: string[];
}

const READINESS_FIELDS = [
  "problem_defined",
  "evidence_strength",
  "measurable_outcome",
  "concept",
  "recommended_option",
  "verdict",
  "reason",
] as const;

/**
 * Deterministic verdict for a BA/PM assessment block.
 *
 * `go` requires all five substantive conditions. Anything malformed, missing or
 * short of those conditions is `needs-clarification` — never `go`. `kill` is an
 * agent/user decision with a stated reason, so it is honoured only when the
 * caller declared it explicitly.
 */
export function readiness(raw: unknown): ReadinessResult {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      verdict: "needs-clarification",
      declared: null,
      ok: false,
      reason: "assessment block is missing or is not a JSON object",
      problems: ["block-not-an-object"],
    };
  }
  const block = raw as Record<string, unknown>;
  for (const field of READINESS_FIELDS) {
    if (!(field in block)) problems.push(`missing:${field}`);
  }
  const text = (field: string): string => {
    const value = block[field];
    if (typeof value !== "string") {
      if (field in block) problems.push(`not-a-string:${field}`);
      return "";
    }
    return value.trim();
  };

  // Evaluate every required field once so `missing:`/`not-a-string:` problems
  // are complete before any verdict is computed.
  const values: Record<string, string> = {};
  for (const field of READINESS_FIELDS) values[field] = text(field);

  const declared = values["verdict"] || null;
  const reason = values["reason"] ?? "";
  const recommended = values["recommended_option"] ?? "";
  const evidence = values["evidence_strength"] ?? "";

  // A block missing a required field, or carrying a non-string one, is
  // malformed: never `go`, and never an honoured `kill`.
  const malformed = problems.some(
    (problem) => problem.startsWith("missing:") || problem.startsWith("not-a-string:"),
  );
  if (malformed) {
    return {
      verdict: "needs-clarification",
      declared,
      ok: false,
      reason: problems.join("; ") || "block is malformed",
      problems,
    };
  }

  if (declared !== null && !["go", "needs-clarification", "kill"].includes(declared)) {
    problems.push(`unknown-verdict:${declared}`);
  }

  const goConditions: Array<[boolean, string]> = [
    [values["problem_defined"] === "yes", "problem_defined is not yes"],
    [evidence === "strong" || evidence === "adequate", "evidence_strength is not strong or adequate"],
    [values["measurable_outcome"] === "yes", "measurable_outcome is not yes"],
    [values["concept"] === "shaped", "concept is not shaped"],
    [recommended.length > 0, "recommended_option is empty"],
  ];

  if (declared === "kill") {
    return {
      verdict: "kill",
      declared,
      ok: reason.length > 0,
      reason: reason.length > 0 ? reason : "kill declared without a stated reason",
      problems: reason.length > 0 ? problems : [...problems, "kill-without-reason"],
    };
  }

  const unmet = goConditions.filter(([holds]) => !holds).map(([, why]) => why);
  const computed: ReadinessVerdict = unmet.length === 0 ? "go" : "needs-clarification";
  const ok = computed === declared && problems.length === 0;
  return {
    verdict: computed,
    declared,
    ok,
    reason:
      computed === "go"
        ? reason || "all readiness conditions hold"
        : unmet.length > 0
          ? unmet.join("; ")
          : "block is malformed",
    problems,
  };
}

/** Extract the trailing ```json readiness block from 01-assessment.md. */
export function parseReadinessBlock(text: string): unknown {
  const fence = /```json\s+readiness[^\n]*\n([\s\S]*?)```/g;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) last = match[1];
  if (last === undefined) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface JudgeInput {
  kind: Exclude<DecisionKind, "readiness">;
  /** Caller-supplied bounded state. Never assembled from repo files by this module. */
  state: Record<string, unknown> | string;
  /** Candidate ids for choice/score question sets. */
  candidates?: Array<{ id: string; description?: string }>;
  /** Deterministic skill candidates; 2..MAX_CANDIDATES add one score question each. */
  skills?: string[];
  /** Absolute project root; receipts are written under it. */
  cwd?: string;
  signal?: AbortSignal;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** Reject, never truncate. A silently shortened judgment is a wrong judgment. */
export function validateState(state: unknown): string | null {
  const serialized = typeof state === "string" ? state : stableStringify(state);
  if (byteLength(serialized) > MAX_STATE_BYTES) {
    return `state exceeds ${MAX_STATE_BYTES} UTF-8 bytes; narrow it instead of truncating`;
  }
  if (looksLikeSecret(serialized)) {
    return "state contains a credential or private-key shaped value; remove it before judging";
  }
  return null;
}

function validateCandidates(candidates: unknown): string | null {
  if (candidates === undefined) return null;
  if (!Array.isArray(candidates)) return "candidates must be an array";
  if (candidates.length > MAX_CANDIDATES) {
    return `at most ${MAX_CANDIDATES} candidates may be judged; got ${candidates.length}`;
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") return "each candidate must be an object";
    const id = (candidate as Record<string, unknown>).id;
    if (typeof id !== "string" || id.trim().length === 0) return "each candidate needs a non-empty id";
  }
  return null;
}

interface QuestionPlan {
  questionSet: string;
  questions: Record<string, unknown>;
  /** Which answer key carries the primary choice and its candidate set. */
  choiceKey?: string;
  expectedOptions?: string[];
  scoreKeys?: string[];
}

function buildPlan(
  kind: JudgeInput["kind"],
  candidates: Array<{ id: string; description?: string }>,
  skills?: string[],
): QuestionPlan {
  if (kind === "intake") {
    const questions: Record<string, unknown> = {
      route: {
        type: "choice",
        instructions:
          "Classify the work this user request needs. Answer only from the request text and the supplied deterministic facts. Do not assume hidden context.",
        criteria: {
          direct:
            "Observed mechanical work: the change is already specified, or it is a one-file edit, a direct answer, or a command the user asked for. No design decision remains.",
          strong:
            "Unknown or high-risk work: architecture, a public schema or API change, security, or a fix whose cause is not yet identified.",
          clarify:
            "Materially missing product decisions: scope, acceptance, or an actor/outcome the requester must choose and cannot be inferred from the request.",
        },
      },
    };
    if (skills && skills.length >= 2 && skills.length <= MAX_CANDIDATES) {
      skills.forEach((name, index) => {
        questions[`skill_${index}`] = {
          type: "score",
          instructions: `Does the skill "${name}" fit this request?`,
          criteria: ["unrelated", "adjacent", "directly_applicable"],
        };
      });
    }
    return {
      questionSet: JEV_QUESTION_SET_INTAKE,
      choiceKey: "route",
      expectedOptions: ["direct", "strong", "clarify"],
      questions,
    };
  }
  if (kind === "requirement") {
    return {
      questionSet: JEV_QUESTION_SET_REQUIREMENT,
      questions: {
        evidence_supports_problem: {
          type: "noul",
          instructions:
            "Does the supplied state contain concrete evidence that the stated problem is real and worth " +
            "solving? Cited facts count; an assertion alone does not.",
          criteria: { true: "cited evidence supports the problem", false: "assertion only, or evidence is absent" },
        },
        clarification_missing: {
          type: "noul",
          instructions:
            "Is a material clarification missing that a human must answer before implementation could start " +
            "safely? Style preferences and reversible defaults do not count.",
          criteria: {
            true: "a blocking decision is unresolved",
            false: "the request is actionable as written",
          },
        },
        concept_shaped: {
          type: "noul",
          instructions:
            "Is at least one concrete concept shaped well enough to estimate and implement — named actors, " +
            "flow, and outcome — rather than a vague aspiration?",
          criteria: { true: "concept is shaped", false: "concept is absent or aspirational" },
        },
      },
    };
  }
  if (kind === "memory-write") {
    return {
      questionSet: JEV_QUESTION_SET_MEMORY_WRITE,
      questions: {
        durable: {
          type: "noul",
          instructions:
            "Does this turn contain something worth recalling in a later session — a decision, a constraint, a " +
            "resolved failure, a verified fact about the project, or a repeatable procedure? Pure tool chatter, " +
            "acknowledgements, and restatements of the request alone do not count.",
          criteria: {
            true: "durable signal is present",
            false: "chatter, acknowledgement, or nothing that outlives the session",
          },
        },
        already_known: {
          type: "noul",
          instructions:
            "Is the durable signal already present in the supplied existing-memory evidence, so storing it again " +
            "would only duplicate an entry?",
          criteria: {
            true: "already covered by existing memory",
            false: "new, or materially changes what is known",
          },
        },
      },
    };
  }
  if (kind === "memory-recall") {
    return {
      questionSet: JEV_QUESTION_SET_MEMORY_RECALL,
      questions: {
        needs_prior_context: {
          type: "noul",
          instructions:
            "Does answering this request require facts from earlier sessions — prior decisions, constraints, or " +
            "state the current message does not supply? Requests that are self-contained, or that are pure " +
            "greetings/commands, do not.",
          criteria: {
            true: "prior-session knowledge is needed",
            false: "self-contained request, no recall needed",
          },
        },
      },
    };
  }
  const scoreKeys = ["value", "urgency", "effort"];
  const questions: Record<string, unknown> = {
    value: {
      type: "score",
      instructions: "How much evidence-backed value would this item deliver? Judge only from the supplied state.",
      criteria: ["no evidence of value", "weak or indirect value", "clear, evidenced value"],
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this item given the supplied constraints and deadlines?",
      criteria: ["no time pressure", "soon but not blocking", "blocking now"],
    },
    effort: {
      type: "score",
      instructions: "How large is the implementation effort implied by the supplied state?",
      criteria: ["single small change", "multi-file change", "large or unknown scope"],
    },
  };
  if (candidates.length > 0) {
    questions.item = {
      type: "choice",
      instructions: "Which candidate item does the supplied state describe?",
      criteria: Object.fromEntries(candidates.map((c) => [c.id, c.description ?? null])),
    };
    return {
      questionSet: JEV_QUESTION_SET_PRIORITY,
      questions,
      choiceKey: "item",
      expectedOptions: candidates.map((c) => c.id),
      scoreKeys,
    };
  }
  return { questionSet: JEV_QUESTION_SET_PRIORITY, questions, scoreKeys };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate one answer against its plan. Returns a problem string or null. */
function validateAnswer(key: string, answer: unknown, plan: QuestionPlan): string | null {
  if (!answer || typeof answer !== "object") return `${key}: answer is not an object`;
  const a = answer as Record<string, unknown>;
  if (plan.choiceKey === key) {
    if (typeof a.choice !== "string") return `${key}: missing choice`;
    if (plan.expectedOptions && !plan.expectedOptions.includes(a.choice)) {
      return `${key}: choice "${a.choice}" is not one of the requested options`;
    }
    if (!isNumber(a.confidence) || a.confidence < 0 || a.confidence > 1) return `${key}: confidence out of range`;
    const probabilities = a.probabilities;
    if (!probabilities || typeof probabilities !== "object") return `${key}: missing probabilities`;
    const entries = Object.entries(probabilities as Record<string, unknown>);
    if (plan.expectedOptions) {
      const keys = entries.map(([label]) => label).sort();
      if (keys.join("|") !== [...plan.expectedOptions].sort().join("|")) {
        return `${key}: probability labels do not match the requested options`;
      }
    }
    let sum = 0;
    for (const [, value] of entries) {
      if (!isNumber(value)) return `${key}: probability is not a number`;
      sum += value;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return `${key}: probabilities sum to ${sum.toFixed(4)}`;
    return null;
  }
  if (a.type === "noul" || typeof a.noul === "number") {
    if (!isNumber(a.noul) || a.noul < 0 || a.noul > 1) return `${key}: noul out of range`;
    return null;
  }
  if (typeof a.score === "number") {
    if (!isNumber(a.score)) return `${key}: score is not a number`;
    if (!isNumber(a.confidence) || a.confidence < 0 || a.confidence > 1) return `${key}: confidence out of range`;
    return null;
  }
  return `${key}: unrecognised answer shape`;
}
/**
 * Rank deterministic skill fit from `skill_<i>` score answers.
 *
 * WHY stable keys: skills may contain characters that break a key, so the
 *   index is the key and the skill name is only carried through here.
 */
export function rankSkillFit(
  answers: Record<string, unknown>,
  skills: string[],
  minScore = 1,
): Array<{ name: string; score: number }> {
  const ranked: Array<{ name: string; score: number }> = [];
  for (let index = 0; index < skills.length; index += 1) {
    const answer = answers[`skill_${index}`];
    const score = answer && typeof answer === "object" ? (answer as Record<string, unknown>).score : undefined;
    if (typeof score !== "number") continue;
    if (score < minScore) continue;
    ranked.push({ name: skills[index], score });
  }
  ranked.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ranked;
}


// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Build the real SDK client. Lazy import so the dependency is optional at rest. */
export async function createSystemOneClient(endpoint: string, model: string): Promise<SystemOneClient> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) throw new Error("TYPESAFE_API_KEY is not set");
  const sdk = (await import("@typesafe-ai/sdk")) as { TypeSafeClient: new (config: Record<string, unknown>) => SystemOneClient };
  return new sdk.TypeSafeClient({
    apiKey,
    baseURL: endpoint,
    defaultModel: model,
    logLevel: "off",
    retry: { maxRetries: 0 },
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * Synthetic round-trip that proves an endpoint speaks the systemOne dialect.
 *
 * The probe bootstraps a route: it asks for `requestedModelFor()` even when no
 * probe file exists yet, then records the model the endpoint actually answered
 * with. Identity is pinned afterwards by `expectedModelFor()`. A response whose
 * `model` differs from the requested model fails the probe and reports the
 * observed string verbatim, so the operator can set `OMP_HARNESS_JEV_MODEL`.
 */
export async function probeEndpoint(
  endpoint: string,
  deps: JudgeDeps = {},
): Promise<EndpointProbe> {
  const requested = requestedModelFor(endpoint);
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const result: EndpointProbe = { endpoint: normalizedEndpoint, ok: false, requested };
  try {
    const client = deps.client ?? (await createSystemOneClient(endpoint, requested));
    const response = (await client.systemOne(
      {
        state: { note: "synthetic probe: a mug is on the table" },
        questions: { present: { type: "noul", instructions: "Is a mug mentioned?" } },
      },
      { timeout: REQUEST_TIMEOUT_MS, retry: { maxRetries: 0 } },
    )) as { model?: unknown; answers?: Record<string, { noul?: unknown }> } | null;
    const observed = typeof response?.model === "string" ? response.model : "";
    const noul = response?.answers?.present?.noul;
    if (typeof noul !== "number") {
      if (observed.length > 0) result.model = observed;
      result.reason = "response is not a well-formed systemOne answer: answers.present.noul is not a number";
      return result;
    }
    result.model = observed;
    if (observed !== requested) {
      result.reason = `model-mismatch: expected ${requested}, observed ${observed.length > 0 ? observed : "(none)"}`;
      return result;
    }
    result.ok = true;
    result.at = new Date((deps.now ?? Date.now)()).toISOString();
    const dir = deps.probesDir ?? defaultProbesDir();
    if (dir) {
      const normalizedResult = { ...result, endpoint: normalizedEndpoint };
      writeTextFileAtomic(probeFileFor(normalizedEndpoint, dir), `${JSON.stringify(normalizedResult, null, 2)}\n`);
    }
    return result;
  } catch (err) {
    // Surface the gateway's own text: a rejected model name must be actionable.
    result.reason = err instanceof Error ? err.message : String(err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface Receipt {
  schema_version: 1;
  decision_id: string;
  timestamp: string;
  kind: DecisionKind;
  question_set_version: string;
  state_sha256: string;
  candidates_sha256: string;
  requested_model: string;
  actual_model: string;
  answers: Record<string, unknown>;
  status: DecisionStatus;
  fallback: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  applied: false;
}

function writeReceipt(cwd: string | undefined, receipt: Receipt): { ok: boolean; error?: string } {
  if (!cwd) return { ok: false, error: "no cwd" };
  try {
    const dir = path.join(cwd, ".omp", "harness");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "jev-decisions.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

function unavailable(kind: DecisionKind, questionSet: string, reason: string): DecisionAnswer {
  return { status: "unavailable", fallback: "deterministic", kind, questionSet, answers: {}, reason };
}

/**
 * One bounded judgment. Never throws: every failure path returns a
 * `unavailable`/`abstain` answer with `fallback: "deterministic"`.
 */
export async function judge(input: JudgeInput, deps: JudgeDeps = {}): Promise<DecisionAnswer> {
  const candidates = input.candidates ?? [];
  const plan = buildPlan(input.kind, candidates, input.skills);
  if (!jevEnabled()) {
    return unavailable(input.kind, plan.questionSet, "OMP_HARNESS_JEV is not 1");
  }
  const endpoint = jevEndpoint();
  const model = expectedModelFor(endpoint, process.env, deps.probesDir);
  if (!model) {
    return unavailable(
      input.kind,
      plan.questionSet,
      `no-passing-probe: ${hostOf(endpoint)} has no passing probe; run /harness-decision probe`,
    );
  }
  const stateProblem = validateState(input.state);
  if (stateProblem) return unavailable(input.kind, plan.questionSet, stateProblem);
  const candidateProblem = validateCandidates(candidates);
  if (candidateProblem) return unavailable(input.kind, plan.questionSet, candidateProblem);

  const started = (deps.now ?? Date.now)();
  let response: unknown;
  try {
    const client = deps.client ?? (await createSystemOneClient(endpoint, model));
    response = await client.systemOne(
      { state: input.state, questions: plan.questions, model },
      { timeout: REQUEST_TIMEOUT_MS, signal: input.signal, retry: { maxRetries: 0 } },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.name : "transport-error";
    return unavailable(input.kind, plan.questionSet, `transport failure: ${reason}`);
  }
  const latencyMs = (deps.now ?? Date.now)() - started;

  if (!response || typeof response !== "object") {
    return unavailable(input.kind, plan.questionSet, "response is not an object");
  }
  const payload = response as Record<string, unknown>;
  const actualModel = typeof payload.model === "string" ? payload.model : "";
  if (actualModel !== model) {
    return unavailable(
      input.kind,
      plan.questionSet,
      `model-mismatch: expected ${model}, observed ${actualModel.length > 0 ? actualModel : "(none)"}`,
    );
  }
  const answers = payload.answers;
  if (!answers || typeof answers !== "object") {
    return unavailable(input.kind, plan.questionSet, "response has no answers");
  }
  const answerMap = answers as Record<string, unknown>;
  for (const key of Object.keys(plan.questions)) {
    if (!(key in answerMap)) return unavailable(input.kind, plan.questionSet, `response is missing answer "${key}"`);
    const problem = validateAnswer(key, answerMap[key], plan);
    if (problem) return unavailable(input.kind, plan.questionSet, problem);
  }

  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const stateHash = sha256(typeof input.state === "string" ? input.state : stableStringify(input.state));
  const candidatesHash = sha256(stableStringify(candidates));
  const decisionId = sha256(`${stateHash}:${candidatesHash}:${plan.questionSet}:${started}`).slice(0, 32);

  let status: DecisionStatus = "answered";
  let reason: string | undefined;
  if (plan.choiceKey) {
    const primary = answerMap[plan.choiceKey] as { confidence?: number } | undefined;
    if (primary && isNumber(primary.confidence) && primary.confidence < MIN_CONFIDENCE) {
      status = "abstain";
      reason = `confidence ${primary.confidence.toFixed(2)} below ${MIN_CONFIDENCE}`;
    }
  }

  const receipt: Receipt = {
    schema_version: 1,
    decision_id: decisionId,
    timestamp: new Date(started).toISOString(),
    kind: input.kind,
    question_set_version: plan.questionSet,
    state_sha256: stateHash,
    candidates_sha256: candidatesHash,
    requested_model: model,
    actual_model: actualModel,
    answers: answerMap,
    status,
    fallback: status === "answered" ? "none" : "deterministic",
    latency_ms: latencyMs,
    input_tokens: isNumber(usage.input_tokens) ? usage.input_tokens : 0,
    output_tokens: isNumber(usage.output_tokens) ? usage.output_tokens : 0,
    applied: false,
  };
  writeReceipt(input.cwd, receipt);

  return {
    status,
    fallback: status === "answered" ? "none" : "deterministic",
    kind: input.kind,
    questionSet: plan.questionSet,
    answers: answerMap,
    receiptId: decisionId,
    requestedModel: model,
    actualModel,
    latencyMs,
    reason,
  };
}
