/**
 * legal/content/index.ts
 *
 * Belge kaydı + erişim yardımcıları. Yeni bir belge türü eklemek için buraya
 * kaydet; yeni bir dil eklemek için `Localized<>` haritalarını doldur (tip
 * zorunluluğu). `assertParallelDocs` dev-zamanı TR/EN yapısal paritesini
 * (aynı bölüm id'leri, aynı sıra) doğrular.
 */
import type { LegalDoc, LegalDocKind, Localized } from "./types";
import type { LegalLocale } from "../locales";
import { SUPPORTED_LOCALES } from "../locales";
import { PRIVACY } from "./privacy";
import { SUPPORT } from "./support";

export const DOCS: Record<LegalDocKind, Localized<LegalDoc>> = {
  privacy: PRIVACY,
  support: SUPPORT,
};

export function getDoc(kind: LegalDocKind, locale: LegalLocale): LegalDoc {
  return DOCS[kind][locale];
}

/**
 * Dev-zamanı invariant: her belgenin tüm dillerinde bölüm id listesi aynı
 * (aynı öğeler, aynı sıra) olmalı. Aksi halde diller içerik açısından ayrışmış
 * demektir. Üretimde çağrılmaz (LegalRoot yalnız import.meta.env.DEV iken çağırır).
 */
export function assertParallelDocs(): void {
  for (const kind of Object.keys(DOCS) as LegalDocKind[]) {
    const byLocale = DOCS[kind];
    const reference = SUPPORTED_LOCALES[0];
    const refIds = byLocale[reference].sections.map((s) => s.id).join(",");
    for (const locale of SUPPORTED_LOCALES) {
      const ids = byLocale[locale].sections.map((s) => s.id).join(",");
      if (ids !== refIds) {
        // eslint-disable-next-line no-console
        console.error(
          `[legal] "${kind}" belgesinde bölüm paritesi bozuk: ` +
            `${reference}=[${refIds}] ↔ ${locale}=[${ids}]`
        );
      }
    }
  }
}
