import { LAYER_FLAG, LAYER_RESULTS, type BombSnapshot } from "../../network/protocol.js";
import { PLAYERS } from "../players.js";
import type { LayerResult } from "../layers/round.js";

const integer = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

export interface DecodedBomb {
  tick: number;
  carrier: number | null;
  fuseEnd: number | null;
  nextFuse: number | null;
  previous: number | null;
  tagBackEnd: number | null;
  armedMask: number;
  rearmAt: number[];
  slowUntil: number[];
  flags: number[];
  outAt: number[];
  result: LayerResult | "forfeit" | null;
}

/** Strict, self-contained decoder used by rendering and prediction. */
export function decodeBombSnapshot(value: unknown): DecodedBomb | null {
  if (!value || typeof value !== "object") return null;
  const s = value as BombSnapshot;
  if (!integer(s.t, 0, 1e8) || !integer(s.c, -1, 2) || !integer(s.e, -1, 1e8) || !integer(s.n, -1, 1e8)) return null;
  if (!integer(s.p, -1, 2) || !integer(s.b, -1, 1e8) || !integer(s.a, 0, 7)) return null;
  if (!Array.isArray(s.x) || s.x.length !== 3 || !s.x.every((v) => integer(v, -1, 1e8))) return null;
  if (!Array.isArray(s.s) || s.s.length !== PLAYERS.length || !s.s.every((v) => integer(v, -1, 1e8))) return null;
  if (!Array.isArray(s.f) || s.f.length !== PLAYERS.length || !s.f.every((v) => integer(v, 0, 255))) return null;
  if (!Array.isArray(s.o) || s.o.length !== PLAYERS.length || !s.o.every((v) => integer(v, -1, 1e8))) return null;
  if (!integer(s.r, 0, LAYER_RESULTS.length - 1)) return null;
  if (s.e >= 0 && s.n >= 0) return null;
  if (s.c < 0 && (s.e >= 0 || s.n >= 0)) return null;
  for (let i = 0; i < 3; i++) {
    const armed = !!(s.a & (1 << i));
    if ((armed && s.x[i] !== -1) || (!armed && s.x[i] < s.t)) return null;
  }
  return {
    tick: s.t,
    carrier: s.c < 0 ? null : s.c,
    fuseEnd: s.e < 0 ? null : s.e,
    nextFuse: s.n < 0 ? null : s.n,
    previous: s.p < 0 ? null : s.p,
    tagBackEnd: s.b < 0 ? null : s.b,
    armedMask: s.a,
    rearmAt: [...s.x],
    slowUntil: [...s.s],
    flags: [...s.f],
    outAt: [...s.o],
    result: LAYER_RESULTS[s.r],
  };
}

export const bombFlag = (d: DecodedBomb | null, slot: number, flag: number) =>
  !!d && slot >= 0 && slot < PLAYERS.length && !!(d.flags[slot] & flag);
export { LAYER_FLAG as BOMB_FLAG };
