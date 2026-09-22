import type { Recipe } from "./sfx";
export const SAMPLE_RATE = 22050;
/** Short original PCM, generated lazily. Seeded noise never consumes bot RNG. */
export function synthesize(
  recipe: Recipe,
  variant = 0,
  sampleRate = SAMPLE_RATE
) {
  let seed = 731 + variant * 997;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const duration = recipe.duration * (variant ? 1.035 : 0.975);
  const samples = new Float32Array(Math.ceil(duration * sampleRate));
  const notes = recipe.notes ?? [1];
  let phase = 0,
    filtered = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    const noteLength = duration / notes.length;
    const note = Math.min(notes.length - 1, Math.floor(time / noteLength));
    const age = time - note * noteLength;
    const progress = age / noteLength;
    const frequency =
      (recipe.frequency * Math.pow(recipe.end / recipe.frequency, progress) +
        (recipe.wobble ?? 0) * Math.sin(age * 65) * (1 - progress)) *
      notes[note];
    phase += (Math.PI * 2 * frequency) / sampleRate;
    filtered += (0.1 + variant * 0.012) * (random() * 2 - 1 - filtered);
    const envelope =
      Math.min(1, age / 0.004) *
      Math.pow(1 - progress, 2) *
      Math.min(1, (noteLength - age) / 0.012);
    const rubber = Math.sin(phase) * 0.78 + Math.sin(phase * 2) * 0.14;
    samples[i] =
      envelope *
      (rubber * (1 - recipe.noise) + filtered * 2 * recipe.noise) *
      0.7;
  }
  return samples;
}
