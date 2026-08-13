/**
 * buildMobileJokerEntries — derives "what advantages do I currently hold?"
 * for the local player, for the mobile joker rail.
 *
 * Two sources, deliberately merged into one list because the player does not
 * think of them as different things:
 *   • banked charges on `ConquestPlayerBonusState` (Gizli Operasyon hazır,
 *     Eleme Yetkisi, +5sn on the next move, Muhafız Desteği…)
 *   • bonus regions the player currently owns (Kâhin, Liman, Bereketli Ova…)
 *
 * The rules encoded here mirror the chip rules already in MobileScoreStrip —
 * `openShieldOwners` / `hiddenShieldOwners` are computed by ConquestGame and
 * passed in rather than re-derived, so there is exactly one authority for
 * who holds what.  Nothing here reads or writes game state.
 *
 * Ordering is stable and intent-first: one-shot charges the player can spend
 * on their next action come before passive holdings, so the rail's top entry
 * is always the most actionable one.
 */

import { getBonusPoolEntry } from "../bonusPool";
import { getBonusTypePresentation } from "../regionBonuses";
import { BONUS_TYPE_EFFECT_COPY } from "../ConquestBonusGuide";
import type { JokerEntry } from "./MobileJokerRail";
import type {
  ConquestPlayerBonusState,
  ConquestRegionBonusType,
} from "../types";

/** A bonus region the local player currently owns. */
export interface HeldBonusRegion {
  regionId:    string;
  regionLabel: string;
  type:        ConquestRegionBonusType;
}

function describe(type: ConquestRegionBonusType): string {
  return BONUS_TYPE_EFFECT_COPY[type]
    ?? getBonusPoolEntry(type)?.description
    ?? "Bu bonusun etkisi bu turda geçerli.";
}

function categoryOf(type: ConquestRegionBonusType): JokerEntry["category"] {
  return getBonusPoolEntry(type)?.category;
}

export function buildMobileJokerEntries(args: {
  bonus:            ConquestPlayerBonusState | undefined;
  /** True when the local player currently holds an open (İstanbul) shield. */
  hasOpenShield:    boolean;
  /** True when the local player has a hidden shield live on the board. */
  hasHiddenShield:  boolean;
  /** Bonus regions the local player owns right now. */
  heldRegions:      HeldBonusRegion[];
}): JokerEntry[] {
  const { bonus, hasOpenShield, hasHiddenShield, heldRegions } = args;
  const out: JokerEntry[] = [];

  const push = (
    key: string,
    type: ConquestRegionBonusType | undefined,
    fallbackIcon: string,
    label: string,
    state: string | undefined,
    detail: string,
    category?: JokerEntry["category"],
  ) => {
    out.push({ key, type, icon: fallbackIcon, label, state, detail, category });
  };

  // ── Banked one-shots (most actionable first) ─────────────────────────────
  if (bonus?.pendingHiddenShield) {
    const p = getBonusTypePresentation("ankara_hidden_shield");
    push(
      "pending-hidden", "ankara_hidden_shield", p.icon, p.label, "hazır",
      "Sıradaki hamlende gizli bir kalkan ya da gizli fetih kurabilirsin. Rakipler bölgeyi olduğu gibi görmeye devam eder.",
      categoryOf("ankara_hidden_shield"),
    );
  }
  if ((bonus?.eliminatorCharges ?? 0) > 0) {
    const p = getBonusTypePresentation("eleme_yetkisi");
    push(
      "eliminator", "eleme_yetkisi", p.icon, p.label,
      (bonus!.eliminatorCharges ?? 0) > 1 ? `${bonus!.eliminatorCharges}×` : "hazır",
      describe("eleme_yetkisi"), categoryOf("eleme_yetkisi"),
    );
  }
  if ((bonus?.extraNextMoveMs ?? 0) > 0) {
    const p = getBonusTypePresentation("karadeniz_extra_time");
    push(
      "extra-time", "karadeniz_extra_time", p.icon, p.label,
      `+${Math.round((bonus!.extraNextMoveMs ?? 0) / 1000)}sn`,
      describe("karadeniz_extra_time"), categoryOf("karadeniz_extra_time"),
    );
  }
  if ((bonus?.mancinikCharges ?? 0) > 0) {
    const p = getBonusTypePresentation("mancinik");
    push(
      "mancinik", "mancinik", p.icon, p.label, "hazır",
      describe("mancinik"), categoryOf("mancinik"),
    );
  }
  if ((bonus?.guardianShieldBypassCharges ?? 0) > 0) {
    push(
      "guardian", undefined, "🛡️", "Muhafız Desteği", "hazır",
      "Sıradaki saldırında rakibin kalkanını dikkate almadan ilerlersin.",
      "savunma",
    );
  }

  // ── Live board state ─────────────────────────────────────────────────────
  if (hasOpenShield) {
    const p = getBonusTypePresentation("istanbul_defense");
    push(
      "open-shield", "istanbul_defense", p.icon, p.label, "aktif",
      describe("istanbul_defense"), categoryOf("istanbul_defense"),
    );
  }
  if (hasHiddenShield) {
    push(
      "hidden-active", undefined, "🕶️", "Gizli Operasyon", "sahada",
      "Haritada kurduğun gizli kalkan hâlâ ayakta. İlk düşman saldırısı ona çarpar.",
      "saldiri",
    );
  }
  if (bonus?.fogActive === true) {
    push(
      "fog", undefined, "🌫️", "Sis Çöktü", "aktif",
      "Puanlar ve hedef göstergeleri senden gizli. Bir fetih sisi dağıtır.",
      "bilgi",
    );
  }

  // ── Bonus regions currently owned ────────────────────────────────────────
  for (const r of heldRegions) {
    const p = getBonusTypePresentation(r.type);
    push(
      `held:${r.regionId}`, r.type, p.icon, p.label, r.regionLabel,
      describe(r.type), categoryOf(r.type),
    );
  }

  return out;
}
