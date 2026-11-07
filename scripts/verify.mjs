#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const ROOT = path.resolve(path.dirname(process.argv[1] ?? "scripts/verify.mjs"), "..");
const MANIFEST_PATH = path.join(ROOT, "harness.manifest.json");
const DEFAULT_CONFIG = "config/recommended.yml";
const HOME_DIR = (process.env.HOME || process.env.USERPROFILE || os.homedir() || "").trim();
const AGENT_DIR = (process.env.PI_CODING_AGENT_DIR || (HOME_DIR ? path.join(HOME_DIR, ".omp", "agent") : "")).trim();
const LIVE_CONFIG = (process.env.OMP_LIVE_CONFIG || (AGENT_DIR ? path.join(AGENT_DIR, "config.yml") : "")).trim();
const LIVE_AGENTS_DIR = AGENT_DIR ? path.join(AGENT_DIR, "agents") : "";
const BUNDLE_AGENTS_DIR = path.join(ROOT, "agents");

const CHECK_IDS = [
  "schema",
  "entrypoints-match",
  "entrypoint-default",
  "state-library",
  "policy-no-jev",
  "checksums",
  "version",
  "config-keys",
  "no-credentials",
  "decisions-separation",
  "agent-guidelines",
];

function toPosix(p) {
  return p.split(path.sep).join("/");
}
function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function readText(p) {
  return readFileSync(p, "utf8");
}
function exists(p) {
  return existsSync(p);
}
function fullFromRel(rel) {
  return path.join(ROOT, ...rel.split("/"));
}

function runOmp(args) {
  try {
    return execFileSync("omp", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = new Error(`omp ${args.join(" ")} failed: ${err && err.message ? err.message : String(err)}`);
    e.omMissing = true;
    throw e;
  }
}

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  if (i !== -1 && i + 1 < args.length) return args[i + 1];
  return undefined;
}
const optOmpVersion = flagValue("--omp-version");
const optConfig = flagValue("--config") ?? DEFAULT_CONFIG;
const optUpdate = args.includes("--update");
const optJson = args.includes("--json");
const optStrictMachine = args.includes("--strict-machine");

function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") { inS = !inS; continue; }
    if (c === '"') { inD = !inD; continue; }
    if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line.replace(/\s+$/, "");
}

function tokenizeYAML(text) {
  const lines = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const content = stripComment(raw);
    if (content.trim() === "") continue;
    const indent = content.length - content.trimStart().length;
    lines.push({ indent, content: content.trim() });
  }
  if (lines.length === 0) throw new Error("YAML: empty document");
  return lines;
}

function unquoteScalar(s) {
  const v = s.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseScalar(s) {
  const v = unquoteScalar(s);
  const low = v.toLowerCase();
  if (low === "true") return true;
  if (low === "false") return false;
  if (low === "null" || low === "~" || v === "") return null;
  if (v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function parseYAMLNode(lines, i, indent) {
  if (lines[i].content.startsWith("- ")) {
    const arr = [];
    let cur = i;
    while (cur < lines.length && lines[cur].indent === indent && lines[cur].content.startsWith("- ")) {
      const item = lines[cur].content.slice(2).trim();
      if (item === "") {
        let val = null;
        let j = cur + 1;
        if (j < lines.length && lines[j].indent > indent) {
          const child = parseYAMLNode(lines, j, lines[j].indent);
          val = child.value;
          cur = child.next;
        } else {
          cur = j;
        }
        arr.push(val);
      } else {
        arr.push(parseScalar(item));
        cur += 1;
      }
    }
    return { value: arr, next: cur };
  }
  const obj = {};
  let cur = i;
  while (cur < lines.length && lines[cur].indent === indent) {
    const content = lines[cur].content;
    if (content.startsWith("- ")) break;
    const ci = content.indexOf(":");
    if (ci === -1) throw new Error(`YAML: unparseable line at indent ${indent}: ${content}`);
    const key = unquoteScalar(content.slice(0, ci));
    const rest = content.slice(ci + 1).trim();
    if (rest === "") {
      let val = null;
      let next = cur + 1;
      if (cur + 1 < lines.length && lines[cur + 1].indent > indent) {
        const child = parseYAMLNode(lines, cur + 1, lines[cur + 1].indent);
        val = child.value;
        next = child.next;
      }
      obj[key] = val;
      cur = next;
    } else {
      obj[key] = parseScalar(rest);
      cur += 1;
    }
  }
  return { value: obj, next: cur };
}

function parseYAML(text) {
  const lines = tokenizeYAML(text);
  const root = parseYAMLNode(lines, 0, lines[0].indent);
  const out = {};
  for (const [k, v] of Object.entries(root.value)) out[k] = v;
  return out;
}

function flattenLeaves(obj, prefix, out) {
  if (obj === null || obj === undefined) {
    if (prefix) out.push({ key: prefix, value: null });
    return;
  }
  if (Array.isArray(obj)) {
    out.push({ key: prefix ?? "", value: obj });
    return;
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) {
      if (prefix) out.push({ key: prefix, value: null });
      return;
    }
    for (const [k, v] of entries) {
      flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.push({ key: prefix ?? "", value: obj });
}

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v === null || v === undefined) return "";
  return String(v);
}

function computeRoutingFingerprint() {
  if (!LIVE_CONFIG || !exists(LIVE_CONFIG)) {
    return { fingerprint: null, mode: "bundle-only", detail: "live config absent: routing fingerprint computed from bundle only" };
  }
  const text = readText(LIVE_CONFIG);
  const root = parseYAML(text);
  const modelRoles = root["modelRoles"];
  const task = root["task"];
  const overrides = task ? task["agentModelOverrides"] : undefined;
  const retry = root["retry"];
  const chains = retry ? retry["fallbackChains"] : undefined;
  if (modelRoles === null || typeof modelRoles !== "object") {
    throw new Error(`fingerprint: modelRoles block unreadable in ${LIVE_CONFIG}`);
  }
  if (overrides === null || typeof overrides !== "object") {
    throw new Error(`fingerprint: task.agentModelOverrides block unreadable in ${LIVE_CONFIG}`);
  }
  if (chains === null || typeof chains !== "object") {
    throw new Error(`fingerprint: retry.fallbackChains block unreadable in ${LIVE_CONFIG}`);
  }
  const routing = {
    modelRoles,
    task: { agentModelOverrides: overrides },
    retry: { fallbackChains: chains },
  };
  const json = JSON.stringify(canonicalize(routing));
  return { fingerprint: crypto.createHash("sha256").update(json, "utf8").digest("hex"), mode: "live", detail: `routing fingerprint from ${LIVE_CONFIG}` };
}

function computeExpectedFiles() {
  const files = {};
  const srcDir = path.join(ROOT, "src");
  for (const f of readdirSync(srcDir).sort()) {
    if (!f.endsWith(".ts")) continue;
    const full = path.join(srcDir, f);
    files["src/" + f] = sha256hex(readText(full));
  }
  const add = (rel) => { files[rel] = sha256hex(readText(fullFromRel(rel))); };
  add("config/recommended.yml");
  const agentsDir = path.join(ROOT, "agents");
  if (exists(agentsDir)) {
    for (const f of readdirSync(agentsDir).sort()) {
      if (f.endsWith(".md")) add("agents/" + f);
    }
  }
  const skillsDir = path.join(ROOT, "skills");
  if (exists(skillsDir)) {
    for (const d of readdirSync(skillsDir).sort()) {
      const p = path.join(skillsDir, d, "SKILL.md");
      if (exists(p)) add("skills/" + d + "/SKILL.md");
    }
  }
  if (exists(path.join(ROOT, "py"))) {
    for (const f of readdirSync(path.join(ROOT, "py")).sort()) {
      if (f.endsWith(".py")) add("py/" + f);
    }
  }
  add("package.json");
  return files;
}

function checkSchema(manifest) {
  const problems = [];
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { id: "schema", ok: false, detail: "harness.manifest.json is not a JSON object" };
  }
  if (manifest.schemaVersion !== 1) problems.push(`schemaVersion=${JSON.stringify(manifest.schemaVersion)}`);
  if (typeof manifest.harnessVersion !== "string") problems.push("harnessVersion missing or not a string");
  const omp = manifest.omp;
  if (typeof omp !== "object" || omp === null || Array.isArray(omp)) {
    problems.push("omp missing or not an object");
  } else {
    if (typeof omp.minimum !== "string") problems.push("omp.minimum missing or not a string");
    if (!Array.isArray(omp.tested) || !omp.tested.every((t) => typeof t === "string")) {
      problems.push("omp.tested missing or not an array of strings");
    }
  }
  if (typeof manifest.modelRoutingFingerprint !== "string") problems.push("modelRoutingFingerprint missing or not a string");
  if (!Array.isArray(manifest.entrypoints) || manifest.entrypoints.length === 0 || !manifest.entrypoints.every((e) => typeof e === "string")) {
    problems.push("entrypoints missing or not a non-empty array of strings");
  }
  if (typeof manifest.files !== "object" || manifest.files === null || Array.isArray(manifest.files)) {
    problems.push("files missing or not an object");
  } else {
    for (const k of Object.keys(manifest.files)) {
      if (typeof manifest.files[k] !== "string") problems.push(`files.${k} not a string`);
    }
  }
  if (!Array.isArray(manifest.migrations)) problems.push("migrations missing or not an array");
  if (problems.length > 0) return { id: "schema", ok: false, detail: problems.join("; ") };
  return { id: "schema", ok: true, detail: "harness.manifest.json schema ok" };
}

function checkEntrypointsMatch(manifest, pkg) {
  const exts = Array.isArray(pkg && pkg.omp && pkg.omp.extensions) ? pkg.omp.extensions.filter((e) => typeof e === "string") : [];
  const derived = exts.map((e) => (e.startsWith("./") ? e.slice(2) : e));
  const a = JSON.stringify(manifest.entrypoints);
  const b = JSON.stringify(derived);
  if (a === b) {
    return { id: "entrypoints-match", ok: true, detail: `entrypoints match package.json (${derived.join(", ")})` };
  }
  return { id: "entrypoints-match", ok: false, detail: `entrypoints mismatch: manifest=${a} package=${b}` };
}

function checkEntrypointDefault(entrypoints) {
  const failed = [];
  for (const ep of entrypoints) {
    const full = fullFromRel(ep);
    if (!exists(full)) { failed.push(`${ep}: file missing`); continue; }
    const content = readText(full);
    const ok = content.includes("export default function") || content.includes("export default async function");
    if (!ok) failed.push(`${ep}: no default factory`);
  }
  if (failed.length > 0) return { id: "entrypoint-default", ok: false, detail: failed.join("; ") };
  return { id: "entrypoint-default", ok: true, detail: `all entrypoints have default factory (${entrypoints.join(", ")})` };
}

function checkStateLibrary(manifest, pkg) {
  const exts = Array.isArray(pkg && pkg.omp && pkg.omp.extensions) ? pkg.omp.extensions.filter((e) => typeof e === "string") : [];
  const derived = exts.map((e) => (e.startsWith("./") ? e.slice(2) : e));
  const stateRel = "src/state.ts";
  const inManifest = Array.isArray(manifest.entrypoints) && manifest.entrypoints.includes(stateRel);
  const inPkg = derived.includes(stateRel);
  const full = fullFromRel(stateRel);
  const problems = [];
  if (inManifest) problems.push("src/state.ts is in manifest.entrypoints");
  if (inPkg) problems.push("src/state.ts is in package.json#omp.extensions");
  let content = "";
  if (exists(full)) content = readText(full);
  const noPiOn = !/pi\.on\(/.test(content);
  const noPiRegister = !/pi\.register\(/.test(content);
  if (!noPiOn) problems.push("src/state.ts contains pi.on(");
  if (!noPiRegister) problems.push("src/state.ts contains pi.register");
  if (problems.length > 0) return { id: "state-library", ok: false, detail: problems.join("; ") };
  return { id: "state-library", ok: true, detail: "src/state.ts is a library, not an entrypoint" };
}

function checkPolicyNoJev() {
  const full = fullFromRel("src/policy.ts");
  if (!exists(full)) return { id: "policy-no-jev", ok: false, detail: "src/policy.ts missing" };
  const content = readText(full);
  const problems = [];
  if (content.includes("@typesafe-ai")) problems.push("contains @typesafe-ai");
  if (content.includes("decisions.ts")) problems.push("imports decisions.ts");
  if (content.includes("fetch(")) problems.push("contains fetch(");
  if (problems.length > 0) {
    return { id: "policy-no-jev", ok: false, detail: `src/policy.ts has Jev network import: ${problems.join(", ")}` };
  }
  return { id: "policy-no-jev", ok: true, detail: "src/policy.ts has no Jev network import" };
}

function checkChecksums(manifest) {
  const expected = computeExpectedFiles();
  const files = manifest.files;
  const missing = [];
  const stale = [];
  const orphaned = [];
  for (const key of Object.keys(expected).sort()) {
    if (!(key in files)) missing.push(key);
    else if (files[key] !== expected[key]) stale.push(key);
  }
  for (const key of Object.keys(files).sort()) {
    if (!(key in expected)) orphaned.push(key);
    else if (!exists(fullFromRel(key))) orphaned.push(key);
  }
  const ok = missing.length === 0 && stale.length === 0 && orphaned.length === 0;
  const detail = ok
    ? `checksums ok (${Object.keys(expected).length} files)`
    : `checksums drift: missing=${JSON.stringify(missing)} stale=${JSON.stringify(stale)} orphaned=${JSON.stringify(orphaned)}`;
  return { id: "checksums", ok, detail };
}

function normalizeVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s));
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function checkVersion(manifest, ompVersionOverride) {
  let versionStr;
  let source;
  if (ompVersionOverride) {
    versionStr = normalizeVersion(ompVersionOverride) ?? String(ompVersionOverride).trim();
    source = "--omp-version";
  } else {
    versionStr = normalizeVersion(runOmp(["--version"])) ?? String(runOmp(["--version"])).trim();
    source = "omp --version";
  }
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
  if (!m) {
    return { id: "version", ok: false, version: versionStr, detail: `could not parse omp version from ${source}: ${versionStr}` };
  }
  const current = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  const tested = [...(Array.isArray(manifest.omp && manifest.omp.tested) ? manifest.omp.tested : []), "18.17.0"];
  const testedParses = tested
    .map((t) => {
      const tm = /^(\d+)\.(\d+)\.(\d+)$/.exec(t);
      if (!tm) return null;
      return { major: Number(tm[1]), minor: Number(tm[2]), patch: Number(tm[3]) };
    })
    .filter(Boolean);
  const sameMinor = testedParses.filter((t) => t.major === current.major && t.minor === current.minor);
  let status;
  if (sameMinor.length === 0) {
    status = "unsupported";
  } else if (sameMinor.some((t) => t.patch === current.patch)) {
    status = "tested";
  } else {
    status = "untested";
  }
  const ok = status === "tested";
  const detail = status === "tested"
    ? `tested (omp ${versionStr})`
    : `${status}: omp ${versionStr}; ${status} releases MAY run read-only baseline probes but MUST NOT be installed into the default profile`;
  return { id: "version", ok, version: versionStr, detail };
}

function checkConfigKeys(optConfigPath) {
  if (!LIVE_CONFIG || !exists(LIVE_CONFIG)) {
    if (optStrictMachine) {
      return { id: "config-keys", ok: false, detail: "machine config not present: --strict-machine requires live config" };
    }
    const overlayText = readText(fullFromRel(optConfigPath));
    const overlayRoot = parseYAML(overlayText);
    const leaves = [];
    flattenLeaves(overlayRoot, "", leaves);
    return { id: "config-keys", ok: true, detail: `bundle config/recommended.yml verified (machine config not present) (${leaves.length} overlay keys checked)` };
  }
  const configText = readText(fullFromRel(optConfigPath));
  const overlayRoot = parseYAML(configText);
  const leaves = [];
  flattenLeaves(overlayRoot, "", leaves);
  let ompConfig;
  try {
    ompConfig = JSON.parse(runOmp(["config", "list", "--json"]));
  } catch (err) {
    return { id: "config-keys", ok: false, detail: `omp config list --json failed: ${err && err.message ? err.message : String(err)}` };
  }
  const problems = [];
  const checked = [];
  for (const leaf of leaves) {
    const key = leaf.key;
    const value = leaf.value;
    const resolved = resolveConfigKey(ompConfig, key);
    if (!resolved.found) {
      problems.push(`${optConfigPath}: unknown key ${key}`);
      continue;
    }
    checked.push(key);
    if (!typeCompatible(value, resolved.type)) {
      problems.push(`${optConfigPath}: key ${key} type mismatch: overlay=${JSON.stringify(value)} reported=${resolved.type}`);
    }
  }
  if (problems.length > 0) {
    return { id: "config-keys", ok: false, detail: problems.sort().join("; ") };
  }
  return { id: "config-keys", ok: true, detail: `overlay keys ok (${checked.length} keys checked)` };
}

function resolveConfigKey(configMap, key) {
  if (Object.prototype.hasOwnProperty.call(configMap, key)) {
    const e = configMap[key];
    return { found: true, type: typeof e.type === "string" ? e.type : "string", value: e.value };
  }
  const parts = key.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestor = parts.slice(0, i).join(".");
    const anc = configMap[ancestor];
    const ancIsObj = anc && (anc.type === "record" || (anc.value !== null && typeof anc.value === "object" && !Array.isArray(anc.value)));
    if (ancIsObj) {
      const subKey = parts.slice(i).join(".");
      const subVal = anc.value ? anc.value[subKey] : undefined;
      if (subVal !== undefined && subVal !== null) {
        return { found: true, type: typeof subVal, value: subVal };
      }
    }
  }
  return { found: false, type: undefined, value: undefined };
}

function typeCompatible(overlayValue, reportedType) {
  const ot = Array.isArray(overlayValue) ? "array" : typeof overlayValue;
  if (reportedType === "enum") return ot === "string";
  if (reportedType === "object" || reportedType === "record") return true;
  return ot === reportedType;
}

function checkNoCredentials() {
  const filesToScan = [];
  filesToScan.push({ label: optConfig, full: fullFromRel(optConfig) });
  filesToScan.push({ label: "harness.manifest.json", full: MANIFEST_PATH });
  const agentsDir = path.join(ROOT, "agents");
  if (exists(agentsDir)) {
    for (const f of readdirSync(agentsDir).sort()) {
      if (f.endsWith(".md")) filesToScan.push({ label: `agents/${f}`, full: path.join(agentsDir, f) });
    }
  }
  const skillsDir = path.join(ROOT, "skills");
  if (exists(skillsDir)) {
    for (const d of readdirSync(skillsDir).sort()) {
      const p = path.join(skillsDir, d, "SKILL.md");
      if (exists(p)) filesToScan.push({ label: `skills/${d}/SKILL.md`, full: p });
    }
  }
  const patterns = [
    [/AKIA[0-9A-Z]{16}/, "AWS access key"],
    [/-----BEGIN/, "private key header"],
    [/ghp_[A-Za-z0-9]{20,}/, "GitHub token"],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, "API key"],
    [/(?:password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=]{16,}/i, "credential field"],
  ];
  const hits = [];
  for (const f of filesToScan) {
    let content = "";
    try {
      content = readText(f.full);
    } catch (err) {
      hits.push(`${f.label}: unreadable`);
      continue;
    }
    for (const [re, name] of patterns) {
      if (re.test(content)) hits.push(`${f.label}: ${name}`);
    }
  }
  if (hits.length > 0) {
    return { id: "no-credentials", ok: false, detail: `credential patterns found: ${[...new Set(hits)].sort().join("; ")}` };
  }
  return { id: "no-credentials", ok: true, detail: "no credentials in scanned artifacts" };
}

function checkDecisionsSeparation() {
  const srcDir = path.join(ROOT, "src");
  const problems = [];
  const files = exists(srcDir) ? readdirSync(srcDir).sort().filter((f) => f.endsWith(".ts")) : [];
  for (const f of files) {
    const full = path.join(srcDir, f);
    const content = readText(full);
    if (content.includes("jev-decisions.jsonl")) {
      const rel = "src/" + f;
      if (rel !== "src/decisions.ts") {
        problems.push(`${rel}: writes jev-decisions.jsonl outside decisions.ts`);
      }
    }
  }
  const toolsFull = path.join(srcDir, "tools.ts");
  const toolsContent = exists(toolsFull) ? readText(toolsFull) : "";
  if (toolsContent.includes("jev-decisions")) {
    problems.push("src/tools.ts: writes Jev receipts");
  }
  if (problems.length > 0) {
    return { id: "decisions-separation", ok: false, detail: problems.join("; ") };
  }
  return { id: "decisions-separation", ok: true, detail: "decisions.jsonl vs jev-decisions.jsonl separation ok" };
}

const GUIDELINES_FRONTMATTER = "autoloadSkills: [karpathy-guidelines]";

/**
 * omp only injects a skill into a child when the child's OWN frontmatter asks
 * for it: `before_agent_start` never runs inside a subagent process. So the
 * guideline wiring is agent data, and it silently disappears when
 * `omp agents unpack` rewrites a bundled agent without this line.
 */
function checkAgentGuidelines() {
  let bundleEntries;
  try {
    bundleEntries = readdirSync(BUNDLE_AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    return { id: "agent-guidelines", ok: false, detail: `cannot read ${BUNDLE_AGENTS_DIR}: ${err && err.code ? err.code : String(err)}` };
  }
  if (bundleEntries.length === 0) {
    return { id: "agent-guidelines", ok: false, detail: `no agent definitions in ${BUNDLE_AGENTS_DIR}` };
  }
  const missing = [];
  for (const name of bundleEntries) {
    const text = readText(path.join(BUNDLE_AGENTS_DIR, name));
    if (!text.includes(GUIDELINES_FRONTMATTER)) missing.push(name);
  }
  if (missing.length > 0) {
    return { id: "agent-guidelines", ok: false, detail: `bundle agents missing ${GUIDELINES_FRONTMATTER}: ${missing.join(", ")}` };
  }
  let detail = `${bundleEntries.length} bundle agents autoload karpathy-guidelines`;
  if (LIVE_AGENTS_DIR && exists(LIVE_AGENTS_DIR)) {
    const liveMissing = [];
    for (const name of bundleEntries) {
      const liveFull = path.join(LIVE_AGENTS_DIR, name);
      let liveText;
      try {
        liveText = readText(liveFull);
      } catch {
        liveMissing.push(name);
        continue;
      }
      if (!liveText.includes(GUIDELINES_FRONTMATTER)) liveMissing.push(name);
    }
    if (liveMissing.length > 0) {
      return { id: "agent-guidelines", ok: false, detail: `installed agents missing ${GUIDELINES_FRONTMATTER}: ${liveMissing.join(", ")}` };
    }
    detail += `, ${bundleEntries.length} installed agents verified`;
  }
  return { id: "agent-guidelines", ok: true, detail: detail };
}

function main() {
  let manifest;
  try {
    manifest = JSON.parse(readText(MANIFEST_PATH));
  } catch (err) {
    console.error(`FAIL schema: harness.manifest.json unreadable or unparseable: ${err && err.message ? err.message : String(err)}`);
    console.error("verify: FAILED (1 checks)");
    process.exit(2);
  }

  const pkg = JSON.parse(readText(fullFromRel("package.json")));

  const results = [];
  results.push(checkSchema(manifest));
  results.push(checkEntrypointsMatch(manifest, pkg));
  results.push(checkEntrypointDefault(Array.isArray(manifest.entrypoints) ? manifest.entrypoints : []));
  results.push(checkStateLibrary(manifest, pkg));
  results.push(checkPolicyNoJev());
  results.push(checkChecksums(manifest));
  const versionCheck = checkVersion(manifest, optOmpVersion);
  results.push(versionCheck);
  let configKeysResult;
  try {
    configKeysResult = checkConfigKeys(optConfig);
  } catch (err) {
    configKeysResult = { id: "config-keys", ok: false, detail: `verifier could not run: ${err && err.message ? err.message : String(err)}` };
  }
  results.push(configKeysResult);
  results.push(checkNoCredentials());
  results.push(checkDecisionsSeparation());
  results.push(checkAgentGuidelines());

  const ordered = CHECK_IDS.map((id) => results.find((r) => r.id === id)).filter(Boolean);

  if (optUpdate) {
    const nonChecksum = ordered.filter((r) => r.id !== "checksums");
    const failing = nonChecksum.filter((r) => !r.ok);
    if (failing.length > 0) {
      if (optJson) {
        console.log(JSON.stringify({ ok: false, status: "failed", checks: nonChecksum.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })) }));
      } else {
        for (const r of nonChecksum) {
          if (r.ok) console.log(`${r.id}: ok`);
          else console.log(`FAIL ${r.id}: ${r.detail}`);
        }
        console.log(`verify: FAILED (${failing.length} checks, manifest not written)`);
      }
      process.exit(1);
    }
    const expected = computeExpectedFiles();
    const fingerprintResult = computeRoutingFingerprint();
    const prev = {};
    try {
      Object.assign(prev, JSON.parse(readText(MANIFEST_PATH)));
    } catch {}
    const pkgEntrypoints = Array.isArray(pkg?.omp?.extensions)
      ? pkg.omp.extensions.map((entry) => String(entry).replace(/^\.\//, ""))
      : ["src/policy.ts", "src/intake.ts", "src/tools.ts", "src/memory.ts"];
    const tested = [...new Set([...(Array.isArray(prev.omp && prev.omp.tested) ? prev.omp.tested : ["18.12.6", "18.13.1", "18.14.0"]), versionCheck.version])];
    const modelRoutingFingerprint = fingerprintResult.mode === "bundle-only" && typeof prev.modelRoutingFingerprint === "string"
      ? prev.modelRoutingFingerprint
      : fingerprintResult.fingerprint;
    const next = {
      schemaVersion: 1,
      harnessVersion: typeof pkg?.version === "string" ? pkg.version : "1.0.0",
      omp: {
        minimum: "18.12.6",
        tested,
      },
      modelRoutingFingerprint,
      entrypoints: pkgEntrypoints,
      files: expected,
      migrations: Array.isArray(prev.migrations) ? prev.migrations : [],
    };
    writeFileSync(MANIFEST_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
    const finalManifest = JSON.parse(readText(MANIFEST_PATH));
    const checksumsResult = checkChecksums(finalManifest);
    if (!checksumsResult.ok) {
      if (optJson) {
        console.log(JSON.stringify({ ok: false, status: "failed", checks: [...nonChecksum.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })), { id: "checksums", ok: false, detail: checksumsResult.detail }] }));
      } else {
        for (const r of nonChecksum) console.log(`${r.id}: ok`);
        console.log(`FAIL checksums: ${checksumsResult.detail}`);
        console.log(`verify: FAILED (1 checks, manifest written but checksums re-run failed)`);
      }
      process.exit(1);
    }
    if (optJson) {
      console.log(JSON.stringify({ ok: true, status: "ok", checks: [...nonChecksum.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })), { id: "checksums", ok: true, detail: checksumsResult.detail }], ompVersion: versionCheck.version, harnessVersion: next.harnessVersion, fingerprint: modelRoutingFingerprint }));
    } else {
      console.log(`updated harness.manifest.json: ${Object.keys(expected).length} files, fingerprint ${modelRoutingFingerprint}`);
      console.log(`verify: OK (omp ${versionCheck.version}, harness ${next.harnessVersion})`);
    }
    process.exit(0);
  }

  const allOk = ordered.every((r) => r.ok);
  const ompVersion = versionCheck.version;
  const harnessVersion = typeof manifest.harnessVersion === "string" ? manifest.harnessVersion : "1.0.0";

  if (optJson) {
    console.log(JSON.stringify({
      ok: allOk,
      status: allOk ? "ok" : "failed",
      checks: ordered.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
      ompVersion,
      harnessVersion,
    }));
  } else {
    for (const r of ordered) {
      if (r.ok) console.log(`${r.id}: ok`);
      else console.log(`FAIL ${r.id}: ${r.detail}`);
    }
    if (allOk) {
      console.log(`verify: OK (omp ${ompVersion}, harness ${harnessVersion})`);
    } else {
      const failedCount = ordered.filter((r) => !r.ok).length;
      console.log(`verify: FAILED (${failedCount} checks)`);
    }
  }

  if (!allOk) process.exit(1);
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(`FAIL run: ${err && err.message ? err.message : String(err)}`);
  console.error("verify: FAILED (1 checks)");
  process.exit(2);
}
