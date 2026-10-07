import { GOLD_MINER as G, type GoldKind } from "./config.js";

/**
 * Altın Madenci geometry and timing, shared by the server's rules, the client's view and
 * the bots. Every hook position is a pure function of time, so a client draws exactly what
 * the server decided from a handful of numbers.
 */
export const SWING_AMPLITUDE = (G.swingDeg * Math.PI) / 180;
export const SWING_MS = G.swingSeconds * 1000;
/** Shot speed, m/s: from rest to the bottom of the mine in `shotSeconds`. */
export const SHOT_SPEED = (G.depth - G.restLength) / G.shotSeconds;
const EMPTY_SPEED = (G.depth - G.restLength) / G.emptySeconds;

/** The pivot of lane `lane` of `lanes`: evenly spread across the top of the mine. */
export const pivotX = (lane: number, lanes: number) => -G.width / 2 + (G.width * (lane + 0.5)) / lanes;
/** The swing angle (radians) at `t` ms on a swing clock that started at `origin` ms. */
export const swingAngle = (t: number, origin: number) => SWING_AMPLITUDE * Math.sin((2 * Math.PI * (t - origin)) / SWING_MS);

/** How far (from the pivot) a hook fired at `angle` from `px` goes before it reaches a wall or the bottom. */
export function edgeLength(px: number, angle: number) {
  const s = Math.sin(angle),
    c = Math.cos(angle);
  let length = G.depth / c;
  if (s > 1e-9) length = Math.min(length, (G.width / 2 - px) / s);
  if (s < -1e-9) length = Math.min(length, (-G.width / 2 - px) / s);
  return length - G.hookRadius;
}

export interface MineItem {
  kind: GoldKind;
  x: number;
  y: number;
  r: number;
}
/**
 * Where (length from the pivot) a hook fired at `angle` from `px` first touches `item`
 * between lengths `from` and `to`, or null when it does not.
 */
export function contactLength(px: number, angle: number, item: MineItem, from: number, to: number): number | null {
  const s = Math.sin(angle),
    c = Math.cos(angle),
    dx = item.x - px,
    dy = item.y,
    reach = item.r + G.hookRadius;
  const along = dx * s + dy * c,
    across = dx * dx + dy * dy - along * along;
  if (across > reach * reach) return null;
  const half = Math.sqrt(reach * reach - across),
    enter = along - half,
    exit = along + half;
  if (exit < from || enter > to) return null;
  return Math.max(enter, from);
}

/** The time (ms after firing) a shot needs to reach `length`. */
export const shotMs = (length: number) => (Math.max(0, length - G.restLength) / SHOT_SPEED) * 1000;
/** How long (ms) the hook takes back from `length`, with `kind` on it or empty (null). */
export function returnMs(length: number, kind: GoldKind | null) {
  const run = Math.max(0, length - G.restLength);
  if (kind === null) return Math.min(G.emptyMax, run / EMPTY_SPEED) * 1000;
  const speed = (G.depth - G.restLength) / G.items[kind].pull;
  return Math.min(G.returnMax, run / speed) * 1000;
}

export type HookState = "swing" | "out" | "back";
/** What a hook is doing: enough to place it at any moment (all times ms after BAŞLA). */
export interface HookMotion {
  state: HookState;
  /** Swing clock origin: while swinging, the angle at `t` is `swingAngle(t, origin)`. */
  origin: number;
  /** Shot angle and the moment it was fired (out or back). */
  angle: number;
  fired: number;
  /** When it stopped going out (it took an item or reached the edge) and how far it got; back only. */
  turn: number;
  reach: number;
  /** When it is back at rest (back only). */
  home: number;
}
/** The hook's angle and tip length (from the pivot) at `t`. */
export function hookPose(h: HookMotion, t: number): { angle: number; length: number } {
  if (h.state === "swing") return { angle: swingAngle(t, h.origin), length: G.restLength };
  if (t <= h.fired) return { angle: h.angle, length: G.restLength };
  const out = G.restLength + (SHOT_SPEED * (t - h.fired)) / 1000;
  if (h.state === "out" || t <= h.turn) return { angle: h.angle, length: h.state === "back" ? Math.min(out, h.reach) : out };
  const span = h.home - h.turn,
    k = span > 0 ? Math.min(1, (t - h.turn) / span) : 1;
  return { angle: h.angle, length: h.reach + (G.restLength - h.reach) * k };
}
/** The tip of a hook at `pose`, in mine coordinates. */
export const tipAt = (px: number, pose: { angle: number; length: number }) => ({ x: px + Math.sin(pose.angle) * pose.length, y: Math.cos(pose.angle) * pose.length });

/** Seconds of play left at `elapsed` ms. */
export const secondsLeft = (elapsed: number) => Math.max(0, G.limit - elapsed / 1000);

/**
 * Where a shot fired at `angle` from `px` at `fired` goes if nothing else changes: the first
 * item it touches (an index, −1 for the edge), when it turns back, how far it got and when it
 * is home. `taken(i)` skips items that are not free. Clients draw shots and bots aim with it;
 * the server resolves the same contacts step by step (claims can race there).
 */
export function traceShot(items: readonly MineItem[], px: number, angle: number, fired: number, taken: (index: number) => boolean = () => false) {
  const edge = edgeLength(px, angle);
  let item = -1,
    reach = edge;
  items.forEach((it, index) => {
    if (taken(index)) return;
    const length = contactLength(px, angle, it, G.restLength, edge);
    if (length !== null && length < reach) {
      reach = length;
      item = index;
    }
  });
  const turn = fired + shotMs(reach);
  return { item, reach, turn, home: turn + returnMs(reach, item >= 0 ? items[item].kind : null) };
}
