export interface AudioSettings {
  master: number;
  sfx: number;
  muted: boolean;
  cameraShake: boolean;
}
export const AUDIO_KEY = "party-lab-audio-v1";
export const defaultAudioSettings = (): AudioSettings => ({
  master: 80,
  sfx: 85,
  muted: false,
  cameraShake: true,
});
export const clampVolume = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
export const outputVolume = (s: AudioSettings) =>
  s.muted ? 0 : (clampVolume(s.master) * clampVolume(s.sfx)) / 10000;
export function validSettings(value: unknown): value is AudioSettings {
  if (!value || typeof value !== "object") return false;
  const s = value as AudioSettings;
  return (
    [s.master, s.sfx].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100
    ) &&
    typeof s.muted === "boolean" &&
    typeof s.cameraShake === "boolean"
  );
}
export const serializeAudio = (settings: AudioSettings) =>
  JSON.stringify({ version: 1, settings });
export function deserializeAudio(raw: string | null): AudioSettings {
  try {
    const data = JSON.parse(raw ?? "null");
    if (data?.version === 1 && validSettings(data.settings))
      return data.settings;
  } catch {
    /* Safe defaults. */
  }
  return defaultAudioSettings();
}
type Store = Pick<Storage, "getItem" | "setItem">;
export function loadAudioSettings(store?: Store): AudioSettings {
  try {
    return deserializeAudio((store ?? window.localStorage).getItem(AUDIO_KEY));
  } catch {
    return defaultAudioSettings();
  }
}
export function saveAudioSettings(settings: AudioSettings, store?: Store) {
  if (!validSettings(settings)) return false;
  try {
    (store ?? window.localStorage).setItem(AUDIO_KEY, serializeAudio(settings));
    return true;
  } catch {
    return false;
  }
}
