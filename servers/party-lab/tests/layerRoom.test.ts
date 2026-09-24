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
import { LayerRoundSimulation, layerSpawns } from "../../../shared/party-lab/simulation/layerRound.js";
import { LAYER_TICKS } from "../../../shared/party-lab/simulation/layers/config.js";
import { decodeLayerSnapshot, LayerTileKnowledge } from "../../../shared/party-lab/simulation/layers/wire.js";
import { readLayerPredictionState } from "../../../shared/party-lab/simulation/predictionState.js";
import { LAYERS_MAP } from "../../../shared/party-lab/maps/layers.js";
import { RAGDOLL } from "../../../shared/party-lab/simulation/ragdoll/config.js";
import type { PlayerId } from "../../../shared/party-lab/simulation/players.js";

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
const create = async (nickname = "Alice") => track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) => track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (p: Peer) => matchMaker.getLocalRoomById(p.room.roomId) as PartyRoom;
const layers = (room: PartyRoom) => room.game as LayerRoundSimulation;
const last = (p: Peer) => p.snapshots[p.snapshots.length - 1];
async function close(...list: Peer[]) {
  for (const p of list) {
    p.room.reconnection.enabled = false;
    if (p.room.connection.isOpen) await p.room.leave().catch(() => {});
    rooms.delete(p.room);
  }
}
/** Host picks Katman Kaosu, everyone Ready, the countdown is skipped to its end. */
async function startLayers(room: PartyRoom, peers: Peer[]) {
  peers[0].room.send("mode", "layer_chaos");
  await until(() => room.selection === "layer_chaos" && peers.every((p) => p.room.state.mode === "layer_chaos"));
  for (const p of peers) p.room.send("ready", true);
  await until(() => room.game.phase === "countdown");
  assert.ok(room.game instanceof LayerRoundSimulation, "the round runs the layer simulation");
  layers(room).round.tick = LAYER_TICKS.countdown - 2;
  await until(() => peers.every((p) => p.room.state.phase === "playing"));
}
/** Move a body straight down below the elimination line (a physical fall out). */
function dropOut(room: PartyRoom, slot: number) {
  const c = layers(room).physics.players[slot];
  const hips = c.body.translation().y;
  for (const part of Object.values(c.parts)) {
    const p = part.body.translation();
    part.body.setTranslation({ x: p.x, y: RAGDOLL.fallY - 1 + (p.y - hips), z: p.z }, true);
  }
}
let seq = 0;
const layerInput = (round: number, extra: Partial<LayerInputPacket> = {}): LayerInputPacket => ({
  seq: ++seq,
  round,
  moveX: 0,
  moveZ: 0,
  jumpPressed: false,
  sprintHeld: false,
  punchPressed: false,
  ...extra,
});
/** The client's reconstruction of the tile field from one socket snapshot equals the server's field. */
function sameField(s: GameSnapshot, sim: LayerRoundSimulation) {
  const d = decodeLayerSnapshot(s.layers);
  assert.ok(d, "a valid layers section");
  const k = new LayerTileKnowledge();
  k.apply(s.round, d);
  k.viewTick = s.phase === "playing" ? d.t - 1 : d.t;
  let checked = 0;
  for (const tile of k.tiles) {
    // The server may be a few ticks further; compare with what it had at that tick.
    const gone = sim.field.goneTick[tile.id] >= 0 && sim.field.goneTick[tile.id] <= k.viewTick;
    const known = sim.field.gone[tile.id] === 1 && sim.field.goneTick[tile.id] < 0;
    assert.equal(!k.intact(tile.id), gone || known, `tile ${tile.id} at tick ${k.viewTick}`);
    checked++;
  }
  return checked;
}

test("layer round over real sockets (2 players): explicit mode, layer packets acknowledged, other modes' packets refused, recipient-only prediction, complete tile section", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  await startLayers(room, [a, b]);
  const sim = layers(room);
  const round = sim.roundId,
    slot = room.state.players.get(a.room.sessionId)!.slot;
  // Duel spawns: two of the three, per this round's rotation.
  const spawns = layerSpawns(sim.game.slots, round);
  for (const [i, id] of sim.game.slots.entries()) {
    const p = sim.physics.players[id].body.translation(),
      s = LAYERS_MAP.spawns[spawns[i]];
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.5, `slot ${id} on spawn ${spawns[i]}`);
  }
  // Rooftop and Barn packets in a layer round: refused (never acknowledged).
  a.room.send("input", { seq: ++seq, round, moveX: 1, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false });
  a.room.send("input", { seq: ++seq, round, moveX: 1, moveZ: 0, jumpPressed: false, sprintHeld: false, attackPressed: false, attackHeld: false, pickupPressed: false, aimYaw: 0, aimPitch: 0, eyeX: 0, eyeY: 1, eyeZ: 0, viewTick: 0 });
  // A layer packet carrying a result claim: refused too.
  a.room.send("input", { ...layerInput(round, { moveX: 1 }), winner: slot });
  await pause(150);
  assert.equal(last(a).ack[slot], -1, "nothing acknowledged");
  const from = sim.physics.players[slot].body.translation().x;
  const moved = seq + 1;
  for (let i = 0; i < 30; i++) {
    a.room.send("input", layerInput(round, { moveX: -1, sprintHeld: i > 10 }));
    await pause(1000 / 60);
  }
  await until(() => (last(a)?.ack[slot] ?? -1) >= moved);
  assert.ok(Math.abs(sim.physics.players[slot].body.translation().x - from) > 0.3, "the server moved the body from intent");
  const s = last(a);
  assert.equal(s.mode, "layer_chaos");
  assert.equal(s.prediction!.slot, slot, "prediction state only for the recipient's own slot");
  assert.equal(s.prediction!.layers!.byteLength, LAYER_PREDICTION_BYTES);
  assert.ok(readLayerPredictionState(s.prediction!.layers));
  assert.notEqual(last(b).prediction!.slot, slot);
  assert.ok(s.layers!.f[slot] & LAYER_FLAG.alive && s.layers!.f[slot] & LAYER_FLAG.body);
  assert.ok(sameField(s, sim) === 297);
  assert.ok(s.layers!.a.byteLength >= 6, "both players' tiles are armed and listed");
  // Wire size of a real snapshot message (msgpack + Colyseus framing), measured by the room once a second.
  await until(() => room.metrics.snapshotWireBytes > 0);
  console.log(JSON.stringify({ snapshotWireBytes: room.metrics.snapshotWireBytes, sectionBytes: sim.section.bytes }));
  assert.ok(room.metrics.snapshotWireBytes < 1600);
  await close(a, b);
});

test("3 players: all three spawns; eliminations over the wire; last alive wins; results → lobby with Ready cleared", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby"),
    c = await join(a.room.roomId, "Carol");
  const room = local(a);
  await startLayers(room, [a, b, c]);
  const sim = layers(room);
  for (const id of [0, 1, 2]) {
    const p = sim.physics.players[id].body.translation(),
      s = LAYERS_MAP.spawns[id];
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.5, `slot ${id} on spawn ${id}`);
  }
  const [sa, sb, sc] = [a, b, c].map((p) => room.state.players.get(p.room.sessionId)!.slot);
  dropOut(room, sb);
  await until(() => [a, b, c].every((p) => last(p) && !(last(p).alive & (1 << sb))));
  assert.ok(a.events.some((e) => e.name === "fall" && e.actor === sb), "everyone hears the fall");
  assert.equal(room.state.phase, "playing", "two left: the round goes on");
  const out = last(b);
  assert.equal(out.layers!.f[sb] & (LAYER_FLAG.alive | LAYER_FLAG.body), 0, "the eliminated player sees themself out");
  assert.ok(out.layers!.o[sb] >= 0);
  dropOut(room, sc);
  await until(() => room.state.phase === "results");
  assert.equal(room.state.winner, sa, "last alive wins");
  await until(() => last(c)?.phase === "results");
  assert.equal(last(c).layers!.r, LAYER_RESULTS.indexOf("survivor"));
  layers(room).round.tick = LAYER_TICKS.results - 2;
  await until(() => [a, b, c].every((p) => p.room.state.phase === "waiting"));
  assert.ok([...room.state.players.values()].every((p) => !p.ready), "Ready cleared for the next round");
  await close(a, b, c);
});

test("reconnect: an alive player comes back to the same seat and body with the exact tile field and state; an eliminated one comes back out; a late joiner watches", { timeout: 40000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby"),
    c = await join(a.room.roomId, "Carol");
  const room = local(a);
  await startLayers(room, [a, b, c]);
  const sim = layers(room);
  const ids = [a, b, c].map((p) => p.room.sessionId);
  const slots = ids.map((id) => room.state.players.get(id)!.slot);
  for (const p of [b, c]) Object.assign(p.room.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 400, maxRetries: 10 });
  // Let some tiles arm and break first.
  await until(() => sim.round.tick > 140);
  // Alive player B drops and reconnects mid-round.
  let reconnects = 0;
  b.room.onReconnect(() => reconnects++);
  const before = b.snapshots.length;
  const tickBefore = last(b).layers!.t;
  sim.game.brawl.fighters[slots[1]].stagger = { time: 5, posture: 0.7, mobility: 0.25 }; // long, to still be on after the round trip
  b.room.connection.close(4010);
  await until(() => room.state.players.get(ids[1])?.connected === false || reconnects > 0);
  await until(() => reconnects === 1 && room.state.players.get(ids[1])?.connected === true);
  await until(() => b.snapshots.length > before + 2);
  const s = last(b);
  assert.equal(b.room.sessionId, ids[1], "same identity");
  assert.equal(room.state.players.get(ids[1])!.slot, slots[1], "same seat");
  assert.equal(room.state.players.size, 3, "no duplicate player");
  assert.equal(sim.physics.players.filter((p) => !p.eliminated).length, 3, "one body each");
  assert.ok(s.layers!.t > tickBefore, "the round clock went on");
  assert.ok(s.alive & (1 << slots[1]) && s.layers!.f[slots[1]] & LAYER_FLAG.body, "still in, body present");
  assert.ok(s.layers!.f[slots[1]] & LAYER_FLAG.staggered, "stagger restored in the snapshot");
  const state = readLayerPredictionState(s.prediction!.layers)!;
  assert.ok(state.staggerTime > 3 && state.staggerPosture === 0.7, "and in the own prediction state");
  assert.equal(sameField(s, sim), 297, "the first snapshots rebuild the exact tile field");
  const seqs = b.snapshots.slice(before).map((x) => x.seq);
  assert.equal(new Set(seqs).size, seqs.length, "no duplicated snapshot handler");
  sim.game.brawl.fighters[slots[1]].stagger.time = 0;
  // Input after the reconnect is accepted again.
  const round = sim.roundId;
  b.room.send("input", layerInput(round, { moveZ: 1 }));
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
  assert.equal(cs.layers!.f[slots[2]] & (LAYER_FLAG.alive | LAYER_FLAG.body), 0, "no body, no respawn");
  assert.ok(cs.layers!.f[slots[2]] & LAYER_FLAG.inMatch, "still in this round's roster (spectating it)");
  assert.equal(sim.physics.players[slots[2]].eliminated, true);
  assert.equal(room.state.phase, "playing");
  assert.equal(sameField(cs, sim), 297);
  await close(a, b, c);
});

test("a late joiner watches the round with the full tile field; leaving is a forfeit", { timeout: 30000 }, async () => {
  const a = await create("Alice"),
    b = await join(a.room.roomId, "Bobby");
  const room = local(a);
  await startLayers(room, [a, b]);
  const sim = layers(room);
  await until(() => sim.round.tick > 100);
  const late = await join(a.room.roomId, "Carol");
  await until(() => late.snapshots.length > 2);
  const s = last(late);
  assert.equal(room.state.players.get(late.room.sessionId)!.participating, false, "spectator");
  assert.equal(s.mask & (1 << room.state.players.get(late.room.sessionId)!.slot), 0);
  assert.equal(sameField(s, sim), 297, "the whole field from its first snapshot");
  // Bobby leaves for good: a forfeit, Alice wins.
  const aliceSlot = room.state.players.get(a.room.sessionId)!.slot as PlayerId;
  await close(b);
  await until(() => room.state.phase === "results");
  assert.equal(room.state.winner, aliceSlot);
  await until(() => last(a)?.phase === "results");
  assert.equal(last(a).layers!.r, LAYER_RESULTS.indexOf("forfeit"));
  await close(a, late);
});
