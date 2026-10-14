import type { AudioManager } from "../../audio/AudioManager";
import type { Recipe } from "../../audio/sfx";

const recipe = (frequency: number, end: number, duration: number, noise: number, gain: number, notes?: number[], priority: 0 | 1 | 2 = 1): Recipe => ({ frequency, end, duration, noise, gain, notes, priority, cooldown: 0.03 });
/** Original procedural cues (no samples): a pop for a box taken, a chime home, a sly slide for a theft, a thud for a knock, a two-tone alarm for "your box was stolen". */
const SOUNDS = {
  take: recipe(620, 940, 0.09, 0.08, 0.07, undefined, 0),
  home: recipe(660, 990, 0.24, 0.01, 0.09, [1, 1.25, 1.5]),
  steal: recipe(540, 250, 0.2, 0.12, 0.08),
  knock: recipe(190, 64, 0.26, 0.6, 0.2, undefined, 2),
  stolen: recipe(392, 300, 0.42, 0.02, 0.1, [1, 0.8, 1, 0.8], 2),
  land: recipe(240, 120, 0.12, 0.45, 0.06, undefined, 0),
} as const;
export type GiftSound = keyof typeof SOUNDS;

/** Plays the cues through the bounded voice pool, panned across the screen (x in −1…1). */
export function giftAudio(audio: AudioManager) {
  const play = (name: GiftSound, pan = 0, gain = 1) =>
    audio.playSpatial(`gift-${name}`, SOUNDS[name], { x: pan * 6, y: 0, z: 0 }, { refDistance: 100, maxDistance: 100, rolloff: 0, spatial: 0.35, gain });
  return {
    play,
    stop() {
      for (const name of Object.keys(SOUNDS)) audio.stopSpatial(`gift-${name}`);
    },
  };
}
