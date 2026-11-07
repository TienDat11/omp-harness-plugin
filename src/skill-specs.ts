import { createHash } from "node:crypto";

export const AUTOLOAD_THETA = 0.7;
export const AUTOLOAD_MARGIN = 0.15;
export const AUTOLOAD_HIGH_CONFIDENCE = 0.85;
export const MAX_L1_DIGEST_CHARS = 4_000;
export const HOLDOUT_RATE = 0.15;
export const MIN_SHADOW_SAMPLES = 20;
export const MAX_SUGGESTED_SKILLS = 3;
export const SCORE_DECAY = 8; // IDF units of signal that map to 63% confidence.

export type TaskCategory =
  | "frontend-ui" | "backend-api" | "database-data" | "devops-iac" | "testing-qa"
  | "security" | "debugging" | "architecture-docs" | "general";

const CATEGORY_ORDER: TaskCategory[] = [
  "frontend-ui", "backend-api", "database-data", "devops-iac", "testing-qa",
  "security", "debugging", "architecture-docs",
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "frontend-ui": ["react", "next.js", "nextjs", "css", "tailwind", "component", "frontend", "ui", "ux", "design", "layout", "responsive", "animation", "accessibility", "a11y", "dark mode"],
  "backend-api": ["api", "endpoint", "rest", "graphql", "grpc", "server", "fastapi", "express", "middleware", "webhook", "rate limit", "worker queue"],
  "database-data": ["sql", "postgres", "postgresql", "mysql", "sqlite", "rls", "migration", "schema", "index", "query plan", "orm", "prisma"],
  "devops-iac": ["docker", "kubernetes", "k8s", "terraform", "ci", "cd", "pipeline", "deploy", "github actions", "aws", "gcp", "azure", "infra"],
  "testing-qa": ["test", "tests", "unit test", "integration test", "e2e", "coverage", "vitest", "jest", "pytest", "flaky", "fuzz"],
  "security": ["security", "vulnerability", "cve", "xss", "sql injection", "csrf", "auth", "secrets", "iam", "permissions", "pentest"],
  "debugging": ["bug", "error", "crash", "stack trace", "regression", "debug", "leak", "hang", "timeout", "fails"],
  "architecture-docs": ["architecture", "design doc", "adr", "rfc", "refactor", "module boundary", "readme", "documentation"],
};

export function classifyTaskCategory(prompt: string): TaskCategory {
  const p = (prompt ?? "").toLowerCase();
  let best: { cat: TaskCategory; score: number; order: number } | null = null;
  for (let i = 0; i < CATEGORY_ORDER.length; i++) {
    const cat = CATEGORY_ORDER[i];
    const kws = CATEGORY_KEYWORDS[cat] ?? [];
    const seen = new Set<string>();
    let score = 0;
    for (const kw of kws) {
      const k = kw.toLowerCase();
      if (seen.has(k)) continue;
      if (p.includes(k)) { seen.add(k); score += 1; }
    }
    if (best === null || score > best.score) {
      best = { cat, score, order: i };
    }
  }
  if (!best || best.score === 0) return "general";
  return best.cat;
}

export function isHoldoutTurn(sessionId: string, turnIndex: number): boolean {
  const h = createHash("sha256").update(`${sessionId}::${turnIndex}`).digest();
  return h[0] / 256 < HOLDOUT_RATE;
}

export interface SkillDoc { name: string; description: string; keywords: string[]; notFor: string[]; notForUnless?: string[] }

export interface Candidate { name: string; score: number; margin: number; reason: string }

/**
 * Prose words that carry no routing signal. Without this filter every skill
 * description matches on "the"/"and"/"for", which drowns the real domain terms
 * and makes ranking pure noise.
 */
const STOPWORDS: Record<string, true> = {
  the: true, and: true, for: true, when: true, with: true, this: true, that: true,
  from: true, into: true, your: true, you: true, are: true, use: true, uses: true,
  using: true, can: true, will: true, must: true, should: true, any: true, all: true,
  not: true, but: true, its: true, has: true, have: true, was: true, were: true,
  they: true, them: true, their: true, than: true, then: true, there: true, here: true,
  about: true, before: true, after: true, also: true, more: true, most: true, only: true,
  such: true, some: true, each: true, every: true, which: true, while: true, what: true,
  who: true, how: true, why: true, does: true, doing: true, done: true, make: true,
  makes: true, need: true, needs: true, want: true, wants: true, like: true, just: true,
  get: true, gets: true, out: true, off: true, over: true, under: true, again: true,
  skill: true, skills: true, load: true, loadm: true, anything: true, something: true,
  anywhere: true, include: true, includes: true, including: true, instead: true,
  other: true, others: true, same: true, very: true, being: true, between: true,
  // Generic action verbs: they describe what the user does, not what domain the
  // work lives in, and they appear in a third of all skill descriptions.
  fix: true, fixes: true, fixing: true, add: true, adds: true, adding: true,
  write: true, writes: true, writing: true, wrote: true, update: true, updates: true,
  remove: true, removes: true, change: true, changes: true, please: true, help: true,
  making: true,
  repo: true, repos: true, project: true, projects: true, code: true, codebase: true,
};

/** Short technical tokens that DO route even though they are three characters or fewer. */
const SHORT_SIGNAL: Record<string, true> = {
  sql: true, rls: true, api: true, ui: true, ux: true, css: true, db: true, ci: true,
  cd: true, aws: true, iam: true, seo: true, tdd: true, rag: true, mcp: true, k8s: true,
  vpc: true, waf: true, dns: true, tls: true, ssh: true, ast: true, lsp: true, e2e: true,
  orm: true, jwt: true, npm: true, sdk: true, pr: true, xss: true, csrf: true,
  qt: true, ba: true, x: true,
};

/** Crude English stem: enough to unify migrations/migration, policies/policy, running/runs. */
function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  return w;
}

/**
 * Strip Vietnamese diacritics so "nghiệp vụ" and "nghiep vu" tokenize the same.
 * Lowercases first so the uppercase Đ folds to d too.
 */
export function foldVietnamese(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

/**
 * Folded Vietnamese phrases mapped to the English words skill descriptions use.
 * Each key must already be diacritic-free (see foldVietnamese).
 */
export const VI_EN_TERMS: Record<string, string> = {
  "quy trinh": "business process flow",
  "nghiep vu": "business process",
  "kich ban": "test case scenario",
  "kich ban kiem thu": "test scenarios qa testing",
  "kich ban test": "test scenarios qa testing",
  "kiem thu qa": "qa testing test",
  "kiem thu phan quyen": "rbac authorization security test",
  "phieu yeu cau": "requirement request",
  "yeu cau": "requirement",
  "dac ta": "spec specification",
  "kiem thu": "testing test qa",
  "phan quyen": "rbac permission authorization",
  "bao mat": "security",
  "lo hong": "vulnerability security",
  "boc tach": "reverse blueprint",
  "ma nguon mo": "open source oss",
  "mo ta hien trang": "as-is",
  "tieu chi nghiem thu": "acceptance criteria",
  "nhat ky": "audit",
  "thong bao": "notification",
  "giao dien": "frontend ui",
  "co so du lieu": "database",
  "trieu chung": "debugging",
  "nang cap": "upgrade refactor simplicity overcomplication karpathy",
  "coi con gi nang cap": "upgrade refactor simplicity overcomplication karpathy",
  "lauren tan": "lauren tan egm goldfish interrogate karpathy",
  "andrej karparthy": "andrej karpathy surgical simplicity overcomplication",
  "andrej karpathy": "andrej karpathy surgical simplicity overcomplication",
  "review skills": "skill routing skill eval trigger eval skill upgrade",
  "toi uu": "optimize refactor simplicity minimal",
  "don gian": "simplicity minimal surgical karpathy",
  "toi gian": "minimal simplicity karpathy",
  "tai cau truc": "refactor",
};

export const VN_ALIASES: Record<string, string> = VI_EN_TERMS;

export interface SkillOverride {
  name: string;
  description?: string;
  triggers: string[];
  notFor?: string[];
  notForUnless?: string[];
}

// One shared harness-prompt veto, spread into the business-routing overrides
// so the notFor/notForUnless lists are defined once (N3) and never drift.
const HARNESS_PROMPT_VETO = {
  notFor: [
    "harness", "code", "refactor", "subagent", "superagent", "typescript",
    "upgrade", "nang cap", "karpathy", "lauren",
  ],
  notForUnless: [
    "qt", "quy trinh", "nghiep vu", "business flow", "business process",
    "test matrix", "kiem thu nghiep vu", "brse", "raci",
  ],
};

/**
 * Per-skill routing overrides (Garry Tan skill resolver): explicit trigger
 * terms that extend a skill's keyword vocabulary, plus `notFor` vetoes gated
 * by `notForUnless` exceptions. Applied at parse time by applySkillOverride so
 * Stage-1 MiniSearch indexes the trigger terms through the skill description.
 */
export const SKILL_OVERRIDES: Readonly<Record<string, SkillOverride>> = {
  "karpathy-guidelines": {
    name: "karpathy-guidelines",
    triggers: [
      "karpathy", "andrej", "lauren", "surgical", "overcomplication",
      "simplicity", "refactor", "bloat", "minimal", "upgrade",
    ],
    notFor: ["pure q&a", "pure question", "explain only"],
  },
  "egm-review-loop": {
    name: "egm-review-loop",
    triggers: [
      "egm", "goldfish", "elephant", "lauren", "tan", "interrogate",
      "review loop", "plan review", "spec review",
    ],
    notFor: ["trivial typo fix", "typo fix"],
  },
  "omp-superagent": {
    name: "omp-superagent",
    triggers: ["superagent", "subagent", "router", "worker", "watchdog", "parallel wave", "delegation"],
    notFor: ["single-line question", "single question"],
  },
  "omp-harness": {
    name: "omp-harness",
    triggers: ["harness", "omp-harness", "prompt cache", "verify-gate", "read-budget", "telemetry", "skill router"],
    notFor: ["unrelated app code", "unrelated app"],
  },
  "skill-creator": {
    name: "skill-creator",
    triggers: ["review skills", "skill routing", "skill eval", "trigger eval", "skill description", "create skill"],
    notFor: [],
  },
  "skill-upgrade": {
    name: "skill-upgrade",
    triggers: [
      "review skills", "skill routing", "skill eval", "trigger eval",
      "skill description", "upgrade skill", "nang cap", "lauren tan", "karpathy",
    ],
    notFor: [],
  },
  "ask-matt": {
    name: "ask-matt",
    triggers: ["matt"],
    notFor: [
      "harness", "code", "refactor", "subagent", "technical architecture",
      "typescript", "upgrade", "nang cap", "karpathy", "lauren",
    ],
    notForUnless: ["ask matt", "matt advised", "matt advice"],
  },
  "business-flow": {
    name: "business-flow",
    triggers: ["business", "flow", "process", "qt"],
    notFor: [
      "harness", "code", "refactor", "subagent", "technical architecture",
      "typescript", "upgrade", "nang cap", "karpathy", "lauren",
    ],
    notForUnless: ["qt", "quy trinh", "nghiep vu", "business flow", "business process"],
  },
  "business-flow-qa": {
    name: "business-flow-qa",
    triggers: ["business-flow-qa", "kiem thu nghiep vu", "test matrix", "verify test"],
    ...HARNESS_PROMPT_VETO,
  },
  "brse-workflow": {
    name: "brse-workflow",
    triggers: ["brse-workflow", "brse", "raci", "as-is", "to-be", "use case", "yeu cau", "dac ta"],
    ...HARNESS_PROMPT_VETO,
  },
  "harness-loop": {
    name: "harness-loop",
    triggers: ["harness-loop", "outcome", "mine", "telemetry", "self-improving", "rejected edits"],
    notFor: [],
  },
  "ponytail": {
    name: "ponytail",
    triggers: ["ponytail", "minimal", "surgical", "bloat"],
    notFor: [],
  },
};

export function isSkillVetoed(doc: Pick<SkillDoc, "notFor" | "notForUnless">, prompt: string): boolean {
  const p = prompt.toLowerCase();
  const folded = foldVietnamese(prompt).toLowerCase();
  const unless = doc.notForUnless ?? [];
  for (const u of unless) {
    if (!u) continue;
    if (p.includes(u.toLowerCase()) || folded.includes(foldVietnamese(u).toLowerCase())) return false;
  }
  const notFor = doc.notFor ?? [];
  for (const nf of notFor) {
    if (!nf) continue;
    if (p.includes(nf.toLowerCase()) || folded.includes(foldVietnamese(nf).toLowerCase())) return true;
  }
  return false;
}

export function applySkillOverride(doc: SkillDoc): SkillDoc {
  const ov = SKILL_OVERRIDES[doc.name];
  if (!ov) return doc;

  const seen = new Set<string>(doc.keywords);
  const addKw = (raw: string): void => {
    const clean = String(raw).toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    doc.keywords.push(clean);
  };
  // Trigger tokens bypass STOPWORDS and the 40-keyword cap: both the raw
  // token and its stemmed form merge into the skill vocabulary.
  for (const trigger of ov.triggers) {
    for (const raw of trigger.match(/[a-z][a-z0-9]*/g) ?? []) {
      addKw(raw);
      addKw(stem(raw));
    }
  }

  const appended = ov.triggers.join(" ");
  if (!doc.description.includes(appended)) {
    doc.description = doc.description ? `${doc.description} ${appended}` : appended;
  }

  for (const nf of ov.notFor ?? []) {
    if (nf && !doc.notFor.includes(nf)) doc.notFor.push(nf);
  }
  if (!doc.notForUnless) doc.notForUnless = [];
  for (const u of ov.notForUnless ?? []) {
    if (u && !doc.notForUnless.includes(u)) doc.notForUnless.push(u);
  }

  return doc;
}

function tokenizeWords(text: string): Set<string> {
  const out = new Set<string>();
  const folded = foldVietnamese((text ?? "").toLowerCase());
  for (const raw of folded.match(/[a-z][a-z0-9]*/g) ?? []) {
    if (raw.length < 3 && SHORT_SIGNAL[raw] !== true) continue;
    out.add(raw);
  }
  // Vietnamese request terms map onto the English vocabulary skills carry.
  const padded = ` ${folded.replace(/[^a-z0-9]+/g, " ").trim()} `;
  for (const [vi, en] of Object.entries(VI_EN_TERMS)) {
    if (padded.includes(` ${vi} `)) for (const w of en.split(" ")) out.add(w);
  }
  return out;
}

export function scoreSkillDocs(
  docs: SkillDoc[],
  prompt: string,
  opts?: { stackSkills?: string[]; suggestionSkills?: string[]; lift?: Record<string, number> },
): Candidate[] {
  const p = (prompt ?? "").toLowerCase();
  const promptWords = tokenizeWords(p);
  const stack = new Set(opts?.stackSkills ?? []);
  const suggest = new Set(opts?.suggestionSkills ?? []);
  const lift = opts?.lift ?? {};

  // Inverse document frequency over the installed catalog. A word every skill
  // description mentions ("security", "code", "test") barely discriminates; a
  // word two skills mention ("rls", "terraform") is a strong signal.
  const docCount = docs?.length ?? 0;
  const df = new Map<string, number>();
  for (const doc of docs ?? []) {
    const seenInDoc = new Set<string>();
    for (const kw of doc.keywords ?? []) {
      const key = stem(String(kw).toLowerCase());
      if (seenInDoc.has(key)) continue;
      seenInDoc.add(key);
      df.set(key, (df.get(key) ?? 0) + 1);
    }
  }
  // Document frequency is keyed by stem so that a request saying "policy"
  // still matches a catalog entry written as "policies".
  const idf = (word: string): number => Math.log(1 + docCount / (1 + (df.get(stem(word)) ?? 1)));

  // Score = IDF-weighted sum of the request terms this skill's vocabulary
  // explains, squashed into 0..1. Coverage (covered ÷ total) was tried and
  // dropped: it punishes the right skill for request words it legitimately does
  // not own ("build", "image" in a docker request), so a strong match scored
  // 0.53. A sum needs no denominator and is dominated by distinctive hits,
  // because a term every description mentions carries almost no weight.
  const requestTerms = [...promptWords]
    .filter((word) => STOPWORDS[word] !== true)
    .filter((word) => df.has(stem(word)))
    .map((word) => ({ word, weight: idf(word) }));

  const raw: Array<{ doc: SkillDoc; rawScore: number; hitKws: string[]; stackBonus: boolean; suggestBonus: boolean; liftVal: number }> = [];

  for (const doc of docs ?? []) {
    if (isSkillVetoed(doc, p)) continue;

    // A term the skill's own name carries is a direct self-description and
    // counts double against an incidental mention in the prose.
    const nameWords = new Set((doc.name.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).map(stem));
    const docStems = new Set<string>();
    for (const kw of doc.keywords ?? []) {
      docStems.add(stem(String(kw).toLowerCase()));
      docStems.add(String(kw).toLowerCase());
    }
    const hitKws: string[] = [];
    let kwScore = 0;
    for (const term of requestTerms) {
      if (!docStems.has(term.word) && !docStems.has(stem(term.word))) continue;
      hitKws.push(term.word);
      kwScore += term.weight * (nameWords.has(stem(term.word)) ? 2 : 1);
    }
    const stackBonus = stack.has(doc.name);
    const suggestBonus = suggest.has(doc.name);
    const liftVal = lift[doc.name] ?? 0;
    raw.push({ doc, rawScore: kwScore, hitKws, stackBonus, suggestBonus, liftVal });
  }

  raw.sort((a, b) => {
    if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
    return a.doc.name.localeCompare(b.doc.name);
  });

  const normalized = raw.map((r) => {
    const curved = 1 - Math.exp(-r.rawScore / SCORE_DECAY);
    let score = curved;
    if (r.stackBonus) score += 0.05;
    if (r.suggestBonus) score += 0.08;
    const liftClamped = Math.max(-0.10, Math.min(0.10, r.liftVal));
    score += liftClamped;
    score = Math.max(0, Math.min(1, score));
    return { r, score };
  });
  // Re-sort by FINAL score (after bonuses/curve/lift) so margin is measured against
  // the true runner-up, not the pre-bonus rawScore ordering.
  normalized.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.r.doc.name.localeCompare(b.r.doc.name);
  });

  const result: Candidate[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const { r, score } = normalized[i];
    const next = normalized[i + 1];
    const margin = next ? score - next.score : score;
    const segments: string[] = [];
    if (r.hitKws.length > 0) {
      segments.push(`kw:${r.hitKws.join(",")}(${r.hitKws.length.toFixed(1)})`);
    } else {
      segments.push(`kw:(+0.0)`);
    }
    if (r.stackBonus) segments.push("stack(+0.05)");
    if (r.suggestBonus) segments.push("suggest(+0.08)");
    if (r.liftVal !== 0) segments.push(`lift(${r.liftVal >= 0 ? "+" : ""}${r.liftVal.toFixed(2)})`);
    const reason = segments.join(" ");
    result.push({ name: r.doc.name, score, margin, reason });
  }
  return result;
}

export function parseSkillDoc(markdown: string, fallbackName: string): SkillDoc | null {
  const md = markdown ?? "";
  let name = "";
  let description = "";

  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const nameM = fm.match(/^name:\s*(.+)$/m);
    const descM = fm.match(/^description:\s*(.+)$/m);
    if (nameM) name = nameM[1].trim().replace(/^["']|["']$/g, "");
    if (descM) description = descM[1].trim().replace(/^["']|["']$/g, "");
  } else {
    const headingM = md.match(/^#\s+(.+)$/m);
    if (headingM) name = headingM[1].trim();
    const lines = md.split(/\n/);
    let para: string[] = [];
    let started = false;
    for (const line of lines) {
      if (line.trim() === "") {
        if (started && para.length) break;
        continue;
      }
      if (line.trim().startsWith("#")) {
        if (started && para.length) break;
        continue;
      }
      started = true;
      para.push(line.trim());
    }
    description = para.join(" ").trim();
  }

  if (!name && fallbackName) name = fallbackName;

  const notFor: string[] = [];
  const nfRe = /not for\s*[:\-]?\s*(.+?)(?:[.;\n]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = nfRe.exec(description)) !== null) {
    const val = m[1].trim();
    if (val) notFor.push(val);
  }

  const combined = `${name} ${description}`;
  // Split on every non-alphanumeric so `supabase-postgres-best-practices`
  // contributes `postgres` rather than one unusable fused token.
  const words = combined.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
  const kwSet = new Set<string>();
  const keywords: string[] = [];
  const addWord = (raw: string): void => {
    const clean = raw.replace(/[^a-z0-9]/g, "");
    if (clean.length < 3 && SHORT_SIGNAL[clean] !== true) return;
    if (STOPWORDS[clean] === true) return;
    if (kwSet.has(clean)) return;
    kwSet.add(clean);
    keywords.push(clean);
  };
  // The name is the strongest signal, so its tokens go in first.
  for (const w of name.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []) addWord(w);
  for (const w of words) {
    if (keywords.length >= 40) break;
    addWord(w);
  }

  if (!name.trim() && !description.trim()) return null;
  const doc: SkillDoc = {
    name: name.trim(),
    description: description.trim(),
    keywords,
    notFor,
  };
  return applySkillOverride(doc);
}

export function digestSkillDoc(doc: SkillDoc, body: string): string {
  const b = body ?? "";
  const lines = b.split(/\n/);
  const preferred: string[] = [];
  const keywordLines: string[] = [];
  const antiWords = /\b(must|never|always|avoid|prefer|do not|why)\b/i;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(?:[-*]|\d+\.)\s/.test(t)) {
      preferred.push(t.replace(/^(?:[-*]|\d+\.)\s*/, "- "));
    } else if (antiWords.test(t)) {
      keywordLines.push(`- ${t}`);
    }
  }
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const bl of [...preferred, ...keywordLines]) {
    if (seen.has(bl)) continue;
    seen.add(bl);
    bullets.push(bl);
    if (bullets.length >= 18) break;
  }
  if (bullets.length === 0) {
    // A short skill with no list markup is already a digest in its entirety:
    // autoloading the body costs the same as autoloading a summary of it.
    const whole = b.replace(/\r\n/g, "\n").trim();
    if (whole.length > 0 && whole.length <= MAX_L1_DIGEST_CHARS) return whole;
    return "";
  }

  const name = doc.name;
  const desc = doc.description ?? "";
  const rules = bullets.slice(0, 12);
  const anti = bullets.filter((x) => /\b(never|avoid|do not|don't)\b/i.test(x)).slice(0, 6);

  const out: string[] = [];
  out.push(`# ${name}`);
  out.push(`Use when: ${desc}`);
  out.push("Rules:");
  for (const r of rules) out.push(r);
  out.push("Anti-patterns:");
  for (const a of anti) out.push(a);

  let text = out.join("\n");
  if (text.length <= MAX_L1_DIGEST_CHARS) return text;
  const arr = out.slice();
  let cut = false;
  while (arr.length > 1 && arr.join("\n").length > MAX_L1_DIGEST_CHARS) {
    arr.pop();
    cut = true;
  }
  text = arr.join("\n");
  if (cut && text.length + 2 <= MAX_L1_DIGEST_CHARS) text = text + "\n…";
  if (text.length > MAX_L1_DIGEST_CHARS) {
    text = text.slice(0, MAX_L1_DIGEST_CHARS);
  }
  return text;
}

export function pinnedDigest(
  entry: { l1Digest?: string; realpath?: string },
  actualSha256: string,
  pinnedSha256?: string,
  recomputedDigest?: string,
  actualRealpath?: string,
): string | null {
  const d = entry?.l1Digest;
  if (!d || d.trim() === "") return null;
  if (d.length > MAX_L1_DIGEST_CHARS) return null;
  if (pinnedSha256 === undefined || pinnedSha256 === "") return null;
  if (pinnedSha256 !== actualSha256) return null;
  if (recomputedDigest !== undefined) {
    if (recomputedDigest.length === 0 || recomputedDigest !== entry.l1Digest) return null;
  }
  if (entry.realpath && actualRealpath && entry.realpath !== actualRealpath) return null;
  return d;
}

export interface ValveDecision {
  valveOpen: boolean;
  mode: "l1_autoload" | "pointer_only" | "holdout_control";
  skill: string | null;
  pointer: string;
  reason: string;
  /** Optional runner-up skill that is also high-confidence and pinned, to be loaded alongside the primary skill. */
  secondarySkills?: Array<{ name: string; digest: string }>;
}

export function decideValve(
  candidates: Candidate[],
  opts: {
    allowlist: Record<string, { l1Digest?: string; realpath?: string }>;
    actualSha256: Record<string, string>;
    pinnedSha256?: Record<string, string>;
    recomputedDigests?: Record<string, string>;
    actualRealpaths?: Record<string, string>;
    holdout: boolean;
    alreadyInjected: string[];
  },
): ValveDecision {
  const injected = new Set(opts?.alreadyInjected ?? []);
  const allowlist = opts?.allowlist ?? {};
  const actual = opts?.actualSha256 ?? {};
  const pinned = opts?.pinnedSha256 ?? {};

  if (!candidates || candidates.length === 0) {
    return { valveOpen: false, mode: "pointer_only", skill: null, pointer: "", reason: "no-candidate" };
  }

  let selected: Candidate | null = null;
  for (const c of candidates) {
    if (!injected.has(c.name)) { selected = c; break; }
  }
  if (!selected) {
    const name = candidates[0].name;
    return { valveOpen: false, mode: "pointer_only", skill: name, pointer: `skill://${name}`, reason: "already-injected" };
  }
  const top = selected;
  const topName = top.name;

  if (top.score < AUTOLOAD_THETA) {
    return { valveOpen: false, mode: "pointer_only", skill: topName, pointer: `skill://${topName}`, reason: "below-theta" };
  }
  if (top.score < AUTOLOAD_HIGH_CONFIDENCE && top.margin < AUTOLOAD_MARGIN) {
    return { valveOpen: false, mode: "pointer_only", skill: topName, pointer: `skill://${topName}`, reason: "thin-margin" };
  }
  const entry = allowlist[topName];
  const actualSha = actual[topName];
  const pinnedSha = pinned[topName];
  const recomputed = opts.recomputedDigests?.[topName];
  const actualReal = opts.actualRealpaths?.[topName];
  const pd = pinnedDigest(entry ?? {}, actualSha ?? "", pinnedSha, recomputed, actualReal);
  if (pd === null) {
    let reason = "not-allowlisted";
    if (opts.recomputedDigests && pinnedSha === actualSha && recomputed !== undefined && recomputed !== entry?.l1Digest) {
      reason = "digest-mismatch";
    } else if (entry) {
      if (pinnedSha !== undefined && pinnedSha !== actualSha) reason = "sha-mismatch";
      else if (!entry.l1Digest || entry.l1Digest.trim() === "" || entry.l1Digest.length > MAX_L1_DIGEST_CHARS) reason = "no-l1-digest";
      else reason = "not-allowlisted";
    }
    return { valveOpen: false, mode: "pointer_only", skill: topName, pointer: `skill://${topName}`, reason };
  }
  if (opts.holdout) {
    return { valveOpen: false, mode: "holdout_control", skill: topName, pointer: `skill://${topName}`, reason: "holdout" };
  }
  const secondarySkills: Array<{ name: string; digest: string }> = [];
  for (const c of candidates) {
    if (c.name === topName) continue;
    if (injected.has(c.name)) continue;
    if (c.score < AUTOLOAD_HIGH_CONFIDENCE) continue;
    const secEntry = allowlist[c.name];
    const secActual = actual[c.name];
    const secPinned = pinned[c.name];
    const secPd = pinnedDigest(secEntry ?? {}, secActual ?? "", secPinned, opts.recomputedDigests?.[c.name], opts.actualRealpaths?.[c.name]);
    if (secPd === null) continue;
    secondarySkills.push({ name: c.name, digest: secPd });
    break; // at most one secondary pinned skill
  }
  return { valveOpen: true, mode: "l1_autoload", skill: topName, pointer: `skill://${topName}`, reason: "autoload", ...(secondarySkills.length > 0 ? { secondarySkills } : {}) };
}
