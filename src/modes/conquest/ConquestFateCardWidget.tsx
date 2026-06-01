/**
 * ConquestFateCardWidget — Kader Kartı V1 draw button.
 *
 * Renders one of three states based on local viewer eligibility:
 *   - active: it's the viewer's action phase and they haven't drawn yet
 *   - used:   the viewer has already drawn this match
 *   - hidden: the viewer can't draw right now (other phase / not action holder)
 *
 * The component is purely presentational — `onDraw` is the only side effect
 * and a click-guard `disabled` flag is exposed for the parent to lock the
 * button while a network write is in flight (double-click protection).
 */

import { playSound } from "../../lib/sound";

type Mode = "active" | "used" | "waiting";

interface Props {
  mode:     Mode;
  /** Disable the button during an in-flight write to prevent two draws in a
   *  single click burst. */
  disabled: boolean;
  variant?: "desktop" | "mobile";
  onDraw:   () => void;
}

export default function ConquestFateCardWidget({
  mode,
  disabled,
  variant = "desktop",
  onDraw,
}: Props) {
  if (mode === "waiting") return null;

  const className =
    "cq-fate-card-widget"
    + (variant === "mobile" ? " cq-fate-card-widget--mobile" : "");

  if (mode === "used") {
    return (
      <div className={className} data-state="used" aria-label="Kader Kartı kullanıldı">
        <span className="cq-fate-card-widget-icon" aria-hidden="true">🎴</span>
        <span className="cq-fate-card-widget-text">Kader Kartı kullanıldı</span>
      </div>
    );
  }

  return (
    <div className={className} data-state="active">
      <button
        type="button"
        className="cq-fate-card-widget-btn"
        onClick={() => {
          if (disabled) return;
          playSound("click");
          onDraw();
        }}
        disabled={disabled}
        aria-label="Kader Kartı çek"
        title="Bu maçta yalnızca bir kez Kader Kartı çekebilirsin."
      >
        <span className="cq-fate-card-widget-icon" aria-hidden="true">🎴</span>
        <span className="cq-fate-card-widget-text">Kader Kartı Çek</span>
      </button>
    </div>
  );
}
