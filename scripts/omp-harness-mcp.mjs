#!/usr/bin/env node
/**
 * omp-harness-mcp.mjs — stdio MCP server (JSON-RPC 2.0, newline-delimited) that
 * exposes omp harness tools to Claude CLI.
 *
 * Tools: jev_decide, jev_rank, jev_gate, intake_open, harness_record,
 * harness_mine, harness_gate, harness_decide, zero_mem_recall, ontology_check,
 * ontology_compile.
 *
 * Harness/ontology handlers are the real implementations from src/tools.ts,
 * invoked through a minimal mock ExtensionAPI (ctx.cwd drives project root).
 * Jev tools call the TypeSafe/ns24 /v1/systemone endpoint directly (model "jev",
 * 4000 ms timeout, deterministic fallback) — src/decisions.ts judge() is NOT used.
 * Zero credentials are literal in this source: keys are read only from env/runtime
 * files at request time. Diagnostics go to stderr; stdout carries JSON-RPC only.
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

let z = null;
try {
  z = createRequire(import.meta.url)("zod");
} catch {
  // zod not resolvable from this script: see fallback branch in loadHandlers.
}
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "omp-harness-mcp", version: "1.0.0" };
const JEV_TIMEOUT_MS = 4000;
const DEFAULT_JEV_ENDPOINT = "https://api.ns24.io";
const DEFAULT_TOP_K = 5;

const TOOL_DEFINITIONS = [
  {
    name: "jev_decide",
    description: "Ask the TypeSafe Jev endpoint (model jev) to pick one option among candidates; deterministic fallback when unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["intake", "requirement", "priority", "readiness"], description: "Decision kind" },
        state: { description: "Opaque decision state" },
        candidates: { type: "array", description: "Options to decide among" },
        path: { type: "string", description: "Readiness block path (kind readiness)" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "jev_rank",
    description: "Ask the TypeSafe Jev endpoint (model jev) to rank options; deterministic fallback when unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        state: { description: "Opaque ranking state" },
        options: { type: "array", description: "Options to rank" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "jev_gate",
    description: "Ask the TypeSafe Jev endpoint (model jev) a yes/no gate question; deterministic fallback when unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        state: { description: "Opaque gate state" },
        question: { type: "string", description: "Yes/no question" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "intake_open",
    description: "Create <project>/.omp/work/<YYYY-MM-DD>/<slug>/ intake folder (tier M/L/XL).",
    inputSchema: {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["S", "M", "L", "XL"], description: "Task tier" },
        title: { type: "string", description: "Short task title; becomes the folder slug" },
        requirement: { type: "string", description: "The user's request, verbatim" },
        questions: { type: "array", description: "Clarifying questions to seed 01-clarify.md" },
        date: { type: "string", description: "Override YYYY-MM-DD (defaults to today)" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
        kind: { type: "string", enum: ["code", "product"], description: "Requirement kind" },
        source: { description: "Source context { kind, locator }" },
        acceptance: { type: "array", description: "Acceptance criteria [{ id, check }]" },
      },
      required: ["tier", "title", "requirement"],
      additionalProperties: true,
    },
  },
  {
    name: "harness_record",
    description: "Write outcome.json into a task's intake folder.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Intake folder path returned by intake_open" },
        tier: { type: "string", enum: ["S", "M", "L", "XL"], description: "Task tier" },
        goal: { type: "string", description: "One-sentence observable goal" },
        acceptance: { type: "array", description: "Acceptance entries" },
        models: { type: "array", description: "Model selectors actually used" },
        tokens: { type: "number", description: "Total tokens, 0 if unknown" },
        wall_ms: { type: "number", description: "Wall time in ms, 0 if unknown" },
        notes: { type: "string", description: "Deviation from plan, open items" },
        lesson: { description: "Design lesson { why_this_design, avoid_misconceptions, files?, reflection_question? }" },
      },
      required: ["dir", "tier", "goal", "acceptance", "models", "tokens", "wall_ms"],
      additionalProperties: true,
    },
  },
  {
    name: "harness_mine",
    description: "Group failed acceptance entries by signature into an evidence bundle.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
        since_days: { type: "number", description: "Window in days, default 14" },
        min_support: { type: "number", description: "Minimum cluster size, default 2" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "harness_gate",
    description: "Apply the harness admission rule to one candidate edit's split scores.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
        candidate_id: { type: "string", description: "Stable id, e.g. h-20261019-a" },
        target: { type: "string", description: "Failure signature this edit addresses" },
        surface: { type: "string", description: "File or config key the edit changes" },
        change: { type: "string", description: "The edit in one line" },
        in_before: { type: "number", description: "Held-in passes before" },
        in_after: { type: "number", description: "Held-in passes after" },
        ho_before: { type: "number", description: "Held-out passes before" },
        ho_after: { type: "number", description: "Held-out passes after" },
        repeats: { type: "number", description: "Evaluation repeats" },
      },
      required: ["candidate_id", "target", "surface", "change", "in_before", "in_after", "ho_before", "ho_after"],
      additionalProperties: true,
    },
  },
  {
    name: "harness_decide",
    description: "Ask the bounded TypeSafe Jev endpoint for a semantic judgment (intake/requirement/priority/readiness).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["intake", "requirement", "priority", "readiness"], description: "Judgment kind" },
        state: { type: "string", description: "Judgment state" },
        candidates: { type: "array", description: "Candidates" },
        path: { type: "string", description: "Readiness block path (kind readiness)" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "zero_mem_recall",
    description: "Query Zero-Mem recall for a project and return evidence lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Recall question" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
        top_k: { type: "number", description: "Max evidence items, default 5" },
        certified_only: { type: "boolean", description: "Only admit certified evidence" },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "ontology_check",
    description: "Compute deterministic 0..1 entity coverage of a query against the project ontology.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Prompt or task text to score" },
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
        certified_only: { type: "boolean", description: "Only consider certified ontology terms" },
        threshold: { type: "number", description: "Answerability threshold, default 0.6" },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "ontology_compile",
    description: "Compile the domain ontology into Zero-Mem SQLite and optional Ossie YAML.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project root (defaults to process.cwd)" },
        export_yaml: { type: "boolean", description: "Also write domain-ontology.yaml, default true" },
      },
      additionalProperties: true,
    },
  },
];

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/**
 * Minimal mock ExtensionAPI. Records registerTool calls so the real handlers from
 * src/tools.ts can be invoked as handler(callId, params, signal, onUpdate, ctx)
 * with ctx = { cwd }. Provides zod resolved via createRequire; if zod cannot be
 * resolved the fallback branch implements ontology handlers directly against
 * src/zeromem.ts/src/ontology.ts and reports harness tools as unavailable.
 */
let handlersPromise = null;
async function loadHandlers() {
  const registered = [];
  if (z) {
    try {
      const mod = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "tools.ts")).href);
      const toolsFn = mod.default ?? mod;
      toolsFn({
        registerTool: (def) => registered.push({ name: def.name, execute: def.execute }),
        registerCommand: () => {},
        registerFileWriteFallback: () => {},
        registerFileDeleteFallback: () => {},
        zod: z,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        pi: {},
        on: () => {},
      });
      return new Map(registered.map((r) => [r.name, r.execute]));
    } catch (err) {
      // src/tools.ts could not be loaded: fall back to direct implementations.
      handlersPromise = null; // mark so retry isn't cached broken
      throw err;
    }
  }
  // Fallback: zod unavailable via createRequire. Implement what we can directly
  // against src/zeromem.ts and src/ontology.ts; harness tools degrade to an
  // unavailable error (this branch does not run when zod is installed).
  const { compileOntology, checkOntologyCoverage, formatOntologyBrief } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "ontology.ts")).href);
  const fallback = (name) => async () => ({
    isError: true,
    content: [{ type: "text", text: `${name}: harness backend unavailable (zod not resolvable)` }],
  });
  return new Map([
    ["ontology_check", async (_id, params, _signal, _onUpdate, ctx) => {
      const root = path.resolve((params && params.cwd) ? params.cwd : (ctx && ctx.cwd) ? ctx.cwd : process.cwd());
      try {
        if (checkOntologyCoverage(root, String(params && params.query)).matchedTerms.length === 0) compileOntology(root);
      } catch {
        // best effort
      }
      const res = checkOntologyCoverage(root, String(params && params.query), {
        threshold: params && params.threshold,
        certifiedOnly: params && params.certified_only === true,
      });
      return { content: [{ type: "text", text: formatOntologyBrief(res) }], details: res };
    }],
    ["ontology_compile", async (_id, params, _signal, _onUpdate, ctx) => {
      const root = path.resolve((params && params.cwd) ? params.cwd : (ctx && ctx.cwd) ? ctx.cwd : process.cwd());
      const res = compileOntology(root, { exportYaml: !(params && params.export_yaml === false) });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], details: res };
    }],
    ["intake_open", fallback("intake_open")],
    ["harness_record", fallback("harness_record")],
    ["harness_mine", fallback("harness_mine")],
    ["harness_gate", fallback("harness_gate")],
    ["harness_decide", fallback("harness_decide")],
  ]);
}
function getHandlers() {
  if (!handlersPromise) handlersPromise = loadHandlers().catch((err) => {
    handlersPromise = null;
    throw err;
  });
  return handlersPromise;
}

/* ----------------------------- Jev tools ----------------------------- */

function resolveJevKey() {
  const key = process.env.TYPESAFE_API_KEY || process.env.NS24_API_KEY;
  if (key) return key;
  const file = process.env.JEV_KEY_FILE || "C:/Users/ADMIN/.config/typesafe/key";
  try {
    const trimmed = readFileSync(file, "utf8").trim();
    if (trimmed) return trimmed;
  } catch {
    // no key file at runtime path
  }
  return undefined;
}

function jevFallback(kind, params, err) {
  const candidates = Array.isArray(params && params.candidates) ? params.candidates : [];
  const first = candidates[0];
  const ref = first && typeof first === "object" ? (first.id ?? first.label ?? String(first)) : first ?? "none";
  const structured = { status: "unavailable", fallback: "deterministic" };
  if (kind === "decide") structured.decision = ref;
  const text = kind === "decide"
    ? `jev_decide: unavailable (deterministic fallback)\nprimary 0: ${ref}`
    : `jev_${kind}: unavailable (deterministic fallback)`;
  if (err) {
    try { process.stderr.write(`jev_${kind}: ${String((err && err.message) ?? err)}\n`); } catch {}
  }
  return { content: [{ type: "text", text }], structuredContent: structured };
}

async function jevCall(kind, params) {
  const key = resolveJevKey();
  if (!key) return jevFallback(kind, params, new Error("no jev key configured"));
  const endpoint = process.env.TYPESAFE_BASE_URL || DEFAULT_JEV_ENDPOINT;
  const url = new URL("/v1/systemone", endpoint).toString();
  const body = JSON.stringify({ model: "jev", kind, ...(params && typeof params === "object" ? params : {}) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body,
      signal: controller.signal,
    });
    let payload;
    try {
      payload = await res.json();
    } catch {
      payload = { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
    }
    if (!res.ok) throw new Error(`jev ${kind}: HTTP ${res.status}`);
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  } catch (err) {
    return jevFallback(kind, params, err);
  } finally {
    clearTimeout(timer);
  }
}

async function handleJevDecide(params) { return jevCall("decide", params && typeof params === "object" ? { state: params.state, candidates: params.candidates, path: params.path } : {}); }
async function handleJevRank(params) { return jevCall("rank", params && typeof params === "object" ? { state: params.state, options: params.options } : {}); }
async function handleJevGate(params) { return jevCall("gate", params && typeof params === "object" ? { state: params.state, question: params.question } : {}); }

/* ----------------------------- zero_mem_recall ----------------------------- */

async function handleZeroMemRecall(params, ctx) {
  const cwd = (params && params.cwd) ? params.cwd : (ctx && ctx.cwd) ? ctx.cwd : process.cwd();
  const { ZeroMemBridge } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "zeromem.ts")).href);
  const bridge = new ZeroMemBridge();
  try {
    const result = await bridge.query(cwd, String(params && params.query ? params.query : ""), {
      topK: params && params.top_k ? Number(params.top_k) : DEFAULT_TOP_K,
      certifiedOnly: params && params.certified_only === true,
    });
    const evidence = Array.isArray(result && result.evidence) ? result.evidence : [];
    const text = evidence.map((e) => (e && e.text ? String(e.text) : "")).filter(Boolean).join("\n") || "(no evidence)";
    return { content: [{ type: "text", text }], structuredContent: result };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String((err && err.message) ?? err) }] };
  } finally {
    bridge.close();
  }
}

/* ----------------------------- tools/call dispatch ----------------------------- */

async function handleToolsCall(params, ctx) {
  if (!params || typeof params !== "object") {
    return { isError: true, content: [{ type: "text", text: "tools/call: params must be an object" }] };
  }
  const name = params.name;
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (!name || typeof name !== "string" || !TOOL_NAMES.has(name)) {
    return { isError: true, content: [{ type: "text", text: `tools/call: unknown tool ${String(name)}` }] };
  }
  // Built-in handlers (not registered via src/tools.ts).
  if (name === "zero_mem_recall") return handleZeroMemRecall(args, ctx);
  if (name === "jev_decide") return handleJevDecide(args);
  if (name === "jev_rank") return handleJevRank(args);
  if (name === "jev_gate") return handleJevGate(args);
  const handlers = await getHandlers();
  const handler = handlers && handlers.get(name);
  if (!handler) {
    return { isError: true, content: [{ type: "text", text: `tools/call: handler unavailable for ${name}` }] };
  }
  let result;
  try {
    result = await handler(`call_${name}`, args, new AbortController().signal, undefined, ctx);
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String((err && err.message) ?? err) }] };
  }
  const content = Array.isArray(result && result.content) && result.content.length > 0
    ? result.content
    : [{ type: "text", text: String(result && result.text !== undefined ? result.text : result ?? "") }];
  const response = { content };
  if (result && result.structuredContent) response.structuredContent = result.structuredContent;
  else if (result && result.details !== undefined) response.structuredContent = result.details;
  return response;
}

/* ----------------------------- JSON-RPC dispatch ----------------------------- */

export async function handleJsonRpcRequest(req, deps = {}) {
  const defaultCwd = deps && deps.cwd ? deps.cwd : process.cwd();
  if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") {
    return null; // cannot address a response: ignore (notification-like)
  }
  const { method, id } = req;
  const hasId = id !== undefined;
  const respond = (payload) => ({ jsonrpc: "2.0", id, ...payload });
  try {
    if (method === "initialize") {
      return respond({ result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    }
    if (method === "notifications/initialized") return null;
    if (method === "ping") return respond({ result: {} });
    if (method === "tools/list") return respond({ result: { tools: TOOL_DEFINITIONS } });
    if (method === "tools/call") {
      return respond({ result: await handleToolsCall(req.params, { cwd: defaultCwd }) });
    }
    return hasId ? respond({ error: { code: -32601, message: `Method not found: ${method}` } }) : null;
  } catch (err) {
    return hasId ? respond({ error: { code: -32603, message: String((err && err.message) ?? err) } }) : null;
  }
}

export async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      // malformed line: nothing to respond to; stderr stays clean of stdout
      continue;
    }
    const response = await handleJsonRpcRequest(req);
    if (response !== null) process.stdout.write(JSON.stringify(response) + "\n");
  }
}

function isMainEntry() {
  try {
    return path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  });
}
