#!/usr/bin/env node
/**
 * mine-sessions.mjs — aggregate-only measurement over local omp sessions.
 *
 * Usage:
 *   node scripts/mine-sessions.mjs [--sessions <dir>] [--log <path>] [--since <ISO>]
 *                                  [--project <slug>] [--json] [--record-baseline]
 *
 * Output holds counts and rates only: no message content, no file paths.
 * Exit codes: 0 success, 2 bad input.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseSessionText } from "../src/telemetry.ts";
import { summarizeSessionMetrics } from "../src/session-metrics.ts";
import { globalHarnessLogPath } from "../src/state.ts";

const MIN_BLOCKS = 20;

function fail(msg) {
  process.stderr.write(`mine-sessions: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === "--sessions") args.sessions = val();
    else if (a === "--log") args.log = val();
    else if (a === "--since") args.since = val();
    else if (a === "--project") args.project = val();
    else if (a === "--json") args.json = true;
    else if (a === "--record-baseline") args.recordBaseline = true;
    else fail(`unknown argument ${a}`);
  }
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pcts(values, ps) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = { n: sorted.length };
  for (const p of ps) out[`p${Math.round(p * 100)}`] = percentile(sorted, p);
  return out;
}

function countField(text, code, key) {
  const out = {};
  const re = new RegExp(`^${code}\\s.*?\\b${key}=([^\\s]+)`);
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m) out[m[1]] = (out[m[1]] ?? 0) + 1;
  }
  return out;
}

const args = parseArgs(process.argv);
const sessionsDir = args.sessions ?? path.join(homedir(), ".omp", "agent", "sessions");
if (!existsSync(sessionsDir)) fail("sessions directory not found");
let sinceMs;
if (args.since !== undefined) {
  sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) fail("--since is not a valid ISO timestamp");
}

const projects = readdirSync(sessionsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (args.project === undefined || d.name === args.project))
  .map((d) => d.name);

let sessions = 0;
const total = { blocks: 0, unnecessary: 0, caught: 0 };
const labelCounts = {};
const walls = [];
const reuseByProvider = {};
const reuseByModel = {};

for (const proj of projects) {
  const dir = path.join(sessionsDir, proj);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    let text;
    try {
      text = readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const { entries } = parseSessionText(text);
    if (entries.length === 0) continue;
    if (sinceMs !== undefined) {
      const t = Date.parse(String(entries[0].timestamp ?? ""));
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }
    sessions += 1;
    const m = summarizeSessionMetrics(entries);
    total.blocks += m.stopBlocks.total;
    total.unnecessary += m.stopBlocks.unnecessary;
    total.caught += m.stopBlocks.caught;
    for (const [k, v] of Object.entries(m.stopBlocks.counts)) labelCounts[k] = (labelCounts[k] ?? 0) + v;
    if (m.activeWallMs > 0) walls.push(m.activeWallMs);
    if (m.cache.reuse > 0) {
      if (m.cache.provider) (reuseByProvider[m.cache.provider] ??= []).push(m.cache.reuse);
      if (m.cache.model) (reuseByModel[m.cache.model] ??= []).push(m.cache.reuse);
    }
  }
}

const rate = (n) => (total.blocks < MIN_BLOCKS ? "insufficient" : n / total.blocks);
const groupPcts = (groups) =>
  Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, pcts(v, [0.1, 0.5])]));

const logPath = args.log ?? globalHarnessLogPath();
let harnessLog = { G1: {}, W1: {}, W2: {} };
if (logPath && existsSync(logPath)) {
  try {
    const lt = readFileSync(logPath, "utf8");
    harnessLog = { G1: countField(lt, "G1", "rc"), W1: countField(lt, "W1", "st"), W2: countField(lt, "W2", "k") };
  } catch {
    // unreadable log: leave empty
  }
}

const report = {
  sessions,
  stopBlocks: {
    total: total.blocks,
    counts: labelCounts,
    unnecessary: total.unnecessary,
    caught: total.caught,
    falseBlockRate: rate(total.unnecessary),
    catchRate: rate(total.caught),
    ignoredRate: rate(labelCounts.ignored ?? 0),
  },
  activeWallMs: pcts(walls, [0.5, 0.95]),
  cacheReuse: { byProvider: groupPcts(reuseByProvider), byModel: groupPcts(reuseByModel) },
  harnessLog,
};

if (args.recordBaseline) {
  const out = path.join(process.cwd(), ".omp", "harness", "metrics-baseline.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), ...report }, null, 2) + "\n", "utf8");
}

if (args.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const fmt = (v) => (typeof v === "number" ? v.toFixed(3) : String(v));
  const lines = [
    `sessions: ${report.sessions}`,
    `stop blocks: ${report.stopBlocks.total} ${JSON.stringify(report.stopBlocks.counts)}`,
    `  falseBlockRate=${fmt(report.stopBlocks.falseBlockRate)} catchRate=${fmt(report.stopBlocks.catchRate)} ignoredRate=${fmt(report.stopBlocks.ignoredRate)}`,
    `active wall ms: n=${report.activeWallMs.n} p50=${report.activeWallMs.p50 ?? "-"} p95=${report.activeWallMs.p95 ?? "-"}`,
    "cache reuse (p10/p50):",
  ];
  for (const [k, v] of Object.entries(report.cacheReuse.byProvider)) lines.push(`  provider ${k}: n=${v.n} p10=${fmt(v.p10)} p50=${fmt(v.p50)}`);
  for (const [k, v] of Object.entries(report.cacheReuse.byModel)) lines.push(`  model ${k}: n=${v.n} p10=${fmt(v.p10)} p50=${fmt(v.p50)}`);
  lines.push(`harness.log G1 rc=${JSON.stringify(harnessLog.G1)} W1 st=${JSON.stringify(harnessLog.W1)} W2 k=${JSON.stringify(harnessLog.W2)}`);
  process.stdout.write(lines.join("\n") + "\n");
}
