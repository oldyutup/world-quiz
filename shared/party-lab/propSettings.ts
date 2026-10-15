import { isPropMapChoice, type PropMapChoice } from "./maps/propTypes.js";

/** Authoritative room settings. Kept when another mode is selected, including Mixed. */
export interface PropSettings { ammo: 5 | 10 | 15; proximity: boolean; }
export const DEFAULT_PROP_SETTINGS: Readonly<PropSettings> = { ammo: 15, proximity: true };
export function validPropSettings(value: unknown): value is PropSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as PropSettings;
  return Object.keys(p).length === 2 && [5, 10, 15].includes(p.ammo) && typeof p.proximity === "boolean";
}

/** The room's map choice for Saklambaç (protocol 25): Mixed and Tahta Oyunu always toss for it. */
export const DEFAULT_PROP_MAP: PropMapChoice = "random";
/** A lobby change: ammo, proximity or the map, each on its own. */
export type PropSettingsPatch = Partial<PropSettings> & { map?: PropMapChoice };
/** Independent field intents avoid overwriting a newer setting with a stale lobby snapshot. */
export function validPropSettingsPatch(value: unknown): value is PropSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as PropSettingsPatch, keys = Object.keys(p);
  return keys.length > 0 && keys.every(k => k === "ammo" || k === "proximity" || k === "map")
    && (!("ammo" in p) || [5, 10, 15].includes(p.ammo!))
    && (!("proximity" in p) || typeof p.proximity === "boolean")
    && (!("map" in p) || isPropMapChoice(p.map));
}
