import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import { type PartyRoom } from "../src/PartyRoom.js";
import { appendChat, ChatMessage, type LobbyState } from "../src/state.js";
import { RECONNECT_SECONDS } from "../src/validation.js";

const { server, httpServer } = createPartyServer();
let endpoint: string;
const rooms = new Set<Room<unknown, LobbyState>>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for synchronized state");
    await pause(20);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const room of rooms) { room.reconnection.enabled = false; if (room.connection.isOpen) await room.leave().catch(() => {}); }
  await server.gracefullyShutdown(false);
});
function track(room: Room<unknown, LobbyState>) { rooms.add(room); room.onMessage("notice", () => {}); return room; }
async function create(name = "Alice") { return track(await new Client(endpoint).create<LobbyState>("party_lab", { nickname: name, intent: "create" })); }
async function join(code: string, name = "Alice") { return track(await new Client(endpoint).joinById<LobbyState>(code, { nickname: name, intent: "join", code })); }
async function leave(room: Room<unknown, LobbyState>) { await room.leave(); rooms.delete(room); }

test("invalid admissions and nonexistent rooms are rejected by the server", async () => {
  await assert.rejects(create("x"));
  await assert.rejects(new Client(endpoint).create("party_lab", { nickname: "Alice" }));
  await assert.rejects(join("ABC234"));
  const room = await create();
  await assert.rejects(new Client(endpoint).joinById(room.roomId, { nickname: "Bob", intent: "join", code: "ABC123" }));
  await assert.rejects(new Client(endpoint).joinById(room.roomId, { nickname: "Bob", intent: "create" }));
  await leave(room);
});

test("concurrent admissions allow exactly three distinct sessions, including duplicate nicknames", async () => {
  const first = await create();
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => join(first.roomId)));
  const admitted = attempts.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  assert.equal(admitted.length, 2);
  assert.equal(attempts.filter(result => result.status === "rejected").length, 3);
  const all = [first, ...admitted];
  await until(() => all.every(room => room.state?.players?.size === 3));
  assert.equal(new Set(all.map(room => room.sessionId)).size, 3);
  const expected = [...first.state.players.keys()].sort();
  all.forEach(room => assert.deepEqual([...room.state.players.keys()].sort(), expected));
  await assert.rejects(join(first.roomId, "Fourth"));
  const id = first.roomId;
  await leave(first); // Creator is just another client; the room remains authoritative.
  await until(() => admitted.every(room => room.state.players.size === 2));
  const replacement = await join(id, "NewFriend");
  await until(() => replacement.state?.players?.size === 3);
  for (const room of [...admitted, replacement]) await leave(room);
  await until(() => !matchMaker.getLocalRoomById(id));
  await assert.rejects(join(id));
});

test("server validates chat, rate limits, rejects unknown types, and caps transient history", async () => {
  const sender = await create();
  const receiver = await join(sender.roomId, "Bob");
  await until(() => receiver.state?.players?.size === 2);
  const notices: string[] = [];
  sender.onMessage("notice", (code: string) => notices.push(code));
  sender.send("chat", { text: "spoof", playerId: receiver.sessionId });
  sender.send("chat", "x".repeat(281));
  sender.send("chat", "<b>Hello</b>");
  sender.send("chat", "Fourth attempt");
  sender.send("chat", "Too fast");
  sender.send("positions", { x: 99 });
  await until(() => notices.includes("CHAT_RATE_LIMIT") && notices.includes("INVALID_MESSAGE") && receiver.state.messages.length === 2);
  assert.equal(notices.filter(code => code === "INVALID_CHAT").length, 2);
  assert.equal(receiver.state.messages[0].text, "<b>Hello</b>");
  assert.equal(receiver.state.messages[0].playerId, sender.sessionId);
  assert.equal(receiver.state.messages[0].nickname, "Alice");
  // Exercise the same bounded history helper without advancing real timers.
  const local = matchMaker.getLocalRoomById(sender.roomId) as PartyRoom;
  for (let i = 0; i < 44; i++) {
    const message = new ChatMessage();
    message.text = `message ${i}`;
    appendChat(local.state, message);
  }
  await until(() => receiver.state.messages.length === 40);
  assert.equal(local.state.messages.length, 40);
  assert.equal(local.state.messages[0].text, "message 4");
  await leave(sender); await leave(receiver);
  await until(() => !matchMaker.getLocalRoomById(local.roomId));
  assert.equal(local.state.messages.length, 0);
});

test("dropped seats stay reserved, reconnect keeps identity, expiry frees capacity", { timeout: 25000 }, async () => {
  const first = await create();
  const second = await join(first.roomId, "Bob");
  const third = await join(first.roomId, "Cara");
  await until(() => first.state?.players?.size === 3);
  const id = second.sessionId;
  const token = second.reconnectionToken;
  second.reconnection.enabled = false;
  second.connection.close(4001); // Non-consented socket drop, not room.leave().
  await until(() => first.state.players.get(id)?.connected === false);
  await assert.rejects(join(first.roomId, "Fourth"));
  const restored = track(await new Client(endpoint).reconnect<LobbyState>(token));
  assert.equal(restored.sessionId, id);
  await until(() => first.state.players.get(id)?.connected === true);
  await assert.rejects(new Client(endpoint).reconnect<LobbyState>(token), "old/duplicate credentials cannot admit another player");
  restored.reconnection.enabled = false;
  restored.connection.close(4001);
  await until(() => !first.state.players.has(id), (RECONNECT_SECONDS + 2) * 1000);
  const fourth = await join(first.roomId, "Fourth");
  await until(() => first.state.players.size === 3);
  await leave(first); await leave(third); await leave(fourth);
  rooms.delete(second); rooms.delete(restored);
});

test("SDK automatically recovers a short drop on the same room and session", async () => {
  const room = await create();
  await until(() => room.state?.players?.size === 1);
  Object.assign(room.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 500, maxRetries: 10 });
  let dropped = false;
  let recovered = false;
  const id = room.sessionId;
  room.onDrop(() => { dropped = true; });
  room.onReconnect(() => { recovered = true; });
  room.connection.close(4010); // Browser-legal, non-consented "may reconnect" close.
  await until(() => dropped && recovered && room.connection.isOpen);
  assert.equal(room.sessionId, id);
  await until(() => room.state.players.get(id)?.connected === true);
  await leave(room);
});
