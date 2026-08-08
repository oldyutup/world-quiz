/**
 * RouteDuelResult.tsx — Rota Duel maç sonucu overlay'i (presentational).
 *
 * Arka planda son oyun ekranı görünmeye devam eder; bu overlay koyu + hafif
 * blur'lu katmanla üstüne biner (mevcut .wheel-result-backdrop reuse) ve
 * arka plan etkileşim almaz.
 *
 * Buton düzeni (görev spesifikasyonu):
 *   • Üstte TAM GENİŞLİK: Rövanş İste (4-durumlu — wheel modeli)
 *   • Altta YAN YANA: Hızlı Eşleş · Ana Menü
 *
 * Rövanş tamamen sunucu-otoriter TEK RPC: buradaki buton yalnız
 * route_duel_request_rematch tetikler; İKİNCİ ONAY geldiğinde yeni maç aynı
 * RPC'nin transaction'ında sunucuda başlar (skorlar sıfır, ayarlar aynı,
 * önceki rotalar dışlanmış). Host client'ının ayrıca bir process adımı
 * çağırması GEREKMEZ — host arka planda/kopuk olsa bile rövanş başlar.
 */
import {
  roundsLabel,
  routeLengthLabel,
  type RouteDuelRoom,
  type RouteDuelPlayer,
} from "../../lib/routeDuelShared";
import GuestEndPrompt from "../GuestEndPrompt";

interface Props {
  room: RouteDuelRoom;
  me: RouteDuelPlayer | undefined;
  opp: RouteDuelPlayer | undefined;
  myId: string;
  isLoggedIn: boolean;
  onRequestRematch: () => void;
  onQuickMatch: () => void;
  onHome: () => void;
}

export default function RouteDuelResult({
  room,
  me,
  opp,
  myId,
  isLoggedIn,
  onRequestRematch,
  onQuickMatch,
  onHome,
}: Props) {
  const myScore = me?.score ?? 0;
  const oppScore = opp?.score ?? 0;
  const winnerId = room.winner_player_id;
  const iWon = !!winnerId && winnerId === myId;

  const reasonText =
    room.finished_reason === "opponent_left"
      ? "Rakip maçtan ayrıldı."
      : room.finished_reason === "disconnect"
        ? "Rakip bağlantısını kaybetti."
        : room.current_round > room.total_rounds
          ? "Uzatma turu maçı belirledi."
          : "Tüm turlar tamamlandı.";

  /* Rövanş 4-durum (wheel modeli) */
  const rematchVotes = room.rematch_requested_by ?? [];
  const iVoted = rematchVotes.includes(myId);
  const oppVoted = rematchVotes.some(v => v !== myId);
  let rematchLabel: string;
  let rematchDisabled: boolean;
  let rematchClass = "wheel-primary-btn rd-result-rematch";
  if (iVoted && oppVoted) {
    rematchLabel = "↺ Rövanş hazırlanıyor...";
    rematchDisabled = true;
  } else if (iVoted) {
    rematchLabel = "✓ Rövanş istedin · Rakip bekleniyor (1/2)";
    rematchDisabled = true;
  } else if (oppVoted) {
    rematchLabel = "↺ Rakip rövanş istiyor · Kabul Et";
    rematchDisabled = false;
  } else {
    rematchLabel = "↺ Rövanş İste";
    rematchDisabled = false;
  }
  if (rematchDisabled) rematchClass += " is-waiting";

  return (
    <div className="wheel-result-backdrop rd-result-backdrop">
      <div className="wheel-result-panel rd-result-panel">
        <div className="wheel-result-emoji">{iWon ? "🏆" : "💀"}</div>
        <h2 className="wheel-result-title">{iWon ? "KAZANDIN!" : "KAYBETTİN"}</h2>
        <p className="duel-lobby-desc" style={{ margin: "0 0 4px", fontSize: "0.95rem" }}>
          {reasonText}
        </p>

        <div className="wd-result-scores">
          <div className={"wd-score" + (iWon ? " lead" : "")}>
            <span className="wd-score-name">{me?.name ?? "Sen"}</span>
            <span className="wd-score-val">{myScore}</span>
          </div>
          <span className="wd-score-sep">·</span>
          <div className={"wd-score" + (!iWon ? " lead" : "")}>
            <span className="wd-score-name">{opp?.name ?? "Rakip"}</span>
            <span className="wd-score-val">{oppScore}</span>
          </div>
        </div>

        <div className="wheel-result-rows">
          <div className="wheel-result-row">
            <span>Tur Sayısı</span>
            <strong>{roundsLabel(room.total_rounds)}</strong>
          </div>
          <div className="wheel-result-row">
            <span>Rota Uzunluğu</span>
            <strong>{routeLengthLabel(room.route_length)}</strong>
          </div>
          {room.current_round > room.total_rounds && (
            <div className="wheel-result-row">
              <span>Uzatma</span>
              <strong>{room.current_round - room.total_rounds} tur</strong>
            </div>
          )}
        </div>

        <div className="rd-result-actions">
          <button
            type="button"
            className={rematchClass}
            disabled={rematchDisabled}
            onClick={rematchDisabled ? undefined : onRequestRematch}
          >
            {rematchLabel}
          </button>

          <GuestEndPrompt visible={!isLoggedIn} />

          <div className="rd-result-actions-row">
            {isLoggedIn ? (
              <button type="button" className="wheel-ghost-btn" onClick={onQuickMatch}>
                ⚡ Hızlı Eşleş
              </button>
            ) : (
              <button
                type="button"
                className="wheel-ghost-btn"
                disabled
                title="Hızlı eşleş için giriş gerekli"
              >
                ⚡ Hızlı Eşleş
              </button>
            )}
            <button type="button" className="wheel-ghost-btn" onClick={onHome}>
              ⌂ Ana Menü
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
