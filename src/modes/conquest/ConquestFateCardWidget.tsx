/**
 * ConquestFateCardWidget — Kader Kartı V1 draw surface.
 *
 * Always-on widget that lives at the bottom of the players panel.  Renders
 * one of four states so the player never loses sight of the affordance:
 *   - active:       it's the viewer's action phase, they haven't drawn yet,
 *                   and they have enough Gold to pay the cost.
 *   - waiting:      the viewer is in the match but it isn't their turn /
 *                   they haven't earned the action right yet.
 *   - insufficient: it IS their turn and they haven't drawn yet, but they
 *                   don't have enough Gold to cover `cost`.
 *   - used:         the viewer has already drawn this match.
 *
 * The parent decides whether the widget renders at all via `visible`
 * (false outside an active match or for spectators).  `onDraw` is the only
 * side effect; `disabled` lets the parent lock the button while a network
 * write is in flight (double-click protection).  `spending` flips the
 * button into a loading label while the Gold spend RPC is awaited.
 */

import { playSound } from "../../lib/sound";

type Mode = "active" | "waiting" | "used" | "insufficient";

interface Props {
  mode:     Mode;
  /** When false the widget renders nothing — lobby/setup/finished or
   *  spectator. */
  visible:  boolean;
  /** Disable the button during an in-flight write to prevent two draws in a
   *  single click burst. */
  disabled: boolean;
  /** Gold cost displayed on the button/help text. */
  cost:     number;
  /** True while the spend RPC is awaited; renders a loading label and
   *  forces the button into a disabled state. */
  spending?: boolean;
  variant?: "desktop" | "mobile";
  onDraw:   () => void;
}

export default function ConquestFateCardWidget({
  mode,
  visible,
  disabled,
  cost,
  spending = false,
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

  const isActive       = mode === "active";
  const isInsufficient = mode === "insufficient";
  const buttonDisabled = !isActive || disabled || spending;

  const label = spending
    ? "Kart çekiliyor..."
    : isActive
      ? `Kader Kartı ${cost}g`
      : isInsufficient
        ? `Yetersiz Gold ${cost}g`
        : "Sıranı Bekle";

  const ariaLabel = spending
    ? "Kart çekiliyor"
    : isActive
      ? `Kader Kartı çek, ${cost} Gold`
      : isInsufficient
        ? `Yetersiz Gold. Bu işlem ${cost} Gold gerektiriyor.`
        : "Sıranı bekle";

  const title = spending
    ? "Gold harcaması sürüyor..."
    : isActive
      ? `Bu maçta yalnızca bir kez Kader Kartı çekebilirsin. ${cost} Gold harcar.`
      : isInsufficient
        ? `Bu işlem ${cost} Gold gerektiriyor.`
        : "Sıran geldiğinde Kader Kartı çekebilirsin.";

  const help = isActive
    ? `Sıra sendeyken maçta 1 kez kullanılır. ${cost} Gold harcar. %50 iyi, %50 kötü etki verir.`
    : isInsufficient
      ? `Kader Kartı çekmek için ${cost} Gold gerekli.`
      : "Doğru cevap verip hamle hakkı aldığında Kader Kartı çekebilirsin.";

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
        aria-label={ariaLabel}
        aria-busy={spending || undefined}
        title={title}
      >
        <span className="cq-fate-card-widget-icon" aria-hidden="true">🎴</span>
        <span className="cq-fate-card-widget-text">{label}</span>
      </button>
      <p className="cq-fate-card-widget-help">{help}</p>
    </div>
  );
}
