import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { MAX_MESSAGES_PER_SECOND } from "../src/validation.js";
import {
  NET,
  type PongPacket,
} from "../../../shared/party-lab/network/protocol.js";

const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms = new Set<Room<unknown, LobbyState>>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
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
function track(room: Room<unknown, LobbyState>) {
  rooms.add(room);
  for (const type of ["snapshot", "feedback", "notice", "pong"])
    if (!(room as unknown as { onMessageHandlers: { events: Record<string, unknown> } }).onMessageHandlers.events[type])
      room.onMessage(type, () => {});
  return room;
}
const create = async (nickname = "Alice") =>
  track(await new Client(endpoint).create<LobbyState>("party_lab", { protocol: NET.version, nickname, intent: "create" }));
const join = async (code: string, nickname: string) =>
  track(await new Client(endpoint).joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code }));
const local = (room: Room<unknown, LobbyState>) =>
  matchMaker.getLocalRoomById(room.roomId) as PartyRoom;
const texts = (state: LobbyState) => {
  const out: string[] = [];
  state.messages.forEach((m) => out.push(m.text));
  return out;
};
const ids = (state: LobbyState) => {
  const out: string[] = [];
  state.messages.forEach((m) => out.push(m.id));
  return out;
};
async function close(...list: Room<unknown, LobbyState>[]) {
  for (const room of list) {
    room.reconnection.enabled = false;
    if (room.connection.isOpen) await room.leave().catch(() => {});
    rooms.delete(room);
  }
}
async function startMatch(...players: Room<unknown, LobbyState>[]) {
  for (const p of players) p.send("ready", true);
  await until(() => players.every((p) => p.state.phase === "countdown"));
}
const input = (seq: number, round: number) => ({
  seq,
  round,
  moveX: seq % 120 < 60 ? 1 : -1,
  moveZ: 0,
  jumpPressed: false,
  punchPressed: false,
  grabHeld: false,
  liftHeld: false,
});

test("a 1 s uplink stall's input burst no longer detaches the player (was: 91 > 90 in one window)", { timeout: 20000 }, async () => {
  const a = await create(),
    b = await join(a.roomId, "Bobby");
  let snapshots = 0;
  a.onMessage("snapshot", () => snapshots++);
  let closed = 0;
  a.onLeave((code) => (closed = code));
  a.onDrop((code) => (closed = code));
  await startMatch(a, b);
  await until(() => a.state.phase === "playing", 6000);
  const room = local(a);
  let seq = 0;
  const queued: ReturnType<typeof input>[] = [];
  const start = performance.now();
  while (performance.now() - start < 3500) {
    const t = performance.now() - start;
    const packet = input(++seq, room.game.roundId);
    // Queued as TCP would during a 1 s stall, then delivered with the live stream.
    if (t > 800 && t < 1800) queued.push(packet);
    else {
      for (const q of queued.splice(0)) a.send("input", q);
      a.send("input", packet);
    }
    await pause(1000 / 60);
  }
  const before = snapshots;
  await pause(400);
  assert.equal(closed, 0, "no drop or leave");
  assert.ok(snapshots > before + 4, "snapshots keep arriving after the burst");
  assert.equal(room.state.players.get(a.sessionId)?.connected, true);
  assert.ok(seq > 150, `sent ${seq} inputs`);
  await close(a, b);
});

test("the Colyseus flood guard still detaches a client that floods far past the cap", { timeout: 20000 }, async () => {
  const a = await create(),
    b = await join(a.roomId, "Bobby");
  const room = local(a);
  for (let i = 0; i < MAX_MESSAGES_PER_SECOND + 50; i++) a.send("ready", i % 2 === 0);
  await until(() => room.state.players.get(a.sessionId)?.connected === false, 3000);
  assert.equal(room.state.players.get(b.sessionId)?.connected, true);
  // The detached socket is no longer read by the server, so a consented leave would wait out the grace.
  a.reconnection.enabled = false;
  void a.leave(false).catch(() => {});
  rooms.delete(a);
  await close(b);
});

test("ping echoes the client clock, adds server time, and diagnostics only on request", { timeout: 10000 }, async () => {
  const a = await create();
  const pongs: PongPacket[] = [];
  const notices: string[] = [];
  a.onMessage("pong", (p: PongPacket) => pongs.push(p));
  a.onMessage("notice", (n: string) => notices.push(n));
  a.send("ping", { id: 1, t: 1234.5 });
  await until(() => pongs.length === 1);
  assert.equal(pongs[0].id, 1);
  assert.equal(pongs[0].t, 1234.5);
  assert.ok(Math.abs(pongs[0].s - Date.now()) < 1000);
  assert.equal(pongs[0].d, undefined);
  a.send("ping", { id: 2, t: 1, diag: true }); // inside the 200 ms minimum interval
  await pause(100);
  assert.equal(pongs.length, 1, "too-frequent ping ignored");
  await pause(150);
  a.send("ping", { id: 3, t: 2, diag: true });
  await until(() => pongs.length === 2);
  const d = pongs[1].d!;
  for (const value of Object.values(d)) assert.ok(Number.isFinite(value));
  assert.ok(d.rooms >= 1 && d.heapMb > 0);
  for (const bad of [null, [], { id: -1, t: 0 }, { id: 1.5, t: 0 }, { id: 4, t: "x" }, { id: 4, t: 0, slot: 1 }, { id: 4, t: 0, diag: 1 }]) {
    await pause(210);
    a.send("ping", bad);
  }
  await pause(150);
  assert.equal(pongs.length, 2, "malformed pings get no reply");
  assert.deepEqual(notices, [], "and no notice spam");
  await close(a);
});

test("chat: A→B, B→A, rapid A→B→A across three clients, Ready changes, countdown and a live match", { timeout: 30000 }, async () => {
  const a = await create(),
    b = await join(a.roomId, "Bobby"),
    c = await join(a.roomId, "Carol");
  const room = local(a);
  const peers = { a, b, c };
  // Each peer's view is copied only inside onStateChange, exactly like the browser session.
  const views = new Map<Room<unknown, LobbyState>, { texts: string[]; ids: string[]; at: Map<string, number> }>();
  for (const peer of Object.values(peers)) {
    const view = { texts: [] as string[], ids: [] as string[], at: new Map<string, number>() };
    views.set(peer, view);
    peer.onStateChange((state) => {
      view.texts = texts(state);
      view.ids = ids(state);
      for (const t of view.texts) if (!view.at.has(t)) view.at.set(t, performance.now());
    });
  }
  const sent = new Map<string, number>();
  const say = async (from: Room<unknown, LobbyState>, text: string, gap = 0) => {
    sent.set(text, performance.now());
    from.send("chat", text);
    if (gap) await pause(gap);
  };
  const delivered = (text: string) =>
    [...views.values()].every((v) => v.texts.includes(text));
  await say(a, "a→b");
  await until(() => delivered("a→b"), 1000);
  await say(b, "b→a");
  await until(() => delivered("b→a"), 1000);
  await say(a, "rapid-1", 5);
  await say(b, "rapid-2", 5);
  await say(a, "rapid-3");
  await until(() => delivered("rapid-3") && delivered("rapid-2"), 1000);
  // Ready toggles interleaved with chat.
  b.send("ready", true);
  await say(c, "while-ready");
  b.send("ready", false);
  await until(() => delivered("while-ready"), 1000);
  // Countdown, then a running match: chat still flows through the same state.
  await startMatch(a, b, c);
  await say(c, "in-countdown");
  await until(() => delivered("in-countdown"), 1000);
  await until(() => a.state.phase === "playing", 6000);
  await say(b, "in-match");
  await until(() => delivered("in-match"), 1000);
  const expected = texts(room.state);
  for (const [peer, view] of views) {
    assert.deepEqual(view.texts, expected, `${peer.sessionId} order matches the server`);
    assert.equal(new Set(view.ids).size, view.ids.length, "no duplicates");
  }
  const latencies = [...sent].map(([text, at]) =>
    Math.max(...[...views.values()].map((v) => v.at.get(text)! - at))
  );
  // One 100 ms patch interval plus loopback; nobody else had to act for delivery.
  assert.ok(Math.max(...latencies) < 250, `worst delivery ${Math.max(...latencies).toFixed(0)} ms`);
  const report = room.loop.report();
  assert.ok(report.chatPatchMaxMs <= 150, `receive→patch ${report.chatPatchMaxMs.toFixed(0)} ms`);
  console.log(JSON.stringify({ chatDeliveryMs: latencies.map((l) => Math.round(l)), chatReceiveToPatchAvgMs: Math.round(report.chatPatchAvgMs) }));
  await close(a, b, c);
});

test("five drop/reconnect cycles mid-match: same seat and body, no duplicate players or listeners, chat intact", { timeout: 60000 }, async () => {
  const a = await create(),
    b = await join(a.roomId, "Bobby");
  Object.assign(b.reconnection, { minUptime: 0, minDelay: 100, maxDelay: 300, maxRetries: 10 });
  const room = local(a);
  const bId = b.sessionId;
  // Five chats inside a few seconds would trip the 4-per-5 s chat limit; delivery is under test.
  (room as unknown as { limiters: Map<string, { take: () => boolean }> }).limiters.get(a.sessionId)!.take = () => true;
  await startMatch(a, b);
  await until(() => a.state.phase === "playing", 6000);
  const slot = room.state.players.get(bId)!.slot;
  const mask = room.game.mask;
  let reconnects = 0;
  b.onReconnect(() => reconnects++);
  const handlerCount = () => {
    const noop = () => {};
    const emitter = b.onStateChange(noop) as unknown as { handlers: unknown[] };
    const n = emitter.handlers.length;
    b.onStateChange.remove(noop);
    return n;
  };
  const events = (b as unknown as { onMessageHandlers: { events: Record<string, unknown[]> } }).onMessageHandlers.events;
  const listeners = { state: handlerCount(), snapshot: events.snapshot.length };
  for (let cycle = 0; cycle < 5; cycle++) {
    if (cycle % 2) b.connection.close(4010);
    else (room.clients.find((client) => client.sessionId === bId)!.ref as unknown as { terminate(): void }).terminate();
    a.send("chat", `during-drop-${cycle}`);
    await until(() => reconnects === cycle + 1 && b.connection.isOpen, 8000);
    await until(() => texts(b.state).includes(`during-drop-${cycle}`), 2000);
  }
  assert.equal(room.state.players.size, 2);
  assert.equal(room.clients.length, 2);
  assert.equal(room.state.players.get(bId)?.slot, slot);
  assert.equal(room.state.players.get(bId)?.connected, true);
  assert.equal(room.game.mask, mask, "no extra body enabled");
  assert.equal(handlerCount(), listeners.state);
  assert.equal(events.snapshot.length, listeners.snapshot);
  assert.deepEqual(texts(b.state), texts(room.state));
  assert.equal(new Set(ids(b.state)).size, ids(b.state).length);
  let snapshots = 0;
  b.onMessage("snapshot", () => snapshots++);
  await pause(300);
  assert.ok(snapshots >= 4, "snapshots resume after the last reconnect");
  await close(a, b);
});

test("server loop cost for a live three-player match (measured, not assumed)", { timeout: 30000 }, async () => {
  const a = await create(),
    b = await join(a.roomId, "Bobby"),
    c = await join(a.roomId, "Carol");
  const room = local(a);
  await startMatch(a, b, c);
  await until(() => a.state.phase === "playing", 6000);
  const players = [a, b, c];
  let seq = 0;
  const started = performance.now();
  // Six seconds covers a full 5 s diagnostics window.
  while (performance.now() - started < 6000 && a.state.phase === "playing") {
    seq++;
    for (const p of players) p.send("input", { ...input(seq, room.game.roundId), punchPressed: seq % 45 === 0 });
    await pause(1000 / 60);
  }
  const report = room.loop.report();
  console.log(JSON.stringify({ serverLoop: {
    stepAvgMs: +report.stepAvgMs.toFixed(3), stepMaxMs: +report.stepMaxMs.toFixed(3),
    tickGapMaxMs: +report.tickGapMaxMs.toFixed(1), catchUpSteps: report.catchUpSteps,
    snapshotAvgMs: +report.snapshotAvgMs.toFixed(3), snapshotMaxMs: +report.snapshotMaxMs.toFixed(3),
    stepBudgetMs: +(1000 / NET.physicsHz).toFixed(2),
  } }));
  assert.ok(report.stepAvgMs < 1000 / NET.physicsHz / 4, "well inside the 16.7 ms tick budget");
  await close(a, b, c);
});
