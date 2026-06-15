/**
 * username.ts — merkezi hesap kullanıcı-adı mantığı (display + key sistemi).
 *
 * Tek doğruluk kaynağı: ekranda görünen ad (`username`, kullanıcı ne yazdıysa
 * Türkçe karakterleri ve büyük/küçük harfiyle korunur) ile benzersizlik anahtarı
 * (`username_key` / DB'de `username_normalized`) ayrı tutulur. Anahtar Türkçe
 * karakterleri ASCII'ye katlar, böylece "padır" ve "padir" AYNI kabul edilir.
 *
 * Bu modüldeki fonksiyonlar hem ilk-giriş NicknameModal'ında hem de profil
 * panelindeki "Adı Değiştir" akışında kullanılır. Aynı katlama mantığı
 * server (Postgres `public.username_key()`) tarafıyla birebir aynıdır; ayrıntı
 * için bkz. migration `*_username_key_system.sql`.
 *
 * NOT: Bu modül, oyun-içi misafir görünen-ad doğrulaması yapan
 * `auth.ts` → validateUsername/normalizeUsername helper'larıyla KARIŞTIRILMAMALI.
 * Onlar ayrı (3-16, ASCII+Türkçe, nokta/tire yok) kuralları korur ve dokunulmaz.
 */
import { supabase } from "./supabase";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

// Yasaklı/saklı kullanıcı adları — TAM eşleşme (server change_username RPC'deki
// v_banned dizisiyle birebir aynı; alt-dize değil). Böylece "torble-oyuncu" gibi
// adlar serbest kalırken "torble" / "admin" gibi birebir taklitler reddedilir.
const USERNAME_RESERVED: ReadonlySet<string> = new Set([
  "admin", "administrator", "moderator", "mod", "system", "sistem",
  "torble", "bot", "npc", "test", "support", "destek", "official",
  "owner", "root", "staff", "null", "undefined", "geoquiz", "geo_quiz",
  "developer", "dev", "yetkili", "kurucu", "yonetici", "help", "helper",
]);

// Görünen ad: Unicode harf/rakam + alt çizgi, nokta, tire. Boşluk/emoji/@ yok.
const USERNAME_DISPLAY_REGEX = /^[\p{L}\p{N}_.-]+$/u;
// Katlanmış anahtar daima ASCII olmalı (Türkçe + yaygın Latin aksanları katlanır).
const USERNAME_KEY_REGEX = /^[a-z0-9_.-]+$/;

// Görünmez / format / kontrol karakterleri (zero-width, BOM, soft-hyphen, kontrol
// karakterleri). Kaynakta literal görünmez karakter bulundurmamak için \u ile.
const INVISIBLE_CHARS_REGEX = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]",
  "g"
);

// Türkçe + yaygın Latin aksanlarını ASCII'ye katlayan tek harita. Postgres
// `public.username_key()` ile birebir aynı tutulmalı.
const FOLD_MAP: Record<string, string> = {
  ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u",
  à: "a", á: "a", â: "a", ä: "a", ã: "a", å: "a",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ò: "o", ó: "o", ô: "o", õ: "o",
  ù: "u", ú: "u", û: "u",
  ñ: "n", ý: "y", ÿ: "y",
};
const FOLD_REGEX = /[çğıöşüàáâäãåèéêëìíîïòóôõùúûñýÿ]/g;

/**
 * Kullanıcı girişini güvenli hale getirir: baştaki '@' işaret(ler)ini atar,
 * baş/son boşlukları kırpar, görünmez/kontrol karakterlerini temizler.
 * Boşlukları İÇERİDE temizlemez — boşluk validasyonda reddedilir (daha net hata).
 */
export function sanitizeUsernameInput(raw: string): string {
  return (raw ?? "")
    .replace(INVISIBLE_CHARS_REGEX, "")
    .replace(/^@+/, "")
    .trim();
}

/**
 * Benzersizlik anahtarını üretir: sanitize → Türkçe/aksan katlama → küçük harf.
 * "padır" ve "padir" → "padir"; "Çağrı" → "cagri"; "İbrahim" → "ibrahim".
 * Locale bağımsız olması için İ/I/ı önce 'i'ye sabitlenir (toLowerCase'ten önce).
 */
export function normalizeUsernameKey(raw: string): string {
  let v = sanitizeUsernameInput(raw);
  // Türkçe noktalı/noktasız I'yı locale-bağımsız sabitlemek için lower'dan önce.
  v = v.replace(/[İIı]/g, "i");
  v = v.toLowerCase();
  v = v.replace(FOLD_REGEX, (ch) => FOLD_MAP[ch] ?? ch);
  return v;
}

/**
 * Görünen kullanıcı adını doğrular. Hata varsa Türkçe mesaj, yoksa null döner.
 * Hem format (görünen ad) hem de katlanmış anahtar (ASCII + yasaklı kelime)
 * kontrol edilir. Otorite server'daki change_username RPC + unique index'tir;
 * bu sadece anlık UI geri bildirimi içindir.
 */
export function validateUsername(raw: string): string | null {
  const display = sanitizeUsernameInput(raw);

  if (display.length === 0) {
    return "Geçerli bir kullanıcı adı seçmelisin.";
  }
  if (/\s/.test(display)) {
    return "Kullanıcı adında boşluk olamaz.";
  }
  if (display.length < USERNAME_MIN_LENGTH) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }
  if (display.length > USERNAME_MAX_LENGTH) {
    return "Kullanıcı adı en fazla 20 karakter olabilir.";
  }
  if (!USERNAME_DISPLAY_REGEX.test(display)) {
    return "Sadece harf, rakam, nokta, tire ve alt çizgi kullanabilirsin.";
  }

  const key = normalizeUsernameKey(display);
  if (key.length < USERNAME_MIN_LENGTH) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }
  if (!USERNAME_KEY_REGEX.test(key)) {
    // Katlanamayan (Türkçe/Latin dışı) harfler — anahtar ASCII olamadı.
    return "Sadece harf, rakam, nokta, tire ve alt çizgi kullanabilirsin.";
  }
  if (USERNAME_RESERVED.has(key)) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  return null;
}

/**
 * Sunucu tarafı müsaitlik kontrolü (canlı UI geri bildirimi). Otorite değildir;
 * gerçek garanti yazma anındaki username_normalized unique index'idir. RPC
 * `is_username_available` security-definer'dır, profiles SELECT RLS'inden bağımsız
 * çalışır ve kendi profilini hariç tutar.
 */
export async function checkUsernameAvailability(
  raw: string
): Promise<{ available: boolean; error?: string }> {
  const key = normalizeUsernameKey(raw);
  if (key.length < USERNAME_MIN_LENGTH) {
    return { available: false };
  }
  const { data, error } = await supabase.rpc("is_username_available", {
    p_username: raw,
  });
  if (error) {
    return { available: false, error: error.message };
  }
  return { available: data === true };
}
