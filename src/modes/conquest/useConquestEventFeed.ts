/**
 * useConquestEventFeed — local-derived event log for the Kuşatma feed.
 *
 * MVP Phase 1 scope.  The hook listens to fields that already live on the
 * synced gameState (regionStates, lastBonusToast, defenseDuel, lastResult)
 * and turns observed transitions into a small FIFO list of UI rows.  No new
 * sync surface is added; each client builds its own log from local diffs.
 *
 *   • ownership change          → capture / loss row (per viewer perspective)
 *   • new lastBonusToast.id      → bonus-earned row
 *   • defenseDuel.id present     → "attack started" row
 *   • defenseDuel.id cleared     → defend / shield-broken row (from lastResult)
 *
 * Deduping is keyed by stable string ids in `seenIdsRef`, so re-renders that
 * don't actually change the underlying field are no-ops.  The list caps at
 * MAX_EVENTS; older rows fall off the bottom.
 *
 * Late joiners see only events that happen after they mount — acceptable
 * for short Kuşatma matches.  A future authoritative `lastEvent` field on
 * gameState can replace this hook without changing its public shape.
 */

import { useEffect, useRef, useState } from "react";
import type {
  ConquestGameState,
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
} from "./types";

export interface ConquestEventFeedEntry {
  id:        string;
  at:        number;
  icon:      string;
  text:      string;
  colorKey?: ConquestPlayerColor;
  isMine?:   boolean;
  regionId?: ConquestRegionId;
}

const MAX_EVENTS = 6;

function regionLabel(
  mapConfig: ConquestMapConfig | null | undefined,
  regionId:  ConquestRegionId,
): string {
  if (!mapConfig) return regionId;
  const r = mapConfig.regions.find(r => r.id === regionId);
  return r?.displayLabel ?? r?.name ?? regionId;
}

function prependBounded(
  existing: ConquestEventFeedEntry[],
  newOnes:  ConquestEventFeedEntry[],
): ConquestEventFeedEntry[] {
  if (newOnes.length === 0) return existing;
  return [...newOnes, ...existing].slice(0, MAX_EVENTS);
}

export function useConquestEventFeed(
  gameState:    ConquestGameState | null,
  players:      ConquestPlayer[],
  playerColors: Record<string, ConquestPlayerColor>,
  myPlayerId:   string | null,
  mapConfig:    ConquestMapConfig | null | undefined,
): ConquestEventFeedEntry[] {
  const [events, setEvents] = useState<ConquestEventFeedEntry[]>([]);
  const seenIdsRef         = useRef<Set<string>>(new Set());
  const prevOwnersRef      = useRef<Record<string, string | null> | null>(null);
  const prevDuelIdRef      = useRef<string | null>(null);
  const prevBonusToastRef  = useRef<string | null>(null);
  const prevFateCardIdRef  = useRef<string | null>(null);

  // ── Ownership transitions ───────────────────────────────────────────
  useEffect(() => {
    if (!gameState) return;
    const current: Record<string, string | null> = {};
    for (const rs of gameState.regionStates) {
      current[rs.regionId] = rs.ownerPlayerId;
    }
    const prev = prevOwnersRef.current;
    if (!prev) {
      prevOwnersRef.current = current;
      return;
    }

    const newEntries: ConquestEventFeedEntry[] = [];
    const now = Date.now();
    for (const rid of Object.keys(current)) {
      const before = prev[rid] ?? null;
      const after  = current[rid];
      if (before === after) continue;
      if (after === null)   continue; // neutralisation doesn't happen today

      const id = `own:${rid}:${before ?? "_"}>${after}:${now}`;
      if (seenIdsRef.current.has(id)) continue;
      seenIdsRef.current.add(id);

      const newOwner  = players.find(p => p.id === after);
      const newName   = newOwner?.name ?? "Bir oyuncu";
      const oldOwner  = before ? players.find(p => p.id === before) : null;
      const oldName   = oldOwner?.name ?? "rakipten";
      const label     = regionLabel(mapConfig, rid as ConquestRegionId);
      const isMine    = after === myPlayerId;
      const wasMine   = before === myPlayerId;

      let icon = "⚔️";
      let text = "";
      if (wasMine) {
        icon = "❌";
        text = `${label} elinden çıktı — ${newName}`;
      } else if (isMine && before !== null) {
        icon = "🗡️";
        text = `${label} bölgesini fethettin (${oldName})`;
      } else if (isMine && before === null) {
        icon = "🚩";
        text = `${label} senindir`;
      } else if (before === null) {
        icon = "🚩";
        text = `${newName}, ${label}'i aldı`;
      } else {
        icon = "⚔️";
        text = `${newName} ${label} bölgesini fethetti`;
      }

      newEntries.push({
        id, at: now, icon, text,
        colorKey: playerColors[after] ?? "neutral",
        isMine,
        regionId: rid as ConquestRegionId,
      });
    }

    if (newEntries.length > 0) {
      setEvents(prev => prependBounded(prev, newEntries));
    }
    prevOwnersRef.current = current;
  }, [gameState, players, playerColors, myPlayerId, mapConfig]);

  // ── Bonus toast surfacing ───────────────────────────────────────────
  useEffect(() => {
    const lbt = gameState?.lastBonusToast;
    if (!lbt) {
      prevBonusToastRef.current = null;
      return;
    }
    if (prevBonusToastRef.current === lbt.id) return;
    prevBonusToastRef.current = lbt.id;
    const key = `bonus:${lbt.id}`;
    if (seenIdsRef.current.has(key)) return;
    seenIdsRef.current.add(key);

    const isMine = myPlayerId === lbt.playerId;
    const name   = lbt.playerName || "Bir oyuncu";
    let suffix = "";
    if (lbt.bonusType === "cukurova_score") {
      // Bereketli Ova ships two toast flavours: capture (+2 on every capture)
      // and harvest (one-shot +4 after 3 held rounds per owner tenure).
      // Distinguish by toast id prefix so the feed reflects the right delta.
      suffix = lbt.id.startsWith("bereket_harvest-") ? " (+4)" : " (+2)";
    }
    else if (lbt.bonusType === "karadeniz_extra_time") suffix = " (+5sn)";
    // Prefer the dynamic region the bonus actually landed on this round.
    // Falls back to the toast's baked-in title for pre-dynamic-bonus saves.
    // Bereketli Ova harvest gets a dedicated label so the feed reads as the
    // 3-turn payout, not a fresh capture.
    const isBereketHarvest = lbt.bonusType === "cukurova_score"
      && lbt.id.startsWith("bereket_harvest-");
    const regionTitle = isBereketHarvest
      ? (lbt.regionId ? `${regionLabel(mapConfig, lbt.regionId)} Hasat` : "Hasat Zamanı")
      : lbt.regionId
        ? `${regionLabel(mapConfig, lbt.regionId)} Bonusu`
        : lbt.title;
    const text = `${name} — ${regionTitle}${suffix}`;

    setEvents(prev => prependBounded(prev, [{
      id: key,
      at: lbt.at,
      icon: lbt.icon || "⭐",
      text,
      colorKey: playerColors[lbt.playerId] ?? "neutral",
      isMine,
    }]));
  }, [gameState?.lastBonusToast, myPlayerId, playerColors]);

  // ── Defense duel start / end ────────────────────────────────────────
  useEffect(() => {
    const duel   = gameState?.defenseDuel ?? null;
    const duelId = duel?.id ?? null;
    const prevId = prevDuelIdRef.current;
    prevDuelIdRef.current = duelId;

    if (duelId && duelId !== prevId && duel) {
      const startKey = `duel-start:${duel.id}`;
      if (!seenIdsRef.current.has(startKey)) {
        seenIdsRef.current.add(startKey);
        const attacker = players.find(p => p.id === duel.attackerId);
        const label    = regionLabel(mapConfig, duel.regionId);
        setEvents(prev => prependBounded(prev, [{
          id: startKey,
          at: duel.startedAt,
          icon: "⚔️",
          text: `${attacker?.name ?? "Saldıran"}, ${label}'a saldırdı`,
          colorKey: playerColors[duel.attackerId] ?? "neutral",
          isMine: myPlayerId === duel.attackerId,
          regionId: duel.regionId,
        }]));
      }
    }

    if (!duelId && prevId) {
      const endKey = `duel-end:${prevId}`;
      if (seenIdsRef.current.has(endKey)) return;
      const lr = gameState?.round.lastResult;
      if (!lr) return;

      seenIdsRef.current.add(endKey);
      const actor      = players.find(p => p.id === lr.playerId);
      const actorName  = actor?.name ?? "Bir oyuncu";
      const label      = lr.regionId ? regionLabel(mapConfig, lr.regionId) : "";
      const msg        = lr.message ?? "";

      let icon: string | null = null;
      let text: string | null = null;

      if (lr.action === "defend_region") {
        if (msg.includes("⏰")) {
          icon = "⏳";
          text = `Süre doldu — ${label} ${actorName}'da kaldı`;
        } else {
          icon = "🛡️";
          text = `${actorName}, ${label}'i savundu`;
        }
      } else if (lr.action === "attack_region" && msg.includes("Kalkan kırıldı")) {
        // Capture didn't happen — shield consumed.  Ownership-effect won't
        // fire a row for this case, so we emit one here.
        icon = "🛡️";
        text = `${actorName} kalkanı kırdı — ${label}`;
      }
      // Successful captures are surfaced by the ownership effect; no row here.

      if (icon && text) {
        setEvents(prev => prependBounded(prev, [{
          id: endKey,
          at: Date.now(),
          icon, text,
          colorKey: playerColors[lr.playerId] ?? "neutral",
          isMine: myPlayerId === lr.playerId,
          regionId: lr.regionId ?? undefined,
        }]));
      }
    }
  }, [gameState?.defenseDuel, gameState?.round.lastResult, players, mapConfig, playerColors, myPlayerId]);

  // ── Kader Kartı V1 — log every draw exactly once ────────────────────
  useEffect(() => {
    const fc = gameState?.lastFateCardEvent;
    if (!fc) {
      prevFateCardIdRef.current = null;
      return;
    }
    if (prevFateCardIdRef.current === fc.id) return;
    prevFateCardIdRef.current = fc.id;
    const key = `fate:${fc.id}`;
    if (seenIdsRef.current.has(key)) return;
    seenIdsRef.current.add(key);

    const isMine  = myPlayerId === fc.playerId;
    const isGood  = fc.cardType === "good";
    const delta   = isGood ? "+1 puan" : "-1 puan";
    const text    = `${fc.playerName} Kader Kartı çekti: ${fc.cardName} (${delta})`;
    setEvents(prev => prependBounded(prev, [{
      id:       key,
      at:       fc.createdAt,
      icon:     isGood ? "🎴" : "💀",
      text,
      colorKey: playerColors[fc.playerId] ?? "neutral",
      isMine,
    }]));
  }, [gameState?.lastFateCardEvent, myPlayerId, playerColors]);

  return events;
}
