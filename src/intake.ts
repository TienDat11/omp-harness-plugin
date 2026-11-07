/**
 * intake.ts — deterministic intake classification with a shadow Jev advisory.
 *
 * WHY shadow-only: the Jev answer may shape a suggestion, never the live
 *   session. No model switch, tool activation, compaction or context write runs
 *   here, so the provider prompt cache prefix stays byte-stable.
 * WHY one request: at most one judge call per new task boundary; the library
 *   pins maxRetries: 0 and never falls back to a paid chat model.
 * WHY the 6000-char cap: judge state is bounded, the request text is cut only
 *   for classification, and receipts never carry history or credentials.
 * WHY the skill catalog is read, not rewritten: the <skills> block already lives
 *   in the system prompt, so injecting a suggestion would mutate the stable
 *   prefix. No fit is a valid result.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  expectedModelFor,
  jevEnabled,
  jevEndpoint,
  judge,
  probeEndpoint,
  rankSkillFit,
  readEndpointProbe,
  requestedModelFor,
  type JudgeDeps,
} from "./decisions.ts";
import {
  clearSessionState,
  getLastReceipt,
  isJevInputAllowed,
  noteSubmission,
  setJevInputAllowed,
  setLastReceipt,
  setSuggestion,
} from "./state.ts";

const REQUEST_CHAR_CAP = 6000;
const MAX_SKILL_CANDIDATES = 12;
const SUGGESTED_SKILLS = 3;
const PROBE_PROFILE_PREFIX = "omp-harness-probe-";
const MIN_TOKEN_LENGTH = 4;
/**
 * Technical acronyms shorter than MIN_TOKEN_LENGTH. Dropping them makes a
 * prompt like "fix sql rls policy" score zero against a skill that literally
 * names both, so they are kept as exact tokens.
 */
const DOMAIN_ACRONYMS: Record<string, true> = {
  sql: true, rls: true, aws: true, iam: true, seo: true, tdd: true, rag: true,
  mcp: true, pr: true, ui: true, ux: true, db: true, ci: true, cd: true, api: true,
  css: true, dom: true, k8s: true, vpc: true, waf: true, dns: true, tls: true,
  ssh: true, ast: true, dap: true, lsp: true, e2e: true, ssr: true, rsc: true,
  orm: true, jwt: true, npm: true, sdk: true,
};
const FILE_TOKEN = new RegExp("[A-Za-z0-9_./-]+[.][A-Za-z0-9]{1,5}", "g");

export interface SkillEntry {
  name: string;
  description: string;
}

interface SanitizedReceipt {
  status: string;
  route: string | null;
  confidence: number | null;
  receiptId: string | null;
  actualModel: string | null;
  latencyMs: number | null;
}

export function skillCandidates(systemPrompt: string, request: string, limit = MAX_SKILL_CANDIDATES): string[] {
  const catalog = parseSkillCatalog(systemPrompt);
  const requestTokens = tokenize(request);
  const scored: Array<{ name: string; score: number }> = [];
  // Technical prompts (harness/refactor/subagent/superagent/typescript/karpathy/lauren tan/egm)
  // that are not actually about ask-matt or business-flow must never surface
  // false-positive ask-matt / business-flow suggestions into stack-router.ts.
  const techRe = /\b(harness|refactor|subagent|superagent|typescript|karpathy|lauren\s+tan|egm)\b/i;
  const nonTechRe = /\b(ask\s+matt|matt|business\s+flow|business-flow|quy\s+trinh|nghiep\s+vu|qt)\b/i;
  const isTechnicalPrompt = techRe.test(request) && !nonTechRe.test(request);
  const notForRe = /\bnot\s+for\b/i;
  for (const skill of catalog) {
    // Skip skills whose description carries a "not for" exclusion.
    if (notForRe.test(skill.description ?? "")) continue;
    // Skip ask-matt / business-flow on technical prompts (false positives).
    if ((skill.name === "ask-matt" || skill.name === "business-flow") && isTechnicalPrompt) continue;
    const skillTokens = tokenize(`${skill.name} ${skill.description}`);
    let score = 0;
    for (const token of skillTokens) {
      if (requestTokens.has(token)) score += 1;
    }
    if (score >= 2) {
      scored.push({ name: skill.name, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return scored.slice(0, limit).map((entry) => entry.name);
}

export function parseSkillCatalog(systemPrompt: string): SkillEntry[] {
  const source = systemPrompt ?? "";
  const open = source.indexOf("<skills>");
  const close = source.indexOf("</skills>");
  const block = open === -1 ? source : source.slice(open + "<skills>".length, close === -1 ? undefined : close);
  const skills: SkillEntry[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("-")) continue;
    const rest = line.slice(1).trim();
    const colon = rest.indexOf(":");
    if (colon === -1) continue;
    const name = rest.slice(0, colon).trim();
    const description = rest.slice(colon + 1).trim();
    if (name) skills.push({ name, description });
  }
  return skills;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const value = (text ?? "").toLowerCase();
  let current = "";
  const flush = () => {
    if (current.length >= MIN_TOKEN_LENGTH || DOMAIN_ACRONYMS[current] === true) tokens.add(current);
    current = "";
  };
  for (const ch of value) {
    const isAlnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isAlnum) current += ch;
    else flush();
  }
  flush();
  return tokens;
}

function hasModelPin(): boolean {
  const pinCandidates = [process.env.PI_MODEL, process.env.OMP_MODEL];
  return pinCandidates.some((value) => typeof value === "string" && value.trim().length > 0);
}

function toSystemPrompt(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => String(part ?? "")).join("\n");
  return String(value ?? "");
}

/** Host only: status and probe output never echo a full URL or credentials. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export default function intake(pi: ExtensionAPI, deps: JudgeDeps = {}) {
  pi.on("input", async (event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    if (event?.source === "extension") return;
    const rawText = String(event?.text ?? "");
    if (rawText.length === 0) return;
    const skills = skillCandidates(toSystemPrompt(ctx.getSystemPrompt()), rawText, MAX_SKILL_CANDIDATES);
    if (skills.length > 0) {
      setSuggestion({
        status: "skipped",
        route: null,
        confidence: null,
        receiptId: null,
        actualModel: null,
        latencyMs: null,
        skills: skills.slice(0, SUGGESTED_SKILLS),
        skill_basis: "deterministic",
      });
    }
    if (!jevEnabled() || !isJevInputAllowed()) return;
    const text = rawText;
    if (text.startsWith("/")) return;
    if (Array.isArray(event?.images) && event.images.length > 0) return;
    const profile = process.env.OMP_PROFILE ?? "";
    if (!profile.startsWith(PROBE_PROFILE_PREFIX) && !isJevInputAllowed()) return;
    if (hasModelPin()) return;
    const submissionIndex = noteSubmission();
    if (submissionIndex > 1) return;
    const capped = text.slice(0, REQUEST_CHAR_CAP);
    const judgeState: Record<string, unknown> = {
      request: capped,
      has_images: false,
      submission_index: submissionIndex,
      profile: profile.length > 0 ? profile : "default",
      facts: {
        request_chars: capped.length,
        file_count: new Set(capped.match(FILE_TOKEN) ?? []).size,
      },
    };
    if (text.length > REQUEST_CHAR_CAP) {
      judgeState.truncated = true;
    }

    const skillQuestion = skills.length >= 2 && skills.length <= MAX_SKILL_CANDIDATES ? skills : undefined;
    const judgeArgs: Parameters<typeof judge>[0] = { kind: "intake", state: judgeState, cwd: ctx.cwd };
    if (skillQuestion) judgeArgs.skills = skillQuestion;
    const answer = await judge(judgeArgs, {});
    const answers = (answer.answers ?? {}) as unknown as Record<string, { choice?: unknown; confidence?: unknown }>;
    const route = typeof answers.route?.choice === "string" ? answers.route.choice : null;
    const confidence = typeof answers.route?.confidence === "number" ? answers.route.confidence : null;
    const receipt: SanitizedReceipt = {
      status: answer.status,
      route,
      confidence,
      receiptId: answer.receiptId ?? null,
      actualModel: answer.actualModel ?? null,
      latencyMs: answer.latencyMs ?? null,
    };
    setLastReceipt(receipt);
    const rankedSkills = skillQuestion ? rankSkillFit(answers as Record<string, unknown>, skillQuestion) : [];
    const skillBasis: "deterministic" | "jev" = answer.status === "answered" && skillQuestion ? "jev" : "deterministic";
    const suggestedSkills = answer.status === "answered" && skillQuestion ? rankedSkills.slice(0, SUGGESTED_SKILLS).map((entry) => entry.name) : skills.slice(0, SUGGESTED_SKILLS);
    setSuggestion({
      status: answer.status,
      route,
      confidence,
      receiptId: answer.receiptId ?? null,
      actualModel: answer.actualModel ?? null,
      latencyMs: answer.latencyMs ?? null,
      skills: suggestedSkills,
      skill_basis: skillBasis,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    clearSessionState();
  });

  pi.registerCommand("harness-decision", {
    description: "harness Jev intake shadow decision: status, allow-input, off, probe",
    handler: async (args, ctx) => {
      const subcommand = (args ?? "").trim().toLowerCase();
      if (subcommand === "status") {
        const endpoint = jevEndpoint();
        const host = endpointHost(endpoint);
        const expected = expectedModelFor(endpoint, process.env, deps.probesDir);
        const probe = readEndpointProbe(endpoint, deps.probesDir);
        const receipt = (getLastReceipt() ?? null) as SanitizedReceipt | null;
        ctx.ui.notify(
          [
            "harness-decision status",
            `  endpoint: ${host}`,
            `  expected-model: ${expected ?? "unresolved (run probe)"}`,
            `  probe: ${probe?.ok ? `passing ${probe.at ?? "(no timestamp)"} model=${probe.model ?? "-"}` : "none"}`,
            `  jev: ${jevEnabled() ? "on" : "off"}`,
            `  egress: ${isJevInputAllowed() ? "allowed" : "denied"}`,
            `  receipt: ${receipt ? JSON.stringify(receipt) : "none"}`,
          ].join("\n"),
          "info",
        );
        return;
      }
      if (subcommand === "probe") {
        // The probe is how the operator unlocks the route, so it is gated only
        // on credentials — never on OMP_HARNESS_JEV.
        const apiKey = process.env.TYPESAFE_API_KEY?.trim();
        if (!apiKey) {
          ctx.ui.notify(
            "harness-decision probe: TYPESAFE_API_KEY is not set; no request made",
            "error",
          );
          return;
        }
        const endpoint = jevEndpoint();
        const host = endpointHost(endpoint);
        const requested = requestedModelFor(endpoint);
        const result = await probeEndpoint(endpoint, deps);
        const lines = [
          "harness-decision probe",
          `  endpoint: ${host}`,
          `  expected-model: ${requested}`,
          `  observed-model: ${result.model && result.model.length > 0 ? result.model : "none"}`,
          `  usable: ${result.ok ? "yes" : "no"}`,
        ];
        if (!result.ok && result.reason) lines.push(`  reason: ${result.reason}`);
        ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "error");
        return;
      }
      if (subcommand === "allow-input") {
        ctx.ui.notify(`harness-decision: input egress enabled; subsequent user requests go to ${jevEndpoint()}`, "info");
        setJevInputAllowed(true);
        return;
      }
      if (subcommand === "off") {
        setJevInputAllowed(false);
        setSuggestion(null);
        ctx.ui.notify("harness-decision: automatic intake disabled", "info");
        return;
      }
      ctx.ui.notify("harness-decision: unknown subcommand; valid: status, allow-input, off, probe", "error");
    },
  });
}
