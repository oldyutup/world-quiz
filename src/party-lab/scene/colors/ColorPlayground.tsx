import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Fog, Quaternion, Vector3, type Group, type Material, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import { CameraFeel } from "../../audio/feel";
import type { Bindings } from "../../input/bindings";
import { isUIInput } from "../../input/device";
import { bindKeyboard } from "../../input/keyboard";
import type { LookController } from "../../input/look";
import PlayerBean from "../PlayerBean";
import { initializePhysics, PHYSICS } from "../physics";
import { PLAYERS, type PlayerId } from "../players";
import { PARTS } from "../ragdoll/config";
import { localCostumeForSlot, type SelectableCostumeId } from "../visual/costumes";
import { layerIntent } from "../layers/controls";
import { colorTileAt } from "../../../../shared/party-lab/maps/colors";
import { COLOR_IDS, type ColorIndex } from "../../../../shared/party-lab/simulation/colors/config";
import { colorCounts, encodeLayout, NO_COLOR } from "../../../../shared/party-lab/simulation/colors/layouts";
import { STAGE_SIZES } from "../../../../shared/party-lab/simulation/colors/shrink";
import type { ColorPhase } from "../../../../shared/party-lab/simulation/colors/schedule";
import type { LayerPhase, LayerResult } from "../../../../shared/party-lab/simulation/layers/round";
import { ColorBot } from "./bots";
import { clampColorPitch, COLOR_CAMERA, colorCameraPosition, ColorFall, ColorFollow } from "./colorCamera";
import { ColorChaosGame } from "./game";
import { colorLabel, TILE_HEX, TILE_INK } from "./palette";
import { buildScenery } from "./scenery";
import { ColorTileVisuals } from "./tileVisuals";

/** What the React HUD shows; republished only when it changes. */
export interface ColorSnapshot {
  phase: LayerPhase;
  /** Countdown/results: seconds left; play: seconds elapsed. */
  seconds: number;
  alive: boolean[];
  active: boolean[];
  winner: PlayerId | null;
  reason: LayerResult | null;
  /** Round time the result was decided (s). */
  endedAt: number;
  /** Who the camera follows while the local player is out (null: themself). */
  spectating: PlayerId | null;
  /** 1-based colour cycle. */
  cycle: number;
  cyclePhase: ColorPhase;
  target: ColorIndex;
  /** This cycle's reaction time (s). */
  reaction: number;
  /** Daralma: this cycle marks tiles that leave after it ("DARALIYOR!"). */
  shrinking: boolean;
  /** Daralma: no colour left — this drop takes the last tile. */
  final: boolean;
}
/** Imperative per-frame DOM (no React re-renders). */
export interface ColorHudElements {
  debug: HTMLElement | null;
  callout: HTMLElement | null;
  timer: HTMLElement | null;
  bar: HTMLElement | null;
}
type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";

/** Seconds the camera stays on an eliminated body's fall before following someone else. */
const SPECTATE_HOLD = 1.2;
const SKY = "#e6e3ee";
/** The final drop's call (no colour left): the grey tiles' ash, darker. */
const FINAL_HEX = "#2c2934";

/** Pale lilac-grey sky and fog, soft light, a haze floor above the fall line, the Prizma Meydanı scenery. */
export function ColorEnvironment({ scenery }: { scenery: MutableRefObject<Group | null> }) {
  const scene = useThree((state) => state.scene);
  const background = useMemo(buildScenery, []);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(SKY, 42, 125);
    scene.background = new Color(SKY);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  useEffect(
    () => () => {
      background.geometry.dispose();
      (background.material as Material).dispose();
    },
    [background]
  );
  return (
    <>
      <hemisphereLight args={["#fffaf2", "#9a93b0", 1.6]} />
      <directionalLight position={[-9, 28, 14]} intensity={2.0} color="#fff4e4" />
      {/* Haze below the field: a falling body sinks out of sight before the fall line (−5 m). */}
      <mesh position={[0, -4.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[170, 48]} />
        <meshBasicMaterial color="#ebe8f2" />
      </mesh>
      <group ref={scenery} name="prizma">
        <primitive object={background} />
      </group>
    </>
  );
}

/**
 * Local Renk Kaosu: 1 human + 1–2 bots on the colour field, with the elevated chase
 * camera, contact shadows, spectating and a debug readout. Nothing here is shared with
 * Rooftop, Barn or Katman Kaosu beyond the ragdoll, the shove punch and the round rules.
 */
export default function ColorPlayground({
  players,
  onStatus,
  onSnapshot,
  hud,
  bindings,
  paused,
  menuOpen,
  audio,
  shakeEnabled,
  costumeId,
  look,
}: {
  players: 2 | 3;
  onStatus: (status: ArenaStatus) => void;
  onSnapshot: (snapshot: ColorSnapshot) => void;
  hud: MutableRefObject<ColorHudElements>;
  bindings: Bindings;
  /** The arena is hidden (lobby-level settings): the simulation stops. */
  paused: boolean;
  /** The Esc menu is open: only this player's input stops; the round and bots go on. */
  menuOpen: boolean;
  audio: AudioManager;
  shakeEnabled: boolean;
  costumeId: SelectableCostumeId;
  look: MutableRefObject<LookController | null>;
}) {
  const { camera, gl } = useThree();
  const beans = useRef<(Group | null)[]>([]);
  const game = useRef<ColorChaosGame | null>(null);
  const bots = useRef<ColorBot[]>([]);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const inputOff = paused || menuOpen;
  const inputOffNow = useRef(inputOff);
  inputOffNow.current = inputOff;
  const poses = useRef(
    PLAYERS.map(() => PARTS.map(() => ({ previous: new Vector3(), current: new Vector3(), previousQ: new Quaternion(), currentQ: new Quaternion() })))
  );
  const accumulator = useRef(0);
  const feel = useRef(new CameraFeel());
  const visuals = useMemo(() => new ColorTileVisuals(), []);
  useEffect(() => () => visuals.dispose(), [visuals]);
  const view = useRef({
    yaw: 0,
    pitch: COLOR_CAMERA.restPitch as number,
    follow: new ColorFollow(),
    spectating: null as PlayerId | null,
  });
  const falls = useRef(PLAYERS.map(() => new ColorFall()));
  /** Presentation-only continuation of a fall past the elimination line (the body itself is frozen). */
  const ghosts = useRef(PLAYERS.map(() => ({ active: false, age: 0, v: new Vector3() })));
  const published = useRef({ key: "" });
  const readout = useRef({ time: 0, frames: 0, simulationMs: 0, steps: 0, fps: 0, physicsMs: 0, hud: 0 });
  const time = useRef(0);
  const scratch = useRef({ pelvis: new Vector3(), velocity: new Vector3() });
  /**
   * Local debug aids, only with `?colorDebug=1`: P hands slot 0 to a bot (autopilot),
   * T jumps the cycle count 5 ahead (faster timers from the next cycle), G hides/shows
   * the background scenery.
   */
  const tools = useMemo(() => new URLSearchParams(window.location.search).has("colorDebug"), []);
  const autopilot = useRef<ColorBot | null>(null);
  const scenery = useRef<Group | null>(null);
  /** Shoves the local player landed this session (debug readout). */
  const humanHits = useRef(0);

  const snapshotOf = (g: ColorChaosGame): ColorSnapshot => {
    const round = g.round,
      cycle = g.schedule.cycle,
      tick = round.phase === "playing" ? Math.max(0, round.tick - 1) : 0;
    return {
      phase: round.phase,
      seconds: round.seconds,
      alive: [...round.alive],
      active: [...round.active],
      winner: round.winner,
      reason: round.reason,
      endedAt: round.endedAt / 60,
      spectating: view.current.spectating,
      cycle: cycle.index,
      cyclePhase: round.phase === "playing" ? g.schedule.phase(tick) : "preview",
      target: cycle.target,
      reaction: (cycle.drop - cycle.announce) / 60,
      shrinking: round.phase === "playing" && cycle.warned.includes(1),
      final: round.phase === "playing" && cycle.final,
    };
  };
  const publish = (g: ColorChaosGame) => {
    const snapshot = snapshotOf(g),
      key = `${g.round.revision}|${snapshot.spectating}|${snapshot.cycle}|${snapshot.cyclePhase}`;
    if (key === published.current.key) return;
    published.current.key = key;
    onSnapshot(snapshot);
  };
  const resetView = (g: ColorChaosGame) => {
    const own = g.physics.players[0].body.translation();
    view.current.yaw = Math.atan2(-own.x, -own.z);
    view.current.pitch = COLOR_CAMERA.restPitch;
    view.current.follow.reset();
    view.current.spectating = null;
    falls.current.forEach((fall) => fall.reset());
    ghosts.current.forEach((ghost) => (ghost.active = false));
  };
  const snapPoses = (g: ColorChaosGame) => {
    for (const player of g.physics.players)
      PARTS.forEach((name, index) => {
        const pose = poses.current[player.id][index],
          body = player.parts[name].body;
        pose.current.copy(body.translation());
        pose.previous.copy(pose.current);
        pose.currentQ.copy(body.rotation());
        pose.previousQ.copy(pose.currentQ);
      });
  };
  /** "MAVİ!" over the arena on every announcement ("SON!" for the final drop), then it shrinks away while the timer runs. */
  const callout = (color: ColorIndex | null) => {
    const element = hud.current.callout;
    if (!element) return;
    element.textContent = color === null ? "SON!" : `${colorLabel(color)}!`;
    element.dataset.color = color === null ? "none" : COLOR_IDS[color];
    element.style.backgroundColor = color === null ? FINAL_HEX : TILE_HEX[color];
    element.style.color = color === null ? "#ffffff" : TILE_INK[color];
    element.getAnimations().forEach((a) => a.cancel());
    element.animate(
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.6)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1.08)", offset: 0.12 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.5 },
        { opacity: 0, transform: "translate(-50%, -140%) scale(0.55)" },
      ],
      { duration: 1100, easing: "ease-out", fill: "forwards" }
    );
  };

  useEffect(() => {
    const perspective = camera as PerspectiveCamera,
      previous = perspective.fov;
    perspective.fov = COLOR_CAMERA.fov;
    perspective.updateProjectionMatrix();
    return () => {
      perspective.fov = previous;
      perspective.updateProjectionMatrix();
    };
  }, [camera]);

  useLayoutEffect(() => {
    keyboard.current?.setBindings(bindings);
    keyboard.current?.setSuspended(inputOff);
    if (paused) {
      audio.stopAll();
      feel.current.clear();
    }
  }, [bindings, paused, inputOff]);

  useEffect(() => {
    let cancelled = false;
    const lockSurface = gl.domElement.closest(".pl-viewport") as HTMLElement | null;
    const controls = bindKeyboard(
      gl.domElement,
      bindings,
      lockSurface ? { mouseSurface: lockSurface, claimMouse: (event) => look.current?.claimsClick(event) ?? false } : {}
    );
    controls.setSuspended(inputOffNow.current);
    keyboard.current = controls;
    const keys = (event: KeyboardEvent) => {
      const g = game.current;
      if (!g || inputOffNow.current || isUIInput(event.target)) return;
      if (tools && event.code === "KeyP") {
        autopilot.current = autopilot.current ? null : new ColorBot(0);
        return;
      }
      if (tools && event.code === "KeyT") {
        g.schedule.cycle.index += 5;
        return;
      }
      if (tools && event.code === "KeyG") {
        if (scenery.current) scenery.current.visible = !scenery.current.visible;
        return;
      }
      // Spectating: Q / E cycle through the survivors.
      if (event.code !== "KeyQ" && event.code !== "KeyE") return;
      if (g.round.alive[0]) return;
      const survivors = g.round.survivors;
      if (!survivors.length) return;
      const at = survivors.indexOf(view.current.spectating ?? (-1 as PlayerId));
      const step = event.code === "KeyE" ? 1 : -1;
      view.current.spectating = survivors[(at + step + survivors.length) % survivors.length];
      view.current.follow.blend = 0.5;
    };
    window.addEventListener("keydown", keys);
    void initializePhysics()
      .then(() => {
        if (cancelled) return;
        const g = new ColorChaosGame(
          (event) => {
            audio.playSfx(event);
            feel.current.trigger(event);
          },
          { players }
        );
        game.current = g;
        bots.current = [new ColorBot(1), new ColorBot(2)];
        bots.current.forEach((bot) => bot.reset());
        accumulator.current = 0;
        resetView(g);
        snapPoses(g);
        publish(g);
        onStatus("ready");
      })
      .catch(() => {
        if (!cancelled) onStatus("error");
      });
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", keys);
      audio.stopAll();
      feel.current.clear();
      controls.dispose();
      keyboard.current = null;
      game.current?.dispose();
      game.current = null;
    };
  }, [onStatus, onSnapshot, gl, audio, players]);

  useFrame((_, delta) => {
    const g = game.current,
      controls = keyboard.current;
    if (!g || !controls) return;
    if (paused || document.hidden || delta > 0.25) {
      accumulator.current = 0;
      controls.clear();
      feel.current.clear();
      return;
    }
    const v = view.current;
    const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
    v.yaw -= dx * COLOR_CAMERA.sensitivity;
    v.pitch = clampColorPitch(v.pitch + dy * COLOR_CAMERA.sensitivity);
    time.current += delta;
    accumulator.current += Math.min(delta, 0.1);
    let announced: ColorIndex | "final" | null = null;
    while (accumulator.current >= PHYSICS.step) {
      for (const character of poses.current)
        for (const pose of character) {
          pose.previous.copy(pose.current);
          pose.previousQ.copy(pose.currentQ);
        }
      const human = layerIntent(controls.readIntent(), v.yaw);
      const inputs = [autopilot.current?.update(g) ?? human, bots.current[0].update(g), bots.current[1].update(g)];
      const start = performance.now();
      const event = g.step(inputs);
      readout.current.simulationMs += performance.now() - start;
      readout.current.steps++;
      if (event) controls.clear();
      if (g.event === "target") announced = g.schedule.cycle.final ? "final" : g.schedule.cycle.target;
      for (const shove of g.brawl.shoves) if (shove.attacker === 0) humanHits.current++;
      for (const player of g.physics.players) {
        if (player.eliminated) continue;
        falls.current[player.id].update(player.body.translation().y, player.body.linvel().y);
      }
      for (const player of g.physics.players)
        PARTS.forEach((name, index) => {
          const pose = poses.current[player.id][index],
            body = player.parts[name].body;
          pose.current.copy(body.translation());
          pose.currentQ.copy(body.rotation());
          if (event === "reset") {
            pose.previous.copy(pose.current);
            pose.previousQ.copy(pose.currentQ);
          }
        });
      for (const id of g.eliminated) {
        const pelvis = poses.current[id][0],
          ghost = ghosts.current[id];
        ghost.active = true;
        ghost.age = 0;
        ghost.v.copy(pelvis.current).sub(pelvis.previous).divideScalar(PHYSICS.step);
      }
      if (event === "reset") {
        bots.current.forEach((bot) => bot.reset());
        autopilot.current?.reset();
        resetView(g);
      }
      accumulator.current -= PHYSICS.step;
    }
    if (announced !== null) callout(announced === "final" ? null : announced);
    const alpha = accumulator.current / PHYSICS.step;
    const round = g.round;
    // ── Characters and their contact shadows ──
    for (const player of g.physics.players) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const ghost = ghosts.current[player.id];
      if (ghost.active) ghost.age += delta;
      const falling = ghost.active && ghost.age < SPECTATE_HOLD;
      bean.visible = !player.eliminated || falling;
      if (!bean.visible) {
        visuals.setShadow(player.id, null);
        continue;
      }
      const t = falling ? ghost.age : 0;
      PARTS.forEach((name, index) => {
        const node = bean.getObjectByName(name)!,
          pose = poses.current[player.id][index];
        node.position.lerpVectors(pose.previous, pose.current, falling ? 1 : alpha);
        node.quaternion.slerpQuaternions(pose.previousQ, pose.currentQ, falling ? 1 : alpha);
        if (falling) {
          node.position.x += ghost.v.x * t;
          node.position.y += ghost.v.y * t + 0.5 * PHYSICS.gravity * t * t;
          node.position.z += ghost.v.z * t;
        }
        if (index === 0) {
          const material = (node.getObjectByName("skin") as Mesh).material as MeshStandardMaterial;
          material.emissiveIntensity = (g.brawl.fighters[player.id].flash / 0.15) * 0.7;
        }
      });
      const hips = bean.getObjectByName("pelvis")!.position,
        under = colorTileAt(hips.x, hips.z);
      visuals.setShadow(player.id, !falling && under && g.field.intact(under.id) && hips.y > -0.2 && hips.y < 3.5 ? hips : null);
    }
    // ── Who the camera follows ──
    if (round.alive[0]) v.spectating = null;
    else if (round.active[0]) {
      const watching = v.spectating ?? 0,
        stillIn = round.alive[watching] && round.active[watching],
        ghost = ghosts.current[watching],
        doneFalling = !ghost.active || ghost.age >= SPECTATE_HOLD;
      const survivors = round.survivors;
      if (!stillIn && doneFalling && survivors.length) {
        const from = poses.current[watching][0].current;
        v.spectating = survivors.reduce((best, id) =>
          poses.current[id][0].current.distanceToSquared(from) < poses.current[best][0].current.distanceToSquared(from) ? id : best
        );
        v.follow.blend = 0.5;
      }
    }
    const focus = v.spectating ?? 0,
      pelvis = scratch.current.pelvis;
    const focusNode = beans.current[focus]?.getObjectByName("pelvis");
    if (focusNode) pelvis.copy(focusNode.position);
    const focusGhost = ghosts.current[focus];
    const falling = falls.current[focus].falling || (focusGhost.active && focusGhost.age < SPECTATE_HOLD);
    const pivot = v.follow.update(pelvis, falling, delta);
    const position = colorCameraPosition(pivot, v.yaw, v.pitch);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(pivot.x, pivot.y - v.follow.lookDrop, pivot.z);
    const [shakeX, shakeY] = feel.current.step(delta, shakeEnabled);
    camera.position.x += shakeX;
    camera.position.y += shakeY;
    // ── Tiles ──
    const playing = round.phase === "playing";
    const visTick = playing ? Math.max(0, round.tick - 1 + alpha) : round.phase === "results" ? Math.max(0, round.endedAt) : 0;
    visuals.update(g.schedule, visTick, time.current, round.phase !== "countdown");
    // ── Reaction timer (per frame, no React) ──
    const cycle = g.schedule.cycle,
      running = playing && visTick >= cycle.announce && visTick < cycle.drop,
      left = running ? (cycle.drop - visTick) / 60 : 0;
    const { timer, bar } = hud.current;
    if (timer) timer.textContent = running ? left.toFixed(1) : "";
    if (bar) bar.style.transform = `scaleX(${running ? left / ((cycle.drop - cycle.announce) / 60) : 0})`;
    publish(g);
    // ── Debug readout (10 Hz) and performance (2 s) ──
    const r = readout.current;
    r.time += delta;
    r.frames++;
    if (r.time >= 2) {
      r.fps = r.frames / r.time;
      r.physicsMs = r.simulationMs / Math.max(1, r.steps);
      r.time = r.frames = r.simulationMs = r.steps = 0;
    }
    r.hud += delta;
    if (r.hud < 0.1) return;
    r.hud = 0;
    const counts = colorCounts(cycle.colors),
      standing = [0, 0, 0, 0];
    cycle.colors.forEach((c, id) => c !== NO_COLOR && g.field.intact(id) && standing[c]++);
    let present = 0,
      grey = 0,
      warned = 0;
    for (let id = 0; id < cycle.colors.length; id++) {
      present += cycle.present[id];
      warned += cycle.warned[id];
      if (cycle.present[id] && cycle.colors[id] === NO_COLOR) grey++;
    }
    const phase = playing ? g.schedule.phase(Math.floor(visTick)) : round.phase;
    const own = g.physics.players[0].body.translation();
    const lines = [
      `Hedef: ${colorLabel(cycle.target)} · Tur ${cycle.index} · Evre: ${phase} · Tepki ${((cycle.drop - cycle.announce) / 60).toFixed(1)} sn · kalan ${left.toFixed(2)} sn`,
      `Hayatta: ${round.survivors.length}/${g.players} · Süre: ${((playing ? round.tick : round.phase === "results" ? round.endedAt : 0) / 60).toFixed(1)} sn · Tur başı ${(cycle.start / 60).toFixed(1)} · düşüş ${(cycle.drop / 60).toFixed(1)} · dönüş ${(cycle.restore / 60).toFixed(1)}`,
      `Karolar (duran/toplam): ${COLOR_IDS.map((id, c) => `${id} ${standing[c]}/${counts[c]}`).join(" · ")} · düzen ${cycle.pick.bank}#${cycle.pick.index} s${cycle.pick.symmetry}`,
      `Daralma: evre ${cycle.stage} (${STAGE_SIZES[cycle.stage]} renkli karo) · bu turda ${present} karo · gri ${grey} · işaretli ${warned}${cycle.final ? " · SON DÜŞÜŞ" : ""}`,
      `Konum: x ${own.x.toFixed(2)} · y ${(own.y - 0.78).toFixed(2)} · z ${own.z.toFixed(2)} · karo ${colorTileAt(own.x, own.z)?.id ?? "—"} · düşüş: ${falls.current[0].falling ? "evet" : "yok"}`,
      `${Math.round(r.fps)} FPS · ${r.physicsMs.toFixed(2)} ms fizik · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · çarpıştırıcı ${g.field.enabledColliders} karo + ${g.players * 9} gövde`,
      ...(tools ? [`Hata ayıklama: P otopilot (${autopilot.current ? "açık" : "kapalı"}) · T +5 tur · G manzara (${scenery.current?.visible === false ? "kapalı" : "açık"})`] : []),
    ];
    const debug = hud.current.debug;
    if (debug) {
      debug.textContent = lines.join("\n");
      const round2 = (n: number) => Math.round(n * 100) / 100;
      debug.dataset.colors = JSON.stringify({
        phase: round.phase,
        cyclePhase: phase,
        tick: playing ? round.tick : 0,
        cycle: cycle.index,
        target: COLOR_IDS[cycle.target],
        reaction: (cycle.drop - cycle.announce) / 60,
        left: round2(left),
        times: { start: cycle.start, announce: cycle.announce, drop: cycle.drop, restore: cycle.restore },
        counts,
        standing,
        alive: round.alive,
        me: { alive: round.alive[0], pos: [own.x, own.y - 0.78, own.z].map(round2), tile: colorTileAt(own.x, own.z)?.id ?? null },
        spectating: v.spectating,
        focus,
        yaw: Math.round((v.yaw * 180) / Math.PI),
        fps: Math.round(r.fps),
        physicsMs: Math.round(r.physicsMs * 1000) / 1000,
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        colliders: g.field.enabledColliders,
        stats: { ...g.brawl.stats, humanHits: humanHits.current },
        layout: encodeLayout(cycle.colors),
        shrink: { stage: cycle.stage, present, grey, warned, final: cycle.final, coloured: STAGE_SIZES[cycle.stage], tiles: cycle.present.join(""), marks: cycle.warned.join("") },
        winner: round.winner,
        reason: round.reason,
        endedAt: round.endedAt,
        autopilot: !!autopilot.current,
        scenery: scenery.current?.visible !== false,
        players: g.physics.players.map((c) => {
          const at = c.body.translation();
          return [at.x, at.y - 0.78, at.z].map(round2).concat(round.alive[c.id] ? 1 : 0);
        }),
      });
    }
  });

  return (
    <>
      <ColorEnvironment scenery={scenery} />
      <primitive object={visuals.group} />
      {PLAYERS.map((player) => (
        <PlayerBean
          key={player.id}
          color={player.color}
          costume={localCostumeForSlot(costumeId, player.id)}
          ref={(bean) => {
            beans.current[player.id] = bean;
          }}
        />
      ))}
    </>
  );
}
