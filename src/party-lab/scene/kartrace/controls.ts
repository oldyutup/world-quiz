import { InputManager } from '../../input/inputManager';
import { defaultBindings } from '../../input/defaults';
import { bindingLabel, isBinding, type Bindings, type BindingSlots } from '../../input/bindings';
import type { Action } from '../../input/actions';
import type { DriveInput } from './config';

export const RACE_ACTIONS = ['moveForward', 'moveBackward', 'moveLeft', 'moveRight', 'raceHandbrake', 'raceCamera', 'raceReset'] as const;
export type RaceAction = typeof RACE_ACTIONS[number];
export type RaceBindings = Record<RaceAction, BindingSlots>;
export type RaceExtras = Pick<RaceBindings, 'raceHandbrake' | 'raceCamera' | 'raceReset'>;
export const RACE_LABELS: Record<RaceAction, string> = { moveForward: 'Gaz', moveBackward: 'Fren / Geri', moveLeft: 'Sol', moveRight: 'Sağ', raceHandbrake: 'El freni', raceCamera: 'Kamera', raceReset: 'Sıfırla' };
export const RACE_CONTROLS_KEY = 'party-lab-race-controls-v1';
export const defaultRaceExtras = (): RaceExtras => ({ raceHandbrake: ['Space', null], raceCamera: ['KeyV', null], raceReset: ['KeyR', null] });
export function raceBindings(shared: Bindings, extras: RaceExtras): RaceBindings {
  const result: RaceBindings = { moveForward: shared.moveForward, moveBackward: shared.moveBackward, moveLeft: shared.moveLeft, moveRight: shared.moveRight, ...extras };
  // Existing shared profiles may already use Space/V/R for movement. Preserve
  // those assignments and expose an unused Race key in both gameplay and help.
  const used = new Set([shared.moveForward, shared.moveBackward, shared.moveLeft, shared.moveRight].flat().filter(Boolean));
  const reserved = new Set(Object.values(extras).flat().filter(Boolean));
  for (const action of ['raceHandbrake', 'raceCamera', 'raceReset'] as const) {
    const slots = [...extras[action]] as [string, string | null];
    if (used.has(slots[0])) slots[0] = ['KeyH', 'KeyC', 'KeyT', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `Key${c}`), 'Space'].find(key => !used.has(key) && !reserved.has(key))!;
    used.add(slots[0]);
    if (slots[1] && used.has(slots[1])) slots[1] = null;
    if (slots[1]) used.add(slots[1]);
    result[action] = slots;
  }
  return result;
}
export const raceBindingLabel = (bindings: RaceBindings, action: RaceAction) => [...new Set(bindings[action].filter((b): b is string => b !== null).map(bindingLabel))].join(' / ');
export const raceHelp = (bindings: RaceBindings) => RACE_ACTIONS.map(action => ({ action, key: raceBindingLabel(bindings, action), label: RACE_LABELS[action] }));
export const raceConflicts = (bindings: RaceBindings, action: RaceAction, binding: string) => RACE_ACTIONS.filter(other => other !== action && bindings[other].includes(binding));
export function changeRaceBinding(bindings: RaceBindings, action: RaceAction, slot: 0 | 1, binding: string | null): RaceBindings | null {
  if ((!binding && slot === 0) || (binding !== null && (!isBinding(binding) || raceConflicts(bindings, action, binding).length))) return null;
  const slots = [...bindings[action]] as [string, string | null];
  if (slot === 0) slots[0] = binding!; else slots[1] = binding;
  return { ...bindings, [action]: slots };
}
export function validRaceExtras(value: unknown): value is RaceExtras {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).length === 3 && Object.keys(defaultRaceExtras()).every(action => {
    const slots = data[action];
    return Array.isArray(slots) && slots.length === 2 && isBinding(slots[0]) && (slots[1] === null || isBinding(slots[1]));
  });
}
export function loadRaceExtras(): RaceExtras {
  try {
    const data = JSON.parse(window.localStorage.getItem(RACE_CONTROLS_KEY) ?? 'null');
    if (data?.version === 1 && validRaceExtras(data.bindings)) return data.bindings;
  } catch { /* Storage unavailable or invalid: keep all actions accessible. */ }
  return defaultRaceExtras();
}
export function saveRaceExtras(bindings: RaceExtras) {
  if (!validRaceExtras(bindings)) return false;
  try { window.localStorage.setItem(RACE_CONTROLS_KEY, JSON.stringify({ version: 1, bindings })); return true; } catch { return false; }
}

/** Reuse Party Lab's alias/edge/clear semantics without adding actions to its
 * production schema. These private adapter slots exist only in a Race manager;
 * gameplay and UI use RaceAction names, never jump/punch/grab or literal keys. */
export const raceInputBindings = (bindings: RaceBindings): Bindings => ({ ...defaultBindings(), moveForward: bindings.moveForward, moveBackward: bindings.moveBackward, moveLeft: bindings.moveLeft, moveRight: bindings.moveRight, jump: bindings.raceHandbrake, punch: bindings.raceCamera, grab: bindings.raceReset, lift: bindings.raceHandbrake });
const ADAPTER: Record<RaceAction, Action> = { moveForward: 'moveForward', moveBackward: 'moveBackward', moveLeft: 'moveLeft', moveRight: 'moveRight', raceHandbrake: 'jump', raceCamera: 'punch', raceReset: 'grab' };
export function readRaceInput(manager: InputManager): { drive: DriveInput; camera: boolean } {
  const down = (action: RaceAction) => manager.isActionDown(ADAPTER[action]);
  const result = { drive: { throttle: Number(down('moveForward')), brake: Number(down('moveBackward')), steer: Number(down('moveLeft')) - Number(down('moveRight')), handbrake: down('raceHandbrake'), reset: manager.wasActionPressed(ADAPTER.raceReset) }, camera: manager.wasActionPressed(ADAPTER.raceCamera) };
  manager.readIntent(); // Consume edges once, retaining held actions.
  return result;
}
