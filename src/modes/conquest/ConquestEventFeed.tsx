/**
 * ConquestEventFeed — compact, append-from-top event log for Kuşatma.
 *
 * Pure presentational.  Rows are computed by useConquestEventFeed and
 * passed in.  Three visual variants share one row vocabulary:
 *
 *   • "war-log"        — desktop right-rail card titled "⚔ Savaş Günlüğü"
 *                        (last 6 events; always rendered so the rail keeps a
 *                        permanent anchor, with an inviting empty state)
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
  // Desktop war-room log: a persistent, titled rail card.  Renders even when
  // empty (inviting placeholder) so the right rail always has an anchor and
  // never reads as unowned space.  Height is bounded in CSS; on short desktop
  // viewports it collapses to a single-row "peek" (see App.css).
  if (variant === "war-log") {
    const visible = events.slice(0, 6);
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
          {visible.length === 0 ? (
            <p className="cq-war-log__empty">İlk hamleler burada belirecek.</p>
          ) : (
            visible.map(e => <FeedRow key={e.id} e={e} />)
          )}
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
