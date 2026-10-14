import type { AudioManager } from "../../audio/AudioManager";
import type { Recipe } from "../../audio/sfx";

const recipe = (frequency: number, end: number, duration: number, noise: number, gain: number, notes?: number[], priority: 0 | 1 | 2 = 1): Recipe => ({ frequency, end, duration, noise, gain, notes, priority, cooldown: 0.04 });
/** Original procedural cues (no samples): a release swish, a solid thud on landing, a lift for a taller tower, a dull miss. */
const SOUNDS = {
  drop: recipe(620, 260, 0.12, 0.7, 0.06, undefined, 0),
  thud: recipe(118, 52, 0.17, 0.42, 0.3, undefined, 2),
  good: recipe(660, 760, 0.18, 0.02, 0.09, [1, 1.5]),
  miss: recipe(260, 170, 0.22, 0.08, 0.08),
} as const;
export type TowerSound = keyof typeof SOUNDS;

/** Plays the cues through the bounded voice pool, panned toward the yard (x in −1…1). */
export function towerAudio(audio: AudioManager) {
  const play = (name: TowerSound, pan = 0, gain = 1) =>
    audio.playSpatial(`box-tower-${name}`, SOUNDS[name], { x: pan * 6, y: 0, z: 0 }, { refDistance: 100, maxDistance: 100, rolloff: 0, spatial: 0.35, gain });
  return {
    play,
    stop() {
      for (const name of Object.keys(SOUNDS)) audio.stopSpatial(`box-tower-${name}`);
    },
  };
}
