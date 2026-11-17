/**
 * optional-deps.ts — fail-open synchronous loader for bare runtime packages.
 *
 * OMP evaluates extension modules as ESM at startup. A static `import MiniSearch
 * from "minisearch"` throws `Cannot find package` during module *evaluation*, which
 * kills the whole extension before any try/catch inside it can run. These loaders
 * resolve through `createRequire` inside try/catch instead, so a missing or partially
 * installed `node_modules` degrades one ranking stage rather than the extension.
 */
import { createRequire } from "node:module";
import { logHarnessCode } from "./state.ts";

export interface MiniSearchLike<T = unknown> {
  addAll(docs: T[]): void;
  search(query: string, opts?: Record<string, unknown>): Array<{ id: string; score: number }>;
}

export type MiniSearchConstructor = new (opts: Record<string, unknown>) => MiniSearchLike;

export interface GraphLike {
  order: number;
  hasNode(id: string): boolean;
  addNode(id: string, attrs?: Record<string, unknown>): void;
  hasEdge(a: string, b: string): boolean;
  addEdge(a: string, b: string, attrs?: Record<string, unknown>): void;
}

export type GraphConstructor = new (opts?: Record<string, unknown>) => GraphLike;

export type PagerankFn = (
  graph: unknown,
  opts?: { alpha?: number; maxIterations?: number },
) => Record<string, number>;

export interface GraphologyDeps {
  Graph: GraphConstructor;
  pagerank: PagerankFn;
}

export interface OptionalDepsOverride {
  minisearch?: MiniSearchConstructor | null;
  graphology?: GraphologyDeps | null;
}

let override: OptionalDepsOverride | null = null;
let miniSearchResolved: MiniSearchConstructor | null | undefined;
let graphologyResolved: GraphologyDeps | null | undefined;
let miniSearchReported = false;
let graphologyReported = false;

const req = createRequire(import.meta.url);

/** Test hook: pass `{ minisearch: null, graphology: null }` to simulate a bare install. */
export function setOptionalDepsOverride(next: OptionalDepsOverride | null): void {
  override = next;
  miniSearchResolved = undefined;
  graphologyResolved = undefined;
  miniSearchReported = false;
  graphologyReported = false;
}

function pickDefault<T>(mod: unknown): T | null {
  if (!mod) return null;
  if (typeof mod === "function") return mod as T;
  if (typeof mod === "object" && "default" in mod && typeof mod.default === "function") {
    return mod.default as T;
  }
  return null;
}

export function loadMiniSearch(cwd = process.cwd()): MiniSearchConstructor | null {
  if (override && "minisearch" in override) {
    const forced = override.minisearch ?? null;
    if (!forced && !miniSearchReported) {
      miniSearchReported = true;
      try {
        logHarnessCode(cwd, "D0 pkg=minisearch status=missing");
      } catch {
        // telemetry never breaks a turn
      }
    }
    return forced;
  }
  if (miniSearchResolved !== undefined) return miniSearchResolved;
  try {
    miniSearchResolved = pickDefault<MiniSearchConstructor>(req("minisearch"));
  } catch {
    miniSearchResolved = null;
  }
  if (!miniSearchResolved && !miniSearchReported) {
    miniSearchReported = true;
    try {
      logHarnessCode(cwd, "D0 pkg=minisearch status=missing");
    } catch {
      // ignore
    }
  }
  return miniSearchResolved;
}

export function loadGraphology(cwd = process.cwd()): GraphologyDeps | null {
  if (override && "graphology" in override) {
    const forced = override.graphology ?? null;
    if (!forced && !graphologyReported) {
      graphologyReported = true;
      try {
        logHarnessCode(cwd, "D0 pkg=graphology status=missing");
      } catch {
        // ignore
      }
    }
    return forced;
  }
  if (graphologyResolved !== undefined) return graphologyResolved;
  try {
    const Graph = pickDefault<GraphConstructor>(req("graphology"));
    const pagerankMod = req("graphology-metrics/centrality/pagerank.js");
    const pagerank = pickDefault<PagerankFn>(pagerankMod);
    graphologyResolved = Graph && pagerank ? { Graph, pagerank } : null;
  } catch {
    graphologyResolved = null;
  }
  if (!graphologyResolved && !graphologyReported) {
    graphologyReported = true;
    try {
      logHarnessCode(cwd, "D0 pkg=graphology status=missing");
    } catch {
      // ignore
    }
  }
  return graphologyResolved;
}
