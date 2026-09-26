import type { Recipe } from "../../audio/sfx";
import type { SpatialOptions } from "../../audio/AudioManager";

/**
 * Saklambaç's periodic whistle, as heard (the simulation decides who whistles when: game.ts).
 * A short rising two-note "fweet", original synthesis like every Party Lab cue.
 */
export const WHISTLE_RECIPE: Recipe = { frequency: 1180, end: 1560, duration: 0.62, noise: 0.04, gain: 0.3, priority: 2, cooldown: 0, wobble: 40, notes: [1, 1.19] };

/**
 * A rough clue for a 22 × 22 m camp, never a pointer: equal-power panning (left/right only —
 * no front/back or height cues), only 60% of the sound panned (the rest centred), the inverse
 * distance model from 3 m (≈ −11 dB at 11 m, ≈ −16 dB at 20 m: always audible, never loud
 * from afar), and muffled when a wall or roof stands between it and the listener
 * ("inside the lodge", "upstairs"). No marker, no arrow, no number: the seeker gets a direction
 * to turn toward and a hint of indoors or out, not the prop.
 */
export const WHISTLE_AUDIO: SpatialOptions = { refDistance: 3, rolloff: 1.0, maxDistance: 40, spatial: 0.6, gain: 1, muffle: null, muffledGain: 0.7 };
/** Low-pass cutoff (Hz) for a whistle heard through a wall. */
export const WHISTLE_MUFFLE = 900;

/**
 * The seeker's hunch ("near", game.ts): a soft two-beat heartbeat, low and short. Played in the
 * middle of the mix at the listener (`spatial` 0: no panning, no distance), so it says only
 * "someone is close", never which way or how far.
 */
export const SENSE_RECIPE: Recipe = { frequency: 118, end: 62, duration: 0.5, noise: 0.08, gain: 0.34, priority: 1, cooldown: 0, notes: [1, 0.86] };
export const SENSE_AUDIO: SpatialOptions = { refDistance: 1, rolloff: 0, maxDistance: 1, spatial: 0, gain: 1, muffle: null };
