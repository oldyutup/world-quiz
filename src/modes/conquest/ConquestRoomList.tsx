/**
 * ConquestRoomList — public room browser for Kuşatma.
 *
 * Phase 5: queries public.conquest_rooms via fetchPublicConquestRooms() and
 * renders one card per joinable room.  A manual "Yenile" button refreshes
 * on demand; we deliberately do NOT subscribe globally to keep the design
 * scalable across many small rooms.  Auto-refresh fires every 20 seconds
 * while the list is visible.
 *
 * Guest restriction (Kuşatma-only): guests cannot browse or join public
 * rooms.  They see the inline lock notice and the Katıl/Oda Kur buttons
 * are disabled.  Guests may still join via direct invite link.
 */

import { useCallback, useEffect, useState } from "react";
import { playSound } from "../../lib/sound";
import { mapLabel } from "./types";
import type { ConquestRoomStatus } from "./types";
import {
  fetchPublicConquestRooms,
  type ConquestPublicRoomSummary,
} from "./conquestService";

interface Props {
  isLoggedIn: boolean;
  onBack:     () => void;
  onCreate:   () => void;
  /** Called with the 6-char room_code when the user picks a card to join. */
  onJoin:     (code: string) => void;
}

/** How often (ms) to silently re-fetch the public room list while open. */
const AUTO_REFRESH_MS = 20_000;

function statusLabel(s: ConquestRoomStatus): string {
  if (s === "waiting")  return "Bekliyor";
  if (s === "playing")  return "Oyunda";
  return "Bitti";
}

export default function ConquestRoomList({
  isLoggedIn,
  onBack,
  onCreate,
  onJoin,
}: Props) {
  const [rooms,    setRooms]    = useState<ConquestPublicRoomSummary[]>([]);
  const [loading,  setLoading]  = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const next = await fetchPublicConquestRooms();
      setRooms(next);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Liste alınamadı.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh while mounted.
  useEffect(() => {
    if (!isLoggedIn) return;
    void refresh();
    const handle = window.setInterval(() => { void refresh(); }, AUTO_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [isLoggedIn, refresh]);

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
            <button
              type="button"
              className="btn btn-ghost cq-refresh-btn"
              onClick={() => { playSound("click"); void refresh(); }}
              disabled={loading || !isLoggedIn}
              title="Listeyi yenile"
            >
              {loading ? "⟳ Yükleniyor…" : "⟳ Yenile"}
            </button>
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

        {errorMsg && (
          <p className="duel-error" style={{ textAlign: "left", marginBottom: 4 }}>
            ⚠️ {errorMsg}
          </p>
        )}

        {isLoggedIn && rooms.length === 0 && !loading ? (
          <div className="cq-rooms-empty" role="status">
            <div className="cq-rooms-empty-icon" aria-hidden>🛡️</div>
            <p className="cq-rooms-empty-title">
              Şu anda açık Kuşatma odası yok.
            </p>
            <p className="cq-rooms-empty-hint">
              İlk odayı sen kur, davet linkini paylaş.
            </p>
          </div>
        ) : !isLoggedIn ? (
          <div className="cq-rooms-empty" role="status">
            <div className="cq-rooms-empty-icon" aria-hidden>🛡️</div>
            <p className="cq-rooms-empty-title">
              Giriş yaparak Kuşatma odalarına katılabilirsin.
            </p>
            <p className="cq-rooms-empty-hint">
              Davet linkin varsa misafir olarak da katılabilirsin.
            </p>
          </div>
        ) : (
          <ul className="cq-rooms-list">
            {rooms.map(({ room, playerCount }) => {
              const full   = playerCount >= room.max_players;
              const joinDisabled =
                !isLoggedIn ||
                room.status !== "waiting" ||
                full;

              return (
                <li key={room.id} className="cq-room-card">
                  <div className="cq-room-card-main">
                    <div className="cq-room-code">#{room.room_code}</div>
                    <div className="cq-room-meta">
                      <span className="cq-room-host">👑 {room.host_name}</span>
                      <span className="cq-room-map">
                        🗺️ {mapLabel(room.map_id as Parameters<typeof mapLabel>[0])}
                      </span>
                      <span className="cq-room-rounds">🔄 {room.round_count} Tur</span>
                      {room.team_mode === "teams_2v2" && (
                        <span className="cq-room-team-tag" title="2v2 Takımlı mod">
                          🛡️ 2v2 Takımlı
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="cq-room-card-side">
                    <span className="cq-room-count">
                      {playerCount}/{room.max_players}
                    </span>
                    <span className={"cq-room-status cq-room-status--" + room.status}>
                      {statusLabel(room.status as ConquestRoomStatus)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-accent cq-join-btn"
                      disabled={joinDisabled}
                      title={!isLoggedIn ? "Katılmak için giriş yapmalısın" : undefined}
                      onClick={() => { playSound("click"); onJoin(room.room_code); }}
                    >
                      Katıl
                    </button>
                  </div>
                </li>
              );
            })}
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
