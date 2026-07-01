/**
 * notificationActions.ts — bildirim aksiyonları için TEK doğruluk kaynağı.
 *
 * Hem kalıcı bildirim merkezi (NotificationList) hem de canlı toast kartları
 * (NotificationToaster) aynı kabul/red/katıl/ödül akışlarını kullansın diye
 * buraya çıkarıldı. Böylece "aynı veriyi kopyalayan ikinci bir sistem" kurulmaz;
 * iki yüzey de mevcut SECURITY DEFINER RPC'lerini (respond_friend_request,
 * mark_notification_read…) çağırır, client hiçbir şeyi "olmuş gibi" göstermez.
 *
 * Her aksiyon bir ActionResult döndürür; çağıran (toast) başarıda kendini kapatır,
 * inbox ise "✓ Kabul edildi" gibi yerel durumunu işaretler.
 */
import { useCallback } from "react";
import { respondFriendRequest, isSafeInternalRoomPath, type NotificationRow } from "./social";
import { useSocial } from "../components/SocialContext";

export interface ActionResult {
  ok: boolean;
}

export interface NotificationActions {
  /** friend_request → kabul/red (respond_friend_request RPC) + state senkron. */
  respondFriend: (n: NotificationRow, response: "accepted" | "rejected") => Promise<ActionResult>;
  /** room_invite/game_invite → "Katıl": davet linkine git (varsa). */
  joinRoom: (n: NotificationRow) => Promise<ActionResult>;
  /** Daveti reddet: yalnız okundu işaretle (entity'ye dokunmaz). */
  declineInvite: (n: NotificationRow) => Promise<ActionResult>;
  /** reward_ready → "Görüntüle/Ödülleri Topla": ödül ekranını aç. */
  openRewards: (n: NotificationRow) => Promise<ActionResult>;
}

export function useNotificationActions(): NotificationActions {
  const social = useSocial();

  const respondFriend = useCallback<NotificationActions["respondFriend"]>(
    async (n, response) => {
      const reqId = n.payload?.friendRequestId as string | undefined;
      if (!reqId) {
        console.error("friend_request notification without friendRequestId", n);
        social.toast("İstek bilgisi eksik, sayfayı yenile.");
        return { ok: false };
      }
      const res = await respondFriendRequest(reqId, response);
      if (!res.ok) {
        social.toast(res.error ?? "İstek işlenemedi.");
        return { ok: false };
      }
      await social.markRead(n.id);
      if (response === "accepted") social.bumpFriends();
      social.toast(
        response === "accepted"
          ? "Arkadaşlık isteği kabul edildi"
          : "Arkadaşlık isteği reddedildi"
      );
      await social.refreshNotifications();
      return { ok: true };
    },
    [social]
  );

  const joinRoom = useCallback<NotificationActions["joinRoom"]>(
    async (n) => {
      const url = n.payload?.roomUrl as unknown;
      await social.markRead(n.id);
      // Ham URL'yi doğrudan navigation'a vermeyiz: yalnız same-origin, göreceli
      // oda yolları açılabilir (open-redirect / phishing koruması). Bu kontrol
      // eski veritabanında kalmış kötü davetleri de güvenle engeller.
      if (!isSafeInternalRoomPath(url)) {
        social.toast("Geçersiz davet bağlantısı.");
        return { ok: false };
      }
      if (social.onJoinRoom) {
        // Davetin hâlâ geçerli olduğu / odada yer olduğu, hedef modun mevcut
        // auto-join akışında (useInviteJoin / conquest join) doğrulanır; geçersizse
        // kullanıcı orada kısa hata görür. Burada ikinci bir doğrulama sistemi kurmayız.
        social.onJoinRoom(url);
        return { ok: true };
      }
      social.toast("Bu davet artık geçerli değil.");
      return { ok: false };
    },
    [social]
  );

  const declineInvite = useCallback<NotificationActions["declineInvite"]>(
    async (n) => {
      await social.markRead(n.id);
      return { ok: true };
    },
    [social]
  );

  const openRewards = useCallback<NotificationActions["openRewards"]>(
    async (n) => {
      await social.markRead(n.id);
      social.onOpenRewards?.();
      return { ok: true };
    },
    [social]
  );

  return { respondFriend, joinRoom, declineInvite, openRewards };
}
