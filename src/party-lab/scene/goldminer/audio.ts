import type { AudioManager } from "../../audio/AudioManager";
import type { Recipe } from "../../audio/sfx";
import type { GoldKind } from "../../../../shared/party-lab/simulation/goldminer/config";

const recipe = (frequency: number, end: number, duration: number, noise: number, gain: number, notes?: number[], priority: 0 | 1 | 2 = 1): Recipe => ({ frequency, end, duration, noise, gain, notes, priority, cooldown: 0.04 });
/** Original procedural cues (no samples): a whoosh, catches by weight, a reel tick and a chime per find. */
const SOUNDS = {
  shot: recipe(520, 180, 0.2, 0.75, 0.1),
  edge: recipe(210, 120, 0.12, 0.5, 0.08, undefined, 0),
  catchLight: recipe(880, 620, 0.09, 0.2, 0.12),
  catchHeavy: recipe(170, 90, 0.2, 0.45, 0.16),
  catchSack: recipe(240, 150, 0.16, 0.7, 0.12),
  reel: recipe(1300, 1100, 0.025, 0.6, 0.035, undefined, 0),
  bankSmall: recipe(990, 1180, 0.28, 0.02, 0.12, [1, 1.5]),
  bankBig: recipe(660, 760, 0.55, 0.02, 0.15, [1, 1.25, 1.5, 2]),
  bankDiamond: recipe(1320, 1500, 0.6, 0.01, 0.12, [1, 1.5, 2, 2.5]),
  bankSack: recipe(520, 640, 0.4, 0.05, 0.13, [1, 1.33, 1.6]),
  bankRock: recipe(150, 95, 0.26, 0.35, 0.14),
} as const;
export type GoldSound = keyof typeof SOUNDS;

export const catchSound = (kind: GoldKind): GoldSound => (kind === "rock" || kind === "big" ? "catchHeavy" : kind === "sack" ? "catchSack" : "catchLight");
export const bankSound = (kind: GoldKind): GoldSound =>
  kind === "diamond" ? "bankDiamond" : kind === "big" ? "bankBig" : kind === "rock" ? "bankRock" : kind === "sack" ? "bankSack" : "bankSmall";

/** Plays the cues through the bounded voice pool, panned a little toward the miner (x in −1…1). */
export function goldAudio(audio: AudioManager) {
  const play = (name: GoldSound, pan = 0, gain = 1) =>
    audio.playSpatial(`gold-miner-${name}`, SOUNDS[name], { x: pan * 6, y: 0, z: 0 }, { refDistance: 100, maxDistance: 100, rolloff: 0, spatial: 0.35, gain });
  return {
    play,
    stop() {
      for (const name of Object.keys(SOUNDS)) audio.stopSpatial(`gold-miner-${name}`);
    },
  };
}
