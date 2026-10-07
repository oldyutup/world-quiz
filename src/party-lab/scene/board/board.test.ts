import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import { BOARD, BOARD_LENGTHS, EFFECT, effectSeconds, moveSeconds, SPECIAL_TYPES } from "../../../../shared/party-lab/board/config";
import { boardBounds, boardPath } from "../../../../shared/party-lab/board/layout";
import type { BoardEffect, BoardRoll, BoardWire } from "../../../../shared/party-lab/board/wire";
import { MODE_NAMES, MODE_SELECTIONS } from "../../../../shared/party-lab/modes";
import { NET } from "../../../../shared/party-lab/network/protocol";
import { boardShot, connectorPoint, effectStage, pawnPoses, rollSeconds, rollStage, shownSquare, squaresLeft, HOP_HEIGHT, LADDER_ARCH, SLIDE_TOP } from "./boardMotion";
import { BOARD_PITCH, BoardCameraRig, cameraOffset, overviewFit } from "./boardCamera";
import { boardBanner, effectText, rollText } from "./boardText";
import { LEGEND_ORDER, SQUARE_STYLE } from "./squareStyle";
import { FACE_VALUES, faceUp } from "./boardVisual";
import { afterRoundText } from "../arenaMenu";

const base = (patch: Partial<BoardWire> = {}): BoardWire => ({
  phase: "move",
  length: 20,
  round: 2,
  pieces: [[0, 7], [1, 3], [2, 3]],
  order: [0, 1, 2],
  current: 0,
  first: 0,
  choice: "two",
  mode: "crate_rain",
  lastMode: "kart_race",
  mini: null,
  roll: { seq: 4, slot: 0, kind: "two", dice: [4, 2], value: 4, bonus: false, from: 3, to: 7, auto: false },
  squares: [[4, "ladder", 8], [7, "forward", 10], [16, "slide", 12], [10, "swap", -1]],
  bonus: [],
  effect: null,
  left: 0,
  winner: -1,
  reason: null,
  ...patch,
});

test("Tahta Oyunu is a lobby selection with its own name, protocol 17", () => {
  assert.equal(NET.version, 17);
  assert.ok(MODE_SELECTIONS.includes("board_game"));
  assert.equal(MODE_NAMES.board_game, "Tahta Oyunu");
  assert.equal(afterRoundText(true), "Tahtaya dönülüyor.");
  assert.equal(afterRoundText(false), "Yeni tur için lobiye dönülüyor.");
});

test("roll timing: 1.5 s dice, 0.25 s per hop, done exactly when the server moves on", () => {
  const roll = base().roll!;
  assert.equal(rollStage(roll, 0).stage, "dice");
  assert.equal(rollStage(roll, 1.49).stage, "dice");
  assert.deepEqual(rollStage(roll, 1.5), { stage: "hop", hop: 0, u: 0 });
  const mid = rollStage(roll, 1.5 + 0.25 * 2.5);
  assert.equal(mid.stage, "hop");
  assert.equal(mid.hop, 2);
  assert.ok(Math.abs(mid.u - 0.5) < 1e-9);
  assert.equal(rollStage(roll, 1.5 + 4 * 0.25).stage, "done");
  assert.equal(rollSeconds(roll), 1.5 + 4 * 0.25);
  // The server holds the move a little longer than the animation.
  assert.ok(moveSeconds(4) - rollSeconds(roll) >= BOARD.settleSeconds - 1e-9);
});

test("pawns: the mover waits on its square, hops square by square, then lands; crowds stand apart", () => {
  const board = base(),
    path = boardPath(20),
    roll = board.roll!;
  // Dice: the mover still stands on `from` (with the two others there: a crowd of three).
  const dice = pawnPoses(board, path, roll, 0.5);
  assert.equal(shownSquare(board, 0, roll, 0.5), 3);
  const crowd = [0, 1, 2].map((s) => dice.get(s)!);
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) assert.ok(Math.hypot(crowd[a].x - crowd[b].x, crowd[a].z - crowd[b].z) > 0.5);
  // Mid hop 2 (square 5 → 6): above the path, between them.
  const hop = pawnPoses(board, path, roll, 1.5 + 0.25 * 2.5).get(0)!;
  assert.ok(hop.hopping);
  assert.ok(Math.abs(hop.y - HOP_HEIGHT) < 1e-9);
  assert.ok(Math.abs(hop.x - (path[5].x + path[6].x) / 2) < 1e-9);
  // While it is in the air, the two left behind spread to a pair.
  const pair = pawnPoses(board, path, roll, 1.6);
  assert.ok(Math.hypot(pair.get(1)!.x - pair.get(2)!.x, pair.get(1)!.z - pair.get(2)!.z) > 0.5);
  // Landed: alone on square 7, in its centre.
  const done = pawnPoses(board, path, roll, 10).get(0)!;
  assert.equal(done.hopping, false);
  assert.ok(Math.hypot(done.x - path[7].x, done.z - path[7].z) < 1e-9);
  // A roll from before the page opened (elapsed ∞) is shown finished.
  assert.equal(shownSquare(board, 0, roll, Infinity), 7);
  assert.equal(squaresLeft(board, 0), 13);
  assert.equal(squaresLeft(base({ pieces: [[0, 20]] }), 0), 0);
  // Six on one square: all apart.
  const six = base({ pieces: [0, 1, 2, 3, 4, 5].map((s) => [s, 9]) as [number, number][], roll: null });
  const poses = [...pawnPoses(six, path, null, 0).values()];
  assert.equal(poses.length, 6);
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) assert.ok(Math.hypot(poses[a].x - poses[b].x, poses[a].z - poses[b].z) >= 0.38);
});

test("camera: whole board between rounds, the player on turn, follow the hop, the winner", () => {
  assert.deepEqual(boardShot(base({ phase: "intro", current: -1 }), null, 0), { kind: "overview" });
  assert.deepEqual(boardShot(base({ phase: "roll", current: 1 }), base().roll, Infinity), { kind: "focus", slot: 1 });
  assert.deepEqual(boardShot(base(), base().roll, 1.0), { kind: "follow", slot: 0 });
  assert.deepEqual(boardShot(base({ phase: "finished", winner: 2 }), null, 0), { kind: "winner", slot: 2 });
  // The overview frames every board length, farther for longer boards and narrow screens.
  const distances = BOARD_LENGTHS.map((length) => overviewFit(boardBounds(boardPath(length)), 16 / 9).distance);
  assert.ok(distances[0] < distances[1] && distances[1] < distances[2], distances.join());
  const tall = overviewFit(boardBounds(boardPath(35)), 9 / 16).distance;
  assert.ok(tall > distances[1]);
  // 45–55° down.
  assert.ok(BOARD_PITCH >= (45 * Math.PI) / 180 && BOARD_PITCH <= (55 * Math.PI) / 180);
  const offset = cameraOffset(10);
  assert.ok(Math.abs(Math.atan2(offset.y, offset.z) - BOARD_PITCH) < 1e-9);
  // Eases toward the shot instead of jumping.
  const rig = new BoardCameraRig(),
    camera = { position: new Vector3(), lookAt() {} } as unknown as import("three").PerspectiveCamera;
  rig.update(camera, new Vector3(0, 0, 0), 20, 1 / 60);
  rig.update(camera, new Vector3(10, 0, 0), 10, 1 / 60);
  assert.ok(rig.target.x > 0 && rig.target.x < 1);
  assert.ok(rig.distance < 20 && rig.distance > 19);
});

test("dice faces: opposite faces add to 7 and the rolled value ends on top", () => {
  assert.deepEqual([...FACE_VALUES].sort(), [1, 2, 3, 4, 5, 6]);
  for (let i = 0; i < 6; i += 2) assert.equal(FACE_VALUES[i] + FACE_VALUES[i + 1], 7);
  const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let value = 1; value <= 6; value++) {
    const n = normals[FACE_VALUES.indexOf(value as 1)];
    const up = new Vector3(n[0], n[1], n[2]).applyQuaternion(faceUp(value));
    assert.ok(up.distanceTo(new Vector3(0, 1, 0)) < 1e-6, `value ${value}`);
  }
});

test("HUD lines: the winner chooses, the dice result waits for the dice, the celebration", () => {
  const name = (slot: number) => ["Kedi", "Ceylan", "Hamsi"][slot];
  assert.deepEqual(boardBanner(base({ phase: "choose", current: 1, first: 1 }), name, 1, true).title, "Mini oyunu kazandın!");
  assert.equal(boardBanner(base({ phase: "choose", current: 1, first: 1 }), name, 0, true).title, "Ceylan mini oyunu kazandı");
  assert.equal(boardBanner(base({ phase: "roll", current: 2 }), name, 2, true).title, "Sıra sende!");
  assert.equal(boardBanner(base(), name, 1, false).title, "Kedi zar atıyor…");
  const shown = boardBanner(base(), name, 1, true);
  assert.equal(shown.title, "Kedi: 4 kare");
  assert.equal(shown.detail, "4 ve 2 → 4 · 7. kare");
  const roll: BoardRoll = { seq: 1, slot: 2, kind: "plus", dice: [6], value: 7, bonus: false, from: 15, to: 20, auto: true };
  assert.equal(rollText(roll), "6 + 1 → 7");
  assert.equal(boardBanner(base({ roll }), name, 0, true).detail, "6 + 1 → 7 · otomatik · Hazineye ulaştı!");
  assert.equal(boardBanner(base({ phase: "finished", winner: 2, reason: "treasure" }), name, 2, true).title, "Hazineyi buldun!");
  assert.equal(boardBanner(base({ phase: "finished", winner: 2, reason: "forfeit" }), name, 0, true).detail, "Rakipler ayrıldı");
  assert.equal(boardBanner(base({ phase: "intro", round: 1, mode: "kart_race" }), name, 0, true).title, "Araba Yarışı");
});

/** Kedi (slot 0) landed on 7 and the effect moved it to `to`. */
const effectBoard = (effect: Partial<BoardEffect>, pieces: [number, number][] = [[0, 10], [1, 3], [2, 15]]) =>
  base({ phase: "effect", pieces, effect: { seq: 2, slot: 0, type: "forward", from: 7, to: 10, other: -1, gained: false, ...effect } });

test("effects: lead on the square, then hops / climb / slide / swap arcs, done exactly when the server moves on", () => {
  const path = boardPath(20);
  const forward = effectBoard({});
  const fx = (board: BoardWire, elapsed: number) => ({ effect: board.effect!, elapsed });
  // Lead: still on the İleri square although the server already moved the piece.
  assert.equal(effectStage(forward.effect!, 0.3).stage, "lead");
  assert.equal(shownSquare(forward, 0, forward.roll, Infinity, fx(forward, 0.3)), 7);
  // Travel: three hops, mid second hop above squares 8 → 9.
  const mid = pawnPoses(forward, path, forward.roll, Infinity, fx(forward, EFFECT.leadSeconds + 1.5 * EFFECT.hopSeconds)).get(0)!;
  assert.ok(mid.hopping && Math.abs(mid.y - HOP_HEIGHT) < 1e-9 && Math.abs(mid.x - (path[8].x + path[9].x) / 2) < 1e-9);
  // Done: on its new square; the server holds the effect a settle longer.
  const end = EFFECT.leadSeconds + 3 * EFFECT.hopSeconds;
  assert.equal(effectStage(forward.effect!, end).stage, "done");
  assert.equal(shownSquare(forward, 0, forward.roll, Infinity, fx(forward, end)), 10);
  assert.ok(effectSeconds(forward.effect!) - end >= EFFECT.settleSeconds - 1e-9);
  // An effect from before the page opened is shown finished.
  assert.equal(shownSquare(forward, 0, forward.roll, Infinity, fx(forward, Infinity)), 10);

  // Ladder 4 → 8: up over the gap between the rows, along the scenery's curve.
  const ladder = effectBoard({ type: "ladder", from: 4, to: 8 }, [[0, 8], [1, 3], [2, 15]]);
  const climb = pawnPoses(ladder, path, null, Infinity, fx(ladder, EFFECT.leadSeconds + EFFECT.climbSeconds / 2)).get(0)!;
  assert.ok(climb.hopping && Math.abs(climb.y - LADDER_ARCH) < 0.02, `ladder top ${climb.y}`);
  const top = connectorPoint("ladder", path[4], path[8], 0.5);
  assert.ok(Math.hypot(climb.x - top.x, climb.z - top.z) < 1e-9);
  // Slide 16 → 12: high at the start, down to the tiles at the end.
  const slide = effectBoard({ type: "slide", from: 16, to: 12 }, [[0, 12], [1, 3], [2, 15]]);
  const edge = connectorPoint("slide", path[16], path[12], 0.3);
  assert.ok(edge.y > SLIDE_TOP * 0.5);
  assert.deepEqual(connectorPoint("slide", path[16], path[12], 1), { x: path[12].x, y: 0, z: path[12].z });
  const late = pawnPoses(slide, path, null, Infinity, fx(slide, EFFECT.leadSeconds + EFFECT.slideSeconds * 0.98)).get(0)!;
  assert.ok(late.y < 0.1 && Math.hypot(late.x - path[12].x, late.z - path[12].z) < 1.2);

  // Swap Kedi (10 → 15) with Hamsi (15 → 10): both in the air, side by side, crossing.
  const swap = effectBoard({ type: "swap", from: 10, to: 15, other: 2 }, [[0, 15], [1, 3], [2, 10]]);
  assert.equal(shownSquare(swap, 2, null, Infinity, fx(swap, 0.2)), 15, "the partner waits on its own square during the lead");
  const half = pawnPoses(swap, path, null, Infinity, fx(swap, EFFECT.leadSeconds + EFFECT.swapSeconds / 2));
  const [a, b] = [half.get(0)!, half.get(2)!];
  assert.ok(a.hopping && b.hopping && a.y > 1 && b.y > 1);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 1, "they pass side by side");
  // Bonus and an empty swap: nobody moves.
  for (const still of [effectBoard({ type: "bonus", from: 7, to: 7, gained: true }, [[0, 7], [1, 3], [2, 15]]), effectBoard({ type: "swap", from: 7, to: 7 }, [[0, 7], [1, 3], [2, 15]])])
    assert.equal(pawnPoses(still, path, null, Infinity, fx(still, EFFECT.leadSeconds + 0.3)).get(0)!.hopping, false);
  // Camera: follow the effect, both players for a swap.
  assert.deepEqual(boardShot(ladder, null, Infinity), { kind: "follow", slot: 0 });
  assert.deepEqual(boardShot(swap, null, Infinity), { kind: "pair", slots: [0, 2] });
});

test("effect notices: names without suffixes, the player's own in the second person, nobody to swap with", () => {
  const name = (slot: number) => ["Kedi", "Ceylan", "Hamsi"][slot];
  const text = (effect: Partial<BoardEffect>, self = 1) => effectText({ seq: 1, slot: 2, type: "forward", from: 7, to: 10, other: -1, gained: true, ...effect }, name, self, 20);
  assert.deepEqual(text({ type: "slide", from: 16, to: 12 }), { title: "Hamsi kaydıraktan kaydı!", detail: "16. kare → 12. kare" });
  assert.equal(text({ type: "slide", from: 16, to: 12 }, 2).title, "Kaydıraktan kaydın!");
  assert.equal(text({ type: "ladder", from: 4, to: 8 }).title, "Hamsi merdivenden çıktı!");
  assert.equal(text({}).title, "Hamsi 3 kare ileri gitti!");
  assert.deepEqual(text({ from: 17, to: 20 }, 2), { title: "3 kare ileri gittin!", detail: "Hazineye ulaştın!" });
  assert.deepEqual(text({ type: "back", from: 2, to: 0 }), { title: "Hamsi 2 kare geri gitti!", detail: "Başlangıca döndü" });
  assert.equal(text({ type: "bonus", from: 5, to: 5 }).title, "Hamsi bonus zar kazandı!");
  assert.equal(text({ type: "swap", from: 10, to: 15, other: 0 }).title, "Hamsi ile Kedi yer değiştirdi!");
  assert.equal(text({ type: "swap", from: 10, to: 15, other: 1 }).title, "Hamsi seninle yer değiştirdi!");
  assert.equal(text({ type: "swap", from: 10, to: 15, other: 0 }, 2).title, "Kedi ile yer değiştirdin!");
  assert.deepEqual(text({ type: "swap", from: 10, to: 10, other: -1 }), { title: "Yer değiştirecek kimse yok!", detail: "Herkes aynı karede" });
  // The banner during the effect phase is the notice; a bonus roll says so.
  assert.equal(boardBanner(effectBoard({ type: "slide", from: 16, to: 12, slot: 2 }), name, 0, true).title, "Hamsi kaydıraktan kaydı!");
  const bonus: BoardRoll = { seq: 3, slot: 0, kind: "two", dice: [3, 5], value: 6, bonus: true, from: 2, to: 8, auto: false };
  assert.equal(rollText(bonus), "3 ve 5 → 5 · +1 bonus → 6");
  assert.equal(rollText({ ...bonus, kind: "plus", dice: [6], value: 8 }), "6 + 1 → 7 · +1 bonus → 8");
  assert.equal(boardBanner(base({ roll: bonus }), name, 1, false).detail, "İki zar · büyüğü alınır · +1 bonus");
});

test("legend: every special type, each with its own colour, glyph, name and rule", () => {
  assert.deepEqual([...LEGEND_ORDER].sort(), [...SPECIAL_TYPES].sort());
  const colours = SPECIAL_TYPES.map((t) => SQUARE_STYLE[t].color.toLowerCase());
  assert.equal(new Set(colours).size, SPECIAL_TYPES.length);
  for (const t of SPECIAL_TYPES) assert.ok(SQUARE_STYLE[t].name && SQUARE_STYLE[t].rule && /^M/.test(SQUARE_STYLE[t].glyph), t);
  // The hues are far apart, so the squares read from the overview.
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (let i = 0; i < colours.length; i++)
    for (let j = i + 1; j < colours.length; j++) {
      const d = Math.abs(hue(colours[i]) - hue(colours[j]));
      assert.ok(Math.min(d, 360 - d) >= 18, `${SPECIAL_TYPES[i]} / ${SPECIAL_TYPES[j]}`);
    }
});
