#!/usr/bin/env node
/**
 * claude-memory-hook.mjs — Claude Code hook (UserPromptSubmit / Stop) backed by
 * omp Zero-Mem. Fail-open: every path exits 0 and writes nothing when there is
 * nothing to inject or when any step fails.
 *
 * Modules (zeromem.ts, ontology.ts) are loaded lazily via an absolute path
 * resolved against the omp harness root, so this file can be copied to any
 * location (e.g. ~/.claude/hooks/memory-intake.mjs) without breaking module
 * resolution. Credentials are never read here.
 *
 * - UserPromptSubmit: when prompt.length >= 24, recall from Zero-Mem and score
 *   ontology coverage; when there is recall evidence or matched ontology terms,
 *   write exactly one JSON object to stdout with the hookSpecificOutput shape.
 * - Stop: recover last user/assistant messages from the transcript (or ev.request
 *   / ev.outcome), extractUnits + appendUnits + ensureGitignore + index +
 *   compileOntology, all inside one fail-open try/catch; exit code 0 always.
 */

import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const MIN_PROMPT_CHARS = 24;
const DEFAULT_TOP_K = 5;

function resolveHarnessRoot() {
  const candidates = [];
  if (process.env.OMP_HARNESS_ROOT) candidates.push(process.env.OMP_HARNESS_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push("D:/omp-harness");
  for (const candidate of candidates) {
    try {
      if (
        existsSync(path.join(candidate, "src", "zeromem.ts")) &&
        existsSync(path.join(candidate, "src", "ontology.ts"))
      ) {
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

let modulesPromise = null;
function loadModules() {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const root = resolveHarnessRoot();
      if (!root) return null;
      const zeromem = await import(pathToFileURL(path.join(root, "src", "zeromem.ts")).href);
      const ontology = await import(pathToFileURL(path.join(root, "src", "ontology.ts")).href);
      return { zeromem, ontology, root };
    })().catch(() => null);
  }
  return modulesPromise;
}

/**
 * Run one hook event. Never throws: returns { exitCode: 0, written? }.
 */
export async function runClaudeMemoryHook(ev, opts = {}) {
  const cwd = String(ev && ev.cwd ? ev.cwd : opts && opts.cwd ? opts.cwd : process.cwd());
  try {
    if (ev && ev.hook_event_name === "UserPromptSubmit") return handleUserPromptSubmit(ev, cwd);
    if (ev && ev.hook_event_name === "Stop") {
      await handleStop(ev, cwd);
      return { exitCode: 0 };
    }
  } catch {
    // fail-open: any failure is silent
  }
  return { exitCode: 0 };
}

function contentString(msg) {
  if (!msg) return "";
  const c = msg.message !== undefined ? msg.message.content : msg.content;
  if (c === undefined || c === null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : String(p && p.text ? p.text : ""))).join("");
  return String(c);
}

/**
 * Recover last user message and last assistant message from the transcript JSONL,
 * falling back to ev.request / ev.outcome.
 */
function recoverStopMessages(ev) {
  let request = "";
  let outcome = "";
  const sessionId = ev && (ev.session_id || ev.sessionId) ? String(ev.session_id || ev.sessionId) : randomUUID();
  const transcriptPath = ev && ev.transcript_path ? String(ev.transcript_path) : "";
  if (transcriptPath) {
    try {
      const text = readFileSync(transcriptPath, "utf8");
      let lastUser = null;
      let lastAssistant = null;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj && obj.type === "user") lastUser = obj;
        else if (obj && obj.type === "assistant") lastAssistant = obj;
      }
      request = contentString(lastUser);
      outcome = contentString(lastAssistant);
    } catch {
      // unreadable or unparsable transcript: fall back to ev.request / ev.outcome
    }
  }
  if (!request && !outcome) {
    const req = ev && ev.request;
    request = String(req ? (req.prompt || req.text || req.message) : "");
    outcome = String(ev && (ev.outcome || (req && req.outcome)) ? ev.outcome || (req && req.outcome) : "");
  }
  return { request, outcome, sessionId };
}

function handleUserPromptSubmit(ev, cwd) {
  const prompt = String(ev && ev.prompt ? ev.prompt : "");
  if (prompt.length < MIN_PROMPT_CHARS) return { exitCode: 0, written: false };
  return (async () => {
    const mods = await loadModules();
    if (!mods) return { exitCode: 0, written: false };
    const { ZeroMemBridge } = mods.zeromem;
    const { checkOntologyCoverage } = mods.ontology;
    const instance = new ZeroMemBridge();
    try {
      const result = instance.query(cwd, prompt, { topK: DEFAULT_TOP_K });
      const coverage = checkOntologyCoverage(cwd, prompt);
      const recallText = (result && result.evidence ? result.evidence : [])
        .map((e) => (e && e.text ? String(e.text) : ""))
        .filter(Boolean)
        .join("\n");
      const ontologyText = (coverage && coverage.matchedTerms ? coverage.matchedTerms : [])
        .map((t) => (t && t.termId ? String(t.termId) : ""))
        .filter(Boolean)
        .join("\n");
      if (!recallText && !ontologyText) return { exitCode: 0, written: false };
      const additionalContext = `<zero-mem-recall>${recallText}</zero-mem-recall>\n<ontology-context>${ontologyText}</ontology-context>`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }));
      return { exitCode: 0, written: true };
    } finally {
      instance.close();
    }
  })();
}

async function handleStop(ev, cwd) {
  const mods = await loadModules();
  if (!mods) return { exitCode: 0 };
  const { ZeroMemBridge, extractUnits, appendUnits, ensureGitignore } = mods.zeromem;
  const { compileOntology } = mods.ontology;
  const bridge = new ZeroMemBridge();
  try {
    const { request, outcome, sessionId } = recoverStopMessages(ev);
    const units = extractUnits(request, outcome, sessionId);
    if (units.length) appendUnits(cwd, units);
    ensureGitignore(cwd);
    await bridge.index(cwd);
    compileOntology(cwd);
  } catch {
    // fail-open: missing store, unreadable transcript, unparsable JSON -> nothing
  } finally {
    bridge.close();
  }
  return { exitCode: 0 };
}

export async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    try {
      await runClaudeMemoryHook(ev);
    } catch {
      // fail-open: never let the CLI loop die on a hook event
    }
  }
  process.exitCode = 0;
}

// Entry-point check: compare resolved script path to import.meta URL.
const IS_MAIN = (() => {
  try {
    const argv1 = process.argv[1] || "";
    return argv1 ? path.resolve(argv1) === fileURLToPath(import.meta.url) : false;
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  process.exitCode = 0;
  main().catch(() => {}).finally(() => {
    process.exitCode = 0;
  });
}
