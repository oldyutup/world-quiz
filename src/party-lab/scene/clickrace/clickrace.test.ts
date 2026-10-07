import assert from "node:assert/strict";
import { test } from "node:test";
import { ClickPresses, bindClickInput, pressBindings } from "./input";
import { ClickRaceClient } from "./online";
import { TRACK, carX, clickInsets, fitClickView, projectClickView, trackBounds, FINISH_X, START_X } from "./layout";
import { averageRate, resultOrder } from "./results";
import { BOT_PACES, ClickBot } from "./bots";
import { LocalClickRace, localClickRace } from "./local";
import { changeBinding } from "../../input/bindings";
import { defaultBindings } from "../../input/defaults";
import { CLICK_RACE as C } from "../../../../shared/party-lab/simulation/clickrace/config";
import { ClickRaceGame } from "../../../../shared/party-lab/simulation/clickrace/game";
import { clickSection, type ClickWire } from "../../../../shared/party-lab/simulation/clickrace/wire";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, modeFits } from "../../../../shared/party-lab/modes";
import { NET } from "../../../../shared/party-lab/network/protocol";

const event = (type: string, properties: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), properties);
/** window/document/HTMLElement stand-ins: enough for the input binder. */
function environment(check: (win: EventTarget, surface: EventTarget & HTMLElement, button: EventTarget) => void) {
  const win = new EventTarget(),
    doc = { activeElement: null as unknown };
  class Element extends EventTarget {
    constructor(private readonly ui = false) {
      super();
    }
    closest(selector: string) {
      return this.ui && selector.includes("button") ? this : null;
    }
  }
  const originals = ["window", "document", "HTMLElement"].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, { window: { value: win, configurable: true }, document: { value: doc, configurable: true }, HTMLElement: { value: Element, configurable: true } });
  try {
    check(win, new Element() as unknown as EventTarget & HTMLElement, new Element(true));
  } finally {
    ["window", "document", "HTMLElement"].forEach((key, i) => (originals[i] ? Object.defineProperty(globalThis, key, originals[i]!) : Reflect.deleteProperty(globalThis, key)));
  }
}

test("Tıklama Yarışı is a registered 2–3 player mode on protocol 16", () => {
  assert.equal(NET.version, 16);
  assert.ok(GAME_MODES.includes("click_race"));
  assert.equal(MODE_NAMES.click_race, "Tıklama Yarışı");
  assert.deepEqual(MODE_PLAYERS.click_race, { min: 2, max: 3 });
  assert.ok(modeFits("click_race", 2) && modeFits("click_race", 3));
});

test("a held key counts once: auto-repeat and presses without a release are ignored", () => {
  const presses = new ClickPresses(pressBindings(defaultBindings()));
  assert.equal(presses.key("KeyF", false), true);
  for (let i = 0; i < 30; i++) assert.equal(presses.key("KeyF", true), false, "auto-repeat");
  assert.equal(presses.key("KeyF", false), false, "a repeat the system did not mark");
  presses.keyUp("KeyF");
  assert.equal(presses.key("KeyF", false), true, "released, pressed again");
  assert.equal(presses.key("KeyJ", false), false, "not a press key");
  assert.equal(presses.mouse(0), true, "left button / trackpad click");
  assert.equal(presses.mouse(2), false, "right button is not bound to Punch by default");
});

test("the player's own Punch key presses the pedal; the left button always does", () => {
  const keyJ = changeBinding(defaultBindings(), "punch", 0, "KeyJ")!;
  assert.ok(keyJ);
  const presses = new ClickPresses(pressBindings({ ...keyJ, punch: ["KeyJ", "MouseRight"] }));
  assert.equal(presses.key("KeyF", false), false, "F after rebinding Punch to J");
  assert.equal(presses.key("KeyJ", false), true);
  assert.equal(presses.mouse(2), true, "Punch's mouse binding");
  assert.equal(presses.mouse(0), true, "left button still counts");
});

test("keyboard, mouse and touch presses each count once; repeats and UI presses do not", () =>
  environment((win, surface, button) => {
    let count = 0,
      enabled = true;
    const presses = new ClickPresses(pressBindings(defaultBindings()));
    const unbind = bindClickInput(surface, presses, () => enabled, () => count++);
    win.dispatchEvent(event("keydown", { code: "KeyF", repeat: false }));
    for (let i = 0; i < 10; i++) win.dispatchEvent(event("keydown", { code: "KeyF", repeat: true }));
    assert.equal(count, 1, "holding F");
    win.dispatchEvent(event("keyup", { code: "KeyF" }));
    win.dispatchEvent(event("keydown", { code: "KeyF", repeat: false }));
    assert.equal(count, 2);
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(count, 3, "mouse / trackpad click");
    const tap = event("pointerdown", { pointerType: "touch" });
    surface.dispatchEvent(tap);
    assert.equal(count, 4, "a tap");
    assert.equal(tap.defaultPrevented, true, "cancelled: no emulated mouse press follows");
    surface.dispatchEvent(event("pointerdown", { pointerType: "mouse", button: 0 }));
    assert.equal(count, 4, "a mouse's pointerdown is the same press as its mousedown");
    const onButton = event("mousedown", { button: 0 });
    Object.defineProperty(onButton, "target", { value: button });
    surface.dispatchEvent(onButton);
    assert.equal(count, 4, "a press on the menu button");
    enabled = false;
    win.dispatchEvent(event("keyup", { code: "KeyF" }));
    win.dispatchEvent(event("keydown", { code: "KeyF", repeat: false }));
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(count, 4, "menu open");
    unbind();
    enabled = true;
    win.dispatchEvent(event("keydown", { code: "KeyF", repeat: false }));
    assert.equal(count, 4, "unbound");
  }));

/** A wire as the server sends it at `elapsed` ms of racing. */
function wireAt(phase: ClickWire["phase"], elapsed: number): ClickWire {
  const g = new ClickRaceGame(2);
  if (phase !== "countdown") while (g.phase === "countdown") g.step();
  g.ticks = Math.round((elapsed * C.hz) / 1000);
  const w = clickSection(g, [0, 1]);
  return { ...w, phase };
}

test("presses are stamped on the client clock from BAŞLA; none before it", () => {
  const client = new ClickRaceClient();
  client.observe(wireAt("countdown", 0), 3, 1000);
  assert.equal(client.press(1100, true), false, "BAŞLA not seen yet");
  // Server at 200 ms of racing, received at 5250 → BAŞLA at or after 5050 on this clock.
  client.observe(wireAt("racing", 200), 3, 5250);
  assert.equal(client.press(5300, false), false, "not racing (finished or watching)");
  assert.equal(client.press(5300, true), true);
  // A faster snapshot shows BAŞLA was earlier: later stamps move up, never back.
  client.observe(wireAt("racing", 400), 3, 5420);
  assert.equal(client.press(5420, true), true);
  const sent: number[][] = [];
  client.flush((stamps) => (sent.push(stamps), true));
  assert.deepEqual(sent, [[250, 400]]);
  assert.equal(client.waiting, 0);
});

test("presses the link refuses wait for the next packet; at most 32 per packet", () => {
  const client = new ClickRaceClient();
  client.observe(wireAt("racing", 0), 1, 0);
  for (let i = 0; i < 70; i++) client.press(i * 10, true);
  client.flush(() => false);
  assert.equal(client.waiting, 70, "nothing lost while refused");
  const sent: number[][] = [];
  client.flush((stamps) => (sent.push(stamps), true));
  assert.deepEqual(sent.map((s) => s.length), [32, 32, 6]);
  assert.deepEqual(sent.flat(), Array.from({ length: 70 }, (_, i) => i * 10), "in order");
  client.press(800, true);
  client.observe(wireAt("countdown", 0), 2, 900);
  assert.equal(client.waiting, 0, "a new round starts clean");
});

test("the fixed camera shows the whole track and every driver for 2 to 6 lanes, wide or tall", () => {
  for (const [width, height] of [[1280, 720], [1920, 1080], [1024, 768], [844, 390], [390, 844], [360, 640]])
    for (let lanes = 2; lanes <= C.maxLanes; lanes++) {
      const insets = clickInsets(width, height),
        view = fitClickView(lanes, width, height, insets),
        b = trackBounds(lanes);
      for (const x of [b.minX, b.maxX])
        for (const y of [0, TRACK.height])
          for (const z of [b.minZ, b.maxZ]) {
            const p = projectClickView(view, width, height, [x, y, z]);
            const where = `${width}×${height}, ${lanes} lanes: (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
            assert.ok(p.x >= insets.left - 0.5 && p.x <= width - insets.right + 0.5, where);
            assert.ok(p.y >= insets.top - 0.5 && p.y <= height - insets.bottom + 0.5, where);
          }
      // Start before finish along the screen's long axis.
      const start = projectClickView(view, width, height, [START_X, 0, 0]),
        finish = projectClickView(view, width, height, [FINISH_X, 0, 0]);
      if (view.portrait) assert.ok(finish.y < start.y, "tall: start at the bottom");
      else assert.ok(finish.x > start.x, "wide: start at the left");
      // A car stays big enough to read.
      assert.ok(TRACK.carLength / view.scale >= 18, `${width}×${height}, ${lanes} lanes: car ${(TRACK.carLength / view.scale).toFixed(1)} px`);
    }
  assert.ok(Math.abs(carX(0) + TRACK.carLength / 2 - START_X) < 1e-9, "nose on the start line");
  assert.ok(Math.abs(carX(1) + TRACK.carLength / 2 - FINISH_X) < 1e-9, "nose on the finish line");
  assert.equal(carX(2), carX(1));
});

test("results: finishing order, average and best presses per second", () => {
  const g = new ClickRaceGame(3);
  while (g.phase === "countdown") g.step();
  for (let t = 1; t <= 600; t++) g.step([t % 6 === 0 ? [(t * 1000) / 60] : [], t % 5 === 0 ? [(t * 1000) / 60] : [], []]);
  const w = clickSection(g, [0, 1, 2]);
  assert.deepEqual(resultOrder(w), [1, 0, 2]);
  assert.equal(averageRate(w, 0), 10);
  assert.equal(averageRate(w, 1), 12);
  assert.ok(w.peak[1] >= 12 && w.peak[1] <= 13);
  assert.equal(averageRate(w, 2), 0);
});

function seededRandom(seed: number) {
  return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
}

test("local bots press at about 6, 9 and 12 a second, unevenly, never past the cap", () => {
  for (const rate of [6, 9, 12]) {
    const bot = new ClickBot(rate, seededRandom(rate));
    const stamps = bot.presses(30_000);
    assert.ok(stamps[0] >= 180 && stamps[0] <= 440, `${rate}/s starts ${stamps[0]} ms after BAŞLA`);
    assert.ok(Math.abs(stamps.length / 30 - rate) <= rate * 0.08, `${rate}/s pressed ${(stamps.length / 30).toFixed(2)}/s`);
    const perSecond = Array.from({ length: 30 }, (_, s) => stamps.filter((t) => t >= s * 1000 && t < (s + 1) * 1000).length);
    assert.ok(Math.max(...perSecond) - Math.min(...perSecond) >= 2, `${rate}/s should drift: ${perSecond.join(",")}`);
    for (let i = 0; i < stamps.length; i++) assert.ok(stamps.filter((t) => t > stamps[i] - 1000 && t <= stamps[i]).length <= C.maxRate);
  }
  assert.deepEqual([...BOT_PACES], [9, 12, 6]);
});

test("Yerel Test Arenası race: the player and three bots on the server's rules", () => {
  const local = localClickRace(4, "cat");
  assert.deepEqual(local.looks.map((l) => l.name), ["Sen", "Orta Bot", "Hızlı Bot", "Yavaş Bot"]);
  assert.equal(new Set(local.looks.map((l) => l.color)).size, 4);
  assert.deepEqual(local.looks.map((l) => l.self), [true, false, false, false]);
  const race = new LocalClickRace(4, seededRandom(5));
  assert.equal(race.press(), false, "before BAŞLA");
  for (let t = 0; t < 3 * 60 && race.game.phase === "countdown"; t++) race.frame(1 / 60, false);
  race.frame(1 / 60, false);
  assert.equal(race.game.phase, "racing");
  for (let i = 0; i < 5; i++) assert.equal(race.press(), true);
  race.frame(1 / 60, false);
  assert.equal(race.game.lanes[0].clicks, 5, "the player's presses count");
  // The menu pauses a local race.
  const ticks = race.game.ticks;
  race.frame(1, true);
  assert.equal(race.game.ticks, ticks);
  let frame = race.frame(0, false);
  for (let t = 0; t < 60 * 60 && frame.wire.phase !== "results"; t++) frame = race.frame(1 / 60, false);
  assert.equal(frame.wire.phase, "results");
  const finish = frame.wire.finish.map((ms) => ms / 1000);
  assert.ok(Math.abs(finish[2] - 12.5) < 1.5 && Math.abs(finish[1] - 16.7) < 1.8 && Math.abs(finish[3] - 25) < 2.5, `bot finishes ${finish}`);
  assert.deepEqual(resultOrder(frame.wire), [2, 1, 3, 0], "fast, average, slow, then the idle player");
  assert.equal(frame.winner, 2);
  for (const players of [2, 3]) assert.equal(localClickRace(players, "gazelle").looks.length, players);
});
