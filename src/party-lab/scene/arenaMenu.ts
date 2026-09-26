import type { Action } from "../input/actions";
import { bindingLabel, type Binding, type Bindings } from "../input/bindings";
import type { LookMode } from "../input/look";
import { PROP_HUNT } from "../../../shared/party-lab/simulation/prophunt/config";
import { whistleKey } from "./prophunt/controls";

/**
 * The Esc menu over an immersive arena (online Rooftop and Barn, local Katman Kaosu, Renk Kaosu, Bomba Sende and Saklambaç). It
 * is NOT a pause: the server (or the local simulation) keeps simulating, the round clock
 * keeps running and the other players or bots keep playing. Opening it only stops this
 * player's local input (held keys released, a neutral input sent, local prediction
 * suspended) until it closes.
 */
export type MenuView = "main" | "controls" | "audio";

/** Esc: closed → menu; a sub-view → back to the menu; the menu → back to the game. */
export function escapeStep(view: MenuView | null): MenuView | null {
  if (view === null) return "main";
  return view === "main" ? null : "main";
}

/**
 * A press this soon after a lock ended is the same Esc that ended it: browsers differ on
 * whether (and before or after `pointerlockchange`) that press also reaches the page.
 */
export const ESC_UNLOCK_GRACE_MS = 350;

/**
 * Esc while Pointer Lock (or fullscreen) is active belongs to the browser: it ends the
 * lock itself and the lock's end opens the menu. So a key press is only acted on when
 * nothing is locked and no lock ended within the grace window; otherwise the one
 * physical press would open the menu and close it again.
 */
export class EscapeGate {
  private endedAt = -Infinity;
  /** The browser ended a lock/fullscreen the page did not release itself. */
  lockEnded(now: number) {
    this.endedAt = now;
  }
  accepts(now: number, locked: boolean) {
    return !locked && now - this.endedAt >= ESC_UNLOCK_GRACE_MS;
  }
}

const SHORT: Record<string, string> = {
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  AltLeft: "Alt",
  AltRight: "Alt",
  Space: "Space",
};
const keyName = (binding: Binding) => SHORT[binding] ?? bindingLabel(binding);
const primary = (bindings: Bindings, action: Action) => keyName(bindings[action][0]);

/** "WASD" when every movement key is a single letter, otherwise "↑/←/↓/→"-style. */
function movement(bindings: Bindings) {
  const keys = (["moveForward", "moveLeft", "moveBackward", "moveRight"] as const).map((a) => primary(bindings, a));
  return keys.every((k) => /^[\p{L}\p{N}]$/u.test(k)) ? keys.join("") : keys.join("/");
}

/** The short controls line shown for a few seconds when a round opens (current bindings). */
export function controlHint(bindings: Bindings, mode: "rooftop" | "barn" | "layers" | "colors" | "bomb" | "propSeeker" | "propHider", lookMode: LookMode = "lock") {
  const parts =
    mode === "propSeeker"
      ? [
          `${movement(bindings)} hareket`,
          `${primary(bindings, "lift")} koş`,
          `${primary(bindings, "jump")} zıpla`,
          `${primary(bindings, "punch")} ateş (${PROP_HUNT.seeker.ammo} mermi)`,
          ...(Object.values(bindings).some((keys) => keys.includes("KeyV")) ? [] : ["V kamera"]),
          ...(lookMode === "drag" ? ["sürükleyerek bak"] : []),
        ]
      : mode === "propHider"
      ? [
          `${movement(bindings)} hareket`,
          `${primary(bindings, "lift")} koş`,
          `${primary(bindings, "jump")} zıpla`,
          `${primary(bindings, "grab")} eşyaya dönüş / çık`,
          `${bindingLabel(whistleKey(bindings))} · Islık`,
          ...(lookMode === "drag" ? ["sürükleyerek bak"] : []),
        ]
      : mode === "bomb"
      ? [
          `${movement(bindings)} hareket`,
          `${primary(bindings, "lift")} koş`,
          `${primary(bindings, "jump")} zıpla`,
          `${primary(bindings, "punch")} yumruk: bombayı ver`,
          ...(lookMode === "drag" ? ["sürükleyerek bak"] : []),
        ]
      : mode === "layers" || mode === "colors"
      ? [
          `${movement(bindings)} hareket`,
          `${primary(bindings, "lift")} koş`,
          `${primary(bindings, "jump")} zıpla`,
          `${primary(bindings, "punch")} it`,
          ...(lookMode === "drag" ? ["sürükleyerek bak"] : []),
        ]
      : mode === "barn"
      ? [
          `${movement(bindings)} hareket`,
          `${primary(bindings, "lift")} koş`,
          `${primary(bindings, "jump")} zıpla`,
          `${primary(bindings, "punch")} ateş/yumruk`,
          `${primary(bindings, "grab")} silah al`,
          ...(lookMode === "drag" ? ["sürükleyerek bak"] : []),
        ]
      : [
          `${movement(bindings)} hareket`,
          `${primary(bindings, "jump")} zıpla`,
          `${primary(bindings, "punch")} yumruk`,
          `${primary(bindings, "grab")} tut`,
          `${primary(bindings, "lift")} kaldır`,
        ];
  return [...parts, "Esc menü"].join(" · ");
}

/** How long the controls line stays once the round is playing. */
export const HINT_MS = 5000;
