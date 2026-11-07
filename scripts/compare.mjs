#!/usr/bin/env node
/**
 * compare.mjs — baseline vs candidate probe comparison.
 *
 * Usage:
 *   node scripts/compare.mjs --baseline probes/baseline.json --candidate probes/results-<runId>.json [--tolerance 0.05] [--json]
 *
 * Exit codes:
 *   0 — valid improvement (admission rule satisfied, cache not inconclusive)
 *   1 — valid non-improvement (admission rule failed; lower acceptance / more fallbacks is NOT an improvement)
 *   2 — inconclusive / missing data (cache missing on either side, or reuse regression over tolerance)
 */
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--candidate") args.candidate = argv[++i];
    else if (a === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else args._.push(a);
  }
  return args;
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function pickAgg(holder, split, arm) {
  const key = split === "in" ? "in" : "out";
  const src = arm && holder?.armAggregates?.[arm] ? holder.armAggregates[arm] : holder;
  const node = src?.[key] ?? src?.aggregates?.[key];
  if (!node || typeof node !== "object") return null;
  return node;
}

// A results file holds BOTH arms. Comparing the baseline arm against a combined
// population would inflate pass counts, so resolve the candidate arm explicitly.
function candidateArm(holder, baseline) {
  const arms = holder?.armAggregates ? Object.keys(holder.armAggregates) : [];
  if (arms.length === 0) return null;
  const recorded = baseline?.recordedFrom;
  const rest = arms.filter((a) => a !== recorded);
  return rest.find((a) => /-candidate$/.test(a)) ?? rest[rest.length - 1] ?? arms[arms.length - 1];
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function meanReuse(reuseValues) {
  const vals = (reuseValues ?? []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function main() {
  const args = parseArgs(process.argv);
  const baseline = loadJson(args.baseline);
  const candidate = loadJson(args.candidate);
  const tolerance = typeof args.tolerance === "number" ? Math.max(0, args.tolerance) : 0.05;

  const arm = candidateArm(candidate, baseline);
  const baseIn = pickAgg(baseline, "in");
  const baseOut = pickAgg(baseline, "out");
  const candIn = pickAgg(candidate, "in", arm);
  const candOut = pickAgg(candidate, "out", arm);

  const missing = !baseIn || !baseOut || !candIn || !candOut;
  const cacheNum = (a) => (typeof a?.cache === "number" ? a.cache : null);
  const baseCacheIn = baseIn?.cache?.reuse ?? baseIn?.cacheReuse ?? baseIn?.cache?.meanReuse ?? cacheNum(baseIn);
  const baseCacheOut = baseOut?.cache?.reuse ?? baseOut?.cacheReuse ?? baseOut?.cache?.meanReuse ?? cacheNum(baseOut);
  const candCacheIn = candIn?.cache?.reuse ?? candIn?.cacheReuse ?? candIn?.cache?.meanReuse ?? cacheNum(candIn);
  const candCacheOut = candOut?.cache?.reuse ?? candOut?.cacheReuse ?? candOut?.cache?.meanReuse ?? cacheNum(candOut);

  const baseReusesIn = Array.isArray(baseIn?.cache?.reuses) ? baseIn.cache.reuses : Array.isArray(baseIn?.cacheReuses) ? baseIn.cacheReuses : [];
  const baseReusesOut = Array.isArray(baseOut?.cache?.reuses) ? baseOut.cache.reuses : Array.isArray(baseOut?.cacheReuses) ? baseOut.cacheReuses : [];
  const candReusesIn = Array.isArray(candIn?.cache?.reuses) ? candIn.cache.reuses : Array.isArray(candIn?.cacheReuses) ? candIn.cacheReuses : [];
  const candReusesOut = Array.isArray(candOut?.cache?.reuses) ? candOut.cache.reuses : Array.isArray(candOut?.cacheReuses) ? candOut.cacheReuses : [];

  const baseMeanIn = meanReuse(baseReusesIn) ?? baseCacheIn;
  const baseMeanOut = meanReuse(baseReusesOut) ?? baseCacheOut;
  const candMeanIn = meanReuse(candReusesIn) ?? candCacheIn;
  const candMeanOut = meanReuse(candReusesOut) ?? candCacheOut;

  const isNum = (v) => typeof v === "number";
  let cacheProblem = [baseIn, candIn, baseOut, candOut].some((a) => a?.cache === undefined || a?.cache === null)
    || ![baseIn, candIn, baseOut, candOut].every((a) => isNum(a?.usage?.input) && isNum(a?.usage?.cacheRead));

  let cacheRegression = false;
  if (!cacheProblem) {
    const pairs = [[baseMeanIn, candMeanIn], [baseMeanOut, candMeanOut]];
    for (const [b, c] of pairs) {
      if (b === null || c === null) { cacheProblem = true; break; }
      const regression = b - c;
      const rel = b === 0 ? (c === 0 ? 0 : 1) : regression / Math.abs(b);
      if (rel > tolerance) { cacheRegression = true; break; }
    }
  }

  const metrics = {
    d_acceptance_in: num(candIn?.acceptance?.passed) - num(baseIn?.acceptance?.passed),
    d_acceptance_out: num(candOut?.acceptance?.passed) - num(baseOut?.acceptance?.passed),
    d_latency_ms_in: num(candIn?.latencyMs) - num(baseIn?.latencyMs),
    d_latency_ms_out: num(candOut?.latencyMs) - num(baseOut?.latencyMs),
    d_requests_in: num(candIn?.requests) - num(baseIn?.requests),
    d_requests_out: num(candOut?.requests) - num(baseOut?.requests),
    d_workers_in: num(candIn?.workers) - num(baseIn?.workers),
    d_workers_out: num(candOut?.workers) - num(baseOut?.workers),
    d_fallbacks_in: num(candIn?.fallbacks) - num(baseIn?.fallbacks),
    d_fallbacks_out: num(candOut?.fallbacks) - num(baseOut?.fallbacks),
    cache: { base_in: baseMeanIn, candidate_in: candMeanIn, base_out: baseMeanOut, candidate_out: candMeanOut },
  };

  const finish = (ok, verdict, reason, exitCode) => {
    const result = {
      ok,
      verdict,
      reason,
      tolerance,
      candidateArm: arm ?? "(flat)",
      baseline: { in: baseIn, out: baseOut },
      candidate: { in: candIn, out: candOut },
      delta: { d_in: missing ? null : num(candIn?.pass) - num(baseIn?.pass), d_ho: missing ? null : num(candOut?.pass) - num(baseOut?.pass) },
      metrics,
    };
    if (ok) {
      result.fallbacks_worse = num(candIn?.fallbacks) > num(baseIn?.fallbacks) || num(candOut?.fallbacks) > num(baseOut?.fallbacks);
      result.acceptance_worse = num(candIn?.acceptance?.passed) < num(baseIn?.acceptance?.passed) || num(candOut?.acceptance?.passed) < num(baseOut?.acceptance?.passed);
      result.improvement = true;
    }
    process.stdout.write(args.json ? JSON.stringify(result, null, 2) + "\n" : `verdict: ${verdict} d_in=${result.delta.d_in} d_ho=${result.delta.d_ho}\n`);
    process.exit(exitCode);
  };

  if (missing || cacheProblem || cacheRegression) {
    finish(false, "inconclusive", missing ? "missing-splits" : cacheProblem ? "cache-inconclusive" : "cache-regression", 2);
  }

  const dIn = num(candIn?.pass) - num(baseIn?.pass);
  const dHo = num(candOut?.pass) - num(baseOut?.pass);
  const accepted = dIn >= 0 && dHo >= 0 && Math.max(dIn, dHo) > 0;
  const fallbacksWorse = num(candIn?.fallbacks) > num(baseIn?.fallbacks) || num(candOut?.fallbacks) > num(baseOut?.fallbacks);
  const acceptanceWorse = num(candIn?.acceptance?.passed) < num(baseIn?.acceptance?.passed) || num(candOut?.acceptance?.passed) < num(baseOut?.acceptance?.passed);
  const improvement = accepted && !fallbacksWorse && !acceptanceWorse;

  if (improvement) finish(true, "improvement", "admission-pass", 0);
  finish(false, "non-improvement", "admission-fail", 1);
}

main();
