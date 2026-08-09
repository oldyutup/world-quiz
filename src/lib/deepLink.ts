/**
 * deepLink.ts — native (Capacitor) davet bağlantısı yakalayıcı.
 *
 * SORUN:
 * Native kabukta uygulama `capacitor://localhost` üzerinden çalışır. iOS bir
 * Universal Link'i (https://torble.com/?duel=AB12C) uygulamaya teslim ettiğinde
 * webview'in adresi DEĞİŞMEZ — bağlantı bir `appUrlOpen` olayı olarak gelir.
 * Yani App.tsx'in `window.location.search` okuyan mevcut davet mantığı native'de
 * hiçbir şey görmez.
 *
 * ÇÖZÜM:
 * Gelen URL'in query parametresini okuyup mevcut webview adresine YAZARIZ
 * (history.replaceState) ve sonra App'e haber veririz. Böylece davet akışı
 * web ile TAMAMEN AYNI kod yolundan geçer — native'e özel ikinci bir katılma
 * sistemi yoktur.
 *
 * KAPSANAN DURUMLAR:
 *   • Uygulama arka planda → `appUrlOpen` anında gelir, callback tetiklenir.
 *   • Uygulama tamamen kapalı (cold start) → Capacitor açılışta
 *     `App.getLaunchUrl()` ile başlatan URL'i verir; onu da okuruz, böylece
 *     "uygulama kapalıyken bağlantıya basılırsa oda kodu kaybolmaz".
 *   • Auth callback (com.kavakgames.torble://auth-callback) → DOKUNULMAZ,
 *     googleAuth.ts kendi dinleyicisiyle işler.
 *
 * Web'de bu modül hiçbir şey yapmaz (isNativePlatform false → erken çıkış),
 * dolayısıyla mevcut web davranışı bit-bit korunur.
 */
import { Capacitor } from "@capacitor/core";
import { INVITE_PARAM } from "./inviteLink";
import { getSiteOrigin } from "../legal/links";
import type { RoomCodeModeKey } from "./roomCodeShared";

/** Bilinen tüm davet parametre anahtarları (mod bağımsız arama için). */
const PARAM_KEYS: string[] = Object.values(INVITE_PARAM);

export interface DeepLinkInvite {
  mode: RoomCodeModeKey;
  code: string;
}

/**
 * AÇILIŞ TESLİMATI tekilleştirici — saf, Capacitor'sız, test edilebilir.
 *
 * iOS cold start'ta AYNI bağlantıyı iki kez teslim edebilir: bir kez
 * `getLaunchUrl()` ile, bir kez de `appUrlOpen` olayı olarak. İkisi de
 * işlenirse çift katılma isteği üretilir.
 *
 * ÖNCEKİ TASARIM YANLIŞTI: `mod:kod` anahtarı modül ömrü boyunca tutuluyor ve
 * HİÇ sıfırlanmıyordu. Kullanıcı odadan çıkıp bir süre sonra AYNI linke
 * gerçekten tekrar dokunduğunda olay sessizce yutuluyordu — uygulama öne
 * geliyor ve hiçbir şey olmuyordu (audit M2).
 *
 * YENİ TASARIM — kapsamı DAR, zaman aşımı YOK:
 *   • Yalnız "açılışı yapan URL" tutulur (mod:kod değil, ham URL).
 *   • Koruma ilk `appUrlOpen` olayında TÜKETİLİR; sonraki dokunuşlara sarkmaz.
 *   • Pencere ayrıca uygulama arka plana düştüğü an KESİN olarak kapanır.
 *     Kullanıcının aynı linke tekrar dokunabilmesi için uygulamadan çıkması
 *     zorunlu olduğundan, gerçek ikinci dokunuş her zaman temiz bir pencerede
 *     gelir.
 */
export function createLaunchDedupe() {
  let launchUrl: string | null = null;
  return {
    /** Cold start URL'i işlendi. */
    noteLaunch(url: string): void {
      launchUrl = url;
    },
    /** Gelen `appUrlOpen` işlensin mi? */
    shouldHandleEvent(url: string): boolean {
      if (launchUrl === null) return true;
      const isLaunchEcho = launchUrl === url;
      // Tek atışlık: eşleşsin ya da eşleşmesin, ilk olaydan sonra koruma düşer.
      launchUrl = null;
      return !isLaunchEcho;
    },
    /** Uygulama arka plana düştü → açılış penceresi kesin olarak bitti. */
    noteBackgrounded(): void {
      launchUrl = null;
    },
  };
}

/** Kodu web tarafındaki normalizasyonla aynı biçime getirir. */
function normalize(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/**
 * Bağlantının BİZE ait olup olmadığını doğrular.
 *
 * Deep-link'ten gelen her değer GÜVENİLMEYEN girdidir. iOS Universal Links
 * yalnız AASA'da tanımlı domainleri teslim eder, ama uygulamaya başka yollardan
 * da URL gelebilir (özel şema, Android intent, test araçları). Yabancı bir
 * host'un oda kodu enjekte etmesini engellemek için host allowlist'i uygulanır.
 *
 * Allowlist yapılandırılmış web origin'inden TÜRETİLİR (kodda ikinci bir
 * domain listesi tutulmaz) + `www.` varyantı.
 */
function isTrustedInviteHost(parsed: URL): boolean {
  // Yalnız http(s). javascript:, data:, file: vb. hiçbir zaman kabul edilmez
  // (JS injection / open-redirect yüzeyi).
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

  const host = parsed.hostname.toLowerCase();

  // Native kabuğun kendi iç adresi (webview aynı URL'i yeniden okuduğunda).
  if (host === "localhost") return true;

  let siteHost = "";
  try {
    siteHost = new URL(getSiteOrigin()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!siteHost) return false;

  return host === siteHost || host === `www.${siteHost}`;
}

/**
 * Gelen deep-link URL'inden davet bilgisini çıkarır. Tanımadığı her URL için
 * null döner (auth callback dâhil) — asla mevcut akışları ele geçirmez.
 *
 * GÜVENLİK: host allowlist + katı oda kodu biçimi (tam 6 karakter A-Z0-9).
 * Beklenmeyen query parametreleri YOK SAYILIR; hiçbiri komut olarak
 * yorumlanmaz. Kod doğrudan DOM'a veya bir yönlendirmeye yazılmaz — yalnız
 * bilinen bir parametre adıyla URLSearchParams üzerinden set edilir.
 */
export function parseInviteFromUrl(url: string): DeepLinkInvite | null {
  try {
    const parsed = new URL(url);
    if (!isTrustedInviteHost(parsed)) return null;
    for (const key of PARAM_KEYS) {
      const raw = parsed.searchParams.get(key);
      if (!raw) continue;
      const code = normalize(raw);
      if (code.length !== 6) continue;
      const mode = (Object.keys(INVITE_PARAM) as RoomCodeModeKey[]).find(
        (m) => INVITE_PARAM[m] === key
      );
      if (!mode) continue;
      return { mode, code };
    }
    // NOT: Projenin gerçek davet biçimi query-param tabanlıdır
    // (https://torble.com/?duel=AB12C). "/oda/KOD" gibi bir yol MEVCUT
    // routing'de yoktur; uydurulmadı.
    return null;
  } catch {
    return null;
  }
}

/**
 * Davet parametresini webview adresine yazar; App.tsx'in mevcut davet
 * effect'i bunu web'deki gibi okuyabilsin diye.
 */
function applyInviteToLocation(invite: DeepLinkInvite): void {
  try {
    const url = new URL(window.location.href);
    // Eski davet parametrelerini temizle ki iki oda arasında karışıklık olmasın.
    for (const key of PARAM_KEYS) url.searchParams.delete(key);
    url.searchParams.set(INVITE_PARAM[invite.mode], invite.code);
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* history API yoksa sessiz geç */
  }
}

/**
 * Native davet bağlantısı dinleyicisini kurar.
 *
 * @param onInvite Davet yakalandığında çağrılır (URL zaten güncellenmiştir).
 * @returns Dinleyiciyi kaldıran fonksiyon.
 */
export function initInviteDeepLinks(
  onInvite: (invite: DeepLinkInvite) => void
): () => void {
  let disposed = false;
  let remove: (() => void) | null = null;

  const isNative = (() => {
    try {
      return Capacitor.isNativePlatform();
    } catch {
      return false;
    }
  })();
  if (!isNative) return () => { /* web: no-op */ };

  /** Açılış teslimatı tekilleştiricisi (saf mantık yukarıda, test edilebilir). */
  const dedupe = createLaunchDedupe();

  const handle = (url: string) => {
    if (disposed) return;
    const invite = parseInviteFromUrl(url);
    if (!invite) return; // auth callback / yabancı host — bize ait değil
    applyInviteToLocation(invite);
    onInvite(invite);
  };

  void (async () => {
    try {
      const { App } = await import("@capacitor/app");

      // 1) Uygulama TAMAMEN KAPALIYKEN bağlantıya basıldıysa: başlatan URL.
      try {
        const launch = await App.getLaunchUrl();
        if (launch?.url) {
          dedupe.noteLaunch(launch.url);
          handle(launch.url);
        }
      } catch {
        /* getLaunchUrl desteklenmiyorsa yoksay */
      }

      // 2) Uygulama AÇIK / ARKA PLANDAYKEN gelen bağlantılar.
      const handleSub = await App.addListener("appUrlOpen", ({ url }) => {
        if (!dedupe.shouldHandleEvent(url)) return; // aynı OS teslimatı
        handle(url);
      });

      // Uygulama arka plana düştüğünde açılış penceresini KESİN olarak kapat.
      // Gerçek bir ikinci dokunuş ancak uygulamadan çıkıldıktan sonra
      // gelebileceği için, bu noktadan sonra aynı link yeniden işlenir.
      const stateSub = await App.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) dedupe.noteBackgrounded();
      });

      if (disposed) {
        void handleSub.remove();
        void stateSub.remove();
      } else {
        remove = () => { void handleSub.remove(); void stateSub.remove(); };
      }
    } catch {
      /* @capacitor/app yoksa sessizce devre dışı */
    }
  })();

  return () => {
    disposed = true;
    remove?.();
  };
}
