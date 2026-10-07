import { BOARD } from "../../../../shared/party-lab/board/config";
import { pawnOffset, type SquarePose } from "../../../../shared/party-lab/board/layout";
import type { BoardRoll, BoardWire } from "../../../../shared/party-lab/board/wire";

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

/** The square a player is drawn on: a mover stays on `from` until their last hop lands. */
export function shownSquare(board: BoardWire, slot: number, roll: BoardRoll | null, elapsed: number) {
  const square = board.pieces.find(([s]) => s === slot)?.[1] ?? 0;
  if (!roll || roll.slot !== slot) return square;
  return rollStage(roll, elapsed).stage === "done" ? roll.to : roll.from;
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
export function pawnPoses(board: BoardWire, path: readonly SquarePose[], roll: BoardRoll | null, elapsed: number): Map<number, PawnPose> {
  const poses = new Map<number, PawnPose>();
  const active = roll && board.pieces.some(([s]) => s === roll.slot) ? roll : null;
  const motion = active ? rollStage(active, elapsed) : null;
  const crowd = new Map<number, number[]>();
  for (const [slot] of board.pieces) {
    if (active && slot === active.slot && motion!.stage === "hop") continue;
    const square = shownSquare(board, slot, active, elapsed);
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

/** Squares to the treasure (the HUD's number); 0 once there. */
export const squaresLeft = (board: BoardWire, slot: number) =>
  Math.max(0, board.length - (board.pieces.find(([s]) => s === slot)?.[1] ?? 0));

/** Seconds of a roll's animation: dice, hops, settle (matches the server's hold). */
export const rollSeconds = (roll: BoardRoll) => BOARD.diceSeconds + (roll.to - roll.from) * BOARD.hopSeconds;

/** Which camera the board wants: the whole board, a player's square, or following a hop. */
export type BoardShot = { kind: "overview" } | { kind: "focus"; slot: number } | { kind: "follow"; slot: number } | { kind: "winner"; slot: number };
export function boardShot(board: BoardWire, roll: BoardRoll | null, elapsed: number): BoardShot {
  if (board.phase === "finished" && board.winner >= 0) return { kind: "winner", slot: board.winner };
  if (roll && board.phase === "move" && board.pieces.some(([s]) => s === roll.slot) && elapsed < rollSeconds(roll) + BOARD.settleSeconds)
    return { kind: "follow", slot: roll.slot };
  if ((board.phase === "choose" || board.phase === "roll" || board.phase === "move") && board.current >= 0) return { kind: "focus", slot: board.current };
  return { kind: "overview" };
}
