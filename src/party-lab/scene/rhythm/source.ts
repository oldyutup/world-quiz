import { RHYTHM as R } from "../../../../shared/party-lab/simulation/rhythm/config";
import { RhythmGame, comboOf, gradePoints, judgePress, MISS, type Grade, type RhythmPress } from "../../../../shared/party-lab/simulation/rhythm/game";
import { chartHash, composeSong, RHYTHM_STYLES, type RhythmStyle, type Song } from "../../../../shared/party-lab/simulation/rhythm/song";
import { RhythmBot, RHYTHM_BOT_NAMES, type RhythmBotLevel } from "../../../../shared/party-lab/simulation/rhythm/bots";
import { rhythmSection, wireResults, wireStrays, type RhythmWire } from "../../../../shared/party-lab/simulation/rhythm/wire";
import type { RhythmInputPacket } from "../../../../shared/party-lab/network/rhythmInput";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { GameStream } from "../../network/gameStream";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type CostumeId, type SelectableCostumeId } from "../visual/costumes";

/** A note's result as this screen knows it. */
export interface Known {
  grade: Grade;
  at: number;
}
/** What a press did on this screen at once: a note hit or lost (`note` ≥ 0), or a stray press (note −1, grade null). */
export interface PressOutcome {
  note: number;
  grade: Grade | null;
  at: number;
}
/** A press of this player the server has not counted yet, with the outcome it should have. */
export interface PendingPress extends PressOutcome {
  /** Its number in the round (the server's `pressed` reaching it confirms it). */
  n: number;
  key: number;
}
/** One lane as drawn: every note's result known here, the stray presses, and the numbers. */
export interface RhythmLaneView {
  results: ReadonlyMap<number, Known>;
  strays: readonly number[];
  score: number;
  combo: number;
  maxCombo: number;
}
/** One frame to show. */
export interface RhythmFrame {
  wire: RhythmWire;
  song: Song;
  /** The moment to draw, ms after BAŞLA (negative during the countdown). */
  now: number;
  /** The winning lane at results (−1 none or a draw). */
  winner: number;
  round: number;
  /** This player's lane (−1 watching). */
  self: number;
  lanes: RhythmLaneView[];
  /** This page composed another song than the server's (another build): it cannot play this round. */
  mismatch: boolean;
}
/** Where the round comes from: the server (online) or a local game with bots. */
export interface RhythmSource {
  frame(dt: number, paused: boolean): RhythmFrame | null;
  /** A press of `key` at `wall` (performance.now() time); what it did, at once (undefined: not counted). */
  press(wall: number, key: number): PressOutcome | undefined;
  /** The game clock at `wall` (ms after BAŞLA), null before it is known. */
  clock(wall: number): number | null;
}
/** A player as drawn: colour, character, name. */
export interface RhythmLook {
  color: string;
  costume: CostumeId;
  name: string;
}

/**
 * The lanes as drawn at `now`. `own` lanes (this player's online; every lane locally, where all
 * presses are known at once) also show a note as missed the moment its window is over, before
 * the server calls it; their combo and score are worked out here from what this screen knows.
 * The others show the server's word.
 */
export function viewLanes(song: Song, wire: RhythmWire, now: number, known: readonly ReadonlyMap<number, Known>[], strays: readonly (readonly number[])[], pending: readonly PendingPress[], self: number, own: (lane: number) => boolean): RhythmLaneView[] {
  return wire.seats.map((_, lane) => {
    const results = new Map(known[lane] ?? []),
      seen = [...(strays[lane] ?? [])];
    if (!own(lane)) return { results, strays: seen, score: wire.score[lane], combo: wire.combo[lane], maxCombo: wire.maxCombo[lane] };
    let extra = 0;
    if (lane === self)
      for (const p of pending) {
        if (p.note < 0) seen.push(p.at);
        else if (!results.has(p.note)) {
          results.set(p.note, { grade: p.grade!, at: p.at });
          extra += gradePoints(p.grade!);
        }
      }
    if (wire.phase === "playing" && !wire.out[lane]) {
      const reach = now - R.windows.good;
      for (let i = 0; i < song.notes.length && song.notes[i].t < reach; i++) if (!results.has(i)) results.set(i, { grade: MISS, at: song.notes[i].t + R.windows.good });
    }
    const c = comboOf(results.values(), seen);
    return { results, strays: seen, score: wire.score[lane] + extra, combo: c.combo, maxCombo: Math.max(c.max, wire.maxCombo[lane]) };
  });
}

/** The song a section names (composed once per round and kept). */
const songOf = (wire: RhythmWire, current: Song | null) => {
  const style = RHYTHM_STYLES[wire.style];
  return current && current.style === style && current.seed === wire.seed ? current : composeSong(style, wire.seed);
};

/**
 * The client half (as Nişancı): a clock in ms after BAŞLA, and the presses it stamps with it.
 * BAŞLA on this clock is the earliest `received − playing clock` seen: a snapshot always arrives
 * after it was sent, so this clock never leads the server's. A press is stamped on it (the
 * moment its note was on this screen) and judged here at once; the server judges it the same
 * when it is at most `toleranceMs` old.
 */
export class RhythmClient {
  private round = -1;
  private goAt = Infinity;
  private countdownGo = Infinity;
  song: Song | null = null;
  /** The composed song is not the server's (its chart fingerprint differs): no press counts. */
  mismatch = false;
  /** Results and stray presses this screen has learnt, per lane. */
  known: Map<number, Known>[] = [];
  strays: number[][] = [];
  pending: PendingPress[] = [];
  private pressed = 0;
  private recent: RhythmPress[] = [];
  private dirty = false;
  private wire: RhythmWire | undefined;
  private lane = -1;
  observe(wire: RhythmWire, round: number, received: number, lane: number) {
    if (round !== this.round) {
      this.round = round;
      this.goAt = this.countdownGo = Infinity;
      this.known = [];
      this.strays = [];
      this.pending = [];
      this.pressed = 0;
      this.recent = [];
      this.dirty = false;
    }
    this.wire = wire;
    this.lane = lane;
    const song = songOf(wire, this.song);
    if (song !== this.song) {
      this.song = song;
      this.mismatch = chartHash(song.notes) !== wire.chart;
      if (this.mismatch) console.error("Ritim Ustası: this page composes another song than the server (reload the page)");
    }
    if (wire.phase === "countdown") this.countdownGo = Math.min(this.countdownGo, received + wire.countdown * 1000);
    else this.goAt = Math.min(this.goAt, received - wire.elapsed);
    wire.seats.forEach((_, l) => {
      const known = (this.known[l] ??= new Map()),
        strays = (this.strays[l] ??= []);
      for (const r of wireResults(wire, l)) known.set(r.note, { grade: r.grade, at: r.at });
      for (const at of wireStrays(wire, l)) if (!strays.includes(at)) strays.push(at);
      // Old stray presses are of no use to the view (the combo keeps the latest ones that matter).
      if (strays.length > 64) strays.splice(0, strays.length - 64);
    });
    if (lane < 0) return;
    // A press the server reached is counted: its result is in the section now.
    this.pending = wire.phase === "results" ? [] : this.pending.filter((p) => p.n > wire.pressed[lane]);
    // Back after a drop: number on from the server's count.
    if (wire.pressed[lane] > this.pressed) this.pressed = wire.pressed[lane];
  }
  get started() {
    return Number.isFinite(this.goAt);
  }
  /** The playing clock at `now` (performance.now()), ms after BAŞLA. */
  clock(now: number) {
    if (Number.isFinite(this.goAt)) return now - this.goAt;
    if (Number.isFinite(this.countdownGo)) return Math.min(0, now - this.countdownGo);
    return null;
  }
  /** A press at `now`: stamped, judged here, sent with the next flush. */
  press(now: number, key: number): PressOutcome | undefined {
    const wire = this.wire,
      lane = this.lane,
      song = this.song;
    if (!wire || !song || this.mismatch || !this.started || wire.phase !== "playing" || lane < 0 || wire.out[lane]) return undefined;
    const t = this.clock(now)!;
    if (t < 0 || t >= wire.limit * 1000) return undefined;
    const known = this.known[lane] ?? new Map<number, Known>();
    const hit = judgePress(song.notes, (i) => known.has(i) || this.pending.some((p) => p.note === i), t, key);
    const outcome: PressOutcome = { note: hit?.note ?? -1, grade: hit?.grade ?? null, at: t };
    this.pending.push({ ...outcome, n: ++this.pressed, key });
    this.recent = [...this.recent, { at: t, key }].slice(-R.recentPresses);
    this.dirty = true;
    return outcome;
  }
  /** Sends the latest presses when there is a new one; a refused send is tried again next frame. */
  flush(send: (packet: { pressed: number; presses: number[] }) => boolean) {
    if (!this.dirty) return;
    if (send({ pressed: this.pressed, presses: this.recent.flatMap((p) => [p.at, p.key]) })) this.dirty = false;
  }
}

/** The moment to draw: results freeze the lanes. */
export const drawTime = (wire: RhythmWire, t: number) => (wire.phase === "results" ? wire.elapsed : wire.phase === "countdown" ? Math.min(0, t) : Math.min(t, wire.limit * 1000));

export interface RhythmOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/** Online: presses go to the server stamped; the lanes shown are the server's, with this player's own presses at once. */
export class OnlineRhythmSource implements RhythmSource {
  readonly client = new RhythmClient();
  /** The arena refreshes this every render (the stream and sender it should use now). */
  constructor(public online: RhythmOnline, readonly round: number, readonly self: number) {}
  private send() {
    if (this.self >= 0) this.client.flush((p) => !!this.online.sendInput({ x: 0, z: 0, jump: false, rhythm: { seq: 0, round: this.round, ...p } satisfies RhythmInputPacket }));
  }
  frame(): RhythmFrame | null {
    const latest = this.online.stream.snapshots.latest,
      wire = latest?.snapshot.rhythm;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    const c = this.client;
    c.observe(wire, this.round, latest.received, this.self);
    this.send();
    const song = c.song!,
      now = drawTime(wire, c.clock(performance.now()) ?? -R.countdown * 1000);
    return {
      wire,
      song,
      now,
      winner: wire.seats.indexOf(latest.snapshot.winner),
      round: this.round,
      self: this.self,
      lanes: viewLanes(song, wire, now, c.known, c.strays, c.pending, this.self, (lane) => lane === this.self),
      mismatch: c.mismatch,
    };
  }
  press(wall: number, key: number) {
    if (this.self < 0) return undefined;
    const outcome = this.client.press(wall, key);
    // At once: the others see the hit as soon as possible (the next frame would add up to 16 ms).
    if (outcome) this.send();
    return outcome;
  }
  clock(wall: number) {
    return this.client.clock(wall);
  }
}

const MS = 1000 / R.hz;
/**
 * Yerel Test Arenası: the server's rules (RhythmGame) run here on the page's clock, with the
 * player in lane 0 and bots that really play in the others. It pauses while the menu is open
 * (the clock stops with it).
 */
export class LocalRhythm implements RhythmSource {
  readonly game: RhythmGame;
  readonly bots: RhythmBot[];
  private origin: number | null = null;
  private pausedAt: number | null = null;
  private botSent: { pressed: number; recent: RhythmPress[] }[];
  constructor(readonly lanes: number, level: RhythmBotLevel, style: RhythmStyle, random: () => number = Math.random) {
    this.game = new RhythmGame(lanes, random, composeSong(style, Math.floor(random() * 2 ** 32)));
    this.bots = Array.from({ length: lanes - 1 }, () => new RhythmBot(level, random));
    this.botSent = this.bots.map(() => ({ pressed: 0, recent: [] }));
  }
  /** The game's own moment: its countdown or its playing clock. */
  private get simTime() {
    const g = this.game;
    return g.phase === "countdown" ? -g.countdownTicks * MS : g.elapsedMs;
  }
  clock(wall: number) {
    if (this.origin === null) return -R.countdown * 1000;
    return (this.pausedAt ?? wall) - this.origin - R.countdown * 1000;
  }
  private step() {
    const g = this.game,
      due = g.elapsedMs + MS;
    const volleys = [undefined, ...this.bots.map((bot, i) => {
      const mine = this.botSent[i];
      for (const p of bot.next(g.notes, due, g.phase === "playing" && !g.lanes[i + 1].out)) {
        mine.pressed++;
        mine.recent = [...mine.recent, p].slice(-R.recentPresses);
      }
      return { pressed: mine.pressed, presses: mine.recent };
    })];
    g.step(volleys);
  }
  frame(_dt: number, paused: boolean): RhythmFrame {
    const wall = performance.now();
    if (this.origin === null) this.origin = wall;
    if (paused && this.pausedAt === null) this.pausedAt = wall;
    if (!paused && this.pausedAt !== null) {
      this.origin += wall - this.pausedAt;
      this.pausedAt = null;
    }
    const target = this.clock(wall);
    // Catch up (a long stall is skipped rather than replayed in one go).
    for (let n = 0; this.game.phase !== "results" && this.simTime + MS <= target && n < 30; n++) this.step();
    const g = this.game,
      wire = rhythmSection(g, g.lanes.map((_, lane) => lane)),
      now = g.phase === "results" ? wire.elapsed : Math.max(target, g.phase === "countdown" ? -R.countdown * 1000 : 0);
    const known = g.lanes.map((_, lane) => new Map(g.results(lane).map((r) => [r.note, { grade: r.grade, at: r.at }] as const)));
    return { wire, song: g.song, now, winner: g.winner(), round: 1, self: 0, lanes: viewLanes(g.song, wire, now, known, g.lanes.map((l) => l.strays), [], 0, () => true), mismatch: false };
  }
  press(wall: number, key: number): PressOutcome | undefined {
    if (this.pausedAt !== null || this.game.phase !== "playing") return undefined;
    const at = this.clock(wall);
    // Never ahead of what the game can take (a press between two steps is a few ms ahead of it).
    const hit = this.game.press(0, { at: Math.min(at, this.game.elapsedMs + R.aheadMs), key });
    if (hit === undefined) return undefined;
    return { note: hit?.note ?? -1, grade: hit?.grade ?? null, at };
  }
}

/** A local round for `players` (the player plus bots of `level`) in `style`: its source and the looks. */
export function localRhythm(players: 2 | 3, level: RhythmBotLevel, style: RhythmStyle, costume: SelectableCostumeId) {
  const source = new LocalRhythm(players, level, style);
  const looks: RhythmLook[] = source.game.lanes.map((_, lane) => ({
    color: PLAYERS[lane].color,
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : `${RHYTHM_BOT_NAMES[level]} Bot${players > 2 ? ` ${lane}` : ""}`,
  }));
  return { source, looks };
}

/** Seconds of playing left at `t`. */
export const timeLeft = (wire: RhythmWire, t: number) => Math.max(0, wire.limit - Math.max(0, t) / 1000);
