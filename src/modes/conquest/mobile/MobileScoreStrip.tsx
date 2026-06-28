/**
 * MobileScoreStrip — horizontal score row, replaces the desktop
 * `.cq-players-panel` overlay on mobile.
 *
 * Each player becomes a compact pill: colour dot, truncated name, big
 * score, region count, and up to two bonus-state chips floating on the
 * top-right corner.  Neutral territory gets its own grey pill on the
 * right end.  Active-turn player gets a coloured ring + slight lift.
 *
 * The bonus-chip logic mirrors ConquestGame's inline rules verbatim so
 * the strip stays in sync with the legacy overlay until that code path
 * is removed:
 *   • open shield (İstanbul) — public, shown to everyone
 *   • extraNextMoveMs (Karadeniz) — public, shown with seconds suffix
 *   • pendingHiddenShield (Ankara, owner-only)
 *   • active hidden shield (Ankara, owner-only)
 *
 * Render order = `players` order (not sorted by score).  This keeps the
 * pill positions stable across rounds.
 */

import type {
  ConquestPlayer,
  ConquestPlayerBonusState,
  ConquestPlayerColor,
  ConquestRegionBonusType,
} from "../types";
import { getBonusTypePresentation, getPlayerBonusState } from "../regionBonuses";
import { ConquestBonusIcon } from "../ConquestAssetIcon";
import GoldIcon from "../../../components/GoldIcon";

interface Props {
  players:            ConquestPlayer[];
  playerColors:       Record<string, ConquestPlayerColor>;
  playerPoints:       Record<string, number>;
  regionCounts:       Record<string, number>;
  playerBonuses:      Record<string, ConquestPlayerBonusState> | undefined;
  openShieldOwners:   Set<string>;
  hiddenShieldOwners: Set<string>;
  /** id of the player currently holding the move (action phase only). */
  actionHolderId:     string | null;
  myPlayerId:         string | null;
  neutralCount:       number;
  neutralPoints:      number;
  /** Transient point deltas per player — non-zero entries render a brief
   *  +N/-N badge floating above the score number.  Lifetime is owned by
   *  the parent (ConquestGame); the strip only renders what it's given. */
  pointDeltas?:       Record<string, { value: number; epoch: number }>;
  /** Kâhin Büyüsü 🔮 preview label.  Owner-only — parent passes null when
   *  the local viewer doesn't hold the Kâhin region. */
  kahinPreview?:      string | null;
}

interface BonusChip {
  key:   string;
  icon:  string;
  title: string;
  /** Bonus tipi — varsa chip PNG asset ile basılır (emoji fallback). */
  assetType?: ConquestRegionBonusType;
}

function buildBonusChips(
  player:             ConquestPlayer,
  bonus:              ConquestPlayerBonusState,
  openShieldOwners:   Set<string>,
  hiddenShieldOwners: Set<string>,
  isMe:               boolean,
): BonusChip[] {
  const chips: BonusChip[] = [];
  // Chip icons follow bonus *type* (canonical), not a fixed region — the
  // dynamic round assignment may move bonuses between tiles but the
  // accumulated player buff (open shield / time bonus / hidden op) keeps
  // its identity.
  const istanbulPres   = getBonusTypePresentation("istanbul_defense");
  const karadenizPres  = getBonusTypePresentation("karadeniz_extra_time");
  const ankaraPres     = getBonusTypePresentation("ankara_hidden_shield");
  const eliminatorPres = getBonusTypePresentation("eleme_yetkisi");
  if (openShieldOwners.has(player.id)) {
    chips.push({
      key:   "ist",
      icon:  istanbulPres.icon,
      assetType: "istanbul_defense",
      title: "Açık kalkan aktif",
    });
  }
  if (bonus.extraNextMoveMs > 0) {
    chips.push({
      key:   "kdz",
      icon:  karadenizPres.icon,
      assetType: "karadeniz_extra_time",
      title: `${karadenizPres.label} (+${Math.round(bonus.extraNextMoveMs / 1000)}sn)`,
    });
  }
  if (isMe && bonus.pendingHiddenShield) {
    chips.push({
      key:   "ank-pending",
      icon:  ankaraPres.icon,
      assetType: "ankara_hidden_shield",
      title: "Gizli Operasyon hazır",
    });
  }
  if (isMe && hiddenShieldOwners.has(player.id)) {
    chips.push({
      key:   "ank-active",
      icon:  "🕶️",
      title: "Gizli Operasyon aktif",
    });
  }
  if (isMe && (bonus.eliminatorCharges ?? 0) > 0) {
    chips.push({
      key:   "elem",
      icon:  eliminatorPres.icon,
      assetType: "eleme_yetkisi",
      title: "Eleme Yetkisi hazır",
    });
  }
  if ((bonus.guardianShieldBypassCharges ?? 0) > 0) {
    chips.push({
      key:   "guardian",
      icon:  "🛡️",
      title: isMe
        ? "Muhafız Desteği hazır"
        : `${player.name} Muhafız Desteği hakkına sahip`,
    });
  }
  // Sis Çöktü 🌫️ — public chip; kart reveal zaten public, opponent da
  // "kör görüyor" intelini alır.
  if (bonus.fogActive === true) {
    chips.push({
      key:   "fog",
      icon:  "🌫️",
      title: isMe
        ? "Sis Çöktü aktif: puanlar ve hedef göstergeleri gizli. Bir fetih sisi dağıtır."
        : `${player.name} Sis Çöktü etkisinde`,
    });
  }
  return chips;
}

export default function MobileScoreStrip({
  players,
  playerColors,
  playerPoints,
  regionCounts,
  playerBonuses,
  openShieldOwners,
  hiddenShieldOwners,
  actionHolderId,
  myPlayerId,
  neutralCount,
  neutralPoints,
  pointDeltas,
  kahinPreview,
}: Props) {
  return (
    <div className="mcq-strip" role="list" aria-label="Oyuncu skorları">
      {kahinPreview && (
        <div
          className="mcq-strip__pill mcq-strip__pill--kahin"
          role="listitem"
          aria-label={`Kâhin görüsü: sıradaki soru ${kahinPreview}`}
        >
          <div className="mcq-strip__pill-top">
            <span className="mcq-strip__pill-dot" aria-hidden="true">🔮</span>
            <span className="mcq-strip__pill-name">Sıradaki soru</span>
          </div>
          <div className="mcq-strip__pill-stats" aria-hidden="true">
            <span className="mcq-strip__pill-points">{kahinPreview}</span>
          </div>
        </div>
      )}
      {players.map(player => {
        const color    = playerColors[player.id];
        const isHolder = actionHolderId === player.id;
        const isMe     = myPlayerId === player.id;
        const bonus    = getPlayerBonusState(playerBonuses, player.id);
        const chips    = buildBonusChips(
          player, bonus, openShieldOwners, hiddenShieldOwners, isMe,
        );
        const visibleChips  = chips.slice(0, 2);
        const overflowCount = chips.length - visibleChips.length;
        const points        = playerPoints[player.id] ?? 0;
        const regions       = regionCounts[player.id] ?? 0;
        const delta         = pointDeltas?.[player.id];
        return (
          <div
            key={player.id}
            className={
              "mcq-strip__pill"
              + (isHolder ? " mcq-strip__pill--active" : "")
              + (isMe ? " mcq-strip__pill--me" : "")
            }
            data-color={color}
            role="listitem"
            aria-label={`${player.name} — ${points} puan, ${regions} bölge${isHolder ? " (sırada)" : ""}`}
          >
            <div className="mcq-strip__pill-top">
              <span className="mcq-strip__pill-dot" aria-hidden="true" />
              <span className="mcq-strip__pill-name">{player.name}</span>
            </div>
            <div className="mcq-strip__pill-stats" aria-hidden="true">
              <span
                className="mcq-strip__pill-points"
                data-bouncing={delta ? "true" : undefined}
              >
                {points}
              </span>
              <span className="mcq-strip__pill-regions">{regions}b</span>
              {(bonus.matchGoldEarned ?? 0) > 0 && (
                <span
                  className="mcq-strip__pill-gold"
                  title={`Bu maçta +${bonus.matchGoldEarned ?? 0} Gold`}
                >
                  +{bonus.matchGoldEarned ?? 0}<GoldIcon />
                </span>
              )}
              {delta && (
                <span
                  key={delta.epoch}
                  className="mcq-strip__pill-delta"
                  data-sign={delta.value > 0 ? "pos" : "neg"}
                >
                  {delta.value > 0 ? `+${delta.value}` : delta.value}
                </span>
              )}
            </div>
            {visibleChips.length > 0 && (
              <span className="mcq-strip__pill-chips" aria-hidden="true">
                {visibleChips.map(c => (
                  <span
                    key={c.key}
                    className="mcq-strip__pill-chip"
                    title={c.title}
                  >
                    {c.assetType
                      ? <ConquestBonusIcon type={c.assetType} fallbackChar={c.icon} alt={c.title} />
                      : c.icon}
                  </span>
                ))}
                {overflowCount > 0 && (
                  <span
                    className="mcq-strip__pill-chip mcq-strip__pill-chip--overflow"
                    title={`+${overflowCount} bonus`}
                  >
                    +{overflowCount}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
      {neutralCount > 0 && (
        <div
          className="mcq-strip__pill mcq-strip__pill--neutral"
          role="listitem"
          aria-label={`${neutralPoints} puanlık ${neutralCount} tarafsız bölge`}
        >
          <div className="mcq-strip__pill-top">
            <span className="mcq-strip__pill-dot" aria-hidden="true" />
            <span className="mcq-strip__pill-name">Tarafsız</span>
          </div>
          <div className="mcq-strip__pill-stats" aria-hidden="true">
            <span className="mcq-strip__pill-points">{neutralPoints}</span>
            <span className="mcq-strip__pill-regions">{neutralCount}b</span>
          </div>
        </div>
      )}
    </div>
  );
}
