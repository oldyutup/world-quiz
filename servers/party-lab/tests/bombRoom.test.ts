import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { BOMB_PREDICTION_BYTES, NET, type BombInputPacket, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { BombRoundSimulation } from "../../../shared/party-lab/simulation/bombRound.js";
import { decodeBombSnapshot } from "../../../shared/party-lab/simulation/bomb/wire.js";
import { BOMB_TICKS } from "../../../shared/party-lab/simulation/bomb/config.js";
import type { PlayerId } from "../../../shared/party-lab/simulation/players.js";

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
interface Peer { room: Room<unknown, LobbyState>; snapshots: GameSnapshot[]; }
function track(room: Room<unknown, LobbyState>): Peer {
  rooms.add(room);
  const peer = { room, snapshots: [] as GameSnapshot[] };
  room.onMessage("snapshot", (snapshot: GameSnapshot) => peer.snapshots.push(snapshot));
  return peer;
}
const create = async (nickname: string) => track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) => track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (peer: Peer) => matchMaker.getLocalRoomById(peer.room.roomId) as PartyRoom;
async function close(...peers: Peer[]) {
  for (const peer of peers) { peer.room.reconnection.enabled = false; if (peer.room.connection.isOpen) await peer.room.leave().catch(() => {}); rooms.delete(peer.room); }
}

test("bomb room: authoritative packet, compact snapshot, reconnect preserves carrier/fuse/trap slow", { timeout: 30000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), room = local(a);
  a.room.send("mode", "bomb_tag");
  await until(() => room.selection === "bomb_tag" && b.room.state.mode === "bomb_tag");
  a.room.send("ready", true); b.room.send("ready", true);
  await until(() => room.game instanceof BombRoundSimulation && room.game.phase === "countdown");
  const sim = room.game as BombRoundSimulation;
  sim.round.tick = BOMB_TICKS.countdown - 2;
  await until(() => sim.phase === "playing");
  const slot = room.state.players.get(b.room.sessionId)!.slot as PlayerId;
  let seq = 0;
  const input = (extra: Partial<BombInputPacket> = {}): BombInputPacket => ({ seq: ++seq, round: sim.roundId, moveX: 0, moveZ: 0, jumpPressed: false, sprintHeld: false, punchPressed: false, viewTick: sim.tick, ...extra });
  b.room.send("input", input({ moveX: 1, sprintHeld: true }));
  await until(() => (b.snapshots[b.snapshots.length - 1]?.ack[slot] ?? -1) >= 1);
  const first = b.snapshots[b.snapshots.length - 1], section = decodeBombSnapshot(first.bomb)!;
  assert.equal(first.mode, "bomb_tag");
  assert.equal(first.v, 9);
  assert.equal(first.prediction?.slot, slot);
  assert.equal(first.prediction?.bomb?.byteLength, BOMB_PREDICTION_BYTES);
  assert.ok(section.carrier !== null && section.fuseEnd !== null);
  // Set unmistakable state, then force a reconnect. No rule is restarted while the seat is reserved.
  sim.game.bomb.carrier = slot;
  sim.game.bomb.phase = "armed";
  sim.game.bomb.fuse = 321;
  sim.game.traps.traps[1].armed = false;
  sim.game.traps.traps[1].rearmIn = 222;
  sim.game.traps.slowed[slot] = 44;
  const beforeRound = sim.roundId;
  Object.assign(b.room.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 400, maxRetries: 10 });
  let reconnects = 0;
  b.room.onReconnect(() => reconnects++);
  b.room.connection.close(4010);
  await until(() => reconnects === 1 && room.state.players.get(b.room.sessionId)?.connected === true);
  const receivedBefore = b.snapshots.length;
  await until(() => b.snapshots.length > receivedBefore);
  const restored = decodeBombSnapshot(b.snapshots[b.snapshots.length - 1].bomb)!;
  assert.equal(sim.roundId, beforeRound);
  assert.equal(restored.carrier, slot);
  assert.ok(restored.fuseEnd !== null && restored.fuseEnd - restored.tick <= 321 && restored.fuseEnd - restored.tick > 280, "same burning fuse, not restarted");
  assert.equal(restored.armedMask & 2, 0);
  assert.ok(restored.rearmAt[1] > restored.tick);
  assert.ok(restored.slowUntil[slot] > restored.tick);
  assert.equal(room.state.players.size, 2, "no duplicate seat");
  await close(a, b);
});

test("bomb leave is a forfeit, not a disconnect-time explosion", { timeout: 20000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), room = local(a);
  a.room.send("mode", "bomb_tag"); await until(() => room.selection === "bomb_tag");
  a.room.send("ready", true); b.room.send("ready", true);
  await until(() => room.game instanceof BombRoundSimulation && room.game.phase === "countdown");
  const sim = room.game as BombRoundSimulation;
  sim.round.tick = BOMB_TICKS.countdown - 2;
  await until(() => sim.phase === "playing");
  const leaving = room.state.players.get(b.room.sessionId)!.slot as PlayerId,
    survivor = room.state.players.get(a.room.sessionId)!.slot as PlayerId;
  sim.game.bomb.carrier = leaving;
  b.room.reconnection.enabled = false;
  await b.room.leave(); rooms.delete(b.room);
  await until(() => sim.phase === "results");
  assert.equal(sim.winner, survivor);
  assert.equal(sim.game.bomb.blasts, 0);
  await close(a);
});
