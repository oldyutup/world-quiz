/**
 * ConquestBonusGuide — onboarding card listing this match's active bonuses.
 *
 * Driven by the dynamic per-match `roundBonuses` assignment (resolved upstream
 * via `getActiveBonusEntries`).  Stays compact: each row shows icon + bonus
 * label + region label only.  Click/tap (or focus) a row to expand the effect
 * description inline — one row open at a time so the card never grows tall.
 *
 * Pure presentational component.  Open/close, auto-show timing, and the help
 * button live in ConquestGame.
 */

import { useState } from "react";
import { EmojiIcon } from "../../components/EmojiIcon";
import { ConquestBonusIcon } from "./ConquestAssetIcon";
import type {
  ConquestRegionBonusDef,
  ConquestRegionBonusType,
  ConquestRegionId,
} from "./types";

/**
 * Region-neutral effect copy keyed by bonus *type*.  The static
 * REGION_BONUSES descriptions still mention a specific city ("İstanbul'u
 * tutan oyuncuya…") which lies when the dynamic assignment moves the bonus
 * elsewhere.  This map describes what the bonus DOES, not where it lives.
 *
 * `Partial` because the bonus type union also carries pool-only entries
 * (see bonusPool.ts) that are not currently assigned by
 * `buildRoundBonusAssignment` and therefore never reach this guide.  The
 * lookup below falls back to `def.description` for any missing key.
 */
export const BONUS_TYPE_EFFECT_COPY: Partial<Record<ConquestRegionBonusType, string>> = {
  istanbul_defense:
    "Bu bölgeyi fetheden oyuncu açık kalkan kazanır. Bölgeye gelen ilk düşman saldırısı, bölgeyi değil kalkanı kırar.",
  ankara_hidden_shield:
    "Fetheden oyuncu Gizli Operasyon hakkı kazanır: kendi bir bölgesine gizli kalkan ya da tarafsız bir bölgeye gizli fetih kurabilir. Komşuluk şartı yoktur.",
  cukurova_score:
    "Bu bölgeyi fetheden oyuncuya anında +2 bonus puan verilir. Aynı oyuncu 3 tur boyunca elinde tutarsa bir kereye mahsus +4 puanlık 'Hasat' bonusu kazanır; bölge aynı sahipte kaldığı sürece tekrar hasat üretmez. Bölge el değiştirirse hasat sayacı sıfırlanır ve yeni sahip için 0/3'ten yeniden başlar.",
  karadeniz_extra_time:
    "Soru süresine +5 saniye ekler.",
  eleme_yetkisi:
    "Sonraki test sorunda 1 yanlış şık silinir.",
  mevzi_bekcisi:
    "Bu bölgeyi kaybetsen bile bölgenin puanı sende kalır. Ownership rakibe geçer, sen ise puanı mevzi koruma puanı olarak korursun.",
  kocbasi:
    "Kalkanları aşar: kalkanlı rakip bölgeye düelloyu kazanırsan bölge tek seferde fethedilir. Rakibe ait her bölge fethinde +1 bonus puan kazandırır.",
};

export interface ConquestBonusGuideEntry {
  regionId:    ConquestRegionId;
  def:         ConquestRegionBonusDef;
  regionLabel: string;
}

interface Props {
  entries:    ConquestBonusGuideEntry[];
  onClose?:   () => void;
  /** Shown above the list. Defaults to "Bu Maçtaki Bonuslar". */
  title?:     string;
  /**
   * Presentation surface.
   *   - "overlay" (default): floating dismissible card — mobile + legacy.
   *   - "rail": a flush, always-on section that lives as the bottom block of
   *     the desktop left command rail (no close button, no hint paragraph;
   *     the list scrolls inside itself so a long bonus set never stretches
   *     the rail or touches the map).
   */
  variant?:   "overlay" | "rail";
}

export default function ConquestBonusGuide({
  entries,
  onClose,
  title = "Bu Maçtaki Bonuslar",
  variant = "overlay",
}: Props) {
  // First row open by default — gives the player something to read without
  // forcing an interaction.  Null collapses everything.
  const [openId, setOpenId] = useState<ConquestRegionId | null>(
    entries[0]?.regionId ?? null,
  );

  if (entries.length === 0) return null;

  const isRail   = variant === "rail";
  const iconSize = isRail ? 22 : 28;

  const list = (
    <ul className="cq-bonus-guide-list" role="list">
      {entries.map(({ regionId, def, regionLabel }) => {
        const isOpen = openId === regionId;
        const effect = BONUS_TYPE_EFFECT_COPY[def.type] ?? def.description;
        return (
          <li key={regionId} className="cq-bonus-guide-item">
            <button
              type="button"
              className={
                "cq-bonus-guide-row" + (isOpen ? " cq-bonus-guide-row--open" : "")
              }
              onClick={() => setOpenId(isOpen ? null : regionId)}
              aria-expanded={isOpen}
              aria-controls={`cq-bonus-guide-effect-${regionId}`}
            >
              <span className="cq-bonus-guide-icon" aria-hidden="true">
                <ConquestBonusIcon type={def.type} fallbackChar={def.icon} alt={def.label} size={iconSize} />
              </span>
              <span className="cq-bonus-guide-meta">
                <span className="cq-bonus-guide-label">{def.label}</span>
                <span className="cq-bonus-guide-region">{regionLabel}</span>
              </span>
              <span className="cq-bonus-guide-chev" aria-hidden="true">
                {isOpen ? "▾" : "▸"}
              </span>
            </button>
            {isOpen && (
              <p
                id={`cq-bonus-guide-effect-${regionId}`}
                className="cq-bonus-guide-effect"
              >
                {effect}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );

  // Rail section — the bottom block of the desktop command rail.  Same row
  // vocabulary as the overlay, but flush (no card chrome, no close): it reads
  // as the rail's third section, not a detached panel.
  if (isRail) {
    return (
      <section
        className="cq-rail-bonus"
        role="region"
        aria-labelledby="cq-rail-bonus-title"
      >
        <h4 id="cq-rail-bonus-title" className="cq-rail-bonus-title">
          <EmojiIcon name="swords" />
          <span>{title}</span>
        </h4>
        <div className="cq-rail-bonus-scroll">{list}</div>
      </section>
    );
  }

  return (
    <aside
      className="cq-bonus-guide"
      role="region"
      aria-labelledby="cq-bonus-guide-title"
    >
      <div className="cq-bonus-guide-head">
        <h3 id="cq-bonus-guide-title" className="cq-bonus-guide-title">
          <EmojiIcon name="swords" />
          <span>{title}</span>
        </h3>
        <button
          type="button"
          className="cq-bonus-guide-close"
          onClick={onClose}
          aria-label="Bonus rehberini kapat"
          title="Kapat"
        >
          ✕
        </button>
      </div>

      <p className="cq-bonus-guide-hint">
        Bonus bölgeyi fetheden oyuncu özel avantaj kazanır. Detay için bir bonusa dokun.
      </p>

      {list}
    </aside>
  );
}
