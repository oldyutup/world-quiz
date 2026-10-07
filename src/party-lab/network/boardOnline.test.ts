import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@colyseus/sdk";
import { BOARD_RETRIES, LobbySession } from "./session";
import type { LobbySnapshot } from "./types";
import { parseBoard } from "../../../shared/party-lab/board/wire";

const serverDir = fileURLToPath(new URL("../../../servers/party-lab/", import.meta.url));
let server: ChildProcess | null = null;
let port = 0;
async function freePort() {
  return new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
before(async () => {
  port = await freePort();
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "development", PARTY_LAB_ALLOWED_ORIGINS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    server!.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server!.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => {
  server?.kill();
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out");
    await pause(5);
  }
}
function peer() {
  const published: LobbySnapshot[] = [];
  const session = new LobbySession((snapshot) => published.push(snapshot), undefined, {
    createClient: () => new Client(`http://127.0.0.1:${port}`),
  });
  const latest = () => published[published.length - 1];
  const room = () => (session as unknown as { room: { reconnection: { maxRetries: number }; state: { board: string } } | null }).room;
  return { session, published, latest, room };
}

test("board through real sessions: host picks it and the length, Ready starts the board, turns are guarded, leaving ends it", { timeout: 60000 }, async () => {
  const host = peer(),
    guest = peer();
  await host.session.connect("create", "Kedici", "", "cat");
  await until(() => !!host.latest()?.code);
  await guest.session.connect("join", "Ceylancik", host.latest().code, "gazelle");
  await until(() => host.latest().players.length === 2 && guest.latest().players.length === 2);
  host.session.setMode("board_game");
  await until(() => guest.latest().selection === "board_game");
  assert.equal(guest.latest().boardLength, 35, "Orta is the default");
  host.session.setBoardSettings({ length: 20 });
  await until(() => guest.latest().boardLength === 20);
  assert.equal(guest.latest().board, null);
  assert.equal(host.room()!.reconnection.maxRetries, 10);
  // Nothing to choose or roll in the lobby: nothing is sent.
  host.session.chooseBoardDice("plus");
  host.session.rollBoardDice();
  host.session.setReady(true);
  guest.session.setReady(true);
  await until(() => guest.latest().board?.phase === "intro");
  const board = guest.latest().board!;
  assert.equal(board.length, 20);
  assert.deepEqual(board.pieces.map(([, square]) => square), [0, 0]);
  assert.equal(guest.latest().phase, "waiting", "the board runs between mini games, not as a round");
  assert.deepEqual(parseBoard(guest.room()!.state.board), board);
  // A board player's page keeps trying to reconnect for the board's two-minute grace.
  assert.equal(guest.room()!.reconnection.maxRetries, BOARD_RETRIES);
  assert.ok(BOARD_RETRIES * 2 >= 120);
  // An unchanged board keeps its object: no re-render for an unrelated patch.
  const before = guest.latest().board;
  host.session.sendChat("selam");
  await until(() => guest.latest().messages.length === 1);
  if (guest.latest().board?.phase === before?.phase && guest.latest().board?.left === before?.left) assert.equal(guest.latest().board, before);
  // The mini game starts on its own.
  await until(() => guest.latest().board?.phase === "minigame" && guest.latest().phase !== "waiting", 10000);
  // The guest leaves from the menu: the host wins by forfeit and sees the celebration.
  guest.session.leave();
  await until(() => host.latest().board?.phase === "finished");
  assert.equal(host.latest().board!.reason, "forfeit");
  assert.equal(host.latest().board!.winner, host.latest().players[0].slot);
  await until(() => host.latest().board === null, 12000);
  assert.equal(host.latest().selection, "board_game");
  host.session.leave();
});
