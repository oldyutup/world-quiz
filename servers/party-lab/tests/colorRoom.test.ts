import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import {
  LAYER_FLAG,
  LAYER_PREDICTION_BYTES,
  LAYER_RESULTS,
  NET,
  type GameEvent,
  type GameSnapshot,
  type LayerInputPacket,
} from "../../../shared/party-lab/network/protocol.js";
import { ColorRoundSimulation } from "../../../shared/party-lab/simulation/colorRound.js";
import { COLOR_TICKS } from "../../../shared/party-lab/simulation/colors/config.js";
import { ColorFieldKnowledge, decodeColorSnapshot } from "../../../shared/party-lab/simulation/colors/wire.js";
import { readLayerPredictionState } from "../../../shared/party-lab/simulation/predictionState.js";
import { colorSpawn, COLOR_TILES } from "../../../shared/party-lab/maps/colors.js";
import { RAGDOLL } from "../../../shared/party-lab/simulation/ragdoll/config.js";

const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms = new Set<Room<unknown, LobbyState>>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000) {
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
}
function track(room: Room<unknown, LobbyState>): Peer {
  rooms.add(room);
  const p: Peer = { room, snapshots: [], events: [] };
  room.onMessage("snapshot", (s: GameSnapshot) => p.snapshots.push(s));
  room.onMessage("feedback", (e: GameEvent[]) => p.events.push(...e));
  room.onMessage("notice", () => {});
  room.onMessage("pong", () => {});
  return p;
}
const create = async (nickname = "Alice") => track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) => track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (p: Peer) => matchMaker.getLocalRoomById(p.room.roomId) as PartyRoom;
const colors = (room: PartyRoom) => room.game as ColorRoundSimulation;
const last = (p: Peer) => p.snapshots[p.snapshots.length - 1];
async function close(...list: Peer[]) {
  for (const p of list) {
    p.room.reconnection.enabled = false;
    if (p.room.connection.isOpen) await p.room.leave().catch(() => {});
    rooms.delete(p.room);
  }
}
/** Host picks Renk Kaosu, everyone Ready, the countdown is skipped to its end. */
async function startColors(room: PartyRoom, peers: Peer[]) {
  peers[0].room.send("mode", "color_chaos");
  await until(() => room.selection === "color_chaos" && peers.every((p) => p.room.state.mode === "color_chaos"));
  for (const p of peers) p.room.send("ready", true);
  await until(() => room.game.phase === "countdown");
  assert.ok(room.game instanceof ColorRoundSimulation, "the round runs the colour simulation");
  colors(room).round.tick = COLOR_TICKS.countdown - 2;
  await until(() => peers.every((p) => p.room.state.phase === "playing"));
}
/** Move a body straight down below the elimination line (a physical fall out). */
function dropOut(room: PartyRoom, slot: number) {
  const c = colors(room).physics.players[slot];
  const hips = c.body.translation().y;
  for (const part of Object.values(c.parts)) {
    const p = part.body.translation();
    part.body.setTranslation({ x: p.x, y: RAGDOLL.fallY - 1 + (p.y - hips), z: p.z }, true);
  }
}
let seq = 0;
const colorInput = (round: number, extra: Partial<LayerInputPacket> = {}): LayerInputPacket => ({
  seq: ++seq,
  round,
  moveX: 0,
  moveZ: 0,
  jumpPressed: false,
  sprintHeld: false,
  punchPressed: false,
  ...extra,
});
/**
 * The client's reconstruction of the floor from one socket snapshot equals the server's —
 * checked against the server's cycle when the server is still in that cycle (it runs a few
 * ticks ahead of what the socket delivered).
 */
function sameFloor(s: GameSnapshot, sim: ColorRoundSimulation) {
  const d = decodeColorSnapshot(s.colors);
  assert.ok(d, "a valid colours section");
  const c = sim.schedule.cycle;
  if (d.cycle.index !== c.index) return 0;
  assert.deepEqual([...d.cycle.colors], [...c.colors], "colour per tile");
  assert.deepEqual([...d.cycle.present], [...c.present], "tiles there");
  assert.deepEqual([...d.cycle.warned], [...c.warned], "marked tiles");
  assert.equal(d.cycle.target, c.target);
  const k = new ColorFieldKnowledge();
  k.apply(s.round, d);
  const tick = s.phase === "playing" ? d.t - 1 : d.t;
  for (const tile of COLOR_TILES) assert.equal(k.standing(tile.id, tick), sim.schedule.standing(tile.id, tick), `tile ${tile.id} at ${tick}`);
  return COLOR_TILES.length;
}

test("health reports protocol 9", async () => {
  const response = await fetch(`${endpoint}/health`);
  assert.deepEqual(await response.json(), { ok: true, service: "party-lab", protocol: 9 });
});

test("colour round over real sockets (2 players): explicit mode, shove packets acknowledged, other modes' packets refused, recipient-only prediction, the same complete floor for both clients", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  await startColors(room, [a, b]);
  const sim = colors(room);
  const round = sim.roundId,
    slot = room.state.players.get(a.room.sessionId)!.slot;
  sim.game.slots.forEach((id, k) => {
    const p = sim.physics.players[id].body.translation(),
      s = colorSpawn(2, k);
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.5, `slot ${id} on the two-player spawn ${k}`);
  });
  // Rooftop and Barn packets in a colour round, and a shove packet claiming a colour or a result: refused.
  a.room.send("input", { seq: ++seq, round, moveX: 1, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false });
  a.room.send("input", { seq: ++seq, round, moveX: 1, moveZ: 0, jumpPressed: false, sprintHeld: false, attackPressed: false, attackHeld: false, pickupPressed: false, aimYaw: 0, aimPitch: 0, eyeX: 0, eyeY: 1, eyeZ: 0, viewTick: 0 });
  a.room.send("input", { ...colorInput(round, { moveX: 1 }), target: 2 });
  a.room.send("input", { ...colorInput(round, { moveX: 1 }), winner: slot });
  await pause(150);
  assert.equal(last(a).ack[slot], -1, "nothing acknowledged");
  const from = sim.physics.players[slot].body.translation();
  const moved = seq + 1;
  for (let i = 0; i < 30; i++) {
    a.room.send("input", colorInput(round, { moveZ: from.z > 0 ? -1 : 1, sprintHeld: i > 10 }));
    await pause(1000 / 60);
  }
  await until(() => (last(a)?.ack[slot] ?? -1) >= moved);
  assert.ok(Math.abs(sim.physics.players[slot].body.translation().z - from.z) > 0.3, "the server moved the body from intent");
  const s = last(a);
  assert.equal(s.mode, "color_chaos");
  assert.ok(!s.layers && !s.barn);
  assert.equal(s.prediction!.slot, slot, "prediction state only for the recipient's own slot");
  assert.equal(s.prediction!.layers!.byteLength, LAYER_PREDICTION_BYTES);
  assert.ok(readLayerPredictionState(s.prediction!.layers));
  assert.notEqual(last(b).prediction!.slot, slot);
  assert.ok(s.colors!.f[slot] & LAYER_FLAG.alive && s.colors!.f[slot] & LAYER_FLAG.body);
  // Both clients got the same floor on every common snapshot.
  const bySeq = new Map(b.snapshots.map((x) => [x.seq, x]));
  let common = 0;
  for (const x of a.snapshots) {
    const y = bySeq.get(x.seq);
    if (!y?.colors || !x.colors) continue;
    const { f: _f, ...fx } = x.colors,
      { f: _g, ...fy } = y.colors;
    assert.deepEqual(fx, fy, `snapshot ${x.seq}`);
    common++;
  }
  assert.ok(common > 10, `${common} common snapshots`);
  let checked = 0;
  for (let i = 0; i < 20 && !checked; i++) {
    await pause(50);
    checked = sameFloor(last(a), sim);
  }
  assert.equal(checked, 85, "the socket's floor is the server's");
  await until(() => room.metrics.snapshotWireBytes > 0 && sim.section.bytes > 0);
  console.log(JSON.stringify({ snapshotWireBytes: room.metrics.snapshotWireBytes, sectionBytes: sim.section.bytes, commonSnapshots: common }));
  assert.ok(room.metrics.snapshotWireBytes < 1600);
  await close(a, b);
});

test("3 players: the 120° spawns; a drop through a wrong colour over the wire; last alive wins; results → lobby with Ready cleared", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby"),
    c = await join(a.room.roomId, "Carol");
  const room = local(a);
  await startColors(room, [a, b, c]);
  const sim = colors(room);
  for (const id of [0, 1, 2]) {
    const p = sim.physics.players[id].body.translation(),
      s = colorSpawn(3, id);
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.5, `slot ${id} on spawn ${id}`);
  }
  const [sa, sb, sc] = [a, b, c].map((p) => room.state.players.get(p.room.sessionId)!.slot);
  dropOut(room, sb);
  await until(() => [a, b, c].every((p) => last(p) && !(last(p).alive & (1 << sb))));
  await until(() => [a, b, c].every((p) => p.events.some((e) => e.name === "fall" && e.actor === sb)));
  assert.ok(a.events.some((e) => e.name === "fall" && e.actor === sb), "everyone hears the fall");
  assert.equal(room.state.phase, "playing", "two left: the round goes on");
  const out = last(b);
  assert.equal(out.colors!.f[sb] & (LAYER_FLAG.alive | LAYER_FLAG.body), 0, "the eliminated player sees themself out");
  assert.ok(out.colors!.o[sb] >= 0);
  dropOut(room, sc);
  await until(() => room.state.phase === "results");
  assert.equal(room.state.winner, sa, "last alive wins");
  await until(() => last(c)?.phase === "results");
  assert.equal(last(c).colors!.r, LAYER_RESULTS.indexOf("survivor"));
  colors(room).round.tick = COLOR_TICKS.results - 2;
  await until(() => [a, b, c].every((p) => p.room.state.phase === "waiting"));
  assert.ok([...room.state.players.values()].every((p) => !p.ready), "Ready cleared for the next round");
  await close(a, b, c);
});

test("reconnect: an alive player comes back to the same seat and body with the exact floor, cycle, target and clock; an eliminated one comes back out (spectating); a late joiner watches; leaving is a forfeit", { timeout: 40000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby"),
    c = await join(a.room.roomId, "Carol");
  const room = local(a);
  await startColors(room, [a, b, c]);
  const sim = colors(room);
  const ids = [a, b, c].map((p) => p.room.sessionId);
  const slots = ids.map((id) => room.state.players.get(id)!.slot);
  for (const p of [b, c]) Object.assign(p.room.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 400, maxRetries: 10 });
  // Into the Daralma: cycle 20 (grey rim, marked next ring), everyone kept on the target colour.
  const keep = () => {
    const { colors: layout, target } = sim.schedule.cycle;
    const safe = COLOR_TILES.filter((t) => layout[t.id] === target).sort((x, y) => x.ring - y.ring);
    sim.game.slots.forEach((slot, k) => {
      if (!sim.round.alive[slot]) return;
      const t = safe[k % safe.length];
      const ch = sim.physics.players[slot];
      const hips = ch.body.translation();
      for (const part of Object.values(ch.parts)) {
        const p = part.body.translation();
        part.body.setTranslation({ x: t.x + (p.x - hips.x), y: 0.86 + (p.y - hips.y), z: t.z + (p.z - hips.z) }, true);
        part.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    });
  };
  // Jump the schedule forward: the round clock and the cycle move to cycle 20's preview.
  let guard = 0;
  while (sim.schedule.cycle.index < 20 && guard++ < 200) {
    const next = sim.schedule.cycle.restore;
    sim.round.tick = next;
    await until(() => sim.schedule.cycle.index > 0 && sim.round.tick > next);
    keep();
  }
  keep();
  await until(() => sim.schedule.cycle.index === 20);
  assert.ok(sim.round.alive.every((x, id) => !slots.includes(id) || x), "everyone still in");
  // Alive player B drops and reconnects mid-round.
  let reconnects = 0;
  b.room.onReconnect(() => reconnects++);
  const before = b.snapshots.length;
  const tickBefore = last(b).colors!.t;
  sim.game.brawl.fighters[slots[1]].stagger = { time: 5, posture: 0.7, mobility: 0.25 }; // long, to still be on after the round trip
  b.room.connection.close(4010);
  await until(() => reconnects === 1 && room.state.players.get(ids[1])?.connected === true);
  await until(() => b.snapshots.length > before + 2);
  const s = last(b);
  assert.equal(b.room.sessionId, ids[1], "same identity");
  assert.equal(room.state.players.get(ids[1])!.slot, slots[1], "same seat");
  assert.equal(room.state.players.size, 3, "no duplicate player");
  assert.equal(sim.physics.players.filter((p) => !p.eliminated).length, 3, "one body each");
  assert.ok(s.colors!.t > tickBefore, "the round clock went on");
  assert.ok(s.alive & (1 << slots[1]) && s.colors!.f[slots[1]] & LAYER_FLAG.body, "still in, body present");
  assert.ok(s.colors!.f[slots[1]] & LAYER_FLAG.staggered, "stagger restored in the snapshot");
  const state = readLayerPredictionState(s.prediction!.layers)!;
  assert.ok(state.staggerTime > 3 && state.staggerPosture === 0.7, "and in the own prediction state");
  const d = decodeColorSnapshot(s.colors)!;
  assert.ok(d.cycle.index >= 20, `cycle ${d.cycle.index}`);
  // Cycle 20: the first rim is back grey (there, no colour), the next ring marked — from the first snapshots.
  assert.ok(d.cycle.stage >= 1 && d.cycle.colors.filter((x) => x !== 255).length < d.cycle.present.reduce((n, x) => n + x, 0), "grey tiles on the floor");
  assert.ok(d.cycle.warned.some((x) => x === 1), "marked tiles (DARALIYOR)");
  let checked = 0;
  for (let i = 0; i < 20 && !checked; i++) {
    await pause(50);
    checked = sameFloor(last(b), sim);
  }
  assert.equal(checked, 85, "the reconnected client's floor is the server's");
  const seqs = b.snapshots.slice(before).map((x) => x.seq);
  assert.equal(new Set(seqs).size, seqs.length, "no duplicated snapshot handler");
  sim.game.brawl.fighters[slots[1]].stagger.time = 0;
  const round = sim.roundId;
  b.room.send("input", colorInput(round, { moveZ: 0.1 }));
  await until(() => (last(b)?.ack[slots[1]] ?? -1) === seq);
  // C falls out, then reconnects: back as a spectator of this round, not revived.
  dropOut(room, slots[2]);
  await until(() => !(last(c)?.alive & (1 << slots[2])));
  let cReconnects = 0;
  c.room.onReconnect(() => cReconnects++);
  const cBefore = c.snapshots.length;
  c.room.connection.close(4010);
  await until(() => cReconnects === 1 && room.state.players.get(ids[2])?.connected === true);
  await until(() => c.snapshots.length > cBefore + 2);
  const cs = last(c);
  assert.equal(cs.alive & (1 << slots[2]), 0, "still eliminated");
  assert.equal(cs.colors!.f[slots[2]] & (LAYER_FLAG.alive | LAYER_FLAG.body), 0, "no body, no respawn");
  assert.ok(cs.colors!.f[slots[2]] & LAYER_FLAG.inMatch, "still in this round's roster (spectating it)");
  assert.equal(room.state.phase, "playing");
  // A late joiner watches with the full floor.
  const late = await join(a.room.roomId, "Dora").catch(() => null);
  assert.equal(late, null, "the room is full (3 seats)");
  // B leaves for good: a forfeit, A wins.
  keep();
  await close(b);
  await until(() => room.state.phase === "results");
  assert.equal(room.state.winner, slots[0]);
  await until(() => last(a)?.phase === "results");
  assert.equal(last(a).colors!.r, LAYER_RESULTS.indexOf("forfeit"));
  await close(a, c);
});

test("a late joiner watches a colour round with the full floor from its first snapshot", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  await startColors(room, [a, b]);
  const sim = colors(room);
  await until(() => sim.round.tick > 60);
  const late = await join(a.room.roomId, "Carol");
  await until(() => late.snapshots.length > 2);
  const s = last(late);
  assert.equal(room.state.players.get(late.room.sessionId)!.participating, false, "spectator");
  assert.equal(s.mask & (1 << room.state.players.get(late.room.sessionId)!.slot), 0);
  let checked = 0;
  for (let i = 0; i < 20 && !checked; i++) {
    await pause(50);
    checked = sameFloor(last(late), sim);
  }
  assert.equal(checked, 85);
  await close(a, b, late);
});
