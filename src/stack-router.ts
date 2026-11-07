/**
 * stack-router.ts — detect the repo stack once per session and name the few
 * domain skills that apply, in one cache-safe custom message.
 *
 * WHY: the skills catalog in the system prompt is alphabetical and static, so
 *   which domain skill fits *this* repo is left to model guesswork. Detecting
 *   the stack from marker files and naming the applicable skills in a single
 *   custom message keeps the provider prompt cache prefix byte-stable (no
 *   systemPrompt override, no tool activation).
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Dirent } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import MiniSearch from "minisearch";
import { getSuggestion, globalHarnessLogPath, logHarnessCode, resolveAgentDir, resolveUserHarnessDir, summarizeHarnessLog, writeTextFileAtomic } from "./state.ts";
import { tokenizeForFts } from "./zeromem.ts";
import {
  AUTOLOAD_THETA,
  classifyTaskCategory,
  decideValve,
  digestSkillDoc,
  extractUserPrompt,
  foldVietnamese,
  isHoldoutTurn,
  parseSkillDoc,
  scoreSkillDocs,
  type Candidate,
  type SkillDoc,
  type ValveDecision,
} from "./skill-specs.ts";
import { SkillTelemetryStore, computeReward, isHardRevert, type SkillRunRecord } from "./skill-telemetry.ts";
import { classifyVerifyCommand, isMutatingTaskCall } from "./verify-gate.ts";

export interface StackInput {
  /** Raw package.json text, when present. */
  packageJson?: string;
  /** Raw pyproject.toml or requirements.txt text. */
  pythonDeps?: string;
  goMod?: string;
  cargoToml?: string;
  /** Marker paths that exist, POSIX-relative, e.g. ["Dockerfile", "infra/main.tf"]. */
  markers: string[];
}

export interface StackFingerprint {
  /** e.g. ["typescript", "python", "go", "rust"] */
  languages: string[];
  /** e.g. ["react", "next", "fastapi", "react-native"] */
  frameworks: string[];
  /** e.g. ["docker", "terraform", "postgres"] */
  tooling: string[];
  /** Installed skill names that apply, filtered by `installed`. */
  skills: string[];
}

function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

export function detectStack(input: StackInput): Omit<StackFingerprint, "skills"> {
  const languages: string[] = [];
  const frameworks: string[] = [];
  const tooling: string[] = [];

  const packageJson = input?.packageJson ?? "";
  if (packageJson.length > 0) {
    if (packageJson.includes('"react"')) pushUnique(frameworks, "react");
    if (packageJson.includes('"next"')) pushUnique(frameworks, "next");
    if (packageJson.includes('"vue"')) pushUnique(frameworks, "vue");
    if (packageJson.includes('"svelte"')) pushUnique(frameworks, "svelte");
    if (packageJson.includes('"react-native"') || packageJson.includes('"expo"')) pushUnique(frameworks, "react-native");
    if (packageJson.includes('"express"') || packageJson.includes('"fastify"') || packageJson.includes('"hono"')) pushUnique(frameworks, "node-api");
    if (packageJson.includes('"prisma"') || packageJson.includes('"drizzle-orm"') || packageJson.includes('"typeorm"')) pushUnique(frameworks, "orm");
    const hasTS = (input?.markers ?? []).some((m) => m === "tsconfig.json" || m.endsWith("/tsconfig.json") || m.endsWith(".ts") || m.endsWith(".tsx")) || packageJson.includes('"typescript"') || packageJson.includes('"@types/') || packageJson.includes('"tsx"') || /\.tsx?["']/.test(packageJson);
    if (hasTS) pushUnique(languages, "typescript");
    else pushUnique(languages, "javascript");
  }

  const pythonDeps = input?.pythonDeps ?? "";
  if (pythonDeps.trim().length > 0) {
    pushUnique(languages, "python");
    if (pythonDeps.includes("fastapi")) pushUnique(frameworks, "fastapi");
    if (pythonDeps.includes("django")) pushUnique(frameworks, "django");
    if (pythonDeps.includes("sqlalchemy")) pushUnique(frameworks, "orm");
  }

  const goMod = input?.goMod ?? "";
  if (goMod.trim().length > 0) pushUnique(languages, "go");

  const cargoToml = input?.cargoToml ?? "";
  if (cargoToml.trim().length > 0) pushUnique(languages, "rust");

  const markers = input?.markers ?? [];
  for (const marker of markers) {
    if (marker.endsWith("Dockerfile")) pushUnique(tooling, "docker");
    if (marker.endsWith(".tf")) pushUnique(tooling, "terraform");
    if (marker.includes("k8s/") || marker.includes("helm/") || marker.includes(".kube/") || marker.includes("deployment.yaml")) pushUnique(tooling, "kubernetes");
    if (marker.endsWith(".sql")) pushUnique(tooling, "postgres");
    if (marker.includes(".github/workflows/")) pushUnique(tooling, "ci");
  }

  return { languages, frameworks, tooling };
}

export function recommendSkills(fp: Omit<StackFingerprint, "skills">, installed: ReadonlySet<string>): string[] {
  const skills = new Set<string>();
  const add = (names: string[]) => {
    for (const name of names) skills.add(name);
  };

  const frameworks = fp.frameworks ?? [];
  const languages = fp.languages ?? [];
  const tooling = fp.tooling ?? [];

  if (frameworks.includes("react") || frameworks.includes("next")) {
    add(["impeccable", "design-taste-frontend", "ui-ux-pro-max", "vercel-react-best-practices", "accessibility"]);
  }
  if (frameworks.includes("vue") || frameworks.includes("svelte")) {
    add(["impeccable", "design-taste-frontend", "ui-ux-pro-max"]);
  }
  if (frameworks.includes("react-native")) {
    add(["react-native-best-practices", "impeccable"]);
  }
  if (frameworks.includes("node-api") || frameworks.includes("fastapi") || frameworks.includes("django")) {
    add(["api-and-interface-design", "senior-backend"]);
  }
  if (languages.includes("typescript") || languages.includes("javascript")) {
    add(["typescript-pro"]);
  }
  if (languages.includes("python")) {
    add(["python-pro"]);
  }
  if (languages.includes("go") || languages.includes("rust")) {
    add(["senior-backend"]);
  }
  if (frameworks.includes("orm") || tooling.includes("postgres")) {
    add(["supabase-postgres-best-practices", "senior-data-engineer"]);
  }
  if (tooling.includes("docker") || tooling.includes("kubernetes")) {
    add(["devops-engineer"]);
  }
  if (tooling.includes("terraform")) {
    add(["terraform-style-guide", "devops-engineer"]);
  }
  if (tooling.includes("ci")) {
    add(["ci-cd-and-automation"]);
  }

  const result: string[] = [];
  for (const name of skills) {
    if (installed.has(name)) result.push(name);
  }
  result.sort();
  return result;
}

function collectMarkers(cwd: string): string[] {
  const out: string[] = [];
  const skip = ["node_modules", ".git", "dist", "build", ".next", "target", "vendor"];
  // Bounded because this runs synchronously on session_start: a monorepo must
  // not stall the first prompt just to discover a Dockerfile.
  let budget = 4000;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 5 || budget <= 0) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.includes(entry.name)) continue;
      if (budget <= 0) return;
      budget -= 1;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${relPath}/`);
        walk(path.join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk(cwd, "", 0);
  return out.map((p) => p.split(path.sep).join("/"));
}

/**
 * Read a marker file, but never more than `MAX_MARKER_BYTES`. Dependency
 * manifests are occasionally enormous (generated lockfile-style `go.mod`,
 * vendored `requirements.txt`); slurping one would stall `session_start`.
 */
const MAX_MARKER_BYTES = 64 * 1024;

function readFileSafe(filePath: string): string {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return "";
    const length = Math.min(stat.size, MAX_MARKER_BYTES);
    if (length === 0) return "";
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function fingerprintProject(cwd: string, installed: ReadonlySet<string>): StackFingerprint {
  const resolved = path.resolve(cwd);
  const packageJson = readFileSafe(path.join(resolved, "package.json"));
  let pythonDeps = "";
  const pyproject = path.join(resolved, "pyproject.toml");
  const requirements = path.join(resolved, "requirements.txt");
  if (existsSync(pyproject)) pythonDeps += readFileSafe(pyproject);
  if (existsSync(requirements)) pythonDeps += "\n" + readFileSafe(requirements);
  const goMod = readFileSafe(path.join(resolved, "go.mod"));
  const cargoToml = readFileSafe(path.join(resolved, "Cargo.toml"));
  const markers = collectMarkers(resolved);
  const base = detectStack({ packageJson, pythonDeps, goMod, cargoToml, markers });
  const skills = recommendSkills(base, installed);
  return { ...base, skills };
}

const fingerprints = new Map<string, StackFingerprint>();
const injectedSessions = new Set<string>();

export function installedSkillsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".omp", "agent", "skills");
}

export function installedSkillDirs(homeDir = os.homedir()): string[] {
  if (homeDir !== os.homedir()) {
    const roots: string[] = [
      path.join(homeDir, ".omp", "agent", "skills"),
      path.join(homeDir, ".omp", "plugins", "node_modules", "@local", "omp-adaptive-harness", "skills"),
    ];
    const cachePluginsDir = path.join(homeDir, ".omp", "plugins", "cache", "plugins");
    if (existsSync(cachePluginsDir)) {
      for (const entry of [...readdirSync(cachePluginsDir)].sort()) {
        roots.push(path.join(cachePluginsDir, entry, "skills"));
      }
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const root of roots) {
      if (existsSync(root) && !seen.has(root)) {
        seen.add(root);
        out.push(root);
      }
    }
    return out;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of installedSkillEntries()) {
    const dir = path.dirname(path.dirname(entry.file));
    if (!seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}

export type SkillOrigin = "user-global" | "bundle" | "plugin-cache" | "repo-local";

export interface InstalledSkillEntry { name: string; file: string; origin: SkillOrigin; realpath: string; }

function sortedSkillDirs(homeDir = os.homedir()): Array<{ dir: string; origin: SkillOrigin }> {
  const out: Array<{ dir: string; origin: SkillOrigin }> = [];
  const push = (dir: string, origin: SkillOrigin) => { if (dir && existsSync(dir)) out.push({ dir, origin }); };
  const agentDir = resolveAgentDir();
  push(agentDir ? path.join(agentDir, "skills") : path.join(homeDir, ".omp", "agent", "skills"), "user-global");
  push(path.join(homeDir, ".omp", "plugins", "node_modules", "@local", "omp-adaptive-harness", "skills"), "bundle");
  const cachePluginsDir = path.join(homeDir, ".omp", "plugins", "cache", "plugins");
  if (existsSync(cachePluginsDir)) {
    for (const entry of [...readdirSync(cachePluginsDir)].sort()) {
      push(path.join(cachePluginsDir, entry, "skills"), "plugin-cache");
    }
  }
  return out;
}

// ponytail: HARNESS_ROOT bundle skills dir is the harness checkout root (src/..); add when bundle ships outside checkout.
const HARNESS_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

export function installedSkillEntries(skillsDir?: string | string[], cwd?: string): InstalledSkillEntry[] {
  const map = new Map<string, InstalledSkillEntry>();
  const addDir = (dir: string, origin: SkillOrigin) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (map.has(entry.name)) continue;
      const file = path.join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      let realpath = file;
      try { realpath = realpathSync(file); } catch { realpath = file; }
      map.set(entry.name, { name: entry.name, file, origin, realpath });
    }
  };
  if (skillsDir !== undefined) {
    const dirs = typeof skillsDir === "string" ? [skillsDir] : skillsDir;
    for (const dir of dirs) addDir(dir, "user-global");
    return [...map.values()];
  }
  for (const { dir, origin } of sortedSkillDirs()) addDir(dir, origin);
  const bundleDir = path.join(HARNESS_ROOT, "skills");
  if (existsSync(bundleDir) && !map.has("__bundle__")) {
    let entries: Dirent[];
    try { entries = readdirSync(bundleDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || map.has(entry.name)) continue;
      const file = path.join(bundleDir, entry.name, "SKILL.md");
      if (existsSync(file)) map.set(entry.name, { name: entry.name, file, origin: "bundle", realpath: file });
    }
  }
  if (cwd && process.env.OMP_HARNESS_REPO_SKILLS === "1") {
    addDir(path.join(path.resolve(cwd), ".omp", "skills"), "repo-local");
  }
  return [...map.values()];
}

export const ALL_RECOMMENDED_SKILLS: string[] = [
  "impeccable", "design-taste-frontend", "ui-ux-pro-max", "vercel-react-best-practices", "accessibility",
  "react-native-best-practices", "api-and-interface-design", "senior-backend", "typescript-pro", "python-pro",
  "supabase-postgres-best-practices", "senior-data-engineer", "devops-engineer", "terraform-style-guide", "ci-cd-and-automation",
];

export function missingSkillsForStack(fp: Omit<StackFingerprint, "skills">, installed: ReadonlySet<string>): string[] {
  return ALL_RECOMMENDED_SKILLS.filter((name) => recommendSkills(fp, new Set([...installed, name])).includes(name) && !installed.has(name));
}

export function userAllowlistPath(): string {
  const dir = resolveUserHarnessDir();
  return dir ? path.join(dir, "skill-allowlist.json") : "";
}

export function installedSkillFiles(roots: string | string[] = installedSkillDirs()): Map<string, string> {
  const dirList = typeof roots === "string" ? [roots] : roots;
  const map = new Map<string, string>();
  for (const dir of dirList) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, "SKILL.md");
      if (existsSync(file) && !map.has(entry.name)) {
        map.set(entry.name, file);
      }
    }
  }
  return map;
}

/** Repo-local evidence store: skill runs, lift, and the pinned allowlist. */
const HARNESS_DIR_REL = path.join(".omp", "harness");

interface PinnedEntry {
  l1Digest?: string;
  sha256?: string;
  realpath?: string;
}

/**
 * Trust-on-first-use allowlist.
 *
 * The first session that sees a skill pins its `SKILL.md` hash and L1 digest in
 * `.omp/harness/skill-allowlist.json`. Every later session must match that hash;
 * an edited or swapped skill body (an injected third-party update) drops back to
 * pointer-only until a human re-pins it with `/harness-skill pin`.
 */
export function loadAllowlist(_cwd?: string): Record<string, PinnedEntry> {
  const file = userAllowlistPath();
  if (!file) return {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, PinnedEntry> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      out[name] = {
        l1Digest: typeof rec.l1Digest === "string" ? rec.l1Digest : undefined,
        sha256: typeof rec.sha256 === "string" ? rec.sha256 : undefined,
        realpath: typeof rec.realpath === "string" ? rec.realpath : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveAllowlist(_cwd: string | undefined, allowlist: Record<string, PinnedEntry>): boolean {
  const file = userAllowlistPath();
  if (!file) return false;
  return writeTextFileAtomic(file, `${JSON.stringify(allowlist, null, 2)}\n`);
}

export interface SkillCorpus {
  docs: SkillDoc[];
  digests: Record<string, string>;
  sha256: Record<string, string>;
  realpaths: Record<string, string>;
  origins: Record<string, SkillOrigin>;
}

/**
 * Read every installed `SKILL.md` once, hash it, and build the pointer digest.
 * Bounded by the skill count (tens of files, a few KB each) and cached per
 * session so a turn never pays for a directory walk.
 */
export function loadSkillCorpus(skillsDir: string | string[] = installedSkillDirs(), cwd?: string): SkillCorpus {
  const entries = skillsDir === undefined ? installedSkillEntries(undefined, cwd) : installedSkillEntries(skillsDir, cwd);
  const docs: SkillDoc[] = [];
  const digests: Record<string, string> = {};
  const shas: Record<string, string> = {};
  const realpaths: Record<string, string> = {};
  const origins: Record<string, SkillOrigin> = {};
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const body = readFileSync(entry.file, "utf8");
      const doc = parseSkillDoc(body, entry.name);
      if (!doc) continue;
      docs.push(doc);
      shas[entry.name] = createHash("sha256").update(body).digest("hex");
      digests[entry.name] = digestSkillDoc(doc, body);
      realpaths[entry.name] = entry.realpath;
      origins[entry.name] = entry.origin;
    } catch {
      // An unreadable skill is simply not routable.
    }
  }
  return { docs, digests, sha256: shas, realpaths, origins };
}


/**
 * Pin every skill we can read into the session allowlist; an already-pinned
 * entry keeps its hash so a changed body fails the check instead of silently
 * re-pinning. Runs with the repo `cwd` so `.omp/harness` resolves correctly.
 */
function pinSkills(cwd: string, corpus: SkillCorpus): void {
  const allowlist = loadAllowlist(cwd);
  let changed = false;
  for (const doc of corpus.docs) {
    const origin = corpus.origins[doc.name];
    if (origin !== "user-global" && origin !== "bundle" && origin !== "plugin-cache") continue;
    const sha = corpus.sha256[doc.name];
    if (!sha) continue;
    if (!allowlist[doc.name]) {
      allowlist[doc.name] = { sha256: sha, l1Digest: corpus.digests[doc.name] ?? "", realpath: corpus.realpaths[doc.name] };
      changed = true;
    }
  }
  if (changed) {
    try { saveAllowlist(cwd, allowlist); } catch { /* read-only home still routes */ }
  }
}

interface TurnState {
  sessionId: string;
  turnIndex: number;
  skillName: string;
  skillSha256: string;
  taskCategory: string;
  loadMode: "auto_injected" | "holdout_control" | "agent_read" | "pointer_only" | "l1_autoload";
  holdout: boolean;
  routerScore: number;
  mutations: number;
  toolCalls: number;
  toolErrors: number;
  verifyRan: boolean;
  verifyPassed: boolean;
  hardReverted: boolean;
  acceptancePassRate: number | null;
}

export function installedSkillNames(skillsDir?: string | string[]): Set<string> {
  const entries = skillsDir === undefined ? installedSkillEntries() : installedSkillEntries(skillsDir);
  return new Set(entries.map((entry) => entry.name).sort());
}

/**
 * True when `doc` carries a `notFor` clause matching `prompt` that is not
 * waived by a matching `notForUnless`. Mirrors the scoreSkillDocs exclusion so
 * routing and pointer suggestion stay consistent.
 */
function skillNotForExcluded(doc: SkillDoc, prompt: string): boolean {
  const p = prompt.toLowerCase();
  const notFor = doc.notFor ?? [];
  for (const nf of notFor) {
    if (nf && p.includes(nf.toLowerCase())) {
      if (doc.notForUnless) {
        for (const nu of doc.notForUnless) {
          if (nu && p.includes(nu.toLowerCase())) return false;
        }
      }
      return true;
    }
  }
  return false;
}

const miniSearchIndexCache = new WeakMap<SkillDoc[], MiniSearch>();

/**
 * Stage-1 funnel: MiniSearch recall over the skill catalog, unioned with the
 * stack fingerprint and Jev suggestion skills so a stack/suggestion signal is
 * never lost to the funnel. Returns docs in original catalog order for
 * deterministic downstream tie-breaking by name.
 */
export function selectCandidateDocs(
  docs: SkillDoc[],
  prompt: string,
  opts?: { stackSkills?: string[]; suggestionSkills?: string[]; limit?: number },
): SkillDoc[] {
  const limit = opts?.limit ?? 25;
  const stack = new Set(opts?.stackSkills ?? []);
  const suggest = new Set(opts?.suggestionSkills ?? []);
  try {
    let ms = miniSearchIndexCache.get(docs);
    if (!ms) {
      ms = new MiniSearch({
        idField: "name",
        fields: ["name", "description"],
        tokenize: tokenizeForFts,
        searchOptions: {},
      });
      ms.addAll(docs.map((d) => ({ name: d.name, description: d.description })));
      miniSearchIndexCache.set(docs, ms);
    }
    const results = ms.search(foldVietnamese(prompt), {
      fields: ["name", "description"],
      boost: { name: 3 },
      fuzzy: 0.2,
      prefix: true,
    });
    const topIds = new Set(results.slice(0, limit).map((r) => String(r.id)));
    const chosen = new Set<string>(topIds);
    for (const n of stack) chosen.add(n);
    for (const n of suggest) chosen.add(n);
    if (chosen.size === 0) return docs; // degrade: no recall → full catalog
    return docs.filter((d) => chosen.has(d.name));
  } catch {
    // Degrade to full catalog on any MiniSearch failure; routing must never crash.
    return docs;
  }
}

function loadModeCode(mode: string): number {
  switch (mode) {
    case "auto_injected":
      return 1;
    case "l1_autoload":
      return 2;
    case "holdout_control":
      return 3;
    case "pointer_only":
      return 4;
    case "agent_read":
      return 5;
    default:
      return 0;
  }
}

export default function stackRouter(pi: ExtensionAPI): void {
  const corpora = new Map<string, SkillCorpus>();
  const turnCounts = new Map<string, number>();
  const turns = new Map<string, TurnState>();
  const injectedSkills = new Map<string, Set<string>>();
  const stores = new Map<string, SkillTelemetryStore>();

  function corpusFor(cwd: string): SkillCorpus {
    const cached = corpora.get(cwd);
    if (cached) return cached;
    const loaded = loadSkillCorpus(installedSkillDirs());
    pinSkills(cwd, loaded);
    corpora.set(cwd, loaded);
    return loaded;
  }

  /** Open the per-repo telemetry store; a locked or read-only workspace degrades to no data. */
  function storeFor(cwd: string): SkillTelemetryStore | null {
    const cached = stores.get(cwd);
    if (cached) return cached;
    try {
      const dir = path.join(cwd, HARNESS_DIR_REL);
      mkdirSync(dir, { recursive: true });
      const store = new SkillTelemetryStore(path.join(dir, "skill-telemetry.db"));
      stores.set(cwd, store);
      return store;
    } catch {
      return null;
    }
  }

  /**
   * Empirical lift per skill, but only once a bucket has enough support. Under
   * the shadow threshold the value is 0, so a handful of lucky turns cannot
   * reorder routing.
   */
  function liftFor(cwd: string, corpus: SkillCorpus, names: string[], category: string, modelId: string): Record<string, number> {
    const store = storeFor(cwd);
    const out: Record<string, number> = {};
    if (!store) return out;
    for (const name of names) {
      const sha = corpus.sha256[name];
      if (!sha) continue;
      try {
        const lift = store.queryLift(name, sha, category, modelId);
        if (lift.shadowMode) continue;
        out[name] = Math.max(-0.2, Math.min(0.2, lift.lift));
      } catch {
        // A corrupt row must not change routing.
      }
    }
    return out;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    const cwd = path.resolve(ctx.cwd ?? process.cwd());
    const installed = installedSkillNames(installedSkillsDir());
    fingerprints.set(cwd, fingerprintProject(cwd, installed));
    // Warm both caches off the critical path of the first prompt.
    try {
      corpusFor(cwd);
    } catch {
      // Routing degrades to pointer-only when the catalog cannot be read.
    }
  });

/** True when a prompt is a synthetic continuation (verify-gate / system notice / superagent report), never a real user turn. */
function isSyntheticContinuationPrompt(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  return (
    trimmed.startsWith("harness verify-gate:") ||
    trimmed.startsWith("<system-notice>") ||
    trimmed.startsWith("[SUPERAGENT-")
  );
}

/** True when the session branch already carries a `harness-stack` custom_message announcement. */
function branchHasStackAnnouncement(ctx: unknown): boolean {
  const mgr = (ctx as { sessionManager?: { getBranch?: () => unknown[] } } | undefined)?.sessionManager;
  const branch = mgr?.getBranch?.();
  if (!Array.isArray(branch)) return false;
  return branch.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).type === "custom_message" &&
      (entry as Record<string, unknown>).customType === "harness-stack",
  );
}

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx?.agent?.kind === "sub") return undefined;
    const cwd = path.resolve(ctx.cwd ?? process.cwd());
    const fp = fingerprints.get(cwd);
    const sessionId = ctx.sessionManager.getSessionId();

    const prompt = String(event?.prompt ?? "");

    // Synthetic continuation prompts never re-emit the turn-1 harness-stack
    // announcement and never advance the per-session turn counter.
    if (isSyntheticContinuationPrompt(prompt)) return undefined;

    const key = `${cwd}::${sessionId}`;
    const alreadyAnnounced = turnCounts.has(sessionId) || injectedSessions.has(key) || branchHasStackAnnouncement(ctx);
    const turnIndex = (turnCounts.get(sessionId) ?? 0) + 1;
    turnCounts.set(sessionId, turnIndex);
    let corpus: SkillCorpus | null = null;
    let candidates: Candidate[] = [];
    let decision: ValveDecision = {
      valveOpen: false,
      mode: "pointer_only",
      skill: null,
      pointer: "",
      reason: "no-candidate",
    };
    const { cleanPrompt, explicitSkills } = extractUserPrompt(prompt);
    const category = classifyTaskCategory(cleanPrompt);
    if (prompt.length >= 12) {
      try {
        corpus = corpusFor(cwd);
      } catch {
        corpus = null;
      }
    }
    if (corpus && corpus.docs.length > 0) {
      const suggestion = getSuggestion();
      let rawSuggested: unknown[] = [];
      if (suggestion && typeof suggestion === "object") {
        const s = suggestion as Record<string, unknown>;
        if ("suggestedSkills" in s && Array.isArray(s.suggestedSkills)) {
          rawSuggested = s.suggestedSkills;
        } else if ("skills" in s && Array.isArray(s.skills)) {
          rawSuggested = s.skills;
        }
      }
      const suggestionSkillsRaw = [...new Set([...rawSuggested.filter((value): value is string => typeof value === "string"), ...explicitSkills])];
      const suggestionSkills = suggestionSkillsRaw.filter((name) => {
        const doc = corpus.docs.find((d) => d.name === name);
        return !doc || !skillNotForExcluded(doc, cleanPrompt);
      });
      const names = corpus.docs.map((doc) => doc.name);
      const modelId = process.env.PI_MODEL ?? process.env.OMP_MODEL ?? "*";
      const lift = liftFor(cwd, corpus, names, category, modelId);
      candidates = scoreSkillDocs(
        selectCandidateDocs(corpus.docs, cleanPrompt, { stackSkills: fp?.skills ?? [], suggestionSkills }),
        cleanPrompt,
        {
        stackSkills: fp?.skills ?? [],
        suggestionSkills,
        lift,
      });
      let seen = injectedSkills.get(sessionId);
      if (!seen) {
        seen = new Set<string>();
        injectedSkills.set(sessionId, seen);
      }
      const pinned: Record<string, string> = {};
      for (const [name, entry] of Object.entries(loadAllowlist(cwd))) {
        if (entry.sha256) pinned[name] = entry.sha256;
      }
      const holdout = isHoldoutTurn(sessionId, turnIndex);
      decision = decideValve(candidates, {
        allowlist: loadAllowlist(cwd),
        actualSha256: corpus.sha256,
        pinnedSha256: pinned,
        holdout,
        alreadyInjected: [...seen],
        recomputedDigests: corpus.digests,
        actualRealpaths: corpus.realpaths,
      });
      // Rare open path: confirm against the whole catalog so the funnel cannot
      // hide a tied competitor; cost is one extra full scan only on a turn that
      // would already autoload, and the already-injected guard caps it per skill.
      if (decision.valveOpen) {
        const fullCandidates = scoreSkillDocs(corpus.docs, cleanPrompt, {
          stackSkills: fp?.skills ?? [],
          suggestionSkills,
          lift,
        });
        decision = decideValve(fullCandidates, {
          allowlist: loadAllowlist(cwd),
          actualSha256: corpus.sha256,
          pinnedSha256: pinned,
          holdout,
          alreadyInjected: [...seen],
          recomputedDigests: corpus.digests,
          actualRealpaths: corpus.realpaths,
        });
        candidates = fullCandidates;
      }
      if (decision.valveOpen && decision.skill) seen.add(decision.skill);
      for (const name of decision.secondarySkills?.map((s) => s.name) ?? []) seen.add(name);
      if (!decision.valveOpen && decision.mode === "holdout_control" && decision.skill) seen.add(decision.skill);

      const wantAutoload = decision.valveOpen && decision.skill !== null;
      if (alreadyAnnounced && !wantAutoload) return undefined;
      if (alreadyAnnounced && wantAutoload && decision.skill) {
        const digest = corpus.digests[decision.skill] ?? "";
        if (digest) {
          return { message: { customType: "harness-stack", content: `\nAutoloaded (${decision.skill}):\n${digest}`, display: false } };
        }
        return undefined;
      }
      if (wantAutoload && decision.skill) {
        logHarnessCode(
          cwd,
          `S1 t=${turnIndex} skill=${decision.skill} score=${(candidates[0]?.score ?? 0).toFixed(2)} sec=${decision.secondarySkills?.length ?? 0} m=${loadModeCode(decision.mode)}`,
        );
      }
      turns.set(sessionId, {
        sessionId,
        turnIndex,
        skillName: decision.skill ?? candidates[0]?.name ?? "",
        skillSha256: decision.skill && corpus.sha256[decision.skill] ? corpus.sha256[decision.skill] : "",
        taskCategory: category,
        loadMode: decision.mode,
        holdout,
        routerScore: candidates[0]?.score ?? 0,
        mutations: 0,
        toolCalls: 0,
        toolErrors: 0,
        verifyRan: false,
        verifyPassed: false,
        hardReverted: false,
        acceptancePassRate: null,
      });

      const detected = fp ? [...fp.languages, ...fp.frameworks, ...fp.tooling].join(", ") : "";
      const stackSkills = fp?.skills ?? [];
      const pointers = candidates
        .filter((candidate) => candidate.score >= AUTOLOAD_THETA / 2)
        .slice(0, 3)
        .map((candidate) => candidate.name)
        .filter((name) => {
          const doc = corpus.docs.find((d) => d.name === name);
          return !doc || !skillNotForExcluded(doc, prompt);
        });
      const named = [...new Set([...stackSkills, ...pointers])];
      const digest = wantAutoload && decision.skill ? corpus.digests[decision.skill] : "";
      const secondaryDigests: string[] = [];
      const secondaryNames: string[] = [];
      if (decision.secondarySkills) {
        let combined = digest.length;
        for (const secondary of decision.secondarySkills) {
          const secondaryDigest = corpus.digests[secondary.name];
          if (!secondaryDigest) continue;
          if (combined + secondaryDigest.length > 1800) break;
          combined += secondaryDigest.length;
          secondaryDigests.push(secondaryDigest);
          secondaryNames.push(secondary.name);
        }
      }
      if (named.length > 0 || wantAutoload) {
        const missing = fp ? missingSkillsForStack(fp, new Set(corpus.docs.map((d) => d.name))) : [];
        const missingSuffix = missing.length > 0 ? ` Missing skills: ${missing.join(", ")}.` : "";
        const head = detected
          ? `harness-stack: detected ${detected}. Domain skills that fit this repo: ${named.join(", ") || "none"}. Load one with skill://<name> when the task matches it.${missingSuffix}`
          : `harness-stack: no stack markers. Candidate skills for this request: ${named.join(", ") || "none"}. Load one with skill://<name> when the task matches it.${missingSuffix}`;
        const secondarySuffix = secondaryNames.length > 0 ? "/" + secondaryNames.join("/") : "";
        const tail =
          wantAutoload && decision.skill && digest
            ? `\nAutoloaded (${decision.skill}${secondarySuffix}):\n${digest}${secondaryDigests.length > 0 ? "\n" + secondaryDigests.join("\n") : ""}`
            : "";
        return {
          message: {
            customType: "harness-stack",
            content: `${head}${tail}`,
            display: false,
          },
        };
      }
    }

    if (!turns.has(sessionId)) {
      turns.set(sessionId, {
        sessionId,
        turnIndex,
        skillName: "",
        skillSha256: "",
        taskCategory: category,
        loadMode: "pointer_only",
        holdout: false,
        routerScore: 0,
        mutations: 0,
        toolCalls: 0,
        toolErrors: 0,
        verifyRan: false,
        verifyPassed: false,
        hardReverted: false,
        acceptancePassRate: null,
      });
    }

    // No catalog or no candidate: keep the original stack-only message.
    if (!fp || fp.skills.length === 0) return undefined;
    if (injectedSessions.has(key)) return undefined;
    injectedSessions.add(key);
    const detected = [...fp.languages, ...fp.frameworks, ...fp.tooling].join(", ");
    const missing = missingSkillsForStack(fp, installedSkillNames(installedSkillsDir()));
    return {
      message: {
        customType: "harness-stack",
        content: `harness-stack: detected ${detected}. Domain skills that fit this repo: ${fp.skills.join(", ")}. Load one with skill://<name> when the task matches it.${missing.length > 0 ? ` Missing skills: ${missing.join(", ")}.` : ""}`,
        display: false,
      },
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = turns.get(sessionId);
    if (!state) return;
    state.toolCalls += 1;
    if (event?.isError === true) state.toolErrors += 1;
    const toolName = event?.toolName;
    const input: unknown = event?.input;
    if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") state.mutations += 1;
    if ((toolName === "task" || toolName === "vibe_spawn") && isMutatingTaskCall(input)) state.mutations += 1;
    if ((toolName === "task" || toolName === "vibe_spawn") && event && typeof event === "object" && "output" in event) {
      const out = String((event as { output?: unknown }).output ?? "");
      if (classifyVerifyCommand(out) || /# pass \d+/.test(out) || /# fail \d+/.test(out)) state.verifyRan = true;
    }
    if (toolName === "bash" && input && typeof input === "object" && "command" in input && typeof input.command === "string") {
      const command = input.command;
      if (isHardRevert(command)) state.hardReverted = true;
      if (classifyVerifyCommand(command)) {
        state.verifyRan = true;
        if (event?.isError !== true) state.verifyPassed = true;
      }
    }
    if (toolName === "read" && input && typeof input === "object" && "path" in input && typeof input.path === "string") {
      const target = input.path;
      if (target.startsWith("skill://") && state.loadMode === "pointer_only") state.loadMode = "agent_read";
    }
    if (toolName === "harness_record" && input && typeof input === "object" && "acceptance" in input && Array.isArray(input.acceptance)) {
      const rows = input.acceptance;
      const graded = rows.filter((row) => row && typeof row === "object" && "pass" in row);
      if (graded.length > 0) {
        const passed = graded.filter((row) => "pass" in row && row.pass === true).length;
        state.acceptancePassRate = passed / graded.length;
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    const cwd = path.resolve(ctx.cwd ?? process.cwd());
    const sessionId = ctx.sessionManager.getSessionId();
    const state = turns.get(sessionId);
    if (!state) return;
    const reward = computeReward({
      mutations: state.mutations,
      verifyRan: state.verifyRan,
      verifyPassed: state.verifyPassed,
      hardReverted: state.hardReverted,
      toolErrors: state.toolErrors,
      toolCalls: state.toolCalls,
      acceptancePassRate: state.acceptancePassRate,
      manualRating: null,
    });
    logHarnessCode(
      cwd,
      `M1 t=${state.turnIndex} mut=${state.mutations} calls=${state.toolCalls} err=${state.toolErrors} v=${state.verifyPassed ? 1 : 0} r=${reward.toFixed(2)} sk=${state.skillName || "-"}`,
    );
    if (!state.skillName) {
      turns.delete(sessionId);
      return;
    }
    const store = storeFor(cwd);
    if (!store) {
      turns.delete(sessionId);
      return;
    }
    const record: SkillRunRecord = {
      runId: `${sessionId}:${state.turnIndex}:${state.skillName}`,
      sessionId,
      turnIndex: state.turnIndex,
      skillName: state.skillName,
      skillSha256: state.skillSha256,
      taskCategory: state.taskCategory,
      modelId: (ctx as { model?: { id?: string } })?.model?.id ?? process.env.PI_MODEL ?? process.env.OMP_MODEL ?? "*",
      loadMode: state.loadMode,
      holdout: state.holdout,
      routerScore: state.routerScore,
      mutations: state.mutations,
      toolCalls: state.toolCalls,
      toolErrors: state.toolErrors,
      verifyRan: state.verifyRan,
      verifyPassed: state.verifyPassed,
      hardReverted: state.hardReverted,
      acceptancePassRate: state.acceptancePassRate,
      manualRating: null,
      reward,
      recordedAt: new Date().toISOString(),
    };
    try {
      store.recordRun(record);
    } catch {
      // Telemetry is never allowed to break a turn.
    }
    turns.delete(sessionId);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    for (const store of stores.values()) {
      try {
        store.close();
      } catch {
        // Already closed.
      }
    }
    stores.clear();
    turnCounts.clear();
    injectedSkills.clear();
  });

  pi.registerCommand("skill-rate", {
    description: "Rate a skill's real usefulness: /skill-rate <skill> <pass|fail|1..5> [note], or /skill-rate status.",
    handler: async (args, ctx) => {
      const cwd = path.resolve(ctx.cwd ?? process.cwd());
      const store = storeFor(cwd);
      if (!store) {
        ctx.ui.notify("skill-rate: telemetry store unavailable in this workspace", "error");
        return;
      }
      const text = String(args ?? "").trim();
      if (text === "" || text === "status") {
        let rows: Array<Record<string, unknown>> = [];
        try {
          rows = store.listStats();
        } catch {
          rows = [];
        }
        if (rows.length === 0) {
          ctx.ui.notify("skill-rate: no skill runs recorded yet for this repo", "info");
          return;
        }
        const lines = rows.slice(0, 15).map((row) => {
          const treatment = Number(row.treatment_runs ?? 0);
          const control = Number(row.control_runs ?? 0);
          const total = treatment + control;
          const lift = Number(row.lift ?? 0);
          const shadow = total < 20 ? " (shadow)" : "";
          return `${String(row.skill_name)} [${String(row.task_category)}] runs=${total} lift=${lift.toFixed(3)}${shadow}`;
        });
        ctx.ui.notify(`skill lift:\n${lines.join("\n")}`, "info");
        return;
      }
      const parts = text.split(/\s+/);
      const skillName = parts[0] ?? "";
      const raw = (parts[1] ?? "").toLowerCase();
      let rating: number | null = null;
      if (raw === "pass") rating = 1;
      else if (raw === "fail") rating = 0;
      else if (/^[1-5]$/.test(raw)) rating = (Number(raw) - 1) / 4;
      if (!skillName || rating === null) {
        ctx.ui.notify("skill-rate: usage /skill-rate <skill> <pass|fail|1..5> [note]", "error");
        return;
      }
      const corpus = corpusFor(cwd);
      const sha = corpus.sha256[skillName] ?? "";
      try {
        store.recordManualRating(skillName, sha, rating);
      } catch {
        ctx.ui.notify("skill-rate: could not record the rating", "error");
        return;
      }
      const note = parts.slice(2).join(" ");
      ctx.ui.notify(`skill-rate: ${skillName} rated ${rating.toFixed(2)}${note ? ` (${note})` : ""}`, "info");
    },
  });

  pi.registerCommand("harness-stack", {
    description: "Show the detected stack and the domain skills that apply.",
    handler: async (_args, ctx) => {
      const cwd = path.resolve(ctx.cwd ?? process.cwd());
      const installed = installedSkillNames(installedSkillsDir());
      const fp = fingerprintProject(cwd, installed);
      const missing = missingSkillsForStack(fp, installed);
      const skillsText = fp.skills.length > 0 ? fp.skills.join(", ") : "none installed";
      const text = `stack: ${fp.languages.join(", ")} | frameworks: ${fp.frameworks.join(", ")} | tooling: ${fp.tooling.join(", ")}\nskills: ${skillsText}` + (missing.length > 0 ? `\nmissingSkills: ${missing.join(", ")}` : "");
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("harness-skill", {
    description: "Inspect or re-pin the skill allowlist: /harness-skill list | /harness-skill pin [name].",
    handler: async (args, ctx) => {
      const cwd = path.resolve(ctx.cwd ?? process.cwd());
      const parts = String(args ?? "").trim().split(/\s+/);
      const sub = parts[0] ?? "list";
      const allowlist = loadAllowlist(cwd);
      if (sub === "list") {
        const names = Object.keys(allowlist).sort();
        if (names.length === 0) {
          ctx.ui.notify("harness-skill: allowlist is empty; it pins on first session with a readable skill catalog", "info");
          return;
        }
        ctx.ui.notify(`pinned skills (${names.length}):\n${names.join("\n")}`, "info");
        return;
      }
      if (sub !== "pin") {
        ctx.ui.notify("harness-skill: usage /harness-skill list | pin [name]", "error");
        return;
      }
      const target = parts[1];
      const corpus = loadSkillCorpus();
      let pinnedCount = 0;
      for (const doc of corpus.docs) {
        if (target && doc.name !== target) continue;
        const sha = corpus.sha256[doc.name];
        if (!sha) continue;
        allowlist[doc.name] = { sha256: sha, l1Digest: corpus.digests[doc.name] ?? "" };
        pinnedCount += 1;
      }
      if (pinnedCount === 0) {
        ctx.ui.notify(`harness-skill: no installed skill matched${target ? ` "${target}"` : ""}`, "error");
        return;
      }
      try {
        saveAllowlist(cwd, allowlist);
      } catch {
        ctx.ui.notify("harness-skill: could not write .omp/harness/skill-allowlist.json", "error");
        return;
      }
      ctx.ui.notify(`harness-skill: pinned ${pinnedCount} skill(s)`, "info");
    },
  });

  pi.registerCommand("harness-log", {
    description: "Summarize compact global harness telemetry (/harness-log).",
    handler: async (_args, ctx) => {
      const logPath = globalHarnessLogPath();
      const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      ctx.ui.notify(text.trim() ? summarizeHarnessLog(text) : `harness-log: empty (${logPath})`, "info");
    },
  });
}
