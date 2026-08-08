/**
 * legal/links.ts
 *
 * Hukuki/destek sayfalarına giden bağlantılar için ortak URL yardımcıları.
 * Hem sayfaların kendisi (kanonik/hreflang) hem de uygulama içi menü bağlantıları
 * buradan beslenir. İçerik dosyalarını (privacy/support) İÇE AKTARMAZ — böylece
 * uygulama bundle'ı hafif kalır.
 */
import { Capacitor } from "@capacitor/core";
import type { LegalLocale } from "./locales";
import { legalPath } from "./router";
import type { LegalDocKind } from "./content/types";
import { CONTACT_EMAIL } from "./content/chrome";

export { CONTACT_EMAIL };
export { legalPath };

/**
 * Kanonik web origin. Sıra:
 *   1. VITE_PUBLIC_SITE_URL  (auth yönlendirmeleriyle aynı kaynak)
 *   2. VITE_PUBLIC_WEB_ORIGIN (uzak asset tabanıyla aynı kaynak)
 *   3. https://torble.com     (kodda tek yerde tanımlı üretim domaini)
 * Native'de mutlak bağlantılar (Browser.open, kanonik etiket) için gereklidir;
 * web'de göreli path zaten yeterlidir.
 */
export function getSiteOrigin(): string {
  // NOT: `import.meta.env` yalnız Vite bundle'ında tanımlıdır. Node altında
  // çalışan test scriptleri bu modülü import edebilsin diye erişim savunmacı
  // yapılır (tarayıcı davranışı DEĞİŞMEZ; orada env her zaman vardır).
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const site = env?.VITE_PUBLIC_SITE_URL?.trim();
  const web = env?.VITE_PUBLIC_WEB_ORIGIN?.trim();
  const base = site || web || "https://torble.com";
  return base.replace(/\/+$/, "");
}

/** Mutlak hukuki URL — native bağlantılar ve kanonik/hreflang için. */
export function legalAbsoluteUrl(kind: LegalDocKind, locale: LegalLocale): string {
  return getSiteOrigin() + legalPath(kind, locale);
}

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Harici bir URL'i platforma uygun biçimde açar:
 *   • Native (Capacitor): sistem içi tarayıcı (@capacitor/browser) — webview'i
 *     terk etmeden güvenli dış bağlantı (googleAuth.ts ile aynı desen).
 *   • Web: yeni sekme (kullanıcının oyun oturumu korunur).
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isNativeApp()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return;
    } catch {
      /* köprü yoksa aşağıdaki web davranışına düş */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
