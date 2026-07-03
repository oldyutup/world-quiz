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
import {
  respondFriendRequest,
  isSafeInternalRoomPath,
  isRoomInviteDead,
  type NotificationRow,
} from "./social";
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
      // Kaynak isteğin durumunu anlık güncelle → kart bu anda "Kabul/Reddet"
      // yerine pasif durumu gösterir (refreshNotifications DB'den teyit eder).
      social.setFriendRequestStatus(reqId, response);
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

      // 1) Ham URL'yi doğrudan navigation'a vermeyiz: yalnız same-origin, göreceli
      //    oda yolları açılabilir (open-redirect / phishing koruması). Geçersiz
      //    bağlantı = ölü davet → KALICI olarak "geçersiz" işaretle, gezinme yok.
      if (!isSafeInternalRoomPath(url)) {
        await social.markInviteInvalid(n.id);
        social.toast("Davet artık geçerli değil.");
        return { ok: false };
      }

      // 2) HAFİF canonical geçerlilik kontrolü (yalnız tıklama anında bir kez):
      //    oda kapanmış / oyun başlamış / oda silinmişse gereksiz tam-sayfa
      //    yönlendirme + geri sekme yaşatmadan daveti çöz. isRoomInviteDead asla
      //    yanlış pozitif vermez (belirsizlik → false), böylece geçerli davet ölmez.
      if (await isRoomInviteDead(n.payload?.mode, n.payload?.roomCode)) {
        await social.markInviteInvalid(n.id);
        social.toast("Davet artık geçerli değil.");
        return { ok: false };
      }

      // 3) Geçerli/bilinmeyen → gezinme (hedef mod son doğrulamayı kendi auto-join
      //    akışında yapar; başarısız olursa davet zaten okundu → butonlar geri gelmez).
      if (social.onJoinRoom) {
        await social.markRead(n.id);
        social.onJoinRoom(url);
        return { ok: true };
      }
      await social.markInviteInvalid(n.id);
      social.toast("Davet artık geçerli değil.");
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
