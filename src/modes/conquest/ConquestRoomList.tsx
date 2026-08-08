/**
 * ConquestRoomList — public room browser for Kuşatma.
 *
 * Phase 5: queries public.conquest_rooms via fetchPublicConquestRooms() and
 * renders one card per joinable room.  A manual "Yenile" button refreshes
 * on demand; we deliberately do NOT subscribe globally to keep the design
 * scalable across many small rooms.  Auto-refresh fires every 20 seconds
 * while the list is visible.
 *
 * MİSAFİR KISITI: açık oda listesi yalnız kayıtlı kullanıcıya açıktır.
 * Kullanıcı normalde buraya hiç gelmez — Kuşatma menüsündeki "Odalara Göz At"
 * misafire giriş/kayıt ekranını gösterir. Bu ekran yine de savunma amaçlı
 * kendi kapısını kurar (doğrudan yönlendirme / eski sekme gibi durumlar için)
 * ve aynı LoginRequiredModal metnini kullanır.
 *
 * ASIL YETKİ SUNUCUDADIR: liste `conquest_list_public_rooms()` RPC'sinden
 * gelir ve o fonksiyon `anon` için `auth_required` fırlatır. Yani buradaki
 * `isLoggedIn` bayrağı kaldırılsa bile misafire oda bilgisi SIZMAZ.
 * Misafir davet linki / oda koduyla katılmaya devam edebilir.
 */

import { useCallback, useEffect, useState } from "react";
import { playSound } from "../../lib/sound";
import { mapLabel } from "./types";
import { EmojiIcon } from "../../components/EmojiIcon";
import LoginRequiredModal, {
  type LoginRequiredChoice,
} from "../../components/LoginRequiredModal";
import type { ConquestRoomStatus } from "./types";
import {
  fetchPublicConquestRooms,
  ConquestAuthRequiredError,
  type ConquestPublicRoomSummary,
} from "./conquestService";

interface Props {
  isLoggedIn: boolean;
  onBack:     () => void;
  onCreate:   () => void;
  /** Called with the 6-char room_code when the user picks a card to join. */
  onJoin:     (code: string) => void;
  /** Misafir bu ekrana düştü → App giriş/kayıt modalını açar. */
  onAuthRequired?: (choice: LoginRequiredChoice) => void;
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
  onAuthRequired,
}: Props) {
  const [rooms,    setRooms]    = useState<ConquestPublicRoomSummary[]>([]);
  const [loading,  setLoading]  = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** Sunucu "auth_required" dedi (ya da hiç giriş yapılmamış) → giriş kapısı. */
  const [authBlocked, setAuthBlocked] = useState<boolean>(!isLoggedIn);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const next = await fetchPublicConquestRooms();
      setRooms(next);
      setAuthBlocked(false);
    } catch (err) {
      // Yetki hatası ile "liste alınamadı" AYRI ele alınır: biri açıklanabilir
      // bir ürün kuralı, diğeri geçici bir arıza.
      if (err instanceof ConquestAuthRequiredError) {
        setRooms([]);
        setAuthBlocked(true);
      } else {
        setErrorMsg(err instanceof Error ? err.message : "Liste alınamadı.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh while mounted.
  useEffect(() => {
    if (!isLoggedIn) { setAuthBlocked(true); return; }
    void refresh();
    const handle = window.setInterval(() => { void refresh(); }, AUTO_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [isLoggedIn, refresh]);

  // Misafir bu ekrana düştüyse listeyi HİÇ göstermeyiz — menüdekiyle aynı
  // giriş/kayıt ekranı gelir (tek metin kaynağı).
  if (authBlocked) {
    return (
      <LoginRequiredModal
        intent="conquest-browse"
        onChoose={(choice) => onAuthRequired?.(choice)}
        onCancel={onBack}
      />
    );
  }

  return (
    <div className="duel-lobby">
      <div className="duel-lobby-card cq-rooms-card">
        <div className="cq-rooms-head">
          <div>
            <h2 className="duel-lobby-title"><EmojiIcon name="search" /> Kuşatma Odaları</h2>
            <p className="duel-lobby-desc">
              Açık Kuşatma odalarını gör ve katıl.
            </p>
          </div>
          <div className="cq-rooms-head-actions">
            <button
              type="button"
              className="btn btn-ghost cq-refresh-btn"
              onClick={() => { playSound("click"); void refresh(); }}
              disabled={loading}
              title="Listeyi yenile"
            >
              {loading ? "⟳ Yükleniyor…" : "⟳ Yenile"}
            </button>
            <button
              type="button"
              className="btn btn-accent cq-create-cta"
              onClick={() => { playSound("click"); onCreate(); }}
            >
              + Oda Kur
            </button>
          </div>
        </div>

        {errorMsg && (
          <p className="duel-error" style={{ textAlign: "left", marginBottom: 4 }}>
            <EmojiIcon name="warning" /> {errorMsg}
          </p>
        )}

        {rooms.length === 0 && !loading ? (
          <div className="cq-rooms-empty" role="status">
            <div className="cq-rooms-empty-icon" aria-hidden><EmojiIcon name="shield" /></div>
            <p className="cq-rooms-empty-title">
              Şu anda açık Kuşatma odası yok.
            </p>
            <p className="cq-rooms-empty-hint">
              İlk odayı sen kur, davet linkini paylaş.
            </p>
          </div>
        ) : (
          <ul className="cq-rooms-list">
            {rooms.map(({ room, playerCount }) => {
              const full   = playerCount >= room.max_players;
              const joinDisabled = room.status !== "waiting" || full;

              return (
                <li key={room.id} className="cq-room-card">
                  <div className="cq-room-card-main">
                    <div className="cq-room-code">#{room.room_code}</div>
                    <div className="cq-room-meta">
                      <span className="cq-room-host"><EmojiIcon name="crown" /> {room.host_name}</span>
                      <span className="cq-room-map">
                        <EmojiIcon name="map" /> {mapLabel(room.map_id as Parameters<typeof mapLabel>[0])}
                      </span>
                      <span className="cq-room-rounds"><EmojiIcon name="refresh" /> {room.round_count} Tur</span>
                      {room.team_mode === "teams_2v2" && (
                        <span className="cq-room-team-tag" title="2v2 Takımlı mod">
                          <EmojiIcon name="shield" /> 2v2 Takımlı
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
                      title={full ? "Oda dolu" : undefined}
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
