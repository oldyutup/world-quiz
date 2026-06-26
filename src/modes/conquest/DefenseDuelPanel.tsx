/**
 * DefenseDuelPanel — Savunma Düellosu UI.
 *
 * Renders the active 1-vs-1 duel between an attacker (action holder who hit
 * a bonus region) and a defender (the region's owner).  Reuses the same
 * challenge schema as the regular round, so the existing question types
 * (quiz / type_race / flag_guess) render identically.
 *
 * Gating:
 *   - Only attacker & defender may submit.
 *   - Everyone else sees the panel read-only with an "İzliyorsun" badge.
 *
 * Visual hierarchy is intentionally MVP — a single panel, header line with
 * the two participants, an 8-second countdown, question, answer controls.
 * No boxing-match animations yet; that's V2.
 */

import { useEffect, useRef, useState } from "react";
import { playSound } from "../../lib/sound";
import { CONQUEST_CHALLENGE_META } from "./conquestChallenges";
import { flagEmojiToCountryCode } from "./utils";
import type {
  ConquestDefenseDuelState,
  ConquestPlayer,
  ConquestPlayerColor,
} from "./types";

interface Props {
  duel:              ConquestDefenseDuelState;
  players:           ConquestPlayer[];
  playerColors:      Record<string, ConquestPlayerColor>;
  myPlayerId:        string | null;
  /** Region label resolved by the parent (uses mapConfig). */
  regionLabel:       string;
  /** True if THIS client already submitted (correct or wrong) for the duel. */
  alreadyAnswered:   boolean;
  lastLocalFeedback: "correct" | "wrong" | null;
  msRemaining:       number;
  /**
   * Viewer-aware deadline for the countdown.  Attackers see a clock capped
   * to the base duel window when the defender holds a time bonus (Mevzi
   * Bekçisi); defenders and spectators see the full extended deadline.
   * Falls back to `duel.endsAt` when absent (legacy/no-bonus path).
   */
  effectiveEndsAt?:  number;
  /**
   * Extra ms the defender gets vs. the attacker.  When > 0 the panel shows
   * the Mevzi Bekçisi chip explaining the asymmetric clock.
   */
  defenderTimeBonusMs?: number;
  /**
   * Koçbaşı 🪵 — true when the attacker is bypassing an active shield this
   * duel.  Drives the bypass chip in place of the standard "kalkan kırılır"
   * note (which would mislead — kocbasi wins flip ownership, not just break).
   */
  kocbasiBypass?:    boolean;
  onSubmitAnswer:    (rawAnswer: string) => void;
}

export default function DefenseDuelPanel({
  duel,
  players,
  playerColors,
  myPlayerId,
  regionLabel,
  alreadyAnswered,
  lastLocalFeedback,
  msRemaining,
  effectiveEndsAt,
  defenderTimeBonusMs,
  kocbasiBypass,
  onSubmitAnswer,
}: Props) {
  const { challenge, attackerId, defenderId, shieldActive, startedAt, endsAt } = duel;
  const meta = CONQUEST_CHALLENGE_META[challenge.type];

  const attacker = players.find(p => p.id === attackerId);
  const defender = players.find(p => p.id === defenderId);
  const attackerName = attacker?.name ?? "Saldıran";
  const defenderName = defender?.name ?? "Savunan";
  const attackerColor = playerColors[attackerId] ?? undefined;
  const defenderColor = playerColors[defenderId] ?? undefined;

  const isParticipant = !!myPlayerId && (myPlayerId === attackerId || myPlayerId === defenderId);
  const isActive  = duel.status === "active" && msRemaining > 0;
  const canSubmit = isActive && isParticipant && !alreadyAnswered;

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset draft + focus when the duel id changes (new duel).
  useEffect(() => {
    setDraft("");
    if (challenge.type !== "quiz" || !challenge.choices) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [duel.id, challenge.type, challenge.choices]);

  const secondsLeft  = Math.max(0, Math.ceil(msRemaining / 1000));
  const questionStart = duel.questionVisibleAt ?? startedAt;
  // Viewer-aware deadline: defaults to the duel's full `endsAt` (defender's
  // deadline) but attackers receive a capped value via `effectiveEndsAt`
  // when the defender holds a time bonus (Mevzi Bekçisi).  totalMs / pct
  // follow the viewer's clock so the progress bar tracks the displayed
  // `msRemaining`.
  const viewerEndsAt = effectiveEndsAt ?? endsAt;
  const totalMs      = Math.max(1, viewerEndsAt - questionStart);
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000));
  const pct          = Math.max(0, Math.min(100, (msRemaining / totalMs) * 100));
  const defenderBonusSec = Math.round((defenderTimeBonusMs ?? 0) / 1000);

  function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || !canSubmit) return;
    playSound("click");
    onSubmitAnswer(trimmed);
  }

  function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(draft);
  }

  const showChoices = challenge.type === "quiz"
    && Array.isArray(challenge.choices)
    && challenge.choices.length > 0;

  return (
    <section
      className={`cq-challenge-panel cq-duel-panel${challenge.type === "flag_guess" ? " cq-challenge-panel--flag" : ""}`}
      data-status={duel.status}
      aria-label="Savunma Düellosu"
    >
      <header className="cq-challenge-head">
        <span className="cq-challenge-type-chip" aria-hidden="true">
          ⚔️ Savunma Düellosu
        </span>
        <span className="cq-challenge-status-chip" data-status={duel.status}>
          {isActive ? `Süre: ${secondsLeft}s` : "Süre bitti"}
        </span>
      </header>

      <div className="cq-duel-versus" role="presentation">
        <span className="cq-duel-side cq-duel-side--attacker" data-color={attackerColor}>
          <span className="cq-duel-side-dot" aria-hidden="true" />
          <span className="cq-duel-side-label">Saldıran</span>
          <span className="cq-duel-side-name">{attackerName}</span>
        </span>
        <span className="cq-duel-vs" aria-hidden="true">VS</span>
        <span className="cq-duel-side cq-duel-side--defender" data-color={defenderColor}>
          <span className="cq-duel-side-dot" aria-hidden="true" />
          <span className="cq-duel-side-label">Savunan</span>
          <span className="cq-duel-side-name">{defenderName}</span>
        </span>
      </div>

      <p className="cq-duel-target" role="status">
        🎯 Hedef: <strong>{regionLabel}</strong>
        {shieldActive && (
          <span className="cq-duel-shield-note"> · 🛡️ Açık kalkan aktif (kazansan bile sadece kalkan kırılır)</span>
        )}
        {kocbasiBypass && (
          <span className="cq-duel-shield-note"> · 🪵 Koçbaşı: Kalkan aşılır</span>
        )}
      </p>

      {defenderBonusSec > 0 && (
        <p
          className="cq-duel-mevzi-chip"
          role="note"
          aria-label="Mevzi Bekçisi avantajı"
        >
          🏰 Mevzi Bekçisi: Savunmacıya +{defenderBonusSec} sn
        </p>
      )}

      <h3 className="cq-challenge-title">
        {meta.icon} {challenge.title}
      </h3>

      {challenge.type === "flag_guess" && challenge.flag && (
        <div className="cq-challenge-flag" aria-label="Bayrak">
          <FlagGlyph emoji={challenge.flag} />
        </div>
      )}

      {challenge.prompt && (
        <p className="cq-challenge-prompt">{challenge.prompt}</p>
      )}

      {isActive && (
        <div
          className="cq-challenge-timer"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={totalSeconds}
          aria-valuenow={secondsLeft}
          aria-label="Düello süresi"
        >
          <div
            className="cq-challenge-timer-fill"
            style={{ width: `${pct}%` }}
            data-low={secondsLeft <= 3 ? "true" : undefined}
          />
        </div>
      )}

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
              onClick={() => submit(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      {isActive && !showChoices && (
        <form className="cq-challenge-answer-form" onSubmit={handleTextSubmit}>
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

      {isActive && isParticipant && lastLocalFeedback === "wrong" && (
        <p className="cq-challenge-feedback cq-challenge-feedback--wrong" role="status">
          ❌ Yanlış cevap. Bu düelloda tekrar deneyemezsin.
        </p>
      )}
      {isActive && isParticipant && lastLocalFeedback === "correct" && (
        <p className="cq-challenge-feedback cq-challenge-feedback--right" role="status">
          ✅ Doğru!
        </p>
      )}
      {isActive && isParticipant && !lastLocalFeedback && alreadyAnswered && (
        <p className="cq-challenge-feedback" role="status">
          ⏳ Cevabını gönderdin — rakibini bekle.
        </p>
      )}
      {isActive && !isParticipant && (
        <p className="cq-challenge-feedback" role="status">
          👀 İzliyorsun — bu düelloya katılamazsın.
        </p>
      )}
    </section>
  );
}

/* Render a flag as an SVG asset when the emoji decodes to a 2-letter ISO
 * code, falling back to the raw emoji text otherwise.  Mirrors the helper
 * in ConquestChallengePanel; both panels share .cq-challenge-flag CSS so
 * the inline `height: 1em` keeps the asset sized by parent font-size. */
function FlagGlyph({ emoji }: { emoji: string }) {
  const [failed, setFailed] = useState(false);
  const code = flagEmojiToCountryCode(emoji);
  if (!code || failed) return <>{emoji}</>;
  return (
    <img
      src={`/assets/flags/${code}.svg`}
      alt={emoji}
      onError={() => setFailed(true)}
      style={{ height: "1em", width: "auto", verticalAlign: "middle", maxWidth: "100%" }}
    />
  );
}
