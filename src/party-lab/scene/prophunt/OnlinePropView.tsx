import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import RAPIER from "@dimforge/rapier3d-compat";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Euler, Fog, Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import { CameraFeel } from "../../audio/feel";
import type { Bindings } from "../../input/bindings";
import { isUIInput } from "../../input/device";
import { bindKeyboard } from "../../input/keyboard";
import type { LookController } from "../../input/look";
import type { MovementInput } from "../../input/types";
import PlayerBean from "../PlayerBean";
import { initializePhysics, PHYSICS } from "../physics";
import { PLAYERS, type PlayerId } from "../players";
import { PARTS, SHAPES } from "../ragdoll/config";
import { playerCostumeAtSlot } from "../visual/costumes";
import { surfaceBelow, type PropRole } from "../../../../shared/party-lab/maps/propHunt";
import type { PropLayout } from "../../../../shared/party-lab/maps/propHuntLayout";
import { PROP_FAMILIES, shapeHeight, type PropFamilyId } from "../../../../shared/party-lab/maps/propHuntProps";
import { PROP_HUNT } from "../../../../shared/party-lab/simulation/prophunt/config";
import { buildPropArena } from "./arena";
import { PropPrediction } from "../../network/prediction/propRig";
import type { GameStream } from "../../network/gameStream";
import type { LobbySnapshot } from "../../network/types";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { PropOnlineEvent } from "../../../../shared/party-lab/simulation/prophunt/wire";
import type { PropHudElements, PropSnapshot } from "./PropHuntPlayground";
import { hiderIntent, seekerIntent, whistleKey } from "./controls";
import { PropHuntGame } from "./game";
import { activeView, clampPitch, disguisePivot, FIRST_PERSON_HIDDEN, ownOpacity, PROP_CAMERA, propCameraBlockers, propCameraPose, propFirstPersonPose, PropFollow, toggledView, VIEW_KEY, type SeekerView, type ViewTuning } from "./propCamera";
import PropHuntScenery from "./PropHuntScenery";
import type { PropKit } from "./scenery";
import { BLASTER_MUZZLE, PropVisuals } from "./visuals";
import { SENSE_AUDIO, SENSE_RECIPE, WHISTLE_AUDIO, WHISTLE_MUFFLE, WHISTLE_RECIPE } from "./whistle";

type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";

const SKY = "#bfe1f2";
/** Seconds a found hider's reveal (the body popping out of the prop) plays before the camera moves on. */
const REVEAL = 1.0;
/** The blaster's grip beside the seeker's torso (facing yaw only): out on the camera's side, low, a little forward. */
const GRIP = new Vector3(-0.56, -0.08, 0.32);
const UP = new Vector3(0, 1, 0);
const REFUSALS = { noProp: "Yakında dönüşecek eşya yok", noRoom: "Burada yer yok", airborne: "Önce yere in" } as const;
/** First person: the blaster as a view model, in the camera's frame (right, up, forward; m). */
const VIEW_GRIP = new Vector3(0.27, -0.3, -0.6);
const TURN_AROUND = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

/** Sky, fog and the camp's soft summer light. */
export function PropEnvironment() {
  const scene = useThree((state) => state.scene);
  const arena = useMemo(buildPropArena, []);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(SKY, 34, 95);
    scene.background = new Color(SKY);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  useEffect(() => () => arena.dispose(), [arena]);
  return (
    <>
      <hemisphereLight args={["#fffaf0", "#7f9a6a", 1.55]} />
      <directionalLight position={[-10, 24, 14]} intensity={2.0} color="#fff1dc" />
      <primitive object={arena.group} />
    </>
  );
}

/**
 * Online presentation of the authoritative camp, with recipient-only movement prediction.
 */
export default function OnlinePropView({
  lobby, stream, sendInput, slot,
  role,
  onStatus,
  onSnapshot,
  hud,
  bindings,
  paused,
  menuOpen,
  audio,
  shakeEnabled,
  look,
  view: seekerView,
  onView,
  proximityEnabled,
}: {
  lobby: LobbySnapshot;
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
  slot: PlayerId;
  role: PropRole;
  onStatus: (status: ArenaStatus) => void;
  onSnapshot: (snapshot: PropSnapshot) => void;
  hud: MutableRefObject<PropHudElements>;
  bindings: Bindings;
  /** The arena is hidden (lobby-level settings): the simulation stops. */
  paused: boolean;
  /** The Esc menu is open: only this player's input stops; the server round goes on. */
  menuOpen: boolean;
  audio: AudioManager;
  shakeEnabled: boolean;
  look: MutableRefObject<LookController | null>;
  /** The seeker's camera (the hiders are always third person). */
  view: SeekerView;
  /** V asks for the other view (the choice lives with the arena, like the Esc menu's). */
  onView: (view: SeekerView) => void;
  proximityEnabled: boolean;
}) {
  const { camera, gl } = useThree();
  const beans = useRef<(Group | null)[]>([]);
  const game = useRef<PropHuntGame | null>(null);
  const prediction = useRef<PropPrediction | null>(null);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const inputOff = paused || menuOpen;
  const inputOffNow = useRef(inputOff);
  inputOffNow.current = inputOff;
  const bindingsNow = useRef(bindings);
  bindingsNow.current = bindings;
  const proximityNow = useRef(proximityEnabled);
  proximityNow.current = proximityEnabled;
  const whistlePressed = useRef(false);
  const seekerViewNow = useRef(seekerView);
  seekerViewNow.current = seekerView;
  const onViewNow = useRef(onView);
  onViewNow.current = onView;

  const tuning: ViewTuning = role === "seeker" ? PROP_CAMERA.seeker : PROP_CAMERA.hider;
  const poses = useRef(PLAYERS.map(() => PARTS.map(() => ({ previous: new Vector3(), current: new Vector3(), previousQ: new Quaternion(), currentQ: new Quaternion() }))));
  /** Disguise poses per slot (bottom-centre and yaw), interpolated like the bodies. */
  const props = useRef(PLAYERS.map(() => ({ family: null as PropFamilyId | null, previous: new Vector3(), current: new Vector3(), previousYaw: 0, currentYaw: 0 })));
  const accumulator = useRef(0);
  const feel = useRef(new CameraFeel());
  const visuals = useMemo(() => new PropVisuals(), []);
  useEffect(() => () => visuals.dispose(), [visuals]);
  /** The camera's solids for the round's layout (rebuilt when a new layout is dealt). */
  const blockers = useRef<{ layout: PropLayout | null; value: ReturnType<typeof propCameraBlockers> }>({ layout: null, value: propCameraBlockers() });
  /** The whistles heard this round (debug readout). */
  const whistles = useRef<{ muffled: boolean; distance: number }[]>([]);
  /** Hunches the local seeker felt this round (debug readout: search seconds only). */
  const senses = useRef<number[]>([]);
  const listener = useRef({ x: 0, y: 0, z: 0 });
  const ray = useMemo(() => new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), []);
  const view = useRef({
    yaw: Math.PI,
    pitch: tuning.restPitch,
    follow: new PropFollow(),
    boom: { boom: null as number | null },
    spectating: null as PlayerId | null,
    lastBoom: 0,
    fov: tuning.fov as number,
    kick: 0,
    firstPerson: false,
  });
  /** A found hider's reveal: the body pops up out of the prop and shrinks away (presentation only). */
  const reveals = useRef(PLAYERS.map(() => ({ active: false, age: 0, at: new Vector3(), yaw: 0 })));
  const published = useRef({ key: "" });
  const readout = useRef({ time: 0, frames: 0, simulationMs: 0, steps: 0, fps: 0, physicsMs: 0, hud: 0, pickIn: 0 });
  const time = useRef(0);
  const scratch = useRef({ v: new Vector3(), w: new Vector3(), q: new Quaternion(), e: new Euler(0, 0, 0, "YXZ"), aim: new Quaternion(), grip: new Vector3(), muzzle: new Vector3(), feet: new Vector3() });

  /** The result's camera: how long the reveal has been shown, and whether the player took the view back. */
  const framing = useRef({ age: 0, off: false });
  const scenery = useRef<Group | null>(null);
  /** The crosshair's aim-line point relative to the seeker's pelvis (sent with the shot). */
  const eye = useRef<{ x: number; y: number; z: number } | null>(null);
  /** The decoy the local hider would copy (refreshed ~10×/s). */
  const pick = useRef<{ index: number } | null>(null);
  const lastShot = useRef<Record<string, unknown> | null>(null);
  /** What the local seeker's shot would hit now (debug readout). */

  const log = useRef({ disguises: 0, refusals: 0, shots: 0, finds: 0 });
  const onKit = useCallback((kit: PropKit | null) => visuals.setKit(kit), [visuals]);

  const snapshotOf = (g: PropHuntGame): PropSnapshot => ({
    phase: g.round.phase,
    seconds: g.round.seconds,
    role,
    roles: [...g.roles],
    alive: [...g.round.alive],
    disguise: g.disguiseOf(slot)?.family ?? null,
    ammo: g.ammo,
    hidden: g.round.hidden.length,
    outcome: g.round.outcome,
    reason: g.round.reason,
    endedAt: g.round.endedAt / 60,
    spectating: view.current.spectating,
    shots: g.stats.shots,
    decoyHits: g.stats.decoyHits,
    reveal: g.reveal.map((r) => ({ id: r.id, family: r.family })),
  });
  const publish = (g: PropHuntGame) => {
    const key = `${g.round.revision}|${g.disguiseOf(slot)?.family ?? "-"}|${g.ammo}|${view.current.spectating}|${g.reveal.length}`;
    if (key === published.current.key) return;
    published.current.key = key;
    onSnapshot(snapshotOf(g));
  };
  const resetView = (g: PropHuntGame) => {
    const { yaw } = g.spawnOf(slot);
    view.current.yaw = yaw;
    view.current.pitch = activeView(seekerViewNow.current, role) === "first" ? PROP_CAMERA.firstPerson.restPitch : tuning.restPitch;
    view.current.follow.reset();
    view.current.boom.boom = null;
    view.current.spectating = null;
    reveals.current.forEach((r) => (r.active = false));
    props.current.forEach((p) => (p.family = null));
    eye.current = null;
    pick.current = null;
    whistles.current = [];
    senses.current = [];
    framing.current = { age: 0, off: false };
    visuals.clear();
  };
  const snapPoses = (g: PropHuntGame) => {
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
  /** The big word over the arena ("BULUNDU!", "Boş!"); `small` for a quick hint. */
  const callout = (text: string, tone: "found" | "miss" | "info" | "warn" | "win", small = false) => {
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
      { duration: small ? 1100 : 1400, easing: "ease-out", fill: "forwards" }
    );
  };

  useEffect(() => {
    const perspective = camera as PerspectiveCamera,
      previous = perspective.fov;
    perspective.fov = tuning.fov;
    perspective.updateProjectionMatrix();
    return () => {
      perspective.fov = previous;
      perspective.updateProjectionMatrix();
    };
  }, [camera, tuning]);

  useLayoutEffect(() => {
    keyboard.current?.setBindings(bindings);
    keyboard.current?.setSuspended(inputOff);
    whistlePressed.current = false;
    if (paused) {
      audio.stopAll();
      feel.current.clear();
    }
  }, [bindings, paused, inputOff]);

  useLayoutEffect(() => {
    if (proximityEnabled) return;
    for (const element of [hud.current.sense, hud.current.senseGlow]) element?.getAnimations().forEach((animation) => animation.cancel());
    audio.stopSpatial("propSense");
  }, [proximityEnabled, audio, hud]);

  useEffect(() => {
    let cancelled = false;
    const lockSurface = gl.domElement.closest(".pl-viewport") as HTMLElement | null;
    const controls = bindKeyboard(gl.domElement, bindings, lockSurface ? { mouseSurface: lockSurface, claimMouse: (event) => look.current?.claimsClick(event) ?? false } : {});
    controls.setSuspended(inputOffNow.current);
    keyboard.current = controls;
    const keys = (event: KeyboardEvent) => {
      const g = game.current;
      if (!g || inputOffNow.current || isUIInput(event.target)) return;
      const bound = Object.values(bindingsNow.current).some((keys) => keys.includes(event.code as never));
      if (g.hidden(slot) && g.round.phase === "search" && event.code === whistleKey(bindingsNow.current) && !event.repeat) {
        event.preventDefault();
        whistlePressed.current = true;
        return;
      }
      // V: the seeker's camera, shoulder ↔ first person (unless V is bound to an action). Pointer Lock stays as it is.
      if (event.code === VIEW_KEY && !bound && !event.repeat && role === "seeker") {
        onViewNow.current(toggledView(seekerViewNow.current, role));
        return;
      }
      // Spectating (found): Q / E cycle through everyone still playing.
      if (event.code !== "KeyQ" && event.code !== "KeyE") return;
      if (g.round.alive[slot] || g.round.phase !== "search") return;
      const watchable = PLAYERS.map((p) => p.id).filter((id) => id !== slot && (g.roles[id] === "seeker" || g.round.alive[id]));
      if (!watchable.length) return;
      const at = watchable.indexOf(view.current.spectating ?? (-1 as PlayerId));
      const step = event.code === "KeyE" ? 1 : -1;
      view.current.spectating = watchable[(at + step + watchable.length) % watchable.length];
      view.current.follow.blend = 0.5;
    };
    window.addEventListener("keydown", keys);
    const clearWhistle = () => { whistlePressed.current = false; };
    window.addEventListener("blur", clearWhistle);
    void initializePhysics()
      .then(() => {
        if (cancelled) return;
        prediction.current = new PropPrediction(slot);
        onStatus("ready");
      })
      .catch(() => {
        if (!cancelled) onStatus("error");
      });
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", keys);
      window.removeEventListener("blur", clearWhistle);
      audio.stopAll();
      feel.current.clear();
      controls.dispose();
      keyboard.current = null;
      prediction.current?.dispose();
      prediction.current = null;
      game.current = null;

    };
  }, [onStatus, onSnapshot, gl, audio, slot]);

  useFrame((_, delta) => {
    const frameStarted = performance.now();
    const latest = stream.snapshots.latest;
    const predictor = prediction.current;
    if (!predictor || !latest?.snapshot.prop) return;
    const fresh = predictor.accept(latest.snapshot);
    game.current = predictor.game;
    const g = game.current,
      controls = keyboard.current;
    if (!g || !controls) return;
    if (fresh) { resetView(g); snapPoses(g); }
    const sample = stream.snapshots.sample(performance.now());
    for (const event of stream.drainProp(latest.snapshot.round, latest.snapshot.tick)) handleEvent(g, event);
    if (paused || document.hidden || delta > 0.25) {
      accumulator.current = 0;
      controls.clear();
      whistlePressed.current = false;
      feel.current.clear();
      return;
    }
    const v = view.current,
      s = scratch.current,
      round = g.round;
    // The seeker's first-person view (never while spectating: only a found hider spectates).
    const firstPerson = activeView(seekerViewNow.current, role) === "first";
    if (firstPerson !== v.firstPerson) {
      v.firstPerson = firstPerson;
      // Back to the shoulder: the boom eases out from close behind the head.
      v.boom.boom = firstPerson ? null : 0.8;
    }
    const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
    v.yaw -= dx * PROP_CAMERA.sensitivity;
    v.pitch = clampPitch(firstPerson ? PROP_CAMERA.firstPerson : tuning, v.pitch + dy * PROP_CAMERA.sensitivity);
    time.current += delta;
    accumulator.current += Math.min(delta, 0.1);
    while (accumulator.current >= PHYSICS.step) {
      for (const character of poses.current)
        for (const pose of character) {
          pose.previous.copy(pose.current);
          pose.previousQ.copy(pose.currentQ);
        }
      for (const p of props.current) {
        p.previous.copy(p.current);
        p.previousYaw = p.currentYaw;
      }
      // The local player's intent: E's press first (reading the intent clears the presses).
      const transform = controls.manager.wasActionPressed("grab");
      const raw = controls.readIntent();
      const own: MovementInput = role === "seeker" ? seekerIntent(raw, v.yaw, v.pitch, eye.current) : hiderIntent(raw, v.yaw, transform);
      own.whistle = whistlePressed.current && !inputOff;
      own.viewTick = sample ? stream.snapshots.renderMs * 60 / 1000 : latest.snapshot.tick;
      const start = performance.now();
      const packet = sendInput(inputOff ? { x: 0, z: 0, jump: false } : own);
      predictor.step(inputOff ? { x: 0, z: 0, jump: false } : own, packet);
      whistlePressed.current = false;
      readout.current.simulationMs += performance.now() - start;
      readout.current.steps++;
      for (const player of g.physics.players)
        PARTS.forEach((name, index) => {
          const pose = poses.current[player.id][index],
            body = player.parts[name].body;
          pose.current.copy(body.translation());
          pose.currentQ.copy(body.rotation());
          if (fresh) {
            pose.previous.copy(pose.current);
            pose.previousQ.copy(pose.currentQ);
          }
        });
      props.current.forEach((p, id) => {
        const worn = g.disguiseOf(id as PlayerId);
        if (!worn) {
          p.family = null;
          return;
        }
        const b = worn.body.translation();
        p.current.set(b.x, b.y - PROP_HUNT.disguise.skin, b.z);
        p.currentYaw = worn.yaw;
        if (p.family !== worn.family) {
          // Appeared this step: no interpolation from wherever it was before.
          p.family = worn.family;
          p.previous.copy(p.current);
          p.previousYaw = p.currentYaw;
        }
      });
      accumulator.current -= PHYSICS.step;
    }
    if (sample) {
      for (const { id } of PLAYERS) {
        if (id === slot) continue;
        PARTS.forEach((_name, i) => {
          const at = id * 63 + i * 7, a = sample.a.values, b = sample.b.values, p = poses.current[id][i];
          p.current.set(a[at], a[at + 1], a[at + 2]).lerp(s.v.set(b[at], b[at + 1], b[at + 2]), sample.alpha);
          p.currentQ.set(a[at + 3], a[at + 4], a[at + 5], a[at + 6]).slerp(s.q.set(b[at + 3], b[at + 4], b[at + 5], b[at + 6]), sample.alpha);
          p.previous.copy(p.current); p.previousQ.copy(p.currentQ);
        });
        const a = sample.a.snapshot.prop?.disguise[id], b = sample.b.snapshot.prop?.disguise[id], p = props.current[id];
        if (a && b && a[0] >= 0 && a[0] === b[0] && g.disguiseOf(id)?.family) {
          p.current.set(a[2], a[3] - PROP_HUNT.disguise.skin, a[4]).lerp(s.v.set(b[2], b[3] - PROP_HUNT.disguise.skin, b[4]), sample.alpha);
          p.currentYaw = a[5] + Math.atan2(Math.sin(b[5] - a[5]), Math.cos(b[5] - a[5])) * sample.alpha;
          p.previous.copy(p.current); p.previousYaw = p.currentYaw;
        }
      }
    }
    predictor.advanceVisual(delta);
    const offset = predictor.visualOffset;
    const alpha = accumulator.current / PHYSICS.step;
    visuals.update(delta);
    // ── The round's decoys (a new layout each round): drawn, and solid for the camera ──
    visuals.setDecoys(g.layout);
    if (blockers.current.layout !== g.layout) blockers.current = { layout: g.layout, value: propCameraBlockers(g.layout.colliders) };
    v.follow.decoys = g.layout.colliders;
    // ── Bodies (hidden while disguised; a found hider pops out of its prop and shrinks away) ──
    for (const player of g.physics.players) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const reveal = reveals.current[player.id];
      if (reveal.active) reveal.age += delta;
      const popping = reveal.active && reveal.age < REVEAL;
      bean.visible = !player.eliminated || popping;
      if (!bean.visible) {
        visuals.setShadow(player.id, null);
        continue;
      }
      if (popping) {
        const t = reveal.age,
          k = Math.max(0.01, 1 - (t / REVEAL) ** 1.6),
          lift = 4.5 * t - 4 * t * t;
        s.q.setFromAxisAngle(UP, reveal.yaw + t * 8);
        PARTS.forEach((name) => {
          const node = bean.getObjectByName(name)!,
            shape = SHAPES[name];
          node.position.set(shape.x, shape.y, 0).applyQuaternion(s.q).add(reveal.at);
          node.position.y += 0.9 + lift;
          node.quaternion.copy(s.q);
          if (node.scale.x !== k) node.scale.setScalar(k);
        });
        visuals.setShadow(player.id, null);
        continue;
      }
      PARTS.forEach((name, index) => {
        const node = bean.getObjectByName(name)!,
          pose = poses.current[player.id][index];
        node.position.lerpVectors(pose.previous, pose.current, alpha);
        if (player.id === slot) node.position.add(offset);
        node.quaternion.slerpQuaternions(pose.previousQ, pose.currentQ, alpha);
        if (node.scale.x !== 1) node.scale.setScalar(1);
      });
      const hips = bean.getObjectByName("pelvis")!.position,
        floor = surfaceBelow(hips.x, hips.z, hips.y);
      visuals.setShadow(player.id, Number.isFinite(floor) && hips.y - floor < 2.2 ? s.feet.set(hips.x, floor, hips.z) : null);
    }
    // Prefer the nearest surviving hider when a found player begins spectating.
    const nearestSurvivor = () => {
      const origin = g.physics.players[slot].body.translation();
      return PLAYERS.filter(p => p.id !== slot && round.alive[p.id] && p.id !== round.seeker)
        .sort((a, b) => {
          const pa = (g.disguiseOf(a.id)?.body ?? g.physics.players[a.id].body).translation();
          const pb = (g.disguiseOf(b.id)?.body ?? g.physics.players[b.id].body).translation();
          return Math.hypot(pa.x - origin.x, pa.z - origin.z) - Math.hypot(pb.x - origin.x, pb.z - origin.z);
        })[0]?.id ?? round.seeker;
    };
    if (round.alive[slot] || role === "seeker") v.spectating = null;
    else if (v.spectating === null && (!reveals.current[slot].active || reveals.current[slot].age >= REVEAL + 0.4)) {
      v.spectating = nearestSurvivor();
      v.follow.blend = 0.5;
    }
    if (v.spectating !== null && !round.alive[v.spectating]) v.spectating = nearestSurvivor();
    const focus = v.spectating ?? slot;
    const focusProp = props.current[focus];
    let pivotX: number, pivotZ: number, feet: number, lift: number, airborne: boolean;
    if (focusProp.family) {
      s.v.lerpVectors(focusProp.previous, focusProp.current, alpha);
      if (focus === slot) s.v.add(offset);
      pivotX = s.v.x;
      pivotZ = s.v.z;
      feet = s.v.y;
      lift = disguisePivot(shapeHeight(PROP_FAMILIES[focusProp.family].shape));
      airborne = !(g.disguiseOf(focus)?.grounded ?? true);
    } else {
      const reveal = reveals.current[focus];
      const node = beans.current[focus]?.getObjectByName("pelvis");
      const hips = reveal.active ? s.w.copy(reveal.at).setY(reveal.at.y + 0.78) : node ? node.position : s.w.set(0, 0.9, 0);
      pivotX = hips.x;
      pivotZ = hips.z;
      feet = hips.y - 0.78;
      lift = firstPerson ? PROP_CAMERA.firstPerson.eye : 0.78 + (v.spectating === null ? tuning.pivotHeight : PROP_CAMERA.hider.pivotHeight);
      const body = g.physics.players[focus];
      airborne = !body.eliminated && Math.abs(body.body.linvel().y) > 1.5;
    }
    const pivot = v.follow.update(pivotX, feet, pivotZ, lift, airborne, delta, firstPerson);
    // The result: the view turns gently to each hider still hidden in turn (2.4 s each), unless the player looks around.
    const frame = framing.current;
    if (round.phase === "results" && g.reveal.length) {
      frame.age += delta;
      if (dx !== 0 || dy !== 0) frame.off = true;
      const target = g.reveal[Math.floor(frame.age / 2.4) % g.reveal.length].at;
      if (!frame.off && Math.hypot(target.x - pivot.x, target.z - pivot.z) > 1) {
        const want = Math.atan2(target.x - pivot.x, target.z - pivot.z),
          turn = Math.atan2(Math.sin(want - v.yaw), Math.cos(want - v.yaw));
        v.yaw += turn * (1 - Math.exp(-delta * 3));
      }
    }
    const viewTuning: ViewTuning = firstPerson ? PROP_CAMERA.firstPerson : v.spectating === null ? tuning : PROP_CAMERA.hider;
    const boomLength = viewTuning.boom + (focusProp.family ? Math.max(0, shapeHeight(PROP_FAMILIES[focusProp.family].shape) - 1) * 0.6 : 0);
    const chest = beans.current[focus]?.getObjectByName("torso")?.position;
    const pose = firstPerson
      ? propFirstPersonPose(blockers.current.value, pivot, chest ?? pivot, v.yaw, v.pitch)
      : propCameraPose(blockers.current.value, viewTuning, boomLength, pivot, v.yaw, v.spectating === null ? v.pitch : clampPitch(PROP_CAMERA.hider, v.pitch), v.boom, delta);
    // Positional sound is heard from the followed player's head, facing where the camera looks.
    listener.current = { x: pivot.x, y: pivot.y, z: pivot.z };
    audio.setListener(pivot, pose.look);
    v.lastBoom = pose.boom;
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.lookAt(pose.position.x + pose.look.x, pose.position.y + pose.look.y, pose.position.z + pose.look.z);
    if (role === "seeker" && v.kick > 0.001) {
      camera.rotateX(firstPerson ? v.kick * 0.5 : v.kick);
      v.kick *= Math.exp(-delta / 0.07);
    }
    const [shakeX, shakeY] = feel.current.step(delta, shakeEnabled);
    camera.position.x += shakeX;
    camera.position.y += shakeY;
    if (Math.abs(viewTuning.fov - v.fov) > 0.02) {
      v.fov = viewTuning.fov;
      const perspective = camera as PerspectiveCamera;
      perspective.fov = v.fov;
      perspective.updateProjectionMatrix();
    }
    // The seeker's crosshair line, as a point near the shoulder relative to the pelvis (bounded by the simulation).
    const seekerBody = g.physics.players[round.seeker].body.translation();
    if (role === "seeker") {
      const t = Math.max(0, (pose.shoulder.x - pose.position.x) * pose.look.x + (pose.shoulder.y - pose.position.y) * pose.look.y + (pose.shoulder.z - pose.position.z) * pose.look.z);
      eye.current = { x: pose.position.x + pose.look.x * t - seekerBody.x, y: pose.position.y + pose.look.y * t - seekerBody.y, z: pose.position.z + pose.look.z * t - seekerBody.z };
    }
    // Pressed against a wall the camera is close to its subject: fade it instead of filling the screen (first person: the parts round the eye are not drawn at all).
    const fade = firstPerson ? 1 : ownOpacity(pose.boom);
    const ownBean = beans.current[slot];
    if (ownBean) for (const name of FIRST_PERSON_HIDDEN) {
      const part = ownBean.getObjectByName(name);
      if (part && part.visible === firstPerson) part.visible = !firstPerson;
    }
    const ownSkin = (beans.current[focus]?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
    if (ownSkin) {
      const transparent = fade < 0.999 && !focusProp.family;
      if (ownSkin.transparent !== transparent) {
        ownSkin.transparent = transparent;
        ownSkin.depthWrite = !transparent;
        ownSkin.needsUpdate = true;
      }
      ownSkin.opacity = transparent ? fade : 1;
    }
    // ── Disguises ──
    props.current.forEach((p, id) => {
      if (!p.family) return visuals.setDisguise(id, null, null, 0, false);
      s.v.lerpVectors(p.previous, p.current, alpha);
      if (id === slot) s.v.add(offset);
      const yaw = p.previousYaw + Math.atan2(Math.sin(p.currentYaw - p.previousYaw), Math.cos(p.currentYaw - p.previousYaw)) * alpha;
      visuals.setDisguise(id, p.family, s.v, yaw, id === focus, id === focus ? fade : 1);
    });
    // ── The result's reveal: the hiders still hidden, outlined through walls, a label over each ──
    const labels = hud.current.reveals,
      width = gl.domElement.clientWidth,
      height = gl.domElement.clientHeight;
    for (const { id } of PLAYERS) {
      const r = round.phase === "results" ? g.reveal.find((x) => x.id === id) : undefined,
        label = labels[id];
      if (!r) {
        visuals.setReveal(id, undefined, null, 0, time.current);
        if (label && label.dataset.shown !== "false") label.dataset.shown = "false";
        continue;
      }
      s.v.set(r.at.x, r.at.y, r.at.z);
      visuals.setReveal(id, r.family, s.v, r.yaw, time.current);
      if (!label) continue;
      s.w.set(r.at.x, r.at.y + (r.family ? shapeHeight(PROP_FAMILIES[r.family].shape) : 1.95) + 0.45, r.at.z).project(camera);
      const shown = s.w.z < 1 && Math.abs(s.w.x) < 1.2 && Math.abs(s.w.y) < 1.2;
      if (label.dataset.shown !== String(shown)) label.dataset.shown = String(shown);
      // Kept whole on screen (its own width), pointing at the prop.
      const half = label.offsetWidth / 2 + 8;
      if (shown) label.style.transform = `translate(${Math.round(Math.max(half, Math.min(width - half, ((s.w.x + 1) / 2) * width)))}px, ${Math.round(Math.max(label.offsetHeight + 12, Math.min(height - 20, ((1 - s.w.y) / 2) * height)))}px) translate(-50%, -100%)`;
    }
    // ── The seeker's blaster, pointed along its aim (the local seeker's at what the crosshair is on) ──
    const seekerBean = beans.current[round.seeker],
      torso = seekerBean?.getObjectByName("torso");
    let blocked = false;
    if (torso && seekerBean?.visible && round.phase !== "countdown") {
      const seekerChar = g.physics.players[round.seeker],
        facing = seekerChar.facing;
      s.grip.copy(GRIP).applyQuaternion(s.q.setFromAxisAngle(UP, facing)).add(torso.position);
      const own = role === "seeker";
      const pitch = own ? v.pitch : 0.2;
      s.grip.y += Math.max(-0.3, Math.min(0.3, -Math.sin(pitch) * 0.45));
      s.e.set(pitch, own ? v.yaw : facing, 0, "YXZ");
      if (own && round.phase === "search") {
        const aim = g.aim({ x: 0, z: 0, jump: false, facing: v.yaw, aimPitch: v.pitch, aimEye: eye.current ?? undefined });
        const d = s.w.set(aim.point.x, aim.point.y, aim.point.z).sub(s.grip);
        if (d.length() > 1.2) {
          d.normalize();
          s.e.set(-Math.asin(Math.max(-1, Math.min(1, d.y))), Math.atan2(d.x, d.z), 0, "YXZ");
        }
        // The body's line to what the crosshair is on is blocked by something closer: a red X.
        const shot = g.cast(aim.origin, aim.direction, PROP_HUNT.seeker.range, round.seeker);
        const toPoint = Math.hypot(aim.point.x - aim.origin.x, aim.point.y - aim.origin.y, aim.point.z - aim.origin.z);
        blocked = !!shot && shot.distance < toPoint - 0.35;

      }
      s.aim.setFromEuler(s.e);
      if (own && firstPerson) {
        // First person: a view model low on the right, along the view (it moves with the camera).
        s.grip.copy(VIEW_GRIP).applyQuaternion(camera.quaternion).add(camera.position);
        s.aim.copy(camera.quaternion).multiply(TURN_AROUND);
      }
      visuals.setBlaster(s.grip, s.aim, v.kick * 8);
    } else visuals.setBlaster(null, s.aim, 0);
    visuals.setViewModel(firstPerson);
    // ── The decoy the local hider would copy (a ring under it) ──
    const r = readout.current;
    r.pickIn -= delta;
    const canPick = role === "hider" && round.alive[slot] && !g.disguiseOf(slot) && (round.phase === "hiding" || round.phase === "search");
    if (r.pickIn <= 0) {
      r.pickIn = 0.1;
      const found = canPick ? g.nearestDecoy(slot) : null;
      pick.current = found ? { index: found.index } : null;
    }
    if (canPick && pick.current) {
      const d = g.decoys[pick.current.index];
      visuals.setTarget(s.feet.set(d.x, d.y, d.z), d.family, time.current);
    } else visuals.setTarget(null, null, time.current);
    // ── Per-frame HUD: timer, prompt, crosshair, the blindfold ──
    const { timer, bar, prompt, crosshair, blind, blindTime } = hud.current;
    const remaining = Math.max(0, round.remaining - Math.min(0.3, (performance.now() - latest.received) / 1000));
    const phaseLength = round.phase === "hiding" ? PROP_HUNT.timing.hiding : round.phase === "search" ? PROP_HUNT.timing.search : 1;
    if (timer) timer.textContent = round.phase === "hiding" || round.phase === "search" ? (remaining < 10 ? remaining.toFixed(1) : String(Math.ceil(remaining))) : "";
    if (bar) bar.style.transform = `scaleX(${round.phase === "hiding" || round.phase === "search" ? remaining / phaseLength : 0})`;
    if (timer?.parentElement) timer.parentElement.dataset.panic = round.phase === "search" && remaining <= 10 ? "true" : "false";
    if (prompt) {
      const E = "E";
      const worn = g.disguiseOf(slot);
      const text = !canPick && !(worn && round.alive[slot])
        ? ""
        : worn
        ? `${E}: kılıktan çık`
        : pick.current
        ? `${E}: ${PROP_FAMILIES[g.decoys[pick.current.index].family].name} ol`
        : "Bir eşyanın yanına git";
      if (prompt.textContent !== text) prompt.textContent = text;
      prompt.dataset.ready = pick.current || worn ? "true" : "false";
    }
    if (crosshair) {
      const shown = role === "seeker" && round.phase === "search" ? "true" : "false";
      if (crosshair.dataset.shown !== shown) crosshair.dataset.shown = shown;
      const flag = blocked ? "true" : "false";
      if (crosshair.dataset.blocked !== flag) crosshair.dataset.blocked = flag;
    }
    if (blind) {
      const blinded = role === "seeker" && round.phase === "hiding";
      if (blind.dataset.shown !== String(blinded)) blind.dataset.shown = String(blinded);
      if (blindTime && blinded) blindTime.textContent = String(Math.ceil(remaining));
    }
    publish(g);
    // ── Debug readout (10 Hz) and performance (2 s) ──
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
    debug.textContent = `${Math.round(r.fps)} FPS · ${gl.info.render.calls} çizim · ${gl.info.render.triangles} üçgen\n${role} · ${round.phase} · ${g.layout.id} · tohum ${latest.snapshot.prop.seed} · mermi ${g.ammo}\nSnapshot ${(performance.now() - latest.received).toFixed(0)} ms · düzeltme ${predictor.correction.toFixed(3)} m · tahmin ${predictor.stepMs.toFixed(2)} ms`;
    debug.dataset.prop = JSON.stringify({ role, phase: round.phase, layout: g.layout.id, seed: latest.snapshot.prop.seed, ammo: g.ammo, alive: round.alive, slot, disguise: g.disguiseOf(slot)?.family ?? null, correction: predictor.correction, fps: r.fps, calls: gl.info.render.calls, triangles: gl.info.render.triangles, jsMs: performance.now() - frameStarted, predictionMs: predictor.stepMs, snapshotAge: performance.now() - latest.received, view: seekerViewNow.current, yaw: v.yaw * 180 / Math.PI, pitch: v.pitch * 180 / Math.PI, spectating: v.spectating, eye: { ...eye.current } });
  });

  /** One simulation event's presentation (sounds come from the game's feedback). */
  function handleEvent(g: PropHuntGame, e: PropOnlineEvent) {
    const s = scratch.current;
    if (e.type === "disguise") {
      log.current.disguises++;
      visuals.poof(s.v.set(e.at.x, e.at.y, e.at.z));
      if (e.id === slot) callout(`${PROP_FAMILIES[e.family].name} oldun`, "info", true);
    } else if (e.type === "undisguise") {
      visuals.poof(s.v.set(e.at.x, e.at.y, e.at.z));
    } else if (e.type === "refused") {
      log.current.refusals++;
      if (e.id === slot && e.why !== "cooldown") callout(REFUSALS[e.why], "warn", true);
    } else if (e.type === "shot") {
      audio.playSfx({ name: "smgFire", actor: e.shooter });
      log.current.shots++;
      const own = e.shooter === slot;
      if (own) view.current.kick = Math.min(0.06, view.current.kick + 0.03);
      // The tracer leaves the blaster's muzzle (presentation), ends where the simulation's shot stopped.
      const muzzle = visuals.blaster.visible ? s.muzzle.set(0, 0.21, BLASTER_MUZZLE).multiplyScalar(visuals.blaster.scale.x).applyQuaternion(visuals.blaster.quaternion).add(visuals.blaster.position) : s.muzzle.set(e.origin.x, e.origin.y, e.origin.z);
      visuals.shot(muzzle, s.w.set(e.end.x, e.end.y, e.end.z), e.hit);
      lastShot.current = { hit: e.hit, target: e.target, decoy: e.decoy, ammo: e.ammo, end: [e.end.x, e.end.y, e.end.z].map((n) => Math.round(n * 100) / 100), tick: g.round.tick };
      if (own && e.hit === "decoy") callout("Boş!", "miss", true);
    } else if (e.type === "found") {
      audio.playSfx({ name: "death", actor: e.id });
      log.current.finds++;
      const reveal = reveals.current[e.id];
      reveal.active = true;
      reveal.age = 0;
      reveal.at.set(e.at.x, e.at.y, e.at.z);
      reveal.yaw = e.yaw;
      visuals.reveal(reveal.at);
      if (e.id === slot) callout("BULUNDUN!", "found");
      else callout(e.by === slot ? "BULDUN!" : "BULUNDU!", "found");
    } else if (e.type === "dry") {
      if (e.shooter === slot) callout("Mermi yok", "warn", true);
    } else if (e.type === "whistleCooldown") {
      if (e.id === slot) callout("Islık hazır değil", "info", true);
    } else if (e.type === "whistle") {
      // Heard where the hider is: panned and faded by distance, muffled through walls — no marker.
      const l = listener.current,
        dx = e.at.x - l.x,
        dy = e.at.y - l.y,
        dz = e.at.z - l.z,
        d = Math.hypot(dx, dy, dz);
      let muffled = false;
      if (d > 0.5) {
        ray.origin = l;
        ray.dir = { x: dx / d, y: dy / d, z: dz / d };
        muffled = !!g.physics.world.castRay(ray, d - 0.3, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined);
      }
      whistles.current.push({ muffled, distance: Math.round(d * 10) / 10 });
      audio.playSpatial("propWhistle", WHISTLE_RECIPE, e.at, { ...WHISTLE_AUDIO, muffle: muffled ? WHISTLE_MUFFLE : null });
    } else if (e.type === "near" && role === "seeker" && proximityNow.current) {
      // The hunch: a line and an even glow that fade, a soft heartbeat in the middle of the mix — no who, where or how far.
      senses.current.push(Math.round(g.round.tick / 6) / 10);
      hunch();
      audio.playSpatial("propSense", SENSE_RECIPE, listener.current, SENSE_AUDIO);
    }
  }
  /** The hunch's text and glow: fade in, a two-beat pulse, fade out (≈ 2 s; nothing stays on screen). */
  function hunch() {
    const { sense, senseGlow } = hud.current;
    for (const element of [sense, senseGlow]) element?.getAnimations().forEach((a) => a.cancel());
    sense?.animate(
      [
        { opacity: 0, transform: "translate(-50%, 6px)" },
        { opacity: 1, transform: "translate(-50%, 0)", offset: 0.15 },
        { opacity: 1, transform: "translate(-50%, 0)", offset: 0.6 },
        { opacity: 0, transform: "translate(-50%, -4px)" },
      ],
      { duration: 2000, easing: "ease-out", fill: "forwards" }
    );
    senseGlow?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0.35, offset: 0.24 }, { opacity: 0.85, offset: 0.36 }, { opacity: 0 }], { duration: 1500, easing: "ease-out", fill: "forwards" });
  }

  return (
    <>
      <PropEnvironment />
      <group ref={scenery} name="prop-kit">
        <PropHuntScenery onKit={onKit} />
      </group>
      <primitive object={visuals.group} />
      {PLAYERS.map((player) => (
        <PlayerBean
          key={player.id}
          color={player.color}
          costume={playerCostumeAtSlot(lobby.players, player.id)}
          ref={(bean) => {
            beans.current[player.id] = bean;
          }}
        />
      ))}
    </>
  );
}
