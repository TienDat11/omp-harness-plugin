/**
 * migrate-memory.mjs — copy omp's memory backends into Zero-Mem stores.
 *
 *   local:   ~/.omp/agent/memories/<mangled-cwd>/MEMORY.md,
 *            memory_summary.md, learned.md, rollout_summaries/*.md,
 *            skills/<name>/SKILL.md
 *   mnemopi: ~/.omp/agent/memories/mnemopi/banks/<bank>/mnemopi.db
 *            (working_memory + episodic_memory, project from metadata_json.cwd)
 *
 * Target: <project>/.omp/memory/zero-mem/<dataset>/units.jsonl — the same file
 * the extension appends to, so no re-index step is needed.
 *
 * Dry run by default. `--apply` writes. `--purge` deletes the omp sources after
 * a successful write (requires --apply).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".omp", "agent");
const MEMORIES = path.join(AGENT_DIR, "memories");
const MIN_UNIT = 40;
const MAX_UNIT = 4000;
const MAX_UNITS_PER_PROJECT = 3000;

const argv = new Set(process.argv.slice(2));
const APPLY = argv.has("--apply");
const PURGE = argv.has("--purge");
const VERBOSE = argv.has("--verbose");

function unitId(kind, text) {
  return createHash("sha256").update(`${kind}\u0000${text}`, "utf8").digest("hex").slice(0, 16);
}

function datasetFor(cwd) {
  const base = path.basename(path.resolve(cwd)) || "root";
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

/**
 * `--c--users-admin-tmp--` -> `C:\Users\ADMIN\tmp`, `--d--chunking-husc-admission-chat-enrollment--`
 * -> `D:\chunking\husc-admission-chat-enrollment`. omp joins path segments with a
 * single `-`, so a segment that contains a `-` is indistinguishable from a
 * separator: resolve by walking the real filesystem and taking the first split
 * whose every prefix exists. Only existing directories are ever returned.
 */
function unmangle(name) {
  const m = /^--([a-z])--(.*)--$/.exec(name);
  if (!m) return null;
  const root = `${m[1].toUpperCase()}:\\`;
  if (!existsSync(root)) return null;
  const tokens = m[2].split("-").filter(Boolean);
  if (tokens.length === 0) return root;

  const walk = (base, index) => {
    if (index >= tokens.length) return base;
    for (let end = tokens.length; end > index; end -= 1) {
      const segment = tokens.slice(index, end).join("-");
      const candidate = path.join(base, segment);
      let isDir = false;
      try {
        isDir = statSync(candidate).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const found = walk(candidate, end);
      if (found) return found;
    }
    return null;
  };
  return walk(root, 0);
}

function splitChunks(text, kind, at, session) {
  const units = [];
  const clean = text.replace(/\r\n/g, "\n").trim();
  for (const paragraph of clean.split(/\n{2,}/)) {
    let body = paragraph.replace(/[ \t]+/g, " ").trim();
    while (body.length > MAX_UNIT) {
      const cut = body.lastIndexOf("\n", MAX_UNIT);
      const head = body.slice(0, cut > MIN_UNIT ? cut : MAX_UNIT);
      body = body.slice(head.length).trim();
      if (head.trim().length >= MIN_UNIT) units.push({ kind, text: head.trim(), at, session });
    }
    if (body.length >= MIN_UNIT) units.push({ kind, text: body, at, session });
  }
  return units;
}

function stamp(file) {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function localSources() {
  const out = [];
  if (!existsSync(MEMORIES)) return out;
  for (const entry of readdirSync(MEMORIES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MEMORIES, entry.name);
    const cwd = unmangle(entry.name);
    if (!cwd) continue;
    const units = [];
    const files = [
      ["MEMORY.md", "fact"],
      ["memory_summary.md", "note"],
      ["learned.md", "procedure"],
    ];
    for (const [file, kind] of files) {
      const full = path.join(dir, file);
      if (!existsSync(full)) continue;
      units.push(...splitChunks(readFileSync(full, "utf8"), kind, stamp(full), `omp:${entry.name}:${file}`));
    }
    const rollouts = path.join(dir, "rollout_summaries");
    if (existsSync(rollouts)) {
      for (const file of readdirSync(rollouts).sort()) {
        const full = path.join(rollouts, file);
        units.push(...splitChunks(readFileSync(full, "utf8"), "note", stamp(full), `omp:${file}`));
      }
    }
    const skills = path.join(dir, "skills");
    if (existsSync(skills)) {
      for (const skill of readdirSync(skills, { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const full = path.join(skills, skill.name, "SKILL.md");
        if (!existsSync(full)) continue;
        const body = readFileSync(full, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
        units.push(...splitChunks(body, "procedure", stamp(full), `omp:skill:${skill.name}`));
      }
    }
    out.push({ cwd, origin: `local:${entry.name}`, units });
  }
  return out;
}

export { datasetFor, unmangle, splitChunks, unitId, localSources };

/**
 * A recorded cwd may be a deleted worktree. Map it to the deepest ancestor that
 * still exists, so its notes land in the project container that owns it. A path
 * with no existing ancestor is unmappable and skipped.
 */
function projectRootFor(cwd) {
  let current = path.resolve(cwd);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function mnemopiSources() {
  const out = [];
  const base = path.join(MEMORIES, "mnemopi", "banks");
  if (!existsSync(base)) return out;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbFile = path.join(base, entry.name, "mnemopi.db");
    if (!existsSync(dbFile)) continue;
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
    } catch {
      continue;
    }
    const rows = [];
    for (const table of ["working_memory", "episodic_memory"]) {
      try {
        rows.push(...db.prepare(`select content, timestamp, metadata_json from ${table}`).all());
      } catch {
        // Table absent in an older bank; skip it.
      }
    }
    db.close();
    const byCwd = new Map();
    for (const row of rows) {
      if (typeof row.content !== "string" || row.content.length === 0) continue;
      let cwd = null;
      try {
        const meta = JSON.parse(String(row.metadata_json ?? "{}"));
        if (typeof meta.cwd === "string" && meta.cwd.length > 0) cwd = meta.cwd;
      } catch {
        // No usable metadata.
      }
      const root = cwd ? projectRootFor(cwd) : null;
      if (!root) continue;
      const at = typeof row.timestamp === "string" ? row.timestamp : new Date(0).toISOString();
      const list = byCwd.get(root) ?? [];
      list.push(...splitChunks(row.content, "note", at, `mnemopi:${entry.name}`));
      byCwd.set(root, list);
    }
    for (const [cwd, units] of byCwd) {
      out.push({ cwd, origin: `mnemopi:${entry.name}`, units });
    }
  }
  return out;
}

export { mnemopiSources };

function writeUnits(cwd, units) {
  const dir = path.join(cwd, ".omp", "memory", "zero-mem", datasetFor(cwd));
  const file = path.join(dir, "units.jsonl");
  const known = new Set();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.id === "string") known.add(parsed.id);
      } catch {
        // torn line
      }
    }
  }
  const fresh = [];
  for (const unit of units) {
    const id = unitId(unit.kind, unit.text);
    if (known.has(id)) continue;
    known.add(id);
    fresh.push({ id, kind: unit.kind, text: unit.text, at: unit.at, session: unit.session });
  }
  if (APPLY && fresh.length > 0) {
    mkdirSync(dir, { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const payload = fresh.map((unit) => `${JSON.stringify(unit)}\n`).join("");
    writeFileSync(file, existing + prefix + payload, "utf8");
  }
  return { file, added: fresh.length };
}

function purgeSources(origins) {
  const removed = [];
  for (const origin of origins) {
    const [kind, name] = origin.split(/:(.*)/s);
    let target;
    if (kind === "local") target = path.join(MEMORIES, name);
    else if (kind === "mnemopi") target = path.join(MEMORIES, "mnemopi", "banks", name);
    else continue;
    if (!existsSync(target)) continue;
    if (!APPLY) {
      removed.push(`${target} (dry run)`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

function rankOf(origin) {
  if (origin.startsWith("local:")) return 0;
  return 1;
}

function main() {
  const sources = [...localSources(), ...mnemopiSources()];
  const byCwd = new Map();
  for (const source of sources) {
    const bucket = byCwd.get(source.cwd) ?? { units: [], origins: new Set() };
    bucket.units.push(...source.units.map((unit) => ({ ...unit, rank: rankOf(source.origin) })));
    bucket.origins.add(source.origin);
    byCwd.set(source.cwd, bucket);
  }

  let totalUnits = 0;
  let totalAdded = 0;
  const origins = new Set();
  for (const [cwd, bucket] of [...byCwd].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Keep the most distilled units when a project exceeds the cap: curated
    // memory first, then lessons/skills, then rollout notes, then raw traces.
    const ordered = bucket.units
      .map((unit, index) => ({ unit, index }))
      .sort((a, b) => a.unit.rank - b.unit.rank || a.index - b.index)
      .map((entry) => entry.unit)
      .slice(0, MAX_UNITS_PER_PROJECT);
    const { file, added } = writeUnits(cwd, ordered);
    totalUnits += ordered.length;
    totalAdded += added;
    for (const origin of bucket.origins) origins.add(origin);
    const dropped = bucket.units.length - ordered.length;
    console.log(
      `${added.toString().padStart(5)} new / ${ordered.length.toString().padStart(5)} units  ${cwd}  -> ${file}${dropped > 0 ? `  (capped, ${dropped} dropped)` : ""}${VERBOSE ? `  [${[...bucket.origins].join(", ")}]` : ""}`,
    );
  }
  console.log(`\ntotal: ${totalAdded} new units from ${totalUnits} candidate units across ${byCwd.size} projects`);
  if (!APPLY) {
    console.log("dry run: nothing written (pass --apply)");
    return;
  }
  if (!PURGE) {
    console.log("sources kept (pass --purge to delete them after a successful write)");
    return;
  }
  const removed = purgeSources(origins);
  console.log(`purged ${removed.length} source(s):`);
  for (const item of removed) console.log(`  ${item}`);
}

main();
