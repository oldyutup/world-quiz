/**
 * legal/router.ts
 *
 * Path tabanlı hukuki-sayfa yönlendiricisi. Hafiftir — yalnız `locales`'i
 * içe aktarır, içerik (privacy/support) dosyalarını ÇEKMEZ. Böylece main.tsx
 * bu eşleştirmeyi uygulama bundle'ını şişirmeden yapabilir; ağır içerik ve
 * sayfa bileşeni yalnız gerçekten bir hukuki route'ta lazy yüklenir.
 *
 * Route şeması:
 *   /tr/privacy, /en/privacy, /tr/support, /en/support   → sayfa
 *   /privacy, /support                                    → tarayıcı diline yönlendir
 *   /<desteklenmeyen-dil>/<tür>                            → yönlendir (bağışlayıcı)
 *   /<tür>/... veya /<dil>/<tür>/... (bozuk)               → 404 (hukuki namespace)
 *   diğer her şey                                          → null (uygulama devralır)
 */
import {
  isLegalLocale,
  resolveBrowserLocale,
  type LegalLocale,
} from "./locales";
import type { LegalDocKind } from "./content/types";

const KINDS: readonly LegalDocKind[] = ["privacy", "support"];

function isKind(value: string): value is LegalDocKind {
  return (KINDS as readonly string[]).includes(value);
}

export type LegalRouteMatch =
  | { type: "page"; kind: LegalDocKind; locale: LegalLocale }
  | {
      type: "redirect";
      kind: LegalDocKind;
      locale: LegalLocale;
      canonicalPath: string;
    }
  | { type: "notfound" };

/** `/${locale}/${kind}` — kanonik hukuki path. */
export function legalPath(kind: LegalDocKind, locale: LegalLocale): string {
  return `/${locale}/${kind}`;
}

/**
 * pathname'i bir hukuki route eşleşmesine çevirir. Hukuki namespace'e ait
 * değilse `null` döner (uygulama normal şekilde açılır).
 */
export function matchLegalRoute(pathname: string): LegalRouteMatch | null {
  const clean = pathname.replace(/\/+$/, "");
  const segs = clean
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).toLowerCase());

  const seg0 = segs[0];
  const seg1 = segs[1];

  // Hukuki namespace mi? Route'larımız /<tür> veya /<dil>/<tür> biçiminde.
  const inNamespace =
    (seg0 !== undefined && isKind(seg0)) ||
    (seg1 !== undefined && isKind(seg1));
  if (!inNamespace) return null;

  // /privacy, /support → tarayıcı diline yönlendir.
  if (segs.length === 1 && seg0 !== undefined && isKind(seg0)) {
    const locale = resolveBrowserLocale();
    return {
      type: "redirect",
      kind: seg0,
      locale,
      canonicalPath: legalPath(seg0, locale),
    };
  }

  // /<dil>/<tür>
  if (segs.length === 2 && seg1 !== undefined && isKind(seg1)) {
    if (seg0 !== undefined && isLegalLocale(seg0)) {
      return { type: "page", kind: seg1, locale: seg0 };
    }
    // Desteklenmeyen dil (ör. /de/privacy) — bağışlayıcı: çözülen dile yönlendir.
    const locale = resolveBrowserLocale();
    return {
      type: "redirect",
      kind: seg1,
      locale,
      canonicalPath: legalPath(seg1, locale),
    };
  }

  // Namespace içinde ama biçim bozuk → 404.
  return { type: "notfound" };
}
