/**
 * ConquestEventFeed — compact, append-from-top event log for Kuşatma.
 *
 * Pure presentational.  Rows are computed by useConquestEventFeed and
 * passed in.  Three visual variants share one tree:
 *
 *   • "desktop"        — bottom-right anchored floating column (last 6)
 *   • "landscape-dock" — appended below the phase panel in the mobile dock
 *   • "portrait-peek"  — single-row floating chip above the bottom sheet
 *
 * No keyboard focus, no pointer interaction — feed is informational only.
 */

import type { ConquestEventFeedEntry } from "./useConquestEventFeed";

interface Props {
  events:  ConquestEventFeedEntry[];
  variant: "desktop" | "landscape-dock" | "portrait-peek";
}

export default function ConquestEventFeed({ events, variant }: Props) {
  if (events.length === 0) return null;
  const visible = variant === "portrait-peek" ? events.slice(0, 1) : events;

  return (
    <div
      className={`cq-event-feed cq-event-feed--${variant}`}
      role="log"
      aria-live="polite"
      aria-label="Olay akışı"
    >
      {visible.map(e => (
        <div
          key={e.id}
          className={
            "cq-event-feed__row"
            + (e.isMine ? " cq-event-feed__row--mine" : "")
          }
          data-color={e.colorKey ?? undefined}
        >
          <span className="cq-event-feed__icon" aria-hidden="true">{e.icon}</span>
          <span className="cq-event-feed__text">{e.text}</span>
        </div>
      ))}
    </div>
  );
}
