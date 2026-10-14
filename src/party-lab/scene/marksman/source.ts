import { MARKSMAN as M } from "../../../../shared/party-lab/simulation/marksman/config";
import { MarksmanGame, type MarksmanHit, type MarksmanShot } from "../../../../shared/party-lab/simulation/marksman/game";
import { BOMB, EMPTY, type SlotKind, type Wave } from "../../../../shared/party-lab/simulation/marksman/waves";
import { MarksmanBot, MARKSMAN_BOT_NAMES, type MarksmanBotLevel, type MarksmanBotView } from "../../../../shared/party-lab/simulation/marksman/bots";
import { marksmanSection, wireHits, wireWaves, type MarksmanWire } from "../../../../shared/party-lab/simulation/marksman/wire";
import type { MarksmanInputPacket } from "../../../../shared/party-lab/network/marksmanInput";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { GameStream } from "../../network/gameStream";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type CostumeId, type SelectableCostumeId } from "../visual/costumes";

/** A shot this player made that the server has not counted yet, with the outcome it should have. */
export interface PendingShot {
  /** Its number in the round (the server's `fired` reaching it confirms or refuses it). */
  n: number;
  at: number;
  aim: number;
  /** The hit it should make (null a miss). */
  hit: MarksmanHit | null;
}
/** One frame of the gallery to show. */
export interface MarksmanFrame {
  wire: MarksmanWire;
  /** The moment to draw, ms after BAŞLA (negative during the countdown). */
  now: number;
  /** The winning lane at results (−1 none or a draw). */
  winner: number;
  round: number;
  /** This player's lane (−1 watching), their aim on this screen and their shots not counted yet. */
  self: number;
  aim: number;
  pending: readonly PendingShot[];
  /** Every wave this screen has seen this round, by id (the wire carries only those around now). */
  waves: ReadonlyMap<number, Wave>;
}
/** Where the gallery comes from: the server (online) or a local game with bots. */
export interface MarksmanSource {
  frame(dt: number, paused: boolean): MarksmanFrame | null;
  /** The held keys' aim now. */
  aim(aim: number): void;
  /** A fire press now (performance.now()); true when it shot. */
  fire(now: number): boolean;
}
/** A player as drawn: colour, character, name. */
export interface MarksmanLook {
  color: string;
  costume: CostumeId;
  name: string;
}

/** The outcome a shot by `lane` at `at` with `aim` gets, given the hits it already has (null a miss). */
export function judge(waves: ReadonlyMap<number, Wave>, hits: readonly MarksmanHit[], at: number, aim: number): MarksmanHit | null {
  const slot = aim + 1;
  for (const [id, w] of waves) {
    if (at < w.open || at >= w.close) continue;
    const kind = w.kinds[slot];
    if (kind === EMPTY || hits.some((h) => h.wave === id && h.slot === slot)) return null;
    return { wave: id, slot, at, points: kind === BOMB ? M.points.bomb : at - w.open <= M.goodMs ? M.points.good : M.points.slow };
  }
  return null;
}
/** Can `lane` shoot at `t` (cooldown and stun aside): shooting, still in, within the time. */
export const canShoot = (wire: MarksmanWire, lane: number, t: number) => wire.phase === "shooting" && lane >= 0 && lane < wire.seats.length && !wire.out[lane] && t >= 0 && t < wire.limit * 1000;

/**
 * The client half of the aim (as Altın Madenci): a clock in ms after BAŞLA, and the shots it
 * stamps with it. BAŞLA on this clock is the earliest `received − shooting clock` seen: a
 * snapshot always arrives after it was sent, so this clock never leads the server's. A shot is
 * stamped on it with the aim held at that moment and judged here at once (drawn before the
 * server says so); the server judges it the same when it is at most `aimToleranceMs` old.
 */
export class MarksmanClient {
  private round = -1;
  private goAt = Infinity;
  private countdownGo = Infinity;
  /** Waves seen this round, by id. */
  readonly waves = new Map<number, Wave>();
  pending: PendingShot[] = [];
  aim = 0;
  private fired = 0;
  private recent: MarksmanShot[] = [];
  private stamp = -1e9;
  private dirty = false;
  private sentAt = -1e9;
  private wire: MarksmanWire | undefined;
  private lane = -1;
  observe(wire: MarksmanWire, round: number, received: number, lane: number) {
    if (round !== this.round) {
      this.round = round;
      this.goAt = this.countdownGo = Infinity;
      this.waves.clear();
      this.pending = [];
      this.fired = 0;
      this.recent = [];
      this.stamp = -1e9;
      this.dirty = this.aim !== 0;
    }
    this.wire = wire;
    this.lane = lane;
    if (wire.phase === "countdown") this.countdownGo = Math.min(this.countdownGo, received + wire.countdown * 1000);
    else this.goAt = Math.min(this.goAt, received - wire.elapsed);
    for (const w of wireWaves(wire)) if (!this.waves.has(w.id)) this.waves.set(w.id, { open: w.open, close: w.close, kinds: w.kinds });
    if (lane < 0) return;
    // A shot the server reached is counted (its hit is in the wire now) or refused.
    this.pending = wire.phase === "results" ? [] : this.pending.filter((p) => p.n > wire.fired[lane]);
    // Back after a drop: number on from the server's count; tell it the aim again.
    if (wire.fired[lane] > this.fired) this.fired = wire.fired[lane];
    if (wire.aim[lane] !== this.aim && received - this.sentAt > 400) this.dirty = true;
  }
  get started() {
    return Number.isFinite(this.goAt);
  }
  /** The shooting clock at `now` (performance.now()), ms after BAŞLA. */
  clock(now: number) {
    if (Number.isFinite(this.goAt)) return now - this.goAt;
    if (Number.isFinite(this.countdownGo)) return Math.min(0, now - this.countdownGo);
    return 0;
  }
  setAim(aim: number) {
    if (aim === this.aim) return;
    this.aim = aim;
    this.dirty = true;
  }
  /** This lane's hits as this screen knows them: the server's plus the ones not counted yet. */
  hits() {
    const wire = this.wire;
    return [...(wire && this.lane >= 0 ? wireHits(wire, this.lane) : []), ...this.pending.flatMap((p) => (p.hit ? [p.hit] : []))];
  }
  /** Stunned until (the server's word, or a bomb this screen just saw hit). */
  stunUntil() {
    const wire = this.wire;
    return Math.max(wire && this.lane >= 0 ? wire.stunUntil[this.lane] : 0, ...this.pending.map((p) => (p.hit && p.hit.points === M.points.bomb ? p.hit.at + M.stunMs : 0)));
  }
  /** A fire press at `now`: a shot (sent with the next flush) when the cooldown and the stun allow it. */
  fire(now: number) {
    const wire = this.wire,
      lane = this.lane;
    if (!wire || !this.started) return false;
    const t = this.clock(now);
    if (!canShoot(wire, lane, t) || t < this.stamp + M.cooldownMs || t < this.stunUntil()) return false;
    const hit = judge(this.waves, this.hits(), t, this.aim);
    this.pending.push({ n: ++this.fired, at: t, aim: this.aim, hit });
    this.recent = [...this.recent, { at: t, aim: this.aim }].slice(-M.recentShots);
    this.stamp = t;
    this.dirty = true;
    return true;
  }
  /** Sends the aim and the latest shots when something changed; a refused send is tried again next frame. */
  flush(send: (packet: { aim: number; fired: number; shots: number[] }) => boolean, now: number) {
    if (!this.dirty || !this.started && !Number.isFinite(this.countdownGo)) return;
    if (send({ aim: this.aim, fired: this.fired, shots: this.recent.flatMap((s) => [s.at, s.aim]) })) {
      this.dirty = false;
      this.sentAt = now;
    }
  }
}

/** The moment to draw: results freeze the gallery. */
export const drawTime = (wire: MarksmanWire, t: number) => (wire.phase === "results" ? wire.elapsed : wire.phase === "countdown" ? Math.min(0, t) : Math.min(t, wire.limit * 1000 + M.aimToleranceMs + 100));

export interface MarksmanOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/** Online: shots go to the server stamped with their aim; the gallery shown is the server's, with this player's own shots at once. */
export class OnlineMarksmanSource implements MarksmanSource {
  readonly client = new MarksmanClient();
  /** The arena refreshes this every render (the stream and sender it should use now). */
  constructor(public online: MarksmanOnline, readonly round: number, readonly self: number) {}
  frame(): MarksmanFrame | null {
    const latest = this.online.stream.snapshots.latest,
      wire = latest?.snapshot.marksman;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    const c = this.client;
    c.observe(wire, this.round, latest.received, this.self);
    const wall = performance.now();
    if (this.self >= 0) c.flush((p) => !!this.online.sendInput({ x: 0, z: 0, jump: false, marksman: { seq: 0, round: this.round, ...p } satisfies MarksmanInputPacket }), wall);
    return { wire, now: drawTime(wire, c.clock(wall)), winner: wire.seats.indexOf(latest.snapshot.winner), round: this.round, self: this.self, aim: c.aim, pending: c.pending, waves: c.waves };
  }
  aim(aim: number) {
    this.client.setAim(aim);
  }
  fire(now: number) {
    return this.self >= 0 && this.client.fire(now);
  }
}

const STEP = 1 / M.hz;
/**
 * Yerel Test Arenası: the server's rules (MarksmanGame) run here, with the player in lane 0 and
 * bots that really play in the others. It pauses while the menu is open.
 */
export class LocalMarksman implements MarksmanSource {
  readonly game: MarksmanGame;
  readonly bots: MarksmanBot[];
  private acc = 0;
  private aim_ = 0;
  private fired = 0;
  private recent: MarksmanShot[] = [];
  private stamp = -1e9;
  private botShots: { fired: number; recent: MarksmanShot[] }[];
  private readonly waves: Map<number, Wave>;
  constructor(readonly lanes: number, level: MarksmanBotLevel, random: () => number = Math.random) {
    this.game = new MarksmanGame(lanes, random);
    this.bots = Array.from({ length: lanes - 1 }, () => new MarksmanBot(level, random));
    this.botShots = this.bots.map(() => ({ fired: 0, recent: [] }));
    this.waves = new Map(this.game.waves.map((w, id) => [id, w]));
  }
  /** The shooting clock now (between steps), ms after BAŞLA; negative in the countdown. */
  get now() {
    const g = this.game;
    return g.phase === "countdown" ? -(g.countdownTicks * 1000) / M.hz + this.acc * 1000 : g.elapsedMs + (g.phase === "shooting" ? this.acc * 1000 : 0);
  }
  private step() {
    const g = this.game,
      due = g.elapsedMs + 1000 / M.hz;
    const volleys = [{ aim: this.aim_, fired: this.fired, shots: this.recent }];
    this.bots.forEach((bot, i) => {
      const lane = i + 1,
        l = g.lanes[lane],
        mine = this.botShots[i];
      const view: MarksmanBotView = {
        playing: g.phase === "shooting" && !l.out,
        waves: g.waves.flatMap((wave, id) => (wave.open <= due ? [{ id, wave }] : [])),
        stunUntil: l.stunUntil,
      };
      for (const shot of bot.next(view, due)) {
        mine.fired++;
        mine.recent = [...mine.recent, shot].slice(-M.recentShots);
      }
      volleys.push({ aim: bot.aim(due), fired: mine.fired, shots: mine.recent });
    });
    g.step(volleys);
  }
  frame(dt: number, paused: boolean): MarksmanFrame {
    if (!paused) {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.step();
      }
    }
    const wire = marksmanSection(this.game, this.game.lanes.map((_, lane) => lane));
    return { wire, now: this.game.phase === "results" ? wire.elapsed : this.now, winner: this.game.winner(), round: 1, self: 0, aim: this.aim_, pending: [], waves: this.waves };
  }
  aim(aim: number) {
    this.aim_ = aim;
  }
  fire() {
    const t = this.now,
      l = this.game.lanes[0];
    const wire = marksmanSection(this.game, this.game.lanes.map((_, lane) => lane));
    if (!canShoot(wire, 0, t) || t < this.stamp + M.cooldownMs || t < l.stunUntil) return false;
    this.fired++;
    this.recent = [...this.recent, { at: t, aim: this.aim_ }].slice(-M.recentShots);
    this.stamp = t;
    return true;
  }
}

/** A local round for `players` (the player plus bots of `level`): its source and the looks. */
export function localMarksman(players: 2 | 3, level: MarksmanBotLevel, costume: SelectableCostumeId) {
  const source = new LocalMarksman(players, level);
  const looks: MarksmanLook[] = source.game.lanes.map((_, lane) => ({
    color: PLAYERS[lane].color,
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : `${MARKSMAN_BOT_NAMES[level]} Bot${players > 2 ? ` ${lane}` : ""}`,
  }));
  return { source, looks };
}

/** One slot of one lane as drawn at the frame's moment. */
export interface SlotView {
  /** The wave in it (its id), what it holds and when it opens and closes; null when nothing is there. */
  wave: number;
  kind: SlotKind;
  open: number;
  close: number;
  /** This lane's hit on it (null while standing). */
  hit: MarksmanHit | null;
}
/** One lane as drawn. */
export interface LaneView {
  slots: (SlotView | null)[];
  aim: number;
  score: number;
  /** Stunned until (ms after BAŞLA). */
  stunUntil: number;
  /** The last shot (its moment and aim) for the muzzle flash; −1e9 none. */
  shotAt: number;
  shotAim: number;
  hits: MarksmanHit[];
}
/** Slots drawn this long after their wave closed (the target goes down). */
export const LOWER_MS = 220;
/** Every lane at the frame's moment: the server's state, with this player's own shots at once. */
export function laneViews(frame: MarksmanFrame): LaneView[] {
  const { wire, now: t, self, pending } = frame;
  // The wave in the slots now: the latest one opened (still showing while it goes down).
  let current = -1;
  for (const [id, w] of frame.waves) if (w.open <= t && t < w.close + LOWER_MS && (current < 0 || w.open > frame.waves.get(current)!.open)) current = id;
  const wave = current >= 0 ? frame.waves.get(current)! : null;
  return wire.seats.map((_, lane) => {
    const own = lane === self && wire.phase !== "results" ? pending : [];
    const hits = [...wireHits(wire, lane), ...own.flatMap((p) => (p.hit ? [p.hit] : []))];
    const last = own[own.length - 1];
    const slots = [0, 1, 2].map((slot): SlotView | null =>
      wave && wave.kinds[slot] !== EMPTY ? { wave: current, kind: wave.kinds[slot], open: wave.open, close: wave.close, hit: hits.find((h) => h.wave === current && h.slot === slot) ?? null } : null
    );
    return {
      slots,
      aim: lane === self ? frame.aim : wire.aim[lane],
      score: wire.score[lane] + own.reduce((sum, p) => sum + (p.hit?.points ?? 0), 0),
      stunUntil: Math.max(wire.stunUntil[lane], ...own.map((p) => (p.hit?.points === M.points.bomb ? p.hit.at + M.stunMs : 0))),
      shotAt: last ? last.at : wire.shotAt[lane],
      shotAim: last ? last.aim : wire.shotAim[lane],
      hits,
    };
  });
}

/** What the autopilot bot sees of `lane` in a frame. */
export function botView(frame: MarksmanFrame, lane: number): MarksmanBotView {
  const { wire } = frame;
  return {
    playing: wire.phase === "shooting" && !wire.out[lane],
    waves: [...frame.waves].flatMap(([id, wave]) => (wave.open <= frame.now ? [{ id, wave }] : [])),
    stunUntil: laneViews(frame)[lane]?.stunUntil ?? 0,
  };
}
/** Seconds of shooting left at `t`. */
export const timeLeft = (wire: MarksmanWire, t: number) => Math.max(0, wire.limit - Math.max(0, t) / 1000);
