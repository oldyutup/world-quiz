import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Fog, Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from "three";
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
import { spawnYaw } from "../../../../shared/party-lab/maps";
import { LAYER_NAMES, LAYER_OUTER_RING, layerBelow } from "../../../../shared/party-lab/maps/layers";
import { breakTicks, LAYER_CHAOS, LAYER_TICKS, schedulePhase, type SchedulePhase } from "../../../../shared/party-lab/simulation/layers/config";
import type { LayerPhase, LayerResult } from "../../../../shared/party-lab/simulation/layers/round";
import { LayerBot } from "./bots";
import { layerIntent, landingMarker } from "./controls";
import { LayerFall } from "./fall";
import { LayerChaosGame } from "./game";
import { clampLayerPitch, LAYER_CAMERA, LayerFollow, updateLayerCamera, type LayerCameraState } from "./layerCamera";
import { LayerTileVisuals } from "./tileVisuals";
import LayerSkyScenery from "./LayerSkyScenery";

/** What the React HUD shows; republished only when it changes. */
export interface LayerSnapshot {
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
}
/** Imperative per-frame DOM (no React re-renders). */
export interface LayerHudElements {
  debug: HTMLElement | null;
  banner: HTMLElement | null;
}
type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";

/** Seconds the camera stays on a fall that left the round before following someone else. */
const SPECTATE_HOLD = 1.2;
const SKY = "#cfdff0";
const PHASE_BANNERS: Record<SchedulePhase, string> = { normal: "", fast: "Hızlanıyor", collapse: "Çöküş" };

/** Soft sky, fog and a haze floor under the last layer; the background scenery is LayerSkyScenery. */
export function LayerEnvironment() {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(SKY, 38, 110);
    scene.background = new Color(SKY);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  return (
    <>
      <hemisphereLight args={["#fff6ea", "#8795b8", 1.7]} />
      <directionalLight position={[-8, 30, 12]} intensity={2.1} color="#fff1dc" />
      {/* Haze below the last layer: bodies sink out of sight before the fall line at −5 m. */}
      <mesh position={[0, -4.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[160, 48]} />
        <meshBasicMaterial color="#dbe6f3" />
      </mesh>
    </>
  );
}

/**
 * Local Katman Kaosu: 1 human + 2 simple bots on the four-layer tile field, with the
 * elevated chase camera, landing marker, spectating and a debug readout. Rooftop and
 * Barn keep their own Playground; nothing here is shared with them beyond the ragdoll.
 */
export default function LayerPlayground({
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
  onSnapshot: (snapshot: LayerSnapshot) => void;
  hud: MutableRefObject<LayerHudElements>;
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
  const game = useRef<LayerChaosGame | null>(null);
  const bots = useRef<LayerBot[]>([]);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const inputOff = paused || menuOpen;
  const inputOffNow = useRef(inputOff);
  inputOffNow.current = inputOff;
  const poses = useRef(
    PLAYERS.map(() => PARTS.map(() => ({ previous: new Vector3(), current: new Vector3(), previousQ: new Quaternion(), currentQ: new Quaternion() })))
  );
  const accumulator = useRef(0);
  const feel = useRef(new CameraFeel());
  const visuals = useMemo(() => new LayerTileVisuals(), []);
  useEffect(() => () => visuals.dispose(), [visuals]);
  const view = useRef({
    yaw: 0,
    pitch: LAYER_CAMERA.restPitch,
    follow: new LayerFollow(),
    camera: { drop: 0, boom: null } as LayerCameraState,
    spectating: null as PlayerId | null,
    boom: LAYER_CAMERA.boom as number,
    appliedPitch: LAYER_CAMERA.restPitch,
  });
  /** Per character, updated every tick: normal play (jumps included) or falling between layers. */
  const falls = useRef(PLAYERS.map(() => new LayerFall()));
  /** Presentation-only continuation of a fall past the elimination line (the body itself is frozen). */
  const ghosts = useRef(PLAYERS.map(() => ({ active: false, age: 0, v: new Vector3() })));
  const published = useRef({ revision: -1, spectating: null as PlayerId | null });
  const readout = useRef({ time: 0, frames: 0, simulationMs: 0, steps: 0, fps: 0, physicsMs: 0, hud: 0, phase: "normal" as SchedulePhase, marker: "none" });
  const time = useRef(0);
  const scratch = useRef({ pelvis: new Vector3(), velocity: new Vector3() });
  /**
   * Local debug aids, only with `?layerDebug=1`: P hands slot 0 to a bot (autopilot),
   * T skips the round clock 10 s ahead (armed tiles due in between vanish at once),
   * G hides/shows the background scenery (readability and cost A/B).
   */
  const tools = useMemo(() => new URLSearchParams(window.location.search).has("layerDebug"), []);
  const autopilot = useRef<LayerBot | null>(null);
  const scenery = useRef<Group>(null);

  const publish = (g: LayerChaosGame) => {
    const round = g.round;
    published.current = { revision: round.revision, spectating: view.current.spectating };
    onSnapshot({
      phase: round.phase,
      seconds: round.seconds,
      alive: [...round.alive],
      active: [...round.active],
      winner: round.winner,
      reason: round.reason,
      endedAt: round.endedAt / 60,
      spectating: view.current.spectating,
    });
  };
  const resetView = (g: LayerChaosGame) => {
    view.current.yaw = spawnYaw(g.physics.map, 0);
    view.current.pitch = LAYER_CAMERA.restPitch;
    view.current.follow.reset();
    view.current.camera = { drop: 0, boom: null };
    view.current.spectating = null;
    for (const player of g.physics.players) falls.current[player.id].reset(player.body.translation().y);
    ghosts.current.forEach((ghost) => (ghost.active = false));
    visuals.reset();
    visuals.setMarker({ kind: "none" }, 0);
    readout.current.phase = "normal";
  };
  const snapPoses = (g: LayerChaosGame) => {
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

  // Vertical FOV for the elevated chase camera.
  useEffect(() => {
    const perspective = camera as PerspectiveCamera,
      previous = perspective.fov;
    perspective.fov = LAYER_CAMERA.fov;
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
    // Clicks arrive on the Pointer Lock element (the viewport); the lock-acquiring click is look input.
    const lockSurface = gl.domElement.closest(".pl-viewport") as HTMLElement | null;
    const controls = bindKeyboard(
      gl.domElement,
      bindings,
      lockSurface ? { mouseSurface: lockSurface, claimMouse: (event) => look.current?.claimsClick(event) ?? false } : {}
    );
    controls.setSuspended(inputOffNow.current);
    keyboard.current = controls;
    // Spectating: Q / E cycle through the survivors.
    const cycle = (event: KeyboardEvent) => {
      const g = game.current;
      if (!g || inputOffNow.current || isUIInput(event.target)) return;
      if (tools && event.code === "KeyP") {
        autopilot.current = autopilot.current ? null : new LayerBot(0);
        return;
      }
      if (tools && event.code === "KeyT" && g.round.phase === "playing") {
        g.round.tick += 600;
        return;
      }
      if (tools && event.code === "KeyG") {
        if (scenery.current) scenery.current.visible = !scenery.current.visible;
        return;
      }
      if (event.code !== "KeyQ" && event.code !== "KeyE") return;
      if (g.round.alive[0]) return;
      const survivors = g.round.survivors;
      if (!survivors.length) return;
      const at = survivors.indexOf(view.current.spectating ?? (-1 as PlayerId));
      const step = event.code === "KeyE" ? 1 : -1;
      view.current.spectating = survivors[(at + step + survivors.length) % survivors.length];
      view.current.follow.blend = 0.5;
    };
    window.addEventListener("keydown", cycle);
    void initializePhysics()
      .then(() => {
        if (cancelled) return;
        const g = new LayerChaosGame(
          (event) => {
            audio.playSfx(event);
            feel.current.trigger(event);
          },
          { players }
        );
        game.current = g;
        bots.current = [new LayerBot(1), new LayerBot(2)];
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
      window.removeEventListener("keydown", cycle);
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
    v.yaw -= dx * LAYER_CAMERA.sensitivity;
    v.pitch = clampLayerPitch(v.pitch + dy * LAYER_CAMERA.sensitivity);
    time.current += delta;
    accumulator.current += Math.min(delta, 0.1);
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
      if (g.field.vanished.length) visuals.spawnDebris(g.field.vanished, time.current);
      for (const player of g.physics.players) {
        if (player.eliminated) continue;
        const at = player.body.translation();
        falls.current[player.id].update(g.field, at.x, at.y, at.z, player.body.linvel().y);
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
    const alpha = accumulator.current / PHYSICS.step;
    // ── Characters ──
    for (const player of g.physics.players) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const ghost = ghosts.current[player.id];
      if (ghost.active) ghost.age += delta;
      const falling = ghost.active && ghost.age < SPECTATE_HOLD;
      bean.visible = !player.eliminated || falling;
      if (!bean.visible) continue;
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
    }
    // ── Who the camera follows ──
    const round = g.round;
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
      focusBean = beans.current[focus],
      pelvis = scratch.current.pelvis;
    const focusNode = focusBean?.getObjectByName("pelvis");
    if (focusNode) pelvis.copy(focusNode.position);
    const focusPose = poses.current[focus][0];
    const velocity = scratch.current.velocity.copy(focusPose.current).sub(focusPose.previous).divideScalar(PHYSICS.step);
    const focusGhost = ghosts.current[focus];
    if (focusGhost.active) velocity.copy(focusGhost.v).setY(focusGhost.v.y + PHYSICS.gravity * focusGhost.age);
    // ── Landing marker (falling between layers only), camera ──
    const fall = falls.current[focus];
    const focusAlive = round.alive[focus] && !g.physics.players[focus].eliminated;
    const marker =
      focusAlive && round.phase === "playing" ? landingMarker(g.field, fall.falling, pelvis.x, pelvis.y, pelvis.z, velocity.y) : ({ kind: "none" } as const);
    // Falling, the landing point is far below the frame's centre: look part of the way down.
    // A body falling out sinks into the haze; the camera stops above it and watches.
    const landingY = marker.kind === "safe" ? g.field.tiles[marker.tile].top : marker.kind === "danger" ? marker.y : null;
    const pivot = v.follow.update(pelvis, fall, landingY, delta);
    const rig = updateLayerCamera(g.field, pivot, v.yaw, v.pitch, v.camera, delta);
    v.boom = rig.boom;
    v.appliedPitch = rig.pitch;
    camera.position.set(rig.position.x, rig.position.y, rig.position.z);
    camera.lookAt(pivot.x, pivot.y - v.follow.lookDrop, pivot.z);
    const [shakeX, shakeY] = feel.current.step(delta, shakeEnabled);
    // Measurement hook (`?layerDebug=1` and a harness-provided `window.__layerTrace` array only).
    const trace = tools ? (window as { __layerTrace?: unknown[] }).__layerTrace : undefined;
    if (trace) {
      const body = g.physics.players[focus],
        look = { x: pivot.x - rig.position.x, y: pivot.y - v.follow.lookDrop - rig.position.y, z: pivot.z - rig.position.z };
      trace.push({
        t: time.current,
        tick: round.tick,
        alpha,
        shownY: pelvis.y,
        hipY: body.body.translation().y,
        vy: body.body.linvel().y,
        grounded: g.physics.isGrounded(focus),
        jumpIn: body.jumpIn,
        layer: layerBelow(pelvis.y - 0.3),
        falling: fall.falling,
        marker: marker.kind,
        pivotY: pivot.y,
        camY: rig.position.y,
        lookPitch: (Math.atan2(-look.y, Math.hypot(look.x, look.z)) * 180) / Math.PI,
        orbitPitch: (rig.pitch * 180) / Math.PI,
        lookDrop: v.follow.lookDrop,
        boom: rig.boom,
        shakeY,
      });
    }
    camera.position.x += shakeX;
    camera.position.y += shakeY;
    const visTick = round.phase === "playing" ? Math.max(0, round.tick - 1 + alpha) : round.phase === "results" ? Math.max(0, round.endedAt) : 0;
    visuals.update(g.field, visTick, time.current, delta, focusAlive || focusGhost.active ? pelvis.y : null);
    visuals.setMarker(marker, time.current);
    readout.current.marker = marker.kind === "safe" ? `güvenli L${g.field.tiles[marker.tile].layer + 1}` : marker.kind === "danger" ? "tehlike" : "—";
    // ── Anti-stall announcements ──
    const phase = round.phase === "playing" ? schedulePhase(round.tick) : "normal";
    if (phase !== readout.current.phase) {
      readout.current.phase = phase;
      const banner = hud.current.banner;
      if (banner && PHASE_BANNERS[phase]) {
        banner.textContent = PHASE_BANNERS[phase];
        banner.getAnimations().forEach((a) => a.cancel());
        banner.animate(
          [
            { opacity: 0, transform: "translate(-50%, -8px) scale(0.96)" },
            { opacity: 1, transform: "translate(-50%, 0) scale(1)", offset: 0.12 },
            { opacity: 1, transform: "translate(-50%, 0) scale(1)", offset: 0.8 },
            { opacity: 0, transform: "translate(-50%, 0) scale(1)" },
          ],
          { duration: 2200, easing: "ease-out" }
        );
      }
    }
    if (published.current.revision !== round.revision || published.current.spectating !== v.spectating) publish(g);
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
    const counts = g.field.counts(visTick),
      layer = layerBelow(pelvis.y - 0.3),
      alive = round.survivors.length,
      tick = round.phase === "playing" ? round.tick : round.phase === "results" ? round.endedAt : 0;
    const collapse = collapseLabel(tick);
    const lines = [
      `Katman: ${layer === -1 ? "boşluk" : `L${layer + 1} ${LAYER_NAMES[layer]}`} · Hayatta: ${alive}/${g.players} · Süre: ${(tick / 60).toFixed(1)} sn`,
      `Karolar: sağlam ${counts.solid} · işaretli ${counts.marked} · uyarı ${counts.warn} · çatlak ${counts.crack} · kırık ${counts.break} · yok ${counts.gone}`,
      `Kırılma süresi: ${(breakTicks(tick) / 60).toFixed(2)} sn · Faz: ${collapse}`,
      `Konum: x ${pelvis.x.toFixed(2)} · y ${(pelvis.y - 0.78).toFixed(2)} (kalça ${pelvis.y.toFixed(2)}) · z ${pelvis.z.toFixed(2)} · iniş: ${r.marker} · düşüş: ${fall.falling ? "katmanlar arası" : "yok"}`,
      `Kamera: bom ${rig.boom.toFixed(2)} m · eğim ${Math.round((rig.pitch * 180) / Math.PI)}° (istenen ${Math.round((v.pitch * 180) / Math.PI)}°) · soluk: ${visuals.opacity.map((o) => o.toFixed(1)).join("/")}`,
      `${Math.round(r.fps)} FPS · ${r.physicsMs.toFixed(2)} ms fizik · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · çarpıştırıcı ${g.field.enabledColliders} karo + 27 gövde`,
      ...(tools
        ? [`Hata ayıklama: P otopilot (${autopilot.current ? "açık" : "kapalı"}) · T +10 sn · G manzara (${scenery.current?.visible === false ? "kapalı" : "açık"})`]
        : []),
    ];
    const debug = hud.current.debug;
    if (debug) {
      debug.textContent = lines.join("\n");
      debug.dataset.layers = JSON.stringify({
        phase: round.phase,
        tick,
        layer,
        alive: round.alive,
        counts,
        pos: [pelvis.x, pelvis.y - 0.78, pelvis.z].map((n) => Math.round(n * 100) / 100),
        spectating: v.spectating,
        focus,
        yaw: Math.round((v.yaw * 180) / Math.PI),
        me: (() => {
          const own = g.physics.players[0].body.translation();
          return { alive: round.alive[0], pos: [own.x, own.y - 0.78, own.z].map((n) => Math.round(n * 100) / 100), facing: Math.round((g.physics.players[0].facing * 180) / Math.PI) };
        })(),
        marker: marker.kind,
        falling: fall.falling,
        boom: Math.round(rig.boom * 100) / 100,
        pitch: Math.round((rig.pitch * 180) / Math.PI),
        fade: visuals.opacity.map((o) => Math.round(o * 100) / 100),
        breakTime: breakTicks(tick) / 60,
        schedule: phase,
        fps: Math.round(r.fps),
        physicsMs: Math.round(r.physicsMs * 1000) / 1000,
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        colliders: g.field.enabledColliders,
        stats: { ...g.field.stats, ...g.brawl.stats },
        winner: round.winner,
        reason: round.reason,
        autopilot: !!autopilot.current,
        scenery: scenery.current?.visible !== false,
        players: g.physics.players.map((c) => {
          const at = c.body.translation();
          return [at.x, at.y - 0.78, at.z].map((n) => Math.round(n * 100) / 100).concat(round.alive[c.id] ? 1 : 0);
        }),
      });
    }
  });

  return (
    <>
      <LayerEnvironment />
      <group ref={scenery} name="sky">
        <LayerSkyScenery />
      </group>
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

/** "Normal", "Hızlanıyor", or which layer/ring the collapse is on. */
function collapseLabel(tick: number) {
  const phase = schedulePhase(tick);
  if (phase === "normal") return `Normal (hızlanma ${Math.max(0, Math.ceil((LAYER_TICKS.fastAt - tick) / 60))} sn sonra)`;
  if (phase === "fast") return `Hızlanıyor (çöküş ${Math.max(0, Math.ceil((LAYER_TICKS.collapseAt - tick) / 60))} sn sonra)`;
  let layer = 0;
  for (let l = 0; l < LAYER_TICKS.layerStarts.length; l++) if (tick >= LAYER_TICKS.layerStarts[l]) layer = l;
  const rings = LAYER_OUTER_RING[layer] + 1,
    ring = Math.min(rings, Math.floor((tick - LAYER_TICKS.layerStarts[layer]) / LAYER_TICKS.ringInterval) + 1);
  return `Çöküş · L${layer + 1} halka ${ring}/${rings} · ${LAYER_CHAOS.collapse.ringInterval} sn arayla`;
}
