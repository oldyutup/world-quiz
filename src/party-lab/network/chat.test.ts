import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@colyseus/sdk";
import {
  followMessages,
  followScroll,
  initialChatFollow,
  jumpToLatest,
  type FollowMessage,
} from "../chatFollow";
import { LobbySession } from "./session";
import type { LobbySnapshot } from "./types";
import { LINK } from "./diagnostics";

const msg = (id: string, playerId: string): FollowMessage => ({ id, playerId });
const bottom = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
const above = { scrollTop: 450, scrollHeight: 1000, clientHeight: 400 };

test("follow model: a reader at the end sees every new message; own sends always pin", () => {
  let state = initialChatFollow();
  let r = followMessages(state, [msg("1", "b")], "a");
  assert.equal(r.pin, true);
  state = r.state;
  r = followMessages(state, [msg("1", "b")], "a");
  assert.equal(r.pin, false, "re-render of the same list (e.g. Ready patch) does nothing");
  r = followMessages(state, [msg("1", "b"), msg("2", "b")], "a");
  assert.equal(r.pin, true);
  assert.equal(r.state.unread, 0);
});

test("follow model: the reported bug — scrolled up, friend's message stays hidden until an own send; now counted", () => {
  let state = followMessages(initialChatFollow(), [msg("1", "b")], "a").state;
  state = followScroll(state, above, true); // one wheel notch up
  assert.equal(state.following, false);
  let r = followMessages(state, [msg("1", "b"), msg("2", "b")], "a");
  assert.equal(r.pin, false, "the reader chose to scroll up");
  assert.equal(r.state.unread, 1, "…but a '1 yeni mesaj' button is shown");
  r = followMessages(r.state, [msg("1", "b"), msg("2", "b"), msg("3", "c")], "a");
  assert.equal(r.state.unread, 2);
  const own = followMessages(r.state, [msg("1", "b"), msg("2", "b"), msg("3", "c"), msg("4", "a")], "a");
  assert.equal(own.pin, true);
  assert.equal(own.state.unread, 0);
  assert.deepEqual(jumpToLatest(r.state), { ...r.state, following: true, unread: 0 });
  assert.equal(followScroll(r.state, bottom, true).unread, 0, "scrolling back to the end clears it");
});

test("follow model: browser/programmatic scroll events never stop following (the 40-message cap case)", () => {
  let state = followMessages(initialChatFollow(), [msg("1", "b")], "a").state;
  // Scroll anchoring after the top message was removed reported 75 px from the end.
  state = followScroll(state, { scrollTop: 525, scrollHeight: 1000, clientHeight: 400 }, false);
  assert.equal(state.following, true);
  const history = Array.from({ length: 40 }, (_, i) => msg(String(i + 2), "b"));
  const r = followMessages(state, history, "a"); // lastId "1" already shifted out
  assert.equal(r.pin, true);
});

// ─── Real server process + three real LobbySessions ────────────────────────────

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
async function until(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out");
    await pause(5);
  }
}
interface Peer {
  session: LobbySession;
  published: { at: number; snapshot: LobbySnapshot; fingerprint: string }[];
  latest: () => LobbySnapshot;
  texts: () => string[];
}
function peer(): Peer {
  const published: Peer["published"] = [];
  const session = new LobbySession(
    (snapshot) =>
      published.push({
        at: performance.now(),
        snapshot,
        fingerprint: snapshot.messages.map((m) => m.id).join("|"),
      }),
    undefined,
    { createClient: () => new Client(`http://127.0.0.1:${port}`) }
  );
  const latest = () => published[published.length - 1].snapshot;
  return { session, published, latest, texts: () => latest().messages.map((m) => m.text) };
}
const roomOf = (p: Peer) =>
  (p.session as unknown as { room: { connection: { close(code: number): void } } }).room;

test("realtime chat through real sessions: B's published state changes on arrival with no action by B", { timeout: 60000 }, async () => {
  const a = peer(), b = peer(), c = peer();
  try {
    await a.session.connect("create", "Alice", "", "cat");
    await until(() => a.latest().status === "connected");
    const code = a.latest().code;
    await b.session.connect("join", "Bobby", code, "cat");
    await c.session.connect("join", "Carol", code, "cat");
    await until(() => [a, b, c].every((p) => p.latest().players.length === 3));
    const delivery: Record<string, number> = {};
    const say = async (from: Peer, text: string, wait = true) => {
      const sent = performance.now();
      assert.equal(from.session.sendChat(text), true);
      if (!wait) return;
      await until(() => [a, b, c].every((p) => p.texts().includes(text)), 2000);
      delivery[text] = Math.max(...[a, b, c].map((p) => p.published.find((e) => e.snapshot.messages.some((m) => m.text === text))!.at - sent));
    };
    // B does nothing between these steps: every change is pushed by the server.
    await say(a, "A→B");
    await say(b, "B→A");
    await say(a, "rapid-1", false);
    await say(b, "rapid-2", false);
    await say(a, "rapid-3");
    await until(() => [a, b, c].every((p) => p.texts().includes("rapid-2")), 2000);
    b.session.setReady(true);
    await say(c, "during-ready");
    b.session.setReady(false);
    await until(() => b.latest().players.every((p) => !p.ready));
    for (const p of [a, b, c]) p.session.setReady(true);
    await until(() => b.latest().phase === "countdown");
    await say(c, "during-countdown");
    await until(() => b.latest().phase === "playing", 6000);
    await say(b, "during-match");
    // Order, uniqueness and immutability of every published list.
    // Messages from different sockets sent in the same millisecond are ordered by server
    // receipt; every client must show that same order, and each sender's own order holds.
    const expected = a.texts();
    assert.deepEqual([...expected].sort(), ["A→B", "B→A", "during-countdown", "during-match", "during-ready", "rapid-1", "rapid-2", "rapid-3"]);
    assert.ok(expected.indexOf("rapid-1") < expected.indexOf("rapid-3"));
    for (const p of [a, b, c]) {
      assert.deepEqual(p.texts(), expected);
      const ids = p.latest().messages.map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length);
      let previous: LobbySnapshot["messages"] | null = null;
      p.published.forEach((e) => {
        // A list, once published, is never mutated afterwards (React compares by identity).
        assert.equal(e.snapshot.messages.map((m) => m.id).join("|"), e.fingerprint);
        if (previous && e.snapshot.messages.length !== previous.length)
          assert.notEqual(e.snapshot.messages, previous, "changed lists are new arrays");
        previous = e.snapshot.messages;
      });
    }
    const worst = Math.max(...Object.values(delivery));
    console.log(JSON.stringify({ chatDeliveryToAllSessionsMs: Object.fromEntries(Object.entries(delivery).map(([k, v]) => [k, Math.round(v)])) }));
    assert.ok(worst < 300, `worst delivery ${worst.toFixed(0)} ms`);
  } finally {
    for (const p of [a, b, c]) p.session.dispose();
  }
});

test("reconnect keeps chat exact; a silently dead socket is recycled through the same seat", { timeout: 60000 }, async () => {
  const a = peer(), b = peer();
  try {
    await a.session.connect("create", "Alice", "", "cat");
    await until(() => a.latest().status === "connected");
    await b.session.connect("join", "Bobby", a.latest().code, "cat");
    await until(() => a.latest().players.length === 2 && b.latest().status === "connected");
    const selfId = b.latest().selfId;
    assert.equal(a.session.sendChat("before-drop"), true);
    await until(() => b.texts().includes("before-drop"));
    roomOf(b).connection.close(4010);
    await until(() => b.latest().status === "reconnecting", 2000);
    assert.equal(a.session.sendChat("while-b-away"), true);
    await until(() => b.latest().status === "connected" && b.texts().includes("while-b-away"), 8000);
    assert.equal(b.latest().selfId, selfId, "same seat");
    // Health check with a clock 11 s ahead = no server data for longer than LINK.deadMs.
    const reconnectsBefore = b.session.diagnostics.reconnects;
    const future = performance.now() + LINK.deadMs + 1000;
    // Synchronous pair: the first (late) tick only sets the cadence baseline, the second
    // is on time and sees >10 s of silence. No interval tick can run in between.
    b.session.checkHealth(performance.now()); // on-time baseline tick, data is fresh
    assert.equal(b.latest().status, "connected");
    b.session.checkHealth(future);
    assert.equal(b.latest().status, "connected", "a late tick never acts on its own");
    b.session.checkHealth(future + 250);
    await until(() => b.session.diagnostics.reconnects === reconnectsBefore + 1 && b.latest().status === "connected", 8000);
    assert.equal(b.session.diagnostics.deadSocketResets, 1);
    assert.equal(a.session.sendChat("after-recycle"), true);
    await until(() => b.texts().includes("after-recycle"), 2000);
    assert.deepEqual(b.texts(), ["before-drop", "while-b-away", "after-recycle"]);
    assert.equal(b.latest().players.length, 2, "no duplicate player");
    assert.equal(b.session.diagnostics.drops, 2);
    assert.equal(b.session.diagnostics.summary(performance.now()).lastCloseCode, 4010);
  } finally {
    for (const p of [a, b]) p.session.dispose();
  }
});

test("input sent while unacknowledged is coalesced to 10/s and keeps pressed edges", { timeout: 30000 }, async () => {
  const sent: { seq: number; jumpPressed: boolean }[] = [];
  const session = new LobbySession(() => {});
  Object.assign(session as unknown as Record<string, unknown>, {
    room: { connection: { isOpen: true }, send: (_: string, p: { seq: number; jumpPressed: boolean }) => sent.push(p) },
    snapshot: {
      status: "connected",
      phase: "playing",
      round: 1,
      selfId: "me",
      players: [{ id: "me", slot: 0 }],
      game: { round: 1, ack: [-1, -1, -1] },
      messages: [],
    },
  });
  const intent = (jump = false) => ({ x: 1, z: 0, jump, punch: false, grab: false, lift: false });
  for (let i = 0; i < LINK.unackedInputs + 1; i++) assert.ok(session.sendInput(intent()));
  assert.equal(session.sendInput(intent(true)), null, "backlog > 30 and < 100 ms since last send");
  assert.equal(session.sendInput(intent()), null);
  assert.equal(session.diagnostics.inputsCoalesced, 2);
  await pause(LINK.stalledInputIntervalMs + 10);
  const next = session.sendInput(intent())!;
  assert.equal(next.jumpPressed, true, "a jump pressed while coalescing is not lost");
  assert.equal(sent.length, LINK.unackedInputs + 2);
  // Acknowledgement catches up: back to 60/s.
  (session as unknown as { snapshot: { game: { ack: number[] } } }).snapshot.game.ack = [next.seq, -1, -1];
  assert.ok(session.sendInput(intent()));
  assert.ok(session.sendInput(intent()));
});
