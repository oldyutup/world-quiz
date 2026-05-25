/**
 * MobileBottomSheet — fixed-bottom sheet for the Conquest mobile shell.
 *
 * Three visual states, controlled by the parent:
 *   "collapsed" : only the handle bar is visible (~62px + safe-area-bottom)
 *   "expanded"  : handle + body, max min(44dvh, 380px)
 *   "full"      : handle + body, max 70dvh — used by defense duel & finished
 *
 * The sheet is `position: fixed` over the viewport bottom.  The mobile
 * shell reserves the collapsed sheet's footprint at the bottom of the
 * map slot (`.mcq-map-slot { padding-bottom: ... }`), so the map's
 * content area never resizes when the sheet expands or collapses — the
 * sheet just overlays the bottom of the map.
 *
 * Dismissible behaviour: when `dismissible` is true and `state` is not
 * "full", a tap on the handle flips the effective state between the
 * parent-chosen `state` and "collapsed".  When `phaseKey` changes (i.e.
 * a new game phase begins) the internal toggle resets so every phase
 * starts in its parent-chosen default.  No drag gestures yet — that's a
 * polish-pass concern, separate from the layout problem this component
 * solves.
 *
 * The sheet has no opinion on what goes inside `handle` or `children` —
 * ConquestGame derives both from the current phase and reuses the same
 * `ConquestChallengePanel` / `ConquestActionPanel` / `DefenseDuelPanel`
 * components the desktop shell uses.  See `.mcq-sheet-body` CSS for the
 * reset that flattens the legacy panel chrome inside the sheet.
 */

import { useEffect, useState, type ReactNode } from "react";
import { playSound } from "../../../lib/sound";

export type MobileBottomSheetState = "collapsed" | "expanded" | "full";

interface Props {
  /** Identifier for the current phase; the sheet resets its internal
   *  user-toggle whenever this changes so each phase starts at the
   *  parent-chosen default. */
  phaseKey:    string;
  /** Default visual state for the current phase. */
  state:       MobileBottomSheetState;
  /** When true the user can tap the handle to flip collapsed/expanded.
   *  Ignored when `state` is "full". */
  dismissible: boolean;
  /** Always-visible handle content (status text, timer, etc.). */
  handle:      ReactNode;
  /** Body content, rendered when effective state is not "collapsed". */
  children:    ReactNode;
  /** When false, the sheet is not rendered at all (e.g. during a
   *  center-screen hidden-op toast). */
  visible?:    boolean;
}

export default function MobileBottomSheet({
  phaseKey,
  state,
  dismissible,
  handle,
  children,
  visible = true,
}: Props) {
  // `userCollapsed` only flips when the user taps the handle.  It is
  // reset on every phase change so the parent's default `state` always
  // wins at the start of a new phase.
  const [userCollapsed, setUserCollapsed] = useState(false);

  useEffect(() => {
    setUserCollapsed(false);
  }, [phaseKey]);

  // "full" overrides everything: defense-duel / finished must be visible
  // even if the user previously collapsed the round_result sheet.
  const effective: MobileBottomSheetState = state === "full"
    ? "full"
    : userCollapsed
      ? "collapsed"
      : state;

  if (!visible) return null;

  const canToggle = dismissible && state !== "full";

  function handleTap() {
    if (!canToggle) return;
    playSound("click");
    setUserCollapsed(v => !v);
  }

  return (
    <div
      className="mcq-sheet"
      data-state={effective}
      data-dismissible={canToggle ? "true" : "false"}
      role="region"
      aria-label="Tur paneli"
    >
      <button
        type="button"
        className="mcq-sheet-handle"
        onClick={handleTap}
        disabled={!canToggle}
        aria-expanded={effective !== "collapsed"}
        aria-label={canToggle
          ? (effective === "collapsed" ? "Paneli aç" : "Paneli kapat")
          : undefined}
      >
        <span className="mcq-sheet-handle-grip" aria-hidden="true" />
        <span className="mcq-sheet-handle-content">{handle}</span>
        {canToggle && (
          <span
            className="mcq-sheet-handle-chevron"
            aria-hidden="true"
            data-expanded={effective !== "collapsed" ? "true" : "false"}
          >
            ⌄
          </span>
        )}
      </button>
      {effective !== "collapsed" && (
        <div className="mcq-sheet-body">{children}</div>
      )}
    </div>
  );
}
