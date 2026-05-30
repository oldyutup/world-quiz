/**
 * useConquestSound — central sound trigger layer for Kuşatma mode.
 *
 * Listens to phase transitions and key fields on the synced gameState
 * and fires the right conquest sound through `playConquestSound`.  Pure
 * local: no new sync surface, no gameplay mutation, no React render
 * output.
 *
 * Sounds covered here:
 *   • round-start          — when the round number advances OR the very
 *                            first round of a fresh match begins
 *   • reveal-{win,neutral,fail}
 *                          — on the challenge → reveal transition, picked
 *                            per viewer based on who won vs. who answered
 *   • turn-{yours,theirs}  — on entering the action phase, picked per
 *                            viewer based on actionHolderId
 *   • capture / bonus-capture / shield-break
 *                          — on entering round_result with an ok action
 *                            that captured a region (or shattered a shield)
 *   • duel-start           — when a defense duel id appears
 *   • duel-{win,lose,spectator}
 *                          — when a defense duel id clears, per viewer
 *   • hidden-operation     — gizli görev placement OR a Gizli Fetih reveal,
 *                            AND any capture of the region currently carrying
 *                            the gizli görev bonus (priority over bonus-capture)
 *   • match-{win,lose}     — once when the match enters the `finished` phase,
 *                            picked per viewer against the final standings
 *
 * Answer-submit and per-region-click clicks stay where they are (fired
 * directly inside the corresponding handlers in ConquestGame); this hook
 * is for everything driven by synced state transitions.
 *
 * Dedupe strategy: every fire is keyed by a stable string id (challenge
 * id, duel id, region+round, etc.).  A single seenIdsRef Set guards the
 * whole hook so a re-render that re-runs an effect on the same snapshot
 * never re-fires a sound.
 */

import { useEffect, useRef } from "react";
import type {
  ConquestGameState,
  ConquestRegionBonusType,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundBonusAssignment,
} from "./types";
import { playConquestSound, type ConquestSoundName } from "./conquestSound";
import {
  HIDDEN_OP_PLACED_MESSAGE_PREFIX,
  HIDDEN_CONQUEST_REVEAL_MESSAGE,
  REGION_BONUSES,
} from "./regionBonuses";
import { buildFinalStandings } from "./conquestGameplay";

/** Hidden-operation bonus type — matched verbatim against the dynamic
 *  assignment OR legacy static catalog so the cue stays tied to the bonus,
 *  not the historical Ankara hardcode. */
const HIDDEN_OP_BONUS_TYPE: ConquestRegionBonusType = "ankara_hidden_shield";

/** Resolve the bonus type carried by `regionId` in this match.  Prefers the
 *  dynamic per-match assignment; falls back to the static catalog for
 *  pre-dynamic-bonus saves so legacy rooms keep their cue mapping. */
function bonusTypeForRegion(
  roundBonuses: ConquestRoundBonusAssignment | undefined,
  regionId:     ConquestRegionId,
): ConquestRegionBonusType | null {
  if (roundBonuses) return roundBonuses[regionId] ?? null;
  return REGION_BONUSES[regionId]?.type ?? null;
}

/** Pick the cue for a region-capture event.  Priority:
 *    1. hidden-operation — bonus type is gizli görev (any region)
 *    2. bonus-capture    — region carries any other active bonus
 *    3. capture          — plain region
 *  Previous owner (neutral vs. opponent) is intentionally ignored. */
function pickCaptureSound(
  roundBonuses: ConquestRoundBonusAssignment | undefined,
  regionId:     ConquestRegionId,
): ConquestSoundName {
  const type = bonusTypeForRegion(roundBonuses, regionId);
  if (type === HIDDEN_OP_BONUS_TYPE) return "hidden-operation";
  if (type === "liman")              return "harbor-capture";
  if (type)                          return "bonus-capture";
  return "capture";
}

function shieldedKey(rs: ConquestRegionState): boolean {
  return rs.shielded === true || !!rs.hiddenShieldOwnerId;
}

export function useConquestSound(
  gameState:  ConquestGameState | null,
  myPlayerId: string | null,
): void {
  const seenIdsRef          = useRef<Set<string>>(new Set());
  const prevPhaseRef        = useRef<string | null>(null);
  const prevRoundRef        = useRef<number | null>(null);
  const prevChallengeIdRef  = useRef<string | null>(null);
  const prevDuelIdRef       = useRef<string | null>(null);
  const prevShieldsRef      = useRef<Record<string, boolean> | null>(null);
  const prevOwnersRef       = useRef<Record<string, string | null> | null>(null);
  const prevCaptureOwnersRef = useRef<Record<string, string | null> | null>(null);
  const answeredChallengeIdRef = useRef<string | null>(null);
  const answeredCorrectRef     = useRef<boolean>(false);

  // ── Track which challenge the local viewer has answered & whether
  //    they got it right.  Picked up from the synced submittedAnswers
  //    AFTER the reveal lands; we also accept the live answeredPlayerIds
  //    while the challenge is still active so the reveal sound for the
  //    local viewer reflects their own submission even if they got the
  //    question wrong (in which case the submission isn't recorded in
  //    submittedAnswers until reveal). ──────────────────────────────
  useEffect(() => {
    const cs = gameState?.round.challenge;
    if (!cs || !myPlayerId) return;
    const challengeId = cs.challenge.id;

    if (answeredChallengeIdRef.current !== challengeId) {
      // New challenge — reset.
      answeredChallengeIdRef.current = null;
      answeredCorrectRef.current     = false;
    }

    const submitted = cs.submittedAnswers?.find(a => a.playerId === myPlayerId);
    if (submitted) {
      answeredChallengeIdRef.current = challengeId;
      answeredCorrectRef.current     = !!submitted.correct;
      return;
    }
    const answeredIds = cs.answeredPlayerIds ?? [];
    if (answeredIds.includes(myPlayerId)) {
      answeredChallengeIdRef.current = challengeId;
      // We can't tell wrong vs. right from answeredPlayerIds alone, so
      // keep the previous flag.  Reveal logic below treats unknown as
      // "wrong" for the local viewer, which is the safer default.
    }
  }, [gameState?.round.challenge, myPlayerId]);

  // ── Round-start (war drum) ─────────────────────────────────────────
  //    Plays ONCE per match, during the game-intro overlay of round 1.
  //    Per-round transitions (round 2, 3, …) intentionally stay silent —
  //    turn-yours/turn-theirs already mark the start of each new round.
  useEffect(() => {
    if (!gameState) return;
    const round = gameState.round.roundNumber;
    const prev  = prevRoundRef.current;
    prevRoundRef.current = round;

    if (prev !== null) return;

    // First snapshot for this client.  Play only if this is a fresh
    // match (round 1 with a game intro overlay still active).
    const introEnds = gameState.gameIntroEndsAt ?? 0;
    if (round === 1 && introEnds > 0 && Date.now() < introEnds) {
      const key = `round-start:${round}:${gameState.startedAt}`;
      if (!seenIdsRef.current.has(key)) {
        seenIdsRef.current.add(key);
        playConquestSound("round-start");
      }
    }
  }, [gameState?.round.roundNumber, gameState?.startedAt, gameState?.gameIntroEndsAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Match end — final standings overlay ────────────────────────────
  //    Fires once when the match enters `finished` phase (the screen that
  //    surfaces the final standings).  Local viewer perspective:
  //      • winner   → match-win
  //      • loser    → match-lose
  //      • draw / spectator / unknown viewer → silent
  //
  //    Dedupe key includes the match (startedAt), the winner id (so a
  //    rematch with the same room re-fires) and the viewer (so two clients
  //    in split-screen / shared-device setups don't suppress each other).
  //    A `finished` snapshot received on first load also fires once for
  //    the viewer who joined late — buildFinalStandings is the same source
  //    of truth the results screen reads, so the cue never disagrees with
  //    the displayed winner.
  useEffect(() => {
    if (!gameState) return;
    if (gameState.phase !== "finished") return;

    const matchId  = gameState.startedAt ?? 0;
    const viewerId = myPlayerId ?? "_spectator";

    const standings = buildFinalStandings(gameState);
    const winners   = standings.filter(s => s.rank === 1);
    // Draws (multiple rank-1 rows) intentionally stay silent — neither cue
    // is honest in that case.
    const isDraw    = winners.length !== 1;
    const winnerId  = isDraw ? null : winners[0]?.playerId ?? null;

    const key = `match-result:${matchId}:${winnerId ?? "_draw"}:${viewerId}`;
    if (seenIdsRef.current.has(key)) return;
    seenIdsRef.current.add(key);

    if (!myPlayerId)           return;            // spectator → silent
    if (isDraw)                return;            // draw → silent
    const viewerInMatch = standings.some(s => s.playerId === myPlayerId);
    if (!viewerInMatch)        return;            // viewer not a player → silent

    if (winnerId === myPlayerId) {
      playConquestSound("match-win");
    } else {
      playConquestSound("match-lose");
    }
  }, [gameState?.phase, gameState?.startedAt, myPlayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Phase transitions: reveal / action / defense_duel / round_result
  useEffect(() => {
    if (!gameState) return;
    const phase    = gameState.phase;
    const prev     = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === phase) return;

    const round    = gameState.round.roundNumber;
    const cs       = gameState.round.challenge;
    const cId      = cs?.challenge.id ?? null;
    const winnerId = cs?.winnerPlayerId ?? cs?.firstCorrectPlayerId ?? null;

    // challenge → reveal
    if (prev === "challenge" && phase === "reveal" && cId) {
      const key = `reveal:${cId}`;
      if (!seenIdsRef.current.has(key)) {
        seenIdsRef.current.add(key);
        if (winnerId && myPlayerId && winnerId === myPlayerId) {
          playConquestSound("reveal-win");
        } else if (
          myPlayerId
          && answeredChallengeIdRef.current === cId
          && answeredCorrectRef.current
          && winnerId !== myPlayerId
        ) {
          // Correct but not first — soft positive.
          playConquestSound("reveal-neutral");
        } else if (!winnerId) {
          // Nobody answered correctly — low-tone fail.
          playConquestSound("reveal-fail");
        } else {
          // Spectator perspective (or local viewer answered wrong/skipped).
          playConquestSound("reveal-neutral");
        }
      }
    }

    // (challenge OR reveal) → action  — turn assignment
    if (
      (prev === "challenge" || prev === "reveal")
      && phase === "action"
    ) {
      const holderId = gameState.round.actionHolderId;
      if (holderId) {
        const key = `turn:${round}:${holderId}`;
        if (!seenIdsRef.current.has(key)) {
          seenIdsRef.current.add(key);
          if (myPlayerId && holderId === myPlayerId) {
            playConquestSound("turn-yours");
          } else {
            playConquestSound("turn-theirs");
          }
        }
      }
    }

    // any → defense_duel
    //
    // Duel intro has two visible stages: the "⚔️ Hedef: …" info toast
    // (first DUEL_INFO_MS of the duel) and then the 3-2-1 countdown
    // overlay (until the question becomes visible).  Each stage owns
    // its own sound — see the dedicated duel-id effect below for the
    // attack-focus → duel-start sequencing.  Nothing fires here so
    // there's no double-trigger when the phase first lands.

    // any → round_result  — shield-break only.  Capture & bonus-capture are
    // owned by the ownership-diff effect below so the cue selection depends
    // on region type (bonus vs. normal) — not on the path that produced the
    // capture (neutral grab, opponent grab via defense_duel, hidden-shield
    // flip, etc.).  Duel resolution is surfaced via the duel-id branch.
    if (phase === "round_result") {
      const lr = gameState.round.lastResult;
      const msg = lr?.message ?? "";
      const cameFromDuel = prev === "defense_duel";
      // Hidden Operation events (placement + Gizli Fetih reveal) own the
      // hidden-operation cue exclusively; suppress shield-break here too
      // so the audio for that tick is a single, clear cue.
      const isHiddenOpEvent =
        msg.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX)
        || msg === HIDDEN_CONQUEST_REVEAL_MESSAGE;
      if (
        lr?.ok
        && !cameFromDuel
        && !isHiddenOpEvent
        && msg.includes("Kalkan kırıldı")
      ) {
        const key = `action:${round}:${lr.action}:${lr.regionId ?? "_"}:${lr.playerId}`;
        if (!seenIdsRef.current.has(key)) {
          seenIdsRef.current.add(key);
          playConquestSound("shield-break");
        }
      }
    }
  }, [gameState?.phase, gameState?.round.roundNumber, gameState?.round.lastResult, gameState?.round.actionHolderId, gameState?.defenseDuel?.id, myPlayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Duel intro audio sequencing ────────────────────────────────────
  //    When a defense duel begins, the UI shows the "⚔️ Hedef: …" info
  //    toast for DUEL_INFO_MS, then transitions into the 3-2-1 countdown
  //    overlay.  Each visual gets its own audio cue:
  //
  //      attack-focus  — fires immediately with the Hedef toast.
  //      duel-start    — fires when the countdown overlay takes over.
  //
  //    DUEL_INFO_MS is duplicated from ConquestGame.tsx — the visible
  //    timing is owned there; gameplay's DEFENSE_DUEL_INFO_MS (4000) is
  //    the *resolver*'s view and does not match the rendered toast
  //    window (5000).  If the UI constant moves, mirror it here.
  //
  //    Stable keys keep both sounds at-most-once per duel even if the
  //    component re-renders or a stale snapshot replays.  Timer is
  //    cleared on duel-id change/unmount so a short-lived duel can't
  //    leave a delayed duel-start playing after the resolution toast.
  useEffect(() => {
    if (!gameState) return;
    if (gameState.phase !== "defense_duel") return;
    const duelId = gameState.defenseDuel?.id ?? null;
    if (!duelId) return;

    const focusKey = `attack-focus-duel:${duelId}`;
    if (!seenIdsRef.current.has(focusKey)) {
      seenIdsRef.current.add(focusKey);
      playConquestSound("attack-focus");
    }

    const DUEL_INFO_MS = 5000;
    const startKey = `duel-start:${duelId}`;
    if (seenIdsRef.current.has(startKey)) return;
    const handle = window.setTimeout(() => {
      if (seenIdsRef.current.has(startKey)) return;
      seenIdsRef.current.add(startKey);
      playConquestSound("duel-start");
    }, DUEL_INFO_MS);
    return () => window.clearTimeout(handle);
  }, [gameState?.phase, gameState?.defenseDuel?.id]);

  // ── Duel-id transitions (start watched above; this handles resolution).
  //    Fires when duel.id drops back to null — winner-relative sound per
  //    viewer.  Spectators get a softer neutral cue.
  useEffect(() => {
    const duel    = gameState?.defenseDuel ?? null;
    const duelId  = duel?.id ?? null;
    const prevId  = prevDuelIdRef.current;
    prevDuelIdRef.current = duelId;

    if (!duelId && prevId) {
      const endKey = `duel-end:${prevId}`;
      if (seenIdsRef.current.has(endKey)) return;
      seenIdsRef.current.add(endKey);

      const lr  = gameState?.round.lastResult ?? null;
      const msg = lr?.message ?? "";
      // Defender wins when defend_region resolves (timer expiry → "⏰", or
      // direct defense).  Attacker wins when attack_region resolves with
      // an ok flag.  Shield-break is handled as its own cue.
      if (msg.includes("Kalkan kırıldı")) {
        playConquestSound("shield-break");
        return;
      }
      if (!lr) {
        playConquestSound("duel-spectator");
        return;
      }
      // attackerId is captured on duel start — we read it from lastResult
      // when possible; for defender wins lr.playerId IS the defender.
      const winnerId = lr.playerId;
      if (myPlayerId && winnerId === myPlayerId) {
        playConquestSound("duel-win");
      } else if (myPlayerId) {
        // We were involved if duel had us as attacker/defender; otherwise
        // it's spectator.  We can't tell from lastResult alone, so any
        // viewer that isn't the winner gets duel-lose if they answered
        // wrong locally, otherwise spectator.  Keep it simple: anyone
        // who isn't the winner gets duel-lose — quieter than duel-win
        // and still works for the spectator case.
        playConquestSound("duel-lose");
      } else {
        playConquestSound("duel-spectator");
      }
    }
  }, [gameState?.defenseDuel?.id, gameState?.round.lastResult, myPlayerId]);

  // ── Region capture (any ownership path).  One diff drives both
  //    `capture` and `bonus-capture` cues based on the *region type*, not
  //    the previous owner.  Earlier the phase effect only fired `capture`
  //    for direct neutral grabs (`!cameFromDuel`), so attacks on
  //    opponent-owned normal regions — which always detour through
  //    defense_duel — landed in round_result with no capture cue at all.
  //    Watching ownership transitions here covers every path uniformly:
  //    neutral → player, opponent → player, hidden-shield flip, duel-won,
  //    etc.
  //
  //    Cue selection priority (per the design contract):
  //      hidden-operation  >  bonus-capture  >  capture
  //
  //    Hidden Operation events (placement + Gizli Fetih reveal) own the
  //    audio for the region they touch this tick; the hidden-op effect
  //    below plays its cue and this effect skips that region so no
  //    duplicate stacks.  For every other transition: bonus-capture wins
  //    if the captured region carries an active round bonus, otherwise
  //    capture plays.
  //
  //    Shield-break / duel-win / duel-lose are per-viewer cues that still
  //    play in parallel — the world-event cue here is global.
  useEffect(() => {
    if (!gameState) return;
    const cur: Record<string, string | null> = {};
    for (const rs of gameState.regionStates) {
      cur[rs.regionId] = rs.ownerPlayerId;
    }

    const prev = prevCaptureOwnersRef.current;
    prevCaptureOwnersRef.current = cur;
    if (!prev) return; // baseline only — no event on first snapshot

    const round = gameState.round.roundNumber;

    // Hidden-op suppression: when the current lastResult is a hidden-op
    // event, skip the cue for that exact region so the hidden-op effect
    // below plays the single, correct sound.
    const lr     = gameState.round.lastResult;
    const lrMsg  = lr?.message ?? "";
    const isHiddenOpEvent =
      lrMsg.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX)
      || lrMsg === HIDDEN_CONQUEST_REVEAL_MESSAGE;
    const hiddenOpRegion = isHiddenOpEvent ? (lr?.regionId ?? null) : null;

    for (const regionId of Object.keys(cur)) {
      const before = prev[regionId] ?? null;
      const after  = cur[regionId] ?? null;
      if (before === after) continue;
      if (after === null)   continue; // no neutralisation in gameplay today

      if (regionId === hiddenOpRegion) continue;

      // Priority: hidden-operation > bonus-capture > capture.  When the
      // captured region carries the gizli görev bonus this match the cue
      // is hidden-operation regardless of which dynamic region it landed
      // on — the historical Ankara hardcode no longer drives selection.
      const sound = pickCaptureSound(gameState.roundBonuses, regionId);

      const key = `${sound}:${regionId}:${before ?? "_"}>${after}:${round}`;
      if (seenIdsRef.current.has(key)) continue;
      seenIdsRef.current.add(key);

      playConquestSound(sound);
    }
  }, [gameState?.regionStates, gameState?.round.roundNumber, gameState?.roundBonuses]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Shield-break safety net.  The phase-effect above catches the
  //    common "Kalkan kırıldı" path through lastResult.message, but a
  //    shield can also break silently via the shieldStates diff (e.g.
  //    a hidden shield triggered without round_result text).  We diff
  //    shielded flags here for those cases. ────────────────────────────
  useEffect(() => {
    if (!gameState) return;
    const cur: Record<string, boolean> = {};
    const ownerCur: Record<string, string | null> = {};
    for (const rs of gameState.regionStates) {
      cur[rs.regionId]      = shieldedKey(rs);
      ownerCur[rs.regionId] = rs.ownerPlayerId;
    }

    const prev      = prevShieldsRef.current;
    const ownerPrev = prevOwnersRef.current ?? {};
    prevShieldsRef.current = cur;
    prevOwnersRef.current  = ownerCur;

    if (!prev) return; // baseline only

    for (const rid of Object.keys(cur)) {
      const before = prev[rid] ?? false;
      const after  = cur[rid];
      if (!before || after) continue;
      // Suppress when the owner also changed this tick — capture sound
      // already covers that moment; double-stacking reads as noise.
      if ((ownerPrev[rid] ?? null) !== (ownerCur[rid] ?? null)) continue;

      const round = gameState.round.roundNumber;
      const key   = `shield-break:${rid}:${round}`;
      if (seenIdsRef.current.has(key)) continue;
      seenIdsRef.current.add(key);
      playConquestSound("shield-break");
    }
  }, [gameState?.regionStates, gameState?.round.roundNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Hidden Operation (Ankara Gizli Fetih / Gizli Operasyon) ──────────
  //    Fires once when the holder consumes the Gizli Operasyon hakkı
  //    (placement) and once when a Gizli Fetih is exposed by an attack
  //    (reveal).  Both events surface through `round.lastResult` with a
  //    distinctive sentinel/canonical message.  Gizli Kalkan reveals
  //    (HIDDEN_SHIELD_REVEAL_MESSAGE) are intentionally NOT routed here
  //    — they keep flowing through the existing branches.
  //
  //    Stable dedupe keys (round + playerId/regionId) survive re-renders
  //    even when lastResult identity changes.
  useEffect(() => {
    if (!gameState) return;
    if (gameState.phase !== "round_result") return;
    const lr = gameState.round.lastResult;
    if (!lr) return;
    const msg = lr.message ?? "";
    const round = gameState.round.roundNumber;

    if (msg.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX)) {
      const key = `hidden-op-placed:${round}:${lr.playerId}`;
      if (!seenIdsRef.current.has(key)) {
        seenIdsRef.current.add(key);
        playConquestSound("hidden-operation");
      }
      return;
    }
    if (msg === HIDDEN_CONQUEST_REVEAL_MESSAGE) {
      const key = `hidden-conquest-reveal:${round}:${lr.regionId ?? "_"}:${lr.playerId}`;
      if (!seenIdsRef.current.has(key)) {
        seenIdsRef.current.add(key);
        playConquestSound("hidden-operation");
      }
    }
  }, [gameState?.phase, gameState?.round.lastResult, gameState?.round.roundNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Garbage-collect the dedupe set when the challenge id rolls over so
  //    long matches don't grow it unbounded.  Keeping at least the
  //    current-challenge-related keys means we still guard against
  //    re-render replays for the live challenge. ─────────────────────
  useEffect(() => {
    const cId = gameState?.round.challenge?.challenge.id ?? null;
    const prev = prevChallengeIdRef.current;
    prevChallengeIdRef.current = cId;
    if (cId && prev && cId !== prev) {
      // Keep set bounded: drop anything that doesn't reference the
      // current challenge or duel.  Cheap heuristic — purge when size
      // grows past a soft cap.
      if (seenIdsRef.current.size > 64) {
        seenIdsRef.current = new Set();
      }
    }
  }, [gameState?.round.challenge?.challenge.id]);
}
