/**
 * legal/locales.ts
 *
 * Torble'ın herkese açık hukuki/destek sayfaları (Gizlilik Politikası, Destek)
 * için dil altyapısı. Tek kaynak: yeni bir dil eklemek için `LegalLocale`
 * union'ına kod eklemek (ör. "de" | "es") + her `Record<LegalLocale, …>`
 * içeriğini doldurmak yeterlidir; TypeScript eksik dili derleme hatasıyla
 * yakalar. Sayfa bileşeni, router ve link yardımcıları hep bu tipleri kullanır.
 */

/** Desteklenen içerik dilleri. Yeni dil eklemek için buraya ekle; içerik
 *  dosyaları (`content/*`) o dili sağlamak zorunda kalır (tip zorunluluğu). */
export type LegalLocale = "tr" | "en";

/** UI/route sırası — dil değiştirici bu sırayla render edilir. */
export const SUPPORTED_LOCALES: readonly LegalLocale[] = ["tr", "en"];

/**
 * Bilinmeyen/desteklenmeyen dilde varsayılan. Ürün gereksinimi:
 * "tr ile başlayan → Türkçe, diğer her durum → İngilizce". Yani varsayılan EN.
 */
export const DEFAULT_LOCALE: LegalLocale = "en";

/**
 * Uygulamanın ŞU ANKİ arayüz dili. Torble arayüzü bugün tek dilli (Türkçe);
 * uygulama içi "Gizlilik / Destek / İletişim" bağlantıları bu değere göre
 * doğru dildeki sayfaya gider. İleride gerçek bir i18n/dil ayarı eklendiğinde
 * yalnızca burası (veya bu fonksiyon) o ayarı okuyacak şekilde güncellenir;
 * bağlantı çağıranların değişmesi gerekmez.
 */
export const APP_UI_LOCALE: LegalLocale = "tr";

export function isLegalLocale(value: string): value is LegalLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Tarayıcı diline göre içerik dili seçer. Kural (ürün gereksinimi):
 *   • Herhangi bir tercih dili "tr" ile başlıyorsa → Türkçe
 *   • Diğer tüm durumlarda → İngilizce (DEFAULT_LOCALE)
 * SSR/güvenli: navigator yoksa varsayılana düşer.
 */
export function resolveBrowserLocale(): LegalLocale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const prefs =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const raw of prefs) {
    if (typeof raw === "string" && raw.toLowerCase().startsWith("tr")) {
      return "tr";
    }
  }
  return DEFAULT_LOCALE;
}
