/**
 * zeromem.ts — in-process Zero-Mem memory engine (v4).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import MiniSearch from "minisearch";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank.js";

export const HARNESS_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BRIDGE_SCRIPT = path.join(HARNESS_ROOT, "py", "zero_mem_bridge.py");
export const DEFAULT_READER_MODEL = "gpt-6-luna";
export const DEFAULT_READER_BASE_URL = "https://api.ns24.io/v1";

const MAX_UNIT_CHARS = 2_000;
const MIN_UNIT_CHARS = 40;

export type MemoryKind = "request" | "outcome" | "decision" | "fact" | "procedure" | "note" | "episode" | "raw_legacy";

export interface MemoryUnit {
  id: string;
  kind: MemoryKind;
  text: string;
  at: string;
  session: string;
  l0?: string;
  l1?: string;
  files?: string[];
  symbols?: string[];
  superseded_by?: string | null;
  invalidated_at?: string | null;
}

export interface Evidence {
  id?: string;
  text: string;
  score: number;
  l0?: string;
  files?: string[];
  symbols?: string[];
  kind?: MemoryKind;
}

export interface QueryResult {
  ok: boolean;
  empty?: boolean;
  evidence: Evidence[];
  answer?: string;
  error?: string;
  answerStatus?: "synthesized" | "evidence_only" | "not_requested";
  readerError?: string;
}

export interface ReaderConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface QueryOptions {
  topK?: number;
  answer?: boolean;
  reader?: ReaderConfig;
  excludeSession?: string;
  excludeIds?: ReadonlySet<string>;
  includeInvalidated?: boolean;
}

export interface BridgeOptions {
  python?: string;
  script?: string;
  env?: NodeJS.ProcessEnv;
  available?: boolean;
}

const projectRootCache = new Map<string, string>();

export function projectRoot(cwd: string): string {
  const abs = path.resolve(cwd);
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  const cached = projectRootCache.get(key);
  if (cached) return cached;
  let resolved = abs;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: abs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    if (out) resolved = path.resolve(out);
  } catch {
    // not a git repo
  }
  projectRootCache.set(key, resolved);
  return resolved;
}

export function datasetName(cwd: string): string {
  const root = projectRoot(cwd);
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  const slug = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

export function storeDir(cwd: string): string {
  const root = projectRoot(cwd);
  return path.join(root, ".omp", "memory", "zero-mem", datasetName(cwd));
}

export function corpusPath(cwd: string): string {
  return path.join(storeDir(cwd), "units.jsonl");
}

export function dbPath(cwd: string): string {
  return path.join(storeDir(cwd), "memory.db");
}

export function storeExists(cwd: string): boolean {
  return existsSync(corpusPath(cwd));
}

export function pythonPath(): string | null {
  return "node:sqlite";
}

function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function unitId(kind: string, text: string): string {
  return createHash("sha256").update(`${kind}\u0000${text}`, "utf8").digest("hex").slice(0, 16);
}

const NOTE_CUE_RE =
  /^\s*(?:[-*]|\d+\.)?\s*(?:decision|decided|rule|constraint|invariant|resolved|fixed|root cause|architecture|convention|gotcha|lesson|note|chốt|quyết định|nguyên tắc|lưu ý)\b/i;

const SKIP_LINE_RE = /^\s*(?:```|~~~|\||#|\*(?!\s)|\/\*|\/\/)/;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "will", "are", "was", "were",
  "been", "into", "when", "what", "where", "which", "while", "your", "their", "there", "then",
  "than", "also", "only", "some", "more", "most", "other", "such", "each", "much", "many",
  "true", "false", "null", "undefined", "void", "return", "const", "let", "var", "function",
  "class", "interface", "type", "import", "export", "async", "await", "string", "number", "boolean",
  "in", "to", "is", "on", "of", "or", "by", "at", "an", "as", "be", "do", "if", "it", "no", "so", "up", "we",
  "của", "và", "các", "những", "trong", "cho", "với", "được", "không", "này", "khi", "một", "như", "đã", "sẽ", "cần",
]);

const RECALL_NOISE = new Set(["nhớ", "nhắc", "lại", "hôm", "trước", "lần", "giúp", "tôi", "nhac", "lai"]);

const VI_MAP: Record<string, string> = {
  "kiến trúc": "architecture",
  "quyết định": "decision",
  "chốt": "decision",
  "nguyên tắc": "rule",
  "luật": "rule",
  "lỗi": "bug",
  "xác thực": "auth",
  "bộ nhớ": "memory",
  "kỹ năng": "skill",
};

export function extractCodeEntities(text: string): { files: string[]; symbols: string[]; l0: string; l1: string } {
  const fileSet = new Set<string>();
  const fileRegex = /\b(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|rs|go|mjs|cjs|json|ya?ml|md|sql|sh|toml)\b/g;
  for (const m of text.matchAll(fileRegex)) {
    const clean = m[0].replace(/\\/g, "/").replace(/^\.\//, "");
    if (clean.length >= 3 && clean.length <= 120) fileSet.add(clean);
  }
  const files = [...fileSet].slice(0, 12);

  const symSet = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]{2,63})(?:\(\))?`/g)) {
    const s = m[1];
    if (!STOP_WORDS.has(s.toLowerCase()) && !fileSet.has(s)) symSet.add(s);
  }
  const camelSnakeRegex = /\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z]{2,}_[a-z0-9_]{2,})\b/g;
  for (const m of text.matchAll(camelSnakeRegex)) {
    const s = m[1];
    if (s.length >= 4 && s.length <= 64 && !STOP_WORDS.has(s.toLowerCase())) symSet.add(s);
  }
  const symbols = [...symSet].slice(0, 16);

  const firstLine = (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? text).trim();
  const l0 = firstLine.slice(0, 160);
  const parts: string[] = [];
  if (files.length > 0) parts.push(`files: ${files.slice(0, 4).join(", ")}`);
  if (symbols.length > 0) parts.push(`symbols: ${symbols.slice(0, 6).join(", ")}`);
  const l1 = parts.length > 0 ? `[${parts.join(" | ")}] ${l0}`.slice(0, 240) : l0;
  return { files, symbols, l0, l1 };
}

export function tokenizeForFts(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (tok: string) => {
    const low = tok.toLowerCase();
    if (low.length < 2) return;
    if (STOP_WORDS.has(low)) return;
    if (RECALL_NOISE.has(low)) return;
    if (seen.has(low)) return;
    seen.add(low);
    out.push(low);
  };

  let expanded = text;
  for (const [k, v] of Object.entries(VI_MAP)) {
    const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    expanded = expanded.replace(re, `${k} ${v}`);
  }

  // camelCase / snake_case splitting on original-ish tokens
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const raw = m[0];
    if (raw.includes("_")) {
      const combined = raw.toLowerCase().replace(/_/g, "");
      if (combined.length >= 2) add(combined);
      for (const part of raw.split("_")) add(part);
    }
    if (/[A-Z]/.test(raw) && /[a-z]/.test(raw)) {
      add(raw.toLowerCase());
      // split camelCase
      const split = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
      for (const part of split.split(/\s+/)) add(part);
    }
  }

  const spaced = expanded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const m of spaced.matchAll(/[\p{L}\p{N}]+/gu)) {
    add(m[0]);
  }
  return out;
}

export function buildFtsQuery(question: string): string {
  const entities = extractCodeEntities(question);
  const tokens = tokenizeForFts(question);
  const terms = new Set<string>();
  for (const f of entities.files) {
    for (const part of tokenizeForFts(f)) terms.add(`"${part.replace(/"/g, '""')}"`);
  }
  for (const s of entities.symbols) {
    for (const part of tokenizeForFts(s)) terms.add(`"${part.replace(/"/g, '""')}"`);
  }
  for (const t of tokens.slice(0, 24)) {
    terms.add(`"${t.replace(/"/g, '""')}"`);
  }
  if (terms.size === 0) return "";
  return [...terms].join(" OR ");
}

export function bm25RankToScore(rank: number): number {
  const abs = Math.abs(Number.isFinite(rank) ? rank : 0);
  const score = abs / (1 + abs);
  return Math.max(0.0001, Math.min(0.9999, Number(score.toFixed(4))));
}

export function extractUnits(
  request: string,
  outcome: string,
  session: string,
  at = new Date().toISOString(),
): MemoryUnit[] {
  const units: MemoryUnit[] = [];
  const seenText = new Set<string>();
  const push = (kind: MemoryKind, raw: string) => {
    const text = normalizeText(raw).slice(0, MAX_UNIT_CHARS);
    if (text.length < MIN_UNIT_CHARS) return;
    if (kind === "outcome" && seenText.has(text)) return;
    seenText.add(text);
    const ent = extractCodeEntities(text);
    const unit: MemoryUnit = {
      id: unitId(kind, text),
      kind,
      text,
      at,
      session,
      l0: ent.l0,
      l1: ent.l1,
      files: ent.files,
      symbols: ent.symbols,
    };
    units.push(unit);
  };

  if (outcome === "") {
    push("note", request);
  } else {
    const prefixRe = /^\s*(?:[-*]|\d+\.)?\s*(decision|decided|rule|constraint|invariant|resolved|fixed|root cause|architecture|convention|gotcha|lesson|note|chốt|quyết định|nguyên tắc|lưu ý)\s*[:—-]\s*(.+)/i;
    const lines = outcome.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length < MIN_UNIT_CHARS) continue;
      if (SKIP_LINE_RE.test(line)) continue;
      const m = line.match(prefixRe);
      if (!m) continue;
      const kw = m[1].toLowerCase();
      let kind: MemoryKind = "note";
      if (/decision|decided|chốt|quyết định/.test(kw)) kind = "decision";
      else if (/rule|constraint|invariant|architecture|convention|nguyên tắc/.test(kw)) kind = "fact";
      else if (/resolved|fixed|root cause|gotcha|lesson/.test(kw)) kind = "procedure";
      else if (/note|lưu ý/.test(kw)) kind = "note";
      push(kind, m[2]);
    }
    if (request.trim().length >= 20 && outcome.trim().length >= 40) {
      const reqHead = normalizeText(request).slice(0, 240);
      const outTail = normalizeText(outcome).slice(-600);
      push("episode", `Episode: [Q] ${reqHead} [A] ${outTail}`);
    }
  }

  const seen = new Set<string>();
  const out: MemoryUnit[] = [];
  for (const u of units) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  return out.filter((u) => u.text.length >= MIN_UNIT_CHARS);
}

export function migrateCorpusToV4(cwd: string): { migrated: number; backupPath: string | null } {
  const file = corpusPath(cwd);
  if (!existsSync(file)) return { migrated: 0, backupPath: null };
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const parsed: any[] = [];
  let hasLegacy = false;
  for (const line of lines) {
    try {
      const u = JSON.parse(line);
      if (u && (u.kind === "request" || u.kind === "outcome")) hasLegacy = true;
      parsed.push(u);
    } catch {
      parsed.push(null);
    }
  }
  if (!hasLegacy) return { migrated: 0, backupPath: null };
  const backupPath = path.join(path.dirname(file), "units.jsonl.v3.bak");
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
  }
  let migrated = 0;
  const outLines = parsed.map((u) => {
    if (u && (u.kind === "request" || u.kind === "outcome")) {
      u.kind = "raw_legacy";
      migrated += 1;
    }
    return JSON.stringify(u);
  });
  writeFileSync(file, `${outLines.join("\n")}\n`, "utf8");
  entityCache.delete(corpusPath(cwd));
  return { migrated, backupPath };
}

const entityCache = new Map<string, { fp: string; files: Set<string>; symbols: Set<string> }>();

export function appendUnits(cwd: string, units: MemoryUnit[]): number {
  if (units.length === 0) return 0;
  const file = corpusPath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const known = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (typeof parsed.id === "string") known.add(parsed.id);
      } catch {
        // ignore
      }
    }
  }
  let added = 0;
  for (const unit of units) {
    if (known.has(unit.id)) continue;
    appendFileSync(file, `${JSON.stringify(unit)}\n`, "utf8");
    known.add(unit.id);
    added += 1;
  }
  if (added > 0) {
    entityCache.delete(corpusPath(cwd));
  }
  return added;
}

export function readUnits(cwd: string): MemoryUnit[] {
  const file = corpusPath(cwd);
  if (!existsSync(file)) return [];
  const units: MemoryUnit[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      units.push(JSON.parse(line) as MemoryUnit);
    } catch {
      // skip
    }
  }
  return units;
}

export function ensureGitignore(cwd: string): void {
  const root = projectRoot(cwd);
  if (!existsSync(path.join(root, ".git"))) return;
  const file = path.join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".omp/memory/") || lines.includes(".omp/memory")) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${prefix}.omp/memory/\n`, "utf8");
}

export function corpusFingerprint(cwd: string): string {
  const file = corpusPath(cwd);
  if (!existsSync(file)) return "empty";
  const stat = statSync(file);
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

export class ZeroMemBridge {
  private dbs = new Map<string, DatabaseSync>();
  public closed = 0;
  private availableOverride?: boolean;

  constructor(options: BridgeOptions = {}) {
    this.availableOverride = options.available;
  }

  get available(): boolean {
    return this.availableOverride ?? true;
  }

  private openDb(cwd: string): DatabaseSync {
    const dbFile = dbPath(cwd);
    const key = process.platform === "win32" ? dbFile.toLowerCase() : dbFile;
    const existing = this.dbs.get(key);
    if (existing) return existing;
    mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS memory_units (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, l0 TEXT NOT NULL, l1 TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL, symbols_json TEXT NOT NULL, session_id TEXT NOT NULL, recorded_at TEXT NOT NULL, superseded_by TEXT DEFAULT NULL, invalidated_at TEXT DEFAULT NULL);`,
    );
    // migrate existing dbs
    for (const col of ["superseded_by TEXT DEFAULT NULL", "invalidated_at TEXT DEFAULT NULL"]) {
      try {
        db.exec(`ALTER TABLE memory_units ADD COLUMN ${col};`);
      } catch {
        // already exists
      }
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS memory_files (file TEXT NOT NULL, basename TEXT NOT NULL, unit_id TEXT NOT NULL, PRIMARY KEY (file, unit_id));`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_files_basename ON memory_files (basename);`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS memory_symbols (symbol TEXT NOT NULL, unit_id TEXT NOT NULL, PRIMARY KEY (symbol, unit_id));`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_symbols_symbol ON memory_symbols (symbol);`);
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, files, symbols, kind, l0_abstract, unit_id UNINDEXED, tokenize='unicode61');`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS memory_episodes (id TEXT PRIMARY KEY, request_head TEXT, outcome_tail TEXT, files_json TEXT, symbols_json TEXT, session_id TEXT, recorded_at TEXT);`,
    );
    this.dbs.set(key, db);
    return db;
  }

  async index(cwd: string, units?: MemoryUnit[]): Promise<{ added: number; total: number } | null> {
    if (!this.available) return null;
    if (units === undefined && !storeExists(cwd)) return { added: 0, total: 0 };
    const db = this.openDb(cwd);
    const fp = corpusFingerprint(cwd);
    const row = db.prepare("SELECT value FROM memory_meta WHERE key = 'fingerprint'").get() as { value?: string } | undefined;
    const countRow = db.prepare("SELECT COUNT(*) AS c FROM memory_units").get() as { c: number };
    if (fp !== "empty" && row?.value === fp && countRow.c > 0 && (units === undefined || countRow.c === units.length)) {
      return { added: 0, total: countRow.c };
    }
    const allUnits = units ?? readUnits(cwd);
    if (allUnits.length === 0) return { added: 0, total: countRow.c };

    const checkStmt = db.prepare("SELECT 1 FROM memory_units WHERE id = ?");
    const insertUnitStmt = db.prepare(
      "INSERT INTO memory_units (id, kind, text, l0, l1, files_json, symbols_json, session_id, recorded_at, superseded_by, invalidated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertFtsStmt = db.prepare(
      "INSERT INTO memory_fts (content, files, symbols, kind, l0_abstract, unit_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertFileStmt = db.prepare(
      "INSERT OR IGNORE INTO memory_files (file, basename, unit_id) VALUES (?, ?, ?)",
    );
    const insertSymbolStmt = db.prepare(
      "INSERT OR IGNORE INTO memory_symbols (symbol, unit_id) VALUES (?, ?)",
    );
    const insertEpisodeStmt = db.prepare(
      "INSERT OR REPLACE INTO memory_episodes (id, request_head, outcome_tail, files_json, symbols_json, session_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const metaStmt = db.prepare(
      "INSERT INTO memory_meta (key, value) VALUES ('fingerprint', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );

    let added = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      // load existing active decision/fact units for superseding checks
      const existingActive = db
        .prepare("SELECT id, kind, text, files_json, symbols_json, recorded_at, invalidated_at FROM memory_units WHERE kind IN ('decision','fact')")
        .all() as Array<any>;

      for (const u of allUnits) {
        if (checkStmt.get(u.id)) continue;
        const needExtract = u.files === undefined || u.symbols === undefined || u.l0 === undefined;
        const ent = needExtract ? extractCodeEntities(u.text) : undefined;
        const files = u.files ?? ent!.files;
        const symbols = u.symbols ?? ent!.symbols;
        const l0 = u.l0 ?? ent!.l0;
        const l1 = u.l1 ?? ent?.l1 ?? l0;

        // bi-temporal superseding for decision/fact
        if (u.kind === "decision" || u.kind === "fact") {
          for (const old of existingActive) {
            if (old.id === u.id) continue;
            if (old.invalidated_at) continue;
            if (old.text === u.text) continue;
            if (!old.recorded_at || old.recorded_at > u.at) continue;
            const oldFiles = JSON.parse(old.files_json || "[]");
            const oldSymbols = JSON.parse(old.symbols_json || "[]");
            let share = false;
            if (files.length > 0 && oldFiles.length > 0) {
              share = files.some((f: string) => oldFiles.includes(f));
            } else if (files.length === 0 || oldFiles.length === 0) {
              // when files empty, use symbols
              if (symbols.length > 0 && oldSymbols.length > 0) {
                share = symbols.some((s: string) => oldSymbols.includes(s));
              }
            }
            if (share) {
              db.prepare("UPDATE memory_units SET superseded_by = ?, invalidated_at = ? WHERE id = ?").run(u.id, u.at, old.id);
              old.invalidated_at = u.at;
            }
          }
        }

        insertUnitStmt.run(u.id, u.kind, u.text, l0, l1, JSON.stringify(files), JSON.stringify(symbols), u.session, u.at, u.superseded_by ?? null, u.invalidated_at ?? null);
        insertFtsStmt.run(u.text, files.join(" "), symbols.join(" "), u.kind, l0, u.id);
        for (const f of files) {
          insertFileStmt.run(f.toLowerCase(), path.basename(f).toLowerCase(), u.id);
        }
        for (const s of symbols) {
          insertSymbolStmt.run(s.toLowerCase(), u.id);
        }
        if (u.kind === "episode" || u.kind === "raw_legacy") {
          let reqHead = "";
          let outTail = "";
          if (u.kind === "episode") {
            const prefix = "Episode: [Q] ";
            let rest = u.text.startsWith(prefix) ? u.text.slice(prefix.length) : u.text;
            const idx = rest.indexOf(" [A] ");
            if (idx >= 0) {
              reqHead = rest.slice(0, idx);
              outTail = rest.slice(idx + 5);
            } else {
              reqHead = rest.slice(0, 240);
            }
          } else {
            reqHead = u.text.slice(0, 240);
          }
          insertEpisodeStmt.run(u.id, reqHead.slice(0, 240), outTail.slice(-600), JSON.stringify(files), JSON.stringify(symbols), u.session, u.at);
        }
        // track in existingActive
        if (u.kind === "decision" || u.kind === "fact") {
          existingActive.push({ id: u.id, kind: u.kind, text: u.text, files_json: JSON.stringify(files), symbols_json: JSON.stringify(symbols), recorded_at: u.at, invalidated_at: null });
        }
        added += 1;
      }
      metaStmt.run(fp);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const totalRow = db.prepare("SELECT COUNT(*) AS c FROM memory_units").get() as { c: number };
    return { added, total: totalRow.c };
  }

  async query(cwd: string, question: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const topK = opts.topK ?? 5;
    if (!storeExists(cwd) && !existsSync(dbPath(cwd))) return { ok: true, empty: true, evidence: [] };
    try {
      await this.index(cwd);
    } catch {
      // ignore
    }
    const db = this.openDb(cwd);
    const q = buildFtsQuery(question);
    const excludeSession = opts.excludeSession;
    const excludeIds = opts.excludeIds;
    const includeInvalidated = opts.includeInvalidated === true;

    const invalidFilter = includeInvalidated ? "" : "AND m.invalidated_at IS NULL";

    const candidateIds = new Set<string>();
    const ftsRankMap = new Map<string, number>();
    const msScoreMap = new Map<string, number>();

    // 1. FTS5
    if (q.trim().length > 0) {
      try {
        const rows = db
          .prepare(
            `SELECT m.id, m.kind, m.text, m.l0, m.files_json, m.symbols_json, m.session_id, m.recorded_at, bm25(memory_fts, 1.0, 2.5, 2.0, 0.5, 1.5) AS rank FROM memory_fts JOIN memory_units m ON m.id = memory_fts.unit_id WHERE memory_fts MATCH ? ${includeInvalidated ? "" : "AND m.invalidated_at IS NULL"} ORDER BY rank ASC LIMIT ?`,
          )
          .all(q, topK * 8) as Array<any>;
        for (const r of rows) {
          if (excludeSession && r.session_id === excludeSession) continue;
          if (excludeIds && excludeIds.has(r.id)) continue;
          candidateIds.add(r.id);
          if (!ftsRankMap.has(r.id)) ftsRankMap.set(r.id, r.rank);
        }
      } catch {
        // ignore
      }
    }

    const questionEntities = extractCodeEntities(question);
    const qFiles = new Set<string>();
    for (const f of questionEntities.files) {
      qFiles.add(f.toLowerCase());
      qFiles.add(path.basename(f).toLowerCase());
    }
    const qSymbols = new Set(questionEntities.symbols.map((s) => s.toLowerCase()));
    const qTokens = new Set(tokenizeForFts(question));
    // cue-stripped tokens
    const strippedTokens = tokenizeForFts(question).filter((t) => !RECALL_NOISE.has(t));
    const hasRecallCue = /nhớ|nhắc|trước|lần|hôm|continue|as before|last time|earlier|previously|recall|remember/i.test(question);

    // 2. Direct SQL union from memory_files and memory_symbols
    try {
      const fileParams: string[] = [];
      const fileConds: string[] = [];
      for (const f of qFiles) {
        fileParams.push(f);
      }
      if (fileParams.length > 0) {
        const ph = fileParams.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT DISTINCT unit_id FROM memory_files WHERE file IN (${ph}) OR basename IN (${ph})`)
          .all(...fileParams, ...fileParams) as Array<{ unit_id: string }>;
        for (const r of rows) candidateIds.add(r.unit_id);
      }
    } catch {
      // ignore
    }
    try {
      const symList = [...qSymbols];
      if (symList.length > 0) {
        const ph = symList.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT DISTINCT unit_id FROM memory_symbols WHERE symbol IN (${ph})`)
          .all(...symList) as Array<{ unit_id: string }>;
        for (const r of rows) candidateIds.add(r.unit_id);
      }
    } catch {
      // ignore
    }

    // fetch all active units for MiniSearch + graph
    const allRows = db
      .prepare(`SELECT id, kind, text, l0, files_json, symbols_json, session_id, recorded_at, invalidated_at FROM memory_units ${includeInvalidated ? "" : "WHERE invalidated_at IS NULL"}`)
      .all() as Array<any>;

    // 3. MiniSearch
    try {
      const docs = allRows
        .filter((r) => !excludeSession || r.session_id !== excludeSession)
        .filter((r) => !excludeIds || !excludeIds.has(r.id))
        .map((r) => ({
          id: r.id,
          text: r.text,
          filesText: JSON.parse(r.files_json || "[]").join(" "),
          symbolsText: JSON.parse(r.symbols_json || "[]").join(" "),
          l0: r.l0,
        }));
      const ms = new MiniSearch({
        fields: ["text", "filesText", "symbolsText", "l0"],
        storeFields: ["id"],
        tokenize: tokenizeForFts,
      });
      ms.addAll(docs);
      const msResults = ms.search(question, {
        fields: ["text", "filesText", "symbolsText", "l0"],
        boost: { symbolsText: 2.5, filesText: 2.5, l0: 1.5, text: 1.0 },
        fuzzy: 0.2,
        prefix: true,
      });
      for (const res of msResults.slice(0, topK * 8)) {
        candidateIds.add(res.id);
        msScoreMap.set(res.id, res.score);
      }
    } catch {
      // ignore
    }

    // row map
    const rowMap = new Map<string, any>();
    for (const r of allRows) rowMap.set(r.id, r);

    // 4. graphology pagerank
    const pagerankScores = new Map<string, number>();
    try {
      const graph = new Graph({ type: "undirected", multi: false });
      const candList = [...candidateIds];
      for (const id of candList) {
        const r = rowMap.get(id);
        if (!r) continue;
        if (!graph.hasNode(id)) graph.addNode(id);
        const files = JSON.parse(r.files_json || "[]");
        const symbols = JSON.parse(r.symbols_json || "[]");
        for (const f of files) {
          const fn = `file:${f}`;
          if (!graph.hasNode(fn)) graph.addNode(fn);
          if (!graph.hasEdge(id, fn)) graph.addEdge(id, fn);
        }
        for (const s of symbols) {
          const sn = `sym:${s}`;
          if (!graph.hasNode(sn)) graph.addNode(sn);
          if (!graph.hasEdge(id, sn)) graph.addEdge(id, sn);
        }
      }
      const pr = pagerank(graph, { alpha: 0.85 });
      for (const id of candList) {
        if (pr[id] !== undefined) pagerankScores.set(id, pr[id]);
      }
    } catch {
      // ignore
    }

    const now = Date.now();
    const maxMs = Math.max(0, ...msScoreMap.values());
    const scored: Array<any> = [];

    for (const id of candidateIds) {
      const r = rowMap.get(id);
      if (!r) continue;
      if (!includeInvalidated && r.invalidated_at) continue;
      if (excludeSession && r.session_id === excludeSession) continue;
      if (excludeIds && excludeIds.has(r.id)) continue;

      const files = JSON.parse(r.files_json || "[]");
      const symbols = JSON.parse(r.symbols_json || "[]");
      const ftsRank = ftsRankMap.get(id);
      const ftsScore = ftsRank !== undefined ? bm25RankToScore(ftsRank) : 0;
      const msRaw = msScoreMap.get(id) ?? 0;
      const msNorm = maxMs > 0 ? msRaw / maxMs : 0;
      const bm25Comp = Math.max(ftsScore, msNorm);

      const uTokens = new Set(tokenizeForFts(`${r.text} ${files.join(" ")} ${symbols.join(" ")}`));
      let overlap = 0;
      for (const t of qTokens) if (uTokens.has(t)) overlap++;
      const overlapScore = qTokens.size > 0 ? overlap / qTokens.size : 0;

      let hasFileMatch = false;
      for (const f of files) {
        if (qFiles.has(f.toLowerCase()) || qFiles.has(path.basename(f).toLowerCase())) {
          hasFileMatch = true;
          break;
        }
      }
      let hasSymMatch = false;
      for (const s of symbols) {
        if (qSymbols.has(s.toLowerCase())) {
          hasSymMatch = true;
          break;
        }
      }
      const entityMatch = hasFileMatch || hasSymMatch ? 0.20 : 0;

      const pr = pagerankScores.get(id) ?? 0;
      const prBonus = Math.min(0.10, pr);

      let kindBonus = 0;
      if (r.kind === "decision" || r.kind === "fact" || r.kind === "procedure" || r.kind === "note") kindBonus = 0.08;
      else if (r.kind === "raw_legacy") kindBonus = -0.08;

      let base = 0.45 * bm25Comp + 0.20 * overlapScore + entityMatch + prBonus + kindBonus;

      const ageDays = r.recorded_at ? (now - new Date(r.recorded_at).getTime()) / 86400000 : 0;
      const isEpisodic = r.kind === "episode" || r.kind === "raw_legacy";
      const decay = isEpisodic ? Math.exp(-0.015 * ageDays) : Math.exp(-0.003 * ageDays);
      let score = base * decay;

      let stale = false;
      for (const f of files) {
        if (typeof f === "string" && f.includes("/") && !existsSync(path.join(cwd, f))) {
          stale = true;
          break;
        }
      }
      if (stale) score *= 0.6;

      let text = r.text;
      if (!text.startsWith(`${r.kind}:`)) text = `${r.kind}: ${text}`;

      scored.push({
        id: r.id,
        kind: r.kind,
        text,
        l0: r.l0,
        files,
        symbols,
        score: Number(score.toFixed(4)),
      });
    }

    // Fallback
    if (scored.length === 0) {
      const rows = db
        .prepare(`SELECT id, kind, text, l0, files_json, symbols_json, session_id, recorded_at FROM memory_units ${includeInvalidated ? "" : "WHERE invalidated_at IS NULL"} ORDER BY recorded_at DESC LIMIT ?`)
        .all(topK * 6) as Array<any>;
      for (const r of rows) {
        if (excludeSession && r.session_id === excludeSession) continue;
        if (excludeIds && excludeIds.has(r.id)) continue;
        const files = JSON.parse(r.files_json || "[]");
        const symbols = JSON.parse(r.symbols_json || "[]");
        const uTokens = new Set(tokenizeForFts(r.text));
        let overlap = 0;
        for (const t of qTokens) if (uTokens.has(t)) overlap++;
        if (overlap === 0 && qTokens.size > 0 && !hasRecallCue && strippedTokens.length > 0) continue;
        let text = r.text;
        if (!text.startsWith(`${r.kind}:`)) text = `${r.kind}: ${text}`;
        scored.push({
          id: r.id,
          kind: r.kind,
          text,
          l0: r.l0,
          files,
          symbols,
          score: Number((overlap > 0 ? 0.1 + overlap * 0.05 : 0.05).toFixed(4)),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // episodic cap: at most min(2, floor(2/5 * topK)) returned items may come from episodic/legacy records; remaining >=3/5 slots reserved for structured facts
    const episodicCap = Math.min(2, Math.floor((topK * 2) / 5));
    let episodicCount = 0;
    const top: any[] = [];
    for (const s of scored) {
      const isEpi = s.kind === "episode" || s.kind === "raw_legacy";
      // Hard cap: never admit more than episodicCap episodes/legacy, even when
      // facts are scarce. The result is then deliberately shorter than topK
      // rather than backfilled with episodes.
      if (isEpi && episodicCount >= episodicCap) continue;
      top.push(s);
      if (isEpi) episodicCount++;
      if (top.length >= topK) break;
    }

    const evidence: Evidence[] = top.map((h) => ({
      id: h.id,
      text: h.text,
      score: h.score,
      l0: h.l0,
      files: h.files,
      symbols: h.symbols,
      kind: h.kind,
    }));

    let answer: string | undefined;
    let answerStatus: QueryResult["answerStatus"] = "not_requested";
    let readerError: string | undefined;
    if (opts.answer) {
      answerStatus = "evidence_only";
      if (!opts.reader?.apiKey) {
        readerError = "missing_reader_api_key";
        answer = evidence.map((e) => e.text).join("\n");
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        timer.unref?.();
        try {
          const baseUrl = (opts.reader.baseUrl ?? DEFAULT_READER_BASE_URL).replace(/\/+$/, "");
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.reader.apiKey}` },
            body: JSON.stringify({
              model: opts.reader.model ?? DEFAULT_READER_MODEL,
              messages: [
                { role: "system", content: "Answer from evidence." },
                { role: "user", content: `${question}\n\n${evidence.map((e) => e.text).join("\n")}` },
              ],
            }),
            signal: controller.signal,
          });
          if (res.ok) {
            const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const completion = json.choices?.[0]?.message?.content;
            if (typeof completion === "string" && completion.trim().length > 0) {
              answer = completion;
              answerStatus = "synthesized";
            } else {
              readerError = "empty_completion";
              answer = evidence.map((e) => e.text).join("\n");
            }
          } else {
            readerError = `http_${res.status}`;
            answer = evidence.map((e) => e.text).join("\n");
          }
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          readerError = raw.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]").slice(0, 200);
          answer = evidence.map((e) => e.text).join("\n");
        } finally {
          clearTimeout(timer);
        }
      }
    }

    return {
      ok: true,
      evidence,
      ...(answer ? { answer } : {}),
      answerStatus,
      ...(readerError ? { readerError } : {}),
    };
  }

  async stats(cwd: string): Promise<Record<string, unknown>> {
    this.openDb(cwd);
    const units = readUnits(cwd).length;
    return { ok: true, dataset: datasetName(cwd), units, engine: "node:sqlite+fts5-bm25" };
  }

  hasCodeEntityMatch(cwd: string, prompt: string): boolean {
    return hasCodeEntityMatch(cwd, prompt);
  }

  close(): void {
    for (const db of this.dbs.values()) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    this.dbs.clear();
    this.closed += 1;
  }
}

export function hasCodeEntityMatch(cwd: string, prompt: string): boolean {
  if (!storeExists(cwd)) return false;
  const entities = extractCodeEntities(prompt);
  if (entities.files.length === 0 && entities.symbols.length === 0) return false;
  const key = corpusPath(cwd);
  const fp = corpusFingerprint(cwd);
  let cached = entityCache.get(key);
  if (!cached || cached.fp !== fp) {
    const fileSet = new Set<string>();
    const symbolSet = new Set<string>();
    const dbFile = dbPath(cwd);
    let loadedFromSql = false;
    if (existsSync(dbFile)) {
      try {
        const db = new DatabaseSync(dbFile);
        try {
          const meta = db.prepare("SELECT value FROM memory_meta WHERE key = 'fingerprint'").get() as
            | { value?: string }
            | undefined;
          if (meta?.value === fp) {
            const fRows = db.prepare("SELECT file, basename FROM memory_files").all() as Array<{
              file: string;
              basename: string;
            }>;
            const sRows = db.prepare("SELECT symbol FROM memory_symbols").all() as Array<{ symbol: string }>;
            for (const r of fRows) {
              fileSet.add(r.file);
              fileSet.add(r.basename);
            }
            for (const r of sRows) symbolSet.add(r.symbol);
            loadedFromSql = true;
          }
        } finally {
          db.close();
        }
      } catch {
        // fallback to units.jsonl scan
      }
    }
    if (!loadedFromSql) {
      const units = readUnits(cwd);
      for (const u of units) {
        const ents =
          u.files !== undefined && u.symbols !== undefined
            ? { files: u.files, symbols: u.symbols }
            : extractCodeEntities(u.text);
        for (const f of ents.files) {
          fileSet.add(f.toLowerCase());
          fileSet.add(path.basename(f).toLowerCase());
        }
        for (const s of ents.symbols) {
          symbolSet.add(s.toLowerCase());
        }
      }
    }
    cached = { fp, files: fileSet, symbols: symbolSet };
    entityCache.set(key, cached);
  }
  for (const f of entities.files) {
    if (cached.files.has(f.toLowerCase()) || cached.files.has(path.basename(f).toLowerCase())) return true;
  }
  for (const s of entities.symbols) {
    if (cached.symbols.has(s.toLowerCase())) return true;
  }
  return false;
}
