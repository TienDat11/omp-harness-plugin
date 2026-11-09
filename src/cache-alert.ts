/**
 * cache-alert.ts — runtime, user-facing-only alert when prompt-cache reuse drops.
 *
 * WHY: a silent cache regression multiplies cost. Listens to `message_end`
 *   (carries the finalized assistant message with `usage` and `provider`),
 *   keeps a rolling window of the last 10 assistant turns that have usage and,
 *   after at least 5 such turns, compares reuse (cacheRead / (input + cacheRead))
 *   with a per-provider threshold. Alerts once per session via a harness log
 *   code (C1) and ctx.ui.notify. It never reaches model context.
 *
 * Config (no harness settings file is consumed at runtime, so env only):
 *   OMP_HARNESS_CACHE_ALERT=0                      disable
 *   OMP_HARNESS_CACHE_ALERT_THRESHOLDS='{"ns24":0.5}'  per-provider overrides (JSON)
 */
import { cacheReuse } from "./telemetry.ts";
import { logHarnessCode } from "./state.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** p10 of measured per-session reuse, by provider. */
export const DEFAULT_THRESHOLDS: Record<string, number> = {
  ns24: 0.675,
  "ns24-anthropic": 0.662,
  vilao: 0.432,
  vnideas: 0.704,
  "openai-codex": 0.486,
  "local-relay": 0.307,
};
export const FALLBACK_THRESHOLD = 0.8;
export const WINDOW = 10;
export const MIN_TURNS = 5;

export function thresholdFor(provider: string): number {
  let map = DEFAULT_THRESHOLDS;
  const raw = process.env.OMP_HARNESS_CACHE_ALERT_THRESHOLDS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const over: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) over[k] = v;
        map = { ...DEFAULT_THRESHOLDS, ...over };
      }
    } catch {
      // Ignore malformed override.
    }
  }
  return Object.hasOwn(map, provider) ? map[provider] : FALLBACK_THRESHOLD;
}

interface SessionState {
  turns: Array<{ input: number; cacheRead: number }>;
  alerted: boolean;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export default function cacheAlert(pi: ExtensionAPI) {
  const states = new Map<string, SessionState>();

  pi.on("message_end", async (event, ctx) => {
    try {
      if (process.env.OMP_HARNESS_CACHE_ALERT === "0") return;
      if (ctx?.agent?.kind === "sub") return;
      const msg = (event as { message?: Record<string, unknown> } | undefined)?.message;
      if (!msg || msg.role !== "assistant") return;
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== "object") return;
      const cwd = ctx?.cwd ?? process.cwd();
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const key = sessionId ? `${cwd}::${sessionId}` : cwd;
      let state = states.get(key);
      if (!state) {
        state = { turns: [], alerted: false };
        states.set(key, state);
      }
      if (state.alerted) return;
      state.turns.push({ input: num(usage.input), cacheRead: num(usage.cacheRead) });
      if (state.turns.length > WINDOW) state.turns.shift();
      if (state.turns.length < MIN_TURNS) return;
      const input = state.turns.reduce((s, t) => s + t.input, 0);
      const cacheRead = state.turns.reduce((s, t) => s + t.cacheRead, 0);
      const reuse = cacheReuse({ input, cacheRead });
      const provider = typeof msg.provider === "string" && msg.provider ? msg.provider : "unknown";
      const threshold = thresholdFor(provider);
      if (reuse >= threshold) return;
      state.alerted = true;
      // logHarnessCode injects `p=<repo>`; the provider goes in `pv=` to avoid a duplicate key.
      logHarnessCode(cwd, `C1 pv=${provider} r=${reuse.toFixed(3)} t=${threshold.toFixed(3)}`);
      try {
        ctx?.ui?.notify?.(`harness: prompt-cache reuse ${reuse.toFixed(3)} is below ${threshold.toFixed(3)} for provider ${provider} over the last ${state.turns.length} turns`, "warning");
      } catch {
        // Notification is best-effort.
      }
    } catch {
      // Telemetry never breaks a turn.
    }
  });
}
