import type { AudioManager } from "../../audio/AudioManager";
import type { Recipe } from "../../audio/sfx";

const recipe = (frequency: number, end: number, duration: number, noise: number, gain: number, notes?: number[], priority: 0 | 1 | 2 = 1): Recipe => ({ frequency, end, duration, noise, gain, notes, priority, cooldown: 0.05 });
/** Original procedural cues (no samples): the train's horn and rumble, a crash, the speed-up. */
const SOUNDS = {
  horn: recipe(311, 296, 1.2, 0.04, 0.2, [1, 0.8, 1, 0.8], 2),
  rumble: recipe(78, 42, 1.1, 0.92, 0.22, undefined, 2),
  crash: recipe(210, 48, 0.55, 0.85, 0.24, undefined, 2),
  zap: recipe(980, 240, 0.2, 0.15, 0.08, undefined, 1),
  rush: recipe(440, 660, 0.6, 0.02, 0.11, [1, 1.26, 1.5, 2], 2),
} as const;
export type TrailSound = keyof typeof SOUNDS;

/** Plays the cues through the bounded voice pool, panned across the screen (x in −1…1). */
export function trailAudio(audio: AudioManager) {
  const play = (name: TrailSound, pan = 0, gain = 1) =>
    audio.playSpatial(`trail-${name}`, SOUNDS[name], { x: pan * 6, y: 0, z: 0 }, { refDistance: 100, maxDistance: 100, rolloff: 0, spatial: 0.35, gain });
  return {
    play,
    stop() {
      for (const name of Object.keys(SOUNDS)) audio.stopSpatial(`trail-${name}`);
    },
  };
}
