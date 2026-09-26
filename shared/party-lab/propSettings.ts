/** Authoritative room settings. Kept when another mode is selected, including Mixed. */
export interface PropSettings { ammo: 5 | 10 | 15; proximity: boolean; }
export const DEFAULT_PROP_SETTINGS: Readonly<PropSettings> = { ammo: 15, proximity: true };
export function validPropSettings(value: unknown): value is PropSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as PropSettings;
  return Object.keys(p).length === 2 && [5, 10, 15].includes(p.ammo) && typeof p.proximity === "boolean";
}

/** Independent field intents avoid overwriting a newer setting with a stale lobby snapshot. */
export function validPropSettingsPatch(value: unknown): value is Partial<PropSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Partial<PropSettings>, keys = Object.keys(p);
  return keys.length > 0 && keys.every(k => k === "ammo" || k === "proximity")
    && (!("ammo" in p) || [5, 10, 15].includes(p.ammo!))
    && (!("proximity" in p) || typeof p.proximity === "boolean");
}
