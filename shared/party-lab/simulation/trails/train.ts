import { LIGHT_TRAILS as L, ticks } from "./config.js";

const T = L.train,
  HALF = L.width / 2;
/** The train's speed, m/s: its front crosses the arena in `cross` s. */
export const TRAIN_SPEED = L.width / T.cross;
/** Play step at which pass k's front enters the arena, its warning starts, and its tail is out. */
export const trainEnter = (k: number) => ticks(T.first + k * T.every);
export const trainWarn = (k: number) => trainEnter(k) - ticks(T.warn);
export const trainLeave = (k: number) => trainEnter(k) + Math.ceil(((L.width + T.length) / TRAIN_SPEED) * L.hz);
/** +1: from the left wall to the right; −1 the other way. They take turns, left to right first. */
export const trainDir = (k: number) => (k % 2 === 0 ? 1 : -1);
/** Passes whose front enters before the time is up. */
export const TRAIN_PASSES = Math.max(0, Math.floor((L.limit - T.first) / T.every - 1e-9) + 1);

/** The pass whose warning or run is on (or comes next) at play step `step`. */
function passAt(step: number) {
  const k = Math.floor((step - trainWarn(0)) / ticks(T.every));
  return Math.max(0, Math.min(TRAIN_PASSES - 1, k));
}
export interface TrainSpan {
  k: number;
  dir: number;
  /** The train's extent along x on the arena, m (x0 ≤ x1). */
  x0: number;
  x1: number;
  /** Its front, m along x (may be past the far wall). */
  front: number;
}
/** Where the train is at play step `step` (fractional for the view), null when none is on the arena. */
export function trainSpan(step: number): TrainSpan | null {
  if (TRAIN_PASSES === 0) return null;
  const k = passAt(step),
    enter = trainEnter(k);
  if (step < enter || step >= trainLeave(k)) return null;
  const dir = trainDir(k),
    run = ((step - enter) / L.hz) * TRAIN_SPEED,
    front = dir * (-HALF + run),
    tail = front - dir * T.length;
  const x0 = Math.max(-HALF, Math.min(front, tail)),
    x1 = Math.min(HALF, Math.max(front, tail));
  return x0 <= x1 ? { k, dir, x0, x1, front } : null;
}
/** Everything the train covered during the step that ended at `step` (its start and end spans joined). */
export function trainSwept(step: number): TrainSpan | null {
  const a = trainSpan(step - 1),
    b = trainSpan(step);
  if (!a || !b) return b ?? a;
  return { ...b, x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) };
}
export interface TrainState {
  k: number;
  dir: number;
  /** "warn": the rails blink, the horn; "run": the train is on the arena; "wait": the next one is coming. "done": no more trains. */
  phase: "wait" | "warn" | "run" | "done";
  /** Seconds until its front enters (0 once running). */
  until: number;
}
/** The train's state at play step `step` (fractional for the view). */
export function trainState(step: number): TrainState {
  if (TRAIN_PASSES === 0) return { k: -1, dir: 1, phase: "done", until: Infinity };
  let k = passAt(step);
  if (step >= trainLeave(k)) k++;
  if (k >= TRAIN_PASSES) return { k: -1, dir: 1, phase: "done", until: Infinity };
  const enter = trainEnter(k),
    dir = trainDir(k);
  if (step >= enter) return { k, dir, phase: "run", until: 0 };
  return { k, dir, phase: step >= trainWarn(k) ? "warn" : "wait", until: (enter - step) / L.hz };
}
