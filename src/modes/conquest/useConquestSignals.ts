/**
 * useConquestSignals — local-derived "cinematic" signals for Kuşatma.
 *
 * Sits ON TOP of useConquestEventFeed (which keeps handling MINOR rows as
 * a persistent log). This hook only detects MAJOR and CRITICAL moments
 * and feeds them through a single-slot center banner (ConquestSignalBanner).
 *
 * Tier table — what fires here:
 *   major     — capital_fell                               (1300ms hold)
 *   critical  — last_stand                                 (2400ms hold)
 *
 * Tier table — what stays elsewhere (intentional; don't duplicate):
 *   minor     — normal captures, bonus toasts, pass, sıra değişti
 *               → ConquestEventFeed rows
 *   major     — defense_duel intro, attack_focus, hidden_op center banner,
 *               bonus toast card (sole feedback for bonus-region captures),
 *               round intro card + 3-2-1 countdown (own overlay flow in
 *               ConquestGame, anchored to challenge.startedAt)
 *               → already own bespoke overlays in ConquestGame; this hook
 *                 deliberately does not double-fire them.
 *   critical  — match-over → owned exclusively by the final standings
 *               panel; surfacing a banner on top of it just stacks
 *               overlays, so this hook stays silent at match end.
 *
 * Pure local diff. No new sync surface. Late joiners see only signals
 * that fire after they mount — acceptable for short Kuşatma matches.
 *
 * Capital reveal coordination: the Ankara bonus toast carries gameplay
 * info (Gizli Operasyon) and shows for ~6s. To prevent a stacked overlay
 * on capture, ConquestGame delays the toast by CAPITAL_REVEAL_HOLD_MS so
 * the cinematic banner here owns the first ~1.4s alone.
 *
 * Future hooks (oyuncu elendi, additional capital systems) can be added
 * by appending a new ConquestSignalKind + a small detector effect; the
 * renderer never needs to change.
 */

import { useEffect, useRef, useState } from "react";
import type {
  ConquestGameState,
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerColor,
} from "./types";
import { CAPITAL_REGION_IDS } from "./conquestCapital";

export type ConquestSignalTier = "minor" | "major" | "critical";

export type ConquestSignalKind =
  | "capital_fell"
  | "last_stand";

export interface ConquestSignal {
  id:        string;
  kind:      ConquestSignalKind;
  tier:      ConquestSignalTier;
  icon:      string;
  title:     string;
  subtitle?: string;
  colorKey?: ConquestPlayerColor | null;
  at:        number;
  ttlMs:     number;
}

const TTL_MAJOR    = 1300;
const TTL_CRITICAL = 2400;

export function useConquestSignals(
  gameState:    ConquestGameState | null,
  players:      ConquestPlayer[],
  playerColors: Record<string, ConquestPlayerColor>,
  myPlayerId:   string | null,
  _mapConfig:   ConquestMapConfig | null | undefined,
): ConquestSignal | null {
  const [queue, setQueue] = useState<ConquestSignal[]>([]);
  const seenRef            = useRef<Set<string>>(new Set());
  const prevOwnersRef      = useRef<Record<string, string | null> | null>(null);
  const lastStandFiredRef  = useRef<Set<string>>(new Set());
  const capitalFiredRef    = useRef<Set<string>>(new Set());

  const enqueue = (s: ConquestSignal) => {
    setQueue(q => (q.some(e => e.id === s.id) ? q : [...q, s]));
  };

  // Round transition has its own dedicated overlay (info card + 3-2-1
  // countdown) in ConquestGame, anchored to challenge.startedAt — no
  // signal banner fires here so the two flows never stack.

  // ── Last-stand (critical) ──────────────────────────────────────────
  // Bonus-region captures intentionally do NOT fire here — the bespoke
  // bonus toast in ConquestGame is the single premium feedback for those.
  // We still diff ownership here so the last-stand detector can run.
  useEffect(() => {
    if (!gameState) return;
    const current: Record<string, string | null> = {};
    for (const rs of gameState.regionStates) {
      current[rs.regionId] = rs.ownerPlayerId;
    }
    const prev = prevOwnersRef.current;
    prevOwnersRef.current = current;
    if (!prev) return;

    // Before/after counts for last-stand detection.
    const beforeCounts: Record<string, number> = {};
    const afterCounts:  Record<string, number> = {};
    for (const ownerId of Object.values(prev)) {
      if (ownerId) beforeCounts[ownerId] = (beforeCounts[ownerId] ?? 0) + 1;
    }
    for (const ownerId of Object.values(current)) {
      if (ownerId) afterCounts[ownerId] = (afterCounts[ownerId] ?? 0) + 1;
    }

    const now = Date.now();

    // ── Capital fell (major) ─────────────────────────────────────────
    // Any capital region whose owner changed to a non-null player this
    // tick. Guarded per (regionId, newOwner, tick) so re-renders don't
    // re-fire on the steady state. Normal region captures intentionally
    // never reach this branch — they stay in the event feed / bonus
    // toast lane. Future capital systems plug in by extending
    // CAPITAL_REGION_IDS; no change here is needed.
    for (const regionId of CAPITAL_REGION_IDS) {
      const before = prev[regionId] ?? null;
      const after  = current[regionId] ?? null;
      if (before === after || after === null) continue;
      const key = `capital-fell:${regionId}:${after}:${now}`;
      if (capitalFiredRef.current.has(key)) continue;
      capitalFiredRef.current.add(key);
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      enqueue({
        id:       key,
        kind:     "capital_fell",
        tier:     "major",
        icon:     "🏛️",
        title:    "Ankara Ele Geçirildi",
        subtitle: "Merkez el değiştirdi.",
        colorKey: playerColors[after] ?? null,
        at:       now,
        ttlMs:    TTL_MAJOR,
      });
    }

    // Last-stand: a player dropped from >1 to exactly 1 region this tick.
    // Guarded per (player, round) to prevent re-fire from re-renders.
    const round = gameState.round.roundNumber;
    for (const pid of Object.keys(afterCounts)) {
      const beforeC = beforeCounts[pid] ?? 0;
      const afterC  = afterCounts[pid] ?? 0;
      if (beforeC > 1 && afterC === 1) {
        const key = `last-stand:${pid}:${round}`;
        if (lastStandFiredRef.current.has(key)) continue;
        lastStandFiredRef.current.add(key);
        const id = `${key}:${now}`;
        if (seenRef.current.has(id)) continue;
        seenRef.current.add(id);
        const player = players.find(p => p.id === pid);
        const isMine = pid === myPlayerId;
        enqueue({
          id,
          kind:     "last_stand",
          tier:     "critical",
          icon:     "🔥",
          title:    isMine
            ? "Son Cephen Kaldı"
            : `${player?.name ?? "Bir oyuncu"} köşeye sıkıştı`,
          subtitle: "Tek bölge — düşerse elenir",
          colorKey: playerColors[pid] ?? null,
          at:       now,
          ttlMs:    TTL_CRITICAL,
        });
      }
    }
  }, [gameState?.regionStates, gameState?.round.roundNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // Match-over intentionally has no banner here — the final standings
  // panel is the only post-match feedback so the two never stack.

  // ── Advance queue when head expires ────────────────────────────────
  useEffect(() => {
    if (queue.length === 0) return;
    const head = queue[0];
    const elapsed   = Date.now() - head.at;
    const remaining = Math.max(80, head.ttlMs - elapsed);
    const t = window.setTimeout(() => {
      setQueue(q => q.slice(1));
    }, remaining);
    return () => window.clearTimeout(t);
  }, [queue]);

  return queue[0] ?? null;
}
