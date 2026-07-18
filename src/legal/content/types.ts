/**
 * legal/content/types.ts
 *
 * Gizlilik/Destek sayfalarının tip-güvenli içerik modeli. İçerik İKİ ayrı
 * kopya bileşen olarak DEĞİL, dilden bağımsız bu yapıyı dolduran veri olarak
 * yazılır; tek `LegalPage` bileşeni her dili aynı yapıdan render eder.
 *
 * Yapısal eşdeğerlik: her belge dilin `Localized<LegalDoc>` haritasında yer
 * alır → TypeScript her dil için belgeyi zorunlu kılar. Bölüm `id`'lerinin
 * diller arası birebir aynı olması ayrıca dev-zamanı bir invariant ile
 * doğrulanır (assertParallel — LegalRoot içinde çağrılır).
 */
import type { LegalLocale } from "../locales";

export type LegalDocKind = "privacy" | "support";

/** Düz metin paragraf. `strongLead` verilirse ilk cümle vurgulanır (opsiyonel). */
export interface LegalParagraph {
  type: "p";
  text: string;
}

/** Alt başlık (bir bölüm içinde ikinci seviye). */
export interface LegalSubheading {
  type: "subheading";
  text: string;
}

/** Madde listesi. `ordered` sıralı (ol) yapar. */
export interface LegalList {
  type: "list";
  items: string[];
  ordered?: boolean;
}

/** Dikkat çekici bilgi kutusu (callout). */
export interface LegalNote {
  type: "note";
  text: string;
}

/** E-posta iletişim satırı — mailto bağlantısı olarak render edilir. */
export interface LegalContact {
  type: "contact";
  label: string;
  email: string;
}

export type LegalBlock =
  | LegalParagraph
  | LegalSubheading
  | LegalList
  | LegalNote
  | LegalContact;

export interface LegalSection {
  /** Diller arası SABİT anchor id (içindekiler + derin bağlantı için). */
  id: string;
  /** O dildeki başlık. */
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  kind: LegalDocKind;
  /** <h1> ve <title> için. */
  title: string;
  /** Başlığın altındaki kısa alt metin. */
  tagline: string;
  /** <meta name="description"> için. */
  metaDescription: string;
  /** Bölümlerden önce gelen giriş blokları. */
  intro: LegalBlock[];
  sections: LegalSection[];
}

/** Bir değeri her dil için zorunlu kılan harita. Yeni dil eklenince eksik
 *  anahtar derleme hatası verir → içerik paritesi tip düzeyinde korunur. */
export type Localized<T> = Record<LegalLocale, T>;
