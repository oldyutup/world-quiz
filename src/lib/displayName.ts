/**
 * displayName.ts — OYUN-İÇİ görünen ad kuralları (saf, yan-etkisiz).
 *
 * TEK DOĞRULUK KAYNAĞI. Bir oyuncunun bir odada görüneceği ad — ister kayıtlı
 * kullanıcının hesap adı olsun, ister misafirin seçtiği nick — bu dosyadaki
 * kurallardan geçer. İki ayrı doğrulama sistemi YOKTUR.
 *
 * Tüketiciler:
 *   • auth.ts        → validateUsername / normalizeUsername olarak re-export
 *                      eder (mevcut çağıranlar değişmeden çalışır).
 *   • guestSession.ts → misafir nick ekranı aynı fonksiyonu kullanır.
 *
 * NEDEN AYRI DOSYA: auth.ts, supabase client'ı ve avatar PNG'lerini import
 * ediyor; bu yüzden Node altındaki test scriptlerinden (scripts/check-*.ts)
 * import EDİLEMİYOR. Kuralları saf bir modüle çekmek onları test edilebilir
 * yapar — roomCodeShared.ts ile aynı desen.
 *
 * SUNUCU AYNASI: Bu kurallar `public.assert_display_name_allowed`
 * (20260704120000 + 20260705130000 + 20260806120000) ile uyumlu olmalıdır.
 * Sunucu 2–16 karakter kabul eder ve kendi yasaklı-kelime listesini uygular;
 * client 3–16 ile daha katıdır (uyumlu). Otorite HER ZAMAN sunucudur.
 *
 * NOT: Bu, HESAP kullanıcı adı kurallarıyla (username.ts: 3–20, Unicode,
 * nokta/tire serbest) KARIŞTIRILMAMALI. O ayrı bir katmandır ve dokunulmadı.
 */
import { BANNED_USERNAME_WORDS } from "../data/bannedUsernames";

/** Oyun-içi görünen ad: küçük harf + rakam + alt çizgi + Türkçe karakterler. */
const USERNAME_REGEX = /^[a-z0-9_çğıöşü]{3,16}$/;

/**
 * Karşılaştırma biçimi. SUNUCUNUN `lower(btrim(name))` davranışının aynası:
 * "Enes", "enes" ve "  ENES  " AYNI kabul edilir.
 */
export function normalizeUsername(username: string) {
  return username.trim().toLocaleLowerCase("tr-TR");
}

/**
 * Görünen adı doğrular. Hata varsa Türkçe mesaj, geçerliyse null döner.
 * Otorite sunucudaki assert_display_name_allowed'dır; bu anlık UI geri
 * bildirimi içindir.
 */
export function validateUsername(usernameRaw: string): string | null {
  const username = normalizeUsername(usernameRaw);

  if (username.length < 3) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }

  if (username.length > 16) {
    return "Kullanıcı adı en fazla 16 karakter olabilir.";
  }

  if (!USERNAME_REGEX.test(username)) {
    return "Sadece küçük harf, rakam, alt çizgi ve Türkçe karakter kullanabilirsin.";
  }

  const hasBannedWord = BANNED_USERNAME_WORDS.some((word) =>
    username.includes(word)
  );

  if (hasBannedWord) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  return null;
}
