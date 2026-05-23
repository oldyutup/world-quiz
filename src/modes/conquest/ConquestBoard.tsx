/**
 * ConquestBoard — responsive region grid for Kuşatma.
 *
 * Renders one ConquestRegionCard per region in the selected map config.
 * The grid layout is CSS-only (auto-fill), making it straightforward to
 * swap in real polygon/SVG map rendering later without touching this
 * component's data wiring.
 *
 * Phase-6: interactive — when `onRegionClick` is provided, every region
 * becomes a button; `legalRegionIds` highlights valid action targets and
 * `flashRegionId` momentarily marks the last illegally-clicked region.
 *
 * When no onRegionClick is provided, the board renders display-only
 * (lobby/preview parity preserved).
 */

import type {
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";
import ConquestRegionCard from "./ConquestRegionCard";

interface Props {
  mapConfig:       ConquestMapConfig;
  regionStates:    ConquestRegionState[];
  players:         ConquestPlayer[];
  playerColors:    Record<string, ConquestPlayerColor>;
  /** Fires on any region click — caller decides legality + reaction. */
  onRegionClick?:  (regionId: ConquestRegionId) => void;
  /** When non-empty, only these regions get the "legal target" highlight. */
  legalRegionIds?: Set<ConquestRegionId>;
  /** Region currently flashing red after an illegal click. */
  flashRegionId?:  ConquestRegionId | null;
  /** Disable interaction entirely (round_result, finished, etc.). */
  disabled?:       boolean;
}

export default function ConquestBoard({
  mapConfig,
  regionStates,
  players,
  playerColors,
  onRegionClick,
  legalRegionIds,
  flashRegionId,
  disabled = false,
}: Props) {
  const playerById = Object.fromEntries(players.map(p => [p.id, p]));
  const stateById  = Object.fromEntries(regionStates.map(rs => [rs.regionId, rs]));
  const interactive = !!onRegionClick && !disabled;

  return (
    <div
      className="cq-board"
      data-interactive={interactive ? "" : undefined}
      role="grid"
      aria-label={`${mapConfig.displayName} harita bölgeleri`}
    >
      {mapConfig.regions.map(region => {
        const rs    = stateById[region.id];
        const owner = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
        const color = owner ? playerColors[owner.id] : null;
        const isLegal = legalRegionIds?.has(region.id) ?? false;
        const isFlash = flashRegionId === region.id;

        return (
          <ConquestRegionCard
            key={region.id}
            region={region}
            ownerColor={color}
            ownerName={owner?.name}
            shielded={rs?.shielded ?? false}
            neighborCount={region.neighbors.length}
            onClick={interactive ? () => onRegionClick!(region.id) : undefined}
            legal={isLegal}
            illegalFlash={isFlash}
            disabled={disabled}
          />
        );
      })}
    </div>
  );
}
