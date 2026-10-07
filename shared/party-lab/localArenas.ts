import { ARENA_MAP_IDS, type ArenaMapId } from "./maps/index.js";

/** Local playgrounds of the game modes, by their arena id (MODE_MAP); each plays against bots. */
export const LOCAL_MODE_ARENAS = ["layers", "colors", "bomb", "prophunt", "human_bowling", "snowball_brawl", "crate_rain", "snowball_fight", "kart_race", "classic_bowling", "click_race"] as const;
export type LocalArenaId = ArenaMapId | (typeof LOCAL_MODE_ARENAS)[number];
/**
 * What the Yerel Test Arenası lists: every static map, then every mode's local playground.
 * Every online mode must be here (servers/party-lab/tests/modeContract.test.ts).
 */
export const LOCAL_ARENA_IDS: readonly LocalArenaId[] = [...ARENA_MAP_IDS, ...LOCAL_MODE_ARENAS];
