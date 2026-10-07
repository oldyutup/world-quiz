import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Euler, Fog, Quaternion, Sprite, Vector3, type MeshBasicMaterial, type PerspectiveCamera } from "three";
import { BOARD } from "../../../../shared/party-lab/board/config";
import type { BoardWire } from "../../../../shared/party-lab/board/wire";
import type { AudioManager } from "../../audio/AudioManager";
import type { LobbyPlayer } from "../../network/types";
import { resolveCostume } from "../visual/costumes";
import { BOARD_FOV, BoardCameraRig, FOCUS_DISTANCE, FOLLOW_DISTANCE, overviewFit, WINNER_DISTANCE } from "./boardCamera";
import { boardShot, effectStage, pawnPoses, rollSeconds, rollStage, shownSquare, type EffectClock } from "./boardMotion";
import { createBoardVisual, createPawn, faceUp, TILE_TOP, type Pawn } from "./boardVisual";
import { SQUARE_STYLE } from "./squareStyle";
import type { SfxName } from "../../../../shared/party-lab/feedback/events";
import type { SpecialType } from "../../../../shared/party-lab/board/config";

/** The cue when an effect starts (its square lights up). */
const EFFECT_CUES: Record<SpecialType, SfxName> = { forward: "jump", bonus: "weaponPickup", back: "lightBump", slide: "fall", ladder: "lift", swap: "throw" };

/** When this page first saw a roll (performance.now ms); −∞ means "already over". */
export interface RollClock {
  seq: number;
  at: number;
}
const SKY = "#cfe1d6";
const DIE_HEIGHT = 2.1;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export default function BoardScene({ board, players, clock, effectClock, audio, onReady }: {
  board: BoardWire;
  players: LobbyPlayer[];
  clock: MutableRefObject<RollClock>;
  /** When this page first saw the latest special square effect. */
  effectClock: MutableRefObject<RollClock>;
  audio?: AudioManager;
  /** The first frame is drawn (the page drops its loading cover). */
  onReady?: () => void;
}) {
  const { scene, camera, size } = useThree();
  // The layout is fixed for a match: the scenery is rebuilt only for a new board.
  const layout = JSON.stringify(board.squares);
  const visual = useMemo(() => createBoardVisual(board.length, JSON.parse(layout) as BoardWire["squares"]), [board.length, layout]);
  const pawns = useRef(new Map<number, Pawn>());
  const badges = useRef(new Map<number, Sprite>());
  const live = useRef({ board, players });
  live.current = { board, players };
  useLayoutEffect(() => {
    const background = scene.background,
      fog = scene.fog;
    scene.background = new Color(SKY);
    scene.fog = new Fog(SKY, 60, 160);
    const lens = camera as PerspectiveCamera;
    lens.fov = BOARD_FOV;
    lens.far = 400;
    lens.updateProjectionMatrix();
    return () => {
      scene.background = background;
      scene.fog = fog;
    };
  }, [scene, camera]);
  useEffect(
    () => () => {
      for (const pawn of pawns.current.values()) pawn.dispose();
      pawns.current.clear();
      badges.current.clear();
      visual.dispose();
    },
    [visual]
  );
  // One pawn per board player: their costume and colour, rebuilt only when those change.
  const roster = board.pieces
    .map(([slot]) => {
      const p = players.find((q) => q.slot === slot);
      return `${slot}:${p?.color}:${p?.costumeId}:${p?.nickname}`;
    })
    .join("|");
  useEffect(() => {
    const keep = new Set<number>();
    for (const [slot] of live.current.board.pieces) {
      const p = live.current.players.find((q) => q.slot === slot);
      const key = `${p?.color}:${p?.costumeId}:${p?.nickname}`;
      keep.add(slot);
      const old = pawns.current.get(slot);
      if (old?.key === key) continue;
      if (old) {
        visual.root.remove(old.group);
        old.dispose();
      }
      const pawn = createPawn(p?.color ?? "#d9d2c3", resolveCostume(p?.costumeId), p?.nickname ?? "Oyuncu", key);
      visual.root.add(pawn.group);
      pawns.current.set(slot, pawn);
      // The bonus die badge rides above the name tag.
      const badge = new Sprite(visual.bonusBadge);
      badge.scale.set(0.5, 0.4, 1);
      badge.renderOrder = 7;
      badge.visible = false;
      pawn.group.add(badge);
      badges.current.set(slot, badge);
    }
    for (const [slot, pawn] of pawns.current)
      if (!keep.has(slot)) {
        visual.root.remove(pawn.group);
        pawn.dispose();
        pawns.current.delete(slot);
        badges.current.delete(slot);
      }
  }, [visual, roster]);

  const fit = useMemo(() => overviewFit(visual.bounds, size.width / Math.max(1, size.height)), [visual, size.width, size.height]);
  const rig = useMemo(() => new BoardCameraRig(), []);
  const cues = useRef({ seq: -1, stage: "", hop: -1, finished: false, effect: -1, effectStage: "" });
  const spin = useMemo(() => [new Quaternion(), new Quaternion()], []);
  const aim = useMemo(() => new Vector3(), []);
  const drawn = useRef(false);

  useFrame((state, frameDt) => {
    const dt = Math.min(frameDt, 0.1),
      time = state.clock.elapsedTime;
    const { board } = live.current;
    const roll = board.roll;
    const elapsed = roll && clock.current.seq === roll.seq ? (performance.now() - clock.current.at) / 1000 : Infinity;
    const effect = board.effect;
    const fx: EffectClock | null = effect ? { effect, elapsed: effectClock.current.seq === effect.seq ? (performance.now() - effectClock.current.at) / 1000 : Infinity } : null;
    const fxStage = fx && Number.isFinite(fx.elapsed) ? effectStage(fx.effect, fx.elapsed) : null;
    const poses = pawnPoses(board, visual.path, roll, elapsed, fx);
    // Players per square, and each one's place in that crowd (slot order), for size and name tags.
    const crowd = new Map<number, number>(),
      place = new Map<number, number>();
    for (const [slot] of board.pieces) if (!poses.get(slot)?.hopping) {
      const square = shownSquare(board, slot, roll, elapsed, fx);
      place.set(slot, crowd.get(square) ?? 0);
      crowd.set(square, (crowd.get(square) ?? 0) + 1);
    }
    const ease = 1 - Math.exp(-dt * 9),
      turn = 1 - Math.exp(-dt * 8);
    for (const [slot, pawn] of pawns.current) {
      const pose = poses.get(slot);
      pawn.group.visible = !!pose;
      if (!pose) continue;
      const shown = pawn.shown;
      if (!shown.placed || pose.hopping) {
        shown.x = pose.x;
        shown.z = pose.z;
        shown.placed = true;
      } else {
        shown.x += (pose.x - shown.x) * ease;
        shown.z += (pose.z - shown.z) * ease;
      }
      // Hopping pawns look where they go; standing ones face the camera.
      shown.yaw += wrap((pose.hopping ? pose.yaw : 0) - shown.yaw) * turn;
      const together = pose.hopping ? 1 : crowd.get(shownSquare(board, slot, roll, elapsed, fx)) ?? 1;
      const scale = together <= 1 ? 0.55 : together === 2 ? 0.5 : together === 3 ? 0.42 : 0.34;
      const cheer = board.phase === "finished" && board.winner === slot ? Math.abs(Math.sin(time * 5.5)) * 0.35 : 0;
      shown.y = pose.y + cheer;
      pawn.group.position.set(shown.x, 0, shown.z);
      pawn.body.position.y = TILE_TOP + shown.y;
      pawn.body.rotation.y = shown.yaw;
      pawn.body.scale.setScalar(scale);
      pawn.shadow.scale.setScalar(Math.max(0.5, 1 - shown.y * 0.7) * (scale / 0.42));
      // Name tags of a crowd stack instead of overlapping.
      pawn.tag.position.set(0, TILE_TOP + shown.y + 2.0 * scale + 0.25 + (place.get(slot) ?? 0) * 0.36, 0);
      // A bonus die: the badge over the tag, popping in when it is won.
      const badge = badges.current.get(slot);
      if (badge) {
        badge.visible = board.bonus.includes(slot);
        badge.position.set(0.95, pawn.tag.position.y, 0);
        const pop = fx && fx.effect.type === "bonus" && fx.effect.slot === slot && fxStage && fxStage.stage !== "done" ? Math.sin(Math.PI * Math.min(1, fx.elapsed / 0.6)) * 0.5 : 0;
        badge.scale.set(0.5 * (1 + pop), 0.4 * (1 + pop), 1);
      }
    }

    // The ring marks whose turn it is.
    const current = board.current;
    // An effect's square lights up in its own colour first.
    const ring = visual.ring;
    const lit = board.phase === "effect" && fx && fxStage?.stage === "lead";
    ring.visible = ((board.phase === "choose" || board.phase === "roll") && current >= 0) || !!lit;
    if (lit) {
      const at = visual.path[fx!.effect.from];
      ring.position.set(at.x, TILE_TOP + 0.015, at.z);
      ring.scale.setScalar(1.05 + 0.18 * Math.sin(Math.PI * fxStage!.u));
      (ring.material as MeshBasicMaterial).color.set(SQUARE_STYLE[fx!.effect.type].color);
    } else if (ring.visible) {
      const at = visual.path[shownSquare(board, current, roll, elapsed, fx)];
      ring.position.set(at.x, TILE_TOP + 0.015, at.z);
      ring.scale.setScalar(1 + 0.06 * Math.sin(time * 4));
      const color = live.current.players.find((p) => p.slot === current)?.color ?? "#ffffff";
      (ring.material as MeshBasicMaterial).color.set(color);
    }

    // Dice: tumble for BOARD.diceSeconds above the mover, land on the server's values.
    const showDice = !!roll && elapsed < rollSeconds(roll) + BOARD.settleSeconds && board.pieces.some(([s]) => s === roll.slot);
    visual.dice.forEach((die, i) => {
      die.visible = showDice && i < roll!.dice.length;
      if (!die.visible) return;
      const r = roll!,
        from = visual.path[r.from],
        t = elapsed,
        two = r.dice.length === 2;
      const target = faceUp(r.dice[i]);
      const x = from.x + (two ? (i ? 0.45 : -0.45) : 0);
      if (t < BOARD.diceSeconds) {
        const u = t / BOARD.diceSeconds,
          seed = r.seq * 13 + i * 7;
        const angle = (1 - (1 - u) * (1 - u)) * 9;
        spin[i].setFromEuler(new Euler(angle * (1 + (seed % 3) * 0.35), angle * 0.7, angle * (1.2 - (seed % 2) * 0.4)));
        const settle = Math.max(0, (u - 0.72) / 0.28);
        die.quaternion.copy(spin[i]).slerp(target, settle * settle * (3 - 2 * settle));
        die.position.set(x, TILE_TOP + DIE_HEIGHT + Math.abs(Math.sin(u * Math.PI * 3)) * 0.55 * (1 - u), from.z);
        die.scale.setScalar(1);
      } else {
        die.quaternion.copy(target);
        // Two dice: the higher one counts, the other steps back.
        const kept = !two || r.dice[i] >= r.dice[1 - i];
        die.position.set(x, TILE_TOP + DIE_HEIGHT - (kept ? 0 : 0.15), from.z);
        die.scale.setScalar(kept ? 1 + 0.08 * Math.max(0, 1 - (t - BOARD.diceSeconds) * 3) : 0.72);
      }
    });
    const plus = visual.plusOne;
    plus.visible = showDice && roll!.kind === "plus" && elapsed >= BOARD.diceSeconds;
    if (plus.visible) {
      const from = visual.path[roll!.from];
      plus.position.set(from.x + 0.62, TILE_TOP + DIE_HEIGHT + 0.25, from.z);
    }
    // A bonus die used on this roll: its "+1" on the other side of the dice.
    const bonusPlus = visual.bonusPlus;
    bonusPlus.visible = showDice && roll!.bonus && elapsed >= BOARD.diceSeconds;
    if (bonusPlus.visible) {
      const from = visual.path[roll!.from];
      bonusPlus.position.set(from.x - (roll!.dice.length === 2 ? 1.15 : 0.7), TILE_TOP + DIE_HEIGHT + 0.25, from.z);
    }

    // Treasure: sparkles turn; the lid opens for the winner.
    visual.sparkles.rotation.y += dt * 0.8;
    visual.sparkles.position.y = TILE_TOP + 0.9 + Math.sin(time * 2) * 0.06;
    const open = board.phase === "finished" && board.reason === "treasure" ? -1.15 : 0;
    visual.chestLid.rotation.x += (open - visual.chestLid.rotation.x) * (1 - Math.exp(-dt * 4));
    visual.sparkles.scale.setScalar(open ? 1.6 : 1);

    // Sound cues from the same clock as the picture.
    const cue = cues.current;
    if (roll && roll.seq !== cue.seq) {
      cue.seq = roll.seq;
      cue.stage = "";
      cue.hop = -1;
    }
    if (roll && Number.isFinite(elapsed)) {
      const motion = rollStage(roll, elapsed);
      if (cue.stage === "" && motion.stage === "dice") audio?.playSfx({ name: "throw", intensity: 0.3 });
      if (cue.stage === "dice" && motion.stage !== "dice") audio?.playSfx({ name: "heavyBump", intensity: 0.35 });
      if (cue.stage === "hop" && motion.hop > cue.hop) audio?.playSfx({ name: "landing", intensity: 0.25 });
      cue.stage = motion.stage;
      cue.hop = motion.hop;
    }
    if (fx && fxStage) {
      if (fx.effect.seq !== cue.effect) {
        cue.effect = fx.effect.seq;
        cue.effectStage = "";
      }
      if (cue.effectStage === "" && fxStage.stage !== "done") audio?.playSfx({ name: fx.effect.type === "swap" && fx.effect.other < 0 ? "uiBack" : EFFECT_CUES[fx.effect.type], intensity: 0.4 });
      if (cue.effectStage === "travel" && fxStage.stage === "done" && fx.effect.from !== fx.effect.to) audio?.playSfx({ name: "landing", intensity: 0.3 });
      cue.effectStage = fxStage.stage;
    }
    if (board.phase === "finished" && !cue.finished) {
      cue.finished = true;
      audio?.playSfx({ name: "winner" });
    }

    // Camera: whole board between rounds, the player on turn, the hop, the winner.
    const shot = boardShot(board, roll, elapsed);
    if (shot.kind === "overview") rig.update(camera as PerspectiveCamera, fit.target, fit.distance, dt);
    else if (shot.kind === "pair") {
      // A swap: both players in view.
      const [a, b] = shot.slots.map((slot) => pawns.current.get(slot)?.shown);
      if (a && b) {
        aim.set((a.x + b.x) / 2, 0.4, (a.z + b.z) / 2);
        const apart = Math.hypot(a.x - b.x, a.z - b.z);
        rig.update(camera as PerspectiveCamera, aim, Math.min(fit.distance, Math.max(FOCUS_DISTANCE, apart * 1.3 + 6)), dt);
      } else rig.update(camera as PerspectiveCamera, fit.target, fit.distance, dt);
    } else {
      const pawn = pawns.current.get(shot.slot);
      const pose = poses.get(shot.slot);
      if (pawn && pose) aim.set(pawn.shown.x, 0.4, pawn.shown.z);
      else aim.copy(fit.target);
      // The celebration card sits low on the screen: keep the winner and the chest above it.
      if (shot.kind === "winner") aim.z += 2.2;
      const want = shot.kind === "follow" ? FOLLOW_DISTANCE : shot.kind === "winner" ? WINNER_DISTANCE : FOCUS_DISTANCE;
      rig.update(camera as PerspectiveCamera, aim, Math.min(want, fit.distance), dt);
    }
    if (!drawn.current) {
      drawn.current = true;
      onReady?.();
    }
  });

  return (
    <>
      <hemisphereLight args={["#f3eddb", "#819b89", 2.0]} />
      <directionalLight color="#ffe5bd" position={[-8, 20, 12]} intensity={2.4} />
      <primitive object={visual.root} />
    </>
  );
}
