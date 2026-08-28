/**
 * quickMatchFreshness.ts — "HIZLI EŞLEŞ eski maçı açmasın" kararının SAF hâli.
 *
 * NEDEN AYRI MODÜL
 * ────────────────
 * Karar ağ+React bağımlı bir effect'in içinde gömülüyken test edilemiyordu ve
 * Çark Düello'da hiç yazılmamıştı. Burada yan etkisizdir ve
 * scripts/check-build9-blockers.ts tarafından DB'siz sürülür.
 *
 * SORUN (build 9 gerçek-cihaz blocker'ı)
 * ──────────────────────────────────────
 * `*_cancel_quick_match` RPC'leri BİLEREK yalnız `matched_room_id IS NULL`
 * satırlarını siler (canlı eşleşmede karşı tarafın realtime UPDATE'ini
 * bozmamak için). Sonuç: BİTMİŞ bir maçın kuyruk satırı `matched_room_id`
 * DOLU hâlde kalır. İstemcilerin "SELECT-first guard"ı ise kuyruk satırını
 * okuyup `matched_room_id` doluysa doğrudan o odaya bağlanır — yani
 * "Hızlı Eşleş" düğmesi önceki maçın kalıntısını "şu anki eşleşmem" sanar.
 *
 * Bayat durum SUNUCUDADIR; `localStorage` temizlemek çare DEĞİLDİR.
 *
 * ÜRÜN KURALI
 * ───────────
 * "HIZLI EŞLEŞ" = "bana ŞU AN geçerli bir maç bul".
 * ASLA = "eski oturumu sürdür". Bitmiş / terk edilmiş / silinmiş / bayat oda
 * YENİDEN AÇILAMAZ. (Kasıtlı reconnect AYRI bir üründür ve kendi doğrulama
 * yolundan geçer: oda var + üyelik var + claim geçerli + durum terminal değil.)
 *
 * İKİ KATMAN
 * ──────────
 *   1) Arama başlarken `*_reset_quick_match` kuyruk satırını KOŞULSUZ siler.
 *   2) Bu karar: oda TAZE olduğu kanıtlanmadan arama state'ine dokunulmaz.
 * (2) olmadan (1) tek nokta hatasıdır: reset RPC'si ağ hatasıyla düşerse eski
 * oda yine açılır.
 *
 * "TAZE" TANIMI
 * ─────────────
 * Hızlı Eşleş odasını SUNUCU kurar: `status='playing'` ve
 * `started_at = now() + 3 sn`. Dolayısıyla gerçek bir eşleşmede
 * `syncedNow − started_at` ∈ [−3 sn, birkaç sn] aralığındadır. Bundan eski
 * ya da `playing` olmayan her şey ÖNCEKİ maçın kalıntısıdır.
 *
 * Saat: karşılaştırma SUNUCU-SENKRON saatle yapılır (`getSyncedNowMs`);
 * cihazın birkaç saniyelik sapması taze bir odayı bayat göstermemeli.
 */

/** Taze bir Hızlı Eşleş odasının olabileceği EN BÜYÜK yaş (ms). */
export const QUICK_MATCH_FRESH_ROOM_MAX_AGE_MS = 30_000;

/** Karar verilirken bakılan minimum oda alanları (mod-agnostik). */
export interface QuickMatchRoomProbe {
  status?:     string | null;
  started_at?: string | null;
}

export type QuickMatchJoinDecision =
  /** Oda taze — arama state'i sökülüp maça bağlanılabilir. */
  | { action: "join" }
  /**
   * Bağlanma. Arama state'ine DOKUNULMAZ: interval'ler dönmeye devam eder,
   * "İptal" düğmesi çalışır ve gerçek bir eşleşme hâlâ gelebilir.
   *   room_unreadable → oda okunamadı/silinmiş (geçici de olabilir)
   *   stale_room      → bitmiş/terk edilmiş/eski oda
   */
  | { action: "keep-searching"; reason: "room_unreadable" | "stale_room" };

/**
 * Eşleşme sinyalindeki `matched_room_id` GERÇEKTEN şu anki maç mı?
 *
 * `fetchFailed` ayrı bir girdidir: okunamayan oda "bayat" DEĞİLDİR — kullanıcıyı
 * kurulum ekranına düşürmek yerine aramayı sürdürmek doğru davranıştır (eski
 * Çark akışı burada aramayı öldürüp "Eşleşilen oda bulunamadı" gösteriyordu).
 */
export function decideQuickMatchJoin(input: {
  room:        QuickMatchRoomProbe | null | undefined;
  fetchFailed?: boolean;
  syncedNowMs: number;
}): QuickMatchJoinDecision {
  const { room, fetchFailed, syncedNowMs } = input;

  if (fetchFailed || !room) return { action: "keep-searching", reason: "room_unreadable" };

  if (room.status !== "playing") return { action: "keep-searching", reason: "stale_room" };

  const startedAtMs = room.started_at ? Date.parse(room.started_at) : Number.NaN;
  if (!Number.isFinite(startedAtMs) || startedAtMs === 0) {
    return { action: "keep-searching", reason: "stale_room" };
  }
  if (!Number.isFinite(syncedNowMs)) {
    // Saat bilinmiyorsa "taze" İDDİA EDİLEMEZ; aramayı sürdür.
    return { action: "keep-searching", reason: "stale_room" };
  }
  if (syncedNowMs - startedAtMs > QUICK_MATCH_FRESH_ROOM_MAX_AGE_MS) {
    return { action: "keep-searching", reason: "stale_room" };
  }

  return { action: "join" };
}
