#!/usr/bin/env node
/**
 * benchmark-compare.mjs — baseline vs candidate accepted-task cost comparison.
 *
 * Mirrors `computeAcceptedTaskCost` (src/telemetry.ts):
 *   - denominator = ALL attempts (pass+fail) per arm
 *   - accepted only when a record passed its check with no measurement error
 *   - costUsd unknown (null) → status UNKNOWN; no accepted attempts → UNDEFINED
 *
 * Reads probe runs from `probes/runs/*.json` (or `probes/results-*.json` when a
 * run dir is absent). A results file holds both arms under `profiles`; the
 * arm whose name ends in `-baseline` is the baseline, `-candidate` the
 * candidate. Files with a single flat `records` array are treated as one arm,
 * classified by filename.
 *
 * Usage:
 *   node scripts/benchmark-compare.mjs [--baseline <path>] [--candidate <path>]
 *     [--runs-dir <dir>] [--json] [--dry-run|--help]
 *
 * Missing `probes/runs` is graceful: usage is printed and the exit code is 0
 * for --help/--dry-run, 2 otherwise (no data to compare).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const USAGE = `Usage: node scripts/benchmark-compare.mjs [options]
  --baseline <path>     baseline results JSON (default: probes/runs/*.json)
  --candidate <path>    candidate results JSON (default: probes/runs/*.json)
  --runs-dir <dir>      scan dir for results JSON (default: probes/runs)
  --json                print the comparison as JSON
  --dry-run, --help     print usage, exit 0

Metrics per arm (computeAcceptedTaskCost rules):
  acceptedCount / totalAttempts (all attempts in the denominator),
  costPerAcceptedUsd (UNDEFINED if none accepted, UNKNOWN if costUsd missing),
  held-in / held-out pass delta, cache-reuse counters, read-budget blocks.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--help" || a === "--json") {
      args[a.slice(2).replace("-", "")] = true;
    } else if (a.startsWith("--")) {
      args[a.slice(2)] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function armRecords(holder) {
  const out = [];
  const profiles = holder?.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length > 0) {
    return names.map((name) => ({
      arm: name.endsWith("-baseline") ? "baseline" : name.endsWith("-candidate") ? "candidate" : name,
      records: collectRecords(profiles[name] ?? {}),
    }));
  }
  return [{ arm: "unknown", records: collectRecords(holder) }];
}

function collectRecords(node) {
  const records = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const item of n) walk(item); return; }
    if (Array.isArray(n.records)) { records.push(...n.records); return; }
    for (const v of Object.values(n)) walk(v);
  };
  walk(node?.probes ?? node);
  return records;
}

function isAccepted(r) {
  return r?.status === "pass" && r?.checkPass !== false && (r?.measurementError ?? null) === null;
}

function computeAcceptedTaskCost(attempts) {
  const totalAttempts = attempts.length;
  let acceptedCount = 0;
  let unknown = false;
  let totalTokenCostUsd = 0;
  let perRequestCalls = 0;
  for (const a of attempts) {
    if (a.accepted) acceptedCount += 1;
    const kind = a.billingKind ?? "unknown";
    if (kind === "unknown") unknown = true;
    if (kind === "per-request") {
      perRequestCalls += a.requests !== undefined && a.requests !== null ? Number(a.requests) : 1;
      if (a.costUsd === null || a.costUsd === undefined || !Number.isFinite(a.costUsd)) unknown = true;
      continue;
    }
    if (a.costUsd === null || a.costUsd === undefined || !Number.isFinite(a.costUsd)) { unknown = true; continue; }
    totalTokenCostUsd += a.costUsd;
  }
  if (acceptedCount === 0) return { status: "UNDEFINED", acceptedCount, totalAttempts, totalTokenCostUsd: null, perRequestCalls, costPerAcceptedUsd: null };
  if (unknown) return { status: "UNKNOWN", acceptedCount, totalAttempts, totalTokenCostUsd: null, perRequestCalls, costPerAcceptedUsd: null };
  return { status: "OK", acceptedCount, totalAttempts, totalTokenCostUsd, perRequestCalls, costPerAcceptedUsd: totalTokenCostUsd / acceptedCount };
}

function summarize(records) {
  const attempts = records.map((r) => ({
    accepted: isAccepted(r),
    costUsd: typeof r?.costUsd === "number" ? r.costUsd : null,
    billingKind: r?.billingKind,
    requests: r?.requests,
  }));
  const cost = computeAcceptedTaskCost(attempts);
  const sum = (key) => records.reduce((acc, r) => acc + (typeof r?.usage?.[key] === "number" ? r.usage[key] : 0), 0);
  const usage = { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") };
  const cacheReuse = usage.input + usage.cacheRead > 0 ? usage.cacheRead / (usage.input + usage.cacheRead) : 0;
  const passRate = (split) => {
    const rs = records.filter((r) => (r?.split ?? "in") === split);
    return rs.length === 0 ? null : rs.filter(isAccepted).length / rs.length;
  };
  const budgetBlocks = records.filter((r) => /budget/.test(String(r?.probeId ?? "")) && (r?.status === "blocked" || r?.status === "pass")).length;
  return { cost, usage, cacheReuse, heldInPassRate: passRate("in"), heldOutPassRate: passRate("out"), budgetBlocks, records: records.length };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.dryrun) { console.log(USAGE); process.exit(0); }
  const runsDir = args["runs-dir"] ?? join("probes", "runs");
  let files = [];
  if (args.baseline) files.push(args.baseline);
  if (args.candidate) files.push(args.candidate);
  if (files.length === 0) {
    const roots = existsSync(runsDir) ? [runsDir] : [runsDir, "probes"];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root).sort()) {
        const full = join(root, name);
        if (name.endsWith(".json")) files.push(full);
        else {
          try {
            for (const inner of readdirSync(full).sort()) {
              if (inner.endsWith(".json")) files.push(join(full, inner));
            }
          } catch {}
        }
      }
      if (files.length > 0) break;
    }
  }
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0 || files.length === 0) {
    console.log(USAGE);
    console.log(`\nNo probe runs found (looked in ${runsDir} and probes/).`);
    process.exit(2);
  }
  const arms = { baseline: [], candidate: [] };
  for (const file of files) {
    let holder;
    try { holder = loadJson(file); } catch (e) { console.error(`skip ${basename(file)}: ${e.message}`); continue; }
    for (const { arm, records } of armRecords(holder)) {
      const key = arm === "baseline" ? "baseline" : arm === "candidate" ? "candidate" : "candidate";
      arms[key].push(...records);
    }
  }
  if (arms.baseline.length === 0 && arms.candidate.length === 0) {
    console.log(USAGE);
    console.log("\nNo records parsed from the results files.");
    process.exit(2);
  }
  const out = { baseline: summarize(arms.baseline), candidate: summarize(arms.candidate) };
  out.heldInPassRateDelta = out.baseline.heldInPassRate === null || out.candidate.heldInPassRate === null ? null : out.candidate.heldInPassRate - out.baseline.heldInPassRate;
  out.heldOutPassRateDelta = out.baseline.heldOutPassRate === null || out.candidate.heldOutPassRate === null ? null : out.candidate.heldOutPassRate - out.baseline.heldOutPassRate;
  if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const arm of ["baseline", "candidate"]) {
    const s = out[arm];
    console.log(`${arm}: attempts=${s.cost.totalAttempts} accepted=${s.cost.acceptedCount} status=${s.cost.status} costPerAcceptedUsd=${s.cost.costPerAcceptedUsd ?? "null"} perRequestCalls=${s.cost.perRequestCalls}`);
    console.log(`  usage input=${s.usage.input} output=${s.usage.output} cacheRead=${s.usage.cacheRead} cacheWrite=${s.usage.cacheWrite} cacheReuse=${s.cacheReuse.toFixed(4)}`);
    console.log(`  heldInPassRate=${s.heldInPassRate ?? "n/a"} heldOutPassRate=${s.heldOutPassRate ?? "n/a"} readBudgetBlocks=${s.budgetBlocks} records=${s.records}`);
  }
  console.log(`held-in pass-rate delta=${out.heldInPassRateDelta ?? "n/a"} held-out pass-rate delta=${out.heldOutPassRateDelta ?? "n/a"}`);
}

main();
