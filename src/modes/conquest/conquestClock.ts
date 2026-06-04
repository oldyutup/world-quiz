/**
 * Conquest (Kuşatma) — server-synced clock.
 *
 * Why this exists
 * ───────────────
 * Kuşatma's per-match timeline (`challenge.startedAt`, `challenge.endsAt`,
 * `gameIntroEndsAt`, duel/action timers) was written with the host's
 * `Date.now()` and consumed by every other client with their *own* local
 * `Date.now()`.  Two PCs with even a few seconds of wall-clock drift would
 * land on different `roundIntroMsRemaining` numbers — one client jumping to
 * the question while the other was still on the "Hazır ol" overlay.
 *
 * Fix shape (per teşhis raporu):
 *   - A new server-side RPC `public.get_server_time_ms()` returns
 *     `clock_timestamp()` in epoch ms.
 *   - At room entry / game start we sample it twice (best-of-two RTT) and
 *     cache `serverOffsetMs = serverTime − localTime`.
 *   - All gameplay writes and UI gates use `getConquestSyncedNowMs()` —
 *     `Date.now() + serverOffsetMs` — instead of `Date.now()`.
 *
 * Failure mode
 * ────────────
 * If the RPC fails (network, RPC missing, RLS, …), `getConquestSyncedNowMs`
 * falls back to plain `Date.now()` and the symptom is identical to the
 * pre-fix state for *that one client*.  We surface this through `isSynced()`
 * and a one-shot `console.warn` so the regression is visible in DevTools.
 *
 * The offset is process-global (module-level state).  All Kuşatma callers
 * see the same value; the module is intentionally a singleton because
 * gameplay state is shared across the whole tab.
 *
 * Refresh
 * ───────
 * `initConquestClockSync()` is called once per game-screen mount in
 * ConquestMode and sets up a 45-second refresh interval.  Returns a
 * dispose handle so the interval is torn down when the screen unmounts.
 */

import { supabase } from "../../lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (process-singleton)
// ─────────────────────────────────────────────────────────────────────────────

let serverOffsetMs: number = 0;
let lastSyncAtMs:   number = 0;
let isOffsetKnown:  boolean = false;
let warnedFallback: boolean = false;

const REFRESH_INTERVAL_MS = 45_000;
/** Two probes per sync; we keep the one with the smaller RTT. */
const PROBE_COUNT = 2;
/** If both probes fail we stay on fallback (Date.now()).  No retry storm. */

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current epoch ms in the server's reference frame.  Equivalent to
 * `Date.now() + serverOffsetMs` once the offset has been measured; falls
 * back to bare `Date.now()` before the first successful sync.
 *
 * Safe to call from anywhere (no async, no throw).  Cheap — single addition.
 */
export function getConquestSyncedNowMs(): number {
  if (!isOffsetKnown && !warnedFallback) {
    warnedFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[conquestClock] Server offset not yet known — falling back to Date.now(). " +
      "This is expected for the very first call before initConquestClockSync resolves.",
    );
  }
  return Date.now() + serverOffsetMs;
}

/** True once at least one probe has succeeded since the page loaded. */
export function isConquestClockSynced(): boolean {
  return isOffsetKnown;
}

/** Current offset in milliseconds (server − local).  0 before first sync. */
export function getConquestClockOffsetMs(): number {
  return serverOffsetMs;
}

/** Wall-clock ms at the most recent successful sync.  0 before first sync. */
export function getConquestClockLastSyncedAtMs(): number {
  return lastSyncAtMs;
}

/**
 * Fetch the current offset from Supabase.  Two probes, smaller RTT wins.
 * Resolves to true on success, false on failure (offset unchanged on fail).
 */
export async function fetchConquestServerTimeOffset(): Promise<boolean> {
  let bestRtt    = Number.POSITIVE_INFINITY;
  let bestOffset: number | null = null;

  for (let i = 0; i < PROBE_COUNT; i++) {
    const sentAt = Date.now();
    const { data, error } = await supabase.rpc("get_server_time_ms");
    const recvAt = Date.now();
    if (error || typeof data !== "number" || !Number.isFinite(data)) continue;
    const rtt        = recvAt - sentAt;
    // The server time we got represents roughly the midpoint of the RTT
    // window; subtracting half the RTT from `recvAt` gives the local time
    // that corresponds to that sample.
    const localAtSample = sentAt + Math.floor(rtt / 2);
    const offset        = data - localAtSample;
    if (rtt < bestRtt) {
      bestRtt    = rtt;
      bestOffset = offset;
    }
  }

  if (bestOffset === null) return false;
  serverOffsetMs = bestOffset;
  isOffsetKnown  = true;
  lastSyncAtMs   = Date.now();
  return true;
}

/**
 * One-shot init + periodic refresh.  Returns a dispose handle.
 *
 * Call once from the Kuşatma room screen (lobby + game).  Re-calling while
 * a sync is already running is safe — the new interval simply overlaps with
 * the old one for one cycle, then the caller's previous dispose cleans up.
 *
 * The first probe runs immediately (fire-and-forget); subsequent probes
 * every REFRESH_INTERVAL_MS.  If a probe fails the offset stays at its
 * previous value (or 0 / fallback if it never succeeded).
 */
export function initConquestClockSync(): { dispose: () => void } {
  // Fire the first probe right away so callers that mount and immediately
  // read the synced clock get a refreshed offset within ~1 RTT.
  void fetchConquestServerTimeOffset();

  const intervalId = window.setInterval(() => {
    void fetchConquestServerTimeOffset();
  }, REFRESH_INTERVAL_MS);

  return {
    dispose: () => {
      window.clearInterval(intervalId);
    },
  };
}
