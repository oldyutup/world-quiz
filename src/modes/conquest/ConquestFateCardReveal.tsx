/**
 * ConquestFateCardReveal — Kader Kartı V1 reveal overlay.
 *
 * Listens to `gameState.lastFateCardEvent` and shows a brief overlay (3s)
 * when a new event id arrives.  Late-join echoes (events older than the
 * reveal window) are skipped so reconnects don't replay stale draws.
 *
 * IMPORTANT — timer lifecycle:
 *   The auto-close timer is keyed on `event?.id` so the effect ONLY tears
 *   down when a genuinely new event arrives (or the event clears).  An
 *   earlier revision had `activeId` in the dep list and tracked
 *   already-seen events with state — every `setActiveId` re-rendered the
 *   component, which re-ran the effect, which fired the cleanup and
 *   cleared the pending timeout.  Result: overlay opened, the 3-second
 *   timer was destroyed before it could fire, and the backdrop stuck on
 *   screen forever.  Dedupe is now done with a ref so it can't trigger a
 *   render.
 */

import { useEffect, useRef, useState } from "react";
import type { ConquestFateCardEvent } from "./types";
import { FATE_REVEAL_MS } from "./conquestFateCards";
import { getConquestSyncedNowMs } from "./conquestClock";

interface Props {
  event: ConquestFateCardEvent | null;
}

export default function ConquestFateCardReveal({ event }: Props) {
  const [shownEvent, setShownEvent] = useState<ConquestFateCardEvent | null>(null);
  // Dedupe key kept in a ref so marking an event as seen never triggers a
  // re-render (which would otherwise tear down the close timer below).
  const seenIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!event) return;
    if (seenIdRef.current === event.id) return;
    seenIdRef.current = event.id;
    // Skip echoes that arrived too late to still be in their reveal window —
    // a reconnecting client should not replay a draw that already finished.
    if (getConquestSyncedNowMs() - event.createdAt > FATE_REVEAL_MS + 500) return;

    const eventId = event.id;
    setShownEvent(event);
    const t = window.setTimeout(() => {
      setShownEvent(cur => (cur && cur.id === eventId ? null : cur));
    }, FATE_REVEAL_MS);
    return () => window.clearTimeout(t);
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shownEvent) return null;

  return (
    <div
      className="cq-fate-reveal-backdrop"
      role="status"
      aria-live="polite"
      aria-label={`${shownEvent.playerName}, ${shownEvent.cardName} kartını çekti — ${shownEvent.description}`}
    >
      <div
        className="cq-fate-reveal-card"
        data-type={shownEvent.cardType}
      >
        <div className="cq-fate-reveal-icon" aria-hidden="true">🎴</div>
        <div className="cq-fate-reveal-eyebrow">
          {shownEvent.playerName} Kader Kartı çekti
        </div>
        <div className="cq-fate-reveal-name">{shownEvent.cardName}</div>
        <div className="cq-fate-reveal-tag" data-type={shownEvent.cardType}>
          {shownEvent.cardType === "good" ? "✨ İyi Kart" : "💀 Kötü Kart"}
        </div>
        <div className="cq-fate-reveal-desc">{shownEvent.description}</div>
      </div>
    </div>
  );
}
