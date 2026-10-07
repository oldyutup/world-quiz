/**
 * LOCAL BOARD E2E SERVER: a test tool, never deployed.
 *
 * Runs the real Party Lab server plus HTTP hooks on 127.0.0.1: one ends the running mini
 * game with a chosen winner, so a headed browser can play a whole Tahta Oyunu without bots
 * for every mode (kart race is finished through its own rules, the real results path; any
 * other mode reports its result to the board directly); one queues the next die faces, so
 * a run can land on each kind of special square.
 *
 * It lives outside src/: the production build (tsconfig.build.json) compiles src/ and
 * shared/party-lab only, Railway starts dist/servers/party-lab/src/index.js, and nothing
 * there imports this file (tests/boardHarness.test.ts checks all three).
 *
 *   PARTY_LAB_ALLOWED_ORIGINS=http://127.0.0.1:5214 npx tsx scripts/board-e2e-server.ts
 */
import { createServer } from "node:http";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import { RaceRoundSimulation } from "../../../shared/party-lab/simulation/raceRound.js";
import type { BoardSession } from "../../../shared/party-lab/board/session.js";

if (process.env.NODE_ENV === "production") throw new Error("board-e2e-server is a local test tool");
const port = Number(process.env.PORT ?? 2567);
const hookPort = Number(process.env.BOARD_E2E_HOOK_PORT ?? 2599);
const { server } = createPartyServer();
await server.listen(port, "127.0.0.1");

/** Queued die faces per board match; the match's own (crypto) die once the queue is empty. */
const forced = new WeakMap<BoardSession, number[]>();
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const hook = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const room = matchMaker.getLocalRoomById(url.searchParams.get("room") ?? "") as PartyRoom | undefined;
  if (!room) return json(res, 404, { error: "NO_ROOM" });
  if (url.pathname === "/board-e2e/state")
    return json(res, 200, {
      selection: room.selection,
      phase: room.game.phase,
      mode: room.game.mode,
      board: room.board?.wire() ?? null,
      players: [...room.state.players.values()].map((p) => ({ id: p.id, nickname: p.nickname, slot: p.slot, connected: p.connected, costumeId: p.costumeId })),
    });
  if (url.pathname === "/board-e2e/finish-mini") {
    const winner = Number(url.searchParams.get("winner") ?? -1);
    const board = room.board;
    if (!board || board.phase !== "minigame" || board.wire().mini !== "playing") return json(res, 409, { error: "NO_MINI_GAME" });
    if (room.game instanceof RaceRoundSimulation && room.game.phase === "playing" && winner >= 0) {
      const sim = room.game,
        g = sim.game;
      g.firstFinish = g.time;
      [winner, ...sim.seats.filter((s) => s !== winner)].forEach((slot, place) => {
        const p = g.progress[sim.seats.indexOf(slot as 0)];
        p.started = true;
        p.laps = 3;
        p.finish = g.time + place;
      });
      return json(res, 200, { ok: true, path: "race" });
    }
    board.miniResult(winner, null);
    return json(res, 200, { ok: true, path: "board" });
  }
  if (url.pathname === "/board-e2e/dice") {
    const board = room.board;
    if (!board) return json(res, 409, { error: "NO_BOARD" });
    const values = (url.searchParams.get("values") ?? "").split(",").map(Number).filter((v) => Number.isInteger(v) && v >= 1 && v <= 6);
    let queue = forced.get(board);
    if (!queue) {
      // The session's die is private; this local tool wraps it.
      const seat = board as unknown as { die: () => number };
      const own = seat.die;
      const q: number[] = [];
      seat.die = () => q.shift() ?? own();
      forced.set(board, (queue = q));
    }
    queue.push(...values);
    return json(res, 200, { ok: true, queued: queue.length });
  }
  json(res, 404, { error: "NOT_FOUND" });
});
hook.listen(hookPort, "127.0.0.1", () => {
  console.log(`Party Lab board E2E server listening at ws://127.0.0.1:${port} (hook http://127.0.0.1:${hookPort})`);
});
const stop = async () => {
  hook.close();
  await server.gracefullyShutdown(false);
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
