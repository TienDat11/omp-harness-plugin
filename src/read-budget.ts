/**
 * read-budget.ts — token cap and duplicate-read guard for the `read` tool.
 *
 * WHY: two avoidable costs dominate a long coding session. A single wide range
 * (`file.ts:1-4000`) spends a whole context window in one call, and a file the
 * session already holds gets read again from line 1. Both are decided before
 * the tool runs, so nothing here touches the prompt cache or history.
 *
 * WHY the selector grammar is parsed here instead of imported from
 * `@oh-my-pi/pi-coding-agent/tools/read-selector`: this repo imports the omp
 * package as types only, because `node --test` refuses to strip types under
 * `node_modules`. The subset parsed here is small and every disagreement
 * degrades to "no guard", never to a wrong rewrite.
 *
 * Liveness comes from the live session branch, never from a private ledger: a
 * previous read stops counting once its result is pruned, once a compaction
 * boundary moves past it, or once the file's stat no longer matches the stat
 * captured when that result arrived.
 */
import { type Stats, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getReadStat, normalizePathKey, resolveHomeDir } from "./state.ts";

/** Widest explicit range the guard lets through. Anything wider is narrowed to this. */
export const MAX_READ_LINES = 180;

/** A whole-file `:raw` read above this many bytes is narrowed to {@link MAX_READ_LINES} lines. */
export const MAX_RAW_BYTES = 64 * 1024;

/** Maximum number of files surfaced in a parent-read ledger handoff. */
export const MAX_LEDGER_FILES = 12;

/** Maximum file size scanned for symbol extraction. */
export const MAX_SYMBOL_SCAN_BYTES = 256 * 1024;

/** Maximum symbols collected per file. */
export const MAX_FILE_SYMBOLS = 24;

const symbolCache = new Map<string, { mtimeMs: number; size: number; symbols: string[] }>();

/** Tag marking a parent-read ledger injected into a subagent task. */
export const PARENT_LEDGER_TAG = "<parent-read-ledger>";

/** Tools that rewrite a file; a read older than one of these is stale. */
const WRITE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

/** `skill://`, `xd://`, `agent://`, `artifact://` … are served by routers, not the filesystem. */
const INTERNAL_URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface SelRange {
  start: number;
  /** Absent means "to end of file". */
  end?: number;
}

export type ParsedSelector =
  | { kind: "none" }
  | { kind: "raw" }
  | { kind: "conflicts" }
  | { kind: "image" }
  | { kind: "lines"; ranges: SelRange[]; raw?: boolean }
  | { kind: "tail"; count: number; raw?: boolean };

/** Minimal shape of a session branch entry; the policy only reads these fields. */
interface BranchEntry {
  type?: string;
  id?: string;
  firstKeptEntryId?: string;
  message?: {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    prunedAt?: unknown;
    content?: unknown;
  };
}

interface ToolCallBlock {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

/**
 * Session branch entries arrive as untyped JSON. Every field read here is
 * optional, so a non-object simply yields an empty entry and is skipped.
 */
function asEntry(value: unknown): BranchEntry {
  return typeof value === "object" && value !== null ? (value as BranchEntry) : {};
}

/** Same for content blocks inside an assistant message. */
function asCallBlock(value: unknown): ToolCallBlock {
  return typeof value === "object" && value !== null ? (value as ToolCallBlock) : {};
}

// ---------------------------------------------------------------------------
// Selector grammar
// ---------------------------------------------------------------------------

/** One comma-separated part: `50`, `1-5`, `1..5`, `L1-L5`, `19,59`, `50+150`, `50-`, `-60`. */
function parsePart(rawPart: string, pinBare = false): SelRange | number | null {
  const part = rawPart.startsWith(":") ? rawPart.slice(1) : rawPart;
  const bare = /^[lL]?(\d+)$/.exec(part);
  if (bare) {
    const start = Number(bare[1]);
    return pinBare ? { start, end: start } : { start };
  }
  const explicit = /^[lL]?(\d+)(?:-|\.\.)[lL]?(\d+)$/.exec(part);
  if (explicit) return { start: Number(explicit[1]), end: Number(explicit[2]) };
  const onward = /^[lL]?(\d+)\+(\d+)$/.exec(part);
  if (onward) {
    const start = Number(onward[1]);
    return { start, end: start + Math.max(1, Number(onward[2])) - 1 };
  }
  const openEnded = /^[lL]?(\d+)-$/.exec(part);
  if (openEnded) return { start: Number(openEnded[1]) };
  if (/^-\d+$/.test(part)) return Number(part.slice(1));
  return null;
}

function parseRangeChunk(chunk: string, raw: boolean): ParsedSelector | null {
  const parts = chunk.split(",");
  const pinBare = raw || parts.length > 1;
  const ranges: SelRange[] = [];
  let tail = 0;
  for (const part of parts) {
    const parsed = parsePart(part, pinBare);
    if (parsed === null) return null;
    if (typeof parsed === "number") tail = Math.max(tail, parsed);
    else ranges.push(parsed);
  }
  // A list mixing a tail keeps the longest tail, matching the read tool.
  if (tail > 0) return raw ? { kind: "tail", count: tail, raw } : { kind: "tail", count: tail };
  if (ranges.length === 0) return null;
  return raw ? { kind: "lines", ranges, raw } : { kind: "lines", ranges };
}

/** Parse a selector suffix (the text after the last `:`), or `null` when it is not one. */
export function parseSelector(sel: string | undefined): ParsedSelector | null {
  if (sel === undefined || sel === "") return null;
  const lower = sel.toLowerCase();
  if (lower === "raw") return { kind: "raw" };
  if (lower === "conflicts") return { kind: "conflicts" };
  if (lower === "img") return { kind: "image" };
  const compound = /^(?:(raw):([^:]+)|([^:]+):(raw))$/i.exec(sel);
  if (compound) return parseRangeChunk(compound[1] === undefined ? compound[3] : compound[2], true);
  if (sel.includes(":")) return null;
  return parseRangeChunk(sel, false);
}

export function expandHome(rawPath: string): string {
  const home = resolveHomeDir();
  if (!home) return "";
  if (rawPath === "~") return home;
  return rawPath.startsWith("~/") ? path.join(home, rawPath.slice(2)) : rawPath;
}

const HASHLINE_HEADER_RE = /^\[([^\]#\r\n]+)#([0-9a-fA-F]{4})\]/gm;
const HASHLINE_MV_RE = /^MV\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s\r\n]+))\s*$/gm;

/** Extract target file paths from a write/edit/ast_edit tool call's arguments. */
export function extractWriteTargets(toolName: string, args: Record<string, unknown>): string[] {
  const targets: string[] = [];
  if (typeof args.path === "string" && args.path !== "") targets.push(args.path);
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) {
      if (typeof entry === "string" && entry !== "") targets.push(entry);
    }
  }
  if (toolName === "edit" && typeof args.input === "string") {
    for (const match of args.input.matchAll(HASHLINE_HEADER_RE)) {
      if (match[1]) targets.push(match[1]);
    }
    for (const match of args.input.matchAll(HASHLINE_MV_RE)) {
      const dest = match[1] ?? match[2] ?? match[3];
      if (dest) targets.push(dest);
    }
  }
  return targets;
}

/**
 * Split `file.ts:1-20` or `file.ts:1-20:raw` into path and selector. A literal
 * path that exists wins, so POSIX filenames and NTFS alternate data streams
 * containing a colon are read as written. An unrecognized suffix is part of the path.
 */
export function splitPathAndSelector(rawPath: string, cwd: string): { path: string; sel?: string } {
  const colon = rawPath.lastIndexOf(":");
  if (colon <= 0) return { path: rawPath };
  if (existsSync(path.resolve(cwd, expandHome(rawPath)))) return { path: rawPath };
  const tail = rawPath.slice(colon + 1);
  const head = rawPath.slice(0, colon);
  const innerColon = head.lastIndexOf(":");
  if (innerColon > 0) {
    const compoundSel = `${head.slice(innerColon + 1)}:${tail}`;
    if (parseSelector(compoundSel) !== null && !existsSync(path.resolve(cwd, expandHome(head)))) {
      return { path: head.slice(0, innerColon), sel: compoundSel };
    }
  }
  if (parseSelector(tail) === null) return { path: rawPath };
  return { path: head, sel: tail };
}

/** Canonical, comparable form of a selector. A bare read keys as `""`. */
export function selectorKey(parsed: ParsedSelector | null): string {
  if (parsed === null) return "";
  switch (parsed.kind) {
    case "lines": {
      const body = parsed.ranges.map((range) => `${range.start}-${range.end ?? ""}`).join(",");
      return parsed.raw === true ? `lines:${body}:raw` : `lines:${body}`;
    }
    case "tail": {
      const body = `tail:${parsed.count}`;
      return parsed.raw === true ? `${body}:raw` : body;
    }
    case "raw":
      return "raw";
    case "conflicts":
      return "conflicts";
    case "image":
      return "img";
    default:
      return "";
  }
}

/**
 * Replacement selector text (no leading `:`) when the request would read more
 * than {@link MAX_READ_LINES} explicit lines or a whole file above
 * {@link MAX_RAW_BYTES}, otherwise `undefined`.
 *
 * An open-ended range (`:50`, `:50-`) is left alone: the read tool already
 * bounds it with `read.defaultLimit`, so rewriting it would only duplicate that
 * decision.
 */
export function narrowSelector(parsed: ParsedSelector | null, sizeBytes: number): string | undefined {
  if (parsed === null) return undefined;
  if (parsed.kind === "tail") {
    return parsed.count > MAX_READ_LINES ? `-${MAX_READ_LINES}${parsed.raw === true ? ":raw" : ""}` : undefined;
  }
  if (parsed.kind === "raw") {
    return sizeBytes > MAX_RAW_BYTES ? `1-${MAX_READ_LINES}:raw` : undefined;
  }
  if (parsed.kind !== "lines") return undefined;

  let explicit = 0;
  let hasOpenEnded = false;
  for (const range of parsed.ranges) {
    if (range.end !== undefined && range.end < range.start) return undefined;
    if (range.end === undefined) {
      hasOpenEnded = true;
      continue;
    }
    explicit += range.end - range.start + 1;
  }
  // Only bail out on a single open-ended range, or when explicit ranges are small.
  if (hasOpenEnded && (parsed.ranges.length === 1 || explicit <= MAX_READ_LINES)) return undefined;
  if (explicit <= MAX_READ_LINES && !hasOpenEnded) return undefined;
  if (explicit === 0 && hasOpenEnded) return undefined;

  const kept: string[] = [];
  let used = 0;
  for (const range of parsed.ranges) {
    if (range.end === undefined) continue;
    if (used >= MAX_READ_LINES) break;
    const take = Math.min(range.end - range.start + 1, MAX_READ_LINES - used);
    if (take <= 0) continue;
    kept.push(`${range.start}-${range.start + take - 1}`);
    used += take;
  }
  if (kept.length === 0) return undefined;
  return `${kept.join(",")}${parsed.raw === true ? ":raw" : ""}`;
}

/** True when every range of `request` sits inside one range of `held`, same raw mode. */
function covers(held: ParsedSelector, request: ParsedSelector): boolean {
  if (held.kind !== "lines" || request.kind !== "lines") return false;
  if (held.raw === true !== (request.raw === true)) return false;
  return request.ranges.every((wanted) => {
    const wantedEnd = wanted.end ?? wanted.start + MAX_READ_LINES - 1;
    return held.ranges.some((range) => {
      const heldEnd = range.end ?? range.start + MAX_READ_LINES - 1;
      return range.start <= wanted.start && heldEnd >= wantedEnd;
    });
  });
}

// ---------------------------------------------------------------------------
// Live-branch lookup
// ---------------------------------------------------------------------------

/** First text line of a tool result, which `read` prefixes with `[name#TAG]`. */
function firstLine(content: unknown): string {
  if (typeof content === "string") return content.split("\n", 1)[0] ?? "";
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (typeof block === "object" && block !== null && "text" in block) {
      const text = block.text;
      if (typeof text === "string") return text.split("\n", 1)[0] ?? "";
    }
  }
  return "";
}

interface BranchScan {
  /** Tool calls by id, so a result can be matched back to the arguments that produced it. */
  calls: Map<string, { name: string; args: Record<string, unknown> }>;
  /** Index of the oldest entry the model can still see. */
  boundary: number;
  /** Latest write-tool call index per normalized path. */
  lastWrite: Map<string, number>;
}

function scanBranch(branch: readonly unknown[], cwd: string): BranchScan {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const lastWrite = new Map<string, number>();
  let compaction: BranchEntry | undefined;
  for (let i = 0; i < branch.length; i++) {
    const entry = asEntry(branch[i]);
    if (entry.type === "compaction") compaction = entry;
    const message = entry.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const raw of message.content) {
      const block = asCallBlock(raw);
      if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      const args = block.arguments ?? {};
      calls.set(block.id, { name: block.name, args });
      if (!Object.hasOwn(WRITE_TOOLS, block.name)) continue;
      for (const target of extractWriteTargets(block.name, args)) {
        const split = splitPathAndSelector(target, cwd);
        lastWrite.set(normalizePathKey(path.resolve(cwd, expandHome(split.path))), i);
      }
    }
  }
  let boundary = 0;
  if (compaction) {
    boundary = branch.length;
    if (compaction.firstKeptEntryId) {
      const kept = branch.findIndex((entry) => asEntry(entry).id === compaction?.firstKeptEntryId);
      if (kept !== -1) boundary = kept;
    }
  }
  return { calls, boundary, lastWrite };
}

/**
 * A read whose result is still visible in the session and still describes the
 * file on disk, or `undefined`.
 */
function findLiveRead(
  targetKey: string,
  request: ParsedSelector | null,
  requestKey: string,
  scan: BranchScan,
  branch: readonly unknown[],
  current: { mtimeMs: number; size: number },
  cwd: string,
): { tag: string; selector: string } | undefined {
  const writeIndex = scan.lastWrite.get(targetKey);
  for (let i = branch.length - 1; i >= scan.boundary; i--) {
    const message = asEntry(branch[i]).message;
    if (message?.role !== "toolResult" || message.toolName !== "read" || message.isError === true) continue;
    // A pruned result is no longer in the model's context, so reading again is correct.
    if (message.prunedAt) continue;
    // A partial/truncated read result does not fully describe the file, so it
    // must not cover a subsequent read request (otherwise the follow-up slice
    // would be wrongly blocked).
    const contentText = (() => {
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : ""))
          .join("\n");
      }
      return "";
    })();
    if (/\bShowing line(?:s)?\b.*\bpartial\b/i.test(contentText) || /\[Some lines truncated to \d+ chars/i.test(contentText)) continue;
    if (writeIndex !== undefined && writeIndex > i) continue;
    const callId = message.toolCallId;
    if (callId === undefined) continue;
    const call = scan.calls.get(callId);
    if (!call) continue;
    const rawArg = call.args.path;
    if (typeof rawArg !== "string") continue;
    const split = splitPathAndSelector(rawArg, cwd);
    if (normalizePathKey(path.resolve(cwd, expandHome(split.path))) !== targetKey) continue;
    const heldStat = getReadStat(callId);
    if (!heldStat || heldStat.mtimeMs !== current.mtimeMs || heldStat.size !== current.size) continue;
    // The guard narrows wide requests before they run, so what the session
    // actually holds is the narrowed selector, not the one the model typed.
    const heldParsed = parseSelector(split.sel);
    const heldNarrow = narrowSelector(heldParsed, current.size);
    const held = heldNarrow === undefined ? heldParsed : parseSelector(heldNarrow);
    const heldKey = selectorKey(held);
    const hasFoldedLines = /(?:^|\n)\s*\u2026\s*(?:\r?\n|$)/.test(contentText);
    if (heldKey !== requestKey && (hasFoldedLines || !(held !== null && request !== null && covers(held, request)))) continue;
    return { tag: firstLine(message.content), selector: heldKey };
  }
  return undefined;
}

export interface ReadVerdict {
  /** Rewritten `path` argument: the same file, narrowed to {@link MAX_READ_LINES} lines. */
  rewrite?: string;
  /** Set when the request must not run at all. */
  block?: string;
}

export interface LiveReadSummary {
  path: string;
  tag: string;
  windows: string[];
  symbols?: string[];
}

export function extractFileSymbols(filePath: string, maxSymbols = MAX_FILE_SYMBOLS): string[] {
  let stat: Stats;
  try {
    stat = statSync(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  if (!/\.(?:[cm]?[jt]sx?|py|rs|go)$/i.test(filePath)) return [];
  const cacheKey = `${normalizePathKey(filePath)}::${stat.mtimeMs}::${stat.size}`;
  if (maxSymbols === MAX_FILE_SYMBOLS) {
    const cached = symbolCache.get(cacheKey);
    if (cached) return cached.symbols.slice(0, maxSymbols);
  }
  let text: string;
  try {
    if (stat.size > MAX_SYMBOL_SCAN_BYTES) {
      text = readFileSync(filePath, "utf8").slice(0, MAX_SYMBOL_SCAN_BYTES);
    } else {
      text = readFileSync(filePath, "utf8");
    }
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const primary: Array<{ line: number; entry: string }> = [];
  const secondary: Array<{ line: number; entry: string }> = [];
  const tsJsPrimary = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const tsJsSecondary = /^(?:export\s+(?:default\s+)?)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)|^export\s+(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/;
  const pyPrimary = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const rustGoPrimary = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|func|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const isPy = /\.py$/i.test(filePath);
  const isRustGo = /\.(?:rs|go)$/i.test(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isPy) {
      const m = line.match(pyPrimary);
      if (m?.[1]) primary.push({ line: i + 1, entry: `${m[1]}@${i + 1}` });
    } else if (isRustGo) {
      const m = line.match(rustGoPrimary);
      if (m?.[1]) primary.push({ line: i + 1, entry: `${m[1]}@${i + 1}` });
    } else {
      let m = line.match(tsJsPrimary);
      if (m?.[1]) primary.push({ line: i + 1, entry: `${m[1]}@${i + 1}` });
      else {
        m = line.match(tsJsSecondary);
        const name = m?.[1] ?? m?.[2];
        if (name) secondary.push({ line: i + 1, entry: `${name}@${i + 1}` });
      }
    }
  }
  const chosen: Array<{ line: number; entry: string }> = [];
  const seen = new Set<string>();
  for (const p of primary) {
    if (chosen.length >= maxSymbols) break;
    if (seen.has(p.entry)) continue;
    seen.add(p.entry);
    chosen.push(p);
  }
  for (const s of secondary) {
    if (chosen.length >= maxSymbols) break;
    if (seen.has(s.entry)) continue;
    seen.add(s.entry);
    chosen.push(s);
  }
  chosen.sort((a, b) => a.line - b.line);
  const symbols = chosen.map((x) => x.entry);
  if (maxSymbols === MAX_FILE_SYMBOLS) {
    symbolCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, symbols });
  }
  return symbols;
}

export function isSafetyOrRulePath(filePath: string): boolean {
  return /(?:^|[\\/])(?:AGENTS|CLAUDE|CONTEXT)\.md$/i.test(filePath.replace(/\\/g, "/"));
}
export function collectLiveReads(
  branch: readonly unknown[],
  cwd: string,
  limit = MAX_LEDGER_FILES,
): LiveReadSummary[] {
  const scan = scanBranch(branch, cwd);
  const byFile = new Map<string, LiveReadSummary>();
  for (let i = branch.length - 1; i >= scan.boundary; i--) {
    const message = asEntry(branch[i]).message;
    if (message?.role !== "toolResult" || message.toolName !== "read" || message.isError === true) continue;
    if (message.prunedAt) continue;
    const callId = message.toolCallId;
    if (typeof callId !== "string") continue;
    const call = scan.calls.get(callId);
    if (!call) continue;
    const rawArg = call.args.path;
    if (typeof rawArg !== "string" || rawArg === "" || INTERNAL_URI_RE.test(rawArg)) continue;
    const split = splitPathAndSelector(rawArg, cwd);
    const resolved = path.resolve(cwd, expandHome(split.path));
    const targetKey = normalizePathKey(resolved);
    const writeIndex = scan.lastWrite.get(targetKey);
    if (writeIndex !== undefined && writeIndex > i) continue;
    let stat: Stats;
    try {
      stat = statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const heldStat = getReadStat(callId);
    if (!heldStat || heldStat.mtimeMs !== stat.mtimeMs || heldStat.size !== stat.size) continue;
    const heldParsed = parseSelector(split.sel);
    const heldNarrow = narrowSelector(heldParsed, stat.size);
    const held = heldNarrow === undefined ? heldParsed : parseSelector(heldNarrow);
    const heldKey = selectorKey(held);
    const windowLabel = heldKey === "" ? "the default window" : heldKey.replace(/^lines:/, "lines ");
    const rel = path.relative(cwd, resolved).replace(/\\/g, "/");
    const displayPath =
      rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : split.path.replace(/\\/g, "/");
    const tag = firstLine(message.content);
    const existing = byFile.get(targetKey);
    if (existing) {
      if (!existing.windows.includes(windowLabel)) existing.windows.push(windowLabel);
    } else {
      if (byFile.size >= limit) continue;
      const symbols = extractFileSymbols(resolved);
      byFile.set(targetKey, { path: displayPath, tag, windows: [windowLabel], ...(symbols.length > 0 ? { symbols } : {}) });
    }
  }
  return [...byFile.values()].sort((a, b) => {
    const aSafe = isSafetyOrRulePath(a.path) ? 0 : 1;
    const bSafe = isSafetyOrRulePath(b.path) ? 0 : 1;
    return aSafe - bSafe;
  }).slice(0, limit);
}
export function resolveTaskInput(
  input: Record<string, unknown>,
  branch: readonly unknown[],
  cwd: string,
): Record<string, unknown> | undefined {
  const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
  const hasSingleTask =
    !Array.isArray(input.tasks) && typeof input.task === "string" && input.task.trim() !== "";
  const hasVibeSpawn =
    typeof input.prompt === "string" && input.prompt.trim() !== "" && !input.prompt.includes(PARENT_LEDGER_TAG);
  if (!hasTasks && !hasSingleTask && !hasVibeSpawn) return undefined;
  if (
    (typeof input.context === "string" && input.context.includes(PARENT_LEDGER_TAG)) ||
    (typeof input.task === "string" && input.task.includes(PARENT_LEDGER_TAG))
  ) {
    return undefined;
  }
  const live = collectLiveReads(branch, cwd);
  if (live.length === 0) return undefined;
  const rows = live.map((entry) => {
    const anchor = entry.tag === "" ? "" : ` ${entry.tag}`;
    const symSuffix = entry.symbols && entry.symbols.length > 0 ? ` — symbols: ${entry.symbols.join(", ")}` : "";
    return `- ${entry.path}${anchor} (${entry.windows.join(", ")})${symSuffix}`;
  });
  const block = `${PARENT_LEDGER_TAG}\nFiles already read in the parent session (stat-verified live; read only the narrow :start-end slice you need, never whole files from :1):\n${rows.join("\n")}\n</parent-read-ledger>`;
  if (hasTasks) {
    const prev = typeof input.context === "string" ? input.context.trim() : "";
    return { ...input, context: prev === "" ? block : `${prev}\n\n${block}` };
  }
  if (hasVibeSpawn) {
    const prompt = String(input.prompt);
    return { ...input, prompt: `${prompt.trim()}\n\n${block}` };
  }
  const prevTask = String(input.task).trim();
  return { ...input, task: `${prevTask}\n\n${block}` };
}

/**
 * Decide one `read` request before it executes.
 *
 * - A range wider than {@link MAX_READ_LINES} (or a whole-file `:raw` above
 *   {@link MAX_RAW_BYTES}) is narrowed, not refused: the tool's own footer then
 *   tells the model where to continue.
 * - A request whose content is still live in the session is refused, with the
 *   `[name#TAG]` anchor of the result already in context.
 */
export function evaluateRead(rawPath: string, cwd: string, branch: readonly unknown[]): ReadVerdict | undefined {
  if (rawPath === "" || INTERNAL_URI_RE.test(rawPath)) return undefined;
  const split = splitPathAndSelector(rawPath, cwd);
  const resolved = path.resolve(cwd, expandHome(split.path));
  let stat: Stats;
  try {
    stat = statSync(resolved);
  } catch {
    // Missing path: the read tool reports the error.
    return undefined;
  }
  // Directory listings are cheap and go stale as files appear; no guard.
  if (!stat.isFile()) return undefined;

  const current = { mtimeMs: stat.mtimeMs, size: stat.size };
  const parsed = parseSelector(split.sel);
  const narrowed = narrowSelector(parsed, current.size);
  const effective = narrowed === undefined ? parsed : parseSelector(narrowed);
  const effectiveKey = selectorKey(effective);

  const live = findLiveRead(normalizePathKey(resolved), effective, effectiveKey, scanBranch(branch, cwd), branch, current, cwd);
  if (live) {
    const anchor = live.tag === "" ? split.path : live.tag;
    const shown = live.selector === "" ? "the default window" : live.selector.replace(/^lines:/, "lines ");
    const cap = narrowed === undefined ? "" : ` A read may request at most ${MAX_READ_LINES} lines.`;
    const syms = extractFileSymbols(resolved);
    const symSuffix = syms.length > 0 ? ` Symbols in file: ${syms.join(", ")}.` : "";
    return {
      block: `blocked: ${path.basename(split.path)} (${shown}) is already in context as ${anchor}; reuse it.${cap} Re-reading is allowed once the file changes or that result is pruned.${symSuffix}`,
    };
  }
  if (narrowed === undefined) return undefined;
  return { rewrite: `${split.path}:${narrowed}` };
}
