/**
 * MobileToastSlot — single positioned region for mobile Conquest toasts.
 *
 * The desktop Conquest screen renders every active toast simultaneously
 * via `position: fixed` (see ConquestGame's `toastsNode`).  On phones
 * that approach hurts: bonus, hidden-op, duel-result, duel-intro and
 * duel-countdown can all activate in overlapping windows and stack on
 * top of each other (and on top of the sheet/dock).
 *
 * This component owns the *render layer* only — gameplay state and
 * toast-creation logic in ConquestGame stay exactly as they were.
 * The slot:
 *
 *   1. Accepts a `specs` list derived each render from the underlying
 *      toast state (parent passes whichever toasts are currently
 *      "supposed to show").
 *   2. Picks ONE — the highest-priority active spec — and renders it
 *      inside `.mcq-toast-slot`.  When the head spec disappears (its
 *      source state turned off), the next-highest active spec takes
 *      over automatically.  Effectively a priority queue where the
 *      underlying state owns each entry's lifetime.
 *   3. Keys the rendered toast by `spec.id`, so React re-mounts on
 *      change and CSS keyframe animation fires fresh.  Stable IDs
 *      (`bonus:<id>`, `hidden-op:<title>`, `duel-intro:<duelId>`, …)
 *      prevent re-mount during the same toast's lifetime.
 *
 * Same-priority ties are broken in `specs` array order — which equals
 * the order the parent computed them, which equals the rough order
 * they became active.  That matches user-facing "FIFO" intent without
 * the timing complications of a literal queue (the time-locked
 * duel-intro and duel-countdown specs would otherwise miss their
 * window if queued behind a 4.5s bonus toast).
 *
 * Positioning lives in CSS so portrait (top of map zone, below header
 * + score strip) and landscape (centre of map column, clear of right
 * dock) can be expressed declaratively.  See `.mcq-toast-slot` rules.
 */

import type { ReactNode } from "react";

export type MobileToastKind =
  | "bonus"
  | "hidden-op"
  | "duel-result"
  | "duel-intro"
  | "duel-countdown";

export interface MobileToastSpec {
  /** Stable key.  Convention: `<kind>:<source-id-or-title>`. */
  id:         string;
  /** Category, also forwarded as `data-kind` for CSS scoping. */
  kind:       MobileToastKind;
  /** Higher number wins when two specs are active simultaneously. */
  priority:   number;
  /** Classes applied to the toast body — keeps the existing
   *  `.cq-bonus-toast` / `.cq-duel-overlay-toast` visual chrome. */
  className:  string;
  /** Optional `data-color` (player palette) for bonus toasts. */
  dataColor?: string;
  /** Inner JSX (icon + text).  No positioning concerns. */
  content:    ReactNode;
  /** ARIA label for the live region (status announcement). */
  ariaLabel?: string;
}

interface Props {
  /** Currently active toast specs.  May be empty.  Order is preserved
   *  for same-priority tie-breaks. */
  specs: MobileToastSpec[];
}

export default function MobileToastSlot({ specs }: Props) {
  // Find highest-priority spec.  Linear scan keeps tie-break stable
  // (first encountered wins on ties), and the list is tiny (≤5).
  let active: MobileToastSpec | null = null;
  for (const spec of specs) {
    if (active === null || spec.priority > active.priority) {
      active = spec;
    }
  }

  if (!active) return null;

  return (
    <div
      className="mcq-toast-slot"
      data-kind={active.kind}
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        key={active.id}
        className={`mcq-toast ${active.className}`}
        data-color={active.dataColor ?? undefined}
        role="status"
        aria-label={active.ariaLabel}
      >
        {active.content}
      </div>
    </div>
  );
}
