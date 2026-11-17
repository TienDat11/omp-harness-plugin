/**
 * ontology.ts — in-process domain ontology (NVIDIA Auto-Ontology, adapted).
 *
 * Four mechanisms, all deterministic and container-free:
 *   A. Two-pass compilation: catalog + cross-file join verification.
 *   B. Fast entity-coverage gate (never compiles on the hot path).
 *   C. Certified-term retrieval boost, consumed by ZeroMemBridge.query().
 *   D. Apache Ossie-compatible YAML export/import.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VI_EN_TERMS } from "./skill-specs.ts";
import { writeTextFileAtomic } from "./state.ts";
import {
  dbPath,
  extractCodeEntities,
  tokenizeForFts,
  projectRoot,
  withMemoryDb,
} from "./zeromem.ts";

export type OntologyTermKind = "module" | "domain-concept" | "tool-contract" | "config-surface";
export type OntologyRelationKind = "imports" | "calls" | "tests" | "configures";

export interface OntologyTermRecord {
  termId: string;
  name: string;
  kind: OntologyTermKind;
  description: string;
  synonyms: string[];
  physicalFiles: string[];
  physicalSymbols: string[];
  certified: boolean;
  certifiedBy: string | null;
  updatedAt: string;
}

export interface OntologyRelationRecord {
  srcTermId: string;
  dstTermId: string;
  relKind: OntologyRelationKind;
  evidence: string;
  verified: boolean;
}

export interface CompileOntologyOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  exportYaml?: boolean;
}

export interface CompileOntologyResult {
  termsCount: number;
  certifiedCount: number;
  verifiedRelationsCount: number;
  queriesCount: number;
  yamlPath?: string;
}

export interface OntologyCoverageResult {
  coverage: number;
  answerable: boolean;
  threshold: number;
  extractedEntities: string[];
  matchedTermIds: string[];
  matchedTerms: OntologyTermRecord[];
  verifiedRelations: OntologyRelationRecord[];
  uncoveredEntities: string[];
}

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_FILE_BYTES = 65_536;
const SCAN_DIRS = ["src", "scripts", "skills", "agents", "py", "config", "tests"];
const CODE_EXTENSIONS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".mts": true, ".js": true, ".mjs": true, ".cjs": true,
  ".py": true, ".md": true, ".yml": true, ".yaml": true,
};

const ONTOLOGY_STOPWORDS: Record<string, true> = {
  fix: true, add: true, update: true, plan: true, check: true, run: true, create: true, make: true,
  use: true, test: true, file: true, code: true, query: true, and: true, or: true, the: true,
  with: true, from: true, into: true, for: true, in: true, on: true, to: true, of: true, by: true,
  is: true, are: true, be: true, this: true, that: true, function: true, method: true, class: true,
  module: true, it: true, as: true, at: true,
};

export function slugifyTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "term";
}

function camelToWords(stem: string): string[] {
  const spaced = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return [...new Set(spaced.toLowerCase().split(/\s+/).filter((w) => w.length >= 3))];
}

function viAliases(stem: string): string[] {
  const folded = stem.toLowerCase();
  const out: string[] = [];
  for (const [vi, en] of Object.entries(VI_EN_TERMS)) {
    const words = en.split(/\s+/);
    if (words.some((w) => w === folded || folded.includes(w))) out.push(vi);
  }
  return out.slice(0, 4);
}

const SYMBOL_RE_TS = /\bexport\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const SYMBOL_RE_PY = /^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^;\n]*?from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|from\s+(\S+)\s+import\s)/g;

interface ScannedFile {
  relPath: string;
  text: string;
  symbols: string[];
}

function isCodeFile(name: string): boolean {
  return path.extname(name).toLowerCase() in CODE_EXTENSIONS;
}

function scanFiles(root: string, maxFiles: number, maxBytes: number): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor") continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!isCodeFile(entry) || stat.size > maxBytes) continue;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const symbols = new Set<string>();
      if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".mts") || entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".cjs")) {
        for (const m of text.matchAll(SYMBOL_RE_TS)) symbols.add(m[1]);
      } else if (entry.endsWith(".py")) {
        for (const m of text.matchAll(SYMBOL_RE_PY)) symbols.add(m[1]);
      }
      // Physical symbols are the term's own exports; a merely referenced name
      // belongs to the term that defines it, not to the importing file.
      out.push({
        relPath: path.relative(root, full).split(path.sep).join("/"),
        text,
        symbols: [...symbols].sort().slice(0, 64),
      });
    }
  };
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir);
    if (existsSync(full)) walk(full);
    if (out.length >= maxFiles) break;
  }
  return out;
}

function rowToTerm(row: {
  term_id: string;
  name: string;
  kind: string;
  description: string;
  synonyms_json: string;
  physical_files_json: string;
  physical_symbols_json: string;
  certified: number;
  certified_by: string | null;
  updated_at: string;
}): OntologyTermRecord {
  return {
    termId: row.term_id,
    name: row.name,
    kind: row.kind as OntologyTermKind,
    description: row.description,
    synonyms: JSON.parse(row.synonyms_json || "[]"),
    physicalFiles: JSON.parse(row.physical_files_json || "[]"),
    physicalSymbols: JSON.parse(row.physical_symbols_json || "[]"),
    certified: row.certified === 1,
    certifiedBy: row.certified_by,
    updatedAt: row.updated_at,
  };
}

function readTerms(db: DatabaseSync, certifiedOnly = false): OntologyTermRecord[] {
  const sql = certifiedOnly
    ? "SELECT * FROM ontology_terms WHERE certified = 1 ORDER BY term_id"
    : "SELECT * FROM ontology_terms ORDER BY term_id";
  return (db.prepare(sql).all() as Array<Parameters<typeof rowToTerm>[0]>).map(rowToTerm);
}

export function compileOntology(cwd: string, opts: CompileOntologyOptions = {}): CompileOntologyResult {
  const root = projectRoot(cwd);
  const files = scanFiles(root, opts.maxFiles ?? DEFAULT_MAX_FILES, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const nowIso = new Date().toISOString();

  const termByFile = new Map<string, string>();
  const terms: OntologyTermRecord[] = [];
  for (const file of files) {
    const stem = path.basename(file.relPath, path.extname(file.relPath));
    if (!stem || stem.startsWith(".")) continue;
    const termId = `term:${slugifyTerm(stem)}`;
    const existing = termByFile.get(file.relPath);
    if (existing) {
      const term = terms.find((t) => t.termId === existing);
      if (term?.physicalSymbols) {
        for (const s of file.symbols) if (!term.physicalSymbols.includes(s)) term.physicalSymbols.push(s);
      }
      continue;
    }
    termByFile.set(file.relPath, termId);
    terms.push({
      termId,
      name: stem,
      kind: file.relPath.startsWith("src/") ? "module" : file.relPath.startsWith("skills/") ? "domain-concept" : "config-surface",
      description: `${file.relPath}${file.symbols.length > 0 ? ` — exports ${file.symbols.slice(0, 5).join(", ")}` : ""}`,
      synonyms: [...new Set([stem, slugifyTerm(stem), ...camelToWords(stem), ...viAliases(stem)])],
      physicalFiles: [file.relPath],
      physicalSymbols: file.symbols,
      certified: false,
      certifiedBy: null,
      updatedAt: nowIso,
    });
  }

  // Pass 2 — cross-file join verification.
  const byFile = new Map(terms.flatMap((t) => t.physicalFiles.map((f) => [f, t] as const)));
  const relations: OntologyRelationRecord[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const src = byFile.get(file.relPath);
    if (!src) continue;
    for (const m of file.text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || (!spec.startsWith(".") && !spec.startsWith("/"))) continue;
      const base = spec.startsWith("/") ? path.relative(root, spec) : path.join(path.dirname(file.relPath), spec);
      const resolved = base.split(path.sep).join("/").replace(/\/index$/, "");
      const alreadyExt = Object.keys(CODE_EXTENSIONS).some((ext) => resolved.endsWith(ext));
      const candidates = alreadyExt ? [resolved] : ["", ...Object.keys(CODE_EXTENSIONS)].map((ext) => `${resolved}${ext}`);
      const dst = candidates.map((c) => byFile.get(c.replace(/^\.\//, ""))).find(Boolean);
      if (!dst || dst.termId === src.termId) continue;
      const key = `${src.termId}\u0000${dst.termId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const symbolHit = dst.physicalSymbols.some((s) => file.text.includes(s));
      const specHit = file.text.includes(spec);
      relations.push({
        srcTermId: src.termId,
        dstTermId: dst.termId,
        relKind: "imports",
        evidence: symbolHit ? `${file.relPath} references ${dst.name} symbols` : `${file.relPath} imports ${spec}`,
        verified: symbolHit || specHit,
      });
    }
  }

  const testFiles = files.filter((f) => f.relPath.startsWith("tests/"));
  for (const term of terms) {
    const hit = testFiles.some(
      (t) => t.text.includes(term.name) || term.physicalSymbols.some((s) => t.text.includes(s)),
    );
    if (hit) {
      term.certified = true;
      term.certifiedBy = "test-suite";
    }
  }

  const queries = relations
    .filter((r) => r.verified)
    .slice(0, 200)
    .map((r) => ({
      queryId: `q:${slugifyTerm(r.srcTermId)}-${slugifyTerm(r.dstTermId)}`,
      termId: r.srcTermId,
      pattern: `${r.relKind} ${r.dstTermId}`,
      commandOrSql: `SELECT * FROM ontology_relations WHERE src_term_id = '${r.srcTermId}' AND dst_term_id = '${r.dstTermId}';`,
    }));

  const result = withMemoryDb(root, (db) => {
    const upsert = db.prepare(
      `INSERT INTO ontology_terms (term_id, name, kind, description, synonyms_json, physical_files_json, physical_symbols_json, certified, certified_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term_id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         description = excluded.description,
         synonyms_json = excluded.synonyms_json,
         physical_files_json = excluded.physical_files_json,
         physical_symbols_json = excluded.physical_symbols_json,
         certified = MAX(ontology_terms.certified, excluded.certified),
         certified_by = COALESCE(ontology_terms.certified_by, excluded.certified_by),
         updated_at = excluded.updated_at`,
    );
    const relInsert = db.prepare(
      `INSERT OR REPLACE INTO ontology_relations (src_term_id, dst_term_id, rel_kind, evidence, verified) VALUES (?, ?, ?, ?, ?)`,
    );
    const queryInsert = db.prepare(
      `INSERT OR REPLACE INTO ontology_queries (query_id, term_id, pattern, command_or_sql, hit_count, updated_at) VALUES (?, ?, ?, ?, COALESCE((SELECT hit_count + 1 FROM ontology_queries WHERE query_id = ?), 1), ?)`,
    );

    let certifiedCount = 0;
    let verifiedRelationsCount = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of terms) {
        upsert.run(
          t.termId,
          t.name,
          t.kind,
          t.description,
          JSON.stringify(t.synonyms),
          JSON.stringify(t.physicalFiles),
          JSON.stringify(t.physicalSymbols),
          t.certified ? 1 : 0,
          t.certifiedBy,
          t.updatedAt,
        );
      }
      for (const r of relations) {
        relInsert.run(r.srcTermId, r.dstTermId, r.relKind, r.evidence, r.verified ? 1 : 0);
        if (r.verified) verifiedRelationsCount++;
      }
      for (const q of queries) {
        queryInsert.run(q.queryId, q.termId, q.pattern, q.commandOrSql, q.queryId, nowIso);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const certRow = db.prepare("SELECT COUNT(*) AS c FROM ontology_terms WHERE certified = 1").get() as { c: number };
    certifiedCount = certRow.c;
    const queryRow = db.prepare("SELECT COUNT(*) AS c FROM ontology_queries").get() as { c: number };
    return {
      termsCount: terms.length,
      certifiedCount,
      verifiedRelationsCount,
      queriesCount: queryRow.c,
    };
  });

  const out: CompileOntologyResult = { ...result };
  if (opts.exportYaml === true) out.yamlPath = exportOntologyYaml(root);
  return out;
}

export function ontologyYamlPath(cwd: string): string {
  return path.join(projectRoot(cwd), ".omp", "ontology", "domain-ontology.yaml");
}

export function checkOntologyCoverage(
  cwd: string,
  text: string,
  opts: { threshold?: number; certifiedOnly?: boolean } = {},
): OntologyCoverageResult {
  const threshold = opts.threshold ?? 0.6;
  const empty: OntologyCoverageResult = {
    coverage: 1,
    answerable: true,
    threshold,
    extractedEntities: [],
    matchedTermIds: [],
    matchedTerms: [],
    verifiedRelations: [],
    uncoveredEntities: [],
  };
  if (!text || !text.trim()) return empty;
  const root = projectRoot(cwd);
  if (!existsSync(dbPath(root))) return empty;

  const ce = extractCodeEntities(text);
  const atomic = [...ce.files, ...ce.symbols];
  const atomicLower = atomic.map((a) => a.toLowerCase());
  const entities: string[] = [...new Set(atomic)];
  const tokenSet = new Set<string>();
  for (const token of text.matchAll(/[A-Za-z_][A-Za-z0-9_./-]*/g)) {
    const raw = token[0];
    const low = raw.toLowerCase();
    if (low.length < 4) continue;
    if (ONTOLOGY_STOPWORDS[low] === true) continue;
    if (atomicLower.some((a) => a.includes(low))) continue;
    tokenSet.add(low);
  }
  for (const t of tokenizeForFts(text)) {
    if (ONTOLOGY_STOPWORDS[t] === true) continue;
    if (atomicLower.some((a) => a.includes(t))) continue;
    tokenSet.add(t);
  }

  let terms: OntologyTermRecord[];
  let relations: OntologyRelationRecord[];
  try {
    const loaded = withMemoryDb(root, (db) => ({
      terms: readTerms(db, opts.certifiedOnly === true),
      relations: db
        .prepare("SELECT src_term_id, dst_term_id, rel_kind, evidence, verified FROM ontology_relations WHERE verified = 1")
        .all() as Array<{ src_term_id: string; dst_term_id: string; rel_kind: string; evidence: string; verified: number }>,
    }));
    terms = loaded.terms;
    relations = loaded.relations.map((r) => ({
      srcTermId: r.src_term_id,
      dstTermId: r.dst_term_id,
      relKind: r.rel_kind as OntologyRelationKind,
      evidence: r.evidence,
      verified: true,
    }));
  } catch {
    return empty;
  }
  if (terms.length === 0) return empty;

  for (const term of terms) {
    for (const alias of [term.name, ...term.synonyms]) {
      const low = alias.toLowerCase();
      if (low.length >= 4 && tokenSet.has(low)) entities.push(alias);
      if (low.length >= 4 && atomicLower.includes(low)) entities.push(alias);
    }
  }
  const uniqEntities = [...new Set(entities)];

  const matchesTerm = (entity: string, term: OntologyTermRecord): boolean => {
    const low = entity.toLowerCase();
    const base = path.basename(low);
    const stem = path.basename(low, path.extname(low));
    const pool = [term.name, ...term.synonyms, ...term.physicalSymbols].map((s) => s.toLowerCase());
    if (pool.includes(low) || pool.includes(base) || pool.includes(stem)) return true;
    return term.physicalFiles.some((f) => {
      const fl = f.toLowerCase();
      return fl === low || path.basename(fl) === base || path.basename(fl, path.extname(fl)) === stem;
    });
  };

  const matchedTerms: OntologyTermRecord[] = [];
  const uncoveredEntities: string[] = [];
  for (const entity of uniqEntities) {
    const hit = terms.find((t) => matchesTerm(entity, t));
    if (hit) {
      if (!matchedTerms.some((t) => t.termId === hit.termId)) matchedTerms.push(hit);
    } else {
      uncoveredEntities.push(entity);
    }
  }

  const coverage = uniqEntities.length === 0 ? 1 : Number((matchedTerms.length / uniqEntities.length).toFixed(4));
  const matchedIds = new Set(matchedTerms.map((t) => t.termId));
  return {
    coverage,
    answerable: coverage >= threshold,
    threshold,
    extractedEntities: uniqEntities,
    matchedTermIds: [...matchedIds],
    matchedTerms,
    verifiedRelations: relations.filter((r) => matchedIds.has(r.srcTermId) || matchedIds.has(r.dstTermId)).slice(0, 20),
    uncoveredEntities,
  };
}

export function certifyTermsForFiles(cwd: string, files: string[], certifiedBy = "harness_record"): number {
  if (!files || files.length === 0) return 0;
  const root = projectRoot(cwd);
  if (!existsSync(dbPath(root))) return 0;
  const wanted = new Set(files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()));
  const basenames = new Set([...wanted].map((f) => path.basename(f)));
  try {
    return withMemoryDb(root, (db) => {
      const terms = readTerms(db);
      const stale = db.prepare("UPDATE ontology_terms SET certified = 1, certified_by = ? WHERE term_id = ?");
      let n = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const term of terms) {
          if (term.certified) continue;
          const hit = term.physicalFiles.some((f) => {
            const fl = f.toLowerCase();
            return wanted.has(fl) || basenames.has(path.basename(fl));
          });
          if (!hit) continue;
          stale.run(certifiedBy, term.termId);
          n++;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return n;
    });
  } catch {
    return 0;
  }
}

export function exportOntologyYaml(cwd: string, outPath?: string): string {
  const root = projectRoot(cwd);
  const target = outPath ?? ontologyYamlPath(root);
  const payload = withMemoryDb(root, (db) => {
    const terms = readTerms(db);
    const relations = (
      db.prepare("SELECT src_term_id, dst_term_id, rel_kind, evidence, verified FROM ontology_relations ORDER BY src_term_id, dst_term_id").all() as Array<{
        src_term_id: string;
        dst_term_id: string;
        rel_kind: string;
        evidence: string;
        verified: number;
      }>
    ).map((r) => ({
      src_term_id: r.src_term_id,
      dst_term_id: r.dst_term_id,
      rel_kind: r.rel_kind,
      evidence: r.evidence,
      verified: r.verified === 1,
    }));
    const queries = db
      .prepare("SELECT query_id, term_id, pattern, command_or_sql, hit_count FROM ontology_queries ORDER BY query_id")
      .all() as Array<{ query_id: string; term_id: string; pattern: string; command_or_sql: string; hit_count: number }>;
    return {
      version: "1.0",
      schema: "apache-ossie-compatible",
      terms: terms.map((t) => ({
        term_id: t.termId,
        name: t.name,
        kind: t.kind,
        description: t.description,
        synonyms: t.synonyms,
        physical_files: t.physicalFiles,
        physical_symbols: t.physicalSymbols,
        certified: t.certified,
        certified_by: t.certifiedBy,
      })),
      relationships: relations,
      verified_queries: queries.map((q) => ({
        query_id: q.query_id,
        term_id: q.term_id,
        pattern: q.pattern,
        command_or_sql: q.command_or_sql,
        hit_count: q.hit_count,
      })),
    };
  });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const doc = `# Apache Ossie-compatible Domain Ontology v1.0\n${body}`;
  writeTextFileAtomic(target, doc);
  return target;
}

interface OntologyYamlDocument {
  version?: string;
  terms?: Array<{
    term_id?: string;
    name?: string;
    kind?: string;
    description?: string;
    synonyms?: string[];
    physical_files?: string[];
    physical_symbols?: string[];
    certified?: boolean;
    certified_by?: string | null;
  }>;
  relationships?: Array<{
    src_term_id?: string;
    dst_term_id?: string;
    rel_kind?: string;
    evidence?: string;
    verified?: boolean;
  }>;
  verified_queries?: Array<{
    query_id?: string;
    term_id?: string;
    pattern?: string;
    command_or_sql?: string;
    hit_count?: number;
  }>;
}

export function importOntologyYaml(cwd: string, inPath?: string): CompileOntologyResult {
  const root = projectRoot(cwd);
  const source = inPath ?? ontologyYamlPath(root);
  const raw = readFileSync(source, "utf8");
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) throw new Error(`ontology yaml is not a JSON-compatible document: ${source}`);
  const doc = JSON.parse(raw.slice(jsonStart)) as OntologyYamlDocument;
  const nowIso = new Date().toISOString();

  return withMemoryDb(root, (db) => {
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO ontology_terms (term_id, name, kind, description, synonyms_json, physical_files_json, physical_symbols_json, certified, certified_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const relInsert = db.prepare(
      `INSERT OR REPLACE INTO ontology_relations (src_term_id, dst_term_id, rel_kind, evidence, verified) VALUES (?, ?, ?, ?, ?)`,
    );
    const queryInsert = db.prepare(
      `INSERT OR REPLACE INTO ontology_queries (query_id, term_id, pattern, command_or_sql, hit_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let termsCount = 0;
    let certifiedCount = 0;
    let verifiedRelationsCount = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of doc.terms ?? []) {
        if (!t.term_id || !t.name) continue;
        upsert.run(
          t.term_id,
          t.name,
          t.kind ?? "module",
          t.description ?? "",
          JSON.stringify(t.synonyms ?? []),
          JSON.stringify(t.physical_files ?? []),
          JSON.stringify(t.physical_symbols ?? []),
          t.certified ? 1 : 0,
          t.certified_by ?? null,
          nowIso,
        );
        termsCount++;
        if (t.certified) certifiedCount++;
      }
      for (const r of doc.relationships ?? []) {
        if (!r.src_term_id || !r.dst_term_id) continue;
        relInsert.run(r.src_term_id, r.dst_term_id, r.rel_kind ?? "imports", r.evidence ?? "", r.verified ? 1 : 0);
        if (r.verified) verifiedRelationsCount++;
      }
      for (const q of doc.verified_queries ?? []) {
        if (!q.query_id || !q.term_id) continue;
        queryInsert.run(q.query_id, q.term_id, q.pattern ?? "", q.command_or_sql ?? "", q.hit_count ?? 1, nowIso);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    const queryRow = db.prepare("SELECT COUNT(*) AS c FROM ontology_queries").get() as { c: number };
    return { termsCount, certifiedCount, verifiedRelationsCount, queriesCount: queryRow.c };
  });
}

export function formatOntologyBrief(result: OntologyCoverageResult, maxChars = 1600): string {
  const lines: string[] = [];
  lines.push(`coverage=${result.coverage} answerable=${result.answerable} threshold=${result.threshold}`);
  if (result.matchedTerms.length > 0) {
    lines.push("terms:");
    for (const t of result.matchedTerms.slice(0, 12)) {
      lines.push(`- ${t.termId} (${t.name})${t.certified ? " [certified]" : ""} files=${t.physicalFiles.slice(0, 3).join(",")}`);
    }
  }
  if (result.verifiedRelations.length > 0) {
    lines.push("verified-relations:");
    for (const r of result.verifiedRelations.slice(0, 8)) {
      lines.push(`- ${r.srcTermId} -> ${r.dstTermId} (${r.relKind})`);
    }
  }
  if (result.uncoveredEntities.length > 0) {
    lines.push(`uncovered: ${result.uncoveredEntities.slice(0, 12).join(", ")}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
