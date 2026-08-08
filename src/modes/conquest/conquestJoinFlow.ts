/**
 * conquestJoinFlow.ts — Kuşatma katılma HATASININ tek karar noktası.
 *
 * NEDEN AYRI (VE SAF) BİR MODÜL:
 * Katılma başarısız olduğunda "kullanıcı hangi ekranda kalır" kararı eskiden
 * `ConquestMode.applyJoinResult` içinde gömülüydü ve her hata için
 * `setPhase("setup")` diyordu — yani sunucu nick'i reddettiğinde oyuncu oda
 * kodu + nick formundan DÜŞÜP "Oda Kur" ekranına atılıyordu. Karar buraya
 * taşındı ki (a) tek yerde dursun, (b) React/Supabase olmadan test edilebilsin
 * (`scripts/check-conquest-join-errors.ts`).
 *
 * BU MODÜL SUPABASE İMPORT ETMEZ. Node altında saf çalışması gerekir; buraya
 * bir istemci bağımlılığı eklenirse test scripti kırılır.
 *
 * GÜVENLİK NOTU: burada hiçbir kural GEVŞETİLMEZ. Kayıtlı-username koruması,
 * kapasite, oda durumu ve yasaklı ad kararlarının tamamı sunucudaki
 * `conquest_register_player` / `assert_display_name_allowed` içindedir. Bu
 * modül yalnız sunucunun VERDİĞİ "hayır"ı kullanıcıya doğru ekranda gösterir.
 */

/* ════════════════════════════════════════════════════════════════════════
   1) Hata sebepleri + kullanıcıya gösterilen metinler
   ════════════════════════════════════════════════════════════════════════ */

export type ConquestJoinFailReason =
  | "not-found"   // Bu kodla oda yok
  | "full"        // Oda max_players'a ulaştı
  | "started"     // Oda status="playing"
  | "closed"      // Oda status="finished" | "closed"
  | "guest-only"  // Açık oda listesi giriş ister (frontend kuralı)
  | "name"        // Görünen ad reddedildi (kayıtlı/yasaklı/çakışan/geçersiz)
  | "error";      // Ağ / DB hatası

export interface ConquestJoinFail {
  ok: false;
  reason:  ConquestJoinFailReason;
  message: string;
}

/** Lobi/katılma ekranlarının kullandığı yerelleştirilmiş hata metinleri. */
export const CONQUEST_JOIN_FAIL_MESSAGES: Record<ConquestJoinFailReason, string> = {
  "not-found":   "Kuşatma odası bulunamadı.",
  "full":        "Bu Kuşatma odası dolu.",
  "started":     "Bu Kuşatma oyunu başlamış.",
  "closed":      "Bu Kuşatma odası kapanmış.",
  "guest-only":  "Açık Kuşatma odalarına katılmak için giriş yapmalısın.",
  "name":        "Bu kullanıcı adı kullanılamaz. Lütfen farklı bir ad seç.",
  "error":       "Bağlantı sorunu. Lütfen tekrar dene.",
};

export function conquestFail(
  reason: ConquestJoinFailReason,
  override?: string,
): ConquestJoinFail {
  return { ok: false, reason, message: override ?? CONQUEST_JOIN_FAIL_MESSAGES[reason] };
}

/* ════════════════════════════════════════════════════════════════════════
   2) Sunucu hata kodu → kullanıcı metni
   ════════════════════════════════════════════════════════════════════════
   `conquest_register_player` hatayı Postgres mesajı olarak fırlatır. Ham
   mesaj UI'ya SIZDIRILMAZ; bilinen kodlar diğer modlarla aynı Türkçe
   cümlelere çevrilir. Sıra önemlidir: `registered_username_taken` metni
   `name_taken` alt dizesini İÇERİR, bu yüzden ondan ÖNCE denenmelidir. */

/** Ad kaynaklı ret kodları — hepsi kullanıcının DÜZELTEBİLECEĞİ hatalardır,
 *  dolayısıyla form açık kalmalı ve odak ad alanına dönmelidir. */
const NAME_FAILURES: ReadonlyArray<{ code: string; message: string }> = [
  {
    code: "registered_username_taken",
    message:
      "Bu kullanıcı adı kayıtlı bir hesaba ait. Başka bir ad seç veya hesabına giriş yap.",
  },
  {
    code: "display_name_forbidden",
    message: "Bu kullanıcı adı kullanılamaz. Lütfen farklı bir ad seç.",
  },
  {
    code: "name_taken",
    message: "Bu kullanıcı adı odada kullanılıyor. Başka bir kullanıcı adı seç.",
  },
  {
    code: "name_invalid",
    message: "Kullanıcı adı 2-16 karakter olmalı.",
  },
];

/** Oda kaynaklı ret kodları — ad değiştirmek çözmez, ama kullanıcı yine de
 *  KODU düzeltip başka bir odaya girebilir; form yine açık kalır. */
const ROOM_FAILURES: ReadonlyArray<{ code: string; reason: ConquestJoinFailReason }> = [
  { code: "room_full",        reason: "full" },
  { code: "room_in_progress", reason: "started" },
  { code: "room_unavailable", reason: "closed" },
  { code: "room_not_found",   reason: "not-found" },
];

/**
 * Ham sunucu hata metnini tek bir `ConquestJoinFail`e çevirir.
 * `fallback` bilinmeyen hatalar için kullanılır (ham Postgres mesajı).
 */
export function mapConquestJoinFailure(raw: string, fallback?: string): ConquestJoinFail {
  const text = raw ?? "";

  for (const { code, reason } of ROOM_FAILURES) {
    if (text.includes(code)) return conquestFail(reason);
  }
  if (text.includes("already_in_room")) {
    return conquestFail("error", "Bu odaya zaten katıldın.");
  }
  for (const { code, message } of NAME_FAILURES) {
    if (text.includes(code)) return conquestFail("name", message);
  }
  return conquestFail("error", fallback || "Odaya katılınamadı.");
}

/* ════════════════════════════════════════════════════════════════════════
   3) Hata sonrası NEREDE kalınır?
   ════════════════════════════════════════════════════════════════════════ */

/** Katılma denemesinin nereden başladığı. Hata sonrası dönülecek ekranı bu
 *  belirler — kullanıcı GELDİĞİ yerde kalır, ana menüye/oda kurmaya atılmaz. */
export type ConquestJoinOrigin =
  | "code"    // "Oda Koduyla Katıl" formu (kod + nick aynı ekranda)
  | "invite"  // Davet linki / oda kodu çözümleyici → otomatik katılma
  | "public"; // Açık oda listesinden katılma (yalnız girişli kullanıcı)

/** Hata sonrası formu yeniden doldurmak için saklanan taslak. */
export interface ConquestJoinDraft {
  code: string;
  name: string;
}

export interface ConquestJoinFailureOutcome {
  /** Hata sonrası render edilecek faz. ASLA "setup" ya da ana menü değildir. */
  phase: "join-code" | "rooms";
  /** Forma geri yazılacak değerler — oda kodu ve nick KAYBOLMAZ. */
  draft: ConquestJoinDraft;
  /** Formda gösterilecek hata metni. */
  message: string;
  /** true → odağı ad alanına ver (kullanıcının düzelteceği alan orası). */
  focusName: boolean;
}

/**
 * Başarısız bir katılma denemesinden sonra kullanıcının kalacağı yeri
 * hesaplar.
 *
 * DEĞİŞMEZLER (regresyon testi bunları doğrular):
 *   • Dönen faz asla "setup" değildir → "Oda Kur" ekranına düşürülmez.
 *   • Denenen oda kodu ve nick taslakta AYNEN korunur.
 *   • Mesaj boş bırakılmaz (kullanıcı sessiz bir başarısızlık görmez).
 *
 * Bu fonksiyon YALNIZ hata dalında çağrılır; başarı dalı dokunulmadan
 * doğrudan lobiye geçer.
 */
export function resolveConquestJoinFailure(
  origin:    ConquestJoinOrigin,
  attempted: ConquestJoinDraft,
  fail:      ConquestJoinFail,
): ConquestJoinFailureOutcome {
  return {
    // Açık oda listesinden gelen kullanıcı listede kalır; diğer iki yol
    // (form + davet linki) kod/nick formuna düşer — davet linkinde form
    // kodu ZATEN dolu açılır, kullanıcı yalnız adını düzeltir.
    phase: origin === "public" ? "rooms" : "join-code",
    draft: { code: attempted.code, name: attempted.name },
    message: fail.message || CONQUEST_JOIN_FAIL_MESSAGES[fail.reason],
    focusName: fail.reason === "name",
  };
}
