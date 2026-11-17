#!/usr/bin/env node
/**
 * sync-cli-surface.mjs — Synchronize the harness skill/capability surface across
 * OMP CLI (~/.omp/agent) and Claude CLI (~/.claude). Idempotent.
 *
 * Usage: node scripts/sync-cli-surface.mjs [--dry-run] [--json]
 *
 * Actions (each independently try/caught, reported in --json output):
 *   A. sync-harness-skills    copy harness skills to OMP agent + Claude skills dirs
 *   B. sync-egm-skills        copy EGM egm-* skills to OMP agent + Claude skills dirs
 *   C. provision-jev-key      write ~/.config/typesafe/key from models.yml ns24 apiKey
 *   D. install-memory-hook    copy claude-memory-hook.mjs to ~/.claude/hooks/
 *   E. reconcile-claude-settings  update ~/.claude/settings.json (env, perms, hooks)
 *   F. reconcile-omp-mcp      update ~/.omp/agent/mcp.json (remove Jev, add MCP servers)
 *   G. reconcile-claude-mcp   update ~/.claude.json (omp-harness + sequential-thinking MCP)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Paths ──────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
);
const HARNESS_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME = (process.env.HOME || process.env.USERPROFILE || os.homedir()).trim();

const HARNESS_SKILLS_SRC = path.join(HARNESS_ROOT, "skills");
const OMP_AGENT_SKILLS = path.join(HOME, ".omp", "agent", "skills");
const CLAUDE_SKILLS = path.join(HOME, ".claude", "skills");
const EGM_SKILLS_SRC = path.join(
  HOME,
  ".omp",
  "plugins",
  "src",
  "elephant-goldfish-model",
  "skills"
);
const TYPESAFE_KEY_DIR = path.join(HOME, ".config", "typesafe");
const TYPESAFE_KEY_FILE = path.join(TYPESAFE_KEY_DIR, "key");
const CLAUDE_MEMORY_HOOK_SRC = path.join(HARNESS_ROOT, "scripts", "claude-memory-hook.mjs");
const CLAUDE_HOOKS_DIR = path.join(HOME, ".claude", "hooks");
const CLAUDE_MEMORY_HOOK_DEST = path.join(CLAUDE_HOOKS_DIR, "memory-intake.mjs");
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const OMP_MCP = path.join(HOME, ".omp", "agent", "mcp.json");
const CLAUDE_JSON = path.join(HOME, ".claude.json");
const MODELS_YML = path.join(HOME, ".omp", "agent", "models.yml");

const HARNESS_SKILL_NAMES = ["omp-harness", "omp-superagent", "harness-loop", "task-intake", "product-delivery"];

// ── CLI ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_OUT = args.includes("--json");

const actions = [];
let hasFailed = false;

function record(action, status, detail) {
  actions.push({ action, status, detail });
  if (status === "failed") hasFailed = true;
  if (!JSON_OUT) {
    const pad = action.padEnd(30);
    console.log(`  ${pad} ${status}  ${detail || ""}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function filesIdentical(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function copyFileIfDifferent(src, dest) {
  if (existsSync(dest) && filesIdentical(src, dest)) return false;
  if (DRY_RUN) return true; // would change
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return true;
}

function copyDirContents(srcDir, destDir) {
  let changed = 0;
  try {
    if (!existsSync(srcDir)) return 0;
    mkdirSync(destDir, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      const sp = path.join(srcDir, name);
      const dp = path.join(destDir, name);
      try {
        const st = statSync(sp);
        if (st.isDirectory()) {
          changed += copyDirContents(sp, dp);
        } else {
          if (copyFileIfDifferent(sp, dp)) changed++;
        }
      } catch {
        // skip individual entry
      }
    }
  } catch {
    // skip directory
  }
  return changed;
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

/**
 * Read, mutate, and write back a JSON file only if content changed.
 * Returns { changed: boolean, error?: string }.
 * In dry-run mode: never writes, but reports changed=true if content would differ.
 */
function updateJsonFile(filePath, mutate, dryRun) {
  if (!existsSync(filePath)) {
    return { changed: false };
  }
  const original = readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch {
    return { changed: false, error: "unparseable JSON" };
  }
  mutate(parsed);
  const next = JSON.stringify(parsed, null, 2) + "\n";
  if (next === original) return { changed: false };
  if (dryRun) return { changed: true };
  // Backup then atomic write
  writeFileSync(filePath + ".bak", original, "utf8");
  atomicWriteJson(filePath, parsed);
  return { changed: true };
}

// ── Action A: Sync harness skills ─────────────────────────────────────

function actionSyncHarnessSkills() {
  if (!existsSync(HARNESS_SKILLS_SRC)) {
    record("sync-harness-skills", "skipped", "source skills dir missing");
    return;
  }
  let totalChanged = 0;
  for (const name of HARNESS_SKILL_NAMES) {
    const src = path.join(HARNESS_SKILLS_SRC, name);
    if (!existsSync(src)) continue;
    for (const destRoot of [OMP_AGENT_SKILLS, CLAUDE_SKILLS]) {
      totalChanged += copyDirContents(src, path.join(destRoot, name));
    }
  }
  record("sync-harness-skills", totalChanged > 0 ? "applied" : "skipped", `${totalChanged} file(s) would be copied`);
}

// ── Action B: Sync EGM skills ─────────────────────────────────────────

function actionSyncEgmSkills() {
  if (!existsSync(EGM_SKILLS_SRC)) {
    record("sync-egm-skills", "skipped", "EGM skills dir missing");
    return;
  }
  let totalChanged = 0;
  try {
    for (const name of readdirSync(EGM_SKILLS_SRC)) {
      if (!name.startsWith("egm-")) continue;
      const src = path.join(EGM_SKILLS_SRC, name);
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const destRoot of [OMP_AGENT_SKILLS, CLAUDE_SKILLS]) {
        totalChanged += copyDirContents(src, path.join(destRoot, name));
      }
    }
  } catch {
    record("sync-egm-skills", "failed", "could not read EGM skills dir");
    return;
  }
  record("sync-egm-skills", totalChanged > 0 ? "applied" : "skipped", `${totalChanged} file(s) would be copied`);
}

// ── Action C: Provision Jev key file ──────────────────────────────────

function extractNs24ApiKey(yamlText) {
  const lines = yamlText.split("\n");
  let inProviders = false;
  let inNs24 = false;
  let ns24Indent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (trimmed === "providers:") {
      inProviders = true;
      continue;
    }
    if (inProviders) {
      if (indent === 0) {
        inProviders = false;
        inNs24 = false;
        continue;
      }
      const colonIdx = trimmed.indexOf(":");
      if (indent === 2 && colonIdx === trimmed.length - 1) {
        const name = trimmed.slice(0, colonIdx).trim();
        inNs24 = name === "ns24";
        ns24Indent = indent;
        continue;
      }
      if (inNs24 && indent > ns24Indent && trimmed.startsWith("apiKey:")) {
        const val = trimmed.replace(/^apiKey:\s*/, "").replace(/^["']|["']$/g, "");
        return val || undefined;
      }
    }
  }
  return undefined;
}

function actionProvisionJevKey() {
  if (existsSync(TYPESAFE_KEY_FILE)) {
    record("provision-jev-key", "skipped", "key file already exists");
    return;
  }
  if (!existsSync(MODELS_YML)) {
    record("provision-jev-key", "skipped", "models.yml not found");
    return;
  }
  let yamlText;
  try {
    yamlText = readFileSync(MODELS_YML, "utf8");
  } catch {
    record("provision-jev-key", "failed", "could not read models.yml");
    return;
  }
  const apiKey = extractNs24ApiKey(yamlText);
  if (!apiKey) {
    record("provision-jev-key", "skipped", "ns24 provider or apiKey not found in models.yml");
    return;
  }
  if (DRY_RUN) {
    record("provision-jev-key", "applied", "would write key file (value not logged)");
    return;
  }
  try {
    mkdirSync(TYPESAFE_KEY_DIR, { recursive: true });
    writeFileSync(TYPESAFE_KEY_FILE, apiKey, "utf8"); // no trailing newline
    record("provision-jev-key", "applied", `wrote ${TYPESAFE_KEY_FILE}`);
  } catch (err) {
    record("provision-jev-key", "failed", err.message || String(err));
  }
}

// ── Action D: Install memory hook ─────────────────────────────────────

function actionInstallMemoryHook() {
  if (!existsSync(CLAUDE_MEMORY_HOOK_SRC)) {
    record("install-memory-hook", "skipped", "claude-memory-hook.mjs not built yet");
    return;
  }
  if (existsSync(CLAUDE_MEMORY_HOOK_DEST) && filesIdentical(CLAUDE_MEMORY_HOOK_SRC, CLAUDE_MEMORY_HOOK_DEST)) {
    record("install-memory-hook", "skipped", "already installed");
    return;
  }
  if (DRY_RUN) {
    record("install-memory-hook", "applied", "would copy to memory-intake.mjs");
    return;
  }
  try {
    mkdirSync(CLAUDE_HOOKS_DIR, { recursive: true });
    copyFileSync(CLAUDE_MEMORY_HOOK_SRC, CLAUDE_MEMORY_HOOK_DEST);
    record("install-memory-hook", "applied", "installed memory-intake.mjs");
  } catch (err) {
    record("install-memory-hook", "failed", err.message || String(err));
  }
}

// ── Action E: Reconcile Claude settings ───────────────────────────────

const DESIRED_ENV = {
  JEV_MODEL: "jev",
  TYPESAFE_MODEL: "jev",
  NS24_URL: "https://api.ns24.io/v1/systemone",
  OMP_HARNESS_JEV: "1",
  OMP_HARNESS_JEV_MODEL: "jev",
  JEV_KEY_FILE: "C:/Users/ADMIN/.config/typesafe/key",
};

const DESIRED_PERMISSIONS = [
  "mcp__pencil",
  "mcp__omp-harness",
  "mcp__ns24-jev",
  "mcp__plugin_jev_jev",
  "mcp__context7",
  "mcp__fast-context",
  "mcp__sequential-thinking",
];

const MEMORY_HOOK_COMMAND = "node C:/Users/ADMIN/.claude/hooks/memory-intake.mjs";

function actionReconcileClaudeSettings() {
  if (!existsSync(CLAUDE_SETTINGS)) {
    record("reconcile-claude-settings", "skipped", "settings.json not found");
    return;
  }
  const result = updateJsonFile(CLAUDE_SETTINGS, (parsed) => {
    // env — set desired keys, preserve everything else
    const env = parsed.env || {};
    for (const [k, v] of Object.entries(DESIRED_ENV)) {
      env[k] = v;
    }
    parsed.env = env;

    // permissions.allow — ensure entries exist, keep existing, no reorder
    const existing = parsed.permissions?.allow || [];
    const merged = [...existing];
    for (const p of DESIRED_PERMISSIONS) {
      if (!merged.includes(p)) merged.push(p);
    }
    if (!parsed.permissions) parsed.permissions = {};
    parsed.permissions.allow = merged;

    // hooks.UserPromptSubmit and hooks.Stop — ensure memory-intake entry
    for (const hookKey of ["UserPromptSubmit", "Stop"]) {
      const arr = (parsed.hooks && parsed.hooks[hookKey]) || [];
      let matcherEntry = arr.find((e) => e && e.matcher === "");
      if (matcherEntry) {
        const hooks = matcherEntry.hooks || [];
        const hasMem = hooks.some((h) => h && h.command === MEMORY_HOOK_COMMAND);
        if (!hasMem) {
          hooks.push({ type: "command", command: MEMORY_HOOK_COMMAND, timeout: 10 });
        }
      } else {
        arr.push({
          matcher: "",
          hooks: [{ type: "command", command: MEMORY_HOOK_COMMAND, timeout: 10 }],
        });
      }
      if (!parsed.hooks) parsed.hooks = {};
      parsed.hooks[hookKey] = arr;
    }
  }, DRY_RUN);

  if (result.error) {
    record("reconcile-claude-settings", "failed", result.error);
    return;
  }
  if (!result.changed) {
    record("reconcile-claude-settings", "skipped", "no changes needed");
    return;
  }
  record("reconcile-claude-settings", "applied", "settings.json updated");
}

// ── Action F: Reconcile OMP MCP config ────────────────────────────────

const REMOVE_MCP_KEYS = ["jev-ultrafast-mcp", "ns24-jev", "jev-tools"];

const ENSURE_MCP_SERVERS = {
  context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
  "fast-context": { command: "npx", args: ["-y", "fast-context-mcp@latest"] },
  "sequential-thinking": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  "omp-harness": { command: "node", args: ["D:/omp-harness/scripts/omp-harness-mcp.mjs"] },
};

function actionReconcileOmpMcp() {
  if (!existsSync(OMP_MCP)) {
    record("reconcile-omp-mcp", "skipped", "mcp.json not found");
    return;
  }
  const result = updateJsonFile(OMP_MCP, (parsed) => {
    const ms = parsed.mcpServers || {};
    for (const k of REMOVE_MCP_KEYS) {
      delete ms[k];
    }
    for (const [k, v] of Object.entries(ENSURE_MCP_SERVERS)) {
      ms[k] = v;
    }
    parsed.mcpServers = ms;

    const ds = parsed.disabledServers || [];
    parsed.disabledServers = ds.filter((n) => !REMOVE_MCP_KEYS.includes(n));
  }, DRY_RUN);

  if (result.error) {
    record("reconcile-omp-mcp", "failed", result.error);
    return;
  }
  if (!result.changed) {
    record("reconcile-omp-mcp", "skipped", "no changes needed");
    return;
  }
  record("reconcile-omp-mcp", "applied", "mcp.json updated");
}

// ── Action G: Reconcile Claude MCP config ─────────────────────────────

const CLAUDE_OMP_HARNESS = {
  type: "stdio",
  command: "node",
  args: ["D:/omp-harness/scripts/omp-harness-mcp.mjs"],
  env: {
    OMP_HARNESS_JEV: "1",
    TYPESAFE_BASE_URL: "https://api.ns24.io",
    OMP_HARNESS_JEV_MODEL: "jev",
    JEV_KEY_FILE: "C:/Users/ADMIN/.config/typesafe/key",
  },
};

function actionReconcileClaudeMcp() {
  if (!existsSync(CLAUDE_JSON)) {
    record("reconcile-claude-mcp", "skipped", ".claude.json not found");
    return;
  }
  const result = updateJsonFile(CLAUDE_JSON, (parsed) => {
    const ms = parsed.mcpServers || {};
    ms["omp-harness"] = CLAUDE_OMP_HARNESS;
    if (!ms["sequential-thinking"]) {
      ms["sequential-thinking"] = {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      };
    }
    parsed.mcpServers = ms;
  }, DRY_RUN);

  if (result.error) {
    record("reconcile-claude-mcp", "failed", result.error);
    return;
  }
  if (!result.changed) {
    record("reconcile-claude-mcp", "skipped", "no changes needed");
    return;
  }
  record("reconcile-claude-mcp", "applied", ".claude.json updated");
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  console.log(`sync-cli-surface (dry-run=${DRY_RUN})`);
  actionSyncHarnessSkills();
  actionSyncEgmSkills();
  actionProvisionJevKey();
  actionInstallMemoryHook();
  actionReconcileClaudeSettings();
  actionReconcileOmpMcp();
  actionReconcileClaudeMcp();

  if (JSON_OUT) {
    console.log(JSON.stringify({ dryRun: DRY_RUN, actions, failed: hasFailed }, null, 2) + "\n");
  }
  if (hasFailed) process.exit(1);
}

main();
