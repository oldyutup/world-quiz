import { bindingLabel, type Bindings } from "../../input/bindings";
import { isUIInput, keyboardBinding } from "../../input/device";
import { KEY_LETTERS } from "../../../../shared/party-lab/simulation/rhythm/song";

const keysOf = (slots: readonly (string | null)[], fallback: readonly string[]) => {
  const keys = slots.filter((binding): binding is string => !!binding && !binding.startsWith("Mouse"));
  return keys.length ? keys : [...fallback];
};
/**
 * The four note keys from the player's movement keys (W A S D and the arrows by default):
 * 0 Hareket İleri (W), 1 Sola Git (A), 2 Hareket Geri (S), 3 Sağa Git (D).
 */
export function noteBindings(bindings: Bindings): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  const groups = [keysOf(bindings.moveForward, ["KeyW", "ArrowUp"]), keysOf(bindings.moveLeft, ["KeyA", "ArrowLeft"]), keysOf(bindings.moveBackward, ["KeyS", "ArrowDown"]), keysOf(bindings.moveRight, ["KeyD", "ArrowRight"])];
  groups.forEach((codes, key) => codes.forEach((code) => !map.has(code) && map.set(code, key)));
  return map;
}
/** What each note says on it: the first key bound to it ("W", "A", "S", "D" by default). */
export function noteLabels(bindings: Bindings): string[] {
  const first = [bindings.moveForward[0], bindings.moveLeft[0], bindings.moveBackward[0], bindings.moveRight[0]];
  return first.map((code, key) => (code && !code.startsWith("Mouse") ? bindingLabel(code) : KEY_LETTERS[key]));
}

/**
 * One press per physical press: a held key's auto-repeat never counts, and a key counts again
 * only after it was released (some systems repeat without marking `repeat`).
 */
export class NoteKeys {
  private held = new Set<string>();
  constructor(public bindings: ReadonlyMap<string, number>) {}
  /** The note key a key-down presses, or null (not a note key, or still held). */
  down(code: string | null, repeat: boolean) {
    if (!code) return null;
    const key = this.bindings.get(code);
    if (key === undefined || repeat || this.held.has(code)) return null;
    this.held.add(code);
    return key;
  }
  up(code: string) {
    this.held.delete(code);
  }
  clear() {
    this.held.clear();
  }
}

/**
 * Keys window-wide (so focus never eats a press). `onPress(key, at)` gets the key and the
 * moment it went down (the event's own time, performance.now() based). Keys on menus and
 * text fields are not game keys; neither are any while `enabled()` is false.
 */
export function bindRhythmInput(keys: NoteKeys, enabled: () => boolean, onPress: (key: number, at: number) => void) {
  const keyDown = (event: KeyboardEvent) => {
    if (!enabled() || isUIInput(event.target) || isUIInput(document.activeElement)) return;
    const code = keyboardBinding(event);
    if (!code || !keys.bindings.has(code)) return;
    event.preventDefault();
    const key = keys.down(code, event.repeat);
    // The key's own moment (a busy frame may run this handler late); a clock that is not
    // performance.now()'s would be far off it.
    const now = performance.now();
    if (key !== null) onPress(key, event.timeStamp > 0 && Math.abs(now - event.timeStamp) < 500 ? event.timeStamp : now);
  };
  const keyUp = (event: KeyboardEvent) => keys.up(event.code);
  const blur = () => keys.clear();
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    window.removeEventListener("blur", blur);
    keys.clear();
  };
}
