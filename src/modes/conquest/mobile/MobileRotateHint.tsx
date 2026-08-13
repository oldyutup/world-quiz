/**
 * MobileRotateHint — one-shot nudge that Kuşatma plays better in landscape.
 *
 * Deliberately NOT a blocking "please rotate your device" wall.  Portrait
 * gameplay stays fully playable, so a wall would be a lie about what the
 * player can do and would strand anyone with rotation locked at the OS
 * level.  This is a slim, self-dismissing strip: it states the benefit,
 * it can be tapped away, and it never comes back for the same match.
 *
 * Suppressed entirely on platforms where we already asked the OS for
 * landscape and got it (the hint would be nagging about something that
 * already happened) — the caller decides that via `visible`.
 */

import { useEffect, useState } from "react";

/** Long enough to read one short sentence, short enough not to linger over
 *  the board while the first question is running. */
const AUTO_DISMISS_MS = 7000;

interface Props {
  /** Caller gates on: mobile + portrait + gameplay actually running. */
  visible: boolean;
  /** Changes when a new match starts, so the hint may show once per match
   *  rather than once per mount. */
  matchKey: string;
}

export default function MobileRotateHint({ visible, matchKey }: Props) {
  const [dismissed, setDismissed] = useState(false);

  // A new match earns a fresh hint.
  useEffect(() => { setDismissed(false); }, [matchKey]);

  useEffect(() => {
    if (!visible || dismissed) return;
    const id = window.setTimeout(() => setDismissed(true), AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [visible, dismissed, matchKey]);

  if (!visible || dismissed) return null;

  return (
    <button
      type="button"
      className="mcq-rotate-hint"
      onClick={() => setDismissed(true)}
      aria-label="Telefonu yana çevir ipucunu kapat"
    >
      <span className="mcq-rotate-hint-glyph" aria-hidden="true">⟳</span>
      <span className="mcq-rotate-hint-text">
        Telefonu yana çevir — harita iki katına çıkar
      </span>
      <span className="mcq-rotate-hint-close" aria-hidden="true">✕</span>
    </button>
  );
}
