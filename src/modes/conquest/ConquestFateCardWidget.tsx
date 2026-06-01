/**
 * ConquestFateCardWidget — Kader Kartı V1 draw surface.
 *
 * Always-on widget that lives at the bottom of the players panel.  Renders
 * one of three states so the player never loses sight of the affordance:
 *   - active:  it's the viewer's action phase and they haven't drawn yet
 *   - waiting: the viewer is in the match but it isn't their turn / they
 *              haven't earned the action right yet
 *   - used:    the viewer has already drawn this match
 *
 * The parent decides whether the widget renders at all via `visible`
 * (false outside an active match or for spectators).  `onDraw` is the only
 * side effect; `disabled` lets the parent lock the button while a network
 * write is in flight (double-click protection).
 */

import { playSound } from "../../lib/sound";

type Mode = "active" | "waiting" | "used";

interface Props {
  mode:     Mode;
  /** When false the widget renders nothing — lobby/setup/finished or
   *  spectator. */
  visible:  boolean;
  /** Disable the button during an in-flight write to prevent two draws in a
   *  single click burst. */
  disabled: boolean;
  variant?: "desktop" | "mobile";
  onDraw:   () => void;
}

export default function ConquestFateCardWidget({
  mode,
  visible,
  disabled,
  variant = "desktop",
  onDraw,
}: Props) {
  if (!visible) return null;

  const className =
    "cq-fate-card-widget"
    + ` cq-fate-card-widget--${mode}`
    + (variant === "mobile" ? " cq-fate-card-widget--mobile" : "");

  if (mode === "used") {
    return (
      <div
        className={className}
        data-state="used"
        role="status"
        aria-label="Kader Kartı kullanıldı"
      >
        <div className="cq-fate-card-widget-status">
          <span className="cq-fate-card-widget-icon" aria-hidden="true">🎴</span>
          <span className="cq-fate-card-widget-text">Kader Kartı kullanıldı</span>
        </div>
        <p className="cq-fate-card-widget-help">
          Bu maçta Kader Kartı hakkını kullandın.
        </p>
      </div>
    );
  }

  const isActive   = mode === "active";
  const buttonDisabled = !isActive || disabled;

  return (
    <div className={className} data-state={mode}>
      <button
        type="button"
        className="cq-fate-card-widget-btn"
        onClick={() => {
          if (buttonDisabled) return;
          playSound("click");
          onDraw();
        }}
        disabled={buttonDisabled}
        aria-label={isActive ? "Kader Kartı çek" : "Sıranı bekle"}
        title={
          isActive
            ? "Bu maçta yalnızca bir kez Kader Kartı çekebilirsin."
            : "Sıran geldiğinde Kader Kartı çekebilirsin."
        }
      >
        <span className="cq-fate-card-widget-icon" aria-hidden="true">🎴</span>
        <span className="cq-fate-card-widget-text">
          {isActive ? "Kader Kartı Çek" : "Sıranı Bekle"}
        </span>
      </button>
      <p className="cq-fate-card-widget-help">
        {isActive
          ? "Sıra sendeyken 1 kez kullanılır. %50 iyi, %50 kötü etki verir."
          : "Doğru cevap verip hamle hakkı aldığında Kader Kartı çekebilirsin."}
      </p>
    </div>
  );
}
