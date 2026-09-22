import {
  SELECTABLE_COSTUME_IDS,
  type SelectableCostumeId,
} from '../../../../shared/party-lab/costumes';

export { SELECTABLE_COSTUME_IDS } from '../../../../shared/party-lab/costumes';
export type { SelectableCostumeId } from '../../../../shared/party-lab/costumes';

/** Presentation IDs; default remains available for old/unknown visual state. */
export const COSTUME_IDS = ['default', ...SELECTABLE_COSTUME_IDS] as const;
export type CostumeId = (typeof COSTUME_IDS)[number];
export function resolveCostume(id: unknown): CostumeId {
  return id === 'cat' || id === 'anchovy' || id === 'gazelle' ? id : 'default';
}

export const COSTUME_NAMES: Record<SelectableCostumeId, string> = {
  cat: 'Kedi', anchovy: 'Hamsi', gazelle: 'Ceylan',
};
export const COSTUME_SYMBOLS: Record<SelectableCostumeId, string> = {
  cat: '🐱', anchovy: '🐟', gazelle: '🦌',
};

/** Local test bots show the other two costumes; slot never selects online identity. */
export function localCostumeForSlot(selected: SelectableCostumeId, slot: number): SelectableCostumeId {
  if (slot === 0) return selected;
  return SELECTABLE_COSTUME_IDS.filter(id => id !== selected)[slot - 1] ?? selected;
}

/** The slot locates a player; the room's validated profile supplies its costume. */
export function playerCostumeAtSlot(players: readonly { slot: number; costumeId: unknown }[], slot: number): CostumeId {
  return resolveCostume(players.find(player => player.slot === slot)?.costumeId);
}
