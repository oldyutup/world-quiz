import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
import type { GameMode } from "../modes.js";
export const NET = {
  // 3: rooftop arena. Prediction replays against the static map, so a client
  // built for another map must refuse this server's snapshots.
  // 4: ping/pong link diagnostics. An older server answers "ping" with an
  // INVALID_MESSAGE notice every second, so mismatched deploys are refused at join.
  // 5: game modes (Rooftop Brawl / Barn Shootout / Mixed). A room can now run Barn
  // rounds: a v4 page would render and predict the rooftop against barn poses, and a
  // v4 server rejects the barn input packet. Every snapshot names its round's mode.
  // 6: Katman Kaosu (layer_chaos) online. A new mode, input packet, snapshot tile section
  // and prediction block; a v5 page would render a layer round as the rooftop and a v5
  // server rejects the layer packet. Mixed rotates all three modes.
  // 7: Renk Kaosu (color_chaos) online. A new mode and snapshot colour section (the shove
  // modes' input packet and prediction block are shared); a v6 page cannot draw or predict a
  // colour round and a v6 server refuses the mode. Mixed rotates all four modes.
  // 8: Bomba Sende (bomb_tag) online. Adds its compact intent, self-contained bomb/trap
  // snapshot and prediction state; Mixed rotates all five modes.
  // 9: Saklambaç, authoritative room settings and six-mode Mixed.
  version: 9,
  physicsHz: 60,
  snapshotHz: 20,
  inputHz: 60,
  staleMs: 300,
  interpolationMs: 100,
  pingMs: 1000,
  /** Barn lag compensation: the oldest view a shot may be resolved against. */
  maxRewindMs: 250,
  /** Bomba Sende proximity rewind. Nine 60 Hz poses cover interpolation + normal RTT. */
  maxBombRewindMs: 150,
  maxPropRewindMs: 150,
} as const;
export interface PingPacket {
  id: number;
  t: number; // Client clock, echoed untouched; the server never interprets it.
  diag?: boolean; // Opt-in server loop diagnostics (debug overlay only).
}
/** Rolling server-loop window; process-wide values cover every room in the process. */
export interface ServerDiagnostics {
  windowMs: number;
  stepAvgMs: number;
  stepMaxMs: number;
  tickGapMaxMs: number; // Longest wall-clock gap between fixed-step callbacks.
  catchUpSteps: number; // Steps run back-to-back to recover from a late callback.
  snapshotAvgMs: number; // Snapshot build + per-client send.
  snapshotMaxMs: number;
  loopDelayP99Ms: number; // Node event-loop delay.
  loopDelayMaxMs: number;
  gcMaxMs: number;
  cpuPercent: number; // Of one core, whole process.
  heapMb: number;
  rssMb: number;
  chatPatchAvgMs: number; // Chat receive → next state patch broadcast.
  chatPatchMaxMs: number;
  rooms: number;
  /** This room: current simulation mode, exact encoded snapshot size, simulations built. */
  mode?: GameMode;
  snapshotBytes?: number;
  simulations?: number;
  /** Katman Kaosu, this round: encoded `layers` section size, tiles armed (not gone) and gone, section build cost. */
  layers?: {
    sectionBytes: number;
    armed: number;
    gone: number;
    encodeUs: number;
  };
  /** Renk Kaosu, this round: encoded `colors` section size, cycle, tiles present / marked / grey, section build cost. */
  colors?: {
    sectionBytes: number;
    cycle: number;
    present: number;
    marked: number;
    grey: number;
    encodeUs: number;
  };
  /** Bomba Sende: compact section and current authoritative state. */
  bomb?: {
    sectionBytes: number;
    carrier: number;
    armedTraps: number;
    slowed: number;
    encodeUs: number;
  };
  /** Barn lag compensation, this round: shots resolved, last/max rewind, rejected/clamped views, lookup cost. */
  rewind?: {
    shots: number;
    lastMs: number;
    maxMs: number;
    clampedOld: number;
    rejectedFuture: number;
    lookupUs: number;
  };
}
export interface PongPacket {
  id: number;
  t: number;
  s: number; // Server Date.now() when the pong was sent.
  d?: ServerDiagnostics;
}
export function validatePing(value: unknown): PingPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((k) => k !== "id" && k !== "t" && k !== "diag"))
    return null;
  if (!Number.isSafeInteger(p.id) || (p.id as number) < 0) return null;
  if (typeof p.t !== "number" || !Number.isFinite(p.t)) return null;
  if (p.diag !== undefined && typeof p.diag !== "boolean") return null;
  return { id: p.id as number, t: p.t, diag: p.diag === true };
}
export type OnlinePhase = "waiting" | "countdown" | "playing" | "results";
export interface InputPacket {
  seq: number;
  round: number;
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  punchPressed: boolean;
  grabHeld: boolean;
  liftHeld: boolean;
}
/**
 * Barn Shootout input: intent only, like the rooftop packet. Movement is already
 * camera-relative (world X/Z, magnitude ≤ 1); the aim is a yaw/pitch plus a point on
 * the camera's aim line near the shoulder (the simulation bounds it). `viewTick` is
 * the server tick of the remote poses on screen when the packet was sent; the server
 * validates and clamps it for lag compensation. Never a target, damage or result.
 */
export interface BarnInputPacket {
  seq: number;
  round: number;
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  sprintHeld: boolean;
  attackPressed: boolean;
  attackHeld: boolean;
  pickupPressed: boolean;
  aimYaw: number;
  aimPitch: number;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  viewTick: number;
}
/**
 * Katman Kaosu and Renk Kaosu input (the shove modes): intent only. Movement is
 * camera-relative world X/Z (magnitude ≤ 1, normalised by `normalizeMove` on both ends);
 * jump and punch are edges, sprint is held. Never a tile, a colour, a hit, an elimination
 * or a result: the server decides all of those.
 */
export interface LayerInputPacket {
  seq: number;
  round: number;
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  sprintHeld: boolean;
  punchPressed: boolean;
}
/** Bomba Sende intent. `viewTick` is the server snapshot timeline on screen, never a target. */
export interface BombInputPacket extends LayerInputPacket {
  viewTick: number;
}
/** Prop Hunt intent: Barn aim/movement edges plus a separate whistle edge. */
export interface PropInputPacket extends BarnInputPacket { whistlePressed: boolean; }
export type AnyInputPacket = PropInputPacket | InputPacket | BarnInputPacket | LayerInputPacket | BombInputPacket;
export const isBarnPacket = (p: AnyInputPacket): p is BarnInputPacket => "attackPressed" in p;
export const isBombPacket = (p: AnyInputPacket): p is BombInputPacket => "viewTick" in p && "punchPressed" in p;
export const isLayerPacket = (p: AnyInputPacket): p is LayerInputPacket => "sprintHeld" in p && !("attackPressed" in p);
export interface GameEvent extends FeedbackEvent {
  id: number;
  round: number;
  tick: number;
  inputSeq?: number; // Originating punch/attack edge, for local presentation deduplication.
}
/** Only sent to this slot's client. Never accepted from a client. */
export interface PredictionState {
  slot: number;
  velocities: Uint8Array; // Nine bodies × (linear XYZ, angular XYZ), Float32 LE.
  controller: number[]; // Rooftop: facing, gait, jump cooldown, next hand, alternate cooldown, two age/cooldown pairs. Barn, layers: empty.
  /** Barn: BARN_PREDICTION_FIELDS Float64 LE values (character + own fighter state). */
  barn?: Uint8Array;
  /** Katman Kaosu and Renk Kaosu (the shove fighter): LAYER_PREDICTION_FIELDS Float64 LE values. */
  layers?: Uint8Array;
  /** Bomba Sende: fighter timers plus authoritative carrier/slow modifiers for replay. */
  bomb?: Uint8Array;
}
export const VELOCITY_BYTES = 9 * 6 * 4;
/**
 * Barn prediction state (Float64, recipient only): what the local rig needs to replay
 * movement, aim-facing, sprint, the idle anchor, trap hold, stagger, punches and its own
 * weapon cadence exactly like the server. Float64 because the restore must be exact: a
 * 180° aim flick is resolved by the sign of a tiny facing difference, and a Float32
 * facing turned the replay the other way (a hard correction at 100 ms + jitter).
 */
export const BARN_PREDICTION_FIELDS = [
  "facing",
  "gait",
  "jumpIn",
  "sprint",
  "anchored",
  "anchorX",
  "anchorZ",
  "alive",
  "punchHand",
  "punchCooldown",
  "punchAge",
  "punchSwingCooldown",
  "trapped",
  "staggerTime",
  "staggerPosture",
  "staggerMobility",
  "protection",
  "weapon",
  "ammo",
  "weaponCooldown",
  "bloom",
  "aimPitch",
] as const;
export const BARN_PREDICTION_BYTES = BARN_PREDICTION_FIELDS.length * 8;
/**
 * Katman Kaosu / Renk Kaosu prediction state (Float64, recipient only): the character's
 * controller state and the own fighter's punch and stagger timers, so the local rig replays
 * movement, sprint blend, jump cooldown, punches and staggers like the server. The tile
 * state it replays against comes from the snapshot's `layers` or `colors` section.
 */
export const LAYER_PREDICTION_FIELDS = [
  "facing",
  "gait",
  "jumpIn",
  "sprint",
  "alive",
  "punchHand",
  "punchCooldown",
  "punchAge",
  "punchSwingCooldown",
  "staggerTime",
  "staggerPosture",
  "staggerMobility",
] as const;
export const LAYER_PREDICTION_BYTES = LAYER_PREDICTION_FIELDS.length * 8;
export const BOMB_PREDICTION_FIELDS = [...LAYER_PREDICTION_FIELDS, "carrier", "slowTicks"] as const;
export const BOMB_PREDICTION_BYTES = BOMB_PREDICTION_FIELDS.length * 8;
/** Katman Kaosu and Renk Kaosu per-fighter flags (`LayerSnapshot.f`, `ColorFieldSnapshot.f`). */
export const LAYER_FLAG = { inMatch: 1, alive: 2, body: 4, staggered: 8, forfeit: 16 } as const;
/** Round result codes (`LayerSnapshot.r`, `ColorFieldSnapshot.r`). */
export const LAYER_RESULTS = [null, "survivor", "all-fell", "timeout", "forfeit"] as const;
/**
 * Katman Kaosu's tile state, complete in every snapshot (idempotent: a late joiner or a
 * reconnect has the exact field from its first snapshot; no tile events to miss):
 * - `t`: round tick. In play, the tick the next step's rules use; in results, the tick
 *   the round ended on; 0 before play.
 * - `g`: GONE bitset, one bit per tile id (297 bits, 38 bytes, LSB first).
 * - `a`: armed tiles not yet GONE, three bytes each: tile id (uint16 LE) and age in ticks
 *   (t − armTick, ≤ 255; a tile never lasts longer than 78). Its GONE tick follows from
 *   the rules (`breakTicks`); untouched tiles follow the fixed collapse schedule.
 * - `f`: per slot, LAYER_FLAG bits. `o`: per slot, the round tick eliminated (−1: not).
 * - `r`: LAYER_RESULTS index of the finished round (0 while undecided).
 */
export interface LayerSnapshot {
  t: number;
  g: Uint8Array;
  a: Uint8Array;
  f: number[];
  o: number[];
  r: number;
}
/**
 * Renk Kaosu's colour field, complete in every snapshot (idempotent: a late joiner or a
 * reconnect has the exact floor from its first snapshot; there are no tile events):
 * - `t`: round tick, as `LayerSnapshot.t`.
 * - `n`: colour cycle (1-based) the drawn tick belongs to; `k`: its ticks
 *   [start, announce, drop, restore] (they follow from `n`; the client checks they do).
 * - `h`: the cycle's target colour (0–3). Sent from the cycle's start, so every screen can
 *   reveal it on the announce tick of its own timeline; the client never shows it earlier.
 * - `p`: tiles there this cycle (bitset, 85 bits = 11 bytes, LSB first); `g`: of those, the
 *   grey ones (no colour, never the target, gone at this drop); `m`: marked ("DARALIYOR":
 *   coloured now, grey next cycle).
 * - `c`: colour per tile, 2 bits each (22 bytes; meaningless where a tile has none).
 * - `f`, `o`, `r`: as LayerSnapshot.
 * Standing on round tick τ of the cycle: the target colour always; every other tile of `p`
 * before `drop`. From `restore` on, the tiles with a colour this cycle (`p` minus `g`).
 */
export interface ColorFieldSnapshot {
  t: number;
  n: number;
  k: number[];
  h: number;
  p: Uint8Array;
  g: Uint8Array;
  m: Uint8Array;
  c: Uint8Array;
  f: number[];
  o: number[];
  r: number;
}
/**
 * Bomba Sende's complete authoritative state. All timers are absolute round ticks:
 * `e` fuse end, `n` next-fuse start, `b` no-tag-back expiry, `x` trap rearm ticks and
 * `s` player slow expiries. `a` is the three armed-trap bits. `f/o/r` mirror layer rounds.
 */
export interface BombSnapshot {
  t: number;
  c: number;
  e: number;
  n: number;
  p: number;
  b: number;
  a: number;
  x: number[];
  s: number[];
  f: number[];
  o: number[];
  r: number;
}
/** Weapon codes on the wire: 0 unarmed, 1 shotgun, 2 SMG. */
export const WEAPON_CODES = [null, "shotgun", "smg"] as const;
/**
 * Barn per-fighter values (small integers, msgpack packs each into 1–3 bytes):
 * flags, HP, weapon code, ammo, kills, deaths, respawn in / protection / trap hold
 * (deciseconds), aim pitch (centiradians, signed).
 */
export const BARN_FIGHTER_FIELDS = 10;
export const BARN_FLAG = { alive: 1, present: 2, staggered: 4 } as const;
export interface BarnSnapshot {
  /** Three slots × BARN_FIGHTER_FIELDS. */
  f: number[];
  /** Active pickups: [spot index, weapon code] pairs. */
  p: number[];
  /** Telegraphed replacements: [spot index, progress 0–100] pairs. */
  t: number[];
  /** Traps in map order: [rearm in (ds, 0 = armed), since sprung (ds, capped 255)] pairs. */
  r: number[];
}
export interface GameSnapshot {
  v: number;
  /** The mode of the round this snapshot belongs to (never inferred from poses). */
  mode: GameMode;
  seq: number;
  tick: number;
  round: number;
  phase: OnlinePhase;
  seconds: number;
  winner: number;
  mask: number;
  alive: number;
  states: number[];
  meters: number[];
  grips: number[];
  ack: number[];
  transforms: Uint8Array;
  prediction?: PredictionState;
  barn?: BarnSnapshot;
  layers?: LayerSnapshot;
  colors?: ColorFieldSnapshot;
  bomb?: BombSnapshot;
  prop?: import("../simulation/prophunt/wire.js").PropSnapshotWire;
}
export const BODY_COUNT = 9,
  BODY_STRIDE = 7,
  TRANSFORM_BYTES = 3 * BODY_COUNT * BODY_STRIDE * 4;
export const CONDITIONS = [
  "CONSCIOUS",
  "DAZED",
  "KNOCKED_OUT",
  "RECOVERING",
] as const;
/**
 * Movement axes as the server applies them: each clamped to [−1, 1], then scaled down to
 * a length of at most 1. The layer client normalises before sending, so its prediction
 * replays exactly the numbers the server uses.
 */
export function normalizeMove(moveX: number, moveZ: number) {
  let x = Math.max(-1, Math.min(1, moveX)),
    z = Math.max(-1, Math.min(1, moveZ));
  const length = Math.max(1, Math.hypot(x, z));
  x /= length;
  z /= length;
  return { x, z };
}
const keys = [
  "seq",
  "round",
  "moveX",
  "moveZ",
  "jumpPressed",
  "punchPressed",
  "grabHeld",
  "liftHeld",
];
export function validateInput(value: unknown): InputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as InputPacket;
  if (
    Object.keys(p).length !== keys.length ||
    Object.keys(p).some((k) => !keys.includes(k))
  )
    return null;
  if (
    !Number.isSafeInteger(p.seq) ||
    p.seq < 0 ||
    !Number.isSafeInteger(p.round) ||
    p.round < 1
  )
    return null;
  if (
    ![p.moveX, p.moveZ].every(
      (v) => typeof v === "number" && Number.isFinite(v)
    )
  )
    return null;
  if (
    ![p.jumpPressed, p.punchPressed, p.grabHeld, p.liftHeld].every(
      (v) => typeof v === "boolean"
    )
  )
    return null;
  let x = Math.max(-1, Math.min(1, p.moveX)),
    z = Math.max(-1, Math.min(1, p.moveZ));
  const length = Math.max(1, Math.hypot(x, z));
  x /= length;
  z /= length;
  return { ...p, moveX: x, moveZ: z };
}
const barnKeys = [
  "seq",
  "round",
  "moveX",
  "moveZ",
  "jumpPressed",
  "sprintHeld",
  "attackPressed",
  "attackHeld",
  "pickupPressed",
  "aimYaw",
  "aimPitch",
  "eyeX",
  "eyeY",
  "eyeZ",
  "viewTick",
];
/** Aim pitch accepted from a client (the simulation clamps it again); eye point range. */
const BARN_PITCH_LIMIT = 1.2,
  BARN_EYE_LIMIT = 4;
export function validateBarnInput(value: unknown): BarnInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as BarnInputPacket;
  if (
    Object.keys(p).length !== barnKeys.length ||
    Object.keys(p).some((k) => !barnKeys.includes(k))
  )
    return null;
  if (
    !Number.isSafeInteger(p.seq) ||
    p.seq < 0 ||
    !Number.isSafeInteger(p.round) ||
    p.round < 1
  )
    return null;
  if (
    ![p.moveX, p.moveZ, p.aimYaw, p.aimPitch, p.eyeX, p.eyeY, p.eyeZ, p.viewTick].every(
      (v) => typeof v === "number" && Number.isFinite(v)
    ) ||
    p.viewTick < 0 ||
    Math.abs(p.aimYaw) > 1e4
  )
    return null;
  if (
    ![p.jumpPressed, p.sprintHeld, p.attackPressed, p.attackHeld, p.pickupPressed].every(
      (v) => typeof v === "boolean"
    )
  )
    return null;
  let x = Math.max(-1, Math.min(1, p.moveX)),
    z = Math.max(-1, Math.min(1, p.moveZ));
  const length = Math.max(1, Math.hypot(x, z));
  x /= length;
  z /= length;
  const eye = (v: number) => Math.max(-BARN_EYE_LIMIT, Math.min(BARN_EYE_LIMIT, v));
  return {
    ...p,
    moveX: x,
    moveZ: z,
    aimYaw: Math.atan2(Math.sin(p.aimYaw), Math.cos(p.aimYaw)),
    aimPitch: Math.max(-BARN_PITCH_LIMIT, Math.min(BARN_PITCH_LIMIT, p.aimPitch)),
    eyeX: eye(p.eyeX),
    eyeY: eye(p.eyeY),
    eyeZ: eye(p.eyeZ),
  };
}
/** 41 bytes: uint32 seq/round, eight float32 intent values, five edge/held bits. */
export const PROP_INPUT_BYTES = 41;
export function encodePropInput(p: PropInputPacket): Uint8Array {
  const bytes = new Uint8Array(PROP_INPUT_BYTES), v = new DataView(bytes.buffer);
  v.setUint32(0, p.seq, true); v.setUint32(4, p.round, true);
  [p.moveX, p.moveZ, p.aimYaw, p.aimPitch, p.eyeX, p.eyeY, p.eyeZ, p.viewTick].forEach((n, i) => v.setFloat32(8 + i * 4, n, true));
  bytes[40] = +p.jumpPressed | (+p.sprintHeld << 1) | (+p.attackPressed << 2) | (+p.pickupPressed << 3) | (+p.whistlePressed << 4);
  return bytes;
}
export function validatePropInput(value: unknown): PropInputPacket | null {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== PROP_INPUT_BYTES || (value[40] & ~31)) return null;
    const v = new DataView(value.buffer, value.byteOffset, value.byteLength), f = value[40];
    value = { seq: v.getUint32(0, true), round: v.getUint32(4, true), moveX: v.getFloat32(8, true), moveZ: v.getFloat32(12, true),
      aimYaw: v.getFloat32(16, true), aimPitch: v.getFloat32(20, true), eyeX: v.getFloat32(24, true), eyeY: v.getFloat32(28, true), eyeZ: v.getFloat32(32, true), viewTick: v.getFloat32(36, true),
      jumpPressed: !!(f & 1), sprintHeld: !!(f & 2), attackPressed: !!(f & 4), pickupPressed: !!(f & 8), whistlePressed: !!(f & 16), attackHeld: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { whistlePressed, ...rest } = value as PropInputPacket;
  if (typeof whistlePressed !== "boolean") return null;
  const p = validateBarnInput(rest);
  return p && !p.attackHeld ? { ...p, whistlePressed } : null;
}
const layerKeys = ["seq", "round", "moveX", "moveZ", "jumpPressed", "sprintHeld", "punchPressed"];
/** Strict keys, finite numbers, booleans; movement normalised (`normalizeMove`). */
export function validateLayerInput(value: unknown): LayerInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as LayerInputPacket;
  if (Object.keys(p).length !== layerKeys.length || Object.keys(p).some((k) => !layerKeys.includes(k))) return null;
  if (!Number.isSafeInteger(p.seq) || p.seq < 0 || !Number.isSafeInteger(p.round) || p.round < 1) return null;
  if (![p.moveX, p.moveZ].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (![p.jumpPressed, p.sprintHeld, p.punchPressed].every((v) => typeof v === "boolean")) return null;
  const move = normalizeMove(p.moveX, p.moveZ);
  return { ...p, moveX: move.x, moveZ: move.z };
}
const bombKeys = [...layerKeys, "viewTick"];
export function validateBombInput(value: unknown): BombInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as BombInputPacket;
  if (Object.keys(p).length !== bombKeys.length || Object.keys(p).some((k) => !bombKeys.includes(k))) return null;
  if (!Number.isSafeInteger(p.viewTick) || p.viewTick < 0) return null;
  const { viewTick: _, ...layer } = p;
  const valid = validateLayerInput(layer);
  return valid ? { ...valid, viewTick: p.viewTick } : null;
}
export const neutralIntent = (): MovementInput => ({
  x: 0,
  z: 0,
  jump: false,
  punch: false,
  grab: false,
  lift: false,
});
/** Per-session mailbox: sequence high-water mark survives stale/reset/reconnect. */
export class InputMailbox {
  seq = -1;
  processedSeq = -1;
  processedRound = -1;
  processedPunchSeq = -1;
  private punchSeq = -1;
  private received = -Infinity;
  private packet: InputPacket | null = null;
  private jump = false;
  private punch = false;
  // Barn: the latest barn packet and its edges (a round is one mode; `accept` picks the validator).
  private barnPacket: BarnInputPacket | null = null;
  private pickup = false;
  private whistle = false;
  private propPacket: PropInputPacket | null = null;
  private attackViewTick = -1;
  // Katman Kaosu and Renk Kaosu: the latest shove-mode packet (its edges share `jump` / `punch`).
  private layerPacket: LayerInputPacket | null = null;
  private bombPacket: BombInputPacket | null = null;
  accept(value: unknown, round: number, now: number, mode: GameMode = "rooftop_brawl") {
    if (mode === "prop_hunt") {
      const p = validatePropInput(value);
      if (!p || p.round !== round || p.seq <= this.seq) return false;
      const edge = p.whistlePressed && !this.propPacket?.whistlePressed;
      const { whistlePressed: _, ...barn } = p;
      if (!this.acceptBarn(barn, round, now)) return false;
      this.whistle ||= edge;
      this.propPacket = p;
      return true;
    }
    if (mode === "barn_shootout") return this.acceptBarn(value, round, now);
    if (mode === "bomb_tag") return this.acceptBomb(value, round, now);
    if (mode === "layer_chaos" || mode === "color_chaos") return this.acceptLayer(value, round, now);
    const p = validateInput(value);
    // Transport limits traffic; valid ordered packets may arrive together after network jitter.
    if (!p || p.round !== round || p.seq <= this.seq) return false;
    this.seq = p.seq;
    this.jump ||= p.jumpPressed && !this.packet?.jumpPressed;
    if (p.punchPressed && !this.packet?.punchPressed && !this.punch) {
      this.punch = true;
      this.punchSeq = p.seq;
    }
    this.packet = p;
    this.barnPacket = null;
    this.layerPacket = null;
    this.bombPacket = null;
    this.received = now;
    return true;
  }
  private acceptBomb(value: unknown, round: number, now: number) {
    const p = validateBombInput(value);
    if (!p || p.round !== round || p.seq <= this.seq) return false;
    this.seq = p.seq;
    const last = this.bombPacket;
    this.jump ||= p.jumpPressed && !last?.jumpPressed;
    if (p.punchPressed && !last?.punchPressed && !this.punch) {
      this.punch = true;
      this.punchSeq = p.seq;
      this.attackViewTick = p.viewTick;
    }
    this.bombPacket = p;
    this.packet = null;
    this.barnPacket = null;
    this.layerPacket = null;
    this.received = now;
    return true;
  }
  private acceptLayer(value: unknown, round: number, now: number) {
    const p = validateLayerInput(value);
    if (!p || p.round !== round || p.seq <= this.seq) return false;
    this.seq = p.seq;
    const last = this.layerPacket;
    this.jump ||= p.jumpPressed && !last?.jumpPressed;
    // The punch edge keeps the sequence of the packet that carried it (swing echo dedupe).
    if (p.punchPressed && !last?.punchPressed && !this.punch) {
      this.punch = true;
      this.punchSeq = p.seq;
    }
    this.layerPacket = p;
    this.packet = null;
    this.barnPacket = null;
    this.bombPacket = null;
    this.received = now;
    return true;
  }
  private acceptBarn(value: unknown, round: number, now: number) {
    const p = validateBarnInput(value);
    if (!p || p.round !== round || p.seq <= this.seq) return false;
    this.seq = p.seq;
    const last = this.barnPacket;
    this.jump ||= p.jumpPressed && !last?.jumpPressed;
    this.pickup ||= p.pickupPressed && !last?.pickupPressed;
    // The attack edge keeps the sequence and view of the packet that carried it.
    if (p.attackPressed && !last?.attackPressed && !this.punch) {
      this.punch = true;
      this.punchSeq = p.seq;
      this.attackViewTick = p.viewTick;
    }
    this.barnPacket = p;
    this.packet = null;
    this.layerPacket = null;
    this.bombPacket = null;
    this.received = now;
    return true;
  }
  read(now: number): MovementInput {
    if (now - this.received > NET.staleMs) this.clear();
    const b = this.barnPacket;
    if (b) {
      const intent = this.readBarn(b);
      if (this.propPacket) intent.whistle = this.whistle;
      this.whistle = false;
      return intent;
    }
    const bomb = this.bombPacket;
    if (bomb) return this.readBomb(bomb);
    const l = this.layerPacket;
    if (l) return this.readLayer(l);
    const p = this.packet;
    if (p) {
      this.processedSeq = this.seq;
      this.processedRound = p.round;
    }
    this.processedPunchSeq = this.punch ? this.punchSeq : -1;
    const result = p
      ? {
          x: p.moveX,
          z: p.moveZ,
          jump: this.jump,
          punch: this.punch,
          grab: p.grabHeld,
          lift: p.liftHeld,
        }
      : neutralIntent();
    this.jump = this.punch = false;
    return result;
  }
  private readBomb(p: BombInputPacket): MovementInput {
    this.processedSeq = this.seq;
    this.processedRound = p.round;
    this.processedPunchSeq = this.punch ? this.punchSeq : -1;
    const result: MovementInput = {
      x: p.moveX,
      z: p.moveZ,
      jump: this.jump,
      punch: this.punch,
      sprint: p.sprintHeld,
      viewTick: this.punch ? this.attackViewTick : p.viewTick,
    };
    this.jump = this.punch = false;
    return result;
  }
  private readLayer(p: LayerInputPacket): MovementInput {
    this.processedSeq = this.seq;
    this.processedRound = p.round;
    this.processedPunchSeq = this.punch ? this.punchSeq : -1;
    const result: MovementInput = { x: p.moveX, z: p.moveZ, jump: this.jump, punch: this.punch, sprint: p.sprintHeld };
    this.jump = this.punch = false;
    return result;
  }
  private readBarn(p: BarnInputPacket): MovementInput {
    this.processedSeq = this.seq;
    this.processedRound = p.round;
    const attack = this.punch;
    this.processedPunchSeq = attack ? this.punchSeq : this.seq;
    const result: MovementInput = {
      x: p.moveX,
      z: p.moveZ,
      jump: this.jump,
      sprint: p.sprintHeld,
      facing: p.aimYaw,
      aimPitch: p.aimPitch,
      aimEye: { x: p.eyeX, y: p.eyeY, z: p.eyeZ },
      attack,
      attackHeld: p.attackHeld,
      pickup: this.pickup,
      viewTick: attack ? this.attackViewTick : p.viewTick,
    };
    this.jump = this.punch = this.pickup = false;
    return result;
  }
  clear() {
    this.propPacket = null;
    this.whistle = false;
    this.packet = null;
    this.barnPacket = null;
    this.layerPacket = null;
    this.bombPacket = null;
    this.jump = this.punch = this.pickup = false;
    this.received = -Infinity;
    this.punchSeq = this.processedPunchSeq = -1;
    this.attackViewTick = -1;
  }
}
