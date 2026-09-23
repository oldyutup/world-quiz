import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import {
  BARN_FIGHTER_FIELDS,
  BARN_FLAG,
  BARN_PREDICTION_BYTES,
  NET,
  type BarnInputPacket,
  type GameEvent,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol.js";
import { BarnRoundSimulation, BARN_MATCH } from "../../../shared/party-lab/simulation/barnRound.js";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound.js";
import { ROUND } from "../../../shared/party-lab/simulation/roundLogic.js";
import { newWeapon } from "../../../shared/party-lab/simulation/barn/weapons.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms = new Set<Room<unknown, LobbyState>>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 6000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out");
    await pause(10);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const room of rooms) {
    room.reconnection.enabled = false;
    if (room.connection.isOpen) await room.leave().catch(() => {});
  }
  await server.gracefullyShutdown(false);
});
interface Peer {
  room: Room<unknown, LobbyState>;
  snapshots: GameSnapshot[];
  events: GameEvent[];
  notices: string[];
}
function track(room: Room<unknown, LobbyState>): Peer {
  rooms.add(room);
  const p: Peer = { room, snapshots: [], events: [], notices: [] };
  room.onMessage("snapshot", (s: GameSnapshot) => p.snapshots.push(s));
  room.onMessage("feedback", (e: GameEvent[]) => p.events.push(...e));
  room.onMessage("notice", (n: string) => p.notices.push(n));
  room.onMessage("pong", () => {});
  return p;
}
const create = async (nickname = "Alice") =>
  track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) =>
  track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (p: Peer) => matchMaker.getLocalRoomById(p.room.roomId) as PartyRoom;
async function close(...list: Peer[]) {
  for (const p of list) {
    p.room.reconnection.enabled = false;
    if (p.room.connection.isOpen) await p.room.leave().catch(() => {});
    rooms.delete(p.room);
  }
}
/** Jump a phase to its last 30 ms (the fixed-step loop then finishes it for real). */
function skip(room: PartyRoom) {
  const game = room.game as unknown as { elapsed: number; phase: string; round: { elapsed: number; phase: string } };
  if (room.game instanceof BarnRoundSimulation) {
    const d = game.phase === "countdown" ? BARN_MATCH.countdown : game.phase === "playing" ? BARN_MATCH.duration : BARN_MATCH.results;
    game.elapsed = d - 0.03;
  } else {
    const r = game.round,
      d = r.phase === "countdown" ? ROUND.countdown : r.phase === "playing" ? ROUND.duration : ROUND.results;
    r.elapsed = d - 0.03;
  }
}
async function playRound(room: PartyRoom, peers: Peer[]) {
  for (const p of peers) p.room.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const mode = room.game.mode;
  skip(room);
  await until(() => room.game.phase === "playing");
  skip(room);
  await until(() => room.game.phase === "results");
  skip(room);
  await until(() => room.game.phase === "waiting");
  await until(() => peers.every((p) => p.room.state.phase === "waiting"));
  return mode;
}
let seq = 0;
const barnInput = (round: number, extra: Partial<BarnInputPacket> = {}): BarnInputPacket => ({
  seq: ++seq,
  round,
  moveX: 0,
  moveZ: 0,
  jumpPressed: false,
  sprintHeld: false,
  attackPressed: false,
  attackHeld: false,
  pickupPressed: false,
  aimYaw: 0,
  aimPitch: 0,
  eyeX: -0.4,
  eyeY: 1.05,
  eyeZ: 0,
  viewTick: 0,
  ...extra,
});

test("mode selector: the creator is host; only the host changes it; everyone sees it; a change clears every Ready", async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  await until(() => b.room.state.hostId === a.room.sessionId && b.room.state.selection === "rooftop_brawl");
  assert.equal(a.room.state.mode, "rooftop_brawl");
  a.room.send("ready", true);
  b.room.send("ready", false);
  await until(() => room.state.players.get(a.room.sessionId)?.ready === true);
  b.room.send("mode", "barn_shootout");
  await until(() => b.notices.includes("MODE_HOST_ONLY"));
  assert.equal(room.selection, "rooftop_brawl", "a non-host cannot change the mode");
  assert.equal(room.state.players.get(a.room.sessionId)?.ready, true);
  for (const bad of ["BARN", "", 3, null, { mode: "barn_shootout" }]) a.room.send("mode", bad);
  await pause(80);
  assert.equal(room.selection, "rooftop_brawl", "invalid selections ignored");
  a.room.send("mode", "barn_shootout");
  await until(() => [a, b].every((p) => p.room.state.selection === "barn_shootout" && p.room.state.mode === "barn_shootout"));
  assert.equal(room.state.players.get(a.room.sessionId)?.ready, false, "changing the mode clears Ready");
  a.room.send("mode", "mixed");
  await until(() => [a, b].every((p) => p.room.state.selection === "mixed"));
  assert.ok(["rooftop_brawl", "barn_shootout"].includes(b.room.state.mode), "Mixed shows the actual next mode");
  await close(a, b);
});

test("host hand-over: when the host leaves (or drops) the earliest-joined connected player hosts", async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby"),
    c = await join(a.room.roomId, "Carol");
  const room = local(a);
  await until(() => room.state.hostId === a.room.sessionId);
  a.room.reconnection.enabled = false;
  a.room.connection.close(4001); // A drop: the seat is held, hosting moves to someone present.
  await until(() => room.state.hostId === b.room.sessionId);
  await close(b);
  await until(() => room.state.hostId === c.room.sessionId);
  c.room.send("mode", "barn_shootout");
  await until(() => room.selection === "barn_shootout");
  await close(c);
  rooms.delete(a.room);
});

test("barn round over real sockets: explicit mode, barn packets acknowledged, rooftop packets refused, recipient-only prediction state", { timeout: 20000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  a.room.send("mode", "barn_shootout");
  await until(() => room.selection === "barn_shootout");
  a.room.send("ready", true);
  b.room.send("ready", true);
  await until(() => room.game.phase === "countdown");
  assert.ok(room.game instanceof BarnRoundSimulation, "the round runs the barn simulation");
  await until(() => b.room.state.phase === "countdown" && b.room.state.mode === "barn_shootout");
  skip(room);
  await until(() => a.room.state.phase === "playing");
  const round = room.game.roundId,
    slot = room.state.players.get(a.room.sessionId)!.slot;
  // A rooftop packet in a barn round is refused (no ack), a barn packet is consumed.
  a.room.send("input", { seq: ++seq, round, moveX: 1, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false });
  await pause(120);
  assert.equal(a.snapshots[a.snapshots.length - 1].ack[slot], -1);
  const moved = seq + 1;
  for (let i = 0; i < 20; i++) {
    a.room.send("input", barnInput(round, { moveX: 1, aimYaw: Math.PI / 2, viewTick: Math.max(0, room.game.tick - 8) }));
    await pause(1000 / 60);
  }
  await until(() => (a.snapshots[a.snapshots.length - 1]?.ack[slot] ?? -1) >= moved);
  const s = a.snapshots[a.snapshots.length - 1];
  assert.equal(s.mode, "barn_shootout");
  assert.equal(s.barn!.f.length, 3 * BARN_FIGHTER_FIELDS);
  assert.equal(s.prediction!.slot, slot, "prediction state only for the recipient's own slot");
  assert.equal(s.prediction!.barn!.byteLength, BARN_PREDICTION_BYTES);
  const other = b.snapshots[b.snapshots.length - 1];
  assert.notEqual(other.prediction!.slot, slot);
  assert.ok(s.seconds > BARN_MATCH.duration - 5 && s.seconds <= BARN_MATCH.duration, `timer ${s.seconds} s of 150`);
  // Results by kills.
  const barn = (room.game as BarnRoundSimulation).barn;
  barn.fighters[room.state.players.get(b.room.sessionId)!.slot].kills = 2;
  skip(room);
  await until(() => a.room.state.phase === "results");
  assert.equal(a.room.state.winner, room.state.players.get(b.room.sessionId)!.slot, "most kills wins");
  await close(a, b);
});

test("Mixed: random first mode, then alternates; each switch rebuilds and disposes the simulation; 20 switches do not leak", { timeout: 60000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  a.room.send("mode", "mixed");
  await until(() => room.selection === "mixed");
  const played: string[] = [];
  const memory: number[] = [];
  for (let i = 0; i < 22; i++) {
    // What the lobby shows (after its next state patch) before anyone is Ready.
    await until(() => a.room.state.mode === room.upcoming && b.room.state.mode === room.upcoming);
    const next = a.room.state.mode;
    const mode = await playRound(room, [a, b]);
    assert.equal(mode, next, "the lobby showed the round's actual mode");
    played.push(mode);
    if (i >= 2) {
      // The test's own received-message arrays are not server memory.
      for (const p of [a, b]) p.snapshots.length = p.events.length = 0;
      gc();
      memory.push(process.memoryUsage().heapUsed / 1048576);
    }
  }
  for (let i = 1; i < played.length; i++) assert.notEqual(played[i], played[i - 1], `alternates (${played.join(",")})`);
  assert.equal(room.simulations.created, 1 + played.length - (played[0] === "rooftop_brawl" ? 1 : 0));
  assert.equal(room.simulations.disposed, room.simulations.created - 1);
  const growth = memory[memory.length - 1] - memory[0];
  console.log(JSON.stringify({ played: played.length, created: room.simulations.created, disposed: room.simulations.disposed, heapMb: memory.map((m) => +m.toFixed(1)), growthMb: +growth.toFixed(2) }));
  assert.ok(growth < 8, `heap grew ${growth.toFixed(1)} MB over 20 switches`);
  // The disposed world is really freed (the old simulation's Rapier world is gone).
  const old = room.game;
  a.room.send("mode", old.mode === "barn_shootout" ? "rooftop_brawl" : "barn_shootout");
  await until(() => room.upcoming !== old.mode);
  await playRound(room, [a, b]);
  assert.throws(() => (old as BarnRoundSimulation | OnlineRoundSimulation).physics.world.step(), "a disposed world cannot be stepped");
  await close(a, b);
});

test("barn reconnect: same seat and identity; HP, weapon/ammo, score and alive/dead restored; one body; no duplicate handlers", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  a.room.send("mode", "barn_shootout");
  await until(() => room.selection === "barn_shootout");
  a.room.send("ready", true);
  b.room.send("ready", true);
  await until(() => room.game.phase === "countdown");
  skip(room);
  await until(() => b.room.state.phase === "playing");
  const game = room.game as BarnRoundSimulation;
  const slot = room.state.players.get(b.room.sessionId)!.slot,
    id = b.room.sessionId;
  Object.assign(b.room.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 400, maxRetries: 10 });
  const cases: [string, () => void, (f: number[]) => void][] = [
    ["alive, unarmed", () => Object.assign(game.barn.fighters[slot], { hp: 64 }), (f) => (assert.equal(f[1], 64), assert.equal(f[2], 0))],
    [
      "alive, armed",
      () => {
        game.barn.fighters[slot].weapon = newWeapon("smg");
        game.barn.fighters[slot].weapon!.ammo = 7;
      },
      (f) => (assert.equal(f[2], 2), assert.equal(f[3], 7)),
    ],
    ["after several kills", () => Object.assign(game.barn.fighters[slot], { kills: 4, deaths: 2 }), (f) => (assert.equal(f[4], 4), assert.equal(f[5], 2))],
    [
      "dead, respawn pending",
      () => {
        const f = game.barn.fighters[slot];
        Object.assign(f, { alive: false, deadFor: 0.2, weapon: null });
      },
      (f) => (assert.equal(f[0] & BARN_FLAG.alive, 0), assert.ok(f[6] > 0 || f[0] & BARN_FLAG.alive)),
    ],
  ];
  let reconnects = 0;
  b.room.onReconnect(() => reconnects++);
  for (const [label, arrange, check] of cases) {
    arrange();
    const before = b.snapshots.length;
    b.room.connection.close(4010);
    await until(() => room.state.players.get(id)?.connected === false || reconnects > 0);
    await until(() => room.state.players.get(id)?.connected === true && b.room.connection.isOpen);
    await until(() => b.snapshots.length > before + 2);
    const s = b.snapshots[b.snapshots.length - 1];
    assert.equal(b.room.sessionId, id, `${label}: same identity`);
    assert.equal(room.state.players.get(id)?.slot, slot, `${label}: same seat`);
    check(s.barn!.f.slice(slot * BARN_FIGHTER_FIELDS, (slot + 1) * BARN_FIGHTER_FIELDS));
    // Handlers are registered once: every snapshot sequence arrives exactly once.
    const seqs = b.snapshots.slice(before).map((x) => x.seq);
    assert.equal(new Set(seqs).size, seqs.length, `${label}: no duplicated snapshot handler`);
    assert.equal(room.state.players.size, 2, "no duplicate player");
    assert.equal(game.physics.players.filter((p) => !p.eliminated).length, game.barn.fighters[slot].alive ? 2 : 2, "no extra body");
  }
  assert.equal(reconnects, cases.length);
  // Input after the reconnect is accepted again (a fresh mailbox, no replayed backlog).
  const round = game.roundId;
  b.room.send("input", barnInput(round, { moveX: 1, aimYaw: 0, viewTick: Math.max(0, game.tick - 8) }));
  await until(() => (b.snapshots[b.snapshots.length - 1]?.ack[slot] ?? -1) === seq);
  await close(a, b);
});
