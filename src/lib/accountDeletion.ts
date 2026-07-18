import {
  FunctionsFetchError,
  FunctionsHttpError,
} from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Hesap silme istemci yardımcıları (App Store hesap silme).
 *
 * Sunucu tarafı: delete-account Edge Function — JWT sahibini doğrular,
 * (varsa) Apple token revocation dener, auth.admin.deleteUser ile hard
 * delete yapar. profiles ON DELETE CASCADE + trg_account_deletion_cleanup
 * trigger'ı FK'sız oyun verisini aynı DB transaction'ında anonimleştirir;
 * yani buradan dönen başarı "her şey ya tamamen silindi ya hiç" demektir.
 *
 * Bu modül üç şey sağlar:
 *   • currentUserHasAppleIdentity — Apple sheet gerekip gerekmediği kararı
 *   • deleteAccount               — Edge Function çağrısı (JWT'yi
 *     functions.invoke oturumdan otomatik ekler; body'de user_id YOKTUR)
 *   • purgeLocalAccountData       — claim token'ları + kullanıcıya bağlı
 *     local cache temizliği ve salt-yerel signOut
 */

export type AppleRevocationStatus =
  | "revoked"
  | "failed"
  | "skipped_no_code"
  | "skipped_config"
  | "not_applicable";

export type DeleteAccountResult =
  | { ok: true; appleRevocation: AppleRevocationStatus }
  /** sessionLost: oturum kurtarılamadı — hesap silinmiş OLABİLİR ama kesin
   *  değil; yerel auth/cache/claim verileri temizlendi. UI kesin "silindi"
   *  DEMEMELİ, tarafsız mesajı göstermeli. Genel 401 asla ok:true yapılmaz. */
  | { ok: false; message: string; sessionLost?: boolean };

const RETRYABLE_MESSAGE =
  "Hesap silinemedi. Bağlantını kontrol edip tekrar dene.";
export const SESSION_LOST_MESSAGE =
  "Oturum sona erdi. Hesap silme işlemi tamamlanmış olabilir. " +
  "Tekrar giriş yapmayı deneyerek hesabın durumunu kontrol edebilirsin.";

/** 401 / belirsiz ağ hatası: "hesap az önce silindi ama yanıt kaybold" ile
 *  "oturum süresi doldu" istemciden ayırt edilemez. Akış:
 *    1. refreshSession TEK KEZ denenir → oturum canlanırsa hesap büyük
 *       ihtimalle duruyor → normal, tekrar denenebilir hata.
 *    2. getUser hâlâ kullanıcı döndürüyorsa → yine normal hata.
 *    3. İkisi de başarısızsa oturum kurtarılamaz → yerel auth/cache/claim
 *       temizliği + salt-yerel signOut yapılır ve sessionLost işaretli
 *       TARAFSIZ mesaj döner. Sahte başarı üretilmez; retry döngüsü yok. */
async function resolveAmbiguousDeleteFailure(): Promise<DeleteAccountResult> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) {
      return { ok: false, message: RETRYABLE_MESSAGE };
    }
  } catch {
    /* refresh yolu kapalı — aşağıya düş */
  }

  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      return { ok: false, message: RETRYABLE_MESSAGE };
    }
  } catch {
    /* kullanıcı alınamıyor */
  }

  purgeLocalAccountData();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* oturum zaten geçersiz */
  }
  return { ok: false, sessionLost: true, message: SESSION_LOST_MESSAGE };
}

export async function currentUserHasAppleIdentity(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return false;
  if ((user.identities ?? []).some((i) => i.provider === "apple")) return true;
  const metaProviders =
    (user.app_metadata?.providers as string[] | undefined) ?? [];
  return metaProviders.includes("apple");
}

export async function deleteAccount(
  appleAuthorizationCode?: string
): Promise<DeleteAccountResult> {
  try {
    const { data, error } = await supabase.functions.invoke("delete-account", {
      body: appleAuthorizationCode ? { appleAuthorizationCode } : {},
    });
    if (error) {
      // 401 (silinmiş kullanıcı JWT'si VEYA süresi dolmuş oturum) ve ağ
      // hataları belirsizdir → oturum-durumu çözümlemesine git. Diğer HTTP
      // hataları (500 vb.) normal, tekrar denenebilir hatadır.
      const status =
        error instanceof FunctionsHttpError
          ? (error.context as Response | undefined)?.status
          : undefined;
      if (status === 401 || error instanceof FunctionsFetchError) {
        return resolveAmbiguousDeleteFailure();
      }
      return { ok: false, message: RETRYABLE_MESSAGE };
    }
    if (!data?.ok) {
      return {
        ok: false,
        message: "Hesap silinemedi. Lütfen tekrar dene.",
      };
    }
    return {
      ok: true,
      appleRevocation: (data.appleRevocation as AppleRevocationStatus) ??
        "not_applicable",
    };
  } catch {
    // invoke'un kendisinin fırlatması = belirsiz ağ hatası.
    return resolveAmbiguousDeleteFailure();
  }
}

/* ── Yerel temizlik ──────────────────────────────────────────────────── */

/** Oyun-modu oturum anahtarı önekleri: player_id / room (içinde claimToken
 *  taşıyan JSON) / claim_token hepsi bu öneklerin altında yaşar. Guest
 *  kimlikleri (…_guest_id) cihaza aittir, hesaba değil — korunur (uygulamanın
 *  kendi clearDuelSession davranışıyla tutarlı). */
const MODE_SESSION_PREFIXES = [
  "geoquiz_duel",        // Ülke Yazmaca 1v1 (player/room+claim)
  "geoquiz_flagduel",    // Bayrak 1v1
  "geoquiz_flaggroup",   // Bayrak Bilmece grup
  "geoquiz_group",       // Ülke Yazmaca grup
  "geoquiz_wheel_duel",  // Çark 1v1 (+ _claim_token)
  "geoquiz_wheel_group", // Çark grup (+ _claim_token)
  "geoquiz_kornokta",    // Kör Nokta (+ _claim_token)
  "torble_route_duel",   // Rota 1v1 (+ _claim_token)
  "conquest:claim:",     // Kuşatma per-player claim token'ları
];

/** Kullanıcıya bağlı cache anahtarları (hesapla anlamını yitirir). */
const USER_CACHE_PREFIXES = ["torble_ach_stats_", "torble_ach_unlocks_"];
const USER_CACHE_KEYS = [
  "geoquiz_gold",
  "geoquiz_daily_bonus",
  "geoquiz_pending_username",
];

export function purgeLocalAccountData(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.endsWith("guest_id")) continue; // cihaz kimliği — hesaba ait değil
      const prefixed =
        MODE_SESSION_PREFIXES.some((p) => k.startsWith(p)) ||
        USER_CACHE_PREFIXES.some((p) => k.startsWith(p));
      if (prefixed || USER_CACHE_KEYS.includes(k)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage erişilemez — best effort */
  }
  try {
    sessionStorage.clear(); // davet linki / pending-target gibi geçici durum
  } catch {
    /* best effort */
  }
}

/** Silme başarısından sonra çağrılır: yerel veriyi temizler, oturumu YALNIZ
 *  yerel olarak kapatır (sunucudaki kullanıcı zaten yok — network çağrısı
 *  hata verirdi) ve uygulamayı giriş yapılmamış köke döndürür. Tam sayfa
 *  yenileme DM/presence/unread gibi kullanıcıya bağlı tüm React state'ini
 *  sıfırlar. */
export async function finalizeAccountDeletion(): Promise<void> {
  purgeLocalAccountData();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* oturum zaten geçersiz olabilir */
  }
  window.location.replace("/");
}
