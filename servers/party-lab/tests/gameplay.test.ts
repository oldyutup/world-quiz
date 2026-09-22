import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import type {
  GameSnapshot,
  GameEvent,
} from "../../../shared/party-lab/network/protocol.js";
import { restore } from "../../../shared/party-lab/simulation/ragdoll/character.js";
import { IDLE_INPUT } from "../../../shared/party-lab/simulation/physics.js";
const { server, httpServer } = createPartyServer();
let endpoint = "";
type Peer = {
  room: Room<unknown, LobbyState>;
  snapshots: GameSnapshot[];
  events: GameEvent[];
};
const peers: Peer[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out");
    await pause(20);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const p of peers) {
    p.room.reconnection.enabled = false;
    if (p.room.connection.isOpen) await p.room.leave().catch(() => {});
  }
  await server.gracefullyShutdown(false);
});
async function peer(code?: string, name = "Alice") {
  const client = new Client(endpoint);
  const room = code
    ? await client.joinById<LobbyState>(code, {
        nickname: name,
        intent: "join",
        code,
      })
    : await client.create<LobbyState>("party_lab", {
        nickname: name,
        intent: "create",
      });
  const p: Peer = { room, snapshots: [], events: [] };
  peers.push(p);
  room.onMessage("notice", () => {});
  room.onMessage("snapshot", (s: GameSnapshot) => p.snapshots.push(s));
  room.onMessage("feedback", (events: GameEvent[]) => p.events.push(...events));
  return p;
}
const local = (p: Peer) =>
  matchMaker.getLocalRoomById(p.room.roomId) as PartyRoom;
const intent = (seq: number, round: number, moveX = 0) => ({
  seq,
  round,
  moveX,
  moveZ: 0,
  jumpPressed: false,
  punchPressed: false,
  grabHeld: false,
  liftHeld: false,
});
async function close(...list: Peer[]) {
  for (const p of list) if (p.room.connection.isOpen) await p.room.leave();
}
test("server ready gate: one cannot start, unready blocks two, all three start; only own input accepted", async () => {
  const a = await peer();
  a.room.send("ready", true);
  await pause(150);
  assert.equal(local(a).state.phase, "waiting");
  const b = await peer(a.room.roomId, "Bobby"),
    c = await peer(a.room.roomId, "Carol");
  b.room.send("ready", true);
  await pause(150);
  assert.equal(local(a).state.phase, "waiting");
  c.room.send("ready", { slot: 0, ready: true });
  await pause(100);
  assert.equal(local(a).state.phase, "waiting");
  c.room.send("ready", true);
  await until(() => [a, b, c].every((p) => p.room.state.phase === "countdown"));
  const room = local(a);
  assert.equal(room.game.mask, 7);
  assert.equal(
    new Set([...room.state.players.values()].map((p) => p.slot)).size,
    3
  );
  a.room.send("input", {
    ...intent(1, room.game.roundId, 1),
    punchPressed: true,
  });
  await until(() => a.room.state.phase === "playing");
  assert.equal(room.game.combat.stats.punches, 0, "countdown input discarded");
  const slot = room.state.players.get(a.room.sessionId)!.slot;
  a.room.send("input", { ...intent(2, room.game.roundId, 1), slot: 1 });
  await pause(80);
  assert.equal(
    a.snapshots[a.snapshots.length - 1].ack[slot],
    -1,
    "spoof packet rejected"
  );
  a.room.send("input", {
    ...intent(3, room.game.roundId, 1),
    punchPressed: true,
    grabHeld: true,
  });
  a.room.send("input", {
    ...intent(3, room.game.roundId, 1),
    punchPressed: true,
    grabHeld: true,
  });
  await until(() => a.snapshots.some((s) => s.ack[slot] === 3));
  assert.equal(room.game.combat.stats.punches, 1);
  await pause(450);
  const same = a.snapshots[a.snapshots.length - 2];
  await until(() =>
    [b, c].every((p) => p.snapshots.some((s) => s.seq === same.seq))
  );
  for (const p of [b, c])
    assert.deepEqual(
      p.snapshots.find((s) => s.seq === same.seq),
      same
    );
  assert.ok(same.transforms instanceof Uint8Array);
  assert.equal(same.transforms.length, 756);
  assert.equal(room.game.combat.stats.punches, 1);
  assert.equal(
    room.game.combat.grips.count(slot as 0 | 1 | 2),
    0,
    "stale held input released"
  );
  await close(a, b, c);
});
test("two real players start without bots; late join waits, fourth rejected; authoritative fall/winner/reset agree", async () => {
  const a = await peer(undefined, "Host"),
    b = await peer(a.room.roomId, "Guest");
  a.room.send("ready", true);
  b.room.send("ready", true);
  await until(() => a.room.state.phase === "playing");
  const room = local(a);
  assert.equal(
    room.game.physics.players.filter((p) => !p.eliminated).length,
    2
  );
  const c = await peer(a.room.roomId, "Later");
  await until(() => c.room.state?.players?.size === 3);
  assert.equal(room.state.players.get(c.room.sessionId)!.participating, false);
  assert.equal(room.game.mask, 3);
  await assert.rejects(peer(a.room.roomId, "Fourth"));
  const slot = room.state.players.get(b.room.sessionId)!.slot;
  restore(room.game.physics.players[slot], { x: 0, y: -6, z: 0 }, 0);
  await until(() =>
    [a, b, c].every(
      (p) =>
        p.room.state.phase === "results" &&
        p.events.some((e) => e.name === "winner")
    )
  );
  for (const p of [a, b, c]) {
    assert.equal(p.room.state.winner, 0);
    assert.equal(
      p.events.filter((e) => e.name === "fall" && e.actor === slot).length,
      1
    );
    assert.equal(p.events.filter((e) => e.name === "winner").length, 1);
  }
  await until(() => [a, b, c].every((p) => p.room.state.phase === "waiting"));
  assert.ok(room.game.combat.grips.hands.flat().every((g) => g === null));
  assert.ok([...room.state.players.values()].every((p) => !p.ready));
  for (const p of [a, b, c]) p.room.send("ready", true);
  await until(() => room.game.phase === "playing");
  assert.equal(room.game.mask, 7);
  restore(room.game.physics.players[slot], { x: 0, y: -6, z: 0 }, 0);
  await until(() =>
    [a, b, c].every(
      (p) =>
        p.events.filter((e) => e.name === "fall" && e.actor === slot).length ===
        2
    )
  );
  for (const p of [a, b, c])
    assert.equal(new Set(p.events.map((e) => e.id)).size, p.events.length);
  await close(a, b, c);
});
test(
  "disconnect clears punches/grips immediately; reconnect preserves slot and expiry forfeits safely",
  { timeout: 25000 },
  async () => {
    const a = await peer(undefined, "First"),
      b = await peer(a.room.roomId, "Second");
    a.room.send("ready", true);
    b.room.send("ready", true);
    await until(() => a.room.state.phase === "playing");
    const room = local(a),
      slot = room.state.players.get(b.room.sessionId)!.slot;
    // Arrange a real grip through the shared authoritative combat path, never a client result message.
    restore(room.game.physics.players[1], { x: 0, y: 1, z: 1 }, 0);
    restore(room.game.physics.players[0], { x: 0, y: 1, z: 1.85 }, 0);
    for (let i = 0; i < 180; i++) room.game.step([]);
    for (let i = 0; i < 65; i++)
      room.game.step([IDLE_INPUT, { ...IDLE_INPUT, grab: true }]);
    assert.ok(room.game.combat.grips.count(1) > 0);
    const token = b.room.reconnectionToken;
    b.room.reconnection.enabled = false;
    b.room.connection.close(4001);
    await until(
      () => room.state.players.get(b.room.sessionId)?.connected === false
    );
    assert.equal(room.game.combat.grips.count(1), 0);
    assert.ok(room.game.combat.players[1].punches.every((p) => p.age < 0));
    const resumed = await new Client(endpoint).reconnect<LobbyState>(token);
    resumed.onMessage("snapshot", () => {});
    resumed.onMessage("feedback", () => {});
    resumed.onMessage("notice", () => {});
    await until(
      () => room.state.players.get(b.room.sessionId)?.connected === true
    );
    assert.equal(room.state.players.get(resumed.sessionId)?.slot, slot);
    resumed.reconnection.enabled = false;
    resumed.connection.close(4001);
    await until(() => !room.state.players.has(b.room.sessionId), 17000);
    assert.equal(room.game.physics.players[slot].eliminated, true);
    assert.equal(room.game.combat.grips.count(1), 0);
    await close(a);
  }
);

test("countdown departure cancels safely and a replacement session never inherits an active slot", async () => {
  const a = await peer(undefined, "Alpha"),
    b = await peer(a.room.roomId, "Bravo");
  a.room.send("ready", true);
  b.room.send("ready", true);
  await until(() => local(a).game.phase === "countdown");
  await close(b);
  await until(() => local(a).game.phase === "waiting");
  assert.equal(local(a).state.players.get(a.room.sessionId)!.ready, false);
  const c = await peer(a.room.roomId, "Charlie"),
    d = await peer(a.room.roomId, "Delta");
  for (const p of [a, c, d]) p.room.send("ready", true);
  await until(() => local(a).game.phase === "playing");
  const room = local(a),
    slot = room.state.players.get(c.room.sessionId)!.slot;
  await close(c);
  await until(() => !room.state.players.has(c.room.sessionId));
  const replacement = await peer(a.room.roomId, "Echo");
  await until(() => replacement.room.state?.players?.size === 3);
  const player = room.state.players.get(replacement.room.sessionId)!;
  assert.equal(player.slot, slot);
  assert.equal(player.participating, false);
  replacement.room.send("input", {
    ...intent(1, room.game.roundId),
    punchPressed: true,
  });
  await pause(150);
  assert.equal(room.game.physics.players[slot].eliminated, true);
  assert.equal(room.game.combat.stats.punches, 0);
  await close(a, d, replacement);
});

test("waiting eligibility is reevaluated when an unready third player leaves", async () => {
  const a = await peer(undefined, "ReadyA"),
    b = await peer(a.room.roomId, "ReadyB"),
    c = await peer(a.room.roomId, "UnreadyC");
  a.room.send("ready", true);
  b.room.send("ready", true);
  await pause(150);
  assert.equal(local(a).game.phase, "waiting");
  await close(c);
  await until(() => local(a).game.phase === "countdown");
  assert.equal(local(a).game.mask, 3);
  await close(a, b);
});
