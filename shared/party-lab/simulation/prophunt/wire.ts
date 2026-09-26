import type { PropSettings } from "../../propSettings.js";
import { roundLayout, type PropLayout } from "../../maps/propHuntLayout.js";
import { PROP_FAMILY_IDS } from "../../maps/propHuntProps.js";
import type { PropHuntGame, PropReveal } from "./game.js";
import type { PropPhase, PropOutcome, PropResult } from "./round.js";

/** Each disguise: family index (-1 absent), source decoy, XYZ, yaw, velocity XYZ, grounded. */
export interface PropSnapshotWire {
  seed: number; index: number; hash: string; families: number;
  phase: PropPhase; t: number; seeker: number; ammo: number;
  settings: PropSettings;
  alive: number; found: number[]; disguise: number[][];
  toggle: number[]; whistle: number[]; shot: number;
  outcome: PropOutcome | null; reason: PropResult | null; ended: number;
  reveal: PropReveal[];
}
export function propSection(game: PropHuntGame, seed: number, index: number, settings: PropSettings): PropSnapshotWire {
  const r = game.round;
  return {
    seed, index, hash: game.layout.id,
    families: game.layout.active.reduce((mask, f) => mask | (1 << PROP_FAMILY_IDS.indexOf(f)), 0),
    phase: r.phase, t: r.tick, seeker: r.seeker, ammo: game.ammo, settings: { ...settings },
    alive: r.alive.reduce((mask, yes, id) => mask | (yes ? 1 << id : 0), 0),
    found: [...r.foundAt],
    disguise: game.disguises.worn.map((w, id) => {
      if (!w) return [-1];
      const p = w.body.translation();
      return [PROP_FAMILY_IDS.indexOf(w.family), game.sourceDecoys[id], p.x, p.y, p.z, w.yaw, w.vx, w.vy, w.vz, +w.grounded];
    }),
    toggle: [...game.toggleCooldown], whistle: [...game.manualWhistleCooldown], shot: game.shotCooldown,
    outcome: r.outcome, reason: r.reason, ended: r.endedAt,
    reveal: r.phase === "results" ? game.reveal.map((v) => ({ ...v, at: { ...v.at } })) : [],
  };
}
/** Reconnect needs one section, never a prior snapshot or a client RNG. */
export function reconstructPropLayout(state: PropSnapshotWire, previous?: { seed: number; index: number; layout: PropLayout }): PropLayout {
  if (!Number.isSafeInteger(state.seed) || state.seed < 0 || state.seed > 0xffffffff || !Number.isSafeInteger(state.index) || state.index < 0) throw Error("Invalid Prop Hunt layout seed");
  const layout = previous?.seed === state.seed && previous.index === state.index ? previous.layout
    : roundLayout(state.seed, state.index, previous?.seed === state.seed && previous.index + 1 === state.index ? previous.layout : null);
  const families = layout.active.reduce((mask, f) => mask | (1 << PROP_FAMILY_IDS.indexOf(f)), 0);
  if (layout.id !== state.hash || families !== state.families) throw Error("Prop Hunt layout mismatch");
  return layout;
}

/** Only accepted presentation events. No whistle identity; near has no spatial payload. */
export type PropOnlineEvent = { eid: number; round: number; tick: number } & (
  | { type: "near" }
  | { type: "whistle"; at: { x: number; y: number; z: number } }
  | Exclude<import("./game.js").PropHuntEvent, { type: "near" | "whistle" }>
);
