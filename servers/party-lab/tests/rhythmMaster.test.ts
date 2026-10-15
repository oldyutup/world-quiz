/**
 * Ritim Ustası: the song (tempo, chart on the beat, same for everyone), the judging windows,
 * the combo and its bonus, stamped presses (no network penalty), the end at 45 s, places and
 * draws, the bots, the wire, the press path (mailbox) and a real room with 2 and 3 players
 * (dropping out and coming back), plus Mixed, the board and the local arena list.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { RHYTHM as R } from "../../../shared/party-lab/simulation/rhythm/config.js";
import { GOOD, MISS, PERFECT, RhythmGame, WRONG, comboOf, judgePress, type RhythmPress } from "../../../shared/party-lab/simulation/rhythm/game.js";
import { RHYTHM_STYLES, SONG_BEATS, beatAt, beatTime, bpmAt, chartHash, composeSong, keysByPitch, parseBar, STYLE_MATERIAL, KEY_W, KEY_A, KEY_S, KEY_D, type Song } from "../../../shared/party-lab/simulation/rhythm/song.js";
import { RhythmBot, RHYTHM_BOT_LEVELS, type RhythmBotLevel } from "../../../shared/party-lab/simulation/rhythm/bots.js";
import { rhythmSection, validRhythmWire, wireResults } from "../../../shared/party-lab/simulation/rhythm/wire.js";
import { RhythmRoundSimulation } from "../../../shared/party-lab/simulation/rhythmRound.js";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { packetPresses, validateRhythmInput } from "../../../shared/party-lab/network/rhythmInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { PLAYERS } from "../../../shared/party-lab/simulation/players.js";

const MS = 1000 / R.hz;
const LIMIT = R.limit * 1000;
const { perfect: P, good: G } = R.windows;
function near(a: number, b: number, eps: number, what = "") {
  assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≉ ${b} (±${eps})`);
}
/** A hand-made chart: notes at `times` (ms) with `keys`. */
function chart(times: number[], keys: number[] = times.map(() => KEY_W)): Song {
  return { style: "chiptune", seed: 1, bars: [], endAt: 40_000, notes: times.map((t, i) => ({ beat: i, len: 0.5, pitch: 60, key: keys[i], t, end: t + 200 })) };
}
/** A game just past its countdown. */
function playing(count = 2, song?: Song, seed = 7) {
  const g = new RhythmGame(count, mulberry32(seed), song);
  while (g.phase === "countdown") g.step();
  assert.equal(g.phase, "playing");
  return g;
}
/** Steps until the server's clock reaches `ms`; `volleys` are delivered on the step that gets there. */
function stepTo(g: RhythmGame, ms: number, volleys: Record<number, RhythmPress[]> = {}) {
  while ((g.ticks + 1) * MS < ms - 1e-9 && g.phase === "playing") g.step();
  g.step(g.lanes.map((l, lane) => (lane in volleys ? { pressed: l.pressed + volleys[lane].length, presses: volleys[lane] } : undefined)));
}
/** Lane `lane` presses `key` at `at`, delivered `late` ms after (on the server's clock; calls go forward in time). */
function press(g: RhythmGame, lane: number, at: number, key: number, late = 0) {
  stepTo(g, at + late, { [lane]: [{ at, key }] });
}
/** Several lanes' presses, each delivered on time, in time order: [lane, at, key]. */
function play(g: RhythmGame, presses: [number, number, number][]) {
  const order = [...presses].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < order.length; ) {
    const at = order[i][1],
      volleys: Record<number, RhythmPress[]> = {};
    for (; i < order.length && order[i][1] === at; i++) (volleys[order[i][0]] ??= []).push({ at, key: order[i][2] });
    stepTo(g, at, volleys);
  }
}
const grade = (g: RhythmGame, lane: number, note: number) => g.lanes[lane].grades[note];

test("the song: 22 bars rising smoothly 110 → 140 BPM (about 42.4 s, the last chord inside 45 s); every note on the eighth-note grid of that tempo map", () => {
  assert.equal(SONG_BEATS, 88);
  assert.equal(bpmAt(0), 110);
  assert.equal(bpmAt(SONG_BEATS), 140);
  near(bpmAt(44), 125, 1e-9);
  near(beatTime(SONG_BEATS), 42_445, 1);
  assert.ok(beatTime(SONG_BEATS) + 2000 < LIMIT, "the last chord rings out before the end");
  // The tempo map: each beat lasts 60 s / bpm (smooth, no steps); beatAt inverts beatTime.
  for (let b = 0; b < SONG_BEATS; b += 0.25) {
    near((beatTime(b + 1e-4) - beatTime(b)) / 1e-4, 60000 / bpmAt(b), 0.01, `beat ${b}`);
    near(beatAt(beatTime(b)), b, 1e-9);
  }
  for (const style of RHYTHM_STYLES)
    for (let seed = 0; seed < 40; seed++) {
      const song = composeSong(style, seed);
      assert.deepEqual(composeSong(style, seed), song, "the same style and seed, the same song");
      assert.ok(song.notes.length >= 100 && song.notes.length <= 125, `${style}/${seed}: ${song.notes.length} notes`);
      song.notes.forEach((n, i) => {
        assert.equal((n.beat * 2) % 1, 0, "on an eighth");
        assert.equal(n.t, beatTime(n.beat), "at its beat's moment");
        assert.equal(n.end, beatTime(n.beat + n.len));
        assert.ok([KEY_W, KEY_A, KEY_S, KEY_D].includes(n.key));
        if (i > 0) assert.ok(n.t - song.notes[i - 1].t >= 214, "at most eighths (no overlapping windows)");
      });
      // Sparse first (about one a beat up to bar 10), denser in the second half.
      const first = song.notes.filter((n) => n.beat < 40).length / 40,
        second = song.notes.filter((n) => n.beat >= 40).length / (SONG_BEATS - 40);
      assert.ok(first >= 0.7 && first <= 1.0, `${style}: ${first} a beat at first`);
      assert.ok(second >= 1.4 && second > first + 0.4, `${style}: ${second} a beat later`);
      assert.equal(song.notes[0].beat, 4, "nothing in the first bar");
      assert.equal(song.notes.at(-1)!.beat, SONG_BEATS, "the last note is the last chord");
      // The keys follow the pitch within a part (intro and main, lift, finale): higher never gets a
      // lower key (S < A < D < W), and every part uses all four keys, none for more than half its notes.
      const rank = [3, 1, 0, 2],
        part = (beat: number) => (beat < 40 ? 0 : beat < 72 ? 1 : 2);
      for (const a of song.notes) for (const b of song.notes) if (part(a.beat) === part(b.beat) && a.pitch < b.pitch) assert.ok(rank[a.key] <= rank[b.key]);
      for (const p of [0, 1, 2]) {
        const notes = song.notes.filter((n) => part(n.beat) === p);
        for (const key of [KEY_W, KEY_A, KEY_S, KEY_D]) {
          const share = notes.filter((n) => n.key === key).length / notes.length;
          assert.ok(share > 0.03 && share <= 0.5, `${style}/${seed} part ${p}: key ${key} ${share.toFixed(2)}`);
        }
      }
    }
  // Every written bar is eight eighths; the second time through a part varies with the seed.
  for (const style of RHYTHM_STYLES) {
    const m = STYLE_MATERIAL[style];
    for (const bar of [m.introBar, ...m.main, ...m.mainEndings, ...m.lift, ...m.liftEndings, ...m.finale]) assert.doesNotThrow(() => parseBar(bar));
    const variants = new Set(Array.from({ length: 12 }, (_, seed) => composeSong(style, seed).notes.map((n) => `${n.beat}:${n.pitch}`).join(",")));
    assert.ok(variants.size >= 8, `${style}: ${variants.size} variants of 12 seeds`);
  }
  assert.throws(() => parseBar("4/2 4/2"), /bar of 4 eighths/);
  // Four groups of about the same size.
  const keys = keysByPitch([60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepEqual([60, 62, 64, 65, 67, 69, 71, 72].map((p) => keys.get(p)), [KEY_S, KEY_S, KEY_A, KEY_A, KEY_D, KEY_D, KEY_W, KEY_W]);
});

test("everyone gets the same notes: one song per round, every lane its own copy; the style is drawn at random", () => {
  const g = playing(3);
  assert.equal(g.lanes.length, 3);
  assert.ok(g.lanes.every((l) => l.grades.length === g.notes.length));
  const n = g.notes[0];
  press(g, 0, n.t, n.key);
  assert.equal(grade(g, 0, 0), PERFECT);
  assert.equal(grade(g, 1, 0), -1, "a hit is the hitter's alone");
  const styles = new Set(Array.from({ length: 60 }, (_, seed) => new RhythmGame(2, mulberry32(seed)).style));
  assert.deepEqual([...styles].sort(), [...RHYTHM_STYLES].sort());
});

test("judging: ±50 ms MÜKEMMEL +10, ±110 ms İYİ +5 (early or late alike); further away no note: a stray press", () => {
  const g = playing(2, chart([2000, 4000, 6000, 8000, 10_000, 12_000]));
  press(g, 0, 2000 - P, KEY_W);
  press(g, 0, 4000 + P + 1, KEY_W);
  press(g, 0, 6000 - G, KEY_W);
  press(g, 0, 8000 + G + 1, KEY_W);
  const l = g.lanes[0];
  assert.deepEqual([...l.grades.slice(0, 3)], [PERFECT, GOOD, GOOD]);
  assert.equal(grade(g, 0, 3), -1, "111 ms late is no hit");
  assert.equal(l.strays.length, 1, "it was a stray press");
  // A note nobody pressed is missed once no press can reach it (good + tolerance after it), never sooner.
  stepTo(g, 8000 + G + R.toleranceMs - 20);
  assert.equal(grade(g, 0, 3), -1);
  stepTo(g, 8000 + G + R.toleranceMs + 20);
  assert.equal(grade(g, 0, 3), MISS);
  assert.equal(l.at[3], 8000 + G, "missed at the end of its window");
  assert.equal(l.score, 20, "a miss costs nothing");
  press(g, 0, 10_000 + 30, KEY_W);
  assert.equal(grade(g, 0, 4), PERFECT);
  assert.equal(l.score, 10 + 5 + 5 + 10);
  assert.deepEqual([l.perfect, l.good, l.miss], [2, 2, 1]);
  // The nearest note of the key wins; two presses for one note: the second is a stray.
  const h = playing(2, chart([2000, 2215], [KEY_W, KEY_A]));
  press(h, 0, 2105, KEY_A);
  assert.equal(grade(h, 0, 1), GOOD, "A went to the A note even with the W note nearer");
  assert.equal(grade(h, 0, 0), -1);
  press(h, 1, 2000, KEY_W);
  press(h, 1, 2010, KEY_W);
  assert.equal(grade(h, 1, 0), PERFECT);
  assert.equal(h.lanes[1].strays.length, 1);
});

test("a wrong key with a note in the window loses that note (YANLIŞ: no points, the combo breaks); the note cannot be hit after", () => {
  const g = playing(2, chart([2000, 3000, 4000, 5000], [KEY_W, KEY_A, KEY_S, KEY_D]));
  press(g, 0, 2000, KEY_W);
  press(g, 0, 3000, KEY_A);
  assert.equal(g.lanes[0].combo, 2);
  press(g, 0, 4020, KEY_D);
  assert.equal(grade(g, 0, 2), WRONG);
  assert.equal(g.lanes[0].wrong, 1);
  assert.equal(g.lanes[0].combo, 0);
  assert.equal(g.lanes[0].score, 20);
  press(g, 0, 4040, KEY_S);
  assert.equal(grade(g, 0, 2), WRONG, "lost for good");
  assert.equal(g.lanes[0].strays.length, 1, "the late right key met nothing");
  // Mashing every key on one note: the first decides.
  press(g, 1, 4995, KEY_W);
  stepTo(g, 4996, { 1: [{ at: 4996, key: KEY_A }, { at: 4997, key: KEY_S }, { at: 4998, key: KEY_D }] });
  assert.equal(grade(g, 1, 3), WRONG);
  assert.equal(g.lanes[1].score, 0);
});

test("combo: every hit adds one, a miss, a wrong key or a stray press resets it; the longest combo × 2 is added at the end", () => {
  const times = Array.from({ length: 12 }, (_, i) => 2000 + i * 250);
  const g = playing(2, chart(times));
  const l = g.lanes[0];
  for (let i = 0; i < 4; i++) press(g, 0, times[i], KEY_W);
  assert.deepEqual([l.combo, l.maxCombo], [4, 4]);
  // A stray press between notes breaks it.
  press(g, 0, times[3] + 125, KEY_W);
  assert.deepEqual([l.combo, l.maxCombo], [0, 4]);
  for (let i = 4; i < 9; i++) press(g, 0, times[i], KEY_W);
  assert.deepEqual([l.combo, l.maxCombo], [5, 5]);
  // Note 9 is missed: called later, but in time order the combo breaks there.
  press(g, 0, times[10], KEY_W);
  assert.equal(l.combo, 6, "not called yet");
  stepTo(g, times[9] + G + R.toleranceMs + 20);
  assert.equal(grade(g, 0, 9), MISS);
  assert.deepEqual([l.combo, l.maxCombo], [1, 5], "the miss came before the last hit");
  press(g, 0, times[11], KEY_W);
  assert.deepEqual([l.combo, l.maxCombo], [2, 5]);
  assert.equal(g.bonus(0), 5 * R.comboBonus);
  assert.equal(g.total(0), l.score + 10);
  // The order alone decides (a break at the same moment as a hit goes first).
  assert.deepEqual(comboOf([{ grade: PERFECT, at: 1 }, { grade: GOOD, at: 2 }, { grade: MISS, at: 3 }, { grade: PERFECT, at: 4 }]), { combo: 1, max: 2 });
  assert.deepEqual(comboOf([{ grade: PERFECT, at: 5 }, { grade: PERFECT, at: 1 }], [5]), { combo: 1, max: 1 });
});

test("fairness: a press is judged at its stamp however late it arrives (up to 300 ms): no İYİ for the network; older is moved up, ahead is held back", () => {
  const g = playing(3, chart([2000, 4000, 6000, 8000]));
  press(g, 0, 2000, KEY_W, 0);
  press(g, 2, 2000, KEY_W, 140);
  press(g, 1, 2000, KEY_W, 280);
  assert.deepEqual([grade(g, 0, 0), grade(g, 1, 0), grade(g, 2, 0)], [PERFECT, PERFECT, PERFECT], "the same press, any delay");
  near(g.lanes[1].at[0], 2000, 1e-9);
  // 400 ms old: moved up to 300 ms ago (= 100 ms late: İYİ).
  press(g, 0, 4000, KEY_W, 400);
  assert.equal(grade(g, 0, 1), GOOD);
  near(g.lanes[0].at[1], 4100, MS);
  // A stamp from the future is held at most 50 ms ahead.
  stepTo(g, 5850);
  const before = g.elapsedMs;
  g.step([{ pressed: g.lanes[0].pressed + 1, presses: [{ at: 6000, key: KEY_W }] }]);
  assert.equal(grade(g, 0, 2), GOOD, `${6000 - (before + MS + R.aheadMs)} ms early at most`);
});

test("held keys and repeated packets: a packet repeats the latest presses, each counts once; bunched packets lose none", () => {
  const g = playing(2, chart([2000, 2250, 2500]));
  stepTo(g, 2000, { 0: [{ at: 2000, key: KEY_W }] });
  // The same packet again (and an older one): nothing new.
  g.step([{ pressed: 1, presses: [{ at: 2000, key: KEY_W }] }]);
  g.step([{ pressed: 1, presses: [] }]);
  assert.equal(g.lanes[0].strays.length, 0);
  assert.equal(g.lanes[0].pressed, 1);
  // Three presses in one packet (the one before it was lost): the new two count.
  while (g.elapsedMs < 2500) g.step();
  g.step([{ pressed: 3, presses: [{ at: 2000, key: KEY_W }, { at: 2250, key: KEY_W }, { at: 2500, key: KEY_W }] }]);
  assert.deepEqual([...g.lanes[0].grades], [PERFECT, PERFECT, PERFECT]);
  assert.equal(g.lanes[0].combo, 3);
  assert.equal(g.lanes[0].pressed, 3);
});

test("time: no press before BAŞLA or at 45 s counts; the round ends at 45 s with every note called", () => {
  const g = new RhythmGame(2, mulberry32(3));
  assert.equal(g.press(0, { at: 0, key: KEY_W }), undefined, "countdown");
  while (g.phase === "countdown") g.step();
  assert.equal(g.press(0, { at: -5, key: KEY_W }), undefined);
  const last = g.notes.at(-1)!;
  stepTo(g, last.t);
  assert.notEqual(g.press(0, { at: last.t, key: last.key }), undefined);
  assert.equal(grade(g, 0, g.notes.length - 1), PERFECT);
  while (g.phase === "playing" && g.ticks < g.limitTicks - 1) g.step();
  assert.equal(g.phase, "playing");
  g.step();
  assert.equal(g.phase, "results");
  near(g.elapsedMs, LIMIT, 1e-6);
  assert.ok(g.lanes.every((l) => [...l.grades].every((x) => x >= 0)), "every note called");
  assert.equal(g.lanes[1].miss, g.notes.length);
  assert.equal(g.press(0, { at: LIMIT - 1, key: KEY_W }), undefined, "over");
});

test("results: the total (score + combo bonus) ranks; equal totals share a place and a tie for first draws; a leaver is last; the last player left wins at once", () => {
  const times = [2000, 2500, 3000, 3500, 4000];
  const g = playing(3, chart(times));
  // Lane 0: four hits, the last note missed (40 + 4 × 2 = 48). Lane 1: notes 1, 3 and 5, a stray after each (30 + 1 × 2 = 32).
  // Lane 2: four hits, the fourth İYİ (35 + 4 × 2 = 43).
  play(g, [
    ...times.slice(0, 4).map((t): [number, number, number] => [0, t, KEY_W]),
    ...[times[0], times[2], times[4]].flatMap((t): [number, number, number][] => [[1, t, KEY_W], [1, t + 200, KEY_W]]),
    ...times.slice(0, 3).map((t): [number, number, number] => [2, t, KEY_W]),
    [2, times[3] + 80, KEY_W],
  ]);
  while (g.phase === "playing") g.step();
  assert.deepEqual(g.lanes.map((_, lane) => g.total(lane)), [48, 32, 43]);
  assert.deepEqual(g.places(), [0, 2, 1]);
  assert.equal(g.winner(), 0);
  // Same totals: a draw.
  const d = playing(2, chart(times));
  play(d, times.slice(0, 2).flatMap((t): [number, number, number][] => [[0, t, KEY_W], [1, t, KEY_W]]));
  while (d.phase === "playing") d.step();
  assert.deepEqual(d.places(), [0, 0]);
  assert.equal(d.winner(), -1);
  // A leaver ranks last even with more points; with one left the round ends at once.
  const e = playing(3, chart(times));
  for (const t of times) press(e, 1, t, KEY_W);
  e.remove(1);
  e.step();
  assert.equal(e.phase, "playing");
  assert.deepEqual(e.places(), [0, 2, 0], "the leaver (lane 1) is last however many points");
  e.remove(0);
  e.step();
  assert.equal(e.phase, "results");
  assert.equal(e.winner(), 2);
});

test("bots really play: Zor is nearly always MÜKEMMEL, Kolay misses often; Zor > Orta > Kolay", () => {
  const avg: Record<RhythmBotLevel, { total: number; perfect: number; miss: number; notes: number }> = { easy: { total: 0, perfect: 0, miss: 0, notes: 0 }, medium: { total: 0, perfect: 0, miss: 0, notes: 0 }, hard: { total: 0, perfect: 0, miss: 0, notes: 0 } };
  for (const level of RHYTHM_BOT_LEVELS)
    for (let seed = 0; seed < 12; seed++) {
      const random = mulberry32(seed);
      const g = new RhythmGame(2, random);
      const bot = new RhythmBot(level, random);
      let pressed = 0,
        recent: RhythmPress[] = [];
      while (g.phase !== "results") {
        const due = g.elapsedMs + MS;
        for (const p of bot.next(g.notes, due, g.phase === "playing")) {
          pressed++;
          recent = [...recent, p].slice(-R.recentPresses);
          assert.ok(p.at <= due + 1e-9, "never ahead of its time");
        }
        g.step([{ pressed, presses: recent }, undefined]);
      }
      const l = g.lanes[0];
      avg[level].total += g.total(0) / 12;
      avg[level].perfect += l.perfect / 12;
      avg[level].miss += (l.miss + l.wrong) / 12;
      avg[level].notes += g.notes.length / 12;
    }
  const { easy, medium, hard } = avg;
  assert.ok(hard.total > medium.total && medium.total > easy.total, JSON.stringify(avg));
  assert.ok(hard.perfect / hard.notes > 0.9, `Zor MÜKEMMEL ${hard.perfect}/${hard.notes}`);
  assert.ok(easy.miss / easy.notes > 0.12, `Kolay misses ${easy.miss}/${easy.notes}`);
  assert.ok(medium.miss / medium.notes < easy.miss / easy.notes);
});

test("the round simulation: player counts, slots (not seats) as winner, placements per slot", () => {
  const sim = new RhythmRoundSimulation(undefined, 11);
  assert.equal(sim.start([0]), false);
  assert.equal(sim.start([0, 1, 2, 2]), false);
  assert.ok(sim.start([2, 1]));
  assert.deepEqual(sim.seats, [1, 2]);
  while (sim.phase !== "playing") sim.step([]);
  const g = sim.game,
    n = g.notes[0];
  stepTo(g, n.t);
  const inputs = PLAYERS.map(() => ({ x: 0, z: 0, jump: false }));
  sim.step(inputs.map((input, slot) => (slot === 2 ? { ...input, rhythm: { seq: 1, round: sim.roundId, pressed: 1, presses: [n.t, n.key] } } : input)));
  assert.equal(g.lanes[1].perfect, 1, "slot 2 is lane 1");
  while (sim.phase === "playing") sim.step([]);
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2);
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.v, 23);
  assert.equal(snap.mode, "rhythm_master");
  assert.equal(snap.winner, 2);
  assert.ok(validRhythmWire(snap.rhythm));
  assert.equal(snap.transforms.byteLength, 0);
});

test("the wire: the song as style + seed (the browser composes the same notes), recent results only; well formed, refused when malformed", () => {
  const g = playing(2);
  const w0 = rhythmSection(g, [0, 1]);
  assert.equal(composeSong(RHYTHM_STYLES[w0.style], w0.seed).notes.length, w0.notes);
  assert.deepEqual(composeSong(RHYTHM_STYLES[w0.style], w0.seed).notes, g.notes);
  // The chart's fingerprint travels too: a page composing another song (another build) can tell.
  assert.equal(w0.chart, chartHash(g.notes));
  assert.notEqual(chartHash(composeSong(RHYTHM_STYLES[w0.style], w0.seed + 1).notes), w0.chart);
  assert.notEqual(chartHash(g.notes.map((n, i) => (i === 50 ? { ...n, key: (n.key + 1) % 4 } : n))), w0.chart, "one key differs");
  const n = g.notes[0];
  press(g, 0, n.t, n.key);
  let w = rhythmSection(g, [0, 1]);
  assert.ok(validRhythmWire(w));
  assert.deepEqual(wireResults(w, 0), [{ note: 0, grade: PERFECT, at: n.t }]);
  assert.deepEqual([w.score[0], w.combo[0], w.maxCombo[0], w.bonus[0], w.total[0], w.pressed[0]], [10, 1, 1, 2, 12, 1]);
  stepTo(g, n.t + R.keepMs + 50);
  w = rhythmSection(g, [0, 1]);
  assert.equal(wireResults(w, 0).length, wireResults(w, 0).filter((r) => r.at >= g.elapsedMs - R.keepMs).length, "only the recent ones");
  assert.ok(!wireResults(w, 0).some((r) => r.note === 0), "an old result is no longer sent");
  for (const bad of [{ ...w, style: 3 }, { ...w, seed: -1 }, { ...w, chart: 1.5 }, { ...w, score: [1] }, { ...w, resGrade: w.resGrade.map(() => 4) }, { ...w, phase: "x" }, { ...w, seats: [0] }, null])
    assert.equal(validRhythmWire(bad), false, JSON.stringify(bad)?.slice(0, 80));
});

test("mailbox: the newest press packet waits for the next step, however late; strict packets", () => {
  const box = new InputMailbox();
  assert.equal(box.accept({ seq: 1, round: 2, pressed: 1, presses: [50, 1] }, 2, 0, "rhythm_master"), true);
  assert.equal(box.accept({ seq: 1, round: 2, pressed: 2, presses: [60, 0] }, 2, 0, "rhythm_master"), false, "replayed seq");
  assert.equal(box.accept({ seq: 2, round: 1, pressed: 2, presses: [60, 0] }, 2, 0, "rhythm_master"), false, "old round");
  assert.equal(box.accept({ seq: 2, round: 2, aim: 0, fired: 1, shots: [] }, 2, 0, "rhythm_master"), false, "another mode's packet");
  const read = box.read(10_000).rhythm!;
  assert.deepEqual(read, { seq: 1, round: 2, pressed: 1, presses: [50, 1] });
  assert.deepEqual(packetPresses(read), [{ at: 50, key: 1 }]);
  assert.equal(box.processedSeq, 1);
  assert.equal(box.read(10_001).rhythm, undefined, "read once");
  for (const bad of [
    { seq: 4, round: 2, pressed: 1, presses: [1, 4] },
    { seq: 4, round: 2, pressed: 1, presses: [1] },
    { seq: 4, round: 2, pressed: 1, presses: [NaN, 0] },
    { seq: 4, round: 2, pressed: 0, presses: [1, 0] },
    { seq: 4, round: 2, pressed: 9, presses: Array.from({ length: 14 }, (_, i) => (i % 2 ? 0 : i)) },
    { seq: 4, round: 2, pressed: 1.5, presses: [] },
    { seq: 4, round: 0, pressed: 1, presses: [1, 0] },
    { seq: 4, round: 2, pressed: 1, presses: [1, 0], x: 1 },
    [1],
  ])
    assert.equal(validateRhythmInput(bad), null, JSON.stringify(bad));
});

test("Ritim Ustası is in Mixed, in the board's mini games and in the Yerel Test Arenası for 2 and 3 players", () => {
  assert.ok(GAME_MODES.includes("rhythm_master"));
  assert.equal(MODE_NAMES.rhythm_master, "Ritim Ustası");
  assert.deepEqual(MODE_PLAYERS.rhythm_master, { min: 2, max: 3 });
  assert.ok(LOCAL_ARENA_IDS.includes("rhythm_master"));
  for (const count of [2, 3]) {
    assert.ok(modeFits("rhythm_master", count));
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("rhythm_master"), `Mixed ${count}P`);
    const minis: string[] = [];
    const host: BoardHost = { startMini: (mode) => (minis.push(mode), true), endMini() {}, connected: () => true };
    const rotation = new MixedRotation(() => 0.25);
    rotation.setPlayers(count);
    const board = new BoardSession(host, { length: 50, slots: PLAYERS.slice(0, count).map((p) => p.id), random: () => 0.25, die: () => 1, rotation, squares: boardSquares(50) });
    const until = (done: () => boolean, act = () => board.step(1 / NET.physicsHz)) => {
      for (let t = 0; t < 600 * NET.physicsHz && !done(); t++) act();
      assert.ok(done(), `board stuck in ${board.phase}`);
    };
    while (minis.length < cycle.length) {
      until(() => board.phase === "minigame");
      board.miniResult(-1, null);
      until(() => board.phase !== "minigame");
      until(() => board.phase === "intro", () => (board.phase === "roll" ? board.rollPressed(board.current) : board.step(1 / NET.physicsHz)));
    }
    assert.ok(minis.includes("rhythm_master"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
  assert.ok(!modeFits("rhythm_master", 1) && !modeFits("rhythm_master", 4));
});

/* A real room: presses in the countdown are dropped, stamped presses judged at their stamp,
   a dropped player's notes go by as misses and they play again once back, the time ends it. */
const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms: Room<unknown, LobbyState>[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timeout");
    await pause(5);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const r of rooms) {
    r.reconnection.enabled = false;
    if (r.connection.isOpen) await r.leave().catch(() => {});
  }
  await server.gracefullyShutdown(false);
});
async function peer(code?: string) {
  const c = new Client(endpoint),
    r = code
      ? await c.joinById<LobbyState>(code, { protocol: NET.version, nickname: "Guest", intent: "join", code })
      : await c.create<LobbyState>("party_lab", { protocol: NET.version, nickname: "Host", intent: "create" });
  rooms.push(r);
  r.onMessage("notice", () => {});
  r.onMessage("feedback", () => {});
  const snapshots: GameSnapshot[] = [];
  r.onMessage("snapshot", (s: GameSnapshot) => snapshots.push(s));
  Object.assign(r.reconnection, { minUptime: 0, minDelay: 70, maxDelay: 100, maxRetries: 10 });
  let seq = 0,
    pressed = 0,
    recent: number[] = [];
  return {
    r,
    snapshots,
    /** One more press (repeating the latest ones like the browser). */
    send: (round: number, at: number, key: number) => {
      pressed++;
      recent = [...recent, at, key].slice(-2 * R.recentPresses);
      r.send("input", { seq: ++seq, round, pressed, presses: recent });
    },
    renumber: (n: number) => {
      pressed = n;
      recent = [];
    },
  };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "rhythm_master");
  await until(() => room.selection === "rhythm_master");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as RhythmRoundSimulation;
  assert.ok(sim instanceof RhythmRoundSimulation);
  const lane = (p: (typeof peers)[number]) => sim.seats.indexOf(room.state.players.get(p.r.sessionId)!.slot as never);
  return { peers, room, sim, lane };
}
async function close(peers: { r: Room<unknown, LobbyState> }[]) {
  for (const p of peers) {
    p.r.reconnection.enabled = false;
    if (p.r.connection.isOpen) await p.r.leave();
  }
}

for (const count of [2, 3])
  test(`room ${count}P: countdown presses dropped, stamped presses judged at their stamp, a dropped player's notes go by as misses, back and pressing, 45 s ends it`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    const g = sim.game;
    // The room takes no input before BAŞLA.
    peers[0].send(sim.roundId, 10, KEY_W);
    await until(() => room.game.phase === "playing");
    await pause(40);
    assert.equal(g.lanes[lane(peers[0])].pressed, 0, "a press sent during the countdown");
    peers[0].renumber(0);
    /** Peer `i` presses the next note 20 ms late, stamped as the browser does. */
    const hit = async (i: number) => {
      const l = g.lanes[lane(peers[i])],
        id = g.notes.findIndex((n) => n.t > g.elapsedMs + 80),
        n = g.notes[id],
        score = l.score;
      await until(() => g.elapsedMs >= n.t + 20);
      peers[i].send(sim.roundId, n.t + 20, n.key);
      await until(() => l.score !== score);
      assert.equal(l.score - score, R.points.perfect, "+10 at its stamp");
      assert.equal(l.grades[id], PERFECT);
      return id;
    };
    await hit(0);
    await hit(1);
    // A dropped player's notes go by as misses; back, they press again (numbering on from the server's count).
    const l1 = lane(peers[1]),
      r = peers[1].r,
      sessionId = r.sessionId,
      misses = g.lanes[l1].miss;
    r.connection.close(4010);
    await until(() => !room.state.players.get(sessionId)!.connected);
    const from = g.elapsedMs;
    const passed = g.notes.findIndex((n) => n.t > from);
    await until(() => g.lanes[l1].grades[passed] >= 0, 6000);
    assert.equal(g.lanes[l1].grades[passed], MISS, "a note went by while offline");
    assert.ok(g.lanes[l1].miss > misses);
    assert.equal(room.game, sim, "the round goes on");
    await until(() => room.state.players.get(sessionId)!.connected);
    peers[1].renumber(g.lanes[l1].pressed);
    await hit(1);
    if (count === 3) await hit(2);
    // To the end of the time.
    g.ticks = g.limitTicks - 5;
    await until(() => room.game.phase === "results", 3000);
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(1), "two hits against one");
    const places = sim.placements();
    assert.equal(places[slot(1)], 0);
    assert.equal(places[slot(0)], 1);
    if (count === 3) assert.equal(places[slot(2)], 1, "equal totals share a place");
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 23);
    assert.ok(validRhythmWire(shown.rhythm));
    assert.equal(shown.winner, slot(1));
    assert.equal(shown.rhythm!.score[l1], 20);
    assert.equal(shown.rhythm!.total[l1], 20 + shown.rhythm!.bonus[l1]);
    await close(peers);
  });

test("room: the player left alone wins the round", { timeout: 30000 }, async () => {
  const { peers, room, sim } = await lobby(2);
  await until(() => room.game.phase === "playing");
  peers[1].r.reconnection.enabled = false;
  await peers[1].r.leave();
  await until(() => room.game.phase === "results");
  assert.equal(sim.winner, room.state.players.get(peers[0].r.sessionId)!.slot);
  await close(peers.slice(0, 1));
});
