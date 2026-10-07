import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { RaceRoundSimulation } from "../../../shared/party-lab/simulation/raceRound.js";
import { NET } from "../../../shared/party-lab/network/protocol.js";
import { MixedRotation, type GameMode } from "../../../shared/party-lab/modes.js";
import { BOARD, boardSquares, moveSeconds, type BoardSquare } from "../../../shared/party-lab/board/config.js";
import { squareProblems } from "../../../shared/party-lab/board/squares.js";
import { parseBoard, type BoardWire } from "../../../shared/party-lab/board/wire.js";

const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms: Room<unknown, LobbyState>[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timeout");
    await pause(10);
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
const names = ["Host", "Guest", "Third"];
async function peer(code?: string) {
  const c = new Client(endpoint);
  const nickname = names[rooms.filter((r) => r.roomId === code).length] ?? "Late";
  const r = code
    ? await c.joinById<LobbyState>(code, { protocol: NET.version, nickname, intent: "join", code })
    : await c.create<LobbyState>("party_lab", { protocol: NET.version, nickname: "Host", intent: "create" });
  rooms.push(r);
  const notices: string[] = [];
  r.onMessage("notice", (n: string) => notices.push(n));
  r.onMessage("feedback", () => {});
  r.onMessage("snapshot", () => {});
  r.onMessage("propEvent", () => {});
  Object.assign(r.reconnection, { minUptime: 0, minDelay: 70, maxDelay: 100, maxRetries: 10 });
  return { r, c, notices };
}
type Peer = Awaited<ReturnType<typeof peer>>;
/** Mini games in a fixed order for the test (kart race finishes on demand). */
class Fixed extends MixedRotation {
  constructor(private readonly modes: GameMode[]) {
    super(() => 0);
  }
  override get next() {
    return this.modes[0];
  }
  override played() {
    if (this.modes.length > 1) this.modes.shift();
  }
  override setPlayers() {}
}
const view = (p: Peer) => parseBoard((p.r.state as unknown as { board: string }).board);
const slotOf = (room: PartyRoom, p: Peer) => room.state.players.get(p.r.sessionId)!.slot;

/** These flows pin a board without special squares (boardSquares.test.ts covers the effects); `random` keeps the room's own layout. */
async function boardRoom(count: number, length = 20, random = false) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[1].r.send("mode", "board_game");
  await until(() => peers[1].notices.includes("MODE_HOST_ONLY"));
  peers[0].r.send("mode", "board_game");
  await until(() => room.selection === "board_game");
  peers[1].r.send("boardSettings", { length });
  peers[0].r.send("boardSettings", { length: 21 });
  peers[0].r.send("boardSettings", { length });
  await until(() => room.state.boardLength === length);
  room.boardRotation = new Fixed(["kart_race"]);
  room.boardLayout = random ? null : boardSquares;
  for (const p of peers) p.r.send("ready", true);
  await until(() => !!room.board);
  return { peers, room };
}
/** Finish the running kart race with finish times in `order` (slots, winner first). */
async function finishRace(room: PartyRoom, order: number[]) {
  await until(() => room.game instanceof RaceRoundSimulation && room.game.phase === "playing");
  const sim = room.game as RaceRoundSimulation,
    g = sim.game;
  g.firstFinish = g.time;
  order.forEach((slot, place) => {
    const p = g.progress[sim.seats.indexOf(slot as 0)];
    p.started = true;
    p.laps = 3;
    p.finish = g.time + place;
  });
  await until(() => room.board!.wire().mini === "results");
}
/** Every remaining turn of the round, by the players themselves. */
async function playTurns(room: PartyRoom, peers: Peer[]) {
  const round = room.board!.round;
  while (room.board && room.board.round === round && room.board.phase !== "finished") {
    const board = room.board,
      current = board.current;
    const p = peers.find((q) => room.state.players.get(q.r.sessionId)?.slot === current);
    if (board.phase === "choose") p!.r.send("boardChoice", "plus");
    else if (board.phase === "roll") p!.r.send("boardRoll");
    await pause(30);
  }
}
async function close(peers: Peer[]) {
  for (const p of peers) {
    p.r.reconnection.enabled = false;
    if (p.r.connection.isOpen) await p.r.leave();
  }
}

for (const count of [2, 3])
  test(`board ${count}P: lobby → mini game → winner's choice → rolls in order → treasure → lobby → rematch`, { timeout: 90000 }, async () => {
    const { peers, room } = await boardRoom(count);
    const slots = peers.map((p) => slotOf(room, p));
    assert.ok([...room.state.players.values()].every((p) => !p.ready), "Ready is cleared for the match");
    await until(() => peers.every((p) => view(p)?.phase === "intro"));
    const first: BoardWire = view(peers[1])!;
    assert.equal(first.length, 20);
    assert.deepEqual(first.pieces, slots.map((s) => [s, 0]).sort((a, b) => a[0] - b[0]));
    assert.equal(room.state.mode, "kart_race");
    // Lobby messages are inert during the match.
    peers[0].r.send("mode", "crate_rain");
    peers[1].r.send("ready", true);
    await pause(100);
    assert.equal(room.selection, "board_game");
    assert.ok([...room.state.players.values()].every((p) => !p.ready));
    // The mini game starts by itself for every board player.
    const winner = slots[count - 1],
      finish = [winner, ...slots.filter((s) => s !== winner)];
    await finishRace(room, finish);
    assert.equal(room.board!.first, winner);
    assert.ok([...room.state.players.values()].every((p) => p.participating));
    await until(() => room.board!.phase === "choose");
    assert.equal(room.game.phase, "waiting", "results cut at 5 s");
    const v = view(peers[0])!;
    await until(() => view(peers[0])!.phase === "choose");
    assert.deepEqual(view(peers[0])!.order, finish, "winner first, then the race order");
    assert.equal(view(peers[0])!.current, winner);
    assert.ok(v);
    // Only the current player acts: another player's choice and roll are ignored.
    const other = peers.find((p) => slotOf(room, p) !== winner)!,
      mover = peers.find((p) => slotOf(room, p) === winner)!;
    other.r.send("boardChoice", "two");
    other.r.send("boardRoll");
    await pause(150);
    assert.equal(room.board!.phase, "choose");
    mover.r.send("boardChoice", "plus");
    await until(() => room.board!.phase === "roll");
    mover.r.send("boardRoll");
    await until(() => room.board!.phase === "move");
    const roll = room.board!.roll!;
    assert.equal(roll.kind, "plus");
    assert.equal(roll.value, roll.dice[0] + 1);
    assert.equal(roll.auto, false);
    await until(() => view(peers[1])?.roll?.seq === roll.seq);
    await playTurns(room, peers);
    await until(() => room.board!.phase === "intro");
    assert.equal(room.board!.round, 2);
    assert.ok(room.board!.pieces.size === count && [...room.board!.pieces.values()].every((s) => s > 0 && s <= 7));
    // Round 2: the last player reaches the treasure, passing it is enough.
    const lead = slots[0];
    room.board!.pieces.set(lead, 19);
    await finishRace(room, [lead, ...slots.filter((s) => s !== lead)]);
    await until(() => room.board!.phase === "choose");
    await playTurns(room, peers);
    assert.equal(room.board!.phase, "finished");
    assert.equal(room.board!.winner, lead);
    assert.equal(room.board!.reason, "treasure");
    assert.equal(room.board!.square(lead), 20);
    await until(() => view(peers[count - 1])?.phase === "finished");
    // Celebration, then the lobby with the same selection: Ready again is the rematch.
    await until(() => !room.board, (BOARD.finishSeconds + 2) * 1000);
    await until(() => peers.every((p) => (p.r.state as unknown as { board: string }).board === ""));
    assert.equal(room.state.phase, "waiting");
    assert.equal(room.selection, "board_game");
    room.boardRotation = new Fixed(["kart_race"]);
    for (const p of peers) p.r.send("ready", true);
    await until(() => !!room.board);
    assert.ok([...room.board!.pieces.values()].every((s) => s === 0));
    await close(peers);
  });

test("board reconnect: a dropped player keeps the square past 15 s, is played for, and returns", { timeout: 90000 }, async () => {
  const { peers, room } = await boardRoom(2);
  const [a, b] = peers,
    slotB = slotOf(room, b),
    slotA = slotOf(room, a);
  await finishRace(room, [slotB, slotA]);
  await until(() => room.board!.phase === "choose");
  // B won and drops right at their choice: away → two dice, rolled for them.
  const token = b.r.reconnectionToken,
    id = b.r.sessionId;
  b.r.reconnection.enabled = false;
  b.r.connection.close(4010);
  await until(() => !room.state.players.get(id)!.connected);
  await until(() => room.board!.phase === "move", 3000);
  assert.equal(room.board!.roll!.slot, slotB);
  assert.equal(room.board!.roll!.kind, "two");
  assert.equal(room.board!.roll!.auto, true);
  const square = room.board!.square(slotB);
  assert.ok(square >= 1 && square <= 6);
  // A plays their own turn.
  await until(() => room.board!.phase === "roll");
  a.r.send("boardRoll");
  await until(() => room.board!.phase === "intro");
  // Past the usual 15 s grace the seat and the square are still there.
  await pause((15 + 1.5) * 1000);
  assert.ok(room.state.players.has(id), "board seat grace is longer than 15 s");
  assert.equal(room.board!.square(slotB), square);
  assert.ok(room.board!.has(slotB));
  // B comes back on the same seat and plays on from that square.
  const back = await b.c.reconnect<LobbyState>(token);
  rooms.push(back);
  back.onMessage("notice", () => {});
  back.onMessage("feedback", () => {});
  back.onMessage("snapshot", () => {});
  assert.equal(back.sessionId, id);
  await until(() => room.state.players.get(id)!.connected);
  await until(() => parseBoard((back.state as unknown as { board: string }).board)?.pieces.some(([s, sq]) => s === slotB && sq === square) === true);
  assert.equal(room.board!.square(slotB), square);
  await finishRace(room, [slotA, slotB]);
  await until(() => room.board!.phase === "choose");
  a.r.send("boardChoice", "two");
  a.r.send("boardRoll");
  await until(() => room.board!.current === slotB && room.board!.phase === "roll");
  back.send("boardRoll");
  await until(() => room.board!.phase === "move" && room.board!.roll!.slot === slotB);
  assert.equal(room.board!.roll!.auto, false);
  assert.equal(room.board!.roll!.from, square);
  back.reconnection.enabled = false;
  await back.leave();
  await close([a]);
});

test("board leave: Esc-menu leave takes the player off the board; the last one wins; latecomers watch, then join the rematch", { timeout: 90000 }, async () => {
  const { peers, room } = await boardRoom(2);
  const [a, b] = peers,
    slotA = slotOf(room, a);
  // A third player joins mid-match: watches, cannot ready into it.
  const late = await peer(a.r.roomId);
  await until(() => room.state.players.size === 3);
  late.r.send("ready", true);
  await until(() => !!view(late) && view(late)!.pieces.length === 2);
  assert.equal(room.board!.pieces.size, 2);
  assert.equal(room.state.players.get(late.r.sessionId)!.ready, false);
  await until(() => room.game.phase === "playing");
  assert.equal(room.state.players.get(late.r.sessionId)!.participating, false);
  // B leaves from the Esc menu (a consented leave) mid mini game: A wins at once.
  b.r.reconnection.enabled = false;
  await b.r.leave();
  await until(() => room.board?.phase === "finished");
  assert.equal(room.board!.winner, slotA);
  assert.equal(room.board!.reason, "forfeit");
  assert.equal(room.game.phase, "waiting");
  await until(() => view(late)?.winner === slotA);
  await until(() => !room.board, (BOARD.finishSeconds + 2) * 1000);
  // Rematch with the latecomer; a single mode works as before afterwards.
  room.boardRotation = new Fixed(["kart_race"]);
  a.r.send("ready", true);
  late.r.send("ready", true);
  await until(() => !!room.board);
  assert.equal(room.board!.pieces.size, 2);
  assert.ok(room.board!.has(slotOf(room, late)));
  late.r.reconnection.enabled = false;
  await late.r.leave();
  await until(() => !room.board || room.board.phase === "finished");
  await until(() => !room.board, (BOARD.finishSeconds + 2) * 1000);
  a.r.send("mode", "crate_rain");
  await until(() => room.selection === "crate_rain");
  const again = await peer(a.r.roomId);
  a.r.send("ready", true);
  again.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  assert.equal(room.board, null);
  assert.equal(room.game.mode, "crate_rain");
  await close([a, again]);
});

test("special squares: a fresh layout per match, the same for every page and after a reconnect, new on the rematch", { timeout: 90000 }, async () => {
  const { peers, room } = await boardRoom(2, 35, true);
  const [a, b] = peers;
  const specials = (squares: readonly BoardSquare[]) => squares.filter((s) => s.type !== "normal").map((s) => [s.index, s.type, s.target]);
  const first = specials(room.board!.squares);
  assert.deepEqual(squareProblems(room.board!.squares, 35), []);
  assert.ok(first.length >= 7 && first.length <= 8);
  await until(() => peers.every((p) => view(p)?.squares.length === first.length));
  for (const p of peers) assert.deepEqual(view(p)!.squares, first);
  // B drops and comes back: the reconnected page has the same layout from its first state.
  const token = b.r.reconnectionToken;
  b.r.reconnection.enabled = false;
  b.r.connection.close(4010);
  await until(() => !room.state.players.get(b.r.sessionId)!.connected);
  const back = await b.c.reconnect<LobbyState>(token);
  rooms.push(back);
  back.onMessage("notice", () => {});
  back.onMessage("feedback", () => {});
  back.onMessage("snapshot", () => {});
  await until(() => !!parseBoard((back.state as unknown as { board: string }).board));
  assert.deepEqual(parseBoard((back.state as unknown as { board: string }).board)!.squares, first);
  assert.deepEqual(specials(room.board!.squares), first, "the server's layout is untouched");
  // A takes the treasure; the rematch draws a new layout.
  const slotA = slotOf(room, a), slotB = room.state.players.get(back.sessionId)!.slot;
  room.board!.pieces.set(slotA, 34);
  await finishRace(room, [slotA, slotB]);
  await until(() => room.board!.phase === "choose");
  a.r.send("boardChoice", "two");
  await until(() => room.board!.phase === "roll");
  a.r.send("boardRoll");
  await until(() => room.board!.phase === "finished");
  await until(() => !room.board, (BOARD.finishSeconds + 2) * 1000);
  room.boardRotation = new Fixed(["kart_race"]);
  a.r.send("ready", true);
  back.send("ready", true);
  await until(() => !!room.board);
  const second = specials(room.board!.squares);
  assert.deepEqual(squareProblems(room.board!.squares, 35), []);
  assert.notDeepEqual(second, first, "a new layout for the rematch");
  await until(() => [a.r, back].every((r) => JSON.stringify(parseBoard((r.state as unknown as { board: string }).board)?.squares) === JSON.stringify(second)));
  back.reconnection.enabled = false;
  await back.leave();
  await close([a]);
});

test("board timing: a move waits for the dice and every hop before the next turn", () => {
  assert.equal(moveSeconds(0), BOARD.diceSeconds + BOARD.settleSeconds);
  assert.equal(moveSeconds(7), 1.5 + 7 * 0.25 + 0.6);
  assert.equal(BOARD.reconnectSeconds, 120);
  assert.equal(BOARD.miniResultsSeconds, 5);
});
