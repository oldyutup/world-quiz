/**
 * ConquestEventFeed — compact, append-from-top event log for Kuşatma.
 *
 * Pure presentational.  Rows are computed by useConquestEventFeed and
 * passed in.  Three visual variants share one row vocabulary:
 *
 *   • "war-log"        — desktop right-rail card titled "⚔ Savaş Günlüğü"
 *                        (last 3 events; renders ONLY when there is at least one
 *                        event so an empty match never shows a hollow card —
 *                        it stays out of the scene until the war actually starts)
 *   • "landscape-dock" — appended below the phase panel in the mobile dock
 *   • "portrait-peek"  — single-row floating chip above the bottom sheet
 *
 * No keyboard focus, no pointer interaction — feed is informational only.
 */

import type { ConquestEventFeedEntry } from "./useConquestEventFeed";

interface Props {
  events:  ConquestEventFeedEntry[];
  variant: "war-log" | "landscape-dock" | "portrait-peek";
}

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

export default function ConquestEventFeed({ events, variant }: Props) {
  // Desktop war-room log: a compact, titled rail card.  Renders ONLY when at
  // least one event exists — an empty match shows no card at all (no hollow
  // "boş kart" claiming the right rail).  Shows the 3 most recent events
  // (newest first); height auto-fits the rows and is capped in CSS.  Hidden
  // entirely on short desktops (see App.css) to give the map + deck priority.
  if (variant === "war-log") {
    if (events.length === 0) return null;
    const visible = events.slice(0, 3);
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
          {visible.map(e => <FeedRow key={e.id} e={e} />)}
        </div>
      </div>
    );
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
