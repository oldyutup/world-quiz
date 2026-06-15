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
import { respondFriendRequest, type NotificationRow } from "../lib/social";
import { useSocial } from "./SocialContext";

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
  // Bu oturumda yanıtlanan arkadaşlık istekleri → aksiyon butonları gizlenir.
  const [resolved, setResolved] = useState<Record<string, "accepted" | "rejected">>({});

  const { notifications, markRead, refreshNotifications } = social;
  const rows = filter ? notifications.filter(filter) : notifications;

  const handleFriendResponse = async (n: NotificationRow, response: "accepted" | "rejected") => {
    const reqId = n.payload?.friendRequestId as string | undefined;
    if (!reqId) {
      console.error("friend_request notification without friendRequestId", n);
      social.toast("İstek bilgisi eksik, sayfayı yenile.");
      return;
    }
    const res = await respondFriendRequest(reqId, response);
    if (!res.ok) {
      social.toast(res.error ?? "İstek işlenemedi.");
      return;
    }
    setResolved((m) => ({ ...m, [n.id]: response }));
    await markRead(n.id);
    if (response === "accepted") social.bumpFriends();
    social.toast(
      response === "accepted"
        ? "Arkadaşlık isteği kabul edildi"
        : "Arkadaşlık isteği reddedildi"
    );
    await refreshNotifications();
  };

  const handleJoin = async (n: NotificationRow) => {
    const url = n.payload?.roomUrl as string | undefined;
    await markRead(n.id);
    if (url && social.onJoinRoom) {
      social.onJoinRoom(url);
    } else {
      social.toast("Bu davet artık geçerli değil.");
    }
    onNavigate?.();
  };

  const handleReward = async (n: NotificationRow) => {
    await markRead(n.id);
    social.onOpenRewards?.();
    onNavigate?.();
  };

  if (rows.length === 0) {
    return <div className="notif-empty">{emptyText}</div>;
  }

  return (
    <div className="notif-list">
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
