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
 *   - Çukurova's +1 score is one-shot per match (cukurovaClaimed flag).
 *   - Doğu Karadeniz adds +5s to the bonused player's *next* move phase only.
 */

import type {
  ConquestBonusToast,
  ConquestPlayerBonusState,
  ConquestRegionBonusType,
  ConquestRegionId,
} from "./types";

/**
 * Viewer-specific overrides for a bonus toast.  Today only Ankara's Gizli
 * Operasyon differentiates by viewer (owner sees the buff explanation;
 * opponents see a warning).  Other bonuses fall through to the toast's
 * baked-in copy.
 */
export function getBonusToastCopyForViewer(
  toast:    ConquestBonusToast,
  viewerId: string | null,
): { title: string; detail: string; icon: string } {
  const isOwner = viewerId !== null && viewerId === toast.playerId;

  if (toast.bonusType === "ankara_hidden_shield") {
    if (isOwner) {
      return {
        icon:   "🎭",
        title:  "🎭 Ankara fethedildi: Gizli Operasyon aktif!",
        detail: "Kendi bölgeni gizlice koruyabilir veya tarafsız bir bölgeyi gizlice fethedebilirsin (komşuluk şartı yok).",
      };
    }
    return {
      icon:   "🎭",
      title:  `🎭 Rakip Ankara'yı fethetti (${toast.playerName})`,
      detail: "Haritada gizli bir operasyon yapabilir. Dikkatli saldır!",
    };
  }

  if (toast.bonusType === "cukurova_score") {
    if (isOwner) {
      return {
        icon:   "🌾",
        title:  "Çukurova Bonusu",
        detail: "🌾 Bereket bonusu! +1 bonus puan kazandın.",
      };
    }
    return {
      icon:   "🌾",
      title:  "Çukurova Ele Geçirildi",
      detail: "🌾 Rakip Çukurova'dan güç topluyor! +1 bonus puan aldı — bu bölgeyi geri almak oyunu dengeleyebilir.",
    };
  }

  if (toast.bonusType === "karadeniz_extra_time") {
    if (isOwner) {
      return {
        icon:   "⛰️",
        title:  "Doğu Karadeniz Bonusu",
        detail: "⛰️ Dağ geçitleri sende! Sıradaki hamlene +5 saniye kazandın.",
      };
    }
    return {
      icon:   "⛰️",
      title:  "Doğu Karadeniz Ele Geçirildi",
      detail: "⛰️ Rakip dağ geçitlerini kontrol ediyor. Bir sonraki hamlesinde +5 saniye avantajı olacak.",
    };
  }

  if (toast.bonusType === "istanbul_defense") {
    if (isOwner) {
      return {
        icon:   "🛡️",
        title:  "İstanbul Bonusu",
        detail: "🛡️ İstanbul savunmaya geçti. Açık kalkan aktif.",
      };
    }
    return {
      icon:   "🛡️",
      title:  "İstanbul Ele Geçirildi",
      detail: "🛡️ Rakip İstanbul'u kalkanla korumaya aldı. İlk saldırı kalkanı kıracak.",
    };
  }

  return { icon: toast.icon, title: toast.title, detail: toast.detail };
}

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
 * Ankara Gizli Operasyon hakkı.  By spec the banner MUST NOT leak the chosen
 * region name or whether the op was a shield (own region) or fetih (neutral
 * region) — paranoia is the feature.  Sentinel prefix on `lastResult.message`
 * also re-uses this title text so the gameplay layer can mark placements
 * without storing extra state.
 */
export const HIDDEN_OP_PLACED_TITLE  = "🎭 Gizli Operasyon Başlatıldı";
export function buildHiddenOpPlacedDetail(playerName: string): string {
  return `${playerName}, Ankara'nın gizli operasyon yeteneğini kullandı. Haritada bir bölge gizlice korumaya alındı ya da ele geçirildi. Neresi olduğunu ancak saldırdığında öğreneceksin.`;
}
/** Sentinel prefix on round-result message — used by UI to detect placement
 *  events and surface the center banner.  Carries the player name only. */
export const HIDDEN_OP_PLACED_MESSAGE_PREFIX = "🎭 Gizli Operasyon kullanıldı:";
export function buildHiddenOpPlacedMessage(playerName: string): string {
  return `${HIDDEN_OP_PLACED_MESSAGE_PREFIX} ${playerName} haritada gizli bir hamle yaptı.`;
}

export interface ConquestRegionBonusDef {
  regionId:    ConquestRegionId;
  type:        ConquestRegionBonusType;
  /** Emoji shown on the map and in the player-bonus chips. */
  icon:        string;
  /** Short TR label (chip text / tooltip head). */
  label:       string;
  /** One-line TR description used as a tooltip / help line. */
  description: string;
}

export const REGION_BONUSES: Record<string, ConquestRegionBonusDef> = {
  istanbul_kocaeli: {
    regionId:    "istanbul_kocaeli",
    type:        "istanbul_defense",
    icon:        "🛡️",
    label:       "Boğaz Kalesi",
    description: "İstanbul’u tutan oyuncuya pasif savunma avantajı (altyapı).",
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
    description: "Çukurova’yı maçta ilk fetheden oyuncuya tek seferlik +1 puan.",
  },
  dogu_karadeniz: {
    regionId:    "dogu_karadeniz",
    type:        "karadeniz_extra_time",
    icon:        "⛰️",
    label:       "Geçit Yolu",
    description: "Fethedenin sıradaki hamle süresine +5 saniye ekler (tek kullanım).",
  },
};

/** Karadeniz fetih bonusu — sonraki hamle fazına eklenir. */
export const KARADENIZ_BONUS_MS = 5_000;

export function getRegionBonus(
  regionId: ConquestRegionId,
): ConquestRegionBonusDef | null {
  return REGION_BONUSES[regionId] ?? null;
}

export function createEmptyPlayerBonusState(): ConquestPlayerBonusState {
  return {
    pendingHiddenShield: false,
    extraNextMoveMs:     0,
    cukurovaClaimed:     false,
    bonusPoints:         0,
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
 * earned (capturing a bonus region).  `at` defaults to now; callers can
 * pass an explicit timestamp when constructing inside a transition that
 * already has one.
 */
export function buildBonusToast(
  bonusType:  ConquestRegionBonusType,
  playerId:   string,
  playerName: string,
  at:         number,
): ConquestBonusToast {
  const { icon, title, detail } = BONUS_TOAST_COPY[bonusType];
  return {
    id: `${bonusType}-${at}-${playerId}`,
    bonusType,
    icon,
    title,
    detail,
    playerId,
    playerName,
    at,
  };
}

const BONUS_TOAST_COPY: Record<
  ConquestRegionBonusType,
  { icon: string; title: string; detail: string }
> = {
  istanbul_defense: {
    icon:   "🛡️",
    title:  "İstanbul Bonusu",
    detail: "Açık kalkan İstanbul’a kuruldu.",
  },
  ankara_hidden_shield: {
    icon:   "🎭",
    title:  "Ankara: Gizli Operasyon",
    detail: "Kendi bölgene gizli kalkan ya da tarafsız bir bölgeye gizli fetih uygulayabilirsin (komşuluk şartı yok).",
  },
  cukurova_score: {
    icon:   "🌾",
    title:  "Çukurova Bonusu",
    detail: "+1 puan kazandın.",
  },
  karadeniz_extra_time: {
    icon:   "⛰️",
    title:  "Doğu Karadeniz Bonusu",
    detail: "Sıradaki hamlene +5 saniye.",
  },
};
