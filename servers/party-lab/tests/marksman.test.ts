/**
 * Nişancı: the waves, the shot rules (engine), the bots, the shot path (mailbox) and a real room
 * with 2 and 3 players.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { MARKSMAN as M } from "../../../shared/party-lab/simulation/marksman/config.js";
import { MarksmanGame, type MarksmanShot } from "../../../shared/party-lab/simulation/marksman/game.js";
import { BOMB, EMPTY, TARGET, makeWaves, tempo, waveAt, type SlotKind, type Wave } from "../../../shared/party-lab/simulation/marksman/waves.js";
import { MarksmanBot, MARKSMAN_BOT_LEVELS, type MarksmanBotLevel } from "../../../shared/party-lab/simulation/marksman/bots.js";
import { marksmanSection, validMarksmanWire, wireHits, wireWaves } from "../../../shared/party-lab/simulation/marksman/wire.js";
import { MarksmanRoundSimulation } from "../../../shared/party-lab/simulation/marksmanRound.js";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { packetShots, validateMarksmanInput } from "../../../shared/party-lab/network/marksmanInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { PLAYERS } from "../../../shared/party-lab/simulation/players.js";

const MS = 1000 / M.hz;
const LIMIT = M.limit * 1000;
/** A hand-made schedule: wave i opens at 1000 + 2000·i for 1500 ms with `kinds[i]`. */
const waves = (...kinds: SlotKind[][]): Wave[] => kinds.map((k, i) => ({ open: 1000 + 2000 * i, close: 2500 + 2000 * i, kinds: k }));
const T_ = TARGET,
  B_ = BOMB,
  E_ = EMPTY;
/** A game just past its countdown. */
function shooting(count = 2, schedule?: Wave[], seed = 7) {
  const g = new MarksmanGame(count, mulberry32(seed), schedule);
  while (g.phase === "countdown") g.step();
  assert.equal(g.phase, "shooting");
  return g;
}
/** Steps until the server's clock reaches `ms` (the shots are delivered on the step that gets there). */
function stepTo(g: MarksmanGame, ms: number, shots: Record<number, MarksmanShot[]> = {}) {
  while ((g.ticks + 1) * MS < ms - 1e-9 && g.phase === "shooting") g.step();
  g.step(g.lanes.map((l, lane) => (lane in shots ? { aim: shots[lane].at(-1)!.aim, fired: l.fired + shots[lane].length, shots: shots[lane] } : undefined)));
}
/** Lane `lane` shoots at `at` with `aim`, delivered `late` ms after (on the server's clock); the points or null. */
function shoot(g: MarksmanGame, lane: number, at: number, aim: number, late = 0) {
  const l = g.lanes[lane],
    before = l.score,
    shots = l.shots;
  stepTo(g, at + late, { [lane]: [{ at, aim }] });
  return l.shots === shots ? null : l.score - before;
}

test("waves: one schedule, never overlapping, the last closing by 45 s; the tempo speeds up (up 1.1 → 0.7 s, pauses 0.4 → 0.2 s); about one slot in four is a bomb, a lone one or a whole bigger wave about one in ten", () => {
  assert.equal(M.limit, 45);
  assert.equal(M.goodMs, 500);
  near(tempo(0).openMs, 1100, 1e-9);
  near(tempo(LIMIT).openMs, 700, 1e-9);
  near(tempo(0).gapMs, 400, 1e-9);
  near(tempo(LIMIT).gapMs, 200, 1e-9);
  assert.ok(tempo(LIMIT).sizes[0] < tempo(0).sizes[0] && tempo(LIMIT).sizes[2] > tempo(0).sizes[2], "multi-slot waves more often");
  let slots = 0,
    bombs = 0,
    singles = 0,
    loneBombs = 0,
    bigger = 0,
    allBombs = 0,
    early = { n: 0, multi: 0, open: 0 },
    late = { n: 0, multi: 0, open: 0 };
  for (let seed = 0; seed < 400; seed++) {
    const list = makeWaves(mulberry32(seed));
    assert.deepEqual(makeWaves(mulberry32(seed)), list, "the same seed, the same waves");
    assert.ok(list.length >= 32 && list.length <= 44, `${list.length} waves`);
    list.forEach((w, i) => {
      assert.ok(w.open < w.close && w.close <= LIMIT);
      if (i > 0) assert.ok(w.open > list[i - 1].close, "a pause between waves");
      const used = w.kinds.filter((k) => k !== EMPTY).length,
        b = w.kinds.filter((k) => k === BOMB).length;
      assert.ok(used >= 1 && used <= 3);
      if (used > 1) (bigger++, (allBombs += +(b === used)));
      slots += used;
      bombs += b;
      if (used === 1) (singles++, (loneBombs += b));
      const bucket = w.open < 15_000 ? early : w.open > 30_000 ? late : null;
      if (bucket) (bucket.n++, (bucket.multi += +(used > 1)), (bucket.open += w.close - w.open));
    });
  }
  near(bombs / slots, 0.25, 0.025, "bomb share");
  near(loneBombs / singles, 0.1, 0.02, "lone bombs");
  near(allBombs / bigger, 0.1, 0.02, "bigger waves all bombs");
  assert.ok(late.multi / late.n > early.multi / early.n + 0.2, "multi-slot waves grow");
  assert.ok(late.open / late.n < early.open / early.n - 200, "waves stay up shorter");
  // waveAt finds the wave up at a moment, none between.
  const list = makeWaves(mulberry32(3));
  assert.equal(waveAt(list, list[4].open), 4);
  assert.equal(waveAt(list, list[4].close - 0.01), 4);
  assert.equal(waveAt(list, list[4].close), -1);
  assert.equal(waveAt(list, 0), -1);
});

test("scoring: within 0.5 s of opening +5, later +2, a closed or empty slot 0; one target counts once; every player has their own copy", () => {
  const g = shooting(2, waves([T_, T_, E_], [E_, T_, E_], [T_, E_, E_]));
  assert.equal(shoot(g, 0, 1000 + M.goodMs, -1), M.points.good, "at exactly 0.5 s");
  assert.equal(shoot(g, 1, 1000 + M.goodMs + 1, -1), M.points.slow, "the other player's copy is still up, later is slow");
  assert.equal(shoot(g, 0, 1700, -1), 0, "already down for lane 0");
  assert.equal(shoot(g, 0, 1900, 1), 0, "an empty slot");
  assert.equal(shoot(g, 0, 2100, 0), M.points.slow);
  assert.equal(shoot(g, 0, 2600, 1), 0, "between waves");
  assert.equal(shoot(g, 0, 3000, 0), M.points.good, "the next wave, as it opens");
  assert.equal(shoot(g, 1, 4499, 0), M.points.slow, "just before it closes");
  assert.equal(shoot(g, 1, 6500, -1), 0, "closed: nothing");
  assert.deepEqual([g.lanes[0].score, g.lanes[1].score], [5 + 2 + 5, 2 + 2]);
  assert.deepEqual([g.lanes[0].good, g.lanes[0].slow, g.lanes[0].bombs], [2, 1, 0]);
  assert.equal(g.lanes[0].shots, 6, "every counted shot, misses too");
});

test("a bomb: −5 (the score can go below zero), a life, and 1 s stunned: no shot counts, the aim still moves; a lone bomb wave has nothing to hit", () => {
  assert.equal(M.lives, 2);
  const g = shooting(2, waves([B_, T_, E_], [E_, B_, E_], [T_, T_, T_]));
  assert.equal(shoot(g, 0, 1200, -1), M.points.bomb);
  assert.deepEqual([g.lanes[0].score, g.lanes[0].lives, g.lanes[0].stunUntil, g.lanes[0].diedAt], [-5, 1, 2200, -1]);
  assert.equal(shoot(g, 0, 1400, 0), null, "stunned: refused");
  stepTo(g, 1600, {});
  g.step([{ aim: 1, fired: g.lanes[0].fired, shots: [] }]);
  assert.equal(g.lanes[0].aim, 1, "the aim moves while stunned");
  assert.equal(shoot(g, 0, 2199, 0), null, "still stunned");
  assert.equal(shoot(g, 0, 2200, 0), M.points.slow, "the stun is over");
  assert.equal(g.lanes[0].score, -3);
  assert.equal(shoot(g, 1, 3100, -1), 0, "a lone bomb: holding fire (or missing) costs nothing");
  assert.deepEqual([g.lanes[1].lives, g.lanes[1].stunUntil], [2, 0]);
});

test("the second bomb knocks the player out: no more shots, and the one left standing wins 150 ms after (shots pressed before the knock-out still count, later ones do not)", () => {
  const g = shooting(2, waves([B_, T_, E_], [B_, B_, B_], [T_, T_, T_]));
  shoot(g, 0, 1100, -1);
  assert.equal(shoot(g, 0, 3100, 1), M.points.bomb, "a wave of bombs only: shooting any is the mistake");
  assert.deepEqual([g.lanes[0].lives, g.lanes[0].diedAt, g.lanes[0].score], [0, 3100, -10]);
  assert.equal(g.standing(0), false);
  assert.equal(g.decidedAt, 3100);
  assert.equal(g.phase, "shooting", "waits for shots pressed before the knock-out");
  assert.equal(shoot(g, 1, 3150, 0), null, "pressed after the knock-out: the round is decided");
  assert.equal(shoot(g, 0, 3200, 0), null, "knocked out: no more shots");
  while (g.phase === "shooting") g.step();
  near(g.elapsedMs, 3100 + M.aimToleranceMs, MS);
  assert.equal(g.winner(), 1);
  assert.deepEqual(g.places(), [1, 0]);
  // A knock-out pressed earlier on the other's clock, arriving late, turns it round.
  const h = shooting(2, waves([B_, T_, E_], [B_, B_, B_]));
  shoot(h, 0, 1100, -1);
  shoot(h, 1, 1150, -1);
  shoot(h, 0, 3100, 0);
  assert.equal(h.decidedAt, 3100);
  assert.equal(shoot(h, 1, 3060, 0, 70), M.points.bomb, "pressed 40 ms earlier, seen later");
  assert.equal(h.lanes[1].diedAt, 3060);
  while (h.phase === "shooting") h.step();
  assert.equal(h.winner(), 0, "lane 0 stood longer");
  assert.deepEqual(h.places(), [0, 1]);
  // Both at the same moment: a draw.
  const d = shooting(2, waves([B_, T_, E_], [B_, B_, B_]));
  shoot(d, 0, 1100, -1);
  shoot(d, 1, 1100, -1);
  stepTo(d, 3100, { 0: [{ at: 3100, aim: 0 }], 1: [{ at: 3100, aim: 1 }] });
  while (d.phase === "shooting") d.step();
  assert.equal(d.winner(), -1);
  assert.deepEqual(d.places(), [0, 0]);
});

test("3 players: a knock-out leaves two playing on; the second one ends it; places: standing by score, then the knocked out by when (later higher)", () => {
  const g = shooting(3, waves([B_, T_, T_], [B_, T_, T_], [B_, T_, T_], [B_, T_, T_]));
  shoot(g, 0, 1100, -1);
  shoot(g, 0, 3100, -1);
  assert.equal(g.lanes[0].diedAt, 3100);
  shoot(g, 1, 3200, 0);
  shoot(g, 1, 3400, 1);
  assert.equal(g.lanes[1].score, 10);
  for (let i = 0; i < 30; i++) g.step();
  assert.equal(g.phase, "shooting", "two still standing");
  assert.equal(g.decidedAt, null);
  shoot(g, 2, 5200, 0);
  shoot(g, 1, 5300, -1);
  shoot(g, 2, 5400, 1);
  shoot(g, 2, 7100, 1);
  assert.equal(g.lanes[2].score, 15);
  shoot(g, 1, 7300, 0);
  shoot(g, 1, 7500, -1);
  assert.equal(g.lanes[1].diedAt, 7500, "the second bomb knocks lane 1 out");
  while (g.phase === "shooting") g.step();
  assert.equal(g.winner(), 2);
  assert.deepEqual(g.places(), [2, 1, 0]);
  // To the time: the standing ones by score (a tie draws), every knocked out one below them.
  const t = shooting(3, waves([B_, T_, T_], [B_, T_, T_], [T_, T_, T_]));
  shoot(t, 0, 1100, 1);
  shoot(t, 0, 1300, 0);
  shoot(t, 0, 1500, -1);
  shoot(t, 0, 3100, -1);
  assert.ok(t.lanes[0].diedAt > 0);
  shoot(t, 1, 5100, 0);
  shoot(t, 2, 5100, 0);
  while (t.phase === "shooting") t.step();
  near(t.elapsedMs, LIMIT + M.aimToleranceMs, MS);
  assert.equal(t.winner(), -1, "5 = 5 standing: a draw");
  assert.deepEqual(t.places(), [2, 0, 0]);
});

test("fairness: a shot is judged at its stamp and with its aim however late it arrives (up to 150 ms), so the speed points never pay for the network; older is moved up", () => {
  const g = shooting(2, waves([T_, T_, T_]));
  // Pressed 0.45 s after the target opened, seen by the server 0.14 s later: still +5, still the left slot.
  stepTo(g, 1000);
  g.step([{ aim: 1, fired: 0, shots: [] }]);
  assert.equal(shoot(g, 0, 1450, -1, 140), M.points.good);
  assert.equal(g.lanes[0].hits[0].at, 1450);
  assert.equal(g.lanes[0].hits[0].slot, 0, "the aim the shot was pressed with, not the aim now");
  // 300 ms late: judged 150 ms before the server's clock.
  const g2 = shooting(2, waves([T_, T_, T_]));
  assert.equal(shoot(g2, 1, 1400, 0, 300), M.points.slow);
  near(g2.lanes[1].hits[0].at, g2.elapsedMs - M.aimToleranceMs, 1e-9);
  // A stamp ahead of the server's clock is held to aheadMs.
  const g3 = shooting(2, waves([T_, T_, T_]));
  stepTo(g3, 1100);
  g3.step([undefined, { aim: 0, fired: 1, shots: [{ at: 1900, aim: 0 }] }]);
  near(g3.lanes[1].hits[0].at, g3.elapsedMs + M.aheadMs, 1e-9);
});

test("cooldown: two shots at least 0.12 s apart on the shooter's clock; a repeated packet counts once; bunched packets lose no shot", () => {
  const g = shooting(2, waves([T_, T_, T_], [T_, T_, T_]));
  assert.equal(shoot(g, 0, 1100, -1), M.points.good);
  assert.equal(shoot(g, 0, 1100 + M.cooldownMs - 1, 0), null, "too soon");
  assert.equal(shoot(g, 0, 1100 + M.cooldownMs, 0), M.points.good, "0.12 s later");
  const fired = g.lanes[0].fired,
    shots = g.lanes[0].shots;
  // The same packet again: nothing new.
  g.step([{ aim: 0, fired, shots: [{ at: 1220, aim: 0 }] }]);
  assert.equal(g.lanes[0].shots, shots);
  // Three shots in one packet (two packets got lost or bunched): all of them, in order, each at its stamp.
  stepTo(g, 3545, { 1: [{ at: 3300, aim: -1 }, { at: 3420, aim: 0 }, { at: 3540, aim: 1 }] });
  assert.equal(g.lanes[1].shots, 3);
  assert.deepEqual(g.lanes[1].hits.map((h) => [h.slot, h.points]), [[0, 5], [1, 5], [2, 2]]);
  // A packet whose older shots were already counted: only the new one (shot 4).
  const before = g.lanes[1].shots;
  stepTo(g, 3700);
  g.step([undefined, { aim: 1, fired: 4, shots: [{ at: 3420, aim: 0 }, { at: 3540, aim: 1 }, { at: 3690, aim: -1 }] }]);
  assert.equal(g.lanes[1].shots, before + 1);
  assert.equal(g.lanes[1].shotAt, 3690);
  assert.equal(g.lanes[1].score, 12, "the left one again: a miss");
});

test("countdown and time: a shot before BAŞLA or at 45 s does not count; one pressed before 45 s arriving late still does; the round ends 150 ms after", () => {
  const list = [...waves([T_, T_, T_]), { open: LIMIT - 1000, close: LIMIT, kinds: [T_, T_, T_] as SlotKind[] }],
    last = list[list.length - 1],
    g = new MarksmanGame(2, mulberry32(5), list);
  g.step([{ aim: -1, fired: 1, shots: [{ at: -500, aim: -1 }] }]);
  assert.equal(g.lanes[0].shots, 0, "countdown");
  assert.equal(g.lanes[0].aim, -1, "the aim moves in the countdown");
  while (g.phase === "countdown") g.step();
  const at = last.close - 10;
  stepTo(g, LIMIT + 100, { 0: [{ at, aim: 0 }] });
  assert.equal(g.phase, "shooting", "waits for late shots");
  assert.equal(g.lanes[0].hits.length, 1, "pressed in time, arrived after 45 s");
  stepTo(g, LIMIT + 120, { 1: [{ at: LIMIT + 5, aim: 0 }] });
  assert.equal(g.lanes[1].shots, 0, "pressed after the time");
  while (g.phase === "shooting") g.step();
  near(g.elapsedMs, LIMIT + M.aimToleranceMs, MS);
});

test("results: the most points wins, equal scores share a place and a tie for first draws; a leaver ranks last; the last player left wins at once", () => {
  const g = shooting(3, waves([T_, T_, T_], [T_, T_, T_]));
  shoot(g, 0, 1100, 0);
  shoot(g, 1, 1100, 0);
  shoot(g, 2, 1800, 0);
  while (g.phase === "shooting") g.step();
  assert.deepEqual(g.places(), [0, 0, 2]);
  assert.equal(g.winner(), -1, "5 = 5: a draw");
  const h = shooting(3, waves([T_, T_, T_], [T_, T_, T_]));
  shoot(h, 2, 1200, -1);
  shoot(h, 2, 1400, 1);
  shoot(h, 1, 1800, 0);
  h.remove(2);
  h.step();
  assert.equal(h.phase, "shooting", "two still in");
  assert.deepEqual(h.places(), [1, 0, 2], "the leaver last despite 10 points");
  shoot(h, 0, 3100, 0);
  h.remove(1);
  h.step();
  assert.equal(h.phase, "results");
  assert.equal(h.winner(), 0, "the last one left");
});

test("bots really play: Zor scores most, Kolay least and gets knocked out most often; all of them aim where they shoot", () => {
  const stats = {} as Record<MarksmanBotLevel, { score: number; bombs: number; good: number; slow: number; out: number }>;
  const ROUNDS = 40;
  for (const level of MARKSMAN_BOT_LEVELS) {
    const r = (stats[level] = { score: 0, bombs: 0, good: 0, slow: 0, out: 0 });
    for (let seed = 0; seed < ROUNDS; seed++) {
      const random = mulberry32(300 + seed),
        g = new MarksmanGame(2, random),
        bot = new MarksmanBot(level, random),
        l = g.lanes[0];
      let fired = 0,
        recent: MarksmanShot[] = [];
      while (g.phase !== "results") {
        const due = g.elapsedMs + MS,
          view = { playing: g.phase === "shooting" && g.standing(0), waves: g.waves.flatMap((wave, id) => (wave.open <= due ? [{ id, wave }] : [])), stunUntil: l.stunUntil };
        for (const shot of bot.next(view, due)) {
          assert.equal(bot.aim(shot.at), shot.aim, "the laser points where it fires");
          fired++;
          recent = [...recent, shot].slice(-3);
        }
        g.step([{ aim: bot.aim(due), fired, shots: recent }]);
      }
      r.score += l.score / ROUNDS;
      r.bombs += l.bombs / ROUNDS;
      r.good += l.good / ROUNDS;
      r.slow += l.slow / ROUNDS;
      r.out += +(l.diedAt >= 0) / ROUNDS;
    }
  }
  const { easy, medium, hard } = stats;
  assert.ok(hard.score > medium.score + 25 && medium.score > easy.score + 25, JSON.stringify(stats));
  assert.ok(easy.out > 0.5 && medium.out < 0.4 && hard.out < 0.12 && easy.out > medium.out && medium.out > hard.out, `knocked out: Kolay ${easy.out}, Orta ${medium.out}, Zor ${hard.out}`);
  assert.ok(hard.bombs < 0.3, `Zor ${hard.bombs.toFixed(2)}`);
  assert.ok(hard.good > hard.slow * 3 && easy.slow > easy.good * 3, "Zor quick, Kolay slow");
});

test("the round simulation: player counts, slots (not seats) as winner, placements per slot, a dropped player's aim back to the middle", () => {
  const sim = new MarksmanRoundSimulation(undefined, 21);
  assert.equal(MODE_NAMES.marksman, "Nişancı");
  assert.deepEqual(MODE_PLAYERS.marksman, { min: 2, max: 3 });
  assert.equal(sim.start([1]), false);
  assert.equal(sim.start([0, 1, 2, 3] as never), false);
  assert.equal(sim.start([2, 1]), true);
  assert.deepEqual(sim.seats, [1, 2]);
  const inputs = PLAYERS.map(() => ({ x: 0, z: 0, jump: false }));
  sim.step(inputs.map((input, slot) => (slot === 1 ? { ...input, marksman: { seq: 1, round: sim.roundId, aim: -1, fired: 0, shots: [] } } : input)));
  assert.equal(sim.game.lanes[0].aim, -1);
  sim.neutralize(1);
  assert.equal(sim.game.lanes[0].aim, 0, "dropped: back to the middle");
  while (sim.phase !== "playing") sim.step([]);
  // Slot 2 (lane 1) hits the first target in time through a real packet.
  const g = sim.game,
    w = g.waves.find((x) => x.kinds.includes(TARGET))!,
    slot = w.kinds.findIndex((k) => k === TARGET);
  while (g.elapsedMs < w.open + 100) sim.step([]);
  sim.step(inputs.map((input, s) => (s === 2 ? { ...input, marksman: { seq: 2, round: sim.roundId, aim: slot - 1, fired: 1, shots: [w.open + 100, slot - 1] } } : input)));
  assert.equal(g.lanes[1].score, M.points.good);
  sim.remove(1);
  sim.step([]);
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2, "the winning lane's slot");
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.v, 21);
  assert.equal(snap.mode, "marksman");
  assert.equal(snap.winner, 2);
  assert.ok(validMarksmanWire(snap.marksman));
  assert.equal(snap.transforms.byteLength, 0);
  assert.deepEqual(wireHits(snap.marksman!, 1).map((h) => h.points), [M.points.good]);
  for (let i = 0; i < M.results * M.hz + 2; i++) sim.step([]);
  assert.equal(sim.phase, "waiting");
  assert.equal(sim.start([0, 1, 2]), true, "3 players");
  assert.equal(sim.game.lanes.length, 3);
});

test("the wire: the waves go out 0.5 s before they open and stay 1.5 s after they close; well formed, refused when malformed", () => {
  const g = shooting(3, undefined, 2),
    w = g.waves[3];
  while (g.elapsedMs < w.open - M.leadMs - 20) g.step();
  assert.ok(!wireWaves(marksmanSection(g, [0, 1, 2])).some((x) => x.id === 3), "not yet");
  while (g.elapsedMs < w.open - M.leadMs) g.step();
  const sent = wireWaves(marksmanSection(g, [0, 1, 2])).find((x) => x.id === 3);
  assert.deepEqual(sent && { open: sent.open, close: sent.close, kinds: sent.kinds }, w, "before it opens, exactly");
  while (g.elapsedMs <= w.close + M.keepMs) g.step();
  assert.ok(!wireWaves(marksmanSection(g, [0, 1, 2])).some((x) => x.id === 3), "gone after keepMs");
  const wire = marksmanSection(g, [0, 1, 2]);
  assert.ok(validMarksmanWire(wire));
  assert.ok(validMarksmanWire(JSON.parse(JSON.stringify(wire))));
  for (const bad of [{ ...wire, aim: wire.aim.map(() => 2) }, { ...wire, lives: wire.lives.map(() => 3) }, { ...wire, diedAt: wire.diedAt.slice(1) }, { ...wire, waveKinds: wire.waveKinds.slice(1) }, { ...wire, phase: "mining" }, { ...wire, seats: [0] }, { ...wire, hitSlot: [3], hitLane: [0], hitWave: [0], hitAt: [1], hitPoints: [5] }, null])
    assert.equal(validMarksmanWire(bad), false);
});

test("mailbox: the newest packet waits for the next step, however late; strict packets", () => {
  const box = new InputMailbox();
  assert.equal(box.accept({ seq: 1, round: 2, aim: -1, fired: 1, shots: [50, -1] }, 2, 0, "marksman"), true);
  assert.equal(box.accept({ seq: 1, round: 2, aim: 0, fired: 2, shots: [60, 0] }, 2, 0, "marksman"), false, "replayed seq");
  assert.equal(box.accept({ seq: 2, round: 1, aim: 0, fired: 2, shots: [60, 0] }, 2, 0, "marksman"), false, "old round");
  assert.equal(box.accept({ seq: 2, round: 2, drop: 2, at: 60 }, 2, 0, "marksman"), false, "another mode's packet");
  const read = box.read(10_000).marksman!;
  assert.deepEqual(read, { seq: 1, round: 2, aim: -1, fired: 1, shots: [50, -1] });
  assert.deepEqual(packetShots(read), [{ at: 50, aim: -1 }]);
  assert.equal(box.processedSeq, 1);
  assert.equal(box.read(10_001).marksman, undefined, "read once");
  for (const bad of [
    { seq: 4, round: 2, aim: 2, fired: 0, shots: [] },
    { seq: 4, round: 2, aim: 0, fired: 1, shots: [1] },
    { seq: 4, round: 2, aim: 0, fired: 1, shots: [NaN, 0] },
    { seq: 4, round: 2, aim: 0, fired: 1, shots: [1, 3] },
    { seq: 4, round: 2, aim: 0, fired: 0, shots: [1, 0] },
    { seq: 4, round: 2, aim: 0, fired: 9, shots: [1, 0, 2, 0, 3, 0, 4, 0] },
    { seq: 4, round: 2, aim: 0, fired: 1.5, shots: [] },
    { seq: 4, round: 2, aim: 0, fired: 1, shots: [1, 0], x: 1 },
    [1],
  ])
    assert.equal(validateMarksmanInput(bad), null, JSON.stringify(bad));
});

test("Nişancı is in Mixed, in the board's mini games and in the Yerel Test Arenası for 2 and 3 players", () => {
  assert.ok(GAME_MODES.includes("marksman"));
  assert.ok(LOCAL_ARENA_IDS.includes("marksman"));
  for (const count of [2, 3]) {
    assert.ok(modeFits("marksman", count));
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("marksman"), `Mixed ${count}P`);
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
    assert.ok(minis.includes("marksman"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
  assert.ok(!modeFits("marksman", 1) && !modeFits("marksman", 4));
});

function near(a: number, b: number, eps: number, what = "") {
  assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≉ ${b} (±${eps})`);
}

/* A real room: shots in the countdown are dropped, a stamped shot is judged at its stamp and aim,
   a dropped player's waves keep coming and they shoot again once back, the time ends it. */
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
    fired = 0,
    recent: number[] = [];
  return {
    r,
    snapshots,
    /** Sends the aim and, with `at`, one more shot (repeating the latest ones like the browser). */
    send: (round: number, aim: number, at?: number) => {
      if (at !== undefined) {
        fired++;
        recent = [...recent, at, aim].slice(-6);
      }
      r.send("input", { seq: ++seq, round, aim, fired, shots: recent });
    },
    renumber: (n: number) => {
      fired = n;
      recent = [];
    },
  };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "marksman");
  await until(() => room.selection === "marksman");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as MarksmanRoundSimulation;
  assert.ok(sim instanceof MarksmanRoundSimulation);
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
  test(`room ${count}P: countdown shots refused, stamped shots judged at their stamp and aim, a dropped player's waves keep coming, back and shooting, 45 s ends it`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    const g = sim.game;
    // The room takes no input before BAŞLA (the browser keeps its aim and sends it right after).
    peers[0].send(sim.roundId, 1, 0);
    await until(() => room.game.phase === "playing");
    await pause(60);
    assert.equal(g.lanes[lane(peers[0])].shots, 0, "a shot sent during the countdown");
    assert.equal(g.lanes[lane(peers[0])].aim, 0);
    peers[0].send(sim.roundId, 1);
    await until(() => g.lanes[lane(peers[0])].aim === 1);
    assert.equal(g.lanes[lane(peers[0])].fired, 1, "the countdown shot is numbered past, never counted");
    /** Peer `i` shoots the first target of the next wave 0.3 s after it opens, stamped as the browser does. */
    const hit = async (i: number) => {
      const l = g.lanes[lane(peers[i])],
        id = g.waves.findIndex((w) => w.open > g.elapsedMs + 60),
        w = g.waves[id],
        slot = w.kinds.findIndex((k) => k === TARGET),
        at = w.open + 300,
        score = l.score;
      assert.ok(slot >= 0, "every wave of these seeds has a target (a lone bomb skipped below)");
      await until(() => g.elapsedMs >= at);
      peers[i].send(sim.roundId, slot - 1, at);
      peers[i].send(sim.roundId, slot - 1);
      await until(() => l.score !== score);
      assert.equal(l.score - score, M.points.good, "+5 at its stamp");
      assert.deepEqual(l.hits.at(-1), { wave: id, slot, at, points: M.points.good });
    };
    const skipLoneBombs = () => {
      while (true) {
        const next = g.waves.find((w) => w.open > g.elapsedMs + 60);
        if (!next || next.kinds.some((k) => k === TARGET)) return;
        g.ticks = Math.ceil(next.open / MS);
      }
    };
    skipLoneBombs();
    await hit(0);
    skipLoneBombs();
    await hit(1);
    // A dropped player's waves keep coming; back, they shoot again (numbering on from the server's count).
    const l1 = lane(peers[1]),
      r = peers[1].r,
      id = r.sessionId;
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    const at = g.elapsedMs;
    await until(() => g.elapsedMs > at + 300);
    assert.equal(room.game, sim, "the round goes on");
    await until(() => room.state.players.get(id)!.connected);
    peers[1].renumber(g.lanes[l1].fired);
    skipLoneBombs();
    await hit(1);
    if (count === 3) {
      skipLoneBombs();
      await hit(2);
    }
    // To the end of the time.
    g.ticks = g.limitTicks - 5;
    await until(() => room.game.phase === "results", 3000);
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(1), "10 points against 5");
    const places = sim.placements();
    assert.equal(places[slot(1)], 0);
    assert.equal(places[slot(0)], 1);
    if (count === 3) assert.equal(places[slot(2)], 1, "5 = 5 share a place");
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 21);
    assert.ok(validMarksmanWire(shown.marksman));
    assert.equal(shown.winner, slot(1));
    assert.equal(shown.marksman!.score[l1], 10);
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

test("room 2P: two bombs through real packets knock a player out, the other wins straight after", { timeout: 30000 }, async () => {
  const { peers, room, sim, lane } = await lobby(2);
  await until(() => room.game.phase === "playing");
  const g = sim.game,
    l = g.lanes[lane(peers[0])];
  /** Peer 0 shoots the next bomb opening after `after`, 0.2 s after it opens (skipping ahead to it). */
  const bomb = async (after: number, n: number) => {
    const w = g.waves.find((x) => x.open > after && x.kinds.includes(BOMB))!,
      slot = w.kinds.indexOf(BOMB),
      at = w.open + 200;
    if (g.elapsedMs < w.open - 300) g.ticks = Math.ceil((w.open - 300) / MS);
    await until(() => g.elapsedMs >= at);
    peers[0].send(sim.roundId, slot - 1, at);
    await until(() => l.bombs >= n);
    return at;
  };
  const first = await bomb(g.elapsedMs + 100, 1);
  assert.deepEqual([l.lives, l.diedAt, l.stunUntil], [1, -1, first + M.stunMs]);
  const second = await bomb(first + M.stunMs + 50, 2);
  assert.deepEqual([l.lives, l.diedAt], [0, second]);
  await until(() => room.game.phase === "results", 2000);
  near(g.elapsedMs, second + M.aimToleranceMs, 2 * MS);
  const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
  assert.equal(room.state.winner, slot(1));
  assert.equal(sim.placements()[slot(0)], 1);
  await until(() => peers[1].snapshots.at(-1)?.phase === "results");
  const shown = peers[1].snapshots.at(-1)!.marksman!;
  assert.deepEqual([shown.lives[lane(peers[0])], shown.diedAt[lane(peers[0])]], [0, second]);
  await close(peers);
});
