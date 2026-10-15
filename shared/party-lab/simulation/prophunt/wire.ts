import type { PropSettings } from "../../propSettings.js";
import type { PropLayout } from "../../maps/propDealer.js";
import { ALL_PROP_FAMILY_IDS, type PropFamilyId } from "../../maps/propHuntProps.js";
import { isPropMapId, PROP_MAPS, type PropMapId } from "../../maps/propMaps.js";
import type { PropHuntGame, PropReveal } from "./game.js";
import type { PropPhase, PropOutcome, PropResult } from "./round.js";

/**
 * Each disguise: family index (into ALL_PROP_FAMILY_IDS; -1 absent), source decoy, XYZ, yaw,
 * velocity XYZ, grounded. `map` (protocol 25): the round's map; `index` counts that map's rounds
 * and `families` is a bitmask over that map's own families.
 */
export interface PropSnapshotWire {
  map: PropMapId; seed: number; index: number; hash: string; families: number;
  phase: PropPhase; t: number; seeker: number; ammo: number;
  settings: PropSettings;
  alive: number; found: number[]; disguise: number[][];
  toggle: number[]; whistle: number[]; shot: number;
  outcome: PropOutcome | null; reason: PropResult | null; ended: number;
  reveal: PropReveal[];
}
/** A layout's families in play as a bitmask over its map's families. */
export function familyMask(map: PropMapId, active: readonly PropFamilyId[]): number {
  const families = PROP_MAPS[map].dealer.def.families;
  return active.reduce((mask, f) => mask | (1 << families.indexOf(f)), 0);
}
export function propSection(game: PropHuntGame, seed: number, index: number, settings: PropSettings): PropSnapshotWire {
  const r = game.round;
  return {
    map: game.map.id, seed, index, hash: game.layout.id,
    families: familyMask(game.map.id, game.layout.active),
    phase: r.phase, t: r.tick, seeker: r.seeker, ammo: game.ammo, settings: { ...settings },
    alive: r.alive.reduce((mask, yes, id) => mask | (yes ? 1 << id : 0), 0),
    found: [...r.foundAt],
    disguise: game.disguises.worn.map((w, id) => {
      if (!w) return [-1];
      const p = w.body.translation();
      return [ALL_PROP_FAMILY_IDS.indexOf(w.family), game.sourceDecoys[id], p.x, p.y, p.z, w.yaw, w.vx, w.vy, w.vz, +w.grounded];
    }),
    toggle: [...game.toggleCooldown], whistle: [...game.manualWhistleCooldown], shot: game.shotCooldown,
    outcome: r.outcome, reason: r.reason, ended: r.endedAt,
    reveal: r.phase === "results" ? game.reveal.map((v) => ({ ...v, at: { ...v.at } })) : [],
  };
}
/** Reconnect needs one section, never a prior snapshot or a client RNG. */
export function reconstructPropLayout(state: PropSnapshotWire, previous?: { map: PropMapId; seed: number; index: number; layout: PropLayout }): PropLayout {
  if (!isPropMapId(state.map)) throw Error("Invalid Prop Hunt map");
  if (!Number.isSafeInteger(state.seed) || state.seed < 0 || state.seed > 0xffffffff || !Number.isSafeInteger(state.index) || state.index < 0) throw Error("Invalid Prop Hunt layout seed");
  const same = previous?.map === state.map && previous.seed === state.seed;
  const layout = same && previous!.index === state.index ? previous!.layout
    : PROP_MAPS[state.map].dealer.roundLayout(state.seed, state.index, same && previous!.index + 1 === state.index ? previous!.layout : null);
  const families = familyMask(state.map, layout.active);
  if (layout.id !== state.hash || families !== state.families) throw Error("Prop Hunt layout mismatch");
  return layout;
}

/** Only accepted presentation events. No whistle identity; near has no spatial payload. */
export type PropOnlineEvent = { eid: number; round: number; tick: number } & (
  | { type: "near" }
  | { type: "whistle"; at: { x: number; y: number; z: number } }
  | Exclude<import("./game.js").PropHuntEvent, { type: "near" | "whistle" }>
);
