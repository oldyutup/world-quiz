/**
 * moderation.ts — Uygulama içi raporlama + hesap moderasyon durumu için tipli
 * Supabase RPC sarmalayıcıları (App Store Guideline 1.2 UGC güvenlik paketi).
 *
 * TASARIM:
 *   - Tüm rapor yolları SECURITY DEFINER RPC'lerden geçer (bkz.
 *     20260806120000_ugc_safety_reports_moderation.sql). İstemci reporter
 *     kimliğini VEYA mesaj/kullanıcı adı snapshot'ını GÖNDEREMEZ; her ikisi de
 *     sunucuda gerçek tablodan türetilir.
 *   - reports tablosuna doğrudan erişim YOK; yalnız report_profile /
 *     report_dm_message / report_room_message RPC'leri.
 *   - Hata kodları kullanıcı-dostu Türkçe mesaja çevrilir; yasaklı kelime veya
 *     snapshot ASLA kullanıcıya geri gösterilmez.
 */
import { supabase } from "./supabase";

/* ──────────────────────────────────────────────────────────────────────────
   Rapor nedenleri — DB değerleri sabit, dil-bağımsız snake_case.
   ────────────────────────────────────────────────────────────────────────── */

export type ReportReason =
  | "harassment"
  | "inappropriate_language"
  | "hate_speech"
  | "sexual_content"
  | "spam_scam"
  | "inappropriate_username"
  | "other";

export interface ReportReasonOption {
  value: ReportReason;
  label: string;
}

/** Kullanıcıya gösterilecek neden listesi (sıralı). */
export const REPORT_REASONS: readonly ReportReasonOption[] = [
  { value: "harassment", label: "Taciz veya zorbalık" },
  { value: "inappropriate_language", label: "Uygunsuz dil" },
  { value: "hate_speech", label: "Nefret söylemi" },
  { value: "sexual_content", label: "Cinsel içerik" },
  { value: "spam_scam", label: "Spam veya dolandırıcılık" },
  { value: "inappropriate_username", label: "Uygunsuz kullanıcı adı" },
  { value: "other", label: "Diğer" },
] as const;

/** "Diğer" için serbest açıklamanın azami uzunluğu (sunucu da 300'e kırpar). */
export const REPORT_DETAIL_MAX = 300;

export type ReportErrorCode =
  | "duplicate"
  | "rate_limited"
  | "target_not_found"
  | "not_allowed"
  | "unknown";

export interface ReportResult {
  ok: boolean;
  /** Makine-okur kod (duplicate akışında block'a devam için). */
  code?: ReportErrorCode;
  /** Kullanıcı-dostu Türkçe hata mesajı (ok=false iken). */
  error?: string;
}

/** RPC hata metnini koda + kullanıcı mesajına çevirir. Snapshot ifşa etmez. */
function mapReportError(message: string | undefined | null): ReportResult {
  const m = (message ?? "").toUpperCase();
  if (m.includes("REPORT_ALREADY_SUBMITTED")) {
    return { ok: false, code: "duplicate", error: "Bu içeriği zaten bildirdin." };
  }
  if (m.includes("REPORT_RATE_LIMITED")) {
    return { ok: false, code: "rate_limited", error: "Çok fazla bildirim gönderdin. Lütfen biraz sonra tekrar dene." };
  }
  if (m.includes("REPORT_TARGET_NOT_FOUND")) {
    return { ok: false, code: "target_not_found", error: "Bildirilen içerik artık bulunamıyor." };
  }
  if (m.includes("ACCOUNT_BANNED") || m.includes("ACCOUNT_SUSPENDED")) {
    return { ok: false, code: "not_allowed", error: "Hesabın kısıtlı olduğu için bu işlemi yapamazsın." };
  }
  if (m.includes("REPORT_NOT_ALLOWED")) {
    return { ok: false, code: "not_allowed", error: "Bu içerik bildirilemedi." };
  }
  return { ok: false, code: "unknown", error: "Bildirim gönderilemedi, tekrar dene." };
}

/* ──────────────────────────────────────────────────────────────────────────
   Raporlama RPC'leri — reporter/target/snapshot DAİMA sunucuda türetilir.
   ────────────────────────────────────────────────────────────────────────── */

/** Bir profili/kullanıcıyı bildirir (authenticated). */
export async function reportProfile(
  targetProfileId: string,
  reason: ReportReason,
  detail?: string | null,
): Promise<ReportResult> {
  const { error } = await supabase.rpc("report_profile", {
    p_target_profile: targetProfileId,
    p_reason: reason,
    p_detail: reason === "other" ? (detail ?? null) : null,
  });
  if (error) return mapReportError(error.message);
  return { ok: true };
}

/** Bir DM mesajını bildirir (yalnız konuşmanın alıcısı). message_id sunucuda
 *  doğrulanır; içerik snapshot'ı istemciden GÖNDERİLMEZ. */
export async function reportDmMessage(
  messageId: string,
  reason: ReportReason,
  detail?: string | null,
): Promise<ReportResult> {
  const { error } = await supabase.rpc("report_dm_message", {
    p_message_id: messageId,
    p_reason: reason,
    p_detail: reason === "other" ? (detail ?? null) : null,
  });
  if (error) return mapReportError(error.message);
  return { ok: true };
}

export interface ReportRoomMessageArgs {
  messageId: string;
  reason: ReportReason;
  /** Mod ayırıcı (duel, flag_duel, wheel_duel, wheel_group, duel_group,
   *  conquest, tevatur, flag_group, route_duel). Katılım doğrulaması için. */
  mode: string;
  /** Misafir raporlayan için oda oyuncu kimliği + claim token (auth'ta gerekmez). */
  playerId?: string | null;
  claimToken?: string | null;
  detail?: string | null;
}

/** Bir lobi/oda mesajını bildirir. Authenticated VEYA claim-token'lı misafir.
 *  Katılım + snapshot sunucuda doğrulanır; içerik istemciden gönderilmez. */
export async function reportRoomMessage(args: ReportRoomMessageArgs): Promise<ReportResult> {
  const { error } = await supabase.rpc("report_room_message", {
    p_message_id: args.messageId,
    p_reason: args.reason,
    p_mode: args.mode,
    p_player_id: args.playerId ?? null,
    p_claim_token: args.claimToken ?? null,
    p_detail: args.reason === "other" ? (args.detail ?? null) : null,
  });
  if (error) return mapReportError(error.message);
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────────────
   Hesap moderasyon durumu — kullanıcı kendi durumunu okur.
   ────────────────────────────────────────────────────────────────────────── */

export type ModerationStatus = "active" | "suspended" | "banned";

export interface MyModerationStatus {
  status: ModerationStatus;
  /** Yalnız suspended iken dolu; süresi geçmişse sunucu 'active' döndürür. */
  suspendedUntil: string | null;
}

/** Kendi moderasyon durumumu çeker (giriş/başlangıç akışı). Hata → 'active'
 *  (fail-open: geçici bir okuma hatası kullanıcıyı yanlışlıkla kilitlemesin). */
export async function getMyModerationStatus(): Promise<MyModerationStatus> {
  const { data, error } = await supabase.rpc("get_my_moderation_status");
  if (error || !data || typeof data !== "object") {
    if (error) console.error("get_my_moderation_status failed", error);
    return { status: "active", suspendedUntil: null };
  }
  const row = data as Record<string, unknown>;
  const status = (row.status as ModerationStatus) ?? "active";
  return {
    status: status === "suspended" || status === "banned" ? status : "active",
    suspendedUntil: (row.suspended_until as string) ?? null,
  };
}
