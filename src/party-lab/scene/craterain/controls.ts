import { bindingLabel, isBinding, type Bindings, type BindingSlots } from '../../input/bindings';
import { defaultBindings } from '../../input/defaults';
import { keyboardBinding, isUIInput } from '../../input/device';

export const CRATE_ACTIONS = ['moveForward', 'moveBackward', 'moveLeft', 'moveRight', 'sprint', 'jump', 'camera', 'lookLeft', 'lookRight', 'lookUp', 'lookDown'] as const;
export type CrateAction = typeof CRATE_ACTIONS[number];
export type CrateBindings = Record<CrateAction, BindingSlots>;
export type CrateOverrides = Partial<CrateBindings>;
export const CRATE_LABELS: Record<CrateAction, string> = { moveForward: 'İleri', moveBackward: 'Geri', moveLeft: 'Sol', moveRight: 'Sağ', sprint: 'Koş', jump: 'Zıpla', camera: 'Kamera', lookLeft: 'Sola bak', lookRight: 'Sağa bak', lookUp: 'Yukarı bak', lookDown: 'Aşağı bak' };
export const CRATE_CONTROLS_KEY = 'party-lab-crate-controls-v1';
export function crateBindings(shared: Bindings, overrides: CrateOverrides = {}): CrateBindings {
  const defaults = defaultBindings();
  const result = { moveForward: shared.moveForward, moveBackward: shared.moveBackward, moveLeft: shared.moveLeft, moveRight: shared.moveRight, sprint: shared.lift, jump: shared.jump,
    camera: ['KeyV', null], lookLeft: ['ArrowLeft', null], lookRight: ['ArrowRight', null], lookUp: ['ArrowUp', null], lookDown: ['ArrowDown', null] } as CrateBindings;
  // Only the unchanged stock arrow aliases become look controls in this mode.
  // Custom movement arrows are preserved; conflicting look keys get a free default.
  for (const action of ['moveForward', 'moveBackward', 'moveLeft', 'moveRight'] as const) {
    if (shared[action][0] === defaults[action][0] && shared[action][1] === defaults[action][1]) result[action] = [shared[action][0], null];
  }
  Object.assign(result, overrides);
  const used = new Set<string>(), reserved = new Set(Object.values(result).flat().filter(Boolean));
  // Explicit local overrides win when an inherited shared profile later changes.
  const ordered = [...CRATE_ACTIONS.filter(a => overrides[a]), ...CRATE_ACTIONS.filter(a => !overrides[a])];
  for (const action of ordered) {
    const slots = [...result[action]] as [string, string | null];
    if (used.has(slots[0]) || slots[0].startsWith('Mouse')) slots[0] = ['KeyJ', 'KeyL', 'KeyI', 'KeyK', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `Key${c}`), ...Array.from({ length: 10 }, (_, i) => `Digit${i}`)].find(k => !used.has(k) && !reserved.has(k))!;
    used.add(slots[0]);
    if (slots[1] && (used.has(slots[1]) || slots[1].startsWith('Mouse'))) slots[1] = null;
    if (slots[1]) used.add(slots[1]);
    result[action] = slots;
  }
  return result;
}
export const crateBindingLabel = (bindings: CrateBindings, action: CrateAction) => [...new Set(bindings[action].filter((v): v is string => !!v).map(bindingLabel))].join(' / ');
export function changeCrateBinding(bindings: CrateBindings, action: CrateAction, slot: 0 | 1, key: string | null): CrateBindings | null {
  if ((!key && slot === 0) || (key && (!isBinding(key) || key.startsWith('Mouse') || CRATE_ACTIONS.some(a => a !== action && bindings[a].includes(key))))) return null;
  const slots = [...bindings[action]] as [string, string | null]; slots[slot] = key!;
  return { ...bindings, [action]: slots };
}
export function loadCrateOverrides(): CrateOverrides {
  try {
    const data = JSON.parse(window.localStorage.getItem(CRATE_CONTROLS_KEY) ?? 'null');
    if (data?.version === 1 && data.bindings && typeof data.bindings === 'object' && !Array.isArray(data.bindings) && Object.entries(data.bindings).every(([key, slots]) => CRATE_ACTIONS.includes(key as CrateAction) && Array.isArray(slots) && slots.length === 2 && isBinding(slots[0]) && !slots[0].startsWith('Mouse') && (slots[1] === null || (isBinding(slots[1]) && !slots[1].startsWith('Mouse'))))) return data.bindings;
  } catch { /* A blocked store must not prevent keyboard play. */ }
  return {};
}
export function saveCrateOverrides(bindings: CrateOverrides) {
  try { window.localStorage.setItem(CRATE_CONTROLS_KEY, JSON.stringify({ version: 1, bindings })); return true; } catch { return false; }
}
/** Local semantic adapter with Party Lab's held-alias and fresh-press rules. */
export class CrateInput {
  private keys = new Set<string>(); private cameraEdge = false;
  constructor(readonly bindings: CrateBindings) {}
  down(action: CrateAction) { return this.bindings[action].some(key => key !== null && this.keys.has(key)); }
  set(key: string, down: boolean) {
    const before = this.down('camera');
    if (down) this.keys.add(key); else this.keys.delete(key);
    if (!before && this.down('camera')) this.cameraEdge = true;
  }
  clear() { this.keys.clear(); this.cameraEdge = false; }
  read() {
    const out = { x: Number(this.down('moveRight')) - Number(this.down('moveLeft')), z: Number(this.down('moveBackward')) - Number(this.down('moveForward')), sprint: this.down('sprint'), jump: this.down('jump'), yaw: Number(this.down('lookLeft')) - Number(this.down('lookRight')), pitch: Number(this.down('lookDown')) - Number(this.down('lookUp')), camera: this.cameraEdge };
    this.cameraEdge = false; return out;
  }
}
export function bindCrateInput(surface: HTMLElement, manager: CrateInput, enabled: () => boolean, gesture: () => void) {
  const clear = () => manager.clear();
  const down = (e: KeyboardEvent) => {
    if (!enabled() || isUIInput(e.target) || !(e.target instanceof HTMLElement) || !surface.contains(e.target)) return;
    const key = keyboardBinding(e); if (!key || !Object.values(manager.bindings).some(slots => slots.includes(key))) return;
    e.preventDefault(); if (!e.repeat) { manager.set(key, true); gesture(); }
  };
  const up = (e: KeyboardEvent) => manager.set(e.code, false);
  window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear); document.addEventListener('visibilitychange', clear); document.addEventListener('focusin', clear);
  return () => { clear(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear); document.removeEventListener('focusin', clear); };
}
