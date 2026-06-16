/**
 * Conquest (Kuşatma) — region bonus catalog.
 *
 * First-pass bonus layer for the four marquee regions: İstanbul, Ankara,
 * Çukurova, Doğu Karadeniz.  Pure data + tiny pure helpers; bonus effects
 * are applied by conquestGameplay.applyActionToGame and consumed by
 * conquestGameplay.consumeMoveTimeBonus.
 *
 * Design rules locked here:
 *   - Bonuses trigger on *capture events*, never on initial distribution.
 *   - "stack olmasın" → repeat triggers overwrite, do not accumulate.
 *   - İstanbul's defense is a passive marker (no gameplay hook today — there
 *     is no question-difficulty system to bind to).  UI shows it whenever
 *     someone owns İstanbul; no persisted player flag needed.
 *   - Ankara's Gizli Operasyon is region-bound (`hiddenShieldOwnerId` on
 *     ConquestRegionState) and stays through one opposing capture attempt.
 *     Two flavours: kind="shield" (cloak on own region) or kind="conquest"
 *     (gizli fetih on a neutral region; ownership flips for real but is
 *     masked from opponents until the first attack triggers a reveal).
 *   - Bereketli Ova (cukurova_score) pays the new owner +2 bonus points on
 *     every capture and a one-shot +4 harvest payout the first time the same
 *     owner has held the region for 3 round-ends in a row.  The held-tenure
 *     counter (`bereketHarvestTurns`) is parked at the interval value after
 *     the harvest fires and resets to 0 on every ownership change, so a long
 *     uninterrupted tenure pays the +4 exactly once.
 *   - Doğu Karadeniz adds +5s to the bonused player's *next* move phase only.
 */

import type {
  ConquestBonusToast,
  ConquestPlayerBonusState,
  ConquestRegionBonusDef,
  ConquestRegionBonusType,
  ConquestRegionId,
} from "./types";
import { BONUS_POOL } from "./bonusPool";

export type { ConquestRegionBonusDef } from "./types";

/**
 * Viewer-specific overrides for a bonus toast.  Today only Ankara's Gizli
 * Operasyon differentiates by viewer (owner sees the buff explanation;
 * opponents see a warning).  Other bonuses fall through to the toast's
 * baked-in copy.
 */
export function getBonusToastCopyForViewer(
  toast:        ConquestBonusToast,
  viewerId:     string | null,
  /**
   * Display label of the region the bonus actually landed on this round.
   * When omitted (legacy saves), the copy falls back to the bonus type's
   * original city name so pre-dynamic-bonus rooms still read sensibly.
   */
  regionLabel?: string | null,
): { title: string; detail: string; icon: string } {
  const isOwner = viewerId !== null && viewerId === toast.playerId;
  // Choose the region phrase: explicit label wins; otherwise fall back to
  // the bonus type's canonical home city (the legacy text).
  const fallbackCity = LEGACY_BONUS_CITY[toast.bonusType] ?? "Bölge";
  const where        = regionLabel || fallbackCity;

  if (toast.bonusType === "ankara_hidden_shield") {
    if (isOwner) {
      return {
        icon:   "🎭",
        title:  `${where} fethedildi: Gizli Operasyon aktif!`,
        detail: "Kendi bölgeni gizlice koruyabilir veya tarafsız bir bölgeyi gizlice fethedebilirsin (komşuluk şartı yok).",
      };
    }
    return {
      icon:   "🎭",
      title:  `Rakip ${where} bölgesini fethetti (${toast.playerName})`,
      detail: "Haritada gizli bir operasyon yapabilir. Dikkatli saldır!",
    };
  }

  if (toast.bonusType === "cukurova_score") {
    // Harvest-flavour toast (id prefix `bereket_harvest-`) carries its own
    // owner-specific copy already; pass it through verbatim so every viewer
    // reads the same "Hasat" line and points value.
    if (toast.id.startsWith("bereket_harvest-")) {
      return { icon: toast.icon, title: toast.title, detail: toast.detail };
    }
    if (isOwner) {
      return {
        icon:   "🌾",
        title:  `${where} Bonusu`,
        detail: "Bereketli Ova fethedildi: +2 bonus puan kazandın. 3 tur elinde tutarsan bir kereye mahsus +4 puanlık hasat bonusu alırsın.",
      };
    }
    return {
      icon:   "🌾",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip ${where}'dan +2 bonus puan aldı. 3 tur boyunca elinde tutarsa bir kereye mahsus +4 hasat bonusu kazanır — geri almak dengeleyebilir.`,
    };
  }

  if (toast.bonusType === "karadeniz_extra_time") {
    if (isOwner) {
      return {
        icon:   "⏳",
        title:  `${where} Bonusu`,
        detail: "Zaman Takviyesi sende! Soru süresine +5 saniye eklendi.",
      };
    }
    return {
      icon:   "⏳",
      title:  `${where} Ele Geçirildi`,
      detail: "Rakip Zaman Takviyesi'ni eline geçirdi. Sıradaki sorusunda +5 saniye avantajı olacak.",
    };
  }

  if (toast.bonusType === "istanbul_defense") {
    if (isOwner) {
      return {
        icon:   "🛡️",
        title:  `${where} Bonusu`,
        detail: `Açık kalkan kuruldu: ${where} bölgesine gelen ilk düşman saldırısı bölgeyi değil kalkanı kırar.`,
      };
    }
    return {
      icon:   "🛡️",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip ${where} bölgesini kalkanla korumaya aldı. İlk saldırı kalkanı kıracak.`,
    };
  }

  if (toast.bonusType === "mancinik") {
    if (isOwner) {
      return {
        icon:   "🎯",
        title:  `${where} Bonusu`,
        detail: "Mancınık hazır! Bir sonraki saldırında komşuluk şartı olmadan haritadaki herhangi bir bölgeyi hedefleyebilirsin. Kale Surları'nı yok saymaz.",
      };
    }
    return {
      icon:   "🎯",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip Mancınık'ı eline geçirdi. Bir sonraki saldırısında uzak bir bölgeni vurabilir — dikkatli ol.`,
    };
  }

  if (toast.bonusType === "kocbasi") {
    // Capture-of-enemy variant: toast id prefix `kocbasi_capture-` is
    // emitted by `buildKocbasiCaptureToast` (see conquestGameplay.applyKocbasi…),
    // signalling that the +1 payout fired.  Keep that toast's own title /
    // detail so the "kalkanı aştı" copy comes through.
    if (toast.id.startsWith("kocbasi_capture-")) {
      return { icon: toast.icon, title: toast.title, detail: toast.detail };
    }
    if (isOwner) {
      return {
        icon:   "🪵",
        title:  `${where} Bonusu`,
        detail: "Koçbaşı sende! Kalkanları aşar, rakip bölge fethedince +1 puan kazandırır.",
      };
    }
    return {
      icon:   "🪵",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip Koçbaşı'nı eline geçirdi. Saldırırken kalkanlar yetersiz kalabilir, dikkat et.`,
    };
  }

  if (toast.bonusType === "liman") {
    // Income-tick toasts carry their own player-specific text (name + N/10 +
    // gold/points).  Keep verbatim so opponents and owner both read the same
    // public-event line — visibility is part of the feature.
    if (toast.id.startsWith("liman_income-")) {
      return { icon: toast.icon, title: toast.title, detail: toast.detail };
    }
    // Capture-flavour banner: someone just took the Liman region.  Describe
    // the bonus itself so the moment reads as a meaningful pick-up.
    if (isOwner) {
      return {
        icon:   "⚓",
        title:  `${where} Bonusu`,
        detail: `Liman sende! Her tur sonunda +1 puan ve +5 Gold kazanırsın (en fazla 10 kez).`,
      };
    }
    return {
      icon:   "⚓",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip Liman'ı eline geçirdi. Her tur sonunda gelir kazanacak — geri almak ekonomiyi dengeler.`,
    };
  }

  if (toast.bonusType === "kahin") {
    if (isOwner) {
      return {
        icon:   "🔮",
        title:  `${where} Bonusu`,
        detail: "Kâhin Büyüsü sende! Sıradaki sorunun türünü önceden görüyorsun. Bölgeyi elinde tuttuğun sürece görü devam eder.",
      };
    }
    return {
      icon:   "🔮",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip Kâhin Büyüsü'nü eline geçirdi. Sıradaki soruların türünü önden görüyor — bölgeyi geri almak bilgi avantajını sıfırlar.`,
    };
  }

  if (toast.bonusType === "istihbarat_agi") {
    if (isOwner) {
      return {
        icon:   "👁️",
        title:  `İstihbarat Ağı Kuruldu!`,
        detail: `${where} artık senin kontrolünde. Rakiplerin gizli bonus keşiflerini ve Gizli Operasyon hamlelerini rapor olarak görebileceksin.`,
      };
    }
    return {
      icon:   "👁️",
      title:  `Rakip İstihbarat Ağı Kurdu!`,
      detail: `${toast.playerName} ${where} bölgesini kontrol altına aldı. Gizli hamleler artık onun için daha görünür olacak.`,
    };
  }

  if (toast.bonusType === "mevzi_bekcisi") {
    // Loss-flavour banner: emitted when a mevzi region changed hands.  The
    // previous owner keeps the region's point value as a "mevzi" protection
    // payout; `toast.playerId` is that previous owner.
    if (toast.pointsPreserved !== undefined) {
      const pts = toast.pointsPreserved;
      if (isOwner) {
        return {
          icon:   "🏰",
          title:  `Mevzi direndi: ${pts} puan korundu.`,
          detail: `${where} bölgesini kaybettin ama mevzi puanın hâlâ sende — toplam skoruna sayılır.`,
        };
      }
      return {
        icon:   "🏰",
        title:  `${where} mevzi direndi`,
        detail: `${toast.playerName} ${where} bölgesini kaybetti ama ${pts} puanını mevzi koruması olarak kurtardı.`,
      };
    }
    // Capture-flavour banner: someone just took the mevzi region.  No prior
    // owner to pay out (initial capture from neutral) — describe the bonus.
    if (isOwner) {
      return {
        icon:   "🏰",
        title:  `${where} Bonusu`,
        detail: `Mevzi Bekçisi: ${where} bölgesini kaybetsen bile puanını korursun.`,
      };
    }
    return {
      icon:   "🏰",
      title:  `${where} Ele Geçirildi`,
      detail: `Rakip ${where} bölgesinde Mevzi Bekçisi avantajı kazandı: bu bölgeyi kaybetse bile puanını korur.`,
    };
  }

  return { icon: toast.icon, title: toast.title, detail: toast.detail };
}

/** Legacy "home city" per bonus type — used only when the toast lacks a
 *  region label (pre-dynamic-bonus saves).  Keeps old rooms readable.
 *
 *  `Partial` because the bonus type union also carries pool-only entries
 *  (see bonusPool.ts) that are never assigned today and therefore never
 *  raise a toast.  Lookups fall back to a generic city string at the call
 *  site so missing keys are safe. */
const LEGACY_BONUS_CITY: Partial<Record<ConquestRegionBonusType, string>> = {
  istanbul_defense:     "İstanbul",
  ankara_hidden_shield: "Ankara",
  cukurova_score:       "Çukurova",
  karadeniz_extra_time: "Doğu Karadeniz",
};

/**
 * Reveal banners — same for every viewer per spec.  Two variants because
 * Ankara's Gizli Operasyon can be placed two ways:
 *   - On a tarafsız bölge: "gizli fetih" — the region was secretly captured
 *     and showed as neutral to opponents; first attack reveals real ownership.
 *   - On a region the player already openly owns: "gizli kalkan" — the region
 *     was secretly shielded against the first hit.
 */
export const HIDDEN_CONQUEST_REVEAL_MESSAGE =
  "🕶️ Gizli fetih ortaya çıktı! Bu bölge rakibin kontrolündeydi; saldırı boşa düştü.";
export const HIDDEN_SHIELD_REVEAL_MESSAGE =
  "🛡️ Gizli kalkan ortaya çıktı! Rakibin bu bölgeyi korumaya almıştı; saldırı boşa gitti.";
/**
 * Legacy "neutral_trap" reveal — no new code emits this kind; kept so older
 * in-flight saves still reveal cleanly.  See `placeHiddenConquestOnNeutralRegion`
 * for the new flow that flips ownership instead of trapping.
 */
export const HIDDEN_NEUTRAL_TRAP_REVEAL_MESSAGE =
  "🕶️ Gizli koruma ortaya çıktı! Bu bölge rakip tarafından tuzaklanmıştı; saldırı boşa düştü.";

/**
 * Center-screen banner shown to ALL clients when a player consumes their
 * Gizli Operasyon hakkı.  By spec the banner MUST NOT leak the chosen
 * target region or whether the op was a shield (own region) or fetih
 * (neutral region) — paranoia is the feature.  Sentinel prefix on
 * `lastResult.message` also re-uses this title text so the gameplay layer
 * can mark placements without storing extra state.
 *
 * `bonusRegionLabel` is the display label of the region that currently
 * carries the gizli-operasyon bonus this match (resolved from the dynamic
 * `roundBonuses` assignment).  When omitted (legacy saves) the copy
 * gracefully drops the possessive so we never lie with a stale Ankara
 * reference if the bonus actually landed elsewhere.
 */
export const HIDDEN_OP_PLACED_TITLE  = "🎭 Gizli Operasyon Başlatıldı";
export function buildHiddenOpPlacedDetail(
  playerName:        string,
  bonusRegionLabel?: string | null,
): string {
  const opener = bonusRegionLabel
    ? `${playerName}, ${bonusRegionLabel} bölgesinin gizli operasyon yeteneğini kullandı.`
    : `${playerName}, gizli operasyon yeteneğini kullandı.`;
  return `${opener} Haritada bir bölge gizlice korumaya alındı ya da ele geçirildi. Neresi olduğunu ancak saldırdığında öğreneceksin.`;
}
/** Sentinel prefix on round-result message — used by UI to detect placement
 *  events and surface the center banner.  Carries the player name only. */
export const HIDDEN_OP_PLACED_MESSAGE_PREFIX = "🎭 Gizli Operasyon kullanıldı:";
export function buildHiddenOpPlacedMessage(playerName: string): string {
  return `${HIDDEN_OP_PLACED_MESSAGE_PREFIX} ${playerName} haritada gizli bir hamle yaptı.`;
}

export const REGION_BONUSES: Record<string, ConquestRegionBonusDef> = {
  istanbul_kocaeli: {
    regionId:    "istanbul_kocaeli",
    type:        "istanbul_defense",
    icon:        "🛡️",
    label:       "Kale Surları",
    description: "Bu bölgeyi fetheden oyuncu Kale Surları kazanır. Bölgeye gelen ilk başarılı düşman saldırısı bölgeyi değil surları yıkar.",
  },
  ankara_cevre: {
    regionId:    "ankara_cevre",
    type:        "ankara_hidden_shield",
    icon:        "🎭",
    label:       "Gizli Operasyon",
    description: "Ankara’yı fetheden, sahip olduğu bir bölgeye gizli kalkan ya da tarafsız bir bölgeye gizli fetih uygulayabilir (komşuluk şartı yok).",
  },
  cukurova: {
    regionId:    "cukurova",
    type:        "cukurova_score",
    icon:        "🌾",
    label:       "Bereketli Ova",
    description: "Bu bölgeyi fetheden oyuncuya anında +2 bonus puan. Aynı oyuncu 3 tur boyunca elinde tutarsa bir kereye mahsus +4 puanlık hasat bonusu kazanır; aynı sahipte kaldıkça tekrar hasat verilmez. Bölge el değiştirince sayaç sıfırlanır.",
  },
  dogu_karadeniz: {
    regionId:    "dogu_karadeniz",
    type:        "karadeniz_extra_time",
    icon:        "⏳",
    label:       "Zaman Takviyesi",
    description: "Soru süresine +5 saniye ekler.",
  },
};

/** Karadeniz fetih bonusu — sonraki hamle fazına eklenir. */
export const KARADENIZ_BONUS_MS = 5_000;

export function getRegionBonus(
  regionId: ConquestRegionId,
): ConquestRegionBonusDef | null {
  return REGION_BONUSES[regionId] ?? null;
}

/**
 * Icon + label per bonus type — looked up via the static catalog (since the
 * canonical icon/copy belongs to the type, not the region).  Used by the
 * player-bonus-chip rows in ConquestGame and MobileScoreStrip, whose chips
 * are tied to bonus *types* the player has accumulated (e.g. extraNextMoveMs
 * + Karadeniz icon), independent of which region carried the type this round.
 *
 * Seeded from REGION_BONUSES first (legacy region-tied entries: istanbul,
 * ankara, çukurova, karadeniz) and then filled in from BONUS_POOL for any
 * pool-resident type not yet covered (e.g. eleme_yetkisi).  REGION_BONUSES
 * wins on overlap so legacy region-flavoured labels stay verbatim.
 */
export const BONUS_TYPE_PRESENTATION: Record<
  ConquestRegionBonusType,
  { icon: string; label: string }
> = (() => {
  const out: Record<string, { icon: string; label: string }> = {};
  for (const entry of BONUS_POOL) {
    out[entry.type] = { icon: entry.icon, label: entry.label };
  }
  for (const def of Object.values(REGION_BONUSES)) {
    out[def.type] = { icon: def.icon, label: def.label };
  }
  return out as Record<ConquestRegionBonusType, { icon: string; label: string }>;
})();

export function getBonusTypePresentation(
  type: ConquestRegionBonusType,
): { icon: string; label: string } {
  return BONUS_TYPE_PRESENTATION[type] ?? { icon: "⭐", label: "Bonus" };
}

export function createEmptyPlayerBonusState(): ConquestPlayerBonusState {
  return {
    pendingHiddenShield: false,
    extraNextMoveMs:     0,
    cukurovaClaimed:     false,
    bonusPoints:         0,
    eliminatorCharges:   0,
    mancinikCharges:     0,
    guardianShieldBypassCharges: 0,
    matchGoldEarned:     0,
    fogActive:           false,
  };
}

/** Safe read — returns a fresh empty state if the player has none yet. */
export function getPlayerBonusState(
  bonuses:  Record<string, ConquestPlayerBonusState> | undefined,
  playerId: string,
): ConquestPlayerBonusState {
  return bonuses?.[playerId] ?? createEmptyPlayerBonusState();
}

/**
 * Build a sync-friendly bonus toast.  Called by gameplay when a bonus is
 * earned (capturing a bonus region).  `at` is the toast timestamp; callers
 * pass it in so multiple transitions in the same tick share an anchor.
 *
 * `regionId` ties the toast to a specific tile so capital-cinematic
 * coordination (Ankara reveal hold) can check the *region* instead of the
 * static bonus type — required for dynamic bonus assignment where any region
 * may carry any bonus type per round.
 */
export function buildBonusToast(
  bonusType:  ConquestRegionBonusType,
  regionId:   ConquestRegionId,
  playerId:   string,
  playerName: string,
  at:         number,
): ConquestBonusToast {
  // Fallback covers pool-only types from bonusPool.ts that have no
  // BONUS_TOAST_COPY entry; in practice they're never assigned to a region
  // today, so this branch is defensive — it never runs in the current build.
  const { icon, title, detail } = BONUS_TOAST_COPY[bonusType] ?? {
    icon:   "⭐",
    title:  "Bonus",
    detail: "",
  };
  return {
    id: `${bonusType}-${regionId}-${at}-${playerId}`,
    bonusType,
    regionId,
    icon,
    title,
    detail,
    playerId,
    playerName,
    at,
  };
}

/**
 * Build a Koçbaşı 🪵 capture-flavour toast — fired when the bonus holder
 * fethes an enemy region and earns the +1 bonus point.  Title switches to
 * the "kalkanı aştı" copy when the capture also bypassed an open shield.
 */
export function buildKocbasiCaptureToast(
  regionId:        ConquestRegionId,
  attackerId:      string,
  attackerName:    string,
  shieldBypassed:  boolean,
  at:              number,
): ConquestBonusToast {
  return {
    id: `kocbasi_capture-${regionId}-${at}-${attackerId}`,
    bonusType:        "kocbasi",
    regionId,
    icon:             "🪵",
    title:            shieldBypassed
      ? "Koçbaşı kalkanı aştı: +1 puan"
      : "Koçbaşı: +1 puan",
    detail:           shieldBypassed
      ? "Kalkan aşıldı ve rakip bölgesi fethedildi. +1 bonus puan kazandın."
      : "Rakip bölgesi fethedildi. +1 bonus puan kazandın.",
    playerId:         attackerId,
    playerName:       attackerName,
    at,
  };
}

/**
 * Build a Mevzi Bekçisi loss-flavour toast — fired when the bonus region
 * changes hands.  Carries `pointsPreserved` + `previousOwnerId` so the viewer
 * copy switches to "Mevzi direndi: X puan korundu." for the player who keeps
 * the points, and shows an informational variant to everyone else.
 *
 * `playerId` / `playerName` on the toast are the PREVIOUS owner (the one who
 * just kept the points).  This drives toast colour and viewer-aware copy.
 */
export function buildMevziLossToast(
  regionId:         ConquestRegionId,
  previousOwnerId:  string,
  previousOwnerName: string,
  pointsPreserved:  number,
  at:               number,
): ConquestBonusToast {
  return {
    id: `mevzi_loss-${regionId}-${at}-${previousOwnerId}`,
    bonusType:        "mevzi_bekcisi",
    regionId,
    icon:             "🏰",
    title:            "Mevzi Direndi",
    detail:           `${pointsPreserved} puan korundu.`,
    playerId:         previousOwnerId,
    playerName:       previousOwnerName,
    at,
    pointsPreserved,
    previousOwnerId,
  };
}

/**
 * Per-type toast copy.  `Partial` because the bonus type union also carries
 * pool-only entries (see bonusPool.ts) that have no wired effect today and
 * therefore never raise a toast.  `buildBonusToast` resolves missing keys
 * via a generic fallback at runtime.
 */
const BONUS_TOAST_COPY: Partial<Record<
  ConquestRegionBonusType,
  { icon: string; title: string; detail: string }
>> = {
  istanbul_defense: {
    icon:   "🛡️",
    title:  "İstanbul Bonusu",
    detail: "Açık kalkan İstanbul’a kuruldu.",
  },
  ankara_hidden_shield: {
    icon:   "🎭",
    /* Used only as a fallback for legacy saves with no toast region label
     * (getBonusToastCopyForViewer prefers the dynamic region label when
     * present, so live matches never display the static "Bonus" word). */
    title:  "Gizli Operasyon",
    detail: "Kendi bölgene gizli kalkan ya da tarafsız bir bölgeye gizli fetih uygulayabilirsin (komşuluk şartı yok).",
  },
  cukurova_score: {
    icon:   "🌾",
    title:  "Bereketli Ova Bonusu",
    detail: "+2 puan kazandın. 3 tur elinde tutarsan bir kereye mahsus +4 puanlık hasat bonusu alırsın.",
  },
  karadeniz_extra_time: {
    icon:   "⏳",
    title:  "Zaman Takviyesi Bonusu",
    detail: "Soru süresine +5 saniye eklendi.",
  },
  eleme_yetkisi: {
    icon:   "🃏",
    title:  "Eleme Yetkisi Bonusu",
    detail: "Sonraki test sorunda 1 yanlış şık silinir.",
  },
  mevzi_bekcisi: {
    icon:   "🏰",
    title:  "Mevzi Bekçisi Bonusu",
    detail: "Bu bölgeyi kaybetsen bile puanını korursun.",
  },
  kocbasi: {
    icon:   "🪵",
    title:  "Koçbaşı Bonusu",
    detail: "Kalkanları aşar. Rakip bölge fethedince +1 puan kazandırır.",
  },
  mancinik: {
    icon:   "🎯",
    title:  "Mancınık Bonusu",
    detail: "Bir sonraki saldırı komşuluk şartı olmadan haritadaki herhangi bir bölgeyi hedefleyebilir.",
  },
  liman: {
    icon:   "⚓",
    title:  "Liman Bonusu",
    detail: "Her tur sonunda +1 puan ve +5 Gold (en fazla 10 kez).",
  },
  kahin: {
    icon:   "🔮",
    title:  "Kâhin Büyüsü Bonusu",
    detail: "Sıradaki sorunun türünü önceden görürsün.",
  },
  istihbarat_agi: {
    icon:   "👁️",
    title:  "İstihbarat Ağı Bonusu",
    detail: "Rakip gizli bonus keşiflerini ve Gizli Operasyon hedeflerini rapor olarak görürsün.",
  },
};
