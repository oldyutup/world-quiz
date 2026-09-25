import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Fog, Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import { CameraFeel } from "../../audio/feel";
import type { Bindings } from "../../input/bindings";
import { isUIInput } from "../../input/device";
import { bindKeyboard } from "../../input/keyboard";
import type { LookController } from "../../input/look";
import PlayerBean from "../PlayerBean";
import { IDLE_INPUT, initializePhysics, PHYSICS } from "../physics";
import { PLAYERS, type PlayerId } from "../players";
import { PARTS } from "../ragdoll/config";
import { localCostumeForSlot, type SelectableCostumeId } from "../visual/costumes";
import { layerIntent } from "../layers/controls";
import { surfaceBelow } from "../../../../shared/party-lab/maps/bomb";
import { BOMB_TAG, BOMB_TICKS } from "../../../../shared/party-lab/simulation/bomb/config";
import type { BombPhase } from "../../../../shared/party-lab/simulation/bomb/rules";
import type { LayerPhase, LayerResult } from "../../../../shared/party-lab/simulation/layers/round";
import { buildBombArena } from "./arena";
import BombScenery from "./BombScenery";
import { BOMB_CAMERA, bombCameraBlockers, bombCameraPose, bombOwnOpacity, BombFollow, clampBombPitch } from "./bombCamera";
import { BombBot } from "./bots";
import { BombTagGame } from "./game";
import type { BombKit } from "./scenery";
import { BOMB_RED, BombVisuals, FUSE_PANIC, type CarrierView } from "./visuals";

/** What the React HUD shows; republished only when it changes. */
export interface BombSnapshot {
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
  /** Who holds the bomb (pending: the next carrier, fuse not lit yet). */
  carrier: PlayerId | null;
  bombPhase: BombPhase;
  /** Protected from the carrier (just passed it), or null. */
  immune: PlayerId | null;
  passes: number;
  blasts: number;
  /** Who each eliminated player went out to. */
  outBy: ("blast" | "fall" | null)[];
  /** The last blast's carrier (the gap's message). */
  lastBlast: PlayerId | null;
}
/** Imperative per-frame DOM (no React re-renders). */
export interface BombHudElements {
  debug: HTMLElement | null;
  fuse: HTMLElement | null;
  bar: HTMLElement | null;
  callout: HTMLElement | null;
  arrow: HTMLElement | null;
  vignette: HTMLElement | null;
}
type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";

/** Seconds the camera stays on a blown-up player before following someone else. */
const SPECTATE_HOLD = 1.4;
const SKY = "#cfe2f0";
/** The blast's knock on the camera within this distance of the followed body (m). */
const SHAKE_RANGE = 8;

/** Sky, fog, soft light and a haze floor under the roof. */
export function BombEnvironment() {
  const scene = useThree((state) => state.scene);
  const arena = useMemo(buildBombArena, []);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(SKY, 40, 120);
    scene.background = new Color(SKY);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  useEffect(() => () => arena.dispose(), [arena]);
  return (
    <>
      <hemisphereLight args={["#fffaf0", "#8f9bb0", 1.55]} />
      <directionalLight position={[-8, 22, 12]} intensity={2.1} color="#fff4e2" />
      <mesh position={[0, -4.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[170, 48]} />
        <meshBasicMaterial color="#e4edf3" />
      </mesh>
      <primitive object={arena.group} />
    </>
  );
}

/**
 * Local Bomba Sende: 1 human + 1–2 bots in the walled playground, with the chase camera,
 * the bomb over the carrier, spectating and a debug readout. Shared with the other modes:
 * the ragdoll, the shove punch and the round rules only.
 */
export default function BombPlayground({
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
  tools,
}: {
  players: 2 | 3;
  onStatus: (status: ArenaStatus) => void;
  onSnapshot: (snapshot: BombSnapshot) => void;
  hud: MutableRefObject<BombHudElements>;
  bindings: Bindings;
  /** The arena is hidden (lobby-level settings): the simulation stops. */
  paused: boolean;
  /** The Esc menu is open: only this player's input stops; the round and bots go on. */
  menuOpen: boolean;
  audio: AudioManager;
  shakeEnabled: boolean;
  costumeId: SelectableCostumeId;
  look: MutableRefObject<LookController | null>;
  /** `?bombDebug=1`: the debug keys (P autopilot, K fuse −5 s, B take the bomb, H hold the bots still, G scenery). */
  tools: boolean;
}) {
  const { camera, gl, size } = useThree();
  const beans = useRef<(Group | null)[]>([]);
  const game = useRef<BombTagGame | null>(null);
  const bots = useRef<BombBot[]>([]);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const inputOff = paused || menuOpen;
  const inputOffNow = useRef(inputOff);
  inputOffNow.current = inputOff;
  const bindingsNow = useRef(bindings);
  bindingsNow.current = bindings;
  const poses = useRef(
    PLAYERS.map(() => PARTS.map(() => ({ previous: new Vector3(), current: new Vector3(), previousQ: new Quaternion(), currentQ: new Quaternion() })))
  );
  const accumulator = useRef(0);
  const feel = useRef(new CameraFeel());
  const visuals = useMemo(() => new BombVisuals(), []);
  useEffect(() => () => visuals.dispose(), [visuals]);
  const blockers = useMemo(bombCameraBlockers, []);
  const view = useRef({
    yaw: 0,
    pitch: BOMB_CAMERA.restPitch as number,
    follow: new BombFollow(),
    boom: { boom: null as number | null },
    sprint: 0,
    fov: BOMB_CAMERA.fov as number,
    spectating: null as PlayerId | null,
    lastBoom: 0,
  });
  /** Presentation-only flight of a blown-up body (the body itself is retired). */
  const ghosts = useRef(PLAYERS.map(() => ({ active: false, age: 0, v: new Vector3(), spin: 0 })));
  const outBy = useRef<("blast" | "fall" | null)[]>(PLAYERS.map(() => null));
  const lastBlast = useRef<PlayerId | null>(null);
  const published = useRef({ key: "" });
  const readout = useRef({ time: 0, frames: 0, simulationMs: 0, steps: 0, fps: 0, physicsMs: 0, hud: 0 });
  const time = useRef(0);
  const scratch = useRef({
    pelvis: new Vector3(),
    head: new Vector3(),
    feet: new Vector3(),
    shield: new Vector3(),
    v: new Vector3(),
    carrierFeet: new Vector3(),
    slowFeet: PLAYERS.map(() => new Vector3()),
    slowed: PLAYERS.map((): Vector3 | null => null),
    slowLeft: PLAYERS.map(() => 0),
  });
  const autopilot = useRef<BombBot | null>(null);
  /** Debug H: the bots stand still (testing the tag range and geometry by hand). */
  const holdBots = useRef(false);
  const scenery = useRef<Group | null>(null);
  /** Local player's passes, landed punches and trap springs this session (debug readout). */
  const human = useRef({ passes: 0, hits: 0, received: 0, trapped: 0 });
  /** Trap springs this session by who was holding the lit bomb then (debug readout). */
  const trapLog = useRef({ carrier: 0, runner: 0, last: null as Record<string, unknown> | null });
  /** The last pass as it happened (debug readout): who, how, how far, and whether both sight lines were clear. */
  const lastPass = useRef<Record<string, unknown> | null>(null);
  const onKit = useCallback((kit: BombKit | null) => visuals.setKit(kit), [visuals]);

  const snapshotOf = (g: BombTagGame): BombSnapshot => ({
    phase: g.round.phase,
    seconds: g.round.seconds,
    alive: [...g.round.alive],
    active: [...g.round.active],
    winner: g.round.winner,
    reason: g.round.reason,
    endedAt: g.round.endedAt / 60,
    spectating: view.current.spectating,
    carrier: g.bomb.carrier,
    bombPhase: g.bomb.phase,
    immune: g.bomb.immuneTicks > 0 ? g.bomb.immune : null,
    passes: g.bomb.passes,
    blasts: g.bomb.blasts,
    outBy: [...outBy.current],
    lastBlast: lastBlast.current,
  });
  const publish = (g: BombTagGame) => {
    const b = g.bomb,
      key = `${g.round.revision}|${b.carrier}|${b.phase}|${b.immuneTicks > 0 ? b.immune : -1}|${view.current.spectating}|${b.passes}`;
    if (key === published.current.key) return;
    published.current.key = key;
    onSnapshot(snapshotOf(g));
  };
  const resetView = (g: BombTagGame) => {
    const own = g.physics.players[0].body.translation();
    view.current.yaw = Math.atan2(-own.x, -own.z);
    view.current.pitch = BOMB_CAMERA.restPitch;
    view.current.follow.reset();
    view.current.boom.boom = null;
    view.current.sprint = 0;
    view.current.spectating = null;
    ghosts.current.forEach((ghost) => (ghost.active = false));
    outBy.current.fill(null);
    lastBlast.current = null;
    visuals.clear();
  };
  const snapPoses = (g: BombTagGame) => {
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
  /** The big word over the arena ("BOMBA SENDE!", "KURTULDUN!", "BOOM!"); `small` for a quick hint. */
  const callout = (text: string, tone: "bomb" | "safe" | "boom" | "info" | "trap", small = false) => {
    const element = hud.current.callout;
    if (!element) return;
    element.textContent = text;
    element.dataset.tone = tone;
    element.dataset.small = small ? "true" : "false";
    element.getAnimations().forEach((a) => a.cancel());
    element.animate(
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.6)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1.08)", offset: 0.14 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.55 },
        { opacity: 0, transform: "translate(-50%, -120%) scale(0.8)" },
      ],
      { duration: small ? 900 : 1300, easing: "ease-out", fill: "forwards" }
    );
  };

  useEffect(() => {
    const perspective = camera as PerspectiveCamera,
      previous = perspective.fov;
    perspective.fov = BOMB_CAMERA.fov;
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
      // A debug key never shadows a gameplay binding (Punch is F by default).
      const debugKey = tools && !Object.values(bindingsNow.current).some((keys) => keys.includes(event.code as never));
      if (debugKey && event.code === "KeyP") {
        autopilot.current = autopilot.current ? null : new BombBot(0);
        autopilot.current?.reset();
        return;
      }
      if (debugKey && event.code === "KeyK") {
        if (g.bomb.phase === "armed") g.bomb.fuse = Math.max(1, g.bomb.fuse - 5 * 60);
        return;
      }
      if (debugKey && event.code === "KeyB") {
        // Take the lit bomb (a test pass from whoever has it).
        if (g.bomb.phase === "armed" && g.bomb.carrier !== null && g.bomb.carrier !== 0 && g.round.alive[0]) {
          g.bomb.carrier = 0;
          g.bomb.immune = null;
          g.bomb.immuneTicks = 0;
        }
        return;
      }
      if (debugKey && event.code === "KeyH") {
        holdBots.current = !holdBots.current;
        return;
      }
      if (debugKey && event.code === "KeyG") {
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
        const g = new BombTagGame(
          (event) => {
            audio.playSfx(event);
            feel.current.trigger(event);
          },
          { players }
        );
        game.current = g;
        // `?bombDebug=1` only: the running game for browser test harnesses (scenario set-up).
        if (tools) (window as unknown as { __bombGame?: BombTagGame }).__bombGame = g;
        bots.current = [new BombBot(1), new BombBot(2)];
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
      if (tools) delete (window as unknown as { __bombGame?: BombTagGame }).__bombGame;
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
    const v = view.current,
      s = scratch.current;
    const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
    v.yaw -= dx * BOMB_CAMERA.sensitivity;
    v.pitch = clampBombPitch(v.pitch + dy * BOMB_CAMERA.sensitivity);
    time.current += delta;
    accumulator.current += Math.min(delta, 0.1);
    while (accumulator.current >= PHYSICS.step) {
      for (const character of poses.current)
        for (const pose of character) {
          pose.previous.copy(pose.current);
          pose.previousQ.copy(pose.currentQ);
        }
      const own = layerIntent(controls.readIntent(), v.yaw);
      const held = holdBots.current;
      const inputs = [autopilot.current?.update(g) ?? own, held ? IDLE_INPUT : bots.current[0].update(g), held ? IDLE_INPUT : bots.current[1].update(g)];
      const start = performance.now();
      const event = g.step(inputs);
      readout.current.simulationMs += performance.now() - start;
      readout.current.steps++;
      if (event) controls.clear();
      for (const shove of g.brawl.shoves) if (shove.attacker === 0) human.current.hits++;
      // Trap springs first: a bomb callout on the same step wins over the trap's.
      for (const { trap, id } of g.sprung) {
        const lit = g.bomb.phase === "armed" && g.bomb.carrier === id;
        if (lit) trapLog.current.carrier++;
        else trapLog.current.runner++;
        if (tools) trapLog.current.last = { trap: trap.id, id, carrier: lit, tick: g.round.tick, fuse: Math.round((g.bomb.fuse / 60) * 100) / 100 };
        if (id === 0) {
          human.current.trapped++;
          callout("TUZAK! Yavaşladın", "trap", true);
        }
      }
      for (const e of g.events) {
        if (e.type === "pass") {
          const head = beans.current[e.from]?.getObjectByName("head");
          if (head) visuals.handOff(s.v.set(head.position.x, head.position.y + 0.3, head.position.z));
          if (tools) {
            const a = g.physics.players[e.from],
              b = g.physics.players[e.to],
              pa = a.body.translation(),
              pb = b.body.translation();
            lastPass.current = {
              from: e.from,
              to: e.to,
              via: e.via,
              reach: Math.round((e.reach ?? 0) * 100) / 100,
              dy: Math.round((pb.y - pa.y) * 100) / 100,
              fuse: Math.round((e.fuse / 60) * 100) / 100,
              at: [pa.x, pa.y - 0.78, pa.z].map((n) => Math.round(n * 100) / 100),
              sight: g.physics.clearPath(pa, pb) && g.physics.clearPath(a.parts.torso.body.translation(), b.parts.torso.body.translation()),
              tick: g.round.tick,
            };
          }
          if (e.from === 0) {
            human.current.passes++;
            callout("KURTULDUN!", "safe");
          } else if (e.to === 0) {
            human.current.received++;
            callout("BOMBA SENDE!", "bomb");
          }
        } else if (e.type === "armed") {
          if (e.carrier === 0) callout("BOMBA SENDE!", "bomb");
          else if (g.round.alive[0]) callout("KAÇ!", "info");
        } else if (e.type === "blast") {
          lastBlast.current = e.carrier;
          outBy.current[e.carrier] = "blast";
          callout("BOOM!", "boom");
        }
      }
      for (const refusal of g.refused) if (refusal.from === 0 && refusal.why === "tag-back") callout("Geri pas yok!", "info", true);
      if (g.blast) {
        const b = g.blast,
          at = s.v.set(b.x, b.y, b.z);
        visuals.explode(at, Math.max(0, surfaceBelow(b.x, b.z, b.y)));
        const focusId = v.spectating ?? 0,
          focus = g.physics.players[focusId].body.translation();
        if (b.carrier === 0 || Math.hypot(focus.x - b.x, focus.z - b.z) < SHAKE_RANGE) feel.current.trigger({ name: "bombBlast", actor: 0, intensity: 1 });
        const ghost = ghosts.current[b.carrier],
          a = Math.random() * Math.PI * 2;
        ghost.active = true;
        ghost.age = 0;
        ghost.v.set(Math.cos(a) * 2.2, 6.5, Math.sin(a) * 2.2);
        ghost.spin = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 4);
      }
      for (const id of g.eliminated) if (!outBy.current[id]) outBy.current[id] = "fall";
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
      if (event === "reset") {
        bots.current.forEach((bot) => bot.reset());
        autopilot.current?.reset();
        resetView(g);
      }
      accumulator.current -= PHYSICS.step;
    }
    const alpha = accumulator.current / PHYSICS.step;
    const round = g.round,
      bomb = g.bomb;
    // ── Characters, their shadows, the blown-up body's flight ──
    for (const player of g.physics.players) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const ghost = ghosts.current[player.id];
      if (ghost.active) ghost.age += delta;
      const flying = ghost.active && ghost.age < 0.9;
      bean.visible = !player.eliminated || flying;
      if (!bean.visible || !round.active[player.id]) {
        bean.visible = bean.visible && round.active[player.id];
        visuals.setShadow(player.id, null);
        continue;
      }
      const t = flying ? ghost.age : 0;
      PARTS.forEach((name, index) => {
        const node = bean.getObjectByName(name)!,
          pose = poses.current[player.id][index];
        node.position.lerpVectors(pose.previous, pose.current, flying ? 1 : alpha);
        node.quaternion.slerpQuaternions(pose.previousQ, pose.currentQ, flying ? 1 : alpha);
        if (flying) {
          node.position.x += ghost.v.x * t;
          node.position.y += ghost.v.y * t + 0.5 * PHYSICS.gravity * t * t;
          node.position.z += ghost.v.z * t;
          node.rotateY(ghost.spin * t);
        }
        // Blown away: the parts shrink to nothing over the flight (never falling back into the scorch).
        const scale = flying ? Math.max(0.01, 1 - (t / 0.9) ** 1.5) : 1;
        if (node.scale.x !== scale) node.scale.setScalar(scale);
        if (index === 0) {
          const material = (node.getObjectByName("skin") as Mesh).material as MeshStandardMaterial;
          material.emissiveIntensity = (g.brawl.fighters[player.id].flash / 0.15) * 0.7;
        }
      });
      const hips = bean.getObjectByName("pelvis")!.position,
        floor = surfaceBelow(hips.x, hips.z, hips.y);
      visuals.setShadow(player.id, !flying && Number.isFinite(floor) && hips.y - floor < 2.2 ? s.feet.set(hips.x, floor, hips.z) : null);
    }
    // ── The bomb, the carrier's ring, the protected player's ring ──
    const carrier = bomb.carrier;
    const carrierBean = carrier !== null && round.phase !== "results" && !g.physics.players[carrier].eliminated ? beans.current[carrier] : null;
    let carrierView: CarrierView | null = null;
    if (carrierBean) {
      const head = carrierBean.getObjectByName("head")!.position,
        hips = carrierBean.getObjectByName("pelvis")!.position,
        floor = surfaceBelow(hips.x, hips.z, hips.y);
      s.head.set(head.x, head.y + 0.3, head.z);
      s.carrierFeet.set(hips.x, Number.isFinite(floor) ? floor : hips.y - 0.78, hips.z);
      carrierView = { head: s.head, feet: s.carrierFeet, lit: bomb.phase === "armed", fuse: bomb.seconds };
    }
    const immune = bomb.immuneTicks > 0 ? bomb.immune : null;
    const immuneBean = immune !== null && round.alive[immune] ? beans.current[immune] : null;
    let shield: Vector3 | null = null;
    if (immuneBean) {
      const hips = immuneBean.getObjectByName("pelvis")!.position,
        floor = surfaceBelow(hips.x, hips.z, hips.y);
      shield = s.shield.set(hips.x, Number.isFinite(floor) ? floor : hips.y - 0.78, hips.z);
    }
    visuals.update(time.current, delta, carrierView, shield);
    // ── The traps, and a ring on everyone they slowed ──
    for (const player of g.physics.players) {
      const left = g.traps.slowed[player.id],
        bean = beans.current[player.id];
      s.slowed[player.id] = null;
      if (left <= 0 || !bean?.visible || player.eliminated || round.phase !== "playing") continue;
      const hips = bean.getObjectByName("pelvis")!.position,
        floor = surfaceBelow(hips.x, hips.z, hips.y);
      s.slowed[player.id] = s.slowFeet[player.id].set(hips.x, Number.isFinite(floor) ? floor : hips.y - 0.78, hips.z);
      s.slowLeft[player.id] = left / BOMB_TICKS.trapSlow;
    }
    visuals.updateTraps(time.current, delta, g.traps.traps, s.slowed, s.slowLeft);
    // ── Who the camera follows ──
    if (round.alive[0]) v.spectating = null;
    else if (round.active[0]) {
      const watching = v.spectating ?? 0,
        stillIn = round.alive[watching] && round.active[watching],
        ghost = ghosts.current[watching],
        done = !ghost.active || ghost.age >= SPECTATE_HOLD;
      const survivors = round.survivors;
      if (!stillIn && done && survivors.length) {
        const from = poses.current[watching][0].current;
        v.spectating = survivors.reduce((best, id) =>
          poses.current[id][0].current.distanceToSquared(from) < poses.current[best][0].current.distanceToSquared(from) ? id : best
        );
        v.follow.blend = 0.5;
      }
    }
    const focus = v.spectating ?? 0;
    const focusNode = beans.current[focus]?.getObjectByName("pelvis");
    const focusGhost = ghosts.current[focus];
    if (focusNode && !(focusGhost.active && focusGhost.age > 0)) s.pelvis.copy(focusNode.position);
    const focusBody = g.physics.players[focus];
    const vy = focusBody.eliminated ? 0 : focusBody.body.linvel().y;
    const pivot = v.follow.update(s.pelvis, vy, delta);
    v.sprint += ((focusBody.eliminated ? 0 : focusBody.sprint) - v.sprint) * (1 - Math.exp(-Math.min(delta, 0.1) / BOMB_CAMERA.sprintEase));
    const pose = bombCameraPose(blockers, pivot, v.yaw, v.pitch, v.sprint, v.boom, delta);
    v.lastBoom = pose.boom;
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.lookAt(pivot.x, pivot.y, pivot.z);
    const fov = BOMB_CAMERA.fov + BOMB_CAMERA.sprintFov * v.sprint;
    if (Math.abs(fov - v.fov) > 0.02) {
      v.fov = fov;
      const perspective = camera as PerspectiveCamera;
      perspective.fov = fov;
      perspective.updateProjectionMatrix();
    }
    const [shakeX, shakeY] = feel.current.step(delta, shakeEnabled);
    camera.position.x += shakeX;
    camera.position.y += shakeY;
    // Pressed against a wall, the camera is close to the body: fade it instead of filling the screen.
    const own = beans.current[focus],
      skin = (own?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
    if (skin) {
      const opacity = bombOwnOpacity(pose.boom),
        transparent = opacity < 0.999;
      if (skin.transparent !== transparent) {
        skin.transparent = transparent;
        skin.depthWrite = !transparent;
        skin.needsUpdate = true;
      }
      skin.opacity = opacity;
    }
    // ── Fuse timer, the carrier arrow, the panic vignette (per frame, no React) ──
    const playing = round.phase === "playing";
    const lit = playing && bomb.phase === "armed";
    const { fuse, bar, arrow, vignette } = hud.current;
    const secondsLeft = bomb.seconds;
    if (fuse) fuse.textContent = lit ? secondsLeft.toFixed(1) : playing && bomb.carrier !== null && bomb.gapLeft > 0 ? secondsLeft.toFixed(1) : "";
    if (bar) bar.style.transform = `scaleX(${lit ? secondsLeft / BOMB_TAG.fuse : 0})`;
    if (fuse?.parentElement) fuse.parentElement.dataset.panic = lit && secondsLeft <= FUSE_PANIC ? "true" : "false";
    const mine = lit && bomb.carrier === 0 && round.alive[0];
    if (vignette) {
      const panic = mine ? Math.max(0, (FUSE_PANIC + 2 - secondsLeft) / (FUSE_PANIC + 2)) : 0;
      vignette.style.opacity = mine ? (0.25 + 0.55 * panic * (0.5 + 0.5 * Math.sin(time.current * (6 + 10 * panic)))).toFixed(3) : "0";
    }
    if (arrow) {
      // Off-screen pointer: toward the carrier (you run from it) or, holding it yourself, the nearest rival.
      let target: PlayerId | null = null;
      if (playing && round.alive[focus] && bomb.carrier !== null) {
        if (bomb.carrier !== focus) target = bomb.carrier;
        else {
          const at = g.physics.players[focus].body.translation();
          let best = Infinity;
          for (const id of round.survivors) {
            if (id === focus) continue;
            const p = g.physics.players[id].body.translation(),
              d = Math.hypot(p.x - at.x, p.z - at.z);
            if (d < best) {
              best = d;
              target = id;
            }
          }
        }
      }
      const node = target !== null ? beans.current[target]?.getObjectByName("head") : null;
      let shown = false;
      if (node) {
        const p = s.v.copy(node.position).project(camera);
        const behind = p.z > 1;
        let nx = behind ? -p.x : p.x,
          ny = behind ? -p.y : p.y;
        if (behind || Math.abs(nx) > 0.94 || Math.abs(ny) > 0.9) {
          const k = Math.max(Math.abs(nx) / 0.86, Math.abs(ny) / 0.8, 1e-6);
          nx /= k;
          ny /= k;
          const x = ((nx + 1) / 2) * size.width,
            y = ((1 - ny) / 2) * size.height,
            angle = Math.atan2(-ny, nx);
          arrow.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
          arrow.style.setProperty("--angle", `${angle.toFixed(3)}rad`);
          arrow.dataset.kind = target === bomb.carrier ? "bomb" : "target";
          arrow.style.color = target === bomb.carrier ? BOMB_RED : PLAYERS[target!].color;
          shown = true;
        }
      }
      if (arrow.dataset.shown !== String(shown)) arrow.dataset.shown = String(shown);
    }
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
    const debug = hud.current.debug;
    if (!debug) return;
    const me = g.physics.players[0].body.translation(),
      round2 = (n: number) => Math.round(n * 100) / 100,
      name = (id: PlayerId | null) => (id === null ? "—" : PLAYERS[id].label);
    const lines = [
      `Bomba: ${name(bomb.carrier)} · ${bomb.phase === "armed" ? `fitil ${secondsLeft.toFixed(1)} sn` : bomb.gapLeft > 0 ? `yeni fitil ${secondsLeft.toFixed(1)} sn` : "bekliyor"} · koruma ${immune === null ? "—" : `${name(immune)} ${(bomb.immuneTicks / 60).toFixed(2)} sn`}`,
      `Tur: ${round.phase} · ${(playing ? round.tick / 60 : 0).toFixed(1)} sn · pas ${bomb.passes} · patlama ${bomb.blasts} · hayatta ${round.survivors.length}/${g.players}`,
      `Botlar: ${bots.current.map((b) => `${name(b.id)} ${b.mode}`).join(" · ")}${autopilot.current ? ` · otopilot ${autopilot.current.mode}` : ""}`,
      `Tuzaklar: ${g.traps.traps.map((t) => (t.armed ? "kurulu" : `${(t.rearmIn / 60).toFixed(1)} sn`)).join(" · ")} · yavaş ${PLAYERS.filter((p) => g.traps.slowed[p.id] > 0).map((p) => p.label).join(", ") || "—"} · yakalanan: taşıyıcı ${trapLog.current.carrier} · kaçan ${trapLog.current.runner}`,
      `Konum: x ${me.x.toFixed(2)} · y ${(me.y - 0.78).toFixed(2)} · z ${me.z.toFixed(2)} · kamera ${pose.boom.toFixed(1)} m · eğim ${Math.round((v.pitch * 180) / Math.PI)}° · koşu ${v.sprint.toFixed(2)}`,
      `${Math.round(r.fps)} FPS · ${r.physicsMs.toFixed(2)} ms fizik · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · ${g.physics.map.colliders.length} statik`,
      ...(tools ? [`Hata ayıklama: P otopilot (${autopilot.current ? "açık" : "kapalı"}) · K fitil −5 sn · B bombayı al · H botlar ${holdBots.current ? "duruyor" : "oynuyor"} · G dekor (${scenery.current?.visible === false ? "kapalı" : "açık"})`] : []),
    ];
    debug.textContent = lines.join("\n");
    debug.dataset.bomb = JSON.stringify({
      phase: round.phase,
      tick: playing ? round.tick : 0,
      carrier: bomb.carrier,
      bombPhase: bomb.phase,
      fuse: round2(secondsLeft),
      immune,
      passes: bomb.passes,
      blasts: bomb.blasts,
      alive: round.alive,
      active: round.active,
      me: { alive: round.alive[0], pos: [me.x, me.y - 0.78, me.z].map(round2) },
      players: g.physics.players.map((c) => {
        const at = c.body.translation();
        return [at.x, at.y - 0.78, at.z].map(round2).concat(round.alive[c.id] ? 1 : 0);
      }),
      bots: bots.current.map((b) => b.mode),
      spectating: v.spectating,
      focus,
      yaw: Math.round((v.yaw * 180) / Math.PI),
      pitch: Math.round((v.pitch * 180) / Math.PI),
      boom: round2(pose.boom),
      sprint: round2(v.sprint),
      fps: Math.round(r.fps),
      physicsMs: Math.round(r.physicsMs * 1000) / 1000,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      human: human.current,
      lastPass: lastPass.current,
      tags: g.tags,
      traps: g.traps.traps.map((t) => [t.armed ? 1 : 0, round2(t.rearmIn / 60)]),
      slowed: g.traps.slowed.map((n) => round2(n / 60)),
      springs: g.traps.springs,
      trapLog: trapLog.current,
      winner: round.winner,
      reason: round.reason,
      endedAt: round.endedAt,
      autopilot: !!autopilot.current,
      holdBots: holdBots.current,
      scenery: scenery.current?.visible !== false,
    });
  });

  return (
    <>
      <BombEnvironment />
      <group ref={scenery} name="bomb-kit">
        <BombScenery onKit={onKit} />
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
