#!/usr/bin/env node
/**
 * run-probes.mjs — deterministic probe runner for the omp harness measurement layer.
 *
 * Arms differ ONLY by the harness config overlay under test:
 *   baseline  = source ~/.omp/agent/{config.yml,models.yml} copied verbatim
 *   candidate = same copy, with config/recommended.yml merged over it (only overlay keys change)
 * Model routing must stay identical; a routing-equality preflight enforces that.
 *
 * Usage:
 *   node scripts/run-probes.mjs [--split all|in|out] [--probe <id>] [--repeats N]
 *                              [--profile-prefix P] [--record-baseline] [--cleanup] [--json]
 *   node scripts/run-probes.mjs --dry-run
 *   node scripts/run-probes.mjs --help
 *
 * Exit codes: 0 all graded probes passed; 1 at least one graded probe failed; 2 setup/measurement error.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, statSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionText, resolveBranch, aggregate, cacheReuse, listWorkerSessions, childRouting } from "../src/telemetry.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBES_DIR = path.join(REPO, "probes");
const FIXTURES_DIR = path.join(PROBES_DIR, "fixtures");
const HOME_DIR = (process.env.HOME || process.env.USERPROFILE || os.homedir() || "").trim();
function resolveOmpBin() {
  if (process.env.OMP_BIN) return process.env.OMP_BIN;
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [process.platform === "win32" ? "omp.exe" : "omp"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const out = (r.stdout || "").trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {}
  return "";
}
const PROFILES_ROOT = path.join(HOME_DIR, ".omp", "profiles");
const OMP_BIN = resolveOmpBin();
const SOURCE_AGENT_DIR = path.join(HOME_DIR, ".omp", "agent");
const CANDIDATE_OVERLAY = path.join(REPO, "config", "recommended.yml");
const EXEC_TIMEOUT_MS = 600000;
const ROUTING_KEYS = ["modelRoles", "task.agentModelOverrides", "retry.fallbackChains"];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--split") args.split = argv[++i];
    else if (a === "--repeats") args.repeats = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--profile-prefix") args.profilePrefix = argv[++i];
    else if (a === "--probe") args.probe = argv[++i];
    else if (a === "--record-baseline") args.recordBaseline = true;
    else if (a === "--from-results") args.fromResults = argv[++i];
    else if (a === "--cleanup") args.cleanup = true;
    else if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/run-probes.mjs [--split all|in|out] [--probe <id>] [--repeats N] [--profile-prefix P] [--record-baseline] [--cleanup] [--json]",
    "",
    "Options:",
    "  --split <all|in|out>   Which splits to run (default: all)",
    "  --probe <id>            Run only the probe with this exact id",
    "  --repeats <n>           Repetitions per probe (default: 2)",
    "  --profile-prefix <p>   Isolated profile prefix (default: omp-harness-probe-<runId>)",
    "  --record-baseline       Write probes/baseline.json from the BASELINE profile",
    "  --from-results <file>  Re-aggregate an existing results file (no sessions run); use with --record-baseline",
    "  --cleanup               Remove the run's two profiles after reporting",
    "  --json                   Emit machine-readable JSON to stdout",
    "  --dry-run                Provision nothing; print commands that WOULD run",
    "  --help                   Show this usage",
    "",
    "Arms: baseline = verbatim config copy; candidate = same copy + config/recommended.yml merged.",
    "Model routing (modelRoles, task.agentModelOverrides, retry.fallbackChains) must match across arms.",
  ].join("\n");
}

function redact(text) {
  return String(text ?? "")
    .replace(/apiKey|api_key/gi, "***REDACTED***")
    .replace(/token|secret|password|Authorization|cookie/gi, "***REDACTED***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "***REDACTED***")
    .replace(/AKIA[0-9A-Z]+/g, "***REDACTED***")
    .replace(/-----BEGIN[A-Z ]*-----/g, "***REDACTED***")
    .replace(/ghp_[A-Za-z0-9_]+/g, "***REDACTED***")
    .replace(/xox-[A-Za-z0-9_-]*/g, "***REDACTED***");
}

// Run a child with stdin closed ('ignore'): an omp -p session never blocks on an EOF read,
// so a one-turn run can finish instead of waiting forever for interactive input.
function runChild(file, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    };
    const child = spawn(file, args, {
      cwd: opts.cwd || process.cwd(),
      shell: opts.shell === true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        } else {
          try { process.kill(-child.pid, "SIGTERM"); } catch { try { process.kill(child.pid, "SIGTERM"); } catch {} }
        }
      } catch {}
      try { child.kill("SIGKILL"); } catch {}
    }, EXEC_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { err += String(e); done(-1); });
    child.on("close", (code) => done(typeof code === "number" ? code : code == null ? 1 : 0));
  });
}

function execShell(cmd, cwd) {
  return runChild(cmd, [], { cwd, shell: true });
}

async function execFileOmp(args, cwd) {
  return runChild(OMP_BIN, args, { cwd });
}

async function runOmpSession(profile, cwd, prompt) {
  const argv = ["--profile", profile, "-p", "--cwd", cwd, prompt];
  const started = Date.now();
  const r = await runChild(OMP_BIN, argv, { cwd });
  return { ...r, wallMs: Date.now() - started };
}

// ---- YAML overlay merge (maps + scalars only; the overlay has no lists/anchors) ----

function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function unquote(v) {
  const t = String(v).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

const KEY_RE = /^(\s*)([A-Za-z_][\w.-]*)\s*:(.*)$/;

function parseEntries(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const stack = [];
  lines.forEach((raw, idx) => {
    const line = stripComment(raw);
    if (!line.trim()) return;
    if (/^\s*-/.test(line)) return; // list item: not part of the map tree
    const m = KEY_RE.exec(line);
    if (!m) return;
    const indent = m[1].length;
    const depth = Math.floor(indent / 2);
    const key = m[2];
    const value = m[3].trim();
    while (stack.length > depth) stack.pop();
    const p = [...stack.map((s) => s.key), key];
    const entry = { idx, indent, depth, key, value, path: p, container: value === "" };
    entries.push(entry);
    if (entry.container) {
      while (stack.length > depth) stack.pop();
      stack.push({ key, depth });
    }
  });
  return { lines, entries };
}

function overlayLeaves(overlayText) {
  const { entries } = parseEntries(overlayText);
  return entries.filter((e) => !e.container).map((e) => ({ path: e.path, value: unquote(e.value) }));
}

function containerBlockEnd(lines, entry) {
  let end = entry.idx;
  for (let i = entry.idx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= entry.indent) break;
    end = i;
  }
  return end;
}

// Merge overlay leaves into base text. Only the overlay's own keys change; comments elsewhere survive.
function mergeOverlay(baseText, overlayText) {
  const { lines, entries } = parseEntries(baseText);
  const byPath = new Map(entries.map((e) => [e.path.join("."), e]));
  const leaves = overlayLeaves(overlayText);
  const changed = [];
  // Apply deepest-first so earlier insertions do not shift later targets.
  const inserts = new Map(); // lineIdx -> array of new lines
  for (const leaf of leaves) {
    const keyPath = leaf.path.join(".");
    const existing = byPath.get(keyPath);
    if (existing && !existing.container) {
      const indent = " ".repeat(existing.indent);
      lines[existing.idx] = `${indent}${existing.key}: ${leaf.value}`;
      changed.push(keyPath);
      continue;
    }
    // Need to create the chain (or just the leaf) under the nearest existing ancestor.
    let parentPath = leaf.path.slice(0, -1);
    let parent = null;
    while (parentPath.length > 0) {
      const cand = byPath.get(parentPath.join("."));
      if (cand && cand.container) { parent = cand; break; }
      parentPath = parentPath.slice(0, -1);
    }
    const missing = leaf.path.slice(parentPath.length);
    if (parent) {
      const end = containerBlockEnd(lines, parent);
      const indent = parent.indent + 2;
      const block = [];
      missing.forEach((k, i) => {
        const isLeaf = i === missing.length - 1;
        const pad = " ".repeat(indent + i * 2);
        block.push(isLeaf ? `${pad}${k}: ${leaf.value}` : `${pad}${k}:`);
      });
      if (!inserts.has(end)) inserts.set(end, []);
      inserts.get(end).push(...block);
      changed.push(keyPath);
    } else {
      const block = missing.map((k, i) => {
        const isLeaf = i === missing.length - 1;
        return isLeaf ? `${k}: ${leaf.value}` : `${k}:`;
      });
      const end = lines.length - 1;
      if (!inserts.has(end)) inserts.set(end, []);
      inserts.get(end).push(...block);
      changed.push(keyPath);
    }
  }
  const out = [];
  lines.forEach((line, idx) => {
    out.push(line);
    if (inserts.has(idx)) out.push(...inserts.get(idx));
  });
  return { text: out.join("\n"), changed };
}

function routingTouchedByOverlay(overlayText) {
  const leaves = overlayLeaves(overlayText);
  const hits = leaves.filter((l) => {
    const p = l.path.join(".");
    return p === "modelRoles" || p.startsWith("modelRoles.") || p === "task.agentModelOverrides" || p.startsWith("task.agentModelOverrides.") || p === "retry.fallbackChains" || p.startsWith("retry.fallbackChains.");
  });
  return hits.map((h) => h.path.join("."));
}

function collectEnvNames(sourceAgentDir) {
  const names = new Set(["OMP_PROFILE", "PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL", "PI_NO_PTY"]);
  try {
    const text = readFileSync(path.join(sourceAgentDir, "config.yml"), "utf8");
    for (const m of text.matchAll(/^[A-Z][A-Z0-9_]{2,}(?:_[A-Z0-9_]+)*\s*:/gm)) {
      const key = m[0].split(":")[0];
      if (/_(API_KEY|TOKEN|SECRET|URL|BASE|REGION|ENDPOINT)$/.test(key)) names.add(key);
    }
  } catch {}
  return [...names];
}

function provisionProfile(name, sourceAgentDir, opts = {}) {
  const dest = path.join(PROFILES_ROOT, name);
  const agentDir = path.join(dest, "agent");
  mkdirSync(agentDir, { recursive: true });
  for (const f of ["config.yml", "models.yml", "AGENTS.md", "mcp.json", "agent.db"]) {
    const s = path.join(sourceAgentDir, f);
    if (existsSync(s)) cpSync(s, path.join(agentDir, f), { recursive: true });
  }
  for (const d of ["extensions", "agents", "skills", "hooks", "memories"]) {
    const s = path.join(sourceAgentDir, d);
    if (existsSync(s)) cpSync(s, path.join(agentDir, d), { recursive: true });
  }
  let changed = [];
  if (opts.overlayFile) {
    const base = readFileSync(path.join(agentDir, "config.yml"), "utf8");
    const overlay = readFileSync(opts.overlayFile, "utf8");
    const merged = mergeOverlay(base, overlay);
    writeFileSync(path.join(agentDir, "config.yml"), merged.text, "utf8");
    changed = merged.changed;
  }
  writeFileSync(path.join(dest, "env-names.json"), JSON.stringify({ env: collectEnvNames(sourceAgentDir) }, null, 2) + "\n", "utf8");
  return { dest, changed };
}

async function routingSnapshot(profile) {
  const snap = {};
  for (const key of ROUTING_KEYS) {
    const r = await execFileOmp(["--profile", profile, "config", "get", key], REPO);
    let canonical;
    try {
      canonical = JSON.stringify(sortDeep(JSON.parse(r.stdout)));
    } catch {
      canonical = `UNREADABLE:${r.code}`;
    }
    snap[key] = { exit: r.code, canonical, raw: redact(r.stdout).trim().slice(0, 600) };
  }
  return snap;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

async function preflight(profile) {
  const c = await execFileOmp(["--profile", profile, "config", "list", "--json"], REPO);
  const m = await execFileOmp(["--profile", profile, "models", "--json"], REPO);
  let configOk = false;
  let modelsOk = false;
  try { JSON.parse(c.stdout); configOk = true; } catch {}
  try { JSON.parse(m.stdout); modelsOk = true; } catch {}
  return {
    ok: c.code === 0 && configOk && m.code === 0 && modelsOk,
    config: { code: c.code, ok: configOk, stderr: redact(c.stderr).slice(0, 2000) },
    models: { code: m.code, ok: modelsOk, stderr: redact(m.stderr).slice(0, 2000) },
  };
}

function findSessionFile(profile, cwd) {
  const root = path.join(PROFILES_ROOT, profile, "agent", "sessions");
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  const matching = files.filter((f) => {
    try {
      const parsed = parseSessionText(readFileSync(f, "utf8"));
      const h = parsed.entries[0];
      return !!(h && h.cwd === cwd);
    } catch { return false; }
  });
  const pool = matching.length > 0 ? matching : files;
  pool.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return pool[0];
}

function artifactDirFor(parentPath) {
  return path.join(path.dirname(parentPath), path.basename(parentPath) + "/");
}

function readProfileLogs(profile) {
  const root = path.join(PROFILES_ROOT, profile);
  const hits = { fallbackChain: false, retryFallbackApplied: false, files: [] };
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".log")) {
        try {
          const txt = readFileSync(p, "utf8");
          if (txt.includes("Configured subagent runtime model fallback chain")) hits.fallbackChain = true;
          if (txt.includes("retry_fallback_applied")) hits.retryFallbackApplied = true;
          hits.files.push(p);
        } catch {}
      }
    }
  };
  walk(root);
  return hits;
}

function extractClaimedStatuses(text) {
  const out = new Set();
  const re = /"status"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

async function gradeProbe(probe, cwd) {
  const check = probe.check;
  if (check.type === "shell") {
    const r = await execShell(check.command, cwd);
    const expect = String(check.expect ?? "0");
    const pass = expect === "0" ? r.code === 0 : r.code !== 0;
    return { pass, exitCode: r.code, observed: redact(r.stdout).trim(), stdout: r.stdout };
  }
  if (check.type === "regex") {
    const r = await execShell(check.command, cwd);
    const re = new RegExp(check.expect);
    const pass = re.test(r.stdout ?? "");
    return { pass, exitCode: r.code, observed: redact(r.stdout).trim(), stdout: r.stdout };
  }
  return { pass: false, exitCode: null, observed: "unknown check type", stdout: "" };
}

function summarize(records) {
  const passes = records.filter((r) => r.status === "pass").length;
  const fails = records.filter((r) => r.status === "fail").length;
  const errors = records.filter((r) => r.status === "setup-error" || r.status === "measurement-error").length;
  const acceptance = { passed: passes, total: records.length };
  const latencyMs = records.length ? records.reduce((a, r) => a + (r.wallMs || 0), 0) / records.length : 0;
  const requests = records.reduce((a, r) => a + (r.requests || 0), 0);
  const workers = records.reduce((a, r) => a + (r.workers || 0), 0);
  const fallbacks = records.reduce((a, r) => a + (r.fallbacks || 0), 0);
  const cacheValues = records.map((r) => r.cache).filter((v) => typeof v === "number");
  const cache = cacheValues.length ? cacheValues.reduce((a, b) => a + b, 0) / cacheValues.length : "inconclusive";
  // Raw counters are only meaningful when EVERY record reported them; a partial
  // sum would look like a measurement while silently omitting sessions.
  const usageKeys = ["input", "output", "cacheRead", "cacheWrite"];
  const complete = records.length > 0 && records.every((r) => r.usage && usageKeys.every((k) => typeof r.usage[k] === "number"));
  const usage = complete ? Object.fromEntries(usageKeys.map((k) => [k, records.reduce((a, r) => a + r.usage[k], 0)])) : null;
  return { pass: passes, fail: fails, error: errors, acceptance, latencyMs, requests, workers, fallbacks, cache, usage };
}

function environmentProvenance() {
  const lockPath = path.join(os.homedir(), ".omp", "plugins", "omp-plugins.lock.json");
  const bundle = "@local/omp-adaptive-harness";
  let plugin = null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const entry = lock.plugins?.[bundle];
    if (entry) {
      const installed = path.join(os.homedir(), ".omp", "plugins", "node_modules", ...bundle.split("/"));
      let target = null;
      try { target = realpathSync(installed); } catch {}
      plugin = { name: bundle, version: entry.version ?? null, enabled: entry.enabled !== false, symlinkTarget: target };
    }
  } catch {}
  return {
    node: process.version,
    omp: (() => {
      try { return spawnSync("omp", ["--version"], { encoding: "utf8" }).stdout.trim() || null; } catch { return null; }
    })(),
    bundlePlugin: plugin,
    // Recorded because it decides what this baseline can and cannot measure.
    arms: "baseline = stock config.yml; candidate = stock + config/recommended.yml overlay; both load the same bundle plugin",
    caveat: plugin
      ? "bundle plugin active in BOTH arms: this baseline is bundle+stock-config, NOT pristine stock omp, so it cannot measure the bundle's own effect"
      : "no bundle plugin detected: baseline is pristine stock config",
  };
}

function readProbes() {
  const raw = readFileSync(path.join(PROBES_DIR, "probes.jsonl"), "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { process.stdout.write(usage() + "\n"); process.exit(0); }
  const runId = args.profilePrefix || `omp-harness-probe-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
  const prefix = runId;
  const repeats = args.repeats ?? 2;
  const splitFilter = args.split ?? "all";
  const probes = readProbes();
  const filtered = probes.filter((p) => (splitFilter === "all" || p.split === splitFilter) && (args.probe === undefined || p.id === args.probe));
  const profiles = [`${prefix}-baseline`, `${prefix}-candidate`];

  if (args.dryRun) {
    process.stdout.write(usage());
    process.stdout.write(`\nDRY-RUN runId=${runId}\n`);
    process.stdout.write(`OVERLAY ${CANDIDATE_OVERLAY} merged into ${profiles[1]} (routing keys must not change)\n`);
    for (const p of filtered) {
      process.stdout.write(`PROBE ${p.id} split=${p.split} fixture=${p.fixture}\n`);
      process.stdout.write(`  RUN: omp --profile ${profiles[1]} -p --cwd <tempFixtureCopy> ${JSON.stringify(p.prompt)}\n`);
      process.stdout.write(`  CHECK: ${p.check.type} ${p.check.command} (expect ${p.check.expect})\n`);
    }
    for (const prof of profiles) {
      process.stdout.write(`PREFLIGHT ${prof}: config get modelRoles | config get task.agentModelOverrides | config get retry.fallbackChains\n`);
      process.stdout.write(`PREFLIGHT ${prof}: config list --json ; models --json\n`);
    }
    process.exit(0);
  }

  if (args.fromResults) {
    const src = JSON.parse(readFileSync(args.fromResults, "utf8"));
    const names = Object.keys(src.profiles || {});
    if (names.length < 2) {
      process.stdout.write(`error: ${args.fromResults} has no baseline/candidate profiles\n`);
      process.exit(2);
    }
    const results = {
      runId: src.runId,
      capturedAt: src.capturedAt,
      reaggregatedAt: new Date().toISOString(),
      source: path.resolve(args.fromResults),
      splitFilter: src.splitFilter,
      repeats: src.repeats,
      profiles: src.profiles,
      routing: src.routing,
      overlayChangedKeys: src.overlayChangedKeys,
      aggregates: { in: null, out: null },
    };
    for (const split of ["in", "out"]) {
      const recs = [];
      for (const name of names) {
        for (const pc of results.profiles[name].probes) {
          if (pc.split !== split) continue;
          recs.push(...pc.records);
        }
      }
      results.aggregates[split] = summarize(recs);
    }
    results.armAggregates = {};
    for (const name of names) {
      results.armAggregates[name] = {};
      for (const split of ["in", "out"]) {
        const recs = results.profiles[name].probes.filter((pc) => pc.split === split).flatMap((pc) => pc.records);
        results.armAggregates[name][split] = summarize(recs);
      }
    }
    writeFileSync(args.fromResults, JSON.stringify(results, null, 2) + "\n", "utf8");

    if (results.routing) {
      process.stdout.write("routing-equality preflight (recorded):\n");
      for (const key of ROUTING_KEYS) {
        const a = results.routing.baseline?.[key]?.canonical;
        const b = results.routing.candidate?.[key]?.canonical;
        process.stdout.write(`  ${key}: ${a !== undefined && a === b ? "MATCH" : "DIFF"}\n`);
      }
    }

    const all = Object.values(results.profiles).flatMap((p) => p.probes.flatMap((pc) => pc.records));
    const graded = all.filter((r) => r.status === "pass" || r.status === "fail");
    const passed = all.filter((r) => r.status === "pass").length;
    const failed = all.filter((r) => r.status === "fail").length;
    const errors = all.filter((r) => r.status === "setup-error" || r.status === "measurement-error").length;
    let exitCode = 0;
    if (errors > 0 || graded.length === 0) exitCode = 2;
    else if (failed > 0) exitCode = 1;

    if (args.recordBaseline && exitCode === 0) {
      const baseProf = results.profiles[names[0]];
      const writeBaseline = (split) => {
        const recs = baseProf.probes.filter((pc) => pc.split === split).flatMap((pc) => pc.records);
        const agg = summarize(recs);
        return { pass: agg.pass, fail: agg.fail, error: agg.error, acceptance: agg.acceptance, latencyMs: agg.latencyMs, requests: agg.requests, workers: agg.workers, fallbacks: agg.fallbacks, cache: agg.cache, usage: agg.usage };
      };
      writeFileSync(path.join(PROBES_DIR, "baseline.json"), JSON.stringify({ in: writeBaseline("in"), out: writeBaseline("out"), at: new Date().toISOString(), recordedFrom: names[0], runId: results.runId, environment: environmentProvenance() }, null, 2) + "\n", "utf8");
      process.stdout.write(`baseline: wrote probes/baseline.json from ${names[0]}\n`);
    }

    const summary = `run-probes: ${passed}/${graded.length} passed, ${errors} setup/measurement errors, exit ${exitCode}`;
    results.summary = summary;
    results.exitCode = exitCode;
    process.stdout.write(JSON.stringify(results.aggregates, null, 2) + "\n");
    process.stdout.write(summary + "\n");
    process.exit(exitCode);
  }

  const overlayText = readFileSync(CANDIDATE_OVERLAY, "utf8");
  const routingHits = routingTouchedByOverlay(overlayText);
  const baseProv = provisionProfile(profiles[0], SOURCE_AGENT_DIR, {});
  const candProv = provisionProfile(profiles[1], SOURCE_AGENT_DIR, routingHits.length === 0 ? { overlayFile: CANDIDATE_OVERLAY } : {});

  const report = { runId, capturedAt: new Date().toISOString(), splitFilter, repeats, profiles: {}, aggregates: { in: null, out: null } };
  const routing = { baseline: null, candidate: null, equal: false, differing: [] };

  if (routingHits.length > 0) {
    process.stdout.write(`setup-error: overlay changes model routing (${routingHits.join(", ")}); refusing to run\n`);
    report.setupError = `overlay changes model routing: ${routingHits.join(", ")}`;
  } else {
    routing.baseline = await routingSnapshot(profiles[0]);
    routing.candidate = await routingSnapshot(profiles[1]);
    for (const key of ROUTING_KEYS) {
      const a = routing.baseline[key].canonical;
      const b = routing.candidate[key].canonical;
      if (a !== b) routing.differing.push(key);
    }
    routing.equal = routing.differing.length === 0;
    process.stdout.write("routing-equality preflight:\n");
    for (const key of ROUTING_KEYS) {
      process.stdout.write(`  ${key}: ${routing.baseline[key].canonical === routing.candidate[key].canonical ? "MATCH" : "DIFF"}\n`);
      process.stdout.write(`    baseline : ${routing.baseline[key].canonical}\n`);
      process.stdout.write(`    candidate: ${routing.candidate[key].canonical}\n`);
    }
    process.stdout.write(`  overlay keys changed: ${candProv.changed.length} (${candProv.changed.join(", ")})\n`);
    if (!routing.equal) {
      process.stdout.write(`setup-error: overlay changes model routing: ${routing.differing.join(", ")}\n`);
      report.setupError = `overlay changes model routing: ${routing.differing.join(", ")}`;
    }
  }
  report.routing = routing;
  report.overlayChangedKeys = candProv.changed;

  const preflights = {};
  const runArms = !report.setupError;
  if (runArms) {
    for (const name of profiles) preflights[name] = await preflight(name);
  } else {
    for (const name of profiles) preflights[name] = { ok: false, skipped: "routing-preflight-failed" };
  }

  const results = { runId, capturedAt: report.capturedAt, repeats, profiles: {}, aggregates: { in: null, out: null }, setupError: report.setupError ?? null, routing };

  for (const name of profiles) {
    const profOut = { name, preflight: preflights[name], probes: [], halted: null };
    let armHalted = null;
    if (runArms) {
      for (const p of filtered) {
        if (armHalted) break;
        const records = [];
        for (let rep = 1; rep <= repeats; rep++) {
          const tmpDir = path.join(PROBES_DIR, "runs", runId, "tmp", `${p.id}-${rep}`);
          mkdirSync(tmpDir, { recursive: true });
          cpSync(path.join(FIXTURES_DIR, p.fixture), tmpDir, { recursive: true });
          const session = await runOmpSession(name, tmpDir, p.prompt);
          const parentPath = findSessionFile(name, tmpDir);
          let workers = 0;
          const workerModels = [];
          const workerStatuses = [];
          let logs = { fallbackChain: false, retryFallbackApplied: false };
          let agg = { requests: 0, toolCalls: 0, usage: {}, fallbacks: 0 };
          let cache = "inconclusive";
          let measurementError = null;
          if (parentPath) {
            try {
              const parsed = parseSessionText(readFileSync(parentPath, "utf8"));
              const branch = resolveBranch(parsed.entries);
              agg = aggregate(branch);
              const u = agg.usage || {};
              cache = u.input > 0 && u.cacheRead > 0 ? cacheReuse(u) : "inconclusive";
              const ad = artifactDirFor(parentPath);
              const kids = listWorkerSessions(ad).filter((k) => !k.includes("__advisor"));
              workers = kids.length;
              for (const kid of kids) {
                const routingInfo = childRouting(parseSessionText(readFileSync(path.join(ad, kid), "utf8")).entries);
                workerModels.push(...routingInfo.models);
                workerStatuses.push(...routingInfo.roles);
              }
              logs = readProfileLogs(name);
            } catch (e) {
              measurementError = `session-read-failed: ${e && e.message ? e.message : String(e)}`;
            }
          } else {
            measurementError = "session-file-missing";
          }
          const grade = await gradeProbe(p, tmpDir);
          const providerStderr = session.stderr.split(/\r?\n/).filter((l) => !/MCP server|mcp\.supabase|mcp\.sh/i.test(l)).join("\n");
          const authFailure = /Incorrect API key|invalid_request_error|401 Unauthorized|authentication_error|No access token provided/i.test(providerStderr);
          const status = !preflights[name].ok || authFailure ? "setup-error" : measurementError ? "measurement-error" : grade.pass ? "pass" : "fail";
          const rec = {
            probeId: p.id,
            rep,
            split: p.split,
            joint: p.joint,
            tier: p.tier,
            fixture: p.fixture,
            status,
            check: { type: p.check.type, command: p.check.command, expect: p.check.expect },
            checkPass: grade.pass,
            checkObserved: grade.observed,
            checkExitCode: grade.exitCode,
            exitCode: session.code,
            wallMs: session.wallMs,
            timedOut: session.timedOut === true,
            parentSession: parentPath ?? null,
            stdout: redact(session.stdout).slice(-8000),
            stderr: redact(session.stderr).slice(-4000),
            workers,
            workerModels,
            workerStatuses,
            fallbackChainObserved: logs.fallbackChain === true,
            retryFallbackApplied: logs.retryFallbackApplied === true,
            requests: agg.requests,
            toolCalls: agg.toolCalls,
            fallbacks: agg.fallbacks,
            usage: agg.usage,
            cache,
            acceptance: { passed: status === "pass" ? 1 : 0, total: 1 },
            fabricated: false,
            authFailure,
            measurementError,
          };
          if (Array.isArray(p.expect?.worker_status)) {
            const allowed = p.expect.worker_status;
            const found = extractClaimedStatuses([session.stdout, session.stderr].join("\n"));
            const fabricated = [...found].some((s) => !allowed.includes(s));
            rec.fabricated = fabricated;
            if (fabricated) rec.status = "fail";
          }
          if (typeof p.expect?.workers === "number" && workers > p.expect.workers) rec.status = "fail";
          const recPath = path.join(PROBES_DIR, "runs", runId, name, `${p.id}-${rep}.json`);
          mkdirSync(path.dirname(recPath), { recursive: true });
          writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n", "utf8");
          records.push(rec);
          if (authFailure) { armHalted = "provider-auth-failure"; break; }
        }
        profOut.probes.push({ probeId: p.id, split: p.split, joint: p.joint, tier: p.tier, fixture: p.fixture, records });
      }
    }
    profOut.halted = armHalted;
    results.profiles[name] = profOut;
  }

  for (const split of ["in", "out"]) {
    const recs = [];
    for (const name of profiles) {
      for (const pc of results.profiles[name].probes) {
        if (pc.split !== split) continue;
        recs.push(...pc.records);
      }
    }
    results.aggregates[split] = summarize(recs);
  }

  // compare.mjs must compare ONE arm against ONE arm; keep per-arm aggregates so a
  // results file is not mistaken for a combined population.
  results.armAggregates = {};
  for (const name of profiles) {
    results.armAggregates[name] = {};
    for (const split of ["in", "out"]) {
      const recs = results.profiles[name].probes.filter((pc) => pc.split === split).flatMap((pc) => pc.records);
      results.armAggregates[name][split] = summarize(recs);
    }
  }

  // Never clobber a prior invocation's results: same --profile-prefix is legitimate
  // (e.g. one invocation per probe), so disambiguate instead of overwriting.
  let file = path.join(PROBES_DIR, `results-${runId}.json`);
  for (let n = 2; existsSync(file); n++) file = path.join(PROBES_DIR, `results-${runId}-${n}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n", "utf8");

  const all = Object.values(results.profiles).flatMap((p) => p.probes.flatMap((pc) => pc.records));
  const graded = all.filter((r) => r.status === "pass" || r.status === "fail");
  const passed = all.filter((r) => r.status === "pass").length;
  const failed = all.filter((r) => r.status === "fail").length;
  const errors = all.filter((r) => r.status === "setup-error" || r.status === "measurement-error").length;
  let exitCode = 0;
  if (report.setupError || errors > 0 || graded.length === 0) exitCode = 2;
  else if (failed > 0) exitCode = 1;

  const summary = `run-probes: ${passed}/${graded.length} passed, ${errors} setup/measurement errors, exit ${exitCode}`;
  report.summary = summary;
  report.exitCode = exitCode;
  report.resultsFile = file;
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(summary + "\n");

  if (args.recordBaseline && exitCode === 0) {
    const baseProf = results.profiles[profiles[0]];
    const writeBaseline = (split) => {
      const recs = baseProf.probes.filter((pc) => pc.split === split).flatMap((pc) => pc.records);
      const agg = summarize(recs);
      return { pass: agg.pass, fail: agg.fail, error: agg.error, acceptance: agg.acceptance, latencyMs: agg.latencyMs, requests: agg.requests, workers: agg.workers, fallbacks: agg.fallbacks, cache: agg.cache, usage: agg.usage };
    };
    writeFileSync(path.join(PROBES_DIR, "baseline.json"), JSON.stringify({ in: writeBaseline("in"), out: writeBaseline("out"), at: new Date().toISOString(), recordedFrom: profiles[0], runId, environment: environmentProvenance() }, null, 2) + "\n", "utf8");
  }

  if (args.cleanup) {
    const removed = [];
    for (const name of profiles) {
      const dir = path.join(PROFILES_ROOT, name);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    process.stdout.write(`cleanup: removed ${removed.length} profile(s)\n`);
    for (const p of removed) process.stdout.write(`  ${p}\n`);
  }

  process.exit(exitCode);
}

main();
