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

test("90 presses to the finish: 8–10 a second finish in 9–11.5 s, well inside the 30 s limit", () => {
  assert.equal(C.trackClicks, 90);
  assert.equal(C.limit, 30);
  for (const rate of [8, 9, 10]) {
    const seconds = C.trackClicks / rate;
    assert.ok(seconds >= 9 && seconds <= 11.5, `${rate}/s → ${seconds} s`);
    const g = racing();
    run(g, 30, (lane, ms) => (lane === 0 ? every(rate)(ms) : []));
    assert.equal(g.lanes[0].clicks, C.trackClicks);
    assert.ok(Math.abs(g.lanes[0].finish! / C.hz - seconds) < 0.2, `finish ${g.lanes[0].finish! / C.hz} s at ${rate}/s`);
  }
});

test("each press counts once, moves one step, and the finishing press stops the lane", () => {
  const g = racing(2);
  g.step([[10], []]);
  g.step([[20, 30], [25]]);
  assert.deepEqual(g.lanes.map((l) => l.clicks), [3, 1]);
  g.lanes[0].clicks = C.trackClicks - 1;
  g.step([[100], []]);
  assert.equal(g.lanes[0].clicks, C.trackClicks);
  assert.equal(g.lanes[0].finish, g.ticks);
  g.step([[110], []]);
  assert.equal(g.lanes[0].clicks, C.trackClicks, "a finished car does not move on");
  assert.equal(g.phase, "racing", "the race goes on until everyone finishes");
});

test("presses before BAŞLA never count", () => {
  const g = new ClickRaceGame(2);
  for (let t = 0; g.phase === "countdown"; t++) {
    assert.equal(g.click(0, 0), false);
    g.step([[0, 1, 2], [0]]);
  }
  assert.deepEqual(g.lanes.map((l) => l.clicks), [0, 0], "countdown presses");
  assert.equal(g.ticks, 0);
  g.step([[-1, -200], [5]]);
  assert.deepEqual(g.lanes.map((l) => l.clicks), [0, 1], "a stamp before BAŞLA (negative) is not a race press");
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

test("presses a stalled link delivers together are all counted (window on press stamps, not arrival)", () => {
  // 15 presses a second; 2 s of packets stall and arrive in one step: 30 presses at once,
  // more than the cap if it were counted on arrival.
  const g = racing(2),
    held: number[] = [];
  run(g, 4, (lane, ms) => {
    if (lane !== 0) return [];
    const now = every(15)(ms);
    if (ms > 1000 && ms <= 3000) {
      held.push(...now);
      return [];
    }
    if (held.length) return [...held.splice(0), ...now];
    return now;
  });
  assert.equal(g.lanes[0].dropped, 0);
  assert.equal(g.lanes[0].clicks, 60, "4 s at 15/s");
  // A burst within one real second still hits the cap: 40 presses stamped 1 ms apart.
  const h = racing(2);
  run(h, 1, () => []);
  h.step([Array.from({ length: 40 }, (_, i) => 500 + i), []]);
  assert.equal(h.lanes[0].clicks, C.maxRate);
});

test("forged stamps buy nothing: they are pulled back to the race clock and never run backwards", () => {
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
});

test("time limit: the furthest car wins; places by finish order, then distance", () => {
  const g = racing(3);
  run(g, C.limit + 1, (lane, ms) => every([2, 1.5, 1][lane])(ms));
  assert.equal(g.phase, "results");
  assert.equal(g.ticks, C.limit * C.hz);
  assert.deepEqual(g.lanes.map((l) => l.finish), [null, null, null]);
  assert.deepEqual(g.places(), [0, 1, 2]);
  assert.equal(g.winner(), 0);
  // Finishers first in finish order, then the rest by distance.
  const h = racing(3);
  h.lanes[2].clicks = C.trackClicks - 1;
  h.step([[], [], [5]]);
  h.lanes[1].clicks = C.trackClicks - 1;
  h.step([[100], [20], []]);
  run(h, C.limit + 1, () => []);
  assert.deepEqual(h.places(), [2, 1, 0]);
  assert.equal(h.winner(), 2);
  const section = clickSection(h, [0, 1, 2]);
  assert.ok(validClickWire(section));
  assert.deepEqual(section.finish, [-1, Math.round((2 * 1000) / C.hz), Math.round(1000 / C.hz)]);
  assert.equal(section.time[0], C.limit * 1000);
});

test("a full tie is a draw, at the finish or at the time limit", () => {
  const g = racing(2);
  for (const l of g.lanes) l.clicks = C.trackClicks - 1;
  g.step([[10], [12]]);
  assert.equal(g.phase, "results", "everyone finished");
  assert.deepEqual(g.places(), [0, 0]);
  assert.equal(g.winner(), -1);
  const h = racing(3);
  run(h, C.limit + 1, (lane, ms) => (lane < 2 ? every(4)(ms) : every(1)(ms)));
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
    assert.equal(section.clicks.length, lanes);
  }
  assert.throws(() => new ClickRaceGame(1));
  assert.throws(() => new ClickRaceGame(7));
});

test("a player who leaves ranks last; the last player racing wins at once", () => {
  const g = racing(3);
  run(g, 2, (lane, ms) => every(lane === 0 ? 12 : 4)(ms));
  const left = g.lanes[0].clicks;
  g.remove(0);
  g.step([[2100], [], []]);
  assert.equal(g.lanes[0].clicks, left, "a car that left stops");
  assert.equal(g.phase, "racing", "two still race");
  g.remove(2);
  g.step();
  assert.equal(g.phase, "results");
  assert.equal(g.winner(), 1);
  assert.deepEqual(g.places(), [1, 0, 2], "leavers behind the stayer, by distance");
});

test("a dropped player's car waits and moves on when they are back", () => {
  const g = racing(2);
  run(g, 1, (_, ms) => every(10)(ms));
  const before = g.lanes[0].clicks;
  run(g, 2, (lane, ms) => (lane === 1 ? every(10)(ms) : []));
  assert.equal(g.lanes[0].clicks, before, "no presses while away");
  run(g, 1, (_, ms) => every(10)(ms));
  assert.equal(g.lanes[0].clicks, before + 10);
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
  sim.game.lanes[1].clicks = C.trackClicks - 1;
  sim.step(press(2, [10]));
  sim.game.lanes[0].clicks = C.trackClicks - 1;
  sim.step(press(1, [20]));
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
    sim.game.lanes[lane(peers[1])].clicks = C.trackClicks - 1;
    peers[1].press([sim.game.elapsedMs], sim.roundId);
    await until(() => sim.game.lanes[lane(peers[1])].finish !== null);
    sim.game.lanes[lane(peers[0])].clicks = C.trackClicks - 1;
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
    assert.equal(shown.v, 16);
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
