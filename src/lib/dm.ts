/**
 * dm.ts — Birebir özel mesaj (DM) için tipli Supabase RPC sarmalayıcıları.
 *
 * TASARIM:
 *   - Tüm yazma yolları SECURITY DEFINER RPC'lerden geçer (bkz.
 *     20260718160000_direct_messages.sql). sender daima server'da auth.uid()'den
 *     belirlenir; client başka kullanıcı adına mesaj atamaz.
 *   - Yalnız karşılıklı arkadaşlar (friends) + engellenmemiş kullanıcılar
 *     mesajlaşabilir; doğrulama server'da.
 *   - Okuma: dm_conversations / dm_messages RLS yalnız tarafa açık.
 *   - Realtime: dm_messages INSERT aboneliği, recipient_id=<me> filtresiyle
 *     yalnız KENDİNE gelen mesajlar (lobby chat'in postgres_changes desenine
 *     benzer, ama tamamen ayrı kanal/tablo).
 *
 * Lobby/oda chat altyapısından AYRIDIR: duel_messages tablosuna hiç dokunmaz.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/* ──────────────────────────────────────────────────────────────────────────
   Tipler
   ────────────────────────────────────────────────────────────────────────── */

export interface DmMessage {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface DmUnreadSummary {
  /** Tüm konuşmalardaki toplam okunmamış mesaj. */
  total: number;
  /** Gönderen (arkadaş) profil id → okunmamış sayısı. */
  byUser: Record<string, number>;
}

export const EMPTY_DM_UNREAD: DmUnreadSummary = { total: 0, byUser: {} };

export interface SendDmResult {
  ok: boolean;
  message?: DmMessage;
  /** Hata kodu (rate_limited / duplicate_message / not_friends / blocked_between / ...). */
  code?: string;
  /** Kullanıcıya gösterilebilir Türkçe mesaj. */
  error?: string;
}

/* ──────────────────────────────────────────────────────────────────────────
   Hata mesajları
   ────────────────────────────────────────────────────────────────────────── */

export function describeDmError(message: string | undefined | null): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("not_friends")) return "Yalnızca arkadaşlarına mesaj gönderebilirsin.";
  if (m.includes("blocked_between")) return "Bu kullanıcıyla mesajlaşamazsın.";
  if (m.includes("rate_limited")) return "Çok hızlı yazıyorsun, biraz yavaşla.";
  if (m.includes("unread_limit"))
    return "Karşı taraf mevcut mesajlarını görmeden en fazla 10 mesaj gönderebilirsin.";
  if (m.includes("duplicate_message")) return "Aynı mesajı arka arkaya gönderemezsin.";
  if (m.includes("empty_message")) return "Boş mesaj gönderilemez.";
  if (m.includes("message_too_long")) return "Mesaj en fazla 500 karakter olabilir.";
  if (m.includes("invalid_recipient")) return "Bu kişiye mesaj gönderilemez.";
  if (m.includes("auth_required")) return "Bu işlem için giriş yapmalısın.";
  if (m.includes("not_participant")) return "Bu konuşmayı görüntüleyemezsin.";
  return "Mesaj gönderilemedi, tekrar dene.";
}

/* ──────────────────────────────────────────────────────────────────────────
   Satır eşleme (snake_case RPC → camelCase)
   ────────────────────────────────────────────────────────────────────────── */

function mapMessage(r: Record<string, unknown>): DmMessage {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    senderId: r.sender_id as string,
    recipientId: r.recipient_id as string,
    content: (r.content as string) ?? "",
    createdAt: r.created_at as string,
    readAt: (r.read_at as string) ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   RPC sarmalayıcıları
   ────────────────────────────────────────────────────────────────────────── */

/** Arkadaşla konuşmayı çözer/oluşturur (canonical çift) → conversation id. */
export async function getOrCreateConversation(otherProfileId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("dm_get_or_create_conversation", {
    p_other: otherProfileId,
  });
  if (error) {
    console.error("dm_get_or_create_conversation failed", error);
    return null;
  }
  const r = (data ?? {}) as { ok?: boolean; conversation_id?: string };
  return r.ok && r.conversation_id ? r.conversation_id : null;
}

/** Mesaj gönderir. sender server'da auth.uid()'den; conversation server'da çözülür. */
export async function sendDirectMessage(
  recipientProfileId: string,
  content: string
): Promise<SendDmResult> {
  const text = content.trim();
  if (text.length === 0) return { ok: false, code: "empty_message", error: "Boş mesaj gönderilemez." };
  const { data, error } = await supabase.rpc("dm_send_message", {
    p_recipient: recipientProfileId,
    p_content: text,
  });
  if (error) {
    const code = (error.message ?? "").trim();
    return { ok: false, code, error: describeDmError(code) };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  if (!r.ok) {
    return { ok: false, error: "Mesaj gönderilemedi, tekrar dene." };
  }
  return { ok: true, message: mapMessage(r) };
}

/**
 * Konuşma geçmişini server'dan getirir (tek gerçek kaynak). Hatayı AÇIKÇA
 * bildirir: çağıran, başarısız/boş bir fetch ile ekrandaki bilinen-iyi listeyi
 * YANLIŞLIKLA boşaltmasın diye `ok`'a bakar. (Boş başarı `ok:true, rows:[]`.)
 */
export async function fetchConversationHistory(
  conversationId: string,
  limit = 50
): Promise<{ ok: boolean; rows: DmMessage[] }> {
  const { data, error } = await supabase.rpc("dm_list_messages", {
    p_conversation: conversationId,
    p_limit: limit,
  });
  if (error || !Array.isArray(data)) {
    if (error) console.error("dm_list_messages failed", error);
    return { ok: false, rows: [] };
  }
  return { ok: true, rows: (data as Record<string, unknown>[]).map(mapMessage) };
}

/**
 * Konuşmayı YALNIZ çağıran kullanıcı için temizler (per-user cleared_at).
 * Mesajlar fiziksel silinmez; karşı taraf tüm geçmişi görmeye devam eder.
 * Dönüş: başarı durumu.
 */
export async function clearConversationForMe(conversationId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("dm_clear_conversation", {
    p_conversation: conversationId,
  });
  if (error) {
    console.error("dm_clear_conversation failed", error);
    return false;
  }
  const r = (data ?? {}) as { ok?: boolean };
  return r.ok === true;
}

/** Bu konuşmadaki bana gelen okunmamışları okundu yapar. Donus: okundu sayısı. */
export async function markConversationRead(conversationId: string): Promise<number> {
  const { data, error } = await supabase.rpc("dm_mark_read", {
    p_conversation: conversationId,
  });
  if (error) {
    console.error("dm_mark_read failed", error);
    return 0;
  }
  const r = (data ?? {}) as { updated?: number };
  return r.updated ?? 0;
}

/** Tüm konuşmalardaki okunmamış özeti (toplam + arkadaş başına). */
export async function fetchDmUnreadSummary(): Promise<DmUnreadSummary> {
  const { data, error } = await supabase.rpc("dm_unread_summary");
  if (error) {
    console.error("dm_unread_summary failed", error);
    return EMPTY_DM_UNREAD;
  }
  const r = (data ?? {}) as { total?: number; by_user?: Record<string, number> };
  return {
    total: r.total ?? 0,
    byUser: (r.by_user as Record<string, number>) ?? {},
  };
}

/**
 * Bana gelen YENİ DM'leri dinler (dm_messages INSERT, recipient_id=<me>).
 * RLS + filtre sayesinde yalnız giriş yapan kullanıcının verisi gelir.
 * Çağıran dönen channel'ı saklar ve unmount'ta supabase.removeChannel çağırır.
 */
export function subscribeDirectMessages(
  profileId: string,
  onInsert: (msg: DmMessage) => void
): RealtimeChannel {
  return supabase
    .channel(`dm:${profileId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "dm_messages",
        filter: `recipient_id=eq.${profileId}`,
      },
      (payload) => {
        if (payload.new) onInsert(mapMessage(payload.new as Record<string, unknown>));
      }
    )
    .subscribe();
}
