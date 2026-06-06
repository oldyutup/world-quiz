/**
 * ConquestFateCardReveal — Kader Kartı V2 reveal overlay (two-phase).
 *
 * Listens to `gameState.lastFateCardEvent` and shows a FATE_REVEAL_MS-long
 * overlay sequenced as:
 *   0 → FATE_REVEAL_INTRO_MS                : dramatic intro slate
 *                                             ("🎴 Kader Kartı çekildi!").
 *   FATE_REVEAL_INTRO_MS → FATE_REVEAL_MS   : viewer-aware detail slate
 *                                             (card name + iyi/kötü tag +
 *                                             2nd-person sentence for the
 *                                             drawer / 3rd-person sentence
 *                                             for every other viewer).
 *
 * Phase boundaries are computed from the SERVER-SYNCED clock
 * (`getConquestSyncedNowMs() - event.createdAt`), not local mount time, so
 * a guest who receives the event 400 ms late jumps straight into the right
 * phase and finishes alongside the host instead of holding the overlay open
 * 400 ms longer.
 *
 * Late-join echoes (events older than FATE_REVEAL_MS + 500 ms) are skipped
 * so reconnects don't replay a stale draw.
 *
 * Move-clock freezing during the reveal lives in `ConquestGame.tsx` (the
 * draw handler pushes `actionStartedAt`/`actionEndsAt` forward by exactly
 * FATE_REVEAL_MS, so every client's countdown and the host's auto-skip
 * timeout shift by the same amount).  This component is purely visual.
 *
 * IMPORTANT — timer lifecycle:
 *   The phase-flip and auto-close timers are keyed on `event?.id` so the
 *   effect ONLY tears down when a genuinely new event arrives (or the
 *   event clears).  An earlier revision had `activeId` in the dep list and
 *   tracked already-seen events with state — every `setActiveId` re-rendered
 *   the component, which re-ran the effect, which fired the cleanup and
 *   cleared the pending timeouts.  Result: overlay opened, the auto-close
 *   timer was destroyed before it could fire, and the backdrop stuck on
 *   screen forever.  Dedupe is now done with a ref so it can't trigger a
 *   render.
 */

import { useEffect, useRef, useState } from "react";
import type { ConquestFateCardEvent } from "./types";
import {
  FATE_REVEAL_MS,
  FATE_REVEAL_INTRO_MS,
  getFateCardViewerCopy,
} from "./conquestFateCards";
import { getConquestSyncedNowMs } from "./conquestClock";

type RevealPhase = "intro" | "detail";

interface Props {
  event: ConquestFateCardEvent | null;
  /**
   * Local viewer's player id — drives the 2nd-person / 3rd-person split.
   * `null` means a spectator or pre-join paint; the renderer falls through
   * to opponent (3rd-person) copy in that case, since a viewer with no id
   * can never be the drawer.
   */
  viewerPlayerId: string | null;
}

export default function ConquestFateCardReveal({ event, viewerPlayerId }: Props) {
  const [shownEvent, setShownEvent] = useState<ConquestFateCardEvent | null>(null);
  const [phase, setPhase]           = useState<RevealPhase>("intro");
  // Dedupe key kept in a ref so marking an event as seen never triggers a
  // re-render (which would otherwise tear down the close timer below).
  const seenIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!event) return;
    if (seenIdRef.current === event.id) return;
    seenIdRef.current = event.id;

    // Skip echoes that arrived too late to still be in their reveal window —
    // a reconnecting client should not replay a draw that already finished.
    const elapsed = getConquestSyncedNowMs() - event.createdAt;
    if (elapsed > FATE_REVEAL_MS + 500) return;

    const eventId = event.id;
    const initialPhase: RevealPhase =
      elapsed < FATE_REVEAL_INTRO_MS ? "intro" : "detail";

    setShownEvent(event);
    setPhase(initialPhase);

    const timers: number[] = [];
    if (initialPhase === "intro") {
      const introRemainingMs = Math.max(0, FATE_REVEAL_INTRO_MS - elapsed);
      timers.push(window.setTimeout(() => {
        setPhase("detail");
      }, introRemainingMs));
    }
    const closeRemainingMs = Math.max(0, FATE_REVEAL_MS - elapsed);
    timers.push(window.setTimeout(() => {
      setShownEvent(cur => (cur && cur.id === eventId ? null : cur));
    }, closeRemainingMs));

    return () => { for (const t of timers) window.clearTimeout(t); };
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shownEvent) return null;

  const viewerIsActor = viewerPlayerId !== null
    && viewerPlayerId === shownEvent.playerId;
  const copy = getFateCardViewerCopy(shownEvent.cardId, viewerIsActor, {
    actorName: shownEvent.playerName,
  });
  const eyebrowText = viewerIsActor
    ? "Kader Kartı çektin"
    : `${shownEvent.playerName} Kader Kartı çekti`;
  const introCaption = viewerIsActor
    ? "Senin sıran"
    : `${shownEvent.playerName} çekti`;
  const ariaLabel =
    (viewerIsActor
      ? `Kader Kartı çektin: ${shownEvent.cardName}.`
      : `${shownEvent.playerName} Kader Kartı çekti: ${shownEvent.cardName}.`)
    + ` ${copy.detail}`;

  return (
    <div
      className="cq-fate-reveal-backdrop"
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
    >
      {phase === "intro" ? (
        <div
          key="intro"
          className="cq-fate-reveal-card cq-fate-reveal-card--intro"
          data-phase="intro"
        >
          <div className="cq-fate-reveal-intro-emoji" aria-hidden="true">🎴</div>
          <div className="cq-fate-reveal-intro-headline">Kader Kartı çekildi!</div>
          <div className="cq-fate-reveal-intro-eyebrow">{introCaption}</div>
        </div>
      ) : (
        <div
          key="detail"
          className="cq-fate-reveal-card"
          data-phase="detail"
          data-type={shownEvent.cardType}
        >
          <div className="cq-fate-reveal-icon" aria-hidden="true">🎴</div>
          <div className="cq-fate-reveal-eyebrow">{eyebrowText}</div>
          <div className="cq-fate-reveal-name">{shownEvent.cardName}</div>
          <div className="cq-fate-reveal-tag" data-type={shownEvent.cardType}>
            {shownEvent.cardType === "good" ? "✨ İyi Kart" : "💀 Kötü Kart"}
          </div>
          <div className="cq-fate-reveal-desc">{copy.detail}</div>
        </div>
      )}
    </div>
  );
}
