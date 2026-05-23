/**
 * ConquestActionPanel — UI shown while a player holds the round's hamle.
 *
 * Responsibilities:
 *   - Announce whose action it is.
 *   - Tell the player what to do ("Bir bölgeye tıkla").
 *   - Offer a "Hamleyi Pas Geç" button.  When the player has no legal map
 *     move, this is the only action.
 *   - Surface the most recent illegal-click message when the parent flashes
 *     one (kept lightweight — proper toast system would come later).
 *
 * Action target selection itself happens on the board, not here.
 */

import { playSound } from "../../lib/sound";
import type {
  ConquestActionResult,
  ConquestPlayer,
  ConquestPlayerColor,
} from "./types";

interface Props {
  actionHolder:   ConquestPlayer | null;
  holderColor:    ConquestPlayerColor | null;
  /** True when the holder has zero legal capture/attack targets. */
  noMovesLeft:    boolean;
  /** Most recent failed action — used to flash the inline error line. */
  lastResult:     ConquestActionResult | null;
  onSkip:         () => void;
}

export default function ConquestActionPanel({
  actionHolder,
  holderColor,
  noMovesLeft,
  lastResult,
  onSkip,
}: Props) {
  function handleSkip() {
    playSound("click");
    onSkip();
  }

  const showError = lastResult && !lastResult.ok;

  if (!actionHolder) {
    return (
      <section className="cq-action-panel" aria-label="Hamle paneli">
        <p className="cq-action-line">Hamle bekleniyor…</p>
      </section>
    );
  }

  return (
    <section className="cq-action-panel" aria-label="Hamle paneli">
      <div className="cq-action-head">
        <span
          className="cq-action-holder-chip"
          data-color={holderColor ?? undefined}
        >
          <span className="cq-action-holder-dot" aria-hidden="true" />
          <span className="cq-action-holder-name">{actionHolder.name}</span>
          <span className="cq-action-holder-tag">Hamle hakkı</span>
        </span>

        {noMovesLeft ? (
          <p className="cq-action-hint" role="status">
            Yapılabilir hamle yok — turu pas geç.
          </p>
        ) : (
          <p className="cq-action-hint">
            Hamle yapmak için haritada bir bölgeye tıkla.
          </p>
        )}
      </div>

      {showError && (
        <p className="cq-action-error" role="alert">
          ⚠ {lastResult!.message}
        </p>
      )}

      <div className="cq-action-buttons">
        <button
          type="button"
          className={noMovesLeft ? "btn btn-accent cq-action-skip-btn" : "btn btn-ghost cq-action-skip-btn"}
          onClick={handleSkip}
        >
          {noMovesLeft ? "Turu Pas Geç" : "Hamleyi Pas Geç"}
        </button>
      </div>
    </section>
  );
}
