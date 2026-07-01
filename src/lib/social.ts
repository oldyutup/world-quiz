/**
 * social.ts — Sosyal sistem (arkadaşlık + bildirim + davet + public profil +
 * kozmetik) için tipli Supabase RPC sarmalayıcıları.
 *
 * TASARIM:
 *   - Tüm yazma yolları SECURITY DEFINER RPC'lerden geçer (bkz.
 *     20260715121000_social_core.sql). Client başka kullanıcı adına bildirim
 *     üretemez; actor daima server'da auth.uid()'den belirlenir.
 *   - Okuma: notifications RLS self-select; profil kartı / lobi avatarı için
 *     get_public_profile(s) RPC (gold DÖNDÜRMEZ).
 *   - Realtime: notifications INSERT aboneliği (web + mobil web + native ortak).
 *
 * Üç platformda da (desktop web, mobil web, native iOS/app) aynı şekilde çalışır;
 * tek fark UI katmanında.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/* ──────────────────────────────────────────────────────────────────────────
   Tipler
   ────────────────────────────────────────────────────────────────────────── */

export type NotificationType =
  | "friend_request"
  | "friend_request_accepted"
  | "game_invite"
  | "room_invite"
  | "achievement_unlocked"
  | "reward_ready"
  | "system_message";

export interface NotificationRow {
  id: string;
  recipient_profile_id: string;
  actor_profile_id: string | null;
  type: NotificationType | string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export type RelationshipStatus =
  | "self"
  | "friends"
  | "request_sent"
  | "request_received"
  /** Ben bu kullanıcıyı engelledim. */
  | "blocked"
  /** Bu kullanıcı beni engelledi. */
  | "blocked_by"
  | "none";

/** get_public_profile dönüşü — Gold içermez (public kart). */
export interface PublicProfile {
  profileId: string;
  username: string | null;
  avatarId: string | null;
  level: number;
  /** Toplam XP (sum xp_events.xp_earned) — XP barı için. */
  xp: number;
  /** XP kazandıran maç sayısı (count xp_events). */
  matchesCount: number;
  /** Galibiyet sayısı (xp_events.result = 'win'). */
  winsCount: number;
  /** Mevcut online galibiyet serisi. */
  currentStreak: number;
  /** Açılan başarım (tier) sayısı — sticky, sunucu otoriteli. */
  achievementsCount: number;
  showcasedBadgeIds: string[];
  activeAvatarFrameId: string | null;
  activeProfileThemeId: string | null;
  activeNameColorId: string | null;
  /** Kart teması / kart stili kozmetik id'si (default null). */
  activeProfileCardStyleId: string | null;
  /** Profil unvanı kozmetik id'si (default null → unvan gösterilmez). */
  activeProfileTitleId: string | null;
  /** Kart efekti kozmetik id'si (default null → efekt yok). */
  activeProfileEffectId: string | null;
  relationshipStatus: RelationshipStatus;
}

/** get_public_profiles dönüşü (lobi/leaderboard avatar çözümü, hafif). */
export interface PublicProfileLite {
  profileId: string;
  username: string | null;
  avatarId: string | null;
  level: number;
  activeAvatarFrameId: string | null;
}

/** get_friends dönüşü — arkadaş listesi satırı (gold içermez). */
export interface FriendRow {
  profileId: string;
  username: string | null;
  avatarId: string | null;
  level: number;
  activeAvatarFrameId: string | null;
  friendsSince: string | null;
}

/** list_blocked_users dönüşü — engellenen kullanıcı satırı (gold içermez). */
export interface BlockedUserRow {
  profileId: string;
  username: string | null;
  avatarId: string | null;
  level: number;
  activeAvatarFrameId: string | null;
  blockedAt: string | null;
}

/** search_public_profiles dönüşü — oyuncu arama satırı (gold içermez). */
export interface SearchProfileResult {
  profileId: string;
  username: string | null;
  avatarId: string | null;
  level: number;
  profileCode: string | null;
  activeAvatarFrameId: string | null;
  relationshipStatus: RelationshipStatus;
}

export interface MyCosmetics {
  showcasedBadgeIds: string[];
  activeAvatarFrameId: string | null;
  activeProfileThemeId: string | null;
  activeNameColorId: string | null;
  activeProfileCardStyleId: string | null;
  activeProfileTitleId: string | null;
  activeProfileEffectId: string | null;
}

/* ──────────────────────────────────────────────────────────────────────────
   Hata mesajları (RPC errcode/message → Türkçe)
   ────────────────────────────────────────────────────────────────────────── */

export function describeSocialError(message: string | undefined | null): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("cannot_friend_self")) return "Kendine arkadaşlık isteği gönderemezsin.";
  if (m.includes("already_friends")) return "Zaten arkadaşsınız.";
  if (m.includes("request_already_sent")) return "İstek zaten gönderildi.";
  if (m.includes("incoming_request_exists")) return "Bu oyuncu sana zaten istek göndermiş. Bildirimlerden yanıtla.";
  if (m.includes("request_not_pending")) return "Bu istek artık geçerli değil.";
  if (m.includes("not_your_request")) return "Bu isteği yanıtlayamazsın.";
  if (m.includes("request_not_found")) return "İstek bulunamadı.";
  if (m.includes("cannot_invite_self")) return "Kendini davet edemezsin.";
  if (m.includes("not_friends")) return "Yalnızca arkadaşlarını odaya davet edebilirsin.";
  if (m.includes("invalid_room_url")) return "Geçersiz davet bağlantısı.";
  if (m.includes("recipient_not_found")) return "Oyuncu bulunamadı.";
  if (m.includes("cannot_block_self")) return "Kendini engelleyemezsin.";
  if (m.includes("blocked_between")) return "Bu kullanıcıyla etkileşemezsin.";
  if (m.includes("auth_required")) return "Bu işlem için giriş yapmalısın.";
  return "Bir hata oluştu, tekrar dene.";
}

/* ──────────────────────────────────────────────────────────────────────────
   Bildirimler
   ────────────────────────────────────────────────────────────────────────── */

/** Kendi bildirimlerimi çeker (RLS self-select). En yeni en üstte. */
export async function fetchNotifications(limit = 50): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as NotificationRow[];
}

export async function markNotificationRead(id: string): Promise<void> {
  await supabase.rpc("mark_notification_read", { p_id: id });
}

export async function markAllNotificationsRead(): Promise<void> {
  await supabase.rpc("mark_all_notifications_read");
}

export interface ClearNotificationsResult {
  ok: boolean;
  /** Silinen bildirim sayısı. */
  deleted: number;
  /** Aksiyon gerektirdiği için korunan (silinmeyen) bildirim sayısı. */
  preserved: number;
  error?: string;
}

/**
 * Kendi bildirimlerimi temizler — clear_my_notifications RPC (SECURITY DEFINER).
 * Yalnız notifications satırları silinir; asıl entity'ler (friend_request,
 * friendship, davet, achievement reward claim hakkı) ETKİLENMEZ. Hâlâ aksiyon
 * bekleyen bildirimler (pending friend_request, okunmamış davet) server'da korunur.
 */
export async function clearMyNotifications(): Promise<ClearNotificationsResult> {
  const { data, error } = await supabase.rpc("clear_my_notifications");
  if (error) {
    console.error("clear_my_notifications failed", error);
    return { ok: false, deleted: 0, preserved: 0, error: error.message };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    deleted: (r.deleted as number) ?? 0,
    preserved: (r.preserved as number) ?? 0,
  };
}

/**
 * notifications tablosunda recipient = benim profilim olan YENİ satırları dinler.
 * Lifecycle: çağıran dönen channel'ı saklar ve unmount'ta
 * supabase.removeChannel(channel) çağırır. Mevcut conquestRealtime deseniyle aynı.
 */
export function subscribeNotifications(
  profileId: string,
  onInsert: (row: NotificationRow) => void
): RealtimeChannel {
  return supabase
    .channel(`notifications:${profileId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `recipient_profile_id=eq.${profileId}`,
      },
      (payload) => {
        if (payload.new) onInsert(payload.new as NotificationRow);
      }
    )
    .subscribe();
}

/* ──────────────────────────────────────────────────────────────────────────
   Arkadaşlık
   ────────────────────────────────────────────────────────────────────────── */

export interface RpcResult {
  ok: boolean;
  error?: string;
}

export async function sendFriendRequest(recipientProfileId: string): Promise<RpcResult> {
  const { error } = await supabase.rpc("send_friend_request", {
    p_recipient: recipientProfileId,
  });
  if (error) {
    if ((error.message ?? "").toLowerCase().includes("blocked_between")) {
      return { ok: false, error: "Bu kullanıcıya istek gönderemezsin." };
    }
    return { ok: false, error: describeSocialError(error.message) };
  }
  return { ok: true };
}

export async function respondFriendRequest(
  requestId: string,
  response: "accepted" | "rejected"
): Promise<RpcResult> {
  const { error } = await supabase.rpc("respond_friend_request", {
    p_request_id: requestId,
    p_response: response,
  });
  if (error) {
    console.error("respond_friend_request failed", { requestId, response, error });
    return { ok: false, error: describeSocialError(error.message) };
  }
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────────────
   İlişki yönetimi: arkadaşlıktan çıkar + engelle / engeli kaldır / liste
   Tüm yazma yolları SECURITY DEFINER RPC (bkz.
   20260716160000_social_block_and_remove_friend.sql). Client doğrudan
   blocked_profiles / friends tablolarına YAZMAZ.
   ────────────────────────────────────────────────────────────────────────── */

/** İki yönlü arkadaşlık ilişkisini kaldırır (engellemez). */
export async function removeFriend(targetProfileId: string): Promise<RpcResult> {
  const { error } = await supabase.rpc("remove_friend", { p_target: targetProfileId });
  if (error) {
    console.error("remove_friend failed", error);
    return { ok: false, error: describeSocialError(error.message) };
  }
  return { ok: true };
}

/**
 * Kullanıcıyı engeller (idempotent, sessiz). Server: varsa arkadaşlığı kaldırır,
 * iki yönlü pending istekleri iptal eder, ilgili friend_request bildirimlerini
 * temizler. Engellenen kişiye bildirim ÜRETİLMEZ.
 */
export async function blockUser(targetProfileId: string): Promise<RpcResult> {
  const { error } = await supabase.rpc("block_user", { p_target: targetProfileId });
  if (error) {
    console.error("block_user failed", error);
    return { ok: false, error: describeSocialError(error.message) };
  }
  return { ok: true };
}

/** Engeli kaldırır (idempotent). Otomatik arkadaşlık KURMAZ. */
export async function unblockUser(targetProfileId: string): Promise<RpcResult> {
  const { error } = await supabase.rpc("unblock_user", { p_target: targetProfileId });
  if (error) {
    console.error("unblock_user failed", error);
    return { ok: false, error: describeSocialError(error.message) };
  }
  return { ok: true };
}

/** Kendi engellediğim kullanıcılar — TEK çağrı (list_blocked_users RPC), N+1 yok. */
export async function listBlockedUsers(): Promise<BlockedUserRow[]> {
  const { data, error } = await supabase.rpc("list_blocked_users");
  if (error || !Array.isArray(data)) {
    if (error) console.error("list_blocked_users failed", error);
    return [];
  }
  return (data as Record<string, unknown>[]).map((r) => ({
    profileId: r.profile_id as string,
    username: (r.username as string) ?? null,
    avatarId: (r.avatar_id as string) ?? null,
    level: (r.level as number) ?? 1,
    activeAvatarFrameId: (r.active_avatar_frame_id as string) ?? null,
    blockedAt: (r.blocked_at as string) ?? null,
  }));
}

/**
 * Oturum açık kullanıcının arkadaş listesi — TEK çağrı (get_friends RPC), N+1 yok.
 * Sadece public alanlar (avatar/username/level/çerçeve); gold dönmez.
 */
export async function fetchFriends(): Promise<FriendRow[]> {
  const { data, error } = await supabase.rpc("get_friends");
  if (error || !Array.isArray(data)) {
    if (error) console.error("get_friends failed", error);
    return [];
  }
  return (data as Record<string, unknown>[]).map((r) => ({
    profileId: r.profile_id as string,
    username: (r.username as string) ?? null,
    avatarId: (r.avatar_id as string) ?? null,
    level: (r.level as number) ?? 1,
    activeAvatarFrameId: (r.active_avatar_frame_id as string) ?? null,
    friendsSince: (r.friends_since as string) ?? null,
  }));
}

/**
 * Public profil arama — username (prefix) veya profile_code (tam) ile.
 * TEK çağrı (search_public_profiles RPC), N+1 yok; gold/email DÖNMEZ.
 * 2 karakterden kısa sorguda boş döner (server da reddeder). Çağıran debounce
 * uygular. "@" önekini server temizler; client'ta da temizlemek zorunlu değil.
 */
export async function searchPublicProfiles(query: string): Promise<SearchProfileResult[]> {
  const q = query.trim();
  if (q.replace(/^@+/, "").trim().length < 2) return [];
  const { data, error } = await supabase.rpc("search_public_profiles", { p_query: q });
  if (error || !Array.isArray(data)) {
    if (error) console.error("search_public_profiles failed", error);
    return [];
  }
  return (data as Record<string, unknown>[]).map((r) => ({
    profileId: r.profile_id as string,
    username: (r.username as string) ?? null,
    avatarId: (r.avatar_id as string) ?? null,
    level: (r.level as number) ?? 1,
    profileCode: (r.profile_code as string) ?? null,
    activeAvatarFrameId: (r.active_avatar_frame_id as string) ?? null,
    relationshipStatus: ((r.relationship_status as RelationshipStatus) ?? "none"),
  }));
}

/* ──────────────────────────────────────────────────────────────────────────
   Oyun / lobi daveti
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Bir davet URL'sinin GÜVENLE açılabilir, uygulama-içi (same-origin) göreceli
 * bir oda yolu olup olmadığını doğrular. Open-redirect / phishing koruması:
 * yalnız `/?conquest=CODE` gibi relative path'ler geçer.
 *
 * Reddedilir: `https://…`, `http://…`, `javascript:…`, `data:…`, `//evil.com`,
 * `\\evil.com`, boşluk/kontrol karakteri içerenler ve `new URL(...)` sonrası
 * origin'i `window.location.origin`'den farklı olan her şey. Bu kontrol, hem
 * yeni davetleri hem de eski veritabanında kalmış kötü davetleri kapsar.
 */
export function isSafeInternalRoomPath(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  // Baş/son boşluğu sessizce kırpmayız — böyle bir değer zaten şüphelidir.
  if (raw.trim() !== raw) return false;
  // Göreceli path olmalı; protocol-relative (`//`) ve mutlak URL değil.
  if (!raw.startsWith("/") || raw.startsWith("//")) return false;
  // Backslash (`/\evil.com` bazı tarayıcılarda `//`'e dönüşür) ve boşluk/
  // kontrol karakterleri kesinlikle yasak.
  if (raw.includes("\\")) return false;
  // Boşluk ve kontrol karakterleri (0x00-0x1F, 0x7F) reddedilir.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return false;
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(raw, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.protocol === window.location.protocol
    );
  } catch {
    return false;
  }
}

export async function sendRoomInvite(args: {
  recipientProfileId: string;
  roomCode: string;
  mode: string;
  roomUrl: string;
}): Promise<RpcResult> {
  // Sunucu son otorite (send_room_invite p_room_url'i doğrular), ama harici bir
  // URL'yi ağ üzerinden hiç göndermemek için burada da erken reddederiz.
  if (!isSafeInternalRoomPath(args.roomUrl)) {
    return { ok: false, error: "Geçersiz davet bağlantısı." };
  }
  const { error } = await supabase.rpc("send_room_invite", {
    p_recipient: args.recipientProfileId,
    p_room_code: args.roomCode,
    p_mode: args.mode,
    p_room_url: args.roomUrl,
  });
  if (error) {
    if ((error.message ?? "").toLowerCase().includes("blocked_between")) {
      return { ok: false, error: "Bu kullanıcıya davet gönderemezsin." };
    }
    return { ok: false, error: describeSocialError(error.message) };
  }
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────────────
   Public profil
   ────────────────────────────────────────────────────────────────────────── */

export async function getPublicProfile(profileId: string): Promise<PublicProfile | null> {
  const { data, error } = await supabase.rpc("get_public_profile", {
    p_profile_id: profileId,
  });
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as Record<string, unknown>;
  return {
    profileId: r.profile_id as string,
    username: (r.username as string) ?? null,
    avatarId: (r.avatar_id as string) ?? null,
    level: (r.level as number) ?? 1,
    xp: (r.xp as number) ?? 0,
    matchesCount: (r.matches_count as number) ?? 0,
    winsCount: (r.wins_count as number) ?? 0,
    currentStreak: (r.current_streak as number) ?? 0,
    achievementsCount: (r.achievements_count as number) ?? 0,
    showcasedBadgeIds: (r.showcased_badge_ids as string[]) ?? [],
    activeAvatarFrameId: (r.active_avatar_frame_id as string) ?? null,
    activeProfileThemeId: (r.active_profile_theme_id as string) ?? null,
    activeNameColorId: (r.active_name_color_id as string) ?? null,
    activeProfileCardStyleId: (r.active_profile_card_style_id as string) ?? null,
    activeProfileTitleId: (r.active_profile_title_id as string) ?? null,
    activeProfileEffectId: (r.active_profile_effect_id as string) ?? null,
    relationshipStatus: ((r.relationship_status as RelationshipStatus) ?? "none"),
  };
}

/**
 * Birden çok profil id için avatar/username/level çözer — TEK çağrı, N+1 yok.
 * Lobi roster'ı ve leaderboard avatar tamamlama için. Sonuç id→profil map'i.
 */
export async function getPublicProfiles(
  ids: string[]
): Promise<Map<string, PublicProfileLite>> {
  const out = new Map<string, PublicProfileLite>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return out;
  const { data, error } = await supabase.rpc("get_public_profiles", {
    p_ids: unique,
  });
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Record<string, unknown>[]) {
    out.set(row.profile_id as string, {
      profileId: row.profile_id as string,
      username: (row.username as string) ?? null,
      avatarId: (row.avatar_id as string) ?? null,
      level: (row.level as number) ?? 1,
      activeAvatarFrameId: (row.active_avatar_frame_id as string) ?? null,
    });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Kozmetik (kendi profilim) — RLS self-write (upsert)
   ────────────────────────────────────────────────────────────────────────── */

export async function getMyCosmetics(profileId: string): Promise<MyCosmetics> {
  const empty: MyCosmetics = {
    showcasedBadgeIds: [],
    activeAvatarFrameId: null,
    activeProfileThemeId: null,
    activeNameColorId: null,
    activeProfileCardStyleId: null,
    activeProfileTitleId: null,
    activeProfileEffectId: null,
  };
  const { data, error } = await supabase
    .from("profile_cosmetics")
    .select("*")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error || !data) return empty;
  const r = data as Record<string, unknown>;
  return {
    showcasedBadgeIds: (r.showcased_badge_ids as string[]) ?? [],
    activeAvatarFrameId: (r.active_avatar_frame_id as string) ?? null,
    activeProfileThemeId: (r.active_profile_theme_id as string) ?? null,
    activeNameColorId: (r.active_name_color_id as string) ?? null,
    activeProfileCardStyleId: (r.active_profile_card_style_id as string) ?? null,
    activeProfileTitleId: (r.active_profile_title_id as string) ?? null,
    activeProfileEffectId: (r.active_profile_effect_id as string) ?? null,
  };
}

/** En fazla 5 rozet sergilenir; fazlası kırpılır. RLS yalnız sahibine izin verir. */
export async function saveShowcasedBadges(
  profileId: string,
  badgeIds: string[]
): Promise<RpcResult> {
  const trimmed = badgeIds.slice(0, 5);
  const { error } = await supabase
    .from("profile_cosmetics")
    .upsert(
      { profile_id: profileId, showcased_badge_ids: trimmed, updated_at: new Date().toISOString() },
      { onConflict: "profile_id" }
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
