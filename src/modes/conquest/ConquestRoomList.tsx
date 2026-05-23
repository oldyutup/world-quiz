/**
 * ConquestRoomList — placeholder public room list for Kuşatma.
 *
 * Phase 2 ships with mock-empty state. The render path is future-ready:
 * once a backend wheel_group_rooms-style table lands, the `rooms` prop
 * (or a hook) drops in unchanged. Discovery is intentionally scoped to
 * Kuşatma rooms only (no global cross-mode list).
 *
 * Guest restriction (Kuşatma-only): guests see the list UI but cannot
 * join rooms or create new ones.
 */

import { playSound } from "../../lib/sound";
import { mapLabel } from "./types";
import type { ConquestRoomSummary } from "./types";

interface Props {
  rooms:      ConquestRoomSummary[];
  isLoggedIn: boolean;
  onBack:     () => void;
  onCreate:   () => void;
  onJoin:     (code: string) => void;
  onRefresh?: () => void;
}

export default function ConquestRoomList({
  rooms,
  isLoggedIn,
  onBack,
  onCreate,
  onJoin,
  onRefresh,
}: Props) {
  return (
    <div className="duel-lobby">
      <div className="duel-lobby-card cq-rooms-card">
        <div className="cq-rooms-head">
          <div>
            <h2 className="duel-lobby-title">🔎 Kuşatma Odaları</h2>
            <p className="duel-lobby-desc">
              Açık Kuşatma odalarını gör ve katıl.
            </p>
          </div>
          <div className="cq-rooms-head-actions">
            {onRefresh && (
              <button
                type="button"
                className="btn btn-ghost cq-refresh-btn"
                onClick={() => { playSound("click"); onRefresh(); }}
                title="Listeyi yenile"
              >
                ⟳ Yenile
              </button>
            )}
            <button
              type="button"
              className="btn btn-accent cq-create-cta"
              onClick={() => { playSound("click"); if (isLoggedIn) onCreate(); }}
              disabled={!isLoggedIn}
              title={!isLoggedIn ? "Oda kurmak için giriş yapmalısın" : undefined}
            >
              + Oda Kur
            </button>
          </div>
        </div>

        {!isLoggedIn && (
          <p className="duel-error" style={{ textAlign: "left", marginBottom: 4 }}>
            🔒 Açık Kuşatma odalarına katılmak için giriş yapmalısın.
          </p>
        )}

        {rooms.length === 0 ? (
          <div className="cq-rooms-empty" role="status">
            <div className="cq-rooms-empty-icon" aria-hidden>🛡️</div>
            <p className="cq-rooms-empty-title">
              Şu anda açık Kuşatma odası yok.
            </p>
            <p className="cq-rooms-empty-hint">
              {isLoggedIn
                ? "İlk odayı sen kur, davet linkini paylaş."
                : "Giriş yaparak oda kurabilirsin."}
            </p>
          </div>
        ) : (
          <ul className="cq-rooms-list">
            {rooms.map(r => (
              <li key={r.code} className="cq-room-card">
                <div className="cq-room-card-main">
                  <div className="cq-room-code">#{r.code}</div>
                  <div className="cq-room-meta">
                    <span className="cq-room-host">👑 {r.hostName}</span>
                    <span className="cq-room-map">🗺️ {mapLabel(r.settings.map)}</span>
                    <span className="cq-room-rounds">🔄 {r.settings.rounds} Tur</span>
                  </div>
                </div>
                <div className="cq-room-card-side">
                  <span className="cq-room-count">
                    {r.playerCount}/{r.settings.maxPlayers}
                  </span>
                  <span className={"cq-room-status cq-room-status--" + r.status}>
                    {r.status === "waiting" ? "Bekliyor" : r.status === "playing" ? "Oyunda" : "Bitti"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-accent cq-join-btn"
                    disabled={
                      !isLoggedIn ||
                      r.status !== "waiting" ||
                      r.playerCount >= r.settings.maxPlayers
                    }
                    title={!isLoggedIn ? "Katılmak için giriş yapmalısın" : undefined}
                    onClick={() => { playSound("click"); onJoin(r.code); }}
                  >
                    Katıl
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="btn btn-ghost cq-back-btn"
          onClick={() => { playSound("click"); onBack(); }}
        >
          ← Geri
        </button>
      </div>
    </div>
  );
}
