import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { NET, encodePropInput, type PropInputPacket, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { PropRoundSimulation } from "../../../shared/party-lab/simulation/propRound.js";
import { reconstructPropLayout, type PropOnlineEvent } from "../../../shared/party-lab/simulation/prophunt/wire.js";
import { PROP_TICKS } from "../../../shared/party-lab/simulation/prophunt/config.js";
import { retire } from "../../../shared/party-lab/simulation/layers/game.js";
import { restore } from "../../../shared/party-lab/simulation/ragdoll/character.js";

const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms = new Set<Room<unknown, LobbyState>>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw Error("Timed out"); await pause(10); }
}
before(async () => { await server.listen(0, "127.0.0.1"); endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`; });
after(async () => {
  for (const room of rooms) { room.reconnection.enabled = false; if (room.connection.isOpen) await room.leave().catch(() => {}); }
  await server.gracefullyShutdown(false);
});
interface Peer { room: Room<unknown, LobbyState>; snapshots: GameSnapshot[]; events: PropOnlineEvent[]; }
function track(room: Room<unknown, LobbyState>): Peer {
  rooms.add(room);
  const peer = { room, snapshots: [] as GameSnapshot[], events: [] as PropOnlineEvent[] };
  room.onMessage("snapshot", (snapshot: GameSnapshot) => peer.snapshots.push(snapshot));
  room.onMessage("propEvent", (event: PropOnlineEvent) => peer.events.push(event));
  room.onMessage("notice", () => {});
  return peer;
}
const create = async (nickname: string) => track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) => track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (peer: Peer) => matchMaker.getLocalRoomById(peer.room.roomId) as PartyRoom;
async function close(...peers: Peer[]) {
  for (const peer of peers) { peer.room.reconnection.enabled = false; if (peer.room.connection.isOpen) await peer.room.leave().catch(() => {}); rooms.delete(peer.room); }
}

async function start(a: Peer, b: Peer, c: Peer) {
  const room = local(a);
  for (const p of [a, b, c]) p.room.send("ready", true);
  await until(() => room.game instanceof PropRoundSimulation && room.game.phase === "countdown");
  const sim = room.game as PropRoundSimulation;
  sim.round.tick = PROP_TICKS.countdown - 2;
  await until(() => sim.phase === "playing");
  return sim;
}

test("Prop Hunt lobby: host authority, ready resets, stored settings, exactly 3 and seat rotation", { timeout: 30000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), room = local(a);
  a.room.send("mode", "prop_hunt"); await until(() => b.room.state.mode === "prop_hunt");
  assert.equal(room.state.propAmmo, 15); assert.equal(room.state.propProximity, true);
  a.room.send("ready", true); b.room.send("ready", true); await pause(200);
  assert.equal(room.game.phase, "waiting");
  b.room.send("propSettings", { ammo: 5, proximity: false }); await pause(100);
  assert.equal(room.state.propAmmo, 15);
  for (const ammo of [5, 10, 15]) {
    a.room.send("propSettings", { ammo, proximity: false });
    await until(() => room.state.propAmmo === ammo && !room.state.propProximity);
    assert.ok([...room.state.players.values()].every(p => !p.ready));
    a.room.send("ready", true); b.room.send("ready", true); await pause(100);
  }
  a.room.send("propSettings", { proximity: true });
  a.room.send("propSettings", { ammo: 5 });
  await until(() => room.state.propAmmo === 5 && room.state.propProximity);
  const c = await join(a.room.roomId, "Carol");
  for (let i = 0; i < 4; i++) {
    const sim = await start(a, b, c);
    assert.equal(sim.round.seeker, i % 3); assert.equal(sim.game.ammo, 5);
    assert.equal(sim.game.proximityEnabled, true);
    a.room.send("propSettings", { ammo: 15, proximity: false }); await pause(80);
    assert.equal(sim.game.ammo, 5); assert.equal(room.state.propAmmo, 5);
    sim.round.phase = "search"; sim.round.tick = PROP_TICKS.search - 2;
    await until(() => sim.phase === "results"); sim.round.tick = PROP_TICKS.results - 2;
    await until(() => a.room.state.phase === "waiting");
  }
  a.room.send("mode", "mixed"); await until(() => room.selection === "mixed");
  assert.equal(room.state.propAmmo, 5); assert.equal(room.state.propProximity, true);
  await close(a, b, c);
});

test("Prop Hunt reconnect seeker and disguised hider: seat, layout, roles, ammo, timers and latch persist", { timeout: 30000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), c = await join(a.room.roomId, "Carol"), room = local(a);
  a.room.send("mode", "prop_hunt"); await until(() => room.selection === "prop_hunt");
  const sim = await start(a, b, c); sim.round.tick = PROP_TICKS.hiding - 2;
  await until(() => sim.round.phase === "search");
  retire(sim.physics.players[1]); sim.game.disguises.wear(1, "crate", { x: 5, y: 0.02, z: 3 }, 0);
  sim.game.ammo = 7; sim.game.manualWhistleCooldown[1] = 420; sim.game.sense.armed = false;
  restore(sim.physics.players[0], { x: 5, y: 0.8, z: 6 });
  const hash = sim.game.layout.id, round = sim.roundId, roles = [...sim.game.roles];
  for (const p of [a, b]) {
    let resumed = 0; const id = p.room.sessionId, slot = room.state.players.get(id)!.slot;
    Object.assign(p.room.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 300, maxRetries: 10 });
    p.room.onReconnect(() => resumed++); p.room.connection.close(4010);
    await until(() => resumed === 1 && room.state.players.get(id)?.connected === true);
    const before = p.snapshots.length; await until(() => p.snapshots.length > before);
    const snap = p.snapshots.at(-1)!;
    assert.equal(room.state.players.get(id)?.slot, slot); assert.equal(snap.round, round);
    assert.equal(snap.prop?.ammo, 7); assert.equal(snap.prop?.hash, hash);
    assert.equal(reconstructPropLayout(snap.prop!).id, hash); assert.deepEqual(sim.game.roles, roles);
    assert.equal(sim.game.disguiseOf(1)?.family, "crate"); assert.ok(sim.game.manualWhistleCooldown[1] > 300);
    assert.equal(sim.game.sense.armed, false); assert.equal(room.state.players.size, 3);
    assert.equal(sim.rotation.next, 1);
  }
  await close(a, b, c);
});

test("Prop Hunt wire events: manual whistle strict validation, proximity only to seeker and no identity", { timeout: 20000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), c = await join(a.room.roomId, "Carol"), room = local(a);
  a.room.send("mode", "prop_hunt"); await until(() => room.selection === "prop_hunt");
  const sim = await start(a, b, c); sim.round.tick = PROP_TICKS.hiding - 2; await until(() => sim.round.phase === "search");
  restore(sim.physics.players[0], { x: 5, y: 0.8, z: 6 });
  retire(sim.physics.players[1]); sim.game.disguises.wear(1, "crate", { x: 5, y: 0.02, z: 3 }, 0);
  const intent: PropInputPacket = { seq: 1, round: sim.roundId, moveX: 0, moveZ: 0, jumpPressed: false, sprintHeld: false, attackPressed: false, attackHeld: false, pickupPressed: false, whistlePressed: true, aimYaw: 0, aimPitch: 0, eyeX: 0, eyeY: 1, eyeZ: 0, viewTick: sim.tick };
  b.room.send("input", encodePropInput(intent)); b.room.send("input", encodePropInput(intent));
  await until(() => [a, b, c].every(p => p.events.some(e => e.type === "whistle")));
  assert.equal(sim.game.manualWhistles[1], 1);
  const whistle = a.events.find(e => e.type === "whistle")!;
  assert.deepEqual(Object.keys(whistle).sort(), ["at", "eid", "round", "tick", "type"]);
  await until(() => a.events.some(e => e.type === "near"));
  assert.ok(!b.events.some(e => e.type === "near") && !c.events.some(e => e.type === "near"));
  assert.deepEqual(Object.keys(a.events.find(e => e.type === "near")!).sort(), ["eid", "round", "tick", "type"]);
  await close(a, b, c);
});
