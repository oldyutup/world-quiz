import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { RHYTHM as R } from "../../../../shared/party-lab/simulation/rhythm/config";
import { GOOD, MISS, PERFECT, RhythmGame, WRONG, type RhythmPress } from "../../../../shared/party-lab/simulation/rhythm/game";
import { beatTime, composeSong, RHYTHM_STYLES, SONG_BEATS } from "../../../../shared/party-lab/simulation/rhythm/song";
import { rhythmSection, type RhythmWire } from "../../../../shared/party-lab/simulation/rhythm/wire";
import { mulberry32 } from "../../../../shared/party-lab/simulation/colors/layouts";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, modeFits } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import { NET, type GameSnapshot } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import { CHAT_LAYOUT } from "../gameChat";
import { defaultBindings } from "../../input/defaults";
import { NoteKeys, bindRhythmInput, noteBindings, noteLabels } from "./input";
import { LocalRhythm, OnlineRhythmSource, RhythmClient, drawTime, viewLanes } from "./source";
import { arrange, stepBeat } from "./arrangement";
import { audioOffset, hz, RhythmMusic } from "./music";
import { APPROACH_MS, circleX, latestWord, noteX, WORDS } from "./lanes";
import { comboScale, laneOrder, resultOrder } from "./hud";
import { dancePose, dancerX } from "./visual";

const MS = 1000 / R.hz;
/** A game just past its countdown. */
function playing(count = 2, seed = 3) {
  const g = new RhythmGame(count, mulberry32(seed));
  while (g.phase === "countdown") g.step();
  return g;
}
const run = (g: RhythmGame, ms: number, volleys: (lane: number) => RhythmPress[] | undefined = () => undefined) => {
  while (g.elapsedMs < ms - 1e-9 && g.phase === "playing") g.step(g.lanes.map((l, lane) => {
    const p = volleys(lane);
    return p ? { pressed: l.pressed + p.length, presses: p } : undefined;
  }));
};
const wireOf = (g: RhythmGame): RhythmWire => rhythmSection(g, g.lanes.map((_, lane) => lane));

test("Ritim Ustası is a registered 2–3 player mode on protocol 25, with a local arena (bots, music style), a chat spot, a lobby hint and an online view", () => {
  assert.equal(NET.version, 25);
  assert.ok(GAME_MODES.includes("rhythm_master"));
  assert.equal(MODE_NAMES.rhythm_master, "Ritim Ustası");
  assert.deepEqual(MODE_PLAYERS.rhythm_master, { min: 2, max: 3 });
  assert.ok(modeFits("rhythm_master", 2) && modeFits("rhythm_master", 3) && !modeFits("rhythm_master", 4));
  assert.ok(LOCAL_ARENA_IDS.includes("rhythm_master"));
  assert.ok(CHAT_LAYOUT.rhythm_master.wide.bottom > 300, "the chat sits above the lanes block");
  const lobby = readFileSync(new URL("../../PartyLobby.tsx", import.meta.url), "utf8");
  assert.match(lobby, /rhythm_master: "/);
  const arena = readFileSync(new URL("../OnlineArena.tsx", import.meta.url), "utf8");
  assert.match(arena, /mode === "rhythm_master"\) return/);
  const online = readFileSync(new URL("../OnlineRhythmArena.tsx", import.meta.url), "utf8");
  assert.match(online, /menu\.view !== null \|\| menu\.chatOpen/, "the chat cuts the input");
  const local = readFileSync(new URL("../ArenaScene.tsx", import.meta.url), "utf8");
  assert.match(local, /id === "rhythm_master" \? "Ritim Ustası"/);
  assert.match(local, /RHYTHM_BOT_LEVELS\.map/, "a bot level menu");
  assert.match(local, /RHYTHM_STYLES\.map/, "a music style menu");
  assert.match(local, /holdMusic/, "the band stops while the local menu pauses the round");
});

test("keys: W A S D and the arrows are the four notes (labels W A S D); a held key and its repeats press once, again only after a release", () => {
  const map = noteBindings(defaultBindings());
  assert.deepEqual([map.get("KeyW"), map.get("KeyA"), map.get("KeyS"), map.get("KeyD")], [0, 1, 2, 3]);
  assert.deepEqual([map.get("ArrowUp"), map.get("ArrowLeft"), map.get("ArrowDown"), map.get("ArrowRight")], [0, 1, 2, 3]);
  assert.equal(map.get("Space"), undefined);
  assert.deepEqual(noteLabels(defaultBindings()), ["W", "A", "S", "D"]);
  const keys = new NoteKeys(map);
  assert.equal(keys.down("KeyS", false), 2);
  assert.equal(keys.down("KeyS", true), null, "auto-repeat");
  assert.equal(keys.down("KeyS", false), null, "still held (a repeat without the flag)");
  assert.equal(keys.down("ArrowDown", false), 2, "another key of the same note is its own press");
  keys.up("KeyS");
  assert.equal(keys.down("KeyS", false), 2);
  assert.equal(keys.down("KeyQ", false), null);
});

test("the key handler: presses with their own moment through real key events; nothing while input is off (menu or chat open); a release always counts", () => {
  const g = globalThis as Record<string, unknown>,
    saved = { window: g.window, document: g.document, HTMLElement: g.HTMLElement };
  const target = new EventTarget();
  g.window = target;
  g.document = { activeElement: null };
  g.HTMLElement = class {};
  try {
    const key = (type: string, code: string, repeat = false, timeStamp = performance.now()) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { code, repeat, metaKey: false, ctrlKey: false, altKey: false, isComposing: false });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      return target.dispatchEvent(event);
    };
    const keys = new NoteKeys(noteBindings(defaultBindings()));
    let on = true;
    const presses: [number, number][] = [];
    const unbind = bindRhythmInput(keys, () => on, (k, at) => presses.push([k, at]));
    const t0 = performance.now() - 12;
    key("keydown", "KeyW", false, t0);
    key("keydown", "KeyW", true);
    key("keydown", "KeyW");
    assert.equal(presses.length, 1, "held: one press");
    assert.deepEqual(presses[0], [0, t0], "the key's own moment");
    key("keydown", "ArrowRight");
    assert.equal(presses[1][0], 3);
    // The chat (or the menu) is open: keys do nothing; releasing still lets go.
    on = false;
    key("keyup", "KeyW");
    key("keydown", "KeyW");
    key("keydown", "KeyA");
    assert.equal(presses.length, 2, "no press with the chat open");
    on = true;
    key("keydown", "KeyW");
    assert.equal(presses.length, 3, "W was released while the chat was open");
    target.dispatchEvent(new Event("blur"));
    key("keydown", "ArrowRight");
    assert.equal(presses.length, 4, "a blur lets every key go");
    unbind();
    key("keyup", "KeyS");
    key("keydown", "KeyS");
    assert.equal(presses.length, 4, "unbound");
  } finally {
    Object.assign(g, saved);
  }
});

const toVolley = (p: { pressed: number; presses: number[] }) => ({ pressed: p.pressed, presses: Array.from({ length: p.presses.length / 2 }, (_, i) => ({ at: p.presses[2 * i], key: p.presses[2 * i + 1] })) });
const rounded = (list: number[]) => list.map((v) => Math.round(v * 1000) / 1000);

test("client clock and presses: never ahead of the server; a press is stamped on it and judged at once exactly as the server judges it; the latest six presses go out; confirmed by the server's count", () => {
  const g = playing(2, 5),
    c = new RhythmClient();
  const first = g.notes[0],
    second = g.notes[1];
  run(g, first.t - 300);
  // Received 40 ms after it was sent: the clock is 40 ms behind (never ahead).
  const wall = 10_000,
    e = g.elapsedMs;
  c.observe(wireOf(g), 1, wall + 40, 0);
  assert.ok(Math.abs(c.clock(wall + 40)! - e) < 1e-9);
  c.observe(wireOf(g), 1, wall + 25, 0);
  assert.ok(Math.abs(c.clock(wall + 25)! - e) < 1e-9, "the earliest arrival sets the clock");
  assert.deepEqual(c.song!.notes, g.notes, "the same song from the style and seed");
  // Presses at screen moments: on time; 80 ms late with the wrong key; between notes.
  const at = (t: number) => wall + 25 + (t - e);
  const sent: { pressed: number; presses: number[] }[] = [];
  const o1 = c.press(at(first.t + 10), first.key)!;
  assert.deepEqual([o1.note, o1.grade], [0, PERFECT]);
  c.flush((p) => (sent.push(p), false));
  c.flush((p) => (sent.push(p), true));
  c.flush((p) => (sent.push(p), true));
  assert.equal(sent.length, 2, "a refused send is tried again, then nothing new");
  run(g, first.t + 50);
  g.step([toVolley(sent[1])]);
  const o2 = c.press(at(second.t + 80), (second.key + 1) % 4)!,
    o3 = c.press(at(second.t + 150), second.key)!;
  assert.deepEqual([o2.note, o2.grade, o3.note, o3.grade], [1, WRONG, -1, null]);
  c.flush((p) => (sent.push(p), true));
  assert.equal(sent[2].pressed, 3);
  assert.deepEqual(rounded(sent[2].presses), rounded([first.t + 10, first.key, second.t + 80, (second.key + 1) % 4, second.t + 150, second.key]));
  // The server gets them within the tolerance and agrees.
  run(g, second.t + 200);
  g.step([toVolley(sent[2])]);
  assert.deepEqual([g.lanes[0].grades[0], g.lanes[0].grades[1]], [PERFECT, WRONG]);
  assert.equal(g.lanes[0].strays.length, 1);
  assert.equal(c.pending.length, 3);
  c.observe(wireOf(g), 1, wall + 9e9, 0);
  assert.equal(c.pending.length, 0, "the server's count confirms them");
  for (let i = 0; i < 8; i++) c.press(at(second.t + 400 + i * 40), 0);
  c.flush((p) => (sent.push(p), true));
  assert.equal(sent[sent.length - 1].presses.length, 2 * R.recentPresses);
  assert.equal(sent[sent.length - 1].pressed, 11);
});

test("no network penalty: with 60 or 120 ms each way, a press on the note's screen moment is MÜKEMMEL on the server too, judged at its stamp", () => {
  for (const latency of [60, 120]) {
    const g = playing(2, 9),
      c = new RhythmClient(),
      note = g.notes[3];
    // The server's clock reads e at wall 50 000 + e; snapshots arrive `latency` later.
    run(g, note.t - 400);
    c.observe(wireOf(g), 1, 50_000 + g.elapsedMs + latency, 0);
    // The player presses when their screen shows the note on the circle.
    const pressedAt = 50_000 + latency + note.t;
    const o = c.press(pressedAt, note.key)!;
    assert.equal(o.grade, PERFECT);
    assert.ok(Math.abs(o.at - note.t) < 1e-6);
    // The packet reaches the server `latency` after the press: 2 × latency after the note on its clock.
    const arrives = note.t + 2 * latency;
    assert.ok(arrives - note.t > R.windows.perfect, "by arrival it would not have been MÜKEMMEL");
    run(g, arrives);
    g.step([{ pressed: 1, presses: [{ at: o.at, key: note.key }] }]);
    assert.equal(g.lanes[0].grades[3], PERFECT, `${latency} ms each way`);
    assert.ok(Math.abs(g.lanes[0].at[3] - note.t) < 1e-6, "judged at its stamp");
  }
});

test("lanes as drawn: an own hit at once (score, combo), an own miss at once, the others' only when the server says so", () => {
  const g = playing(2, 2);
  const [a, b] = g.notes;
  run(g, b.t + R.windows.good + 30, (lane) => (lane === 1 && g.elapsedMs < a.t && g.elapsedMs + MS >= a.t ? [{ at: a.t, key: a.key }] : undefined));
  const wire = wireOf(g),
    now = g.elapsedMs;
  const known = g.lanes.map(() => new Map());
  known[1].set(0, { grade: PERFECT, at: a.t });
  const pending = [{ n: 1, note: 0, grade: GOOD as typeof GOOD, at: a.t + 70, key: a.key }];
  const lanes = viewLanes(g.song, wire, now, known, [[], []], pending, 0, (lane) => lane === 0);
  assert.equal(lanes[0].results.get(0)?.grade, GOOD, "own press at once");
  assert.equal(lanes[0].results.get(1)?.grade, MISS, "own miss at once");
  assert.equal(lanes[0].score, R.points.good);
  assert.equal(lanes[0].combo, 0);
  assert.equal(lanes[0].maxCombo, 1);
  assert.equal(lanes[1].results.get(1), undefined, "a rival's miss waits for the server");
  assert.equal(lanes[1].score, wire.score[1]);
  assert.equal(drawTime({ ...wire, phase: "results", elapsed: 45_000 }, 46_000), 45_000);
  assert.equal(drawTime({ ...wire, phase: "countdown" }, 500), 0);
});

test("online source: a press goes out at once as a rhythm packet stamped on the clock, the frame shows it at once; another round is not this arena's; a watcher sends nothing", () => {
  const g = playing(2, 8),
    note = g.notes[0];
  run(g, note.t - 30);
  let snapshot = { round: 4, winner: -1, rhythm: wireOf(g) } as unknown as GameSnapshot;
  const sent: MovementInput[] = [];
  const stream = { snapshots: { get latest() { return { snapshot, received: performance.now() - 30 }; } } };
  const source = new OnlineRhythmSource({ stream: stream as never, sendInput: (input) => (sent.push(input), {} as never) }, 4, 1);
  const before = source.frame()!;
  assert.ok(before);
  const wall = performance.now() + (note.t - before.now);
  const outcome = source.press(wall, note.key)!;
  assert.equal(outcome.grade, PERFECT);
  assert.equal(sent.length, 1, "sent at once");
  assert.equal(sent[0].rhythm?.round, 4);
  assert.equal(sent[0].rhythm?.pressed, 1);
  assert.deepEqual(sent[0].rhythm?.presses, [outcome.at, note.key]);
  const frame = source.frame()!;
  assert.equal(frame.mismatch, false);
  assert.equal(frame.lanes[1].results.get(0)?.grade, PERFECT);
  assert.equal(frame.lanes[1].score, R.points.perfect);
  assert.equal(frame.lanes[1].combo, 1);
  assert.equal(sent.length, 1, "once");
  assert.equal(source.press(wall + 5, note.key)?.note, -1, "a second press on the same note is stray");
  snapshot = { ...snapshot, round: 5 } as GameSnapshot;
  assert.equal(source.frame(), null);
  const watcher = new OnlineRhythmSource({ stream: stream as never, sendInput: () => assert.fail("a watcher sent") }, 5, -1);
  watcher.frame();
  assert.equal(watcher.press(performance.now(), 0), undefined);
  // A page that composes another song than the server's (another build) says so and counts no press.
  snapshot = { ...snapshot, rhythm: { ...snapshot.rhythm!, chart: (snapshot.rhythm!.chart + 1) >>> 0 } } as GameSnapshot;
  const stale = new OnlineRhythmSource({ stream: stream as never, sendInput: () => assert.fail("a stale page sent") }, 5, 1);
  assert.equal(stale.frame()?.mismatch, true);
  assert.equal(stale.press(performance.now(), note.key), undefined);
  assert.equal(source.frame(), null, "(another round for the first source)");
});

test("local arena: the player presses through the same rules on the page's clock, bots really play, the round ends with places; paused, the clock stops", async () => {
  const local = new LocalRhythm(3, "hard", "disco", mulberry32(4));
  assert.equal(local.game.style, "disco");
  let frame = local.frame(0, false);
  assert.equal(frame.wire.phase, "countdown");
  assert.ok(frame.now <= -R.countdown * 1000 + 50);
  // Jump the game to just before its first note, as if the countdown were over.
  const g = local.game,
    note = g.notes[0];
  while (g.phase === "countdown") g.step();
  while (g.elapsedMs < note.t - 20) g.step();
  // The page's clock now reads the game's moment.
  (local as unknown as { origin: number }).origin = performance.now() - R.countdown * 1000 - g.elapsedMs;
  const outcome = local.press(performance.now() + 20, note.key)!;
  assert.ok(outcome && outcome.note === 0 && (outcome.grade === PERFECT || outcome.grade === GOOD), JSON.stringify(outcome));
  // Paused: the clock stands still and presses do nothing.
  frame = local.frame(0.016, true);
  const stopped = local.clock(performance.now());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(local.clock(performance.now()), stopped);
  assert.equal(local.press(performance.now(), 0), undefined);
  local.frame(0.016, false);
  // Run the rest: the bots play the song.
  while (g.phase === "playing") (local as unknown as { step(): void }).step();
  frame = local.frame(0, false);
  assert.equal(frame.wire.phase, "results");
  assert.ok(g.lanes[1].perfect > g.notes.length * 0.85 && g.lanes[2].perfect > g.notes.length * 0.85, "Zor bots");
  assert.ok(frame.wire.places.every((p) => p >= 0 && p <= 2));
  assert.ok(frame.winner === 1 || frame.winner === 2 || frame.winner === -1);
});

test("the band sits on the song's beats: drums, bass and chords on the sixteenth grid of the same tempo map, every bar, the last chord where the song ends", () => {
  for (const style of RHYTHM_STYLES) {
    const song = composeSong(style, 3),
      band = arrange(song);
    assert.ok(band.every((e, i) => i === 0 || band[i - 1].t <= e.t), "in time order");
    const grid = new Set<number>();
    const swing = style === "lofi" ? 0.09 : 0;
    for (let bar = 0; bar <= 22; bar++) for (let step = 0; step < 16; step++) grid.add(Math.round(beatTime(stepBeat(bar, step, swing)) * 1000));
    for (const e of band) assert.ok(grid.has(Math.round(e.t * 1000)), `${style} ${e.voice} at ${e.t}`);
    // Kicks on beats only (every bar has its kick on the one); the melody's eighths are never swung.
    const kicks = band.filter((e) => e.voice === "kick");
    for (let bar = 0; bar < 22; bar++) assert.ok(kicks.some((k) => Math.abs(k.t - beatTime(bar * 4)) < 1e-6), `${style}: kick on bar ${bar}`);
    assert.ok(song.notes.every((n) => grid.has(Math.round(n.t * 1000))), "every melody note on the band's grid");
    const end = band.filter((e) => Math.abs(e.t - song.endAt) < 1e-6);
    assert.ok(end.some((e) => e.voice === "bass") && end.some((e) => e.voice === "crash"), `${style}: the last chord`);
    assert.ok(band[band.length - 1].t <= beatTime(SONG_BEATS) + 1e-6);
    assert.ok(band.filter((e) => e.voice === "bass").every((e) => e.pitches.length === 1 && e.pitches[0] < 64));
  }
  assert.equal(hz(69), 440);
  assert.ok(Math.abs(hz(81) - 880) < 1e-9);
});

/** A tiny Web Audio stand-in: enough nodes for the music, recording when sources start. */
function fakeContext() {
  const starts: { kind: string; at: number }[] = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
  const node = (kind: string) => ({
    kind,
    gain: param(),
    frequency: param(),
    detune: param(),
    Q: param(),
    type: "",
    buffer: null,
    loop: false,
    onended: null,
    connect(next: unknown) {
      return next;
    },
    disconnect() {},
    start(at = 0) {
      starts.push({ kind, at });
    },
    stop() {},
    setPeriodicWave() {},
  });
  const context = {
    state: "running",
    currentTime: 99.78,
    sampleRate: 8000,
    outputLatency: 0.02,
    baseLatency: 0.01,
    getOutputTimestamp: () => ({ contextTime: 99.95, performanceTime: 7000 }),
    createGain: () => node("gain"),
    createBiquadFilter: () => node("filter"),
    createOscillator: () => node("osc"),
    createBufferSource: () => node("buffer"),
    createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
    createPeriodicWave: () => ({}),
  };
  return { context, starts };
}

test("music: the band is scheduled on the game clock where the speakers play it (output latency included), a little ahead; paused it stops; a hit's melody note sounds at once; locked audio schedules nothing", () => {
  // getOutputTimestamp: context time 99.95 leaves the speakers at performance time 7000.
  const { context, starts } = fakeContext();
  assert.ok(Math.abs(audioOffset(context, 2000, 7000) - (99.95 - 2)) < 1e-9, "game 2000 ms at wall 7000 is heard with context time 99.95");
  assert.ok(Math.abs(audioOffset({ currentTime: 10, outputLatency: 0.02, baseLatency: 0.01 }, 1000, 0) - (10 - 0.03 - 1)) < 1e-9, "without it: the current time less the latency");
  let bus: { context: unknown; output: unknown } | null = null;
  const audio = { musicBus: () => bus };
  const music = new RhythmMusic(audio as never);
  const song = composeSong("chiptune", 1);
  music.setSong(song);
  music.update(-200, 6800, true);
  assert.equal(starts.length, 0, "locked: nothing");
  bus = { context, output: {} };
  // At game −200 ms (wall 6800): game 0 is heard at wall 7000, i.e. context time 99.95.
  music.update(-200, 6800, true);
  const kicks = starts.filter((s) => s.kind === "osc");
  assert.ok(kicks.length > 0, "the first beat is queued before BAŞLA");
  assert.ok(kicks.some((s) => Math.abs(s.at - 99.95) < 1e-6), JSON.stringify(kicks.slice(0, 3)));
  assert.ok(starts.every((s) => s.at <= context.currentTime + 0.25 + 1e-9), "no more than 250 ms ahead");
  const n = starts.length;
  music.update(-200, 6800, false);
  context.currentTime = 100.2;
  music.update(0, 7000, false);
  assert.equal(starts.length, n, "held: nothing new");
  assert.equal(music.playMelody(song.notes[0], 200), true);
  assert.ok(starts.slice(n).some((s) => Math.abs(s.at - (100.2 + 0.003)) < 1e-9), "the melody note at once");
  music.dispose();
});

test("lanes geometry: a note reaches the circle at its moment, coming from the right over 1.7 s; the latest result's word", () => {
  const w = 900,
    h = 112;
  assert.equal(noteX(5000, 5000, w, h), circleX(h));
  assert.ok(noteX(5000 + APPROACH_MS, 5000, w, h) <= w && noteX(5000 + APPROACH_MS, 5000, w, h) > w - h);
  assert.ok(noteX(4900, 5000, w, h) < circleX(h), "late notes run on past the circle");
  assert.deepEqual(WORDS, ["KAÇTI", "İYİ!", "MÜKEMMEL!", "YANLIŞ"]);
  const view = { results: new Map([[0, { grade: PERFECT, at: 1000 }], [1, { grade: MISS, at: 1300 }]]), strays: [], score: 10, combo: 0, maxCombo: 1 } as const;
  assert.equal(latestWord(view as never, 1350)?.grade, MISS);
  assert.equal(latestWord(view as never, 1200)?.grade, PERFECT);
  assert.equal(latestWord(view as never, 3000), null);
});

test("HUD: this player's lane first, results by places; the combo grows with it; dancers dance harder with a bigger combo and stumble when it breaks", () => {
  assert.deepEqual(laneOrder(3, 1), [1, 0, 2]);
  assert.deepEqual(laneOrder(2, -1), [0, 1]);
  assert.deepEqual(resultOrder({ seats: [0, 1, 2], places: [1, 0, 1] } as never), [1, 0, 2]);
  assert.ok(Number(comboScale(0)) === 1 && Number(comboScale(10)) > 1.3 && Number(comboScale(40)) === 1.7 && Number(comboScale(200)) === 1.7);
  assert.deepEqual([dancerX(0, 3), dancerX(1, 3), dancerX(2, 3)], [-2.3, 0, 2.3]);
  const hand = (pose: ReturnType<typeof dancePose>) => Math.max(pose.parts[4].y, pose.parts[6].y);
  const calm = dancePose(10.5, 0, 0, 1),
    wild = dancePose(10.5, 1, 0, 1);
  assert.ok(hand(wild) > hand(calm) + 0.8, "hands up with a big combo");
  assert.ok(wild.lift > calm.lift);
  const trip = dancePose(10.5, 0.5, 0.5, 1);
  assert.ok(trip.parts[2].y < dancePose(10.5, 0.5, 0, 1).parts[2].y, "the head drops in a stumble");
  assert.ok(Math.abs(trip.tilt) > 0.3);
});
