import { BOARD, EFFECT, effectTravelSeconds } from "../../../../shared/party-lab/board/config";
import { pawnOffset, SQUARE_SIZE, type SquarePose } from "../../../../shared/party-lab/board/layout";
import type { BoardEffect, BoardRoll, BoardWire } from "../../../../shared/party-lab/board/wire";

/**
 * What the board looks like at a moment, from the server's board and when this page first
 * saw the latest roll. Pure: no three.js, no clock of its own (the caller passes elapsed
 * seconds), so the timing is testable. The server holds each move for exactly
 * BOARD.diceSeconds + steps × BOARD.hopSeconds + BOARD.settleSeconds before the next turn.
 */
export const HOP_HEIGHT = 0.55;
/** On the treasure square the chest stands at the back; players gather in front of it. */
export const TREASURE_FRONT = 0.42;

export type RollStage = "dice" | "hop" | "done";
export function rollStage(roll: BoardRoll, elapsed: number): { stage: RollStage; hop: number; u: number } {
  if (elapsed < BOARD.diceSeconds) return { stage: "dice", hop: -1, u: elapsed / BOARD.diceSeconds };
  const steps = roll.to - roll.from,
    t = (elapsed - BOARD.diceSeconds) / BOARD.hopSeconds;
  if (t >= steps) return { stage: "done", hop: steps, u: 1 };
  const hop = Math.floor(t);
  return { stage: "hop", hop, u: t - hop };
}

/** A special square effect and how long ago this page first saw it (Infinity: already over). */
export interface EffectClock {
  effect: BoardEffect;
  elapsed: number;
}
export type EffectStage = "lead" | "travel" | "done";
/** Lead (the square lights up), travel (pieces move; a bonus or an empty swap just waits), done. */
export function effectStage(effect: BoardEffect, elapsed: number): { stage: EffectStage; u: number } {
  if (elapsed < EFFECT.leadSeconds) return { stage: "lead", u: elapsed / EFFECT.leadSeconds };
  const travel = effectTravelSeconds(effect),
    t = elapsed - EFFECT.leadSeconds;
  return t < travel ? { stage: "travel", u: t / travel } : { stage: "done", u: 1 };
}
/** The effect still being shown, or null. */
const showing = (fx: EffectClock | null | undefined) => (fx && Number.isFinite(fx.elapsed) && effectStage(fx.effect, fx.elapsed).stage !== "done" ? fx : null);

/**
 * The square a player is drawn on: a mover stays on `from` until their last hop lands; during
 * an effect's lead the player (and a swap partner) still stand where they were.
 */
export function shownSquare(board: BoardWire, slot: number, roll: BoardRoll | null, elapsed: number, fx?: EffectClock | null) {
  const square = board.pieces.find(([s]) => s === slot)?.[1] ?? 0;
  const live = showing(fx);
  if (live) {
    const e = live.effect;
    if (slot === e.slot) return e.from;
    if (slot === e.other) return e.to;
  }
  if (!roll || roll.slot !== slot) return square;
  return rollStage(roll, elapsed).stage === "done" ? square : roll.from;
}

/**
 * Ladders arch over the gap between rows. Slides start a little out in the gap, low enough
 * that the camera still sees their square's glyph, and bow sideways on the way down.
 */
export const LADDER_ARCH = 0.45;
export const SLIDE_TOP = 0.6;
export const SLIDE_LIP = 0.35;
export const SLIDE_BOW = 0.45;
/** Where the scenery of a ladder or slide runs, as fractions of the centre-to-centre line. */
export function connectorSpan(type: "ladder" | "slide", a: { x: number; z: number }, b: { x: number; z: number }) {
  const d = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const edge = Math.min(0.45, SQUARE_SIZE / 2 / d);
  return { start: type === "slide" ? Math.min(0.5, edge + SLIDE_LIP / d) : edge, end: 1 - edge };
}
/**
 * A point on a ladder (lower → upper square) or a slide (upper → lower), centre to centre:
 * t = 0 at `a`, 1 at `b`; y above the tile tops. The scenery is built from the same curve,
 * so a climbing or sliding pawn stays on it.
 */
export function connectorPoint(type: "ladder" | "slide", a: { x: number; z: number }, b: { x: number; z: number }, t: number) {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    d = Math.hypot(dx, dz) || 1;
  const { start, end } = connectorSpan(type, a, b);
  const s = Math.max(0, Math.min(1, (t - start) / (end - start)));
  const gap = t > start && t < end;
  let y = 0,
    side = 0;
  if (type === "ladder") y = gap ? LADDER_ARCH * Math.sin(Math.PI * s) : 0;
  else {
    // A hop up onto the chute, then down: steep first, flattening at the bottom.
    y = t <= start ? SLIDE_TOP * (t / start) : gap ? SLIDE_TOP * (1 - s) ** 2 : 0;
    side = gap ? SLIDE_BOW * Math.sin(Math.PI * s) : 0;
  }
  return { x: a.x + dx * t - (dz / d) * side, y, z: a.z + dz * t + (dx / d) * side };
}

export interface PawnPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** In the air between two squares (not part of any square's crowd). */
  hopping: boolean;
}

/**
 * Every player's pose. Players sharing a square stand round it (pawnOffset), in slot
 * order; a hopping player is alone in the air on the path's centre line.
 */
export function pawnPoses(board: BoardWire, path: readonly SquarePose[], roll: BoardRoll | null, elapsed: number, fx?: EffectClock | null): Map<number, PawnPose> {
  const poses = new Map<number, PawnPose>();
  const active = roll && board.pieces.some(([s]) => s === roll.slot) ? roll : null;
  const motion = active ? rollStage(active, elapsed) : null;
  const flying = effectPoses(board, path, fx);
  for (const [slot, pose] of flying) poses.set(slot, pose);
  const crowd = new Map<number, number[]>();
  for (const [slot] of board.pieces) {
    if (active && slot === active.slot && motion!.stage === "hop") continue;
    if (flying.has(slot)) continue;
    const square = shownSquare(board, slot, active, elapsed, fx);
    crowd.set(square, [...(crowd.get(square) ?? []), slot]);
  }
  for (const [square, slots] of crowd)
    slots.forEach((slot, index) => {
      const at = path[Math.min(square, path.length - 1)],
        offset = pawnOffset(index, slots.length),
        front = square >= path.length - 1 ? TREASURE_FRONT : 0;
      // The offset ring turns with the path so neighbours stay side by side.
      const c = Math.cos(at.yaw),
        s = Math.sin(at.yaw);
      poses.set(slot, { x: at.x + offset.x * c + offset.z * s, y: 0, z: at.z - offset.x * s + offset.z * c + front, yaw: at.yaw, hopping: false });
    });
  if (active && motion!.stage === "hop") {
    const a = path[active.from + motion!.hop],
      b = path[Math.min(path.length - 1, active.from + motion!.hop + 1)],
      u = motion!.u;
    poses.set(active.slot, {
      x: a.x + (b.x - a.x) * u,
      y: HOP_HEIGHT * Math.sin(Math.PI * u),
      z: a.z + (b.z - a.z) * u,
      yaw: Math.atan2(b.x - a.x, b.z - a.z),
      hopping: true,
    });
  }
  return poses;
}

/** Pawns in the air during an effect's travel: hops (İleri, Geri), ladder, slide, the swap's two arcs. */
export function effectPoses(board: BoardWire, path: readonly SquarePose[], fx?: EffectClock | null): Map<number, PawnPose> {
  const poses = new Map<number, PawnPose>();
  const live = showing(fx);
  if (!live) return poses;
  const e = live.effect,
    { stage, u } = effectStage(e, live.elapsed);
  const on = (slot: number) => board.pieces.some(([s]) => s === slot);
  if (stage !== "travel" || !on(e.slot)) return poses;
  const at = (i: number) => path[Math.max(0, Math.min(path.length - 1, i))];
  const toward = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.atan2(b.x - a.x, b.z - a.z);
  if (e.type === "forward" || e.type === "back") {
    const steps = Math.abs(e.to - e.from),
      dir = Math.sign(e.to - e.from);
    if (!steps) return poses;
    const t = Math.min(steps - 1e-9, u * steps),
      hop = Math.floor(t),
      v = t - hop;
    const a = at(e.from + dir * hop),
      b = at(e.from + dir * (hop + 1));
    poses.set(e.slot, { x: a.x + (b.x - a.x) * v, y: HOP_HEIGHT * Math.sin(Math.PI * v), z: a.z + (b.z - a.z) * v, yaw: toward(a, b), hopping: true });
  } else if (e.type === "ladder" || e.type === "slide") {
    // Climbing is steady; sliding speeds up.
    const t = e.type === "slide" ? u * u : u;
    const a = at(e.from),
      b = at(e.to),
      p = connectorPoint(e.type, a, b, t);
    poses.set(e.slot, { x: p.x, y: p.y, z: p.z, yaw: toward(a, b), hopping: true });
  } else if (e.type === "swap" && e.other >= 0 && on(e.other)) {
    // Two arcs that pass each other side by side.
    const a = at(e.from),
      b = at(e.to),
      d = Math.hypot(b.x - a.x, b.z - a.z) || 1,
      lift = 1.3 * Math.sin(Math.PI * u),
      side = 0.6 * Math.sin(Math.PI * u);
    const px = -(b.z - a.z) / d,
      pz = (b.x - a.x) / d;
    poses.set(e.slot, { x: a.x + (b.x - a.x) * u + px * side, y: lift, z: a.z + (b.z - a.z) * u + pz * side, yaw: toward(a, b), hopping: true });
    poses.set(e.other, { x: b.x + (a.x - b.x) * u - px * side, y: lift, z: b.z + (a.z - b.z) * u - pz * side, yaw: toward(b, a), hopping: true });
  }
  return poses;
}

/** Squares to the treasure (the HUD's number); 0 once there. */
export const squaresLeft = (board: BoardWire, slot: number) =>
  Math.max(0, board.length - (board.pieces.find(([s]) => s === slot)?.[1] ?? 0));

/** Seconds of a roll's animation: dice, hops, settle (matches the server's hold). */
export const rollSeconds = (roll: BoardRoll) => BOARD.diceSeconds + (roll.to - roll.from) * BOARD.hopSeconds;

/** Which camera the board wants: the whole board, a player's square, or following a hop. */
export type BoardShot =
  | { kind: "overview" }
  | { kind: "focus"; slot: number }
  | { kind: "follow"; slot: number }
  | { kind: "winner"; slot: number }
  | { kind: "pair"; slots: [number, number] };
export function boardShot(board: BoardWire, roll: BoardRoll | null, elapsed: number): BoardShot {
  if (board.phase === "finished" && board.winner >= 0) return { kind: "winner", slot: board.winner };
  // An effect: follow the player; a swap keeps both in view.
  const e = board.effect;
  if (board.phase === "effect" && e && board.pieces.some(([s]) => s === e.slot))
    return e.type === "swap" && e.other >= 0 && board.pieces.some(([s]) => s === e.other) ? { kind: "pair", slots: [e.slot, e.other] } : { kind: "follow", slot: e.slot };
  if (roll && board.phase === "move" && board.pieces.some(([s]) => s === roll.slot) && elapsed < rollSeconds(roll) + BOARD.settleSeconds)
    return { kind: "follow", slot: roll.slot };
  if ((board.phase === "choose" || board.phase === "roll" || board.phase === "move") && board.current >= 0) return { kind: "focus", slot: board.current };
  return { kind: "overview" };
}
