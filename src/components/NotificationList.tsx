/**
 * NotificationList.tsx — bildirim listesi gövdesi (paylaşılan presentational).
 *
 * Hem desktop/mobil-web NotificationCenter paneli hem de native Arkadaşlar
 * sosyal merkezindeki "Bildirimler" sekmesi aynı listeyi/aksiyonları kullansın
 * diye buraya çıkarıldı (kod tekrarı yok). Veri + aksiyonlar SocialContext'ten.
 *
 * Aksiyonlar tipe göre:
 *   - friend_request          → Kabul Et / Reddet
 *   - room_invite/game_invite → Katıl / Reddet
 *   - reward_ready            → Ödülleri Topla
 *   - diğer                   → tıklayınca okundu
 */
import { useState } from "react";
import { type NotificationRow } from "../lib/social";
import { useNotificationActions } from "../lib/notificationActions";
import { useSocial } from "./SocialContext";

/**
 * Günlük +50 Gold bonus kartı — oyun daveti kartıyla aynı görsel dilde,
 * aksiyon gerektiren (action-required) bir karttır. Claim mevcut server RPC'sine
 * (claim_daily_gold_bonus) gider; alınınca SocialContext.dailyRewardAvailable
 * false olur ve kart listeden kalkar.
 */
function DailyRewardCard() {
  const social = useSocial();
  const [claiming, setClaiming] = useState(false);

  const handleClaim = async () => {
    if (claiming) return;
    setClaiming(true);
    await social.claimDailyReward();
    // Başarı/zaten-alındı durumunda kart, dailyRewardAvailable=false ile kalkar.
    setClaiming(false);
  };

  return (
    <div className="notif-item notif-item--unread notif-item--daily">
      <div className="notif-item-main">
        <span className="notif-item-title">
          <span className="notif-daily-gift" aria-hidden="true">🎁</span> Günlük bonusun hazır
        </span>
        <span className="notif-item-body">+50 Gold seni bekliyor.</span>
      </div>
      <div className="notif-item-actions">
        <button
          type="button"
          className="notif-act notif-act--accept"
          onClick={(e) => {
            e.stopPropagation();
            void handleClaim();
          }}
          disabled={claiming}
        >
          {claiming ? "Alınıyor…" : "+50 Gold'u Al"}
        </button>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "az önce";
  if (min < 60) return `${min} dk önce`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} sa önce`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} gün önce`;
  return new Date(iso).toLocaleDateString("tr-TR");
}

interface NotificationListProps {
  /** Yalnızca arkadaşlık isteklerini göster (native "Gelen İstekler" sekmesi). */
  filter?: (n: NotificationRow) => boolean;
  /** Boş durum metni (sekmeye göre değişir). */
  emptyText?: string;
  /** Bir aksiyon "Katıl"/"Ödül" gibi paneli kapatması gerektiğinde çağrılır. */
  onNavigate?: () => void;
}

export function NotificationList({
  filter,
  emptyText = "Henüz bildirim yok.",
  onNavigate,
}: NotificationListProps) {
  const social = useSocial();
  // Toast'larla ORTAK aksiyon akışı (tek doğruluk kaynağı, kopya sistem yok).
  const actions = useNotificationActions();
  // Bu oturumda yanıtlanan arkadaşlık istekleri → aksiyon butonları gizlenir.
  const [resolved, setResolved] = useState<Record<string, "accepted" | "rejected">>({});

  const { notifications, markRead } = social;
  const rows = filter ? notifications.filter(filter) : notifications;

  const handleFriendResponse = async (n: NotificationRow, response: "accepted" | "rejected") => {
    const res = await actions.respondFriend(n, response);
    if (res.ok) setResolved((m) => ({ ...m, [n.id]: response }));
  };

  const handleJoin = async (n: NotificationRow) => {
    await actions.joinRoom(n);
    onNavigate?.();
  };

  const handleReward = async (n: NotificationRow) => {
    await actions.openRewards(n);
    onNavigate?.();
  };

  // Günlük bonus kartı yalnız genel bildirim görünümünde (filtreli sekmelerde
  // değil) ve bonus alınabilir durumdayken gösterilir.
  const showDaily = !filter && social.dailyRewardAvailable;

  if (rows.length === 0 && !showDaily) {
    return <div className="notif-empty">{emptyText}</div>;
  }

  return (
    <div className="notif-list">
      {showDaily && <DailyRewardCard />}
      {rows.map((n) => (
        <div
          key={n.id}
          className={`notif-item${n.read_at ? "" : " notif-item--unread"}`}
          onClick={() => {
            if (!n.read_at) void markRead(n.id);
          }}
        >
          <div className="notif-item-main">
            <span className="notif-item-title">{n.title}</span>
            {n.body && <span className="notif-item-body">{n.body}</span>}
            <span className="notif-item-time">{timeAgo(n.created_at)}</span>
          </div>

          {n.type === "friend_request" &&
            (resolved[n.id] ? (
              <div className="notif-item-resolved">
                {resolved[n.id] === "accepted" ? "✓ Kabul edildi" : "Reddedildi"}
              </div>
            ) : (
              <div className="notif-item-actions">
                <button
                  type="button"
                  className="notif-act notif-act--accept"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleFriendResponse(n, "accepted");
                  }}
                >
                  Kabul Et
                </button>
                <button
                  type="button"
                  className="notif-act notif-act--reject"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleFriendResponse(n, "rejected");
                  }}
                >
                  Reddet
                </button>
              </div>
            ))}

          {(n.type === "room_invite" || n.type === "game_invite") && (
            <div className="notif-item-actions">
              <button
                type="button"
                className="notif-act notif-act--accept"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleJoin(n);
                }}
              >
                Katıl
              </button>
              <button
                type="button"
                className="notif-act notif-act--reject"
                onClick={(e) => {
                  e.stopPropagation();
                  void markRead(n.id);
                }}
              >
                Reddet
              </button>
            </div>
          )}

          {n.type === "reward_ready" && (
            <div className="notif-item-actions">
              <button
                type="button"
                className="notif-act notif-act--accept"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleReward(n);
                }}
              >
                Ödülleri Topla
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
