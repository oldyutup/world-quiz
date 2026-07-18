/**
 * legal/content/chrome.ts
 *
 * Sayfa "kroması": belgeye özgü olmayan, her hukuki/destek sayfasında paylaşılan
 * arayüz metinleri (dil değiştirici, "Son güncelleme", içindekiler başlığı,
 * uygulamaya dön vb.) + ortak sabitler (iletişim e-postası, son güncelleme
 * tarihi). Tümü dil-güvenli (`Localized<LegalChrome>`).
 */
import type { LegalLocale } from "../locales";
import type { Localized } from "./types";

/** Tüm sayfalarda tek iletişim kanalı. */
export const CONTACT_EMAIL = "contact@torble.com";

/**
 * Belgelerin son güncellenme tarihi (ISO). Sayfalarda kullanıcının diline göre
 * biçimlendirilir. İçerik anlamlı biçimde değiştiğinde güncellenir.
 */
export const LAST_UPDATED_ISO = "2026-07-19";

export interface LegalChrome {
  /** <html lang> ve tarih biçimlendirme için BCP-47 etiketi. */
  htmlLang: string;
  /** Dil değiştirici bölgesinin erişilebilir etiketi. */
  languageSwitchLabel: string;
  /** Her dil düğmesinin görünen adı (kendi dilinde). */
  languageName: string;
  /** "Son güncelleme" ön eki. */
  lastUpdatedLabel: string;
  /** İçindekiler başlığı. */
  tocLabel: string;
  /** Üst/alt gezinme — Gizlilik sayfası bağlantısı. */
  privacyNav: string;
  /** Üst/alt gezinme — Destek sayfası bağlantısı. */
  supportNav: string;
  /** İletişim bağlantısı etiketi. */
  contactNav: string;
  /** Uygulamaya/ana sayfaya dön. */
  backToApp: string;
  /** Logo/ana sayfa bağlantısının erişilebilir etiketi. */
  homeAriaLabel: string;
  /** Alt bilgi telif satırı (yıl enjekte edilir). */
  footerRights: (year: number) => string;
  /** Belge içeriğinin bilgilendirme amaçlı olduğunu belirten alt not. */
  footerNote: string;
  /** 404 — başlık. */
  notFoundTitle: string;
  /** 404 — açıklama. */
  notFoundBody: string;
}

export const CHROME: Localized<LegalChrome> = {
  tr: {
    htmlLang: "tr",
    languageSwitchLabel: "Dil seç",
    languageName: "Türkçe",
    lastUpdatedLabel: "Son güncelleme",
    tocLabel: "İçindekiler",
    privacyNav: "Gizlilik Politikası",
    supportNav: "Destek",
    contactNav: "İletişim",
    backToApp: "Torble'a dön",
    homeAriaLabel: "Torble ana sayfası",
    footerRights: (year) => `© ${year} Torble. Tüm hakları saklıdır.`,
    footerNote:
      "Bu sayfa bilgilendirme amaçlıdır ve Torble'ın güncel uygulamalarını yansıtır.",
    notFoundTitle: "Sayfa bulunamadı",
    notFoundBody:
      "Aradığın hukuki sayfa burada yok. Aşağıdaki bağlantılardan devam edebilirsin.",
  },
  en: {
    htmlLang: "en",
    languageSwitchLabel: "Select language",
    languageName: "English",
    lastUpdatedLabel: "Last updated",
    tocLabel: "Contents",
    privacyNav: "Privacy Policy",
    supportNav: "Support",
    contactNav: "Contact",
    backToApp: "Back to Torble",
    homeAriaLabel: "Torble home",
    footerRights: (year) => `© ${year} Torble. All rights reserved.`,
    footerNote:
      "This page is for information purposes and reflects Torble's current practices.",
    notFoundTitle: "Page not found",
    notFoundBody:
      "The legal page you're looking for isn't here. You can continue from the links below.",
  },
};

/** Tarihi kullanıcının diline göre okunur biçime çevirir (uzun ay adı). */
export function formatLastUpdated(iso: string, locale: LegalLocale): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return iso;
  }
}
