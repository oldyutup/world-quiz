import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { PropRoundSimulation } from "../../../shared/party-lab/simulation/propRound.js";
import { reconstructPropLayout } from "../../../shared/party-lab/simulation/prophunt/wire.js";
import { PROP_TICKS } from "../../../shared/party-lab/simulation/prophunt/config.js";
import { MARKET_DEALER } from "../../../shared/party-lab/maps/marketLayout.js";

const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms = new Set<Room<unknown, LobbyState>>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw Error(`Timed out: ${check.toString()}`); await pause(10); }
}
before(async () => { await server.listen(0, "127.0.0.1"); endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`; });
after(async () => {
  for (const room of rooms) { room.reconnection.enabled = false; if (room.connection.isOpen) await room.leave().catch(() => {}); }
  await server.gracefullyShutdown(false);
});
interface Peer { room: Room<unknown, LobbyState>; snapshots: GameSnapshot[]; notices: string[]; }
function track(room: Room<unknown, LobbyState>): Peer {
  rooms.add(room);
  const peer = { room, snapshots: [] as GameSnapshot[], notices: [] as string[] };
  room.onMessage("snapshot", (snapshot: GameSnapshot) => peer.snapshots.push(snapshot));
  room.onMessage("propEvent", () => {});
  room.onMessage("notice", (n: string) => peer.notices.push(n));
  return peer;
}
const create = async (nickname: string) => track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) => track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (peer: Peer) => matchMaker.getLocalRoomById(peer.room.roomId) as PartyRoom;
async function close(...peers: Peer[]) {
  for (const peer of peers) { peer.room.reconnection.enabled = false; if (peer.room.connection.isOpen) await peer.room.leave().catch(() => {}); rooms.delete(peer.room); }
}
/** Everyone Ready; the introduction skipped; returns the round once hiding has begun. */
async function start(peers: Peer[]) {
  const room = local(peers[0]);
  // Let the room settle into the lobby (its Ready reset) before everyone confirms.
  await pause(250);
  for (const p of peers) p.room.send("ready", true);
  await until(() => room.game instanceof PropRoundSimulation && room.game.phase === "countdown");
  const sim = room.game as PropRoundSimulation;
  sim.round.tick = PROP_TICKS.countdown - 2;
  await until(() => sim.phase === "playing");
  return sim;
}
async function finish(sim: PropRoundSimulation, peer: Peer) {
  sim.round.phase = "search"; sim.round.tick = PROP_TICKS.search - 2;
  await until(() => sim.phase === "results"); sim.round.tick = PROP_TICKS.results - 2;
  await until(() => peer.room.state.phase === "waiting");
}

test("Saklambaç map: Rastgele by default, host only, a change clears Ready; the chosen map is played and named in every snapshot", { timeout: 40000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), c = await join(a.room.roomId, "Carol"), room = local(a);
  a.room.send("mode", "prop_hunt"); await until(() => b.room.state.mode === "prop_hunt");
  assert.equal(room.state.propMap, "random");
  await until(() => b.room.state.propMap === "random");
  // A guest cannot choose; nonsense is ignored.
  b.room.send("propSettings", { map: "market" }); await pause(150);
  assert.equal(room.state.propMap, "random");
  assert.ok(b.notices.includes("MODE_HOST_ONLY"));
  a.room.send("propSettings", { map: "forest" }); await pause(150);
  assert.equal(room.state.propMap, "random");
  // The host picks the Market: everyone confirms again.
  b.room.send("ready", true); await until(() => room.state.players.get(b.room.sessionId)?.ready === true);
  a.room.send("propSettings", { map: "market" });
  await until(() => room.state.propMap === "market" && c.room.state.propMap === "market");
  assert.ok([...room.state.players.values()].every((p) => !p.ready));
  let sim = await start([a, b, c]);
  assert.equal(sim.mapChoice, "market");
  assert.equal(sim.game.map.id, "market");
  for (const p of [a, b, c]) await until(() => p.snapshots.some((s) => s.prop?.map === "market" && s.round === sim.roundId));
  const wire = a.snapshots.filter((s) => s.prop?.map === "market").at(-1)!.prop!;
  assert.equal(reconstructPropLayout(wire).id, sim.game.layout.id);
  assert.equal(sim.game.layout.id, MARKET_DEALER.roundLayout(room.propRotation.seed, 0).id);
  // A change during the round waits for the lobby (and is refused now).
  a.room.send("propSettings", { map: "camp" }); await pause(100);
  assert.equal(room.state.propMap, "market");
  await finish(sim, a);
  a.room.send("propSettings", { map: "camp" }); await until(() => room.state.propMap === "camp");
  sim = await start([a, b, c]);
  assert.equal(sim.game.map.id, "camp");
  for (const p of [a, b, c]) await until(() => p.snapshots.some((s) => s.prop?.map === "camp" && s.round === sim.roundId));
  await finish(sim, a);
  // Rastgele: every round tossed again (the room's coin; here a fixed one).
  a.room.send("propSettings", { map: "random" }); await until(() => room.state.propMap === "random");
  const coin = [0.8, 0.2, 0.6];
  let k = 0;
  (room.game as PropRoundSimulation).random = () => coin[k++];
  const maps: string[] = [];
  for (let r = 0; r < 3; r++) {
    sim = await start([a, b, c]);
    assert.equal(sim.mapChoice, "random");
    maps.push(sim.game.map.id);
    await finish(sim, a);
  }
  assert.deepEqual(maps, ["market", "camp", "market"]);
  // Each map kept its own layout sequence across the rounds in between.
  assert.equal(room.propRotation.chains.market.index, 2);
  assert.equal(room.propRotation.chains.camp.index, 1);
  await close(a, b, c);
});

test("Saklambaç map in Mixed and Tahta Oyunu: always Rastgele, whatever the host chose for Saklambaç", { timeout: 30000 }, async () => {
  const a = await create("Alice"), b = await join(a.room.roomId, "Bobby"), c = await join(a.room.roomId, "Carol"), room = local(a);
  a.room.send("mode", "prop_hunt"); await until(() => room.selection === "prop_hunt");
  a.room.send("propSettings", { map: "camp" }); await until(() => room.state.propMap === "camp");
  a.room.send("mode", "mixed"); await until(() => room.selection === "mixed");
  while (room.rotation.next !== "prop_hunt") room.rotation.played();
  room.upcoming = room.rotation.next;
  room["syncGameState"]();
  await until(() => a.room.state.mode === "prop_hunt");
  const sim = await start([a, b, c]);
  assert.equal(sim.mapChoice, "random");
  assert.equal(room.state.propMap, "camp", "the host's Saklambaç choice is kept for later");
  await finish(sim, a);
  // A board round's mini game.
  room["ensureSimulation"]("prop_hunt");
  assert.ok(room["startBoardMini"]("prop_hunt", [0, 1, 2]));
  assert.equal((room.game as PropRoundSimulation).mapChoice, "random");
  await close(a, b, c);
});
