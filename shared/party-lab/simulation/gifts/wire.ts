import { LAYER_FLAG, LAYER_RESULTS } from "../../network/protocol.js";
import { PLAYERS } from "../players.js";
import type { LayerResult } from "../layers/round.js";
import { GIFT_EVENT_KINDS, type GiftBox, type GiftEvent, type GiftEventKind, type GiftGame } from "./game.js";

/**
 * Hediye Kapmaca's complete authoritative state, in every snapshot (a reconnect has it all
 * from its first one). Positions in centimetres, timers as absolute round ticks.
 * - `t`: round tick (in play, the next step's; in results, the end; 0 before play).
 * - `s`: slots in seat order (seat = home). `p`: boxes left on the pile; `w`: tick it ran out (−1).
 * - `h`: per slot, boxes at home (−1 not in the match). `c`: carrying, one bit per slot.
 * - `b`: boxes on the floor or flying, 8 numbers each: id, x, z (where it rests), fx, fy, fz
 *   (where it left), at (tick it left), land (tick it rests).
 * - `u`, `g`: per slot, the tick the stun / the guard ends (−1 none).
 * - `e`: the recent box events, 8 numbers each: id, tick, kind (GIFT_EVENT_KINDS index),
 *   actor, owner, x, z, box.
 * - `f`: per slot, LAYER_FLAG bits. `r`: LAYER_RESULTS index of the finished round (0 undecided).
 */
export interface GiftWire {
  t: number;
  s: number[];
  p: number;
  w: number;
  h: number[];
  c: number;
  b: number[];
  u: number[];
  g: number[];
  e: number[];
  f: number[];
  r: number;
}
const BOX = 8,
  EVENT = 8,
  MAX_BOXES = 24,
  MAX_EVENTS = 32;
const cm = (m: number) => Math.round(m * 100);

export function giftWire(game: GiftGame, flags: readonly number[], result: number): GiftWire {
  const t = game.round.phase === "playing" ? game.round.tick : game.round.phase === "results" ? Math.max(0, game.round.endedAt) : 0;
  const inMatch = (slot: number) => game.seatOf[slot] >= 0;
  return {
    t,
    s: [...game.seats],
    p: game.pile,
    w: game.pileEmptyAt,
    h: PLAYERS.map(({ id }) => (inMatch(id) ? game.home[id] : -1)),
    c: PLAYERS.reduce((mask, { id }) => mask | (game.carrying[id] ? 1 << id : 0), 0),
    b: game.boxes.slice(-MAX_BOXES).flatMap((box) => [box.id, cm(box.x), cm(box.z), cm(box.fx), cm(box.fy), cm(box.fz), box.at, box.land]),
    u: PLAYERS.map(({ id }) => (game.stun[id] > 0 ? t + game.stun[id] : -1)),
    g: PLAYERS.map(({ id }) => (game.guard[id] > 0 ? t + game.guard[id] : -1)),
    e: game.log.slice(-MAX_EVENTS).flatMap((e) => [e.id, e.tick, GIFT_EVENT_KINDS.indexOf(e.kind), e.actor, e.owner, cm(e.x), cm(e.z), e.box]),
    f: [...flags],
    r: result,
  };
}

/** Flags of every slot from a game (local play: everyone in the match is connected and in). */
export function giftFlags(game: GiftGame) {
  return PLAYERS.map(({ id }) =>
    game.seatOf[id] < 0
      ? 0
      : LAYER_FLAG.inMatch |
        (game.round.alive[id] ? LAYER_FLAG.alive : 0) |
        (!game.physics.players[id].eliminated ? LAYER_FLAG.body : 0) |
        (game.brawl.fighters[id].stagger.time > 1e-9 ? LAYER_FLAG.staggered : 0) |
        (game.forfeited[id] ? LAYER_FLAG.forfeit : 0)
  );
}

export interface DecodedGift {
  tick: number;
  seats: number[];
  players: 2 | 3;
  pile: number;
  pileEmptyAt: number;
  home: number[];
  carrying: boolean[];
  boxes: GiftBox[];
  stunUntil: number[];
  guardUntil: number[];
  events: GiftEvent[];
  flags: number[];
  result: LayerResult | "forfeit" | null;
}
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const integers = (v: unknown, length: number | null, min: number, max: number) =>
  Array.isArray(v) && (length === null || v.length === length) && v.every((n) => integer(n, min, max));

export function validGiftWire(value: unknown): value is GiftWire {
  if (!value || typeof value !== "object") return false;
  const w = value as GiftWire;
  if (!integer(w.t, 0, 1e8) || !integer(w.p, 0, 99) || !integer(w.w, -1, 1e8) || !integer(w.c, 0, 7) || !integer(w.r, 0, LAYER_RESULTS.length - 1)) return false;
  if (!integers(w.s, null, 0, PLAYERS.length - 1) || (w.s.length !== 2 && w.s.length !== 3) || new Set(w.s).size !== w.s.length) return false;
  if (!integers(w.h, PLAYERS.length, -1, 99) || !integers(w.u, PLAYERS.length, -1, 1e8) || !integers(w.g, PLAYERS.length, -1, 1e8) || !integers(w.f, PLAYERS.length, 0, 255)) return false;
  if (!integers(w.b, null, -1e5, 1e8) || w.b.length % BOX !== 0 || w.b.length > BOX * MAX_BOXES) return false;
  if (!integers(w.e, null, -1e5, 1e8) || w.e.length % EVENT !== 0 || w.e.length > EVENT * MAX_EVENTS) return false;
  for (let i = 0; i < w.e.length; i += EVENT) if (!integer(w.e[i + 2], 0, GIFT_EVENT_KINDS.length - 1)) return false;
  return true;
}

/** Strict decoder used by rendering and prediction (null when malformed). */
export function decodeGiftWire(value: unknown): DecodedGift | null {
  if (!validGiftWire(value)) return null;
  const w = value;
  const boxes: GiftBox[] = [];
  for (let i = 0; i < w.b.length; i += BOX) {
    const [id, x, z, fx, fy, fz, at, land] = w.b.slice(i, i + BOX);
    boxes.push({ id, x: x / 100, z: z / 100, fx: fx / 100, fy: fy / 100, fz: fz / 100, at, land });
  }
  const events: GiftEvent[] = [];
  for (let i = 0; i < w.e.length; i += EVENT) {
    const [id, tick, kind, actor, owner, x, z, box] = w.e.slice(i, i + EVENT);
    events.push({ id, tick, kind: GIFT_EVENT_KINDS[kind] as GiftEventKind, actor, owner, x: x / 100, z: z / 100, box });
  }
  return {
    tick: w.t,
    seats: [...w.s],
    players: w.s.length === 2 ? 2 : 3,
    pile: w.p,
    pileEmptyAt: w.w,
    home: [...w.h],
    carrying: PLAYERS.map(({ id }) => !!(w.c & (1 << id))),
    boxes,
    stunUntil: [...w.u],
    guardUntil: [...w.g],
    events,
    flags: [...w.f],
    result: LAYER_RESULTS[w.r],
  };
}
