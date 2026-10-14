import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";
import { DEATH_FADE, LIFE, TrailGame, onCentimetre, steer, trailAlpha, type TrailInput, type TrailLine } from "../../../../shared/party-lab/simulation/trails/game";
import { TrailBot, TRAIL_BOT_NAMES, type TrailBotLevel } from "../../../../shared/party-lab/simulation/trails/bots";
import { restoreTrails, trailSection, wireLines, type TrailWire } from "../../../../shared/party-lab/simulation/trails/wire";
import type { TrailInputPacket } from "../../../../shared/party-lab/network/trailInput";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { BufferedSnapshot, GameStream } from "../../network/gameStream";
import { InputHistory, PREDICTION_LIMITS } from "../../network/prediction/history";
import { RigCorrection } from "../../network/prediction/correction";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type CostumeId, type SelectableCostumeId } from "../visual/costumes";

const STEP = 1 / L.hz;
/** The direction keys held, as screen directions (each −1, 0 or 1; W is z −1). */
export type TrailControls = TrailInput;
export const NO_CONTROLS: TrailControls = { x: 0, z: 0 };
/** Keys from the keyboard's movement vector (any length): each axis −1, 0 or 1. */
export const keysOf = (x: number, z: number): TrailControls => ({ x: Math.abs(x) < 0.2 ? 0 : Math.sign(x), z: Math.abs(z) < 0.2 ? 0 : Math.sign(z) });

/** One unbroken stretch of trail to draw: points with their brightness (0…1). */
export interface TrailRun {
  x: number[];
  z: number[];
  alpha: number[];
}
/**
 * What of a trail can be seen at play step `step`, as unbroken runs: its points up to `until`
 * (older than their life cut off where they end, wiped pieces left out), then the head when
 * running. Brightness falls over each point's last second and with a dead player's trail.
 */
export function trailRuns(line: TrailLine, died: number, step: number, head: { x: number; z: number } | null, until = Infinity): TrailRun[] {
  if (died >= 0 && step >= died + DEATH_FADE) return [];
  const xs: number[] = [],
    zs: number[] = [],
    ts: number[] = [],
    cuts: boolean[] = [];
  for (let i = 0; i < line.x.length && line.t[i] <= until; i++) {
    xs.push(line.x[i]);
    zs.push(line.z[i]);
    ts.push(line.t[i]);
    cuts.push(line.cut[i]);
  }
  if (head && xs.length) {
    xs.push(head.x);
    zs.push(head.z);
    ts.push(Math.min(step, until));
    cuts.push(false);
  }
  const runs: TrailRun[] = [];
  let run: TrailRun | null = null;
  for (let i = 0; i + 1 < xs.length; i++) {
    const tb = ts[i + 1];
    if (tb + LIFE <= step || cuts[i]) {
      run = null;
      continue;
    }
    if (!run) {
      run = { x: [], z: [], alpha: [] };
      runs.push(run);
      let ax = xs[i],
        az = zs[i],
        ta = ts[i];
      // The tail: where the trail is exactly a life old.
      if (ta + LIFE <= step && tb > ta) {
        const f = (step - LIFE - ta) / (tb - ta);
        ax += (xs[i + 1] - ax) * f;
        az += (zs[i + 1] - az) * f;
        ta = step - LIFE;
      }
      run.x.push(ax);
      run.z.push(az);
      run.alpha.push(trailAlpha(ta, died, step));
    }
    run.x.push(xs[i + 1]);
    run.z.push(zs[i + 1]);
    run.alpha.push(trailAlpha(tb, died, step));
  }
  return runs;
}

/** One frame of the arena to show. */
export interface TrailFrame {
  wire: TrailWire;
  round: number;
  /** This player's lane (−1 watching). */
  self: number;
  /** The winning lane at results (−1 none or a draw). */
  winner: number;
  /** Where to draw each head now (own predicted, the others a moment behind) and its heading. */
  x: number[];
  z: number[];
  a: number[];
  alive: boolean[];
  /** Play step to draw at (fractional): the trails' fading, the train and the clock run on it. */
  step: number;
  /** Per lane, its trail as unbroken runs. */
  trails: TrailRun[][];
  /** The own head is up against something here (the prediction stopped; only the server decides). */
  blocked: boolean;
}
/** Where the arena comes from: the server (online) or a local game with bots. */
export interface TrailSource {
  frame(dt: number, controls: TrailControls, paused: boolean): TrailFrame | null;
}

/**
 * The client's own head, predicted: a TrailGame restored from every snapshot, then this
 * player's keys the server has not used yet run again on it (laying the same trail points the
 * server will), with the leftover difference eased out. When the run ahead touches something
 * the head stops there for the view; whether it died is only ever the server's call.
 */
export class TrailPrediction {
  readonly game: TrailGame;
  readonly history = new InputHistory();
  readonly correction = new RigCorrection(1);
  readonly metrics = { corrections: 0, hard: 0, maxError: 0, replaySteps: 0, overflows: 0, blocked: 0, recent: [] as { step: number; error: number }[] };
  active = false;
  /** The run ahead touched something (it stays put until the server says otherwise). */
  blocked = false;
  /** The predicted play step (the server's plus the inputs run since). */
  step = 0;
  private seq = -1;
  private ready = false;
  private shown = new Float32Array(7);
  private pose = new Float32Array(7);
  constructor(wire: TrailWire, readonly lane: number, readonly slot: number) {
    this.game = new TrailGame(wire.seats.length, () => 0.5, 0);
    restoreTrails(this.game, wire);
    this.step = wire.step;
  }
  private capture() {
    const p = this.game.players[this.lane];
    this.pose.set([p.x, 0, p.z, 0, 0, 0, 1]);
    return this.pose;
  }
  reconcile(frame: BufferedSnapshot, now: number) {
    const s = frame.snapshot,
      w = s.trail;
    if (!w || s.seq <= this.seq || this.lane < 0) return;
    this.seq = s.seq;
    const was = this.active;
    this.active = w.phase === "playing" && w.alive[this.lane] && !w.out[this.lane];
    const before = this.shown.slice();
    restoreTrails(this.game, w);
    this.step = w.step;
    this.blocked = false;
    this.history.acknowledge(s.ack[this.slot] ?? -1);
    if (this.history.records.some((r) => now - r.sentAt > PREDICTION_LIMITS.staleMs)) {
      this.history.clear();
      this.ready = false;
    }
    // Every input the server has not used yet runs this head on; the server already ran `held`
    // more steps on the last input it had, so skip as many of ours (Bombacı's rule).
    let held = w.held[this.lane] ?? 0;
    if (this.active)
      for (const r of this.history.records) {
        if (held-- > 0) continue;
        if ("dirX" in r.packet) this.run(r.packet as TrailInputPacket);
        this.metrics.replaySteps++;
      }
    if (!this.active || !was) {
      this.correction.clear();
      this.ready = false;
    }
    if (this.ready) {
      const r = this.correction.begin(before, this.capture());
      this.metrics.maxError = Math.max(this.metrics.maxError, r.error);
      if (r.tier !== "none") this.metrics.corrections++;
      // The latest noticeable ones (debugging: when they happen).
      if (r.error > 0.05) this.metrics.recent = [...this.metrics.recent.slice(-15), { step: w.step, error: Math.round(r.error * 1000) / 1000 }];
      if (r.tier === "hard") this.metrics.hard++;
    }
  }
  /** One step of this head, as the server will run it (the turn, the run, a trail point every few steps). */
  private run(p: TrailInputPacket) {
    const step = ++this.step;
    if (this.blocked) return;
    const g = this.game,
      me = g.players[this.lane],
      from = { x: me.x, z: me.z };
    steer(me, { x: p.dirX, z: p.dirZ }, step);
    const hit = g.hazard(this.lane, from, me, step);
    if (hit) {
      me.x = from.x + (me.x - from.x) * hit.f;
      me.z = from.z + (me.z - from.z) * hit.f;
      this.blocked = true;
      this.metrics.blocked++;
    }
    if (step % L.trailEvery === 0 || hit) {
      const line = g.lines[this.lane];
      line.x.push(onCentimetre(me.x));
      line.z.push(onCentimetre(me.z));
      line.t.push(step);
      line.cut.push(false);
    }
  }
  /**
   * A step with no input sent yet this round (just after BAŞLA, before the first packet goes):
   * the server runs the head straight on meanwhile, so the prediction does too (not kept: the
   * next snapshot has it).
   */
  coast() {
    if (this.active && !this.sent) this.run({ seq: -1, round: 0, dirX: 0, dirZ: 0 });
  }
  /** An input went to the server this round. */
  private sent = false;
  /** This frame's input: kept until the server has used it, and run at once while alive. */
  stepInput(packet: TrailInputPacket, now: number) {
    this.sent = true;
    if (!this.history.add(packet, 1, now)) {
      this.metrics.overflows++;
      this.ready = false;
      return;
    }
    if (this.active) this.run(packet);
  }
  /** The own head's drawn position (x, z), the correction eased in. */
  visual(dt: number) {
    this.ready = true;
    const v = this.correction.apply(this.capture(), dt, this.shown);
    return { x: v[0], z: v[2] };
  }
}

export interface TrailOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
/** Online: keys go to the server 60 times a second; the arena shown is the server's, the own head predicted. */
export class OnlineTrailSource implements TrailSource {
  prediction: TrailPrediction | null = null;
  private acc = 0;
  private decoded: { seq: number; lines: TrailLine[] } = { seq: -1, lines: [] };
  /** The arena refreshes `online` every render (the stream and sender it should use now). */
  constructor(public online: TrailOnline, readonly round: number, readonly self: number, readonly slot: number) {}
  frame(dt: number, controls: TrailControls, paused: boolean): TrailFrame | null {
    const { stream, sendInput } = this.online,
      latest = stream.snapshots.latest,
      wire = latest?.snapshot.trail;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    const now = performance.now(),
      lane = this.self;
    if (lane >= 0) {
      this.prediction ??= new TrailPrediction(wire, lane, this.slot);
      this.prediction.reconcile(latest, now);
    }
    const prediction = this.prediction,
      keys = paused || lane < 0 ? NO_CONTROLS : controls;
    this.acc = dt > 0.25 ? 0 : Math.min(0.05, this.acc + dt);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (lane < 0) continue;
      const packet = sendInput({ x: 0, z: 0, jump: false, trail: { seq: 0, round: this.round, dirX: keys.x, dirZ: keys.z } });
      if (packet && "dirX" in packet) prediction?.stepInput(packet, now);
      else prediction?.coast();
    }
    if (this.decoded.seq !== latest.snapshot.seq) this.decoded = { seq: latest.snapshot.seq, lines: wireLines(wire) };
    const lines = this.decoded.lines,
      playing = wire.phase === "playing",
      since = playing ? Math.min(6, (now - latest.received) / (1000 * STEP)) : 0,
      step = wire.step + since;
    // The others a moment behind, between two snapshots; their trails end where they are drawn.
    const sample = stream.snapshots.sample(now),
      a = sample?.a.snapshot.trail,
      b = sample?.b.snapshot.trail,
      same = !!a && !!b && sample!.a.snapshot.round === this.round && sample!.b.snapshot.round === this.round;
    const x = [...wire.x],
      z = [...wire.z],
      heading = [...wire.a],
      alive = wire.alive.map((v, i) => v && !wire.out[i]),
      shownAt = wire.seats.map(() => Infinity);
    if (same && a && b)
      wire.seats.forEach((_, i) => {
        // Still running where it is drawn: shown running (a crash shows once the drawing gets there).
        if (i === lane || !b.alive[i] || !a.alive[i] || b.out[i]) return;
        alive[i] = true;
        const t = sample!.alpha;
        x[i] = a.x[i] + (b.x[i] - a.x[i]) * t;
        z[i] = a.z[i] + (b.z[i] - a.z[i]) * t;
        heading[i] = lerpAngle(a.a[i], b.a[i], t);
        shownAt[i] = a.step + (b.step - a.step) * t;
      });
    const own = prediction?.active ? prediction : null;
    if (own) {
      const v = own.visual(Math.min(0.1, dt));
      x[lane] = v.x;
      z[lane] = v.z;
      heading[lane] = own.game.players[lane].a;
    }
    const trails = wire.seats.map((_, i) =>
      i === lane && own ? trailRuns(own.game.lines[lane], -1, Math.max(step, own.step), { x: x[i], z: z[i] }) : trailRuns(lines[i], alive[i] ? -1 : wire.died[i], step, alive[i] ? { x: x[i], z: z[i] } : null, shownAt[i])
    );
    return { wire, round: this.round, self: lane, winner: wire.seats.indexOf(latest.snapshot.winner), x, z, a: heading, alive, step, trails, blocked: !!own?.blocked };
  }
}

/**
 * Yerel Test Arenası: the server's rules (TrailGame, a fresh start ring) run here with the
 * player in lane 0 and bots in the others. It pauses while the menu is open.
 */
export class LocalTrails implements TrailSource {
  readonly game: TrailGame;
  readonly bots: TrailBot[];
  private acc = 0;
  private before: { x: number; z: number; a: number }[];
  constructor(readonly players: number, level: TrailBotLevel, random: () => number = Math.random) {
    this.game = new TrailGame(players, random);
    this.bots = Array.from({ length: players - 1 }, (_, i) => new TrailBot(level, i + 1, random));
    this.before = this.game.players.map((p) => ({ x: p.x, z: p.z, a: p.a }));
  }
  frame(dt: number, controls: TrailControls, paused: boolean): TrailFrame {
    const g = this.game;
    if (!paused) {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.before = g.players.map((p) => ({ x: p.x, z: p.z, a: p.a }));
        g.step([controls, ...this.bots.map((bot) => bot.input(g))]);
      }
    }
    const wire = trailSection(g, g.players.map((_, lane) => lane)),
      playing = g.phase === "playing",
      alpha = playing ? this.acc / STEP : 1,
      step = g.ticks + (playing ? alpha - 1 : 0);
    const alive = g.players.map((p) => p.alive && !p.out);
    const x = g.players.map((p, i) => (alive[i] ? this.before[i].x + (p.x - this.before[i].x) * alpha : p.x)),
      z = g.players.map((p, i) => (alive[i] ? this.before[i].z + (p.z - this.before[i].z) * alpha : p.z)),
      a = g.players.map((p, i) => (alive[i] ? lerpAngle(this.before[i].a, p.a, alpha) : p.a));
    const trails = g.players.map((p, i) => trailRuns(g.lines[i], p.died, Math.max(0, step), alive[i] ? { x: x[i], z: z[i] } : null, alive[i] ? Math.max(0, step) : Infinity));
    return { wire, round: 1, self: 0, winner: g.winner(), x, z, a, alive, step: Math.max(0, step), trails, blocked: false };
  }
}

/** How a lane looks: colour, costume, name. */
export interface TrailLook {
  color: string;
  costume: CostumeId;
  name: string;
}
/** A local arena for `players` (the player plus bots of `level`): its source and how everyone looks. */
export function localTrails(players: 2 | 3, level: TrailBotLevel, costume: SelectableCostumeId) {
  const source = new LocalTrails(players, level);
  const looks: TrailLook[] = source.game.players.map((_, lane) => ({
    color: PLAYERS[lane].color,
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : `${TRAIL_BOT_NAMES[level]} Bot${players > 2 ? ` ${lane}` : ""}`,
  }));
  return { source, looks };
}
