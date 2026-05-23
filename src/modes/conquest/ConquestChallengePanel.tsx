/**
 * ConquestChallengePanel — Phase 9A real-challenge UI.
 *
 * Renders the active challenge for *every* player (no longer host-only) and
 * collects answer submissions.  Branches on `challenge.type`:
 *
 *   quiz       — prompt + choice buttons (when `choices` set) or text input
 *   type_race  — prompt + text input
 *   flag_guess — large flag glyph + text input
 *
 * Validation lives in conquestChallengeValidation; this panel only knows
 * "submit raw text to parent, parent reports back correct / wrong".
 *
 * One-answer-per-player is enforced client-locally (parent passes
 * `alreadyAnswered`) — a wrong submission disables further input on the
 * losing client without touching the synced state.  See ConquestGame for
 * why we keep this off the wire.
 *
 * Resolved / skipped states render a static summary line; the parent panel
 * shell already wraps everything with the correct status chip.
 */

import { useEffect, useRef, useState } from "react";
import { playSound } from "../../lib/sound";
import { CONQUEST_CHALLENGE_META } from "./conquestChallenges";
import type {
  ConquestChallengeState,
  ConquestPlayer,
  ConquestPlayerColor,
} from "./types";

interface Props {
  challengeState:  ConquestChallengeState;
  players:         ConquestPlayer[];
  playerColors:    Record<string, ConquestPlayerColor>;
  /** Local viewer id — used to decide if submission is allowed. */
  myPlayerId:      string | null;
  /** True if this client already submitted (correct OR wrong) for this challenge. */
  alreadyAnswered: boolean;
  /** Last local submission result (for "Yanlış cevap." feedback after a miss). */
  lastLocalFeedback: "correct" | "wrong" | null;
  /** Live ms remaining, supplied by the parent so the countdown ticks every frame. */
  msRemaining:     number;
  /** Fired with the raw text the user typed/clicked.  Parent validates. */
  onSubmitAnswer:  (rawAnswer: string) => void;
}

export default function ConquestChallengePanel({
  challengeState,
  players,
  playerColors,
  myPlayerId,
  alreadyAnswered,
  lastLocalFeedback,
  msRemaining,
  onSubmitAnswer,
}: Props) {
  const { challenge, status, winnerPlayerId, endsAt, startedAt } = challengeState;
  const meta     = CONQUEST_CHALLENGE_META[challenge.type];
  const isActive = status === "active";

  const isEligible = !!myPlayerId
    && challenge.eligiblePlayerIds.includes(myPlayerId);
  const canSubmit  = isActive && isEligible && !alreadyAnswered && msRemaining > 0;

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset local draft whenever the challenge id changes (new round).
  useEffect(() => {
    setDraft("");
    // Auto-focus the text input on mount for typing flows.
    if (challenge.type !== "quiz" || !challenge.choices) {
      // setTimeout 0 to wait for input to be in the DOM.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [challenge.id, challenge.type, challenge.choices]);

  const winnerName = winnerPlayerId
    ? players.find(p => p.id === winnerPlayerId)?.name ?? "Oyuncu"
    : null;

  const secondsLeft = Math.max(0, Math.ceil(msRemaining / 1000));
  const totalSeconds = Math.max(1, Math.round((endsAt - startedAt) / 1000));
  const pct = Math.max(0, Math.min(100, (msRemaining / (endsAt - startedAt)) * 100));

  function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!canSubmit) return;
    playSound("click");
    onSubmitAnswer(trimmed);
  }

  function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(draft);
  }

  function handleChoice(choice: string) {
    submit(choice);
  }

  // ── Sub-renderers ────────────────────────────────────────────────────
  const showChoices = challenge.type === "quiz" && Array.isArray(challenge.choices)
    && challenge.choices.length > 0;

  return (
    <section
      className="cq-challenge-panel"
      data-status={status}
      aria-label="Mücadele paneli"
    >
      <header className="cq-challenge-head">
        <span className="cq-challenge-type-chip" aria-hidden="true">
          {meta.icon} {meta.label}
        </span>
        <span className="cq-challenge-status-chip" data-status={status}>
          {status === "active"   && `Süre: ${secondsLeft}s`}
          {status === "resolved" && (winnerName ? `Kazanan: ${winnerName}` : "Tamamlandı")}
          {status === "skipped"  && "Süre bitti"}
        </span>
      </header>

      <h3 className="cq-challenge-title">{challenge.title}</h3>

      {challenge.type === "flag_guess" && challenge.flag && (
        <div className="cq-challenge-flag" aria-label="Bayrak">
          {challenge.flag}
        </div>
      )}

      {challenge.prompt && (
        <p className="cq-challenge-prompt">{challenge.prompt}</p>
      )}

      {/* Countdown bar — only while active */}
      {isActive && (
        <div
          className="cq-challenge-timer"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={totalSeconds}
          aria-valuenow={secondsLeft}
          aria-label="Kalan süre"
        >
          <div
            className="cq-challenge-timer-fill"
            style={{ width: `${pct}%` }}
            data-low={secondsLeft <= 5 ? "true" : undefined}
          />
        </div>
      )}

      {/* Quiz with choices → button grid */}
      {isActive && showChoices && (
        <div
          className="cq-challenge-choice-grid"
          role="group"
          aria-label="Cevap seçenekleri"
        >
          {challenge.choices!.map(choice => (
            <button
              key={choice}
              type="button"
              className="cq-challenge-choice-btn"
              disabled={!canSubmit}
              onClick={() => handleChoice(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      {/* Free-text submission */}
      {isActive && !showChoices && (
        <form
          className="cq-challenge-answer-form"
          onSubmit={handleTextSubmit}
        >
          <input
            ref={inputRef}
            type="text"
            className="cq-challenge-answer-input"
            placeholder={
              challenge.type === "flag_guess"
                ? "Ülke adını yaz…"
                : "Cevabını yaz…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!canSubmit}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={64}
            aria-label="Cevap"
          />
          <button
            type="submit"
            className="btn btn-accent cq-challenge-submit-btn"
            disabled={!canSubmit || draft.trim().length === 0}
          >
            Gönder
          </button>
        </form>
      )}

      {/* Local feedback after a submission */}
      {isActive && lastLocalFeedback === "wrong" && (
        <p className="cq-challenge-feedback cq-challenge-feedback--wrong" role="status">
          ❌ Yanlış cevap. Bu tur tekrar deneyemezsin.
        </p>
      )}
      {isActive && lastLocalFeedback === "correct" && (
        <p className="cq-challenge-feedback cq-challenge-feedback--right" role="status">
          ✅ Doğru! Hamle hakkı senin.
        </p>
      )}
      {isActive && !lastLocalFeedback && alreadyAnswered && (
        <p className="cq-challenge-feedback" role="status">
          ⏳ Cevabını gönderdin — diğer oyuncuları bekle.
        </p>
      )}
      {isActive && !isEligible && (
        <p className="cq-challenge-feedback" role="status">
          👀 Bu tur izleyicisin.
        </p>
      )}

      {/* Resolved (winner picked) */}
      {status === "resolved" && winnerName && (
        <p className="cq-challenge-resolved-line" role="status">
          🏆{" "}
          <span
            className="cq-challenge-winner-tag"
            data-color={winnerPlayerId ? playerColors[winnerPlayerId] : undefined}
          >
            <span className="cq-challenge-winner-dot" aria-hidden="true" />
            <strong>{winnerName}</strong>
          </span>{" "}
          doğru cevap verdi ve hamle hakkı kazandı.
        </p>
      )}

      {/* Expired with no winner */}
      {status === "skipped" && (
        <p className="cq-challenge-resolved-line" role="status">
          ⏰ Süre bitti. Kimse doğru cevap veremedi.
        </p>
      )}
    </section>
  );
}
