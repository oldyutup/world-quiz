import type { ArenaMapId } from "../../../shared/party-lab/maps";
import RooftopArena from "./arenas/RooftopArena";
import TestArena from "./arenas/TestArena";

/** Visual arena (including its lighting) for a shared map id. Physics never reads anything rendered here. */
export default function Arena({ mapId }: { mapId: ArenaMapId }) {
  return mapId === "test" ? <TestArena /> : <RooftopArena />;
}
