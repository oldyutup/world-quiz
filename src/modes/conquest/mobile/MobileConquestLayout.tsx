/**
 * MobileConquestLayout — CSS Grid shell that owns the mobile Conquest HUD.
 *
 * Step 7 brings a real landscape grid: portrait is unchanged (header /
 * score strip / map / fixed-bottom sheet), but landscape now ships a
 * two-column grid where the right column is a docked command panel
 * (players + phase content) — no more `position: fixed` floating card.
 *
 *   PORTRAIT:                       LANDSCAPE:
 *   ┌───────────────────┐           ┌──────────────────┬───────┐
 *   │ header            │           │ header                  │
 *   ├───────────────────┤           ├──────────────────┬───────┤
 *   │ score strip       │           │                  │ vert. │
 *   ├───────────────────┤           │      map         │ score │
 *   │                   │           │                  │ + dock│
 *   │      map          │           │                  │ panel │
 *   │                   │           └──────────────────┴───────┘
 *   ├ bottom sheet ─────┤
 *   └───────────────────┘
 *
 * Why two render branches?  The DOM topology differs: in portrait the
 * sheet is a fixed-position sibling of the shell; in landscape the
 * dock is an in-grid `<aside>` so the map column naturally shrinks
 * to make room (no map-on-top-of-dock overlap).  Trying to express
 * both with a single CSS-Grid + display: contents trick fights the
 * landscape goal of "real dock, not floating overlay."
 *
 * Why slot props rather than children?  ConquestGame already owns
 * gameplay state and callbacks; passing slot nodes lets us reuse the
 * same React elements between the desktop and mobile branches without
 * lifting state.  The phase panel that ends up inside the landscape
 * dock is the *same* React subtree the portrait sheet renders.
 */

import type { ReactNode } from "react";

interface Props {
  /** "portrait" or "landscape" — drives both the grid template via the
   *  `mcq-shell--*` modifier class and which sub-tree this component
   *  renders (the landscape branch hoists the score strip and adds a
   *  dock slot). */
  orientation: "portrait" | "landscape";
  /** Top bar slot (back button, round badge). */
  header:      ReactNode;
  /** Compact horizontal score row that replaces the desktop overlay panel.
   *  In landscape this same node is rendered *inside* the dock and
   *  styled vertically via CSS. */
  scoreStrip:  ReactNode;
  /** Optional bonus chip strip (portrait only).  Renders between the
   *  score strip and the map; collapses cleanly when undefined so
   *  legacy callers stay byte-identical. */
  bonusStrip?: ReactNode;
  /** Main interactive map.  Rendered inside `.mcq-map-slot`; the slot
   *  performs the centering / sizing so we can drop the legacy
   *  `transform: scale(...)` patches. */
  map:         ReactNode;
  /** Landscape-only command panel body (phase content).  Ignored in
   *  portrait — the portrait sheet receives this content via the
   *  `overlays` slot instead. */
  dock?:       ReactNode;
  /** Floating elements (toasts, portrait bottom sheet).  Rendered as a
   *  sibling of the shell so `position: fixed` continues to work. */
  overlays:    ReactNode;
}

export default function MobileConquestLayout({
  orientation,
  header,
  scoreStrip,
  bonusStrip,
  map,
  dock,
  overlays,
}: Props) {
  if (orientation === "landscape") {
    return (
      <>
        <div
          className="mcq-shell mcq-shell--landscape"
          data-orientation="landscape"
        >
          <div className="mcq-header-slot">{header}</div>
          <div className="mcq-map-slot">{map}</div>
          <aside className="mcq-dock-slot" aria-label="Komut paneli">
            <div className="mcq-dock-players">{scoreStrip}</div>
            <div className="mcq-dock-body">{dock}</div>
          </aside>
        </div>
        {overlays}
      </>
    );
  }

  return (
    <>
      <div
        className="mcq-shell mcq-shell--portrait"
        data-orientation="portrait"
      >
        <div className="mcq-header-slot">{header}</div>
        <div className="mcq-strip-slot">{scoreStrip}</div>
        {bonusStrip ? (
          <div className="mcq-bonus-slot">{bonusStrip}</div>
        ) : null}
        <div className="mcq-map-slot">{map}</div>
      </div>
      {overlays}
    </>
  );
}
