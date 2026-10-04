/** Kept across mode changes; Mixed uses the same host preference. */
export interface BowlingSettings { obstacles: boolean; }
export const DEFAULT_BOWLING_SETTINGS: Readonly<BowlingSettings> = { obstacles: false };
export function validBowlingSettings(value: unknown): value is BowlingSettings {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.keys(value)[0] === 'obstacles'
    && typeof (value as BowlingSettings).obstacles === 'boolean';
}
