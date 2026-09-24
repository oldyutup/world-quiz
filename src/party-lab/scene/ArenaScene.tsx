import { usePartyAudio } from "../audio/PartyAudio";
import type { AudioManager } from "../audio/AudioManager";
import { CameraFeel } from "../audio/feel";
import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from "react";
import RAPIER from "@dimforge/rapier3d-compat";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Euler,
  Vector3,
  Quaternion,
  type Group,
  type Mesh,
  type MeshStandardMaterial,
  type PerspectiveCamera,
} from "three";
import { bindKeyboard } from "../input/keyboard";
import Arena from "./Arena";
import { ACTION_LABELS, ACTIONS, BARN_ACTION_LABELS } from "../input/actions";
import { actionBindingLabel, type Bindings } from "../input/bindings";
import PlayerBean from "./PlayerBean";
import { localCostumeForSlot, type SelectableCostumeId } from "./visual/costumes";
import { PARTS } from "./ragdoll/config";
import { COMBAT } from "./combatConfig";
import { initializePhysics, PHYSICS } from "./physics";
import { LocalRoundSimulation } from "./localRound";
import { PLAYERS } from "./players";
import type { RoundSnapshot } from "./roundLogic";
import {
  ARENA_MAP_IDS,
  arenaMap,
  DEFAULT_ARENA_MAP_ID,
  spawnYaw,
  type ArenaMapId,
} from "../../../shared/party-lab/maps";
import {
  BARN_CAMERA,
  barnCameraBlockers,
  clampPitch,
  ownCharacterOpacity,
  smoothing,
  updateChaseCamera,
} from "./arenas/barnCamera";
import { barnIntent } from "./arenas/barnControls";
import {
  bindLook,
  loadLookMode,
  saveLookMode,
  type LookController,
  type LookMode,
  type LookStatus,
} from "../input/look";
import type { ActionIntent } from "../input/actions";
import { BarnBridge, HELD_SCALE, MUZZLE, type HeldView } from "./arenas/barnView";
import { BARN_COMBAT } from "../../../shared/party-lab/simulation/barn/config";
import type { BarnHit, BarnNotice, BarnShot } from "../../../shared/party-lab/simulation/barn/combat";
import { GRIP, HIT_GLOW, PUNCH_GLOW, SHIELD_GLOW, UP, VIEW_KICK, WEAPON_NAMES } from "./arenas/barnPresentation";
import LayerPlayground, { type LayerHudElements, type LayerSnapshot } from "./layers/LayerPlayground";
import LayerHud from "./layers/LayerHud";
import { LAYER_CHAOS } from "../../../shared/party-lab/simulation/layers/config";
import { ArenaMenu, ControlHint, MenuButton, useArenaMenu, useDebugPanel } from "./ArenaChrome";
import { controlHint } from "./arenaMenu";

/**
 * What the local arena can open: every shared static map, plus Katman Kaosu's tile
 * field (also an online mode; the local arena adds bots and debug tools, see scene/layers/).
 */
type LocalArenaId = ArenaMapId | "layers";
const LOCAL_ARENA_IDS: readonly LocalArenaId[] = [...ARENA_MAP_IDS, "layers"];
const localArenaName = (id: LocalArenaId) => (id === "layers" ? LAYER_CHAOS.label : arenaMap(id).name);
/**
 * Katman Kaosu opens immersive, like the online arenas (ArenaChrome): the arena fills the
 * page, only gameplay HUD sits on it, and settings, map and player count move into the
 * Esc menu. The other local test maps keep the header/footer test layout.
 */
const IMMERSIVE_MAPS: ReadonlySet<LocalArenaId> = new Set(["layers"]);
/** `?layerDebug=1` / `?partyDebug=1`: Katman Kaosu's debug readout starts open. */
const debugAtStart = () => {
  const query = new URLSearchParams(window.location.search);
  return query.has("layerDebug") || query.has("partyDebug");
};
/** Maps that run untimed with standing dummies instead of bots and the rooftop round. */
const EXPLORE_MAPS: ReadonlySet<LocalArenaId> = new Set(["barn"]);
/** Maps whose local test runs Barn Shootout combat (health, weapons, traps, respawn). */
const BARN_COMBAT_MAPS: ReadonlySet<LocalArenaId> = new Set(["barn"]);

type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";
interface BarnHudElements {
  crosshair: HTMLElement | null;
  hp: HTMLElement | null;
  hpBar: HTMLElement | null;
  weapon: HTMLElement | null;
  ammo: HTMLElement | null;
  status: HTMLElement | null;
  hitmarker: HTMLElement | null;
  vignette: HTMLElement | null;
  death: HTMLElement | null;
  deathTime: HTMLElement | null;
}
interface CombatHudElements {
  labels: (HTMLSpanElement | null)[];
  meters: (HTMLProgressElement | null)[];
  hint: HTMLDivElement | null;
  performance: HTMLSpanElement | null;
  barn: BarnHudElements;
}
/** Restartable one-shot CSS feedback (no React state). */
function flash(element: HTMLElement | null, frames: Keyframe[], duration: number) {
  element?.getAnimations().forEach((a) => a.cancel());
  element?.animate(frames, { duration, easing: "ease-out" });
}
const setText = (element: HTMLElement | null, cache: Record<string, string>, key: string, text: string) => {
  if (cache[key] === text) return;
  cache[key] = text;
  if (element) element.textContent = text;
};
/** Local player's Barn HUD, per frame but only touching the DOM when a value changes. */
function updateBarnHud(combat: NonNullable<LocalRoundSimulation["barn"]>, el: BarnHudElements, cache: Record<string, string>) {
  const me = combat.fighters[0];
  const hp = Math.ceil(me.hp);
  setText(el.hp, cache, "hp", String(hp));
  const bar = `${hp}`;
  if (cache.bar !== bar && el.hpBar) {
    el.hpBar.style.setProperty("--hp", `${hp}%`);
    el.hpBar.dataset.low = hp <= 30 ? "true" : "false";
  }
  cache.bar = bar;
  setText(el.weapon, cache, "weapon", me.weapon ? WEAPON_NAMES[me.weapon.kind] : "Silah yok");
  setText(
    el.ammo,
    cache,
    "ammo",
    me.weapon ? `${me.weapon.ammo} ${"●".repeat(me.weapon.ammo)}${"○".repeat(BARN_COMBAT[me.weapon.kind].ammo - me.weapon.ammo)}` : "Yumruk"
  );
  setText(
    el.status,
    cache,
    "status",
    !me.alive ? "" : me.trapped > 0 ? `Ayı kapanı · ${me.trapped.toFixed(1)} sn` : me.protection > 0 ? "Doğuş koruması" : ""
  );
  const dead = me.alive ? "" : "dead";
  if (cache.dead !== dead && el.death) el.death.hidden = me.alive;
  cache.dead = dead;
  if (!me.alive) setText(el.deathTime, cache, "deathTime", `${Math.max(0, BARN_COMBAT.death.respawn - me.deadFor).toFixed(1)} sn içinde yeniden doğacaksın`);
}

class SceneBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? (
      <div className="pl-scene-notice" role="alert">
        Arena açılamadı. WebGL 2 destekli bir tarayıcıda tekrar dene.
      </div>
    ) : (
      this.props.children
    );
  }
}

function Playground({
  onStatus,
  onRound,
  hud,
  bindings,
  paused,
  audio,
  shakeEnabled,
  costumeId,
  mapId,
  look,
}: {
  mapId: ArenaMapId;
  /** Barn only: mouse/trackpad look deltas for the chase camera. */
  look: MutableRefObject<LookController | null>;
  onStatus: (status: ArenaStatus) => void;
  onRound: (snapshot: RoundSnapshot) => void;
  hud: MutableRefObject<CombatHudElements>;
  bindings: Bindings;
  paused: boolean;
  audio: AudioManager;
  shakeEnabled: boolean;
  costumeId: SelectableCostumeId;
}) {
  const beans = useRef<(Group | null)[]>([]);
  const simulation = useRef<LocalRoundSimulation | null>(null);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const poses = useRef(
    PLAYERS.map(() =>
      PARTS.map(() => ({
        previous: new Vector3(),
        current: new Vector3(),
        previousQ: new Quaternion(),
        currentQ: new Quaternion(),
      }))
    )
  );
  const accumulator = useRef(0);
  const publishedRevision = useRef(-1);
  const { camera, size, gl } = useThree();
  const hudTime = useRef(0);
  const cameraBase = useRef(new Vector3());
  const feel = useRef(new CameraFeel());
  const barn = mapId === "barn";
  // Barn chase camera: aim yaw/pitch (also the body's facing), smoothed pivot, eased boom.
  const aim = useRef({ yaw: 0, pitch: BARN_CAMERA.restPitch });
  const pivot = useRef<Vector3 | null>(null);
  const boom = useRef<number | null>(null);
  const blockers = useMemo(() => (barn ? barnCameraBlockers(arenaMap(mapId)) : []), [barn, mapId]);
  const aimMarker = useRef<Mesh>(null);
  const aimRay = useRef(new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
  const ownColliders = useRef(new Set<number>());
  const cameraReadout = useRef({ boom: 0, aim: -1, on: -1 });
  const colliderOwner = useRef(new Map<number, number>());
  /** What the crosshair's line meets (presentation: the held weapon points at it). */
  const crosshair = useRef({ point: new Vector3(), hit: false });
  const performanceSample = useRef({
    time: 0,
    frames: 0,
    simulationMs: 0,
    steps: 0,
    rays: 0,
    rayMs: 0,
  });
  // Barn combat presentation: per-frame bridge, what the steps produced, aim-line point, recoil.
  const bridge = useMemo(() => (BARN_COMBAT_MAPS.has(mapId) ? new BarnBridge() : undefined), [mapId]);
  const produced = useRef<{ shots: BarnShot[]; hits: BarnHit[]; notices: BarnNotice[] }>({ shots: [], hits: [], notices: [] });
  const eye = useRef<{ x: number; y: number; z: number } | null>(null);
  const viewKick = useRef(0);
  const held = useRef<HeldView[]>(PLAYERS.map(() => ({ kind: null, grip: new Vector3(), aim: new Quaternion(), kick: 0 })));
  const barnHudCache = useRef({ hp: "", bar: "", weapon: "", ammo: "", status: "", dead: "", deathTime: "" });
  const scratch = useRef({ euler: new Euler(0, 0, 0, "YXZ"), q: new Quaternion(), v: new Vector3() });

  useEffect(() => {
    if (barn) return; // The barn's chase camera is placed every frame (see useFrame).
    const perspective = camera as PerspectiveCamera;
    const distance = Math.max(1, 1.5 / (size.width / Math.max(1, size.height)));
    perspective.position.set(0, 12 * distance, 14 * distance);
    perspective.lookAt(0, 0, 0);
    cameraBase.current.copy(perspective.position);
    perspective.updateProjectionMatrix();
  }, [camera, size.width, size.height, barn]);

  useEffect(() => {
    if (!barn) return;
    const perspective = camera as PerspectiveCamera,
      previousFov = perspective.fov;
    perspective.fov = BARN_CAMERA.fov;
    perspective.updateProjectionMatrix();
    return () => {
      perspective.fov = previousFov;
      perspective.updateProjectionMatrix();
    };
  }, [camera, barn]);

  useLayoutEffect(() => {
    keyboard.current?.setBindings(bindings);
    keyboard.current?.setSuspended(paused);
    if (paused) { simulation.current?.combat.stop(); audio.stopAll(); feel.current.clear(); }
  }, [bindings, paused]);

  useEffect(() => {
    let cancelled = false;
    // Barn: gameplay clicks arrive on the Pointer Lock element (the viewport) and the
    // lock-acquiring click is look input, never a punch or a shot.
    const lockSurface = barn ? (gl.domElement.closest(".pl-viewport") as HTMLElement | null) : null;
    const controls = bindKeyboard(
      gl.domElement,
      bindings,
      lockSurface ? { mouseSurface: lockSurface, claimMouse: (event) => look.current?.claimsClick(event) ?? false } : {}
    );
    controls.setSuspended(paused);
    keyboard.current = controls;
    void initializePhysics()
      .then(() => {
        if (cancelled) return;
        const local = new LocalRoundSimulation(Math.random, event => { audio.playSfx(event); feel.current.trigger(event); }, arenaMap(mapId), {
          explore: EXPLORE_MAPS.has(mapId),
          barnCombat: BARN_COMBAT_MAPS.has(mapId),
        });
        simulation.current = local;
        accumulator.current = 0;
        aim.current = { yaw: spawnYaw(local.map, 0), pitch: BARN_CAMERA.restPitch };
        pivot.current = null;
        boom.current = null;
        eye.current = null;
        viewKick.current = 0;
        ownColliders.current = new Set(Object.values(local.physics.players[0].parts).map((part) => part.collider.handle));
        colliderOwner.current = new Map(local.physics.players.flatMap((c) => Object.values(c.parts).map((part) => [part.collider.handle, c.id] as const)));
        for (const player of local.physics.players) {
          PARTS.forEach((name, index) => {
            const pose = poses.current[player.id][index],
              body = player.parts[name].body;
            pose.current.copy(body.translation());
            pose.previous.copy(pose.current);
            pose.currentQ.copy(body.rotation());
            pose.previousQ.copy(pose.currentQ);
          });
        }
        publishedRevision.current = local.round.revision;
        onRound(local.round.snapshot());
        onStatus("ready");
      })
      .catch(() => {
        if (!cancelled) onStatus("error");
      });
    return () => {
      cancelled = true;
      audio.stopAll();
      feel.current.clear();
      camera.position.copy(cameraBase.current);
      controls.dispose();
      keyboard.current = null;
      simulation.current?.dispose();
      simulation.current = null;
    };
  }, [onStatus, onRound, gl, audio, mapId]);

  useFrame((frame, delta) => {
    const local = simulation.current;
    const controls = keyboard.current;
    if (!local || !controls) return;
    camera.position.copy(cameraBase.current);
    // Never try to catch up minutes of physics after a hidden tab or debugger pause.
    if (paused || document.hidden || delta > 0.25) {
      accumulator.current = 0;
      controls.clear();
      feel.current.clear();
      return;
    }
    if (barn) {
      const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
      aim.current.yaw -= dx * BARN_CAMERA.sensitivity;
      aim.current.pitch = clampPitch(aim.current.pitch + dy * BARN_CAMERA.sensitivity);
    }
    // Barn: WASD relative to the camera, body facing the aim (strafe/backpedal), Lift binding =
    // sprint, Punch binding = contextual attack (held: automatic fire), Grab binding = pick up.
    const read = (): ActionIntent | ReturnType<typeof barnIntent> => {
      if (!barn) return controls.readIntent();
      const attackHeld = controls.manager.isActionDown("punch"),
        pickup = controls.manager.wasActionPressed("grab");
      return barnIntent(controls.readIntent(), aim.current.yaw, { attackHeld, pickup, aimPitch: aim.current.pitch, aimEye: eye.current ?? undefined });
    };
    const out = produced.current;
    out.shots.length = out.hits.length = out.notices.length = 0;
    accumulator.current += Math.min(delta, 0.1);
    while (accumulator.current >= PHYSICS.step) {
      for (const character of poses.current)
        for (const pose of character) {
          pose.previous.copy(pose.current);
          pose.previousQ.copy(pose.currentQ);
        }
      const start = performance.now();
      const event = local.step(read());
      performanceSample.current.simulationMs += performance.now() - start;
      if (local.barn) {
        // Fresh objects per step: keep them for this frame's presentation.
        out.shots.push(...local.barn.shots);
        out.hits.push(...local.barn.hits);
        out.notices.push(...local.barn.notices);
      }
      performanceSample.current.steps++;
      if (event) controls.clear();
      for (const player of local.physics.players) {
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
      }
      if (publishedRevision.current !== local.round.revision) {
        publishedRevision.current = local.round.revision;
        onRound(local.round.snapshot());
      }
      accumulator.current -= PHYSICS.step;
    }
    const barnCombat = local.barn;
    if (barnCombat) {
      for (const notice of out.notices)
        if (notice.type === "respawn" && notice.id === 0) {
          // Back on a spawn: look the way it faces and snap the camera there.
          aim.current = { yaw: barnCombat.fighters[0].home.yaw, pitch: BARN_CAMERA.restPitch };
          pivot.current = null;
          boom.current = null;
          eye.current = null;
        }
      for (const shot of out.shots) {
        held.current[shot.shooter].kick = 1;
        if (shot.shooter === 0) viewKick.current = Math.min(0.06, viewKick.current + VIEW_KICK[shot.kind]);
      }
      const hudBarn = hud.current.barn;
      for (const hit of out.hits) {
        if (hit.attacker === 0 && hit.target !== 0) {
          hudBarn.hitmarker?.classList.toggle("pl-hitmarker-kill", hit.killed);
          flash(hudBarn.hitmarker, [{ opacity: 1, transform: "translate(-50%, -50%) scale(1.3)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(1)" }], hit.killed ? 420 : 220);
        }
        if (hit.target === 0)
          flash(hudBarn.vignette, [{ opacity: Math.min(1, 0.35 + hit.damage / 60) }, { opacity: 0 }], hit.killed ? 900 : 450);
      }
    }
    for (const player of local.physics.players) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      bean.visible = !player.eliminated;
      const combat = local.combat.players[player.id];
      const fighter = barnCombat?.fighters[player.id];
      PARTS.forEach((name, index) => {
        const node = bean.getObjectByName(name)!,
          pose = poses.current[player.id][index];
        node.position.lerpVectors(
          pose.previous,
          pose.current,
          accumulator.current / PHYSICS.step
        );
        node.quaternion.slerpQuaternions(
          pose.previousQ,
          pose.currentQ,
          accumulator.current / PHYSICS.step
        );
        const mesh = node.getObjectByName("skin") as Mesh;
        const material = mesh.material as MeshStandardMaterial;
        if (!fighter)
          material.emissiveIntensity =
            (combat.flash / COMBAT.punch.flash) * 0.7;
        else if (index === 0) {
          // One material per character: red on a hit, a pale shimmer while spawn-protected.
          const hit = fighter.flash > 0,
            shielded = fighter.alive && fighter.protection > 0;
          material.emissive.copy(hit ? HIT_GLOW : shielded ? SHIELD_GLOW : PUNCH_GLOW);
          material.emissiveIntensity = hit ? (fighter.flash / 0.15) * 0.9 : shielded ? 0.3 + 0.2 * Math.sin(frame.clock.elapsedTime * 16) : 0;
        }
      });
      const stars = bean.getObjectByName("stars")!;
      stars.visible =
        combat.condition.state === "KNOCKED_OUT" ||
        combat.condition.state === "DAZED";
      stars.rotation.y = frame.clock.elapsedTime * 3;
    }
    const own = beans.current[0];
    const pelvisNode = barn ? own?.getObjectByName("pelvis") : undefined;
    if (own && pelvisNode) {
      const p = pelvisNode.position;
      if (!pivot.current) pivot.current = new Vector3(p.x, p.y + BARN_CAMERA.pivotHeight, p.z);
      else {
        const kxz = smoothing(delta, BARN_CAMERA.followXZ),
          ky = smoothing(delta, BARN_CAMERA.followY);
        pivot.current.x += (p.x - pivot.current.x) * kxz;
        pivot.current.z += (p.z - pivot.current.z) * kxz;
        pivot.current.y += (p.y + BARN_CAMERA.pivotHeight - pivot.current.y) * ky;
      }
      const rig = updateChaseCamera(blockers, pivot.current, aim.current.yaw, aim.current.pitch, boom.current, delta);
      boom.current = rig.boom;
      cameraBase.current.set(rig.position.x, rig.position.y, rig.position.z);
      camera.position.copy(cameraBase.current);
      camera.lookAt(rig.position.x + rig.look.x, rig.position.y + rig.look.y, rig.position.z + rig.look.z);
      if (barnCombat) {
        // Shots kick the view up briefly; the aim (and what the next shot hits) does not move.
        camera.rotateX(viewKick.current);
        viewKick.current *= Math.exp(-delta / 0.07);
        // The crosshair's line, as a point near the shoulder relative to the pelvis: the
        // simulation fires along the camera's own line (it bounds how far this may be).
        const look = rig.look,
          t = Math.max(0, (pivot.current.x - rig.position.x) * look.x + (pivot.current.y - rig.position.y) * look.y + (pivot.current.z - rig.position.z) * look.z);
        eye.current = {
          x: rig.position.x + look.x * t - p.x,
          y: rig.position.y + look.y * t - p.y,
          z: rig.position.z + look.z * t - p.z,
        };
      }
      // Pressed against a wall, the camera is close to the body: fade it instead of filling the screen.
      const skin = (own.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
      if (skin) {
        const opacity = ownCharacterOpacity(rig.boom),
          transparent = opacity < 0.999;
        if (skin.transparent !== transparent) {
          skin.transparent = transparent;
          skin.depthWrite = !transparent;
          skin.needsUpdate = true;
        }
        skin.opacity = opacity;
      }
      // Temporary aim debug: where the centre of the screen points (own body ignored).
      const ray = aimRay.current;
      ray.origin = rig.position;
      ray.dir = rig.look;
      const hit = local.physics.world.castRay(ray, 80, true, undefined, undefined, undefined, undefined, (c) => !ownColliders.current.has(c.handle));
      const marker = aimMarker.current;
      if (marker) {
        marker.visible = !!hit;
        if (hit) marker.position.set(rig.position.x + rig.look.x * hit.timeOfImpact, rig.position.y + rig.look.y * hit.timeOfImpact, rig.position.z + rig.look.z * hit.timeOfImpact);
      }
      cameraReadout.current = { boom: rig.boom, aim: hit ? hit.timeOfImpact - rig.boom : -1, on: hit ? colliderOwner.current.get(hit.collider.handle) ?? -1 : -1 };
      crosshair.current.hit = !!hit;
      if (hit) crosshair.current.point.set(rig.position.x + rig.look.x * hit.timeOfImpact, rig.position.y + rig.look.y * hit.timeOfImpact, rig.position.z + rig.look.z * hit.timeOfImpact);
      // Armed: warn when cover in front of the body would stop the shot although the
      // camera sees past it (shots leave the torso toward the crosshair's point).
      const barnHudCrosshair = hud.current.barn.crosshair;
      if (barnHudCrosshair && local.barn) {
        const me = local.barn.fighters[0],
          from = local.physics.players[0].parts.torso.body.translation(),
          to = crosshair.current.point,
          gap = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z),
          k = Math.max(0, gap - 0.15) / Math.max(gap, 1e-6);
        const blocked =
          !!me.alive && !!me.weapon && crosshair.current.hit && gap > 0.5 &&
          !local.physics.clearPath(from, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k });
        const flag = blocked ? "true" : "false";
        if (barnHudCrosshair.dataset.blocked !== flag) barnHudCrosshair.dataset.blocked = flag;
      }
    }
    const [shakeX, shakeY] = feel.current.step(delta, shakeEnabled);
    camera.position.x += shakeX; camera.position.y += shakeY;
    if (barnCombat && bridge) {
      // Weapons in hand: beside the torso at the gun hand, pointed along the aim (own: at the crosshair; others: their facing).
      const { euler, q, v } = scratch.current;
      for (const player of local.physics.players) {
        const view = held.current[player.id],
          fighter = barnCombat.fighters[player.id],
          body = beans.current[player.id]?.getObjectByName("torso");
        if (!body) continue;
        view.kind = fighter.alive ? fighter.weapon?.kind ?? null : null;
        view.grip.copy(GRIP).applyQuaternion(q.setFromAxisAngle(UP, player.facing)).add(body.position);
        view.grip.y += Math.max(-0.3, Math.min(0.3, -Math.sin(player.id === 0 && barn ? aim.current.pitch : fighter.aimPitch) * 0.45));
        const own = player.id === 0 && barn;
        euler.set(own ? aim.current.pitch : fighter.aimPitch, own ? aim.current.yaw : player.facing, 0, "YXZ");
        // Own weapon converges on what the crosshair is on (never rolled), unless that is too close.
        if (own && crosshair.current.hit && v.copy(crosshair.current.point).sub(view.grip).length() > 1.2) {
          v.normalize();
          euler.set(-Math.asin(Math.max(-1, Math.min(1, v.y))), Math.atan2(v.x, v.z), 0, "YXZ");
        }
        view.aim.setFromEuler(euler);
        view.kick *= Math.exp(-delta / 0.06);
      }
      const f = bridge.frame;
      f.elapsed = frame.clock.elapsedTime;
      f.dt = delta;
      f.held = held.current;
      const director = barnCombat.pickups,
        telegraph = BARN_COMBAT.pickups.telegraph;
      f.props = {
        pickups: director.active,
        telegraphs: director.pending.flatMap((p) =>
          p.spot && director.time >= p.due - telegraph ? [{ spot: p.spot, progress: Math.min(1, (director.time - (p.due - telegraph)) / telegraph) }] : []
        ),
        traps: barnCombat.traps.map((t) => ({ id: t.id, armed: t.armed, sprungFor: t.sprungFor, rearmIn: t.rearmIn, holding: !t.armed && t.sprungFor < BARN_COMBAT.trap.hold })),
      };
      for (const shot of out.shots) {
        const view = held.current[shot.shooter];
        q.copy(view.aim);
        v.set(0, 0, MUZZLE[shot.kind] * HELD_SCALE).applyQuaternion(q);
        f.shots.push({ kind: shot.kind, muzzle: view.grip.clone().add(v), pellets: shot.pellets });
      }
      for (const hit of out.hits)
        if (hit.source === "punch" || hit.source === "trap") f.impacts.push({ point: new Vector3(hit.point.x, hit.point.y, hit.point.z), body: hit.source === "punch", strong: hit.killed });
      bridge.publish();
      const rays = barnCombat.hitscan.stats;
      performanceSample.current.rays = rays.rays;
      performanceSample.current.rayMs = rays.ms;
    }
    const sample = performanceSample.current;
    sample.time += delta;
    sample.frames++;
    if (sample.time >= 2) {
      if (hud.current.performance)
        hud.current.performance.textContent = `${Math.round(
          sample.frames / sample.time
        )} FPS · ${(sample.simulationMs / Math.max(1, sample.steps)).toFixed(
          barn ? 2 : 1
        )} ms fizik · 27 gövde / 24 eklem${
          barn
            ? ` · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · ${local.physics.map.colliders.length} statik · kamera ${cameraReadout.current.boom.toFixed(1)} m · nişan ${
                cameraReadout.current.aim < 0 ? "—" : `${cameraReadout.current.aim.toFixed(1)} m`
              } · yön ${Math.round(((((aim.current.yaw * 180) / Math.PI) % 360) + 360) % 360)}° / eğim ${Math.round((aim.current.pitch * 180) / Math.PI)}° · konum ${hud.current.performance.dataset.position ?? "—"}`
            : ""
        }${
          local.barn
            ? ` · çatışma ışını ${Math.round(sample.rays / sample.time)}/sn, ${((sample.rayMs / Math.max(1, sample.rays)) * 1000).toFixed(0)} µs/ışın`
            : ""
        }`;
      sample.time = sample.frames = sample.simulationMs = sample.steps = 0;
      if (local.barn) {
        local.barn.hitscan.stats.rays = local.barn.hitscan.stats.ms = 0;
        sample.rays = sample.rayMs = 0;
      }
    }
    if (barnCombat) updateBarnHud(barnCombat, hud.current.barn, barnHudCache.current);
    // Imperative DOM meters at 10Hz, not React state or full component rerenders.
    hudTime.current += delta;
    if (hudTime.current >= 0.1) {
      hudTime.current = 0;
      // Barn layout practice: where you stand (the readout below shows it; walkthrough scripts read it).
      if (barn && hud.current.performance) {
        const b = local.physics.players[0].body.translation();
        hud.current.performance.dataset.position = `${b.x.toFixed(2)},${(b.y - 0.78).toFixed(2)},${b.z.toFixed(2)}`;
      }
      // Barn combat test readout (walkthrough scripts read it, like the position above).
      if (local.barn && hud.current.performance) {
        const c = local.barn,
          round2 = (n: number) => Math.round(n * 100) / 100;
        hud.current.performance.dataset.combat = JSON.stringify({
          fighters: c.fighters.map((f) => {
            const at = local.physics.players[f.id].body.translation();
            return { hp: f.hp, alive: f.alive, weapon: f.weapon?.kind ?? null, ammo: f.weapon?.ammo ?? 0, trapped: round2(f.trapped), protection: round2(f.protection), home: f.home.id, at: [round2(at.x), round2(at.y - 0.78), round2(at.z)], torso: round2(local.physics.players[f.id].parts.torso.body.translation().y), deaths: f.deaths };
          }),
          pickups: c.pickups.active.map((p) => `${p.spot}:${p.kind}`),
          pending: c.pickups.pending.map((p) => `${p.emptied}→${p.spot ?? "?"}@${round2(p.due - c.pickups.time)}`),
          traps: c.traps.map((t) => `${t.id}:${t.armed ? "armed" : `sprung ${round2(t.rearmIn)}`}`),
          stats: c.stats,
          aimOn: cameraReadout.current.on,
          yaw: round2(aim.current.yaw),
          pitch: round2(aim.current.pitch),
        });
      }
      for (const player of local.combat.players) {
        const label = hud.current.labels[player.id],
          meter = hud.current.meters[player.id];
        const fighter = local.barn?.fighters[player.id];
        if (fighter) {
          // Barn: health on the roster (the meter is the HP bar).
          const text = !fighter.alive
            ? `Öldü · ${Math.max(0, BARN_COMBAT.death.respawn - fighter.deadFor).toFixed(1)} sn`
            : `${Math.ceil(fighter.hp)} HP${fighter.trapped > 0 ? " · kapanda" : fighter.protection > 0 ? " · korumalı" : fighter.weapon ? ` · ${WEAPON_NAMES[fighter.weapon.kind]}` : ""}`;
          if (label && label.textContent !== text) label.textContent = text;
          if (meter) meter.value = fighter.alive ? fighter.hp : 0;
          continue;
        }
        const active =
          local.round.phase === "playing" &&
          !local.options.explore &&
          !local.physics.players[player.id].eliminated;
        const state = player.condition.state,
          grips = local.combat.grips.count(player.id);
        const text = !active
          ? ""
          : state === "KNOCKED_OUT"
          ? "Baygın"
          : state === "RECOVERING"
          ? "Toparlanıyor"
          : state === "DAZED"
          ? "Sersem"
          : local.combat.grips.incoming[player.id].size
          ? "Tutuluyor"
          : grips
          ? `${grips} elle tutuyor`
          : player.punches[0].age >= 0
          ? "Sol yumruk"
          : player.punches[1].age >= 0
          ? "Sağ yumruk"
          : "Hazır";
        if (label && label.textContent !== text) label.textContent = text;
        if (meter) meter.value = active ? player.condition.meter : 0;
      }
      const human = local.combat.players[0];
      const me = local.barn?.fighters[0];
      const nearby = me?.alive ? local.barn!.pickups.nearest(local.physics.players[0].body.translation()) : null;
      const text =
        local.round.phase !== "playing" || local.physics.players[0].eliminated
          ? ""
          : me
          ? !me.alive
            ? ""
            : nearby
            ? `${actionBindingLabel(bindings, "grab")}: ${WEAPON_NAMES[nearby.kind]} al${me.weapon ? ` (elindeki ${WEAPON_NAMES[me.weapon.kind]} yok olur)` : ""}`
            : me.trapped > 0
            ? "Ayı kapanı! Kurtulana kadar yürüyemez, zıplayamazsın — nişan alıp saldırabilirsin."
            : `${actionBindingLabel(bindings, "punch")}: ${me.weapon ? "ateş" : "yumruk"} · ${actionBindingLabel(bindings, "grab")}: yakındaki silahı al · ${actionBindingLabel(bindings, "lift")}: koş · Mermi bitince silah kaybolur, yenisini bul.`
          : local.options.explore
          ? `Ambar yerleşim testi · WASD kameraya göre · ${actionBindingLabel(bindings, "lift")} basılı: koş · Üst kat: batıda rampa, doğuda saman basamakları, güneyde merdiven; açık kenarlardan atla. Silahlar ve tuzaklar önizleme.`
          : human.condition.state === "KNOCKED_OUT"
          ? "Bayıldın! Birazdan toparlanacaksın."
          : human.condition.state === "RECOVERING"
          ? "Ayağa kalkıyorsun…"
          : local.combat.grips.incoming[0].size
          ? "Tutuldun! Uzaklaş, zıpla veya boş elinle karşılık ver."
          : local.combat.grips.count(0)
          ? `${actionBindingLabel(bindings, "lift")}: kaldır · Savurmak için tutmayı bırak.`
          : `${actionBindingLabel(bindings, "punch")}: yumruk · ${actionBindingLabel(bindings, "grab")}: basılı tut ve yakala.`;
      if (hud.current.hint && hud.current.hint.textContent !== text)
        hud.current.hint.textContent = text;
    }
  });

  return (
    <>
      <Arena mapId={mapId} barn={bridge} />
      {barn && (
        <mesh ref={aimMarker} visible={false} renderOrder={10}>
          <sphereGeometry args={[0.07, 12, 8]} />
          <meshBasicMaterial color="#ff5a3c" depthTest={false} transparent opacity={0.9} fog={false} />
        </mesh>
      )}
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

export default function ArenaScene({ onExit, bindings, onBindings, bindingsSaved, paused, onControls, costumeId }: {
  onExit: () => void;
  bindings: Bindings;
  /** Rebinding from the immersive arena's Esc menu (the test layout opens the full page). */
  onBindings: (bindings: Bindings) => void;
  bindingsSaved: boolean;
  paused: boolean;
  onControls: () => void;
  costumeId: SelectableCostumeId;
}) {
  const { audio, settings } = usePartyAudio();
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const [status, setStatus] = useState<ArenaStatus>("loading");
  const [mapId, setMapId] = useState<LocalArenaId>(DEFAULT_ARENA_MAP_ID);
  const [round, setRound] = useState<RoundSnapshot | null>(null);
  const explore = EXPLORE_MAPS.has(mapId);
  const barn = mapId === "barn";
  // Katman Kaosu (local): its own playground, HUD and 2–3 player choice.
  const layers = mapId === "layers";
  const [layerPlayers, setLayerPlayers] = useState<2 | 3>(3);
  const [layerSnapshot, setLayerSnapshot] = useState<LayerSnapshot | null>(null);
  const layerHud = useRef<LayerHudElements>({ debug: null, banner: null });
  /** Mouse/trackpad look drives a chase camera (Barn, Katman Kaosu). */
  const chaseCamera = barn || layers;
  const immersive = IMMERSIVE_MAPS.has(mapId);
  // Immersive only: the Esc menu (never a pause — the local round and bots go on) and the
  // debug readout, which is collapsed unless asked for.
  const menu = useArenaMenu(immersive && !paused);
  const menuOpen = menu.view !== null;
  const inputOff = paused || menuOpen;
  const [openDebugAtStart] = useState(debugAtStart);
  const debugPanel = useDebugPanel(true, openDebugAtStart);
  const barnCombat = BARN_COMBAT_MAPS.has(mapId);
  const [lookMode, setLookMode] = useState<LookMode>(loadLookMode);
  const [lookStatus, setLookStatus] = useState<LookStatus>("unlocked");
  const look = useRef<LookController | null>(null);
  const lookModeNow = useRef(lookMode);
  lookModeNow.current = lookMode;
  const viewport = useRef<HTMLDivElement>(null);
  const combatHud = useRef<CombatHudElements>({
    labels: [],
    meters: [],
    hint: null,
    performance: null,
    barn: { crosshair: null, hp: null, hpBar: null, weapon: null, ammo: null, status: null, hitmarker: null, vignette: null, death: null, deathTime: null },
  });

  useEffect(() => {
    if (!inputOff) viewport.current?.focus();
  }, [inputOff]);
  // Barn and Katman Kaosu: pointer lock / drag look on the arena viewport. A lock the
  // browser ends (Esc, focus loss) opens the menu in the immersive arena only.
  const { lockEnded } = menu;
  useEffect(() => {
    const surface = viewport.current;
    if (!chaseCamera || !surface) return;
    const controller = bindLook(surface, lookModeNow.current, setLookStatus, lockEnded);
    look.current = controller;
    return () => {
      controller.dispose();
      look.current = null;
      setLookStatus("unlocked");
    };
  }, [chaseCamera, lockEnded]);
  useEffect(() => {
    look.current?.setMode(lookMode);
    saveLookMode(lookMode);
  }, [lookMode]);
  useEffect(() => {
    look.current?.setEnabled(!inputOff);
  }, [inputOff, chaseCamera]);
  function chooseMap(next: LocalArenaId) {
    menu.setView(null);
    setStatus("loading");
    setRound(null);
    setLayerSnapshot(null);
    setMapId(next);
    // Keep arrow keys for the game, not for switching maps mid-round.
    requestAnimationFrame(() => viewport.current?.focus());
  }
  function chooseLayerPlayers(next: 2 | 3) {
    menu.setView(null);
    setStatus("loading");
    setLayerSnapshot(null);
    setLayerPlayers(next);
    requestAnimationFrame(() => viewport.current?.focus());
  }
  const layerOut = layerSnapshot?.phase === "playing" && !layerSnapshot.alive[0];

  const mapSelect = (
    <select value={mapId} onChange={(event) => chooseMap(event.target.value as LocalArenaId)}>
      {LOCAL_ARENA_IDS.map((id) => (
        <option key={id} value={id}>{localArenaName(id)}</option>
      ))}
    </select>
  );
  return (
    <div className={`party-lab pl-playground${immersive ? " pl-immersive" : ""}`} data-mode={layers ? LAYER_CHAOS.mode : undefined}>
      {!immersive && <header className="pl-arena-header">
        <div>
          <span className="pl-eyebrow">PARTY LAB / YEREL TEST · {localArenaName(mapId).toLocaleUpperCase("tr-TR")}</span>
          <h2>Biraz hareket, biraz kaos.</h2>
        </div>
        <label className="pl-map-select">
          <span>Harita</span>
          {mapSelect}
        </label>
        {chaseCamera && (
          <label className="pl-map-select pl-look-select">
            <span>Bakış</span>
            <select
              value={lookMode}
              onChange={(event) => {
                setLookMode(event.target.value as LookMode);
                requestAnimationFrame(() => viewport.current?.focus());
              }}
            >
              <option value="lock">İmleç kilidi</option>
              <option value="drag">Sürükleyerek bak</option>
            </select>
          </label>
        )}
        <button className="pl-button pl-join" type="button" onClick={onControls}>Kontroller</button>
        <button className="pl-button pl-join" type="button" onClick={onExit} data-sfx="uiBack">
          Lobiye Dön
        </button>
      </header>}
      <div
        className="pl-viewport"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label={layers ? `${LAYER_CHAOS.label} · yerel arena` : "Yerel 3D test arenası"}
        aria-describedby={immersive ? undefined : "pl-controls"}
        data-look={chaseCamera ? lookMode : undefined}
        data-combat={barnCombat ? "barn" : undefined}
        data-mode={layers ? LAYER_CHAOS.mode : undefined}
        data-arena={mapId}
        onPointerDown={() => viewport.current?.focus()}
      >
        <SceneBoundary onError={() => setStatus("graphics-error")}>
          <Canvas
            dpr={[1, 1.5]}
            camera={{ position: [0, 12, 14], fov: 45, near: 0.1, far: 180 }}
            gl={{ antialias: true, alpha: true }}
            fallback={
              <div className="pl-scene-notice" role="alert">
                Bu arena için WebGL 2 desteği gerekiyor.
              </div>
            }
          >
            {mapId === "layers" ? (
              <LayerPlayground
                key={`layers-${layerPlayers}`}
                players={layerPlayers}
                onStatus={setStatus}
                onSnapshot={setLayerSnapshot}
                hud={layerHud}
                bindings={bindings}
                paused={paused}
                menuOpen={menuOpen}
                audio={audio}
                shakeEnabled={settings.cameraShake && !reducedMotion}
                look={look}
                costumeId={costumeId}
              />
            ) : (
              <Playground
                key={mapId}
                mapId={mapId}
                onStatus={setStatus}
                onRound={setRound}
                hud={combatHud}
                bindings={bindings}
                paused={paused}
                audio={audio}
                shakeEnabled={settings.cameraShake && !reducedMotion}
                look={look}
                costumeId={costumeId}
              />
            )}
          </Canvas>
        </SceneBoundary>
        {immersive && <MenuButton onOpen={() => menu.setView("main")} />}
        {layers && status === "ready" && layerSnapshot && (
          <>
            <LayerHud snapshot={layerSnapshot} hud={layerHud} debugOpen={debugPanel.open} />
            {lookMode === "lock" && lookStatus !== "locked" && !inputOff && layerSnapshot.phase !== "results" && (
              <div className="pl-arena-message pl-look-prompt" role="status">
                <strong>{lookStatus === "error" ? "İmleç kilitlenemedi" : "Kamerayı çevirmek için arenaya tıkla"}</strong>
                <span>
                  {lookStatus === "error"
                    ? "Tekrar tıkla ya da Esc menüsündeki Bakış ayarından “Sürükleyerek bak”ı seç."
                    : "Fare ya da trackpad ile çevir · Esc menü"}
                </span>
              </div>
            )}
          </>
        )}
        {layers && (
          <ControlHint
            text={controlHint(bindings, "layers", lookMode)}
            playing={layerSnapshot?.phase === "playing"}
            replay={menu.hintReplay}
            hidden={menuOpen || layerOut}
          />
        )}
        {!layers && status === "ready" && round && (
          <>
            <div className="pl-round-hud">
              <ul className="pl-roster" aria-label="Oyuncu durumları">
                {PLAYERS.map((player) => (
                  <li
                    key={player.id}
                    className={round.alive[player.id] ? "" : "pl-eliminated"}
                  >
                    <span
                      className="pl-player-dot"
                      style={{ backgroundColor: player.color }}
                      aria-hidden="true"
                    />
                    <span>
                      <b>
                        {player.label}{" "}
                        <small>{player.id === 0 ? "Sen" : explore ? "Kukla" : "Bot"}</small>
                      </b>
                      {!barnCombat && <span>{round.alive[player.id] ? "Aktif" : "Elendi"}</span>}
                      <span
                        className="pl-combat-label"
                        ref={(element) => {
                          combatHud.current.labels[player.id] = element;
                        }}
                      />
                      <progress
                        hidden={explore && !barnCombat}
                        className={barnCombat ? "pl-stun-meter pl-hp-meter" : "pl-stun-meter"}
                        max={barnCombat ? BARN_COMBAT.health : COMBAT.knockout.threshold}
                        defaultValue={barnCombat ? BARN_COMBAT.health : 0}
                        aria-label={barnCombat ? `${player.label} can` : `${player.label} sersemleme birikimi`}
                        ref={(element) => {
                          combatHud.current.meters[player.id] = element;
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              {round.phase === "playing" && !explore && (
                <span
                  className="pl-round-clock"
                  aria-label={`Kalan süre: ${round.seconds} saniye`}
                >
                  {round.seconds} sn
                </span>
              )}
            </div>
            <div
              className="pl-combat-hint"
              ref={(element) => {
                combatHud.current.hint = element;
              }}
            />
            {barnCombat && (
              <>
                <div
                  className="pl-damage-vignette"
                  aria-hidden="true"
                  ref={(element) => {
                    combatHud.current.barn.vignette = element;
                  }}
                />
                <div
                  className="pl-hitmarker"
                  aria-hidden="true"
                  ref={(element) => {
                    combatHud.current.barn.hitmarker = element;
                  }}
                />
                <div className="pl-barn-hud" aria-label="Can ve silah">
                  <div className="pl-barn-health">
                    <span className="pl-barn-hp" aria-label="Can">
                      <b ref={(element) => { combatHud.current.barn.hp = element; }}>{BARN_COMBAT.health}</b>
                      <small>HP</small>
                    </span>
                    <span className="pl-barn-hp-bar" ref={(element) => { combatHud.current.barn.hpBar = element; }} />
                  </div>
                  <div className="pl-barn-weapon">
                    <b ref={(element) => { combatHud.current.barn.weapon = element; }}>Silah yok</b>
                    <span ref={(element) => { combatHud.current.barn.ammo = element; }}>Yumruk</span>
                  </div>
                  <span className="pl-barn-status" role="status" ref={(element) => { combatHud.current.barn.status = element; }} />
                </div>
                <div
                  className="pl-arena-message pl-barn-death"
                  role="status"
                  hidden
                  ref={(element) => {
                    combatHud.current.barn.death = element;
                  }}
                >
                  <strong>Öldün!</strong>
                  <span ref={(element) => { combatHud.current.barn.deathTime = element; }} />
                </div>
              </>
            )}
            {barn && (
              <>
                {/* Screen centre = the aim line the simulation fires along (a red X: your body's line to it is blocked). */}
                <div
                  className="pl-crosshair"
                  aria-hidden="true"
                  ref={(element) => {
                    combatHud.current.barn.crosshair = element;
                  }}
                />
                {lookMode === "lock" && lookStatus !== "locked" && !paused && (
                  <div className="pl-arena-message pl-look-prompt" role="status">
                    <strong>{lookStatus === "error" ? "İmleç kilitlenemedi" : "Bakmak için arenaya tıkla"}</strong>
                    <span>
                      {lookStatus === "error"
                        ? "Tekrar tıkla ya da Bakış menüsünden “Sürükleyerek bak”ı seç."
                        : "Fare ya da trackpad ile çevir · WASD kameraya göre · Esc imleci bırakır"}
                    </span>
                  </div>
                )}
                {lookMode === "lock" && lookStatus === "locked" && <div className="pl-look-chip">Esc: imleci bırak</div>}
                {lookMode === "drag" && lookStatus !== "dragging" && (
                  <div className="pl-look-chip">Bakmak için basılı tutup sürükle</div>
                )}
              </>
            )}
            {(round.phase !== "playing" || !round.alive[0]) && (
              <div
                className={`pl-arena-message pl-round-message${round.phase === "results" ? " pl-result-pulse" : ""}`}
                role="status"
                aria-atomic="true"
              >
                {round.phase === "countdown" && (
                  <>
                    <strong>{round.seconds}</strong>
                    <span>Hazır ol!</span>
                  </>
                )}
                {round.phase === "playing" && (
                  <>
                    <strong>Düştün!</strong>
                    <span>Diğer oyuncuları izle.</span>
                  </>
                )}
                {round.phase === "results" && (
                  <>
                    <strong
                      style={{
                        color:
                          round.winner === null
                            ? undefined
                            : PLAYERS[round.winner].color,
                      }}
                    >
                      {round.winner === null
                        ? "Berabere!"
                        : `${PLAYERS[round.winner].label} kazandı!`}
                    </strong>
                    <span>
                      {round.reason === "timeout" ? "Süre doldu. " : ""}Yeni tur
                      birazdan.
                    </span>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {status !== "ready" && status !== "graphics-error" && (
          <div className="pl-arena-message" role="status" aria-live="polite">
            {status === "loading" && "Arena hazırlanıyor…"}
            {status === "error" &&
              "Fizik motoru yüklenemedi. Lobiye dönüp tekrar dene."}
          </div>
        )}
      </div>
      {!immersive && <footer className="pl-arena-footer" id="pl-controls">
        <div>
          {ACTIONS.map(action => <span key={action}>
            <kbd>{actionBindingLabel(bindings, action)}</kbd> {(barn && BARN_ACTION_LABELS[action]) || ACTION_LABELS[action]}
          </span>)}
        </div>
        <span
          ref={(element) => {
            combatHud.current.performance = element;
          }}
        >
          {barnCombat ? "1 oyuncu + 2 hedef kukla · Yerel çatışma testi" : explore ? "1 oyuncu + 2 kukla · Yerleşim testi" : "1 oyuncu + 2 yerel bot · Aktif ragdoll testi"}
        </span>
      </footer>}
      {menu.view && (
        <ArenaMenu
          view={menu.view}
          setView={menu.setView}
          onResume={() => menu.setView(null)}
          onLeave={onExit}
          leaveLabel="Lobiye Dön"
          lobby={null}
          modeName={localArenaName(mapId)}
          bindings={bindings}
          onBindings={onBindings}
          bindingsSaved={bindingsSaved}
          look={chaseCamera ? { mode: lookMode, onChange: setLookMode } : undefined}
          debug={{ open: debugPanel.open, onToggle: debugPanel.toggle }}
        >
          <label className="pl-menu-row">
            <span>Harita</span>
            {mapSelect}
          </label>
          {layers && (
            <label className="pl-menu-row">
              <span>Oyuncu</span>
              <select value={layerPlayers} onChange={(event) => chooseLayerPlayers(Number(event.target.value) === 2 ? 2 : 3)}>
                <option value={3}>3 (sen + 2 bot)</option>
                <option value={2}>2 (sen + 1 bot)</option>
              </select>
            </label>
          )}
        </ArenaMenu>
      )}
    </div>
  );
}
