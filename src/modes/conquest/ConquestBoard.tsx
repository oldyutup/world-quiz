/**
 * ConquestBoard — responsive region grid for Kuşatma.
 *
 * Renders one ConquestRegionCard per region in the selected map config.
 * The grid layout is CSS-only (auto-fill), making it straightforward to
 * swap in real polygon/SVG map rendering later without touching this
 * component's data wiring.
 *
 * Phase-4 scope: display-only grid.  No interactivity yet.
 */

import type {
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionState,
} from "./types";
import ConquestRegionCard from "./ConquestRegionCard";

interface Props {
  mapConfig:    ConquestMapConfig;
  regionStates: ConquestRegionState[];
  players:      ConquestPlayer[];
  playerColors: Record<string, ConquestPlayerColor>;
}

export default function ConquestBoard({
  mapConfig,
  regionStates,
  players,
  playerColors,
}: Props) {
  const playerById = Object.fromEntries(players.map(p => [p.id, p]));
  const stateById  = Object.fromEntries(regionStates.map(rs => [rs.regionId, rs]));

  return (
    <div
      className="cq-board"
      role="grid"
      aria-label={`${mapConfig.displayName} harita bölgeleri`}
    >
      {mapConfig.regions.map(region => {
        const rs    = stateById[region.id];
        const owner = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
        const color = owner ? playerColors[owner.id] : null;

        return (
          <ConquestRegionCard
            key={region.id}
            region={region}
            ownerColor={color}
            ownerName={owner?.name}
            shielded={rs?.shielded ?? false}
            neighborCount={region.neighbors.length}
          />
        );
      })}
    </div>
  );
}
