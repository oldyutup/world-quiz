/**
 * ConquestEventFeed — compact, append-from-top event log for Kuşatma.
 *
 * Pure presentational.  Rows are computed by useConquestEventFeed and
 * passed in.  Three visual variants share one row vocabulary:
 *
 *   • "war-log"        — desktop bottom-right TRANSIENT toast-log.  Surfaces
 *                        the 1–3 newest events when something happens, then
 *                        auto-dismisses; it is never a persistent panel and
 *                        stays out of the scene entirely while the match is
 *                        quiet (no hollow card claiming the right rail).
 *   • "landscape-dock" — appended below the phase panel in the mobile dock
 *   • "portrait-peek"  — single-row floating chip above the bottom sheet
 *
 * No keyboard focus, no pointer interaction — feed is informational only.
 */

import { useEffect, useState } from "react";
import type { ConquestEventFeedEntry } from "./useConquestEventFeed";

interface Props {
  events:  ConquestEventFeedEntry[];
  variant: "war-log" | "landscape-dock" | "portrait-peek";
}

/** How long the desktop war-log lingers after its newest event before it
 *  fades back out — long enough to read 1–3 lines, short enough to stay
 *  ephemeral rather than a fixed panel. */
const WAR_LOG_VISIBLE_MS = 6500;

function FeedRow({ e }: { e: ConquestEventFeedEntry }) {
  return (
    <div
      className={
        "cq-event-feed__row" + (e.isMine ? " cq-event-feed__row--mine" : "")
      }
      data-color={e.colorKey ?? undefined}
    >
      <span className="cq-event-feed__icon" aria-hidden="true">{e.icon}</span>
      <span className="cq-event-feed__text">{e.text}</span>
    </div>
  );
}

/**
 * Desktop transient war-log.  Re-appears whenever a fresh event reaches the
 * front of the feed (keyed on the newest id), then auto-hides after
 * WAR_LOG_VISIBLE_MS.  Self-contained so the other (mobile) variants stay
 * stateless and the desktop log never lingers as a permanent card.
 */
function TransientWarLog({ events }: { events: ConquestEventFeedEntry[] }) {
  const latestId = events[0]?.id ?? null;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!latestId) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), WAR_LOG_VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, [latestId]);

  if (!latestId || !visible) return null;
  const recent = events.slice(0, 3);
  return (
    <div
      className="cq-war-log"
      role="log"
      aria-live="polite"
      aria-label="Savaş günlüğü"
    >
      <div className="cq-war-log__head">
        <span className="cq-war-log__title">⚔ Savaş Günlüğü</span>
      </div>
      <div className="cq-war-log__body">
        {recent.map(e => <FeedRow key={e.id} e={e} />)}
      </div>
    </div>
  );
}

export default function ConquestEventFeed({ events, variant }: Props) {
  if (variant === "war-log") {
    return <TransientWarLog events={events} />;
  }

  if (events.length === 0) return null;
  const visible = variant === "portrait-peek" ? events.slice(0, 1) : events;

  return (
    <div
      className={`cq-event-feed cq-event-feed--${variant}`}
      role="log"
      aria-live="polite"
      aria-label="Olay akışı"
    >
      {visible.map(e => <FeedRow key={e.id} e={e} />)}
    </div>
  );
}
