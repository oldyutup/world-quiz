/**
 * Kuşatma — bölge-içi bonus filigran motifleri.
 *
 * Her açık bonus türü için bölge shape'ine clip'lenen (pattern dolgusu bölge
 * path'inin kendisine basıldığı için doğal clip) düşük opaklıklı bir SVG
 * <pattern> üretir.  Bonus bölgenin KENDİSİNDEN okunur: bu filigran dokusu,
 * bölge-içi büyük tür emblemiyle (TurkeyConquestMap Layer 3.8) birlikte
 * çalışan arka katmandır — kumaş gibi tekrarlayan ince çizgi-motif, yarım
 * kaydırmalı (half-drop) dizilim + hafif eğim, banknot/armalı doku hissi.
 *
 * Renk bonus KATEGORİSİNİN mevcut harita tonunu kullanır (savunma gümüş,
 * saldırı kor, bilgi lavanta, ekonomi altın) — aynı ton chip rim'inde,
 * kesikli aura çizgisinde ve brifing kartında da göründüğü için anlam yalnız
 * renge dayanmaz.  Motifin ÇİZGİSİ türü söyler: kum saati = Zaman Takviyesi,
 * çapa+dalga = Liman, sur mazgalı = Mevzi Bekçisi, düğüm ağı = İstihbarat…
 *
 * Salt sunum: pointer-events almaz, gameplay/koordinat/etiketlere dokunmaz.
 * Stroke kalınlığı ve katman opaklığı CSS'ten yönetilir
 * (.cq-map-bonus-motif / .cq-map-bonus-motif-glyph, App.css).
 */

import type { ReactNode } from "react";
import type { ConquestRegionBonusType } from "./types";
import { getBonusPoolEntry, type BonusCategory } from "./bonusPool";

/** Pattern karo boyu (SVG user unit, 1005×490 harita uzayında).  ~46 birim,
 *  orta boy bir bölgeye 4-8 motif düşürür: doku gibi okunur, grid gibi değil. */
const MOTIF_TILE = 46;

/** Kategori tonu — mevcut aura/brifing kategori diliyle aynı aile.  Alpha
 *  motif çizgisine bakılır; katman opaklığı (CSS) ile çarpılınca ~0.25-0.30
 *  efektif değere iner: doku olarak net okunur ama owner dolgusunu ve
 *  etiketleri boğmaz. */
const MOTIF_TINT: Record<BonusCategory, string> = {
  savunma: "rgba(214, 226, 242, 0.46)",
  saldiri: "rgba(253, 186, 116, 0.48)",
  bilgi:   "rgba(199, 185, 255, 0.50)",
  ekonomi: "rgba(252, 211, 77, 0.48)",
};

export function bonusMotifPatternId(type: ConquestRegionBonusType): string {
  return `cqBonusMotif-${type}`;
}

// ── Glyph'ler ────────────────────────────────────────────────────────────────
// Hepsi (0,0) merkezli ~13-14 birimlik kutuda çizgi-sanat.  Stroke/fill
// davranışı sarmalayıcı <g class="cq-map-bonus-motif-glyph">'ten miras alınır;
// dolu minik noktalar cq-map-bonus-motif-dot ile ayrılır.

/** Kale Surları 🛡️ — kalkan konturu + orta şerit. */
const shieldGlyph = (
  <>
    <path d="M 0 -6.6 C 2 -5.4 3.9 -5 5.2 -5.2 C 5.2 -0.6 3.6 3.7 0 6.6 C -3.6 3.7 -5.2 -0.6 -5.2 -5.2 C -3.9 -5 -2 -5.4 0 -6.6 Z" />
    <path d="M 0 -4.4 V 4.3" />
  </>
);

/** Mevzi Bekçisi 🏰 — mazgallı sur parapeti + harç derzleri (taş teması). */
const parapetGlyph = (
  <>
    <path d="M -6.4 3.6 V -1.2 H -4.2 V -3.8 H -1.4 V -1.2 H 1.4 V -3.8 H 4.2 V -1.2 H 6.4 V 3.6 Z" />
    <path d="M -6.4 1.2 H 6.4 M -2.4 1.2 V 3.6 M 2.4 1.2 V 3.6" opacity={0.72} />
  </>
);

/** Zaman Takviyesi ⏳ — kum saati + kum tanesi. */
const hourglassGlyph = (
  <>
    <path d="M -4 -6.4 H 4 M -4 6.4 H 4" />
    <path d="M -3.1 -6.4 C -3.1 -2.7 -1 -1.7 0 0 C 1 -1.7 3.1 -2.7 3.1 -6.4" />
    <path d="M -3.1 6.4 C -3.1 2.7 -1 1.7 0 0 C 1 1.7 3.1 2.7 3.1 6.4" />
    <circle className="cq-map-bonus-motif-dot" cx={0} cy={4.6} r={0.9} />
  </>
);

/** Koçbaşı 🪵 — ileri itki: çift ok ucu (agresif ama düşük opaklıkta). */
const chevronsGlyph = (
  <path d="M -4.8 -4.4 L -0.4 0 L -4.8 4.4 M 0.8 -4.4 L 5.2 0 L 0.8 4.4" />
);

/** Gizli Operasyon 🎭 — maske konturu + göz yayları. */
const maskGlyph = (
  <>
    <path d="M -5.4 -2.8 C -1.8 -4.3 1.8 -4.3 5.4 -2.8 C 5.6 0.4 3.9 3.3 0 4.4 C -3.9 3.3 -5.6 0.4 -5.4 -2.8 Z" />
    <path d="M -3.5 -1.2 C -2.6 -2 -1.5 -2 -0.8 -1.3 M 0.8 -1.3 C 1.5 -2 2.6 -2 3.5 -1.2" />
  </>
);

/** Mancınık 🎯 — nişangâh; ikincil hücrede atış yörüngesi. */
const crosshairGlyph = (
  <>
    <circle cx={0} cy={0} r={4.5} />
    <path d="M 0 -6.4 V -2.9 M 0 6.4 V 2.9 M -6.4 0 H -2.9 M 6.4 0 H 2.9" />
    <circle className="cq-map-bonus-motif-dot" cx={0} cy={0} r={0.95} />
  </>
);
const trajectoryGlyph = (
  <>
    <path d="M -5.4 4.6 C -3.4 -2.8 2 -5.6 5.4 -4.2" />
    <path d="M 5.4 -4.2 L 2.9 -4.6 M 5.4 -4.2 L 4.6 -1.9" />
  </>
);

/** Eleme Yetkisi 🃏 — hafif yatık oyun kartı + karo. */
const cardGlyph = (
  <g transform="rotate(-9)">
    <rect x={-3.4} y={-4.8} width={6.8} height={9.6} rx={1.3} />
    <path d="M 0 -1.9 L 1.55 0 L 0 1.9 L -1.55 0 Z" />
  </g>
);

/** Kâhin Büyüsü 🔮 — dört uçlu ışıltı; ikincil hücrede rün vuruşu (mistik). */
const sparkleGlyph = (
  <>
    <path d="M 0 -6 C 0.7 -2.4 2.4 -0.7 6 0 C 2.4 0.7 0.7 2.4 0 6 C -0.7 2.4 -2.4 0.7 -6 0 C -2.4 -0.7 -0.7 -2.4 0 -6 Z" />
    <circle className="cq-map-bonus-motif-dot" cx={0} cy={0} r={0.9} />
  </>
);
const runeGlyph = (
  <path d="M -1.7 -5.4 V 5.4 M -1.7 -2.9 L 2.7 -0.3 L -1.7 2.3" />
);

/** İstihbarat Ağı 👁️ — düğüm + bağlantı ağı. */
const networkGlyph = (
  <>
    <path d="M -4.7 2.9 L -0.1 -4.9 L 4.9 0.5 L 0.5 5 Z M -4.7 2.9 L 4.9 0.5" />
    <circle className="cq-map-bonus-motif-dot" cx={-4.7} cy={2.9} r={1.05} />
    <circle className="cq-map-bonus-motif-dot" cx={-0.1} cy={-4.9} r={1.05} />
    <circle className="cq-map-bonus-motif-dot" cx={4.9} cy={0.5} r={1.05} />
    <circle className="cq-map-bonus-motif-dot" cx={0.5} cy={5} r={1.05} />
  </>
);

/** Bereketli Ova 🌾 — başak: sap + tane yayları. */
const wheatGlyph = (
  <>
    <path d="M 0 6.6 C 0.3 2.4 0.2 -1.8 0 -5.8" />
    <path d="M 0 -5.6 C -1.9 -5 -2.7 -3.7 -2.8 -2.1 M 0 -5.6 C 1.9 -5 2.7 -3.7 2.8 -2.1 M 0.1 -2.9 C -1.7 -2.4 -2.5 -1.2 -2.6 0.3 M 0.1 -2.9 C 1.9 -2.4 2.7 -1.2 2.8 0.3 M 0.1 -0.2 C -1.6 0.3 -2.4 1.4 -2.5 2.8 M 0.1 -0.2 C 1.8 0.3 2.6 1.4 2.7 2.8" />
  </>
);

/** Liman ⚓ — çapa; ikincil hücrede dalga (deniz teması). */
const anchorGlyph = (
  <>
    <circle cx={0} cy={-4.9} r={1.6} />
    <path d="M 0 -3.3 V 5.7 M -3.3 -0.7 H 3.3" />
    <path d="M -4.9 1.9 C -4.4 4.8 -2.4 6.4 0 6.7 C 2.4 6.4 4.4 4.8 4.9 1.9" />
    <path d="M -4.9 1.9 L -6.2 3 M 4.9 1.9 L 6.2 3" />
  </>
);
const waveGlyph = (
  <path d="M -6 0.6 Q -3 -2.6 0 0.6 T 6 0.6" />
);

/** Havuzda olup motifi tanımlanmamış (bugün spawn etmeyen) türler için
 *  savunmacı yedek — nötr karo konturu. */
const fallbackGlyph = <path d="M 0 -5 L 5 0 L 0 5 L -5 0 Z" />;

/** Tür → motif.  `secondary` verilirse yarım kaydırmalı ikinci hücrede o
 *  basılır (çapa+dalga gibi ikili dokular); verilmezse aynı glyph %85
 *  ölçekte tekrarlanır — grid monotonluğunu kırar. */
const MOTIF_GLYPHS: Partial<Record<
  ConquestRegionBonusType,
  { primary: ReactNode; secondary?: ReactNode }
>> = {
  istanbul_defense:     { primary: shieldGlyph },
  mevzi_bekcisi:        { primary: parapetGlyph },
  karadeniz_extra_time: { primary: hourglassGlyph },
  kocbasi:              { primary: chevronsGlyph },
  ankara_hidden_shield: { primary: maskGlyph },
  mancinik:             { primary: crosshairGlyph, secondary: trajectoryGlyph },
  eleme_yetkisi:        { primary: cardGlyph },
  kahin:                { primary: sparkleGlyph, secondary: runeGlyph },
  istihbarat_agi:       { primary: networkGlyph },
  cukurova_score:       { primary: wheatGlyph },
  liman:                { primary: anchorGlyph, secondary: waveGlyph },
};

interface BonusMotifPatternDefsProps {
  /** Bu maçta haritada fiilen görünen bonus türleri — yalnız bunların
   *  pattern'i mount edilir, DOM şişmez. */
  types: readonly ConquestRegionBonusType[];
}

/**
 * SVG <defs> içine konacak pattern tanımları.  `style.color` kategori tonunu
 * taşır; glyph çizgileri currentColor üzerinden bu tonu miras alır (pattern
 * içeriği, referans veren path'in DOM konumundan DEĞİL pattern elemanının
 * kendisinden miras aldığı için ton burada bağlanır).
 */
export function BonusMotifPatternDefs({ types }: BonusMotifPatternDefsProps) {
  if (types.length === 0) return null;
  return (
    <>
      {types.map((t) => {
        const cat = getBonusPoolEntry(t)?.category ?? "ekonomi";
        const def: { primary: ReactNode; secondary?: ReactNode } =
          MOTIF_GLYPHS[t] ?? { primary: fallbackGlyph };
        return (
          <pattern
            key={t}
            id={bonusMotifPatternId(t)}
            patternUnits="userSpaceOnUse"
            width={MOTIF_TILE}
            height={MOTIF_TILE}
            // scale hem karoyu hem glyph'i büyütür: motif "biraz daha
            // belirgin" ama dizilim yoğunluğu (glyph/alan oranı) aynı kalır.
            patternTransform="rotate(-8) scale(1.15)"
            style={{ color: MOTIF_TINT[cat] }}
          >
            <g
              className="cq-map-bonus-motif-glyph"
              transform={`translate(${MOTIF_TILE * 0.27} ${MOTIF_TILE * 0.27})`}
            >
              {def.primary}
            </g>
            <g
              className="cq-map-bonus-motif-glyph"
              transform={`translate(${MOTIF_TILE * 0.77} ${MOTIF_TILE * 0.77}) scale(0.85)`}
            >
              {def.secondary ?? def.primary}
            </g>
          </pattern>
        );
      })}
    </>
  );
}
