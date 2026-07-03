/**
 * notificationStatus.ts — bir bildirimin aksiyonlarının HÂLÂ geçerli olup
 * olmadığını belirleyen TEK derivasyon noktası.
 *
 * Amaç: bildirim merkezi (NotificationList) ve canlı toast (NotificationToaster)
 * bayat/çözülmüş aksiyon göstermesin. "Kabul/Reddet" ya da "Katıl/Reddet"
 * butonları YALNIZCA kaynak kayıt hâlâ aksiyon alınabilir durumdaysa görünsün.
 *
 * Kanonik durum kaynağı (server-otoriteli, sayfa yenilemesine dayanıklı) —
 * clear_my_notifications RPC'sindeki "aksiyon bekleyen" tanımıyla uyumlu:
 *   - friend_request          → friend_requests.status = 'pending'
 *   - room_invite/game_invite → notifications.read_at IS NULL (henüz yanıtlanmadı)
 *     + payload.inviteState = 'invalid' değilse (oda kapanmış/başlamış/silinmiş
 *       davet resolve_room_invite ile KALICI damgalanır, bkz. 20260727120000).
 * Bu sinyaller client tarafından okunabilir (RLS party-select + read_at +
 * payload); local state'e güvenmez, sayfa yenilemesine dayanır.
 */
import type { FriendRequestStatus, NotificationRow } from "./social";

/**
 * Yanıtlanmamış bir davetin "artık geçerli değil" sayıldığı yaş eşiği. Oda
 * davetleri kısa ömürlüdür; bundan eski hâlâ yanıtlanmamış bir davetin odası
 * neredeyse kesin kapanmıştır. Not: gerçek katılım akışı davetin geçerliliğini
 * ayrıca doğrular (useInviteJoin / conquest join); bu eşik yalnız açıkça bayat
 * davetlerde butonu gizleyen kozmetik bir güvenlik ağıdır (hâlâ geçerli bir
 * daveti saklamamak için bilinçli olarak geniş tutuldu).
 */
export const INVITE_STALE_MS = 3 * 60 * 60 * 1000; // 3 saat

export interface NotifActionState {
  /** Aksiyon butonları (Kabul/Reddet · Katıl/Reddet) gösterilebilir mi? */
  actionable: boolean;
  /**
   * actionable=false olduğunda gösterilecek küçük, sakin pasif durum metni.
   * (reward_ready gibi zamanla geçersizleşmeyen türlerde undefined kalır.)
   */
  passiveText?: string;
}

/**
 * Bir bildirimin aksiyon durumunu üretir. `friendRequestStatuses`
 * SocialContext'te tutulan id→status haritasıdır (fetchFriendRequestStatuses).
 */
export function resolveNotificationAction(
  n: NotificationRow,
  friendRequestStatuses: Record<string, FriendRequestStatus>,
  now: number = Date.now()
): NotifActionState {
  if (n.type === "friend_request") {
    const reqId = n.payload?.friendRequestId as string | undefined;
    const status = reqId ? friendRequestStatuses[reqId] : undefined;
    switch (status) {
      case "pending":
        return { actionable: true };
      case "accepted":
        return { actionable: false, passiveText: "İsteği kabul ettin" };
      case "rejected":
        return { actionable: false, passiveText: "İsteği reddettin" };
      case "cancelled":
        return { actionable: false, passiveText: "İstek geri çekildi" };
      default:
        // Durum bilinmiyor / kaynak istek silinmiş → artık aksiyon alınamaz.
        return { actionable: false, passiveText: "Bu istek artık geçerli değil" };
    }
  }

  if (n.type === "room_invite" || n.type === "game_invite") {
    // Oda kapanmış/başlamış/silinmiş ya da bağlantı geçersiz → KALICI olarak
    // "invalid" damgalanır (resolve_room_invite). Bu, read_at'ten önce gelir:
    // kullanıcı yanıt vermeden de davet ölmüş olabilir.
    if (n.payload?.inviteState === "invalid") {
      return { actionable: false, passiveText: "Davet artık geçerli değil" };
    }
    // Katıl/Reddet ikisi de bildirimi okundu işaretler → read_at, kullanıcının
    // daveti zaten yanıtladığının kalıcı (server) kanıtıdır.
    if (n.read_at) {
      return { actionable: false, passiveText: "Bu davete yanıt verildi" };
    }
    const ageMs = now - new Date(n.created_at).getTime();
    if (Number.isFinite(ageMs) && ageMs > INVITE_STALE_MS) {
      return { actionable: false, passiveText: "Davet artık geçerli değil" };
    }
    return { actionable: true };
  }

  // reward_ready / achievement_unlocked / system vb.: zamanla geçersizleşmez,
  // kendi aksiyon akışları var → her zaman aksiyon alınabilir kabul edilir.
  return { actionable: true };
}
