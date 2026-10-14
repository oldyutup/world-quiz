import type { AudioManager } from "../../audio/AudioManager";
import type { Recipe } from "../../audio/sfx";

const recipe = (frequency: number, end: number, duration: number, noise: number, gain: number, notes?: number[], priority: 0 | 1 | 2 = 1): Recipe => ({ frequency, end, duration, noise, gain, notes, priority, cooldown: 0.03 });
/** Original procedural cues (no samples): a blaster zap, a bright ding for a quick hit, a lower one for a slow hit, a boom. */
const SOUNDS = {
  shot: recipe(1350, 420, 0.09, 0.25, 0.05, undefined, 0),
  good: recipe(880, 1320, 0.2, 0.01, 0.1, [1, 1.5, 2]),
  slow: recipe(560, 620, 0.18, 0.02, 0.08, [1, 1.25]),
  bomb: recipe(140, 38, 0.5, 0.85, 0.3, undefined, 2),
  pop: recipe(320, 520, 0.06, 0.3, 0.025, undefined, 0),
} as const;
export type MarksmanSound = keyof typeof SOUNDS;

/** Plays the cues through the bounded voice pool, panned toward the lane (x in −1…1). */
export function marksmanAudio(audio: AudioManager) {
  const play = (name: MarksmanSound, pan = 0, gain = 1) =>
    audio.playSpatial(`marksman-${name}`, SOUNDS[name], { x: pan * 6, y: 0, z: 0 }, { refDistance: 100, maxDistance: 100, rolloff: 0, spatial: 0.35, gain });
  return {
    play,
    stop() {
      for (const name of Object.keys(SOUNDS)) audio.stopSpatial(`marksman-${name}`);
    },
  };
}
