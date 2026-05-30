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
  /** Live ms remaining on the move-phase timer. Null disables the bar
   *  (e.g. legacy in-flight room without timer fields). */
  msRemaining:    number | null;
  /** Full duration of this move phase (used to scale the bar). Null disables. */
  totalMs:        number | null;
  /** Ankara: holder has an unspent Gizli Operasyon — show the placement hint. */
  hasPendingHiddenShield?: boolean;
  /** Mancınık: holder has an unspent uzak-saldırı charge — show the range hint. */
  hasMancinikCharge?: boolean;
  onSkip:         () => void;
}

export default function ConquestActionPanel({
  actionHolder,
  holderColor,
  noMovesLeft,
  lastResult,
  msRemaining,
  totalMs,
  hasPendingHiddenShield,
  hasMancinikCharge,
  onSkip,
}: Props) {
  const showTimer    = msRemaining !== null && totalMs !== null && totalMs > 0;
  const secondsLeft  = showTimer ? Math.max(0, Math.ceil(msRemaining! / 1000)) : 0;
  const timerPct     = showTimer
    ? Math.max(0, Math.min(100, (msRemaining! / totalMs!) * 100))
    : 0;
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
    <section
      className="cq-action-panel cq-action-panel--active"
      data-active="true"
      aria-label="Hamle paneli"
    >
      <div className="cq-action-head">
        <span
          className="cq-action-holder-chip cq-action-holder-chip--active"
          data-color={holderColor ?? undefined}
        >
          <span className="cq-action-holder-dot" aria-hidden="true" />
          <span className="cq-action-holder-name">{actionHolder.name}</span>
          <span className="cq-action-holder-tag">⚔ HAMLE SENDE</span>
        </span>

        {noMovesLeft ? (
          <p className="cq-action-hint" role="status">
            Yapılabilir hamle yok — turu pas geç.
          </p>
        ) : (
          <p className="cq-action-hint">
            {showTimer
              ? `Hamleni yap: ${secondsLeft}sn`
              : "Hamle yapmak için haritada bir bölgeye tıkla."}
          </p>
        )}
      </div>

      {showTimer && (
        <div
          className="cq-challenge-timer"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(totalMs! / 1000))}
          aria-valuenow={secondsLeft}
          aria-label="Hamle süresi"
        >
          <div
            className="cq-challenge-timer-fill"
            style={{ width: `${timerPct}%` }}
            data-low={secondsLeft <= 3 ? "true" : undefined}
          />
        </div>
      )}

      {showError && (
        <p className="cq-action-error" role="alert">
          ⚠ {lastResult!.message}
        </p>
      )}

      {hasPendingHiddenShield && (
        <p className="cq-action-hint cq-action-hint--bonus" role="status">
          🎭 Gizli Operasyon hazır — kendi bölgene tıklarsan gizli kalkan,
          tarafsız bir bölgeye tıklarsan gizli fetih kurulur.
        </p>
      )}

      {hasMancinikCharge && (
        <p className="cq-action-hint cq-action-hint--bonus" role="status">
          🎯 Mancınık hazır — bir sonraki saldırında komşuluk şartı olmadan
          haritadaki herhangi bir bölgeyi hedefleyebilirsin. Kale Surları'nı
          yok saymaz.
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
