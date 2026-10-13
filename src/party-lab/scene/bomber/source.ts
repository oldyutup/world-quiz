import { BOMBER as B, ticks } from "../../../../shared/party-lab/simulation/bomber/config";
import { CELLS, sectorAngle, sectorOf } from "../../../../shared/party-lab/simulation/bomber/arena";
import { BomberGame, type BomberInput } from "../../../../shared/party-lab/simulation/bomber/game";
import { BomberBot, BOMBER_BOT_NAMES, type BomberBotLevel } from "../../../../shared/party-lab/simulation/bomber/bots";
import { bomberSection, restoreBomber, wireBombs, type BomberWire } from "../../../../shared/party-lab/simulation/bomber/wire";
import type { BomberInputPacket } from "../../../../shared/party-lab/network/bomberInput";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { BufferedSnapshot, GameStream } from "../../network/gameStream";
import { InputHistory, PREDICTION_LIMITS } from "../../network/prediction/history";
import { RigCorrection } from "../../network/prediction/correction";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type CostumeId, type SelectableCostumeId } from "../visual/costumes";

const STEP = 1 / B.hz;
/** Walk and bomb, in screen axes (x right, z down the screen; length ≤ 1); `bomb`: pressed since the last frame. */
export interface BomberControls {
  x: number;
  z: number;
  bomb: boolean;
}
export const NO_CONTROLS: BomberControls = { x: 0, z: 0, bomb: false };
/** A bomb to draw: the server's, or this player's own before the server shows it. */
export interface DrawnBomb {
  key: string;
  owner: number;
  cell: number;
  /** Steps to go (fractional). */
  fuse: number;
}
/** One frame of the arena to show. */
export interface BomberFrame {
  wire: BomberWire;
  round: number;
  /** This player's lane (−1 watching). */
  self: number;
  /** The winning lane at results (−1 none or a draw). */
  winner: number;
  /** Where to draw each player now (own player predicted, the others a moment behind). */
  x: number[];
  z: number[];
  face: number[];
  alive: boolean[];
  /** Play steps to draw at (fractional): fuses, flames and the falling rings run on it. */
  step: number;
  bombs: DrawnBomb[];
  /** The view's turn: this player's start at the bottom of the screen. */
  yaw: number;
}
/** Where the arena comes from: the server (online) or a local game with bots. */
export interface BomberSource {
  frame(dt: number, controls: BomberControls, paused: boolean): BomberFrame | null;
}

/** The view's turn (radians about the vertical): `lane`'s start at the bottom of the screen. */
export const viewYaw = (spawns: readonly number[], lane: number) => sectorAngle(sectorOf(spawns[Math.max(0, lane)] ?? 0)) - Math.PI / 2;
/** Screen axes to arena axes for a view turned by `yaw` (W walks up the screen whichever way that is). */
export function toWorld(x: number, z: number, yaw: number) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return { x: x * c - z * s, z: x * s + z * c };
}
/** Arena axes to screen axes (the inverse turn). */
export const toScreen = (x: number, z: number, yaw: number) => toWorld(x, z, -yaw);

/**
 * The client's own player, predicted: a BomberGame restored from every snapshot, then this
 * player's inputs the server has not used yet walked again on it (bombs placed included),
 * with the leftover difference eased out. Everything else is the server's.
 */
export class BomberPrediction {
  readonly game: BomberGame;
  readonly history = new InputHistory();
  readonly correction = new RigCorrection(1);
  readonly metrics = { corrections: 0, hard: 0, maxError: 0, replaySteps: 0, overflows: 0 };
  active = false;
  private seq = -1;
  private ready = false;
  private shown = new Float32Array(7);
  private pose = new Float32Array(7);
  constructor(wire: BomberWire, readonly lane: number, readonly slot: number) {
    this.game = new BomberGame(wire.seats.length, () => 0.5, { players: wire.seats.length, cells: new Uint8Array(CELLS), spawns: [...wire.spawns], pockets: [] });
    restoreBomber(this.game, wire);
  }
  private capture() {
    const p = this.game.players[this.lane];
    this.pose.set([p.x, 0, p.z, 0, 0, 0, 1]);
    return this.pose;
  }
  reconcile(frame: BufferedSnapshot, now: number) {
    const s = frame.snapshot,
      w = s.bomber;
    if (!w || s.seq <= this.seq || this.lane < 0) return;
    this.seq = s.seq;
    const was = this.active;
    this.active = w.phase === "playing" && w.alive[this.lane] && !w.out[this.lane];
    const before = this.shown.slice();
    restoreBomber(this.game, w);
    this.history.acknowledge(s.ack[this.slot] ?? -1);
    if (this.history.records.some((r) => now - r.sentAt > PREDICTION_LIMITS.staleMs)) {
      this.history.clear();
      this.ready = false;
    }
    // Alive on the server now, so every input it has not used yet will walk this player: replay
    // them all (those sent before this client knew of the respawn too). The server already ran
    // `held` more steps on the last input it had: skip as many of ours (an input that arrived late
    // is usually followed by two at once, the older one never run).
    let held = w.held[this.lane] ?? 0;
    if (this.active)
      for (const r of this.history.records) {
        if (held-- > 0) continue;
        if ("bombs" in r.packet) this.run(r.packet as BomberInputPacket);
        this.metrics.replaySteps++;
      }
    // Back from the dead or just started: a jump, not something to blend.
    if (!this.active || !was) {
      this.correction.clear();
      this.ready = false;
    }
    if (this.ready) {
      const r = this.correction.begin(before, this.capture());
      this.metrics.maxError = Math.max(this.metrics.maxError, r.error);
      if (r.tier !== "none") this.metrics.corrections++;
      if (r.tier === "hard") this.metrics.hard++;
    }
  }
  private run(p: BomberInputPacket) {
    const g = this.game,
      me = g.players[this.lane];
    g.walkLane(this.lane, { x: p.moveX, z: p.moveZ, bombs: p.bombs });
    if (p.bombs > me.presses) {
      me.presses = p.bombs;
      g.place(this.lane);
    }
    g.updatePasses();
  }
  /** This frame's input: kept until the server has used it, and walked at once while alive. */
  step(packet: BomberInputPacket, now: number) {
    if (!this.history.add(packet, 1, now)) {
      this.metrics.overflows++;
      this.ready = false;
      return;
    }
    if (this.active) this.run(packet);
  }
  /** The own player's drawn position (x, z), the correction eased in. */
  visual(dt: number) {
    this.ready = true;
    const v = this.correction.apply(this.capture(), dt, this.shown);
    return { x: v[0], z: v[2] };
  }
}

export interface BomberOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/** Online: inputs go to the server at 60 a second; the arena shown is the server's, the own player predicted. */
export class OnlineBomberSource implements BomberSource {
  prediction: BomberPrediction | null = null;
  private acc = 0;
  private presses = 0;
  private faces: number[] = [];
  /** The arena refreshes `online` every render (the stream and sender it should use now). */
  constructor(public online: BomberOnline, readonly round: number, readonly self: number, readonly slot: number) {}
  frame(dt: number, controls: BomberControls, paused: boolean): BomberFrame | null {
    const { stream, sendInput } = this.online,
      latest = stream.snapshots.latest,
      wire = latest?.snapshot.bomber;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    const now = performance.now(),
      lane = this.self,
      yaw = viewYaw(wire.spawns, lane);
    if (lane >= 0) {
      this.prediction ??= new BomberPrediction(wire, lane, this.slot);
      this.prediction.reconcile(latest, now);
    }
    const prediction = this.prediction;
    const off = paused || lane < 0;
    if (!off && controls.bomb && prediction?.active) this.presses++;
    const world = off ? { x: 0, z: 0 } : toWorld(controls.x, controls.z, yaw);
    this.acc = dt > 0.25 ? 0 : Math.min(0.05, this.acc + dt);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (lane < 0) continue;
      const packet = sendInput({ x: 0, z: 0, jump: false, bomber: { seq: 0, round: this.round, moveX: world.x, moveZ: world.z, bombs: this.presses } });
      if (packet && "bombs" in packet) prediction?.step(packet, now);
    }
    // The others a moment behind, between two snapshots (a jump of over a metre is a respawn: no glide).
    const sample = stream.snapshots.sample(now),
      a = sample?.a.snapshot.bomber,
      b = sample?.b.snapshot.bomber,
      same = !!a && !!b && sample!.a.snapshot.round === this.round && sample!.b.snapshot.round === this.round;
    const x = [...wire.x],
      z = [...wire.z],
      alive = [...wire.alive];
    const face = wire.face.map((f, i) => this.faces[i] ?? f);
    if (same && a && b)
      wire.seats.forEach((_, i) => {
        if (i === lane) return;
        const t = sample!.alpha,
          jump = Math.hypot(b.x[i] - a.x[i], b.z[i] - a.z[i]) > 1;
        x[i] = jump ? b.x[i] : a.x[i] + (b.x[i] - a.x[i]) * t;
        z[i] = jump ? b.z[i] : a.z[i] + (b.z[i] - a.z[i]) * t;
        face[i] = b.face[i];
        alive[i] = b.alive[i] && a.alive[i];
      });
    if (prediction?.active) {
      const v = prediction.visual(Math.min(0.1, dt)),
        me = prediction.game.players[lane];
      x[lane] = v.x;
      z[lane] = v.z;
      face[lane] = me.face;
    }
    this.faces = face;
    const since = wire.phase === "playing" ? Math.min(6, (now - latest.received) / (1000 * STEP)) : 0;
    const bombs: DrawnBomb[] = wireBombs(wire).map((bomb) => ({ key: `s${bomb.id}`, owner: bomb.owner, cell: bomb.cell, fuse: bomb.fuse - since }));
    if (prediction?.active)
      for (const bomb of prediction.game.bombs)
        if (bomb.owner === lane && !bombs.some((s) => s.cell === bomb.cell)) bombs.push({ key: `p${bomb.cell}`, owner: lane, cell: bomb.cell, fuse: ticks(B.fuse) });
    return { wire, round: this.round, self: lane, winner: wire.seats.indexOf(latest.snapshot.winner), x, z, face, alive, step: wire.step + since, bombs, yaw };
  }
}

/**
 * Yerel Test Arenası: the server's rules (BomberGame, a fresh arena) run here with the player in
 * lane 0 and bots in the others. It pauses while the menu is open.
 */
export class LocalBomber implements BomberSource {
  readonly game: BomberGame;
  readonly bots: BomberBot[];
  private acc = 0;
  private presses = 0;
  private before: { x: number; z: number }[];
  constructor(readonly players: number, level: BomberBotLevel, random: () => number = Math.random) {
    this.game = new BomberGame(players, random);
    this.bots = Array.from({ length: players - 1 }, (_, i) => new BomberBot(level, i + 1, random));
    this.before = this.game.players.map((p) => ({ x: p.x, z: p.z }));
  }
  frame(dt: number, controls: BomberControls, paused: boolean): BomberFrame {
    const g = this.game,
      yaw = viewYaw(g.layout.spawns, 0);
    if (!paused) {
      if (controls.bomb && g.phase === "playing" && g.players[0].alive) this.presses++;
      const world = toWorld(controls.x, controls.z, yaw),
        human: BomberInput = { ...world, bombs: this.presses };
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.before = g.players.map((p) => ({ x: p.x, z: p.z }));
        g.step([human, ...this.bots.map((bot) => bot.input(g))]);
      }
    }
    const wire = bomberSection(g, g.players.map((_, lane) => lane)),
      alpha = g.phase === "playing" ? this.acc / STEP : 1;
    const x = g.players.map((p, i) => (Math.hypot(p.x - this.before[i].x, p.z - this.before[i].z) > 1 ? p.x : this.before[i].x + (p.x - this.before[i].x) * alpha)),
      z = g.players.map((p, i) => (Math.hypot(p.x - this.before[i].x, p.z - this.before[i].z) > 1 ? p.z : this.before[i].z + (p.z - this.before[i].z) * alpha));
    return {
      wire,
      round: 1,
      self: 0,
      winner: g.winner(),
      x,
      z,
      face: g.players.map((p) => p.face),
      alive: g.players.map((p) => p.alive),
      step: g.ticks + (g.phase === "playing" ? alpha : 0),
      bombs: g.bombs.map((b) => ({ key: `l${b.id}`, owner: b.owner, cell: b.cell, fuse: b.fuse - (g.phase === "playing" ? alpha : 0) })),
      yaw,
    };
  }
}

/** How a lane looks: colour, costume, name. */
export interface BomberLook {
  color: string;
  costume: CostumeId;
  name: string;
}
/** A local arena for `players` (the player plus bots of `level`): its source and how everyone looks. */
export function localBomber(players: 2 | 3, level: BomberBotLevel, costume: SelectableCostumeId) {
  const source = new LocalBomber(players, level);
  const looks: BomberLook[] = source.game.players.map((_, lane) => ({
    color: PLAYERS[lane].color,
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : `${BOMBER_BOT_NAMES[level]} Bot${players > 2 ? ` ${lane}` : ""}`,
  }));
  const first = bomberSection(source.game, looks.map((_, lane) => lane));
  return { source, looks, first };
}
