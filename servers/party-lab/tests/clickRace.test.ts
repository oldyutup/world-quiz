/**
 * Tıklama Yarışı: the counting rules (engine), the input path (mailbox) and a real room.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { ClickRaceGame } from "../../../shared/party-lab/simulation/clickrace/game.js";
import { CLICK_RACE as C } from "../../../shared/party-lab/simulation/clickrace/config.js";
import { clickSection, validClickWire } from "../../../shared/party-lab/simulation/clickrace/wire.js";
import { ClickRoundSimulation } from "../../../shared/party-lab/simulation/clickRound.js";
import { validateClickInput } from "../../../shared/party-lab/network/clickInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { IDLE_INPUT } from "../../../shared/party-lab/simulation/physics.js";
import { PLAYERS } from "../../../shared/party-lab/simulation/players.js";

const STEP_MS = 1000 / C.hz;
/** A race just past its countdown. */
function racing(lanes = 2) {
  const g = new ClickRaceGame(lanes);
  while (g.phase === "countdown") g.step();
  return g;
}
/** Steps the race for `seconds`; `presses(lane, ms)` gives each lane's stamps per step. */
function run(g: ClickRaceGame, seconds: number, presses: (lane: number, ms: number) => number[]) {
  for (let t = 0; t < seconds * C.hz && g.phase === "racing"; t++) {
    const ms = (g.ticks + 1) * STEP_MS;
    g.step(g.lanes.map((_, lane) => presses(lane, ms)));
  }
}
/** One press every `1000 / rate` ms on the clicker's clock: the presses of the step ending at `ms`. */
const every = (rate: number) => (ms: number) => {
  const tick = Math.round(ms / STEP_MS),
    upTo = (t: number) => Math.floor((t * rate) / C.hz + 1e-9),
    out: number[] = [];
  for (let k = upTo(tick - 1) + 1; k <= upTo(tick); k++) out.push((k * 1000) / rate);
  return out;
};

/** Steps one lane pressing at `rate` until it finishes (or the race ends); its finish in seconds. */
function finishAt(rate: number) {
  const g = racing();
  run(g, C.limit + 1, (lane, ms) => (lane === 0 ? every(rate)(ms) : []));
  return g.lanes[0].finish === null ? Infinity : g.lanes[0].finish / 1000;
}
/** Places a car just before the line: half of what one press moves it in a step, so it finishes. */
const nearLine = (g: ClickRaceGame, lane: number) => g.setDistance(lane, g.track - C.pressSpeed / C.hz / 2);

test("driving: about 9 presses a second finish in 7–8 s, about 12 in 5–6 s; the limit is 30 s", () => {
  assert.equal(C.limit, 30);
  const slow = finishAt(6),
    average = finishAt(9),
    fast = finishAt(12);
  assert.ok(average >= 7 && average <= 8, `9/s: ${average} s`);
  assert.ok(fast >= 5 && fast <= 6, `12/s: ${fast} s`);
  assert.ok(slow > average + 2 && slow < C.limit, `6/s: ${slow} s`);
  // Faster pressing means a faster car.
  const g = racing(3);
  run(g, 3, (lane, ms) => every([6, 9, 12][lane])(ms));
  assert.ok(g.lanes[0].distance < g.lanes[1].distance && g.lanes[1].distance < g.lanes[2].distance, `${g.lanes.map((l) => l.distance.toFixed(1))}`);
});

/** Lets lane 0 go: when it is below 0.3 m/s, when it stops (s) and how far it glides (m). */
function letGo(g: ClickRaceGame) {
  const from = g.lanes[0].distance,
    speed = g.lanes[0].speed;
  let stopped = -1,
    slow = -1;
  for (let t = 1; t <= 5 * C.hz && stopped < 0; t++) {
    g.step();
    if (t === 1) assert.ok(g.lanes[0].speed > speed * 0.9 && g.lanes[0].distance > from, "still rolling right after the last press");
    if (t === C.hz) assert.ok(g.lanes[0].speed > 0, "still rolling a second later");
    if (slow < 0 && g.lanes[0].speed < 0.3) slow = t / C.hz;
    if (g.lanes[0].speed === 0) stopped = t / C.hz;
  }
  return { speed, slow, stopped, glided: g.lanes[0].distance - from };
}

test("let go at top speed, the car glides about 2 s and stops; never at once", () => {
  const top = racing();
  run(top, 3, (lane, ms) => (lane === 0 ? every(25)(ms) : []));
  const fast = letGo(top);
  assert.ok(fast.speed > 9, `top speed ${fast.speed} m/s`);
  assert.ok(fast.stopped >= 1.8 && fast.stopped <= 2.2, `stopped after ${fast.stopped} s`);
  assert.ok(fast.slow >= 1.3 && fast.slow <= 1.9, `below 0.3 m/s after ${fast.slow} s`);
  assert.ok(fast.glided > 3 && fast.glided < 7, `glided ${fast.glided} m`);
  // From an average player's cruise it glides a little less.
  const cruise = racing();
  run(cruise, 3, (lane, ms) => (lane === 0 ? every(9)(ms) : []));
  const average = letGo(cruise);
  assert.ok(average.stopped >= 1.3 && average.stopped < fast.stopped, `cruise stopped after ${average.stopped} s`);
});

test("pressing in bursts (1 s on, 0.5 s off) still finishes in a fair time; the car rolls on in the rests", () => {
  const on = (ms: number) => ms % 1500 < 1000;
  const g = racing();
  let restMoves = 0,
    restStops = 0;
  run(g, C.limit + 1, (lane, ms) => {
    if (lane !== 0) return [];
    if (!on(ms) && g.lanes[0].finish === null) {
      if (g.lanes[0].speed > 0) restMoves++;
      else restStops++;
    }
    return on(ms) ? every(9)(ms) : [];
  });
  const seconds = g.lanes[0].finish! / 1000,
    steady = finishAt(9);
  assert.ok(g.lanes[0].finish !== null, "finished");
  assert.ok(seconds < 12.5 && seconds < 1.6 * steady, `bursts of 9/s: ${seconds} s (steady 9/s: ${steady} s)`);
  assert.equal(restStops, 0, "never stops in a half-second rest");
  assert.ok(restMoves > 0);
});

test("there is a top speed: past about 15/s, faster pressing hardly helps", () => {
  const g = racing();
  let top = 0;
  for (let t = 0; t < 3 * C.hz; t++) {
    g.step([every(25)((g.ticks + 1) * STEP_MS), []]);
    top = Math.max(top, g.lanes[0].speed);
  }
  assert.ok(top <= C.maxSpeed, `top ${top} m/s`);
  assert.ok(finishAt(25) > finishAt(15) - 0.5, `25/s ${finishAt(25)} s vs 15/s ${finishAt(15)} s`);
});

test("each press counts once and pushes the car; a finished car takes no more presses", () => {
  const g = racing(2);
  g.step([[10], []]);
  assert.equal(g.lanes[0].clicks, 1);
  assert.ok(g.lanes[0].speed > 0 && g.lanes[0].distance > 0, "pushed");
  assert.equal(g.lanes[1].distance, 0);
  g.step([[20, 30], [25]]);
  assert.deepEqual(g.lanes.map((l) => l.clicks), [3, 1]);
  nearLine(g, 0);
  g.step([[g.elapsedMs + STEP_MS], []]);
  assert.ok(g.lanes[0].finish !== null && Math.abs(g.lanes[0].finish - g.elapsedMs) <= STEP_MS, `finish at ${g.lanes[0].finish} ms`);
  const clicks = g.lanes[0].clicks;
  g.step([[g.elapsedMs], []]);
  assert.equal(g.lanes[0].clicks, clicks, "a finished car takes no presses");
  assert.equal(g.phase, "racing", "the race goes on until everyone finishes");
});

test("presses before BAŞLA never count", () => {
  const g = new ClickRaceGame(2);
  for (let t = 0; g.phase === "countdown"; t++) {
    assert.equal(g.click(0, 0), false);
    g.step([[0, 1, 2], [0]]);
  }
  assert.deepEqual(g.lanes.map((l) => [l.clicks, l.distance, l.speed]), [[0, 0, 0], [0, 0, 0]], "countdown presses");
  assert.equal(g.ticks, 0);
  g.step([[-1, -200], [5]]);
  assert.deepEqual(g.lanes.map((l) => l.clicks), [0, 1], "a stamp before BAŞLA (negative) is not a race press");
  assert.equal(g.lanes[0].distance, 0);
  // The room drops input outside play as well (PartyRoom "input" handler); see the room test.
});

test("at most 25 presses count in any second; the rest are ignored without a penalty", () => {
  const g = racing(2);
  run(g, 3, (lane, ms) => every(lane === 0 ? 40 : 20)(ms));
  const [fast, steady] = g.lanes;
  assert.ok(fast.clicks <= 3 * C.maxRate + 1 && fast.clicks >= 3 * C.maxRate - 1, `40/s for 3 s counted ${fast.clicks}`);
  assert.ok(fast.dropped > 0);
  assert.equal(fast.peak, C.maxRate);
  assert.equal(steady.clicks, 60, "20/s is untouched");
  assert.equal(steady.dropped, 0);
  // No penalty: back to a human pace, every press counts again.
  const before = fast.clicks;
  run(g, 1, (lane, ms) => (lane === 0 ? every(10)(ms) : []));
  assert.equal(fast.clicks - before, 10);
});

test("presses a stalled link delivers late move the car as if they came on time", () => {
  // Two players press the same; one link stalls for 1.5 s and then delivers 13 presses at once
  // (exact up to CLICK_RACE.catchUpMs).
  const g = racing(2),
    held: number[] = [];
  run(g, 3, (lane, ms) => {
    const now = every(9)(ms);
    if (lane === 0) return now;
    if (ms > 1000 && ms <= 2500) {
      held.push(...now);
      return [];
    }
    return [...held.splice(0), ...now];
  });
  assert.equal(g.lanes[1].dropped, 0);
  assert.equal(g.lanes[1].clicks, g.lanes[0].clicks);
  assert.ok(Math.abs(g.lanes[1].distance - g.lanes[0].distance) < 1e-9 && Math.abs(g.lanes[1].speed - g.lanes[0].speed) < 1e-9, `${g.lanes[0].distance} vs ${g.lanes[1].distance}`);
  // A burst within one real second still hits the cap: 40 presses stamped 1 ms apart.
  const h = racing(2);
  run(h, 1, () => []);
  h.step([Array.from({ length: 40 }, (_, i) => 500 + i), []]);
  assert.equal(h.lanes[0].clicks, C.maxRate);
  // A ping does not slow a car: presses arriving 200 ms after they were made count from then.
  const p = racing(2);
  const late: number[][] = [];
  run(p, 4, (lane, ms) => {
    const now = every(10)(ms);
    if (lane === 0) return now;
    late.push(now);
    return late.length > 12 ? late.shift()! : [];
  });
  p.step([[], late.flat()]);
  assert.equal(p.lanes[1].clicks, p.lanes[0].clicks);
  assert.ok(Math.abs(p.lanes[0].distance - p.lanes[1].distance) < 1e-9, `a 200 ms ping: ${p.lanes[0].distance} vs ${p.lanes[1].distance} m`);
});

test("forged or batched stamps buy nothing", () => {
  const g = racing(2);
  // Every step claims a whole second of presses ahead of now, 40 per step.
  run(g, 10, (lane, ms) => (lane === 0 ? Array.from({ length: 40 }, (_, i) => ms + i * 25) : []));
  const seconds = g.ticks / C.hz;
  assert.ok(g.lanes[0].clicks <= C.maxRate * (seconds + C.aheadMs / 1000) + 1, `${g.lanes[0].clicks} in ${seconds} s`);
  for (let i = 1; i < g.lanes[0].stamps.length; i++) assert.ok(g.lanes[0].stamps[i] >= g.lanes[0].stamps[i - 1]);
  assert.ok(g.lanes[0].stamps.at(-1)! <= g.elapsedMs + C.aheadMs);
  // Old stamps (replayed from earlier) land at the newest counted time, inside the window.
  const h = racing(2);
  run(h, 2, () => []);
  h.step([Array.from({ length: 60 }, () => 0), []]);
  assert.equal(h.lanes[0].clicks, C.maxRate);
  // Pressing at the cap but sending a second's worth at a time: no further than sending each.
  const b = racing(2),
    batch: number[] = [];
  run(b, 4, (lane, ms) => {
    const now = every(25)(ms);
    if (lane === 0) return now;
    batch.push(...now);
    return Math.round(ms) % 1000 < STEP_MS ? batch.splice(0) : [];
  });
  b.step([[], batch.splice(0)]);
  assert.ok(b.lanes[1].distance <= b.lanes[0].distance + 1e-6, `batched ${b.lanes[1].distance} m vs ${b.lanes[0].distance} m`);
});

test("time limit: the furthest car wins; places by finish time, then distance", () => {
  const g = racing(3);
  run(g, C.limit + 1, (lane, ms) => every([2, 1.5, 1][lane])(ms));
  assert.equal(g.phase, "results");
  assert.equal(g.ticks, C.limit * C.hz);
  assert.deepEqual(g.lanes.map((l) => l.finish), [null, null, null]);
  assert.deepEqual(g.places(), [0, 1, 2]);
  assert.equal(g.winner(), 0);
  // Finishers first in finish order, then the rest by distance.
  const h = racing(3);
  nearLine(h, 2);
  h.step([[], [], [h.elapsedMs + STEP_MS]]);
  nearLine(h, 1);
  h.step([[h.elapsedMs + STEP_MS], [h.elapsedMs + STEP_MS], []]);
  run(h, C.limit + 1, () => []);
  assert.deepEqual(h.places(), [2, 1, 0]);
  assert.equal(h.winner(), 2);
  const section = clickSection(h, [0, 1, 2]);
  assert.ok(validClickWire(section));
  assert.ok(section.finish[0] === -1 && section.finish[2] < section.finish[1], `${section.finish}`);
  assert.equal(section.time[0], C.limit * 1000);
});

test("a full tie is a draw, at the finish or at the time limit", () => {
  const g = racing(2);
  for (const lane of [0, 1]) nearLine(g, lane);
  g.step([[g.elapsedMs + STEP_MS], [g.elapsedMs + STEP_MS]]);
  assert.equal(g.phase, "results", "everyone finished");
  assert.deepEqual(g.places(), [0, 0]);
  assert.equal(g.winner(), -1);
  const h = racing(3);
  run(h, C.limit + 1, (lane, ms) => (lane < 2 ? every(1)(ms) : every(0.5)(ms)));
  assert.deepEqual(h.places(), [0, 0, 2]);
  assert.equal(h.winner(), -1);
  const idle = racing(2);
  run(idle, C.limit + 1, () => []);
  assert.equal(idle.winner(), -1, "nobody pressed");
});

test("2, 3 and 6 lanes race, rank and report every lane", () => {
  for (const lanes of [2, 3, 6]) {
    const g = racing(lanes);
    // Lane i presses at 6 + i per second: the last lane is fastest.
    run(g, 60, (lane, ms) => every(6 + lane)(ms));
    assert.equal(g.phase, "results", `${lanes} lanes`);
    assert.deepEqual(g.places(), g.lanes.map((_, lane) => lanes - 1 - lane));
    assert.equal(g.winner(), lanes - 1);
    const section = clickSection(g, g.lanes.map((_, i) => i));
    assert.ok(validClickWire(section));
    assert.equal(section.distance.length, lanes);
  }
  assert.throws(() => new ClickRaceGame(1));
  assert.throws(() => new ClickRaceGame(7));
});

test("a player who leaves stops and ranks last; the last player racing wins at once", () => {
  const g = racing(3);
  run(g, 2, (lane, ms) => every(lane === 0 ? 12 : 4)(ms));
  const left = g.lanes[0].distance;
  g.remove(0);
  g.step([[2100], [], []]);
  assert.equal(g.lanes[0].distance, left, "a car that left stops");
  assert.equal(g.phase, "racing", "two still race");
  g.remove(2);
  g.step();
  assert.equal(g.phase, "results");
  assert.equal(g.winner(), 1);
  assert.deepEqual(g.places(), [1, 0, 2], "leavers behind the stayer, by distance");
});

test("a dropped player's car glides to a stop and moves on when they are back", () => {
  const g = racing(2);
  run(g, 1, (_, ms) => every(10)(ms));
  run(g, 2.5, (lane, ms) => (lane === 1 ? every(10)(ms) : []));
  const parked = g.lanes[0].distance;
  assert.equal(g.lanes[0].speed, 0, "stopped while away");
  run(g, 1, (lane, ms) => (lane === 1 ? every(10)(ms) : []));
  assert.equal(g.lanes[0].distance, parked, "stays put");
  run(g, 1, (_, ms) => every(10)(ms));
  assert.ok(g.lanes[0].distance > parked + 2, "back: it moves on");
});

test("the round simulation: player counts, slots (not seats) as winner, placements per slot", () => {
  const sim = new ClickRoundSimulation();
  assert.equal(sim.start([0]), false);
  assert.ok(MODE_PLAYERS.click_race.min === 2 && MODE_PLAYERS.click_race.max === 3);
  assert.ok(sim.start([2, 1]));
  assert.equal(sim.phase, "countdown");
  const idle = PLAYERS.map(() => IDLE_INPUT);
  const press = (slot: number, stamps: number[]) => PLAYERS.map((p) => (p.id === slot ? { ...IDLE_INPUT, click: { seq: 1, round: 1, stamps } } : IDLE_INPUT));
  while (sim.phase === "countdown") sim.step(press(2, [0]));
  assert.equal(sim.phase, "playing");
  assert.deepEqual(sim.game.lanes.map((l) => l.clicks), [0, 0], "countdown presses");
  nearLine(sim.game, 1);
  sim.step(press(2, [sim.game.elapsedMs + STEP_MS]));
  nearLine(sim.game, 0);
  sim.step(press(1, [sim.game.elapsedMs + STEP_MS]));
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2, "slot 2 finished first");
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.winner, 2);
  assert.ok(validClickWire(snap.click));
  assert.equal(snap.transforms.byteLength, 0);
  for (let t = 0; t < C.results * C.hz + 1; t++) sim.step(idle);
  assert.equal(sim.phase, "waiting");
});

test("mailbox: presses queue across packets until a step counts them; never dropped as stale", () => {
  const box = new InputMailbox();
  assert.equal(box.accept({ seq: 1, round: 2, stamps: [5] }, 2, 0, "click_race"), true);
  assert.equal(box.accept({ seq: 2, round: 2, stamps: [9, 12] }, 2, 1, "click_race"), true);
  assert.equal(box.accept({ seq: 2, round: 2, stamps: [13] }, 2, 1, "click_race"), false, "replayed seq");
  assert.equal(box.accept({ seq: 3, round: 1, stamps: [13] }, 2, 1, "click_race"), false, "old round");
  assert.deepEqual(box.read(10_000).click?.stamps, [5, 9, 12], "read long after arrival");
  assert.equal(box.processedSeq, 2);
  assert.equal(box.read(10_001).click, undefined, "counted once");
  for (const bad of [{ seq: 4, round: 2, stamps: [] }, { seq: 4, round: 2, stamps: [NaN] }, { seq: 4, round: 2, stamps: Array(33).fill(1) }, { seq: 4, round: 2, stamps: [1], x: 1 }, { seq: 4, round: 2, stamps: "1" }])
    assert.equal(validateClickInput(bad), null, JSON.stringify(bad));
});

test("Tıklama Yarışı is in Mixed and in the board's mini games for 2 and 3 players", () => {
  for (const count of [2, 3]) {
    assert.ok(modeFits("click_race", count));
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("click_race"), `Mixed ${count}P`);
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
    assert.ok(minis.includes("click_race"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
  assert.ok(!modeFits("click_race", 1) && !modeFits("click_race", 4));
});

/* A real room: the room drops presses outside play, counts stamped bursts, keeps a dropped
   player's car, hands the round to the stayer, and reports the finish order. */
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
  let seq = 0;
  return { r, snapshots, press: (stamps: number[], round: number) => r.send("input", { seq: ++seq, round, stamps }) };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "click_race");
  await until(() => room.selection === "click_race");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as ClickRoundSimulation;
  assert.ok(sim instanceof ClickRoundSimulation);
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
  test(`room ${count}P: countdown presses dropped, bursts counted, reconnect, finish order`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    peers[0].press([0, 1, 2], sim.roundId);
    await pause(60);
    await until(() => room.game.phase === "playing");
    await pause(60);
    assert.equal(sim.game.lanes[lane(peers[0])].clicks, 0, "presses sent during the countdown");
    // Ten single presses, then a stalled-link burst of 30 presses stamped over 2 s.
    for (let i = 0; i < 10; i++) peers[0].press([i * 50], sim.roundId);
    await until(() => sim.game.lanes[lane(peers[0])].clicks === 10);
    await until(() => sim.game.elapsedMs > 2700);
    peers[1].press(Array.from({ length: 30 }, (_, i) => 500 + i * 70), sim.roundId);
    await until(() => sim.game.lanes[lane(peers[1])].clicks === 30);
    assert.equal(sim.game.lanes[lane(peers[1])].dropped, 0);
    // A dropped player's car stays put; back, they keep pressing from there.
    const r = peers[0].r,
      id = r.sessionId;
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    assert.equal(sim.game.lanes[lane(peers[0])].clicks, 10);
    await until(() => room.state.players.get(id)!.connected);
    assert.equal(room.game, sim);
    const after = sim.game.elapsedMs;
    peers[0].press([after - 10], sim.roundId);
    await until(() => sim.game.lanes[lane(peers[0])].clicks === 11);
    // Finish order: peer 1 first, then peer 0 (and peer 2 runs out of time if present).
    nearLine(sim.game, lane(peers[1]));
    peers[1].press([sim.game.elapsedMs], sim.roundId);
    await until(() => sim.game.lanes[lane(peers[1])].finish !== null);
    nearLine(sim.game, lane(peers[0]));
    peers[0].press([sim.game.elapsedMs], sim.roundId);
    await until(() => sim.game.lanes[lane(peers[0])].finish !== null);
    if (count === 3) sim.game.ticks = sim.game.limitTicks - 1;
    await until(() => room.game.phase === "results");
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(1));
    const places = sim.placements();
    assert.equal(places[slot(1)], 0);
    assert.equal(places[slot(0)], 1);
    if (count === 3) assert.equal(places[slot(2)], 2);
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 17);
    assert.ok(validClickWire(shown.click));
    assert.equal(shown.winner, slot(1));
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
