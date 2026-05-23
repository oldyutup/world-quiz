/**
 * ConquestChallengePanel — UI for the round's current challenge.
 *
 * Phase-6 scope: only the placeholder challenge is implemented.  It renders
 * one "Kazananı seç: <player>" button per eligible player.  Clicking a
 * button calls onSelectWinner, which the parent (ConquestGame) routes
 * through resolveChallengeWithWinner.
 *
 * Future challenge types (quiz, map_click, type_race…) will branch on
 * `challenge.type` here without changing the parent's wiring.
 */

import { playSound } from "../../lib/sound";
import { CONQUEST_CHALLENGE_META } from "./conquestChallenges";
import type {
  ConquestChallengeState,
  ConquestPlayer,
  ConquestPlayerColor,
} from "./types";

interface Props {
  challengeState: ConquestChallengeState;
  players:        ConquestPlayer[];
  playerColors:   Record<string, ConquestPlayerColor>;
  /** Called when the (local) user selects a winner.  Caller validates. */
  onSelectWinner: (playerId: string) => void;
}

export default function ConquestChallengePanel({
  challengeState,
  players,
  playerColors,
  onSelectWinner,
}: Props) {
  const { challenge, status, winnerPlayerId } = challengeState;
  const meta    = CONQUEST_CHALLENGE_META[challenge.type];
  const isActive = status === "active";

  const eligiblePlayers = players.filter(
    p => challenge.eligiblePlayerIds.includes(p.id),
  );

  function handlePick(playerId: string) {
    if (!isActive) return;
    playSound("click");
    onSelectWinner(playerId);
  }

  const winnerName = winnerPlayerId
    ? players.find(p => p.id === winnerPlayerId)?.name ?? "Oyuncu"
    : null;

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
          {status === "active"   && "Mücadele başladı"}
          {status === "resolved" && (winnerName ? `Kazanan: ${winnerName}` : "Tamamlandı")}
          {status === "skipped"  && "Mücadele atlandı"}
        </span>
      </header>

      <h3 className="cq-challenge-title">{challenge.title}</h3>
      {challenge.prompt && (
        <p className="cq-challenge-prompt">{challenge.prompt}</p>
      )}

      {isActive && (
        <div
          className="cq-challenge-winner-grid"
          role="group"
          aria-label="Kazananı seç"
        >
          {eligiblePlayers.map(p => (
            <button
              key={p.id}
              type="button"
              className="cq-challenge-winner-btn"
              data-color={playerColors[p.id]}
              onClick={() => handlePick(p.id)}
            >
              <span className="cq-challenge-winner-dot" aria-hidden="true" />
              <span className="cq-challenge-winner-name">{p.name}</span>
              <span className="cq-challenge-winner-hint">Kazandı</span>
            </button>
          ))}
        </div>
      )}

      {!isActive && winnerName && (
        <p className="cq-challenge-resolved-line" role="status">
          🏆 <strong>{winnerName}</strong> mücadeleyi kazandı — hamle bekleniyor.
        </p>
      )}
    </section>
  );
}
