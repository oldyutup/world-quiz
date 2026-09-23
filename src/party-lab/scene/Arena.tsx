import type { ArenaMapId } from "../../../shared/party-lab/maps";
import BarnArena from "./arenas/BarnArena";
import RooftopArena from "./arenas/RooftopArena";
import TestArena from "./arenas/TestArena";
import type { BarnBridge } from "./arenas/barnView";

/**
 * Visual arena (including its lighting) for a shared map id. Physics never reads
 * anything rendered here. The barn's combat visuals follow `barn` (published per frame).
 */
export default function Arena({ mapId, barn }: { mapId: ArenaMapId; barn?: BarnBridge }) {
  return mapId === "test" ? <TestArena /> : mapId === "barn" ? <BarnArena bridge={barn} /> : <RooftopArena />;
}
