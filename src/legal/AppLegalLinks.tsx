/**
 * legal/AppLegalLinks.tsx
 *
 * Uygulama İÇİNDEN hukuki/destek sayfalarına ve iletişime giden erişilebilir
 * bağlantılar. Uygulamanın mevcut arayüz dili (APP_UI_LOCALE) hangi dildeki
 * sayfaya gidileceğini belirler.
 *
 * Davranış:
 *   • Web: gerçek <a> — yeni sekmede açılır (oyun oturumu korunur), klavye ile
 *     erişilebilir.
 *   • Native (Capacitor): tıklama yakalanır ve sayfa sistem tarayıcısında
 *     (@capacitor/browser) mutlak web URL'iyle açılır.
 *   • İletişim: standart mailto bağlantısı (OS'in e-posta uygulamasına devreder).
 *
 * İçerik dosyalarını İÇE AKTARMAZ; yalnız hafif link/locale yardımcılarını
 * kullanır, böylece uygulama bundle'ı şişmez.
 */
import type { ReactNode, MouseEvent } from "react";
import { APP_UI_LOCALE } from "./locales";
import type { LegalDocKind } from "./content/types";
import {
  CONTACT_EMAIL,
  legalPath,
  legalAbsoluteUrl,
  isNativeApp,
  openExternalUrl,
} from "./links";

interface LegalLinkProps {
  kind: LegalDocKind;
  className?: string;
  children: ReactNode;
}

/** Gizlilik/Destek sayfasına giden, platforma duyarlı bağlantı. */
export function AppLegalLink({ kind, className, children }: LegalLinkProps) {
  const native = isNativeApp();
  const href = native
    ? legalAbsoluteUrl(kind, APP_UI_LOCALE)
    : legalPath(kind, APP_UI_LOCALE);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (native) {
      e.preventDefault();
      void openExternalUrl(legalAbsoluteUrl(kind, APP_UI_LOCALE));
    }
    // Web: varsayılan gezinme (yeni sekme) çalışır.
  };

  return (
    <a
      className={className}
      href={href}
      onClick={onClick}
      {...(native ? {} : { target: "_blank", rel: "noopener noreferrer" })}
    >
      {children}
    </a>
  );
}

interface ContactLinkProps {
  className?: string;
  children: ReactNode;
}

/** İletişim (mailto) bağlantısı. */
export function AppContactLink({ className, children }: ContactLinkProps) {
  return (
    <a className={className} href={`mailto:${CONTACT_EMAIL}`}>
      {children}
    </a>
  );
}
