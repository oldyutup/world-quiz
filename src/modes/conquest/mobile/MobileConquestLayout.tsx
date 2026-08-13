/**
 * MobileConquestLayout — CSS Grid shell that owns the mobile Conquest HUD.
 *
 * Portrait keeps the header / score strip / map / fixed-bottom-sheet stack.
 * Landscape is map-first: the board is the primary surface and every control
 * either floats over the board's letterbox or lives in a dock that only
 * exists while a phase actually needs one.
 *
 *   PORTRAIT:                       LANDSCAPE (dockMode="panel"):
 *   ┌───────────────────┐           ┌─────────────────────────┬────────┐
 *   │ header            │           │ header                           │
 *   ├───────────────────┤           ├─────────────────────────┬────────┤
 *   │ score strip       │           │ ▪roster ▪jokers         │ phase  │
 *   ├───────────────────┤           │        MAP              │ panel  │
 *   │                   │           │                         │        │
 *   │      map          │           └─────────────────────────┴────────┘
 *   │                   │
 *   ├ bottom sheet ─────┤           LANDSCAPE (dockMode="compact"):
 *   └───────────────────┘           ┌──────────────────────────────────┐
 *                                   │ header                           │
 *                                   ├──────────────────────────────────┤
 *                                   │ ▪roster ▪jokers                  │
 *                                   │            MAP (full width)      │
 *                                   │                    ▪float card   │
 *                                   └──────────────────────────────────┘
 *
 * ── Why the dock is phase-adaptive ───────────────────────────────────────
 * In landscape the map is *width*-limited: the board's aspect (~2.2:1) is
 * wider than the slot, so surplus height is already being letterboxed away
 * and only the column width changes how big the map renders.  A permanent
 * side dock is therefore a permanent tax on the board.  During the question
 * phase that tax buys something real (a readable question with tappable
 * answers).  During the move phase it buys nothing — the player is looking
 * at the map — so the dock collapses and the few move controls float over
 * the board instead.  Measured on a 844×390 viewport, collapsing the dock
 * takes the rendered board from 608×272 to 844×377.
 *
 * ── Why the roster and joker rail float ──────────────────────────────────
 * They sit in the letterbox band the map cannot use anyway, so they cost
 * zero board area at the default zoom. They do overlap the board once the
 * player zooms in, which is the accepted trade in every map game: glass
 * chrome over the board, dismissible by the fit-to-screen control.
 *
 * ── Why slot props rather than children ──────────────────────────────────
 * ConquestGame already owns gameplay state and callbacks; passing slot nodes
 * lets us reuse the same React elements between the desktop and mobile
 * branches without lifting state.  The phase panel inside the landscape dock
 * is the *same* React subtree the portrait sheet renders.
 */

import type { ReactNode } from "react";

export type MobileDockMode = "panel" | "compact";

interface Props {
  /** "portrait" or "landscape" — drives both the grid template via the
   *  `mcq-shell--*` modifier class and which sub-tree this component
   *  renders. */
  orientation: "portrait" | "landscape";
  /** Landscape only. "panel" gives the phase content a real side column;
   *  "compact" removes the column so the map spans the full width and the
   *  phase content is expected to arrive through `floating` instead.
   *  Ignored in portrait. */
  dockMode?:   MobileDockMode;
  /** Top bar slot (back button, round badge, utility controls). */
  header:      ReactNode;
  /** Compact score row. In portrait it is a grid row under the header; in
   *  landscape it floats over the top of the board. */
  scoreStrip:  ReactNode;
  /** Optional bonus chip strip (portrait only). Renders between the score
   *  strip and the map; collapses cleanly when undefined. */
  bonusStrip?: ReactNode;
  /** Landscape only. The local player's active bonuses, floated against the
   *  board's left edge so "I hold a joker" is legible without opening
   *  anything. Ignored in portrait. */
  jokerRail?:  ReactNode;
  /** Main interactive map. Rendered inside `.mcq-map-slot`; the slot
   *  performs the centering / sizing. */
  map:         ReactNode;
  /** Landscape `dockMode="panel"` only — side column body (phase content). */
  dock?:       ReactNode;
  /** Landscape `dockMode="compact"` only — small card floated over the
   *  board's bottom-right corner. */
  floating?:   ReactNode;
  /** Portrait only — a transient note (e.g. the rotate hint) parked in the
   *  dead band under the board, so it never covers the board itself nor
   *  the question sheet. */
  boardNote?:  ReactNode;
  /** Floating elements (toasts, portrait bottom sheet). Rendered as a
   *  sibling of the shell so `position: fixed` continues to work. */
  overlays:    ReactNode;
}

export default function MobileConquestLayout({
  orientation,
  dockMode = "panel",
  header,
  scoreStrip,
  bonusStrip,
  jokerRail,
  map,
  dock,
  floating,
  boardNote,
  overlays,
}: Props) {
  if (orientation === "landscape") {
    const showDock = dockMode === "panel";
    return (
      <>
        <div
          className={`mcq-shell mcq-shell--landscape mcq-shell--dock-${dockMode}`}
          data-orientation="landscape"
          data-dock={dockMode}
        >
          <div className="mcq-header-slot">{header}</div>
          <div className="mcq-map-slot">
            {map}
            <div className="mcq-board-overlays">
              <div className="mcq-roster-float">{scoreStrip}</div>
              {/* One bottom bar, not two floating cards. An action card
                  pinned to the board's right corner covered a quarter of
                  the east — exactly the regions the player has to tap
                  during the move phase. Laid out as a single strip along
                  the bottom letterbox it costs a thin band instead. */}
              {(jokerRail || (!showDock && floating)) ? (
                <div className="mcq-bottom-bar">
                  {jokerRail ? (
                    <div className="mcq-joker-float">{jokerRail}</div>
                  ) : null}
                  {!showDock && floating ? (
                    <div className="mcq-phase-float">{floating}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          {showDock ? (
            <aside className="mcq-dock-slot" aria-label="Komut paneli">
              <div className="mcq-dock-body">{dock}</div>
            </aside>
          ) : null}
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
        <div className="mcq-map-slot">
          {map}
          {/* Portrait cannot make the board bigger — a 2.05:1 map inside a
              0.46:1 viewport is width-limited by geometry, so ~220px below
              the board is dead either way. The joker row is parked there
              rather than claiming a fifth chrome band above the board. */}
          {jokerRail ? (
            <div className="mcq-joker-portrait">{jokerRail}</div>
          ) : null}
          {boardNote ? (
            <div className="mcq-board-note">{boardNote}</div>
          ) : null}
        </div>
      </div>
      {overlays}
    </>
  );
}
