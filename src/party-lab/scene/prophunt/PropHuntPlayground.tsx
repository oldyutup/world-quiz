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
import { IDLE_INPUT, initializePhysics, PHYSICS } from "../physics";
import { PLAYERS, type PlayerId } from "../players";
import { PARTS, SHAPES } from "../ragdoll/config";
import { localCostumeForSlot, type SelectableCostumeId } from "../visual/costumes";
import { surfaceBelow, type PropRole } from "../../../../shared/party-lab/maps/propHunt";
import type { PropLayout } from "../../../../shared/party-lab/maps/propHuntLayout";
import { PROP_FAMILIES, shapeHeight, type PropFamilyId } from "../../../../shared/party-lab/maps/propHuntProps";
import { PROP_HUNT } from "../../../../shared/party-lab/simulation/prophunt/config";
import type { PropOutcome, PropPhase, PropResult } from "../../../../shared/party-lab/simulation/prophunt/round";
import { buildPropArena } from "./arena";
import { HiderBot, SeekerBot, propNav } from "./bots";
import { hiderIntent, seekerIntent, whistleKey } from "./controls";
import { PropHuntGame, type PropHuntEvent } from "./game";
import { activeView, clampPitch, disguisePivot, FIRST_PERSON_HIDDEN, ownOpacity, PROP_CAMERA, propCameraBlockers, propCameraPose, propFirstPersonPose, PropFollow, toggledView, VIEW_KEY, type SeekerView, type ViewTuning } from "./propCamera";
import PropHuntScenery from "./PropHuntScenery";
import type { PropKit } from "./scenery";
import { BLASTER_MUZZLE, PropVisuals } from "./visuals";
import { SENSE_AUDIO, SENSE_RECIPE, WHISTLE_AUDIO, WHISTLE_MUFFLE, WHISTLE_RECIPE } from "./whistle";

/** What the React HUD shows; republished only when it changes. */
export interface PropSnapshot {
  phase: PropPhase;
  /** Whole seconds left in the phase. */
  seconds: number;
  /** The local player's role, and everyone's. */
  role: PropRole;
  roles: PropRole[];
  alive: boolean[];
  /** The local player's disguise (null: none). */
  disguise: PropFamilyId | null;
  ammo: number;
  hidden: number;
  outcome: PropOutcome | null;
  reason: PropResult | null;
  /** Search seconds elapsed when the round was decided. */
  endedAt: number;
  /** Who the camera follows while the local player is out (null: themself). */
  spectating: PlayerId | null;
  shots: number;
  decoyHits: number;
  /** At the result: the hiders still hidden and what they were (empty otherwise). */
  reveal: { id: PlayerId; family: PropFamilyId | null }[];
}
/** Imperative per-frame DOM (no React re-renders). */
export interface PropHudElements {
  debug: HTMLElement | null;
  timer: HTMLElement | null;
  bar: HTMLElement | null;
  callout: HTMLElement | null;
  prompt: HTMLElement | null;
  crosshair: HTMLElement | null;
  blind: HTMLElement | null;
  blindTime: HTMLElement | null;
  /** The seeker's hunch: a line of text and an even glow round the screen's edge (never a direction). */
  sense: HTMLElement | null;
  senseGlow: HTMLElement | null;
  /** Per slot: the result's label over a hider still hidden. */
  reveals: (HTMLElement | null)[];
}
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
 * Local Saklambaç: the human (seeker or hider, chosen in the Esc menu) with bots in the other
 * roles, in Orman Kampı. Shared with the other modes: the ragdoll and the look/keyboard input.
 */
export default function PropHuntPlayground({
  role,
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
  view: seekerView,
  onView,
  proximityEnabled,
}: {
  role: PropRole;
  onStatus: (status: ArenaStatus) => void;
  onSnapshot: (snapshot: PropSnapshot) => void;
  hud: MutableRefObject<PropHudElements>;
  bindings: Bindings;
  /** The arena is hidden (lobby-level settings): the simulation stops. */
  paused: boolean;
  /** The Esc menu is open: only this player's input stops; the round and bots go on. */
  menuOpen: boolean;
  audio: AudioManager;
  shakeEnabled: boolean;
  costumeId: SelectableCostumeId;
  look: MutableRefObject<LookController | null>;
  /** `?propDebug=1`: the debug keys (H bots hold still, K skip time, G scenery). */
  tools: boolean;
  /** The seeker's camera (the hiders are always third person). */
  view: SeekerView;
  /** V asks for the other view (the choice lives with the arena, like the Esc menu's). */
  onView: (view: SeekerView) => void;
  proximityEnabled: boolean;
}) {
  const { camera, gl } = useThree();
  const beans = useRef<(Group | null)[]>([]);
  const game = useRef<PropHuntGame | null>(null);
  const bots = useRef<{ id: PlayerId; bot: HiderBot | SeekerBot }[]>([]);
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
  const roles: PropRole[] = useMemo(() => (role === "seeker" ? ["seeker", "hider", "hider"] : ["hider", "hider", "seeker"]), [role]);
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
  const whistles = useRef<{ id: PlayerId; muffled: boolean; distance: number }[]>([]);
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
  const holdBots = useRef(false);
  /** The result's camera: how long the reveal has been shown, and whether the player took the view back. */
  const framing = useRef({ age: 0, off: false });
  const scenery = useRef<Group | null>(null);
  /** The crosshair's aim-line point relative to the seeker's pelvis (sent with the shot). */
  const eye = useRef<{ x: number; y: number; z: number } | null>(null);
  /** The decoy the local hider would copy (refreshed ~10×/s). */
  const pick = useRef<{ index: number } | null>(null);
  const lastShot = useRef<Record<string, unknown> | null>(null);
  /** What the local seeker's shot would hit now (debug readout). */
  const aimHit = useRef<{ hit: string; target: PlayerId | null; decoy: number | null } | null>(null);
  const log = useRef({ disguises: 0, refusals: 0, shots: 0, finds: 0 });
  const onKit = useCallback((kit: PropKit | null) => visuals.setKit(kit), [visuals]);

  const snapshotOf = (g: PropHuntGame): PropSnapshot => ({
    phase: g.round.phase,
    seconds: g.round.seconds,
    role,
    roles: [...g.roles],
    alive: [...g.round.alive],
    disguise: g.disguiseOf(0)?.family ?? null,
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
    const key = `${g.round.revision}|${g.disguiseOf(0)?.family ?? "-"}|${g.ammo}|${view.current.spectating}|${g.reveal.length}`;
    if (key === published.current.key) return;
    published.current.key = key;
    onSnapshot(snapshotOf(g));
  };
  const resetView = (g: PropHuntGame) => {
    const { yaw } = g.spawnOf(0);
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
      if (g.hidden(0) && (g.round.phase === "hiding" || g.round.phase === "search") && event.code === whistleKey(bindingsNow.current) && !event.repeat) {
        event.preventDefault();
        whistlePressed.current = true;
        return;
      }
      // V: the seeker's camera, shoulder ↔ first person (unless V is bound to an action). Pointer Lock stays as it is.
      if (event.code === VIEW_KEY && !bound && !event.repeat && role === "seeker") {
        onViewNow.current(toggledView(seekerViewNow.current, role));
        return;
      }
      // A debug key never shadows a gameplay binding.
      const debugKey = tools && !bound;
      if (debugKey && event.code === "KeyH") {
        holdBots.current = !holdBots.current;
        return;
      }
      if (debugKey && event.code === "KeyK") {
        // Skip ahead: the rest of the hiding, or 10 s of the search.
        if (g.round.phase === "hiding") g.round.tick = Math.max(g.round.tick, 60 * (PROP_HUNT.timing.hiding - 0.5));
        else if (g.round.phase === "search") g.round.tick = Math.min(60 * PROP_HUNT.timing.search - 30, g.round.tick + 600);
        return;
      }
      if (debugKey && event.code === "KeyG") {
        if (scenery.current) scenery.current.visible = !scenery.current.visible;
        visuals.decoys.visible = scenery.current?.visible ?? !visuals.decoys.visible;
        return;
      }
      // Spectating (found): Q / E cycle through everyone still playing.
      if (event.code !== "KeyQ" && event.code !== "KeyE") return;
      if (g.round.alive[0] || g.round.phase !== "search") return;
      const watchable = PLAYERS.map((p) => p.id).filter((id) => id !== 0 && (g.roles[id] === "seeker" || g.round.alive[id]));
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
        // A fresh match seed per arena visit: every round deals its decoy layout from it.
        const g = new PropHuntGame(
          (event) => {
            audio.playSfx(event);
            feel.current.trigger(event);
          },
          { roles, seed: (Math.random() * 0x100000000) >>> 0 }
        );
        game.current = g;
        // `?propDebug=1` only: the running game for browser test harnesses (scenario set-up).
        if (tools) (window as unknown as { __propGame?: PropHuntGame }).__propGame = g;
        propNav();
        bots.current = PLAYERS.filter((p) => p.id !== 0).map((p) => ({ id: p.id, bot: roles[p.id] === "seeker" ? new SeekerBot(p.id) : new HiderBot(p.id) }));
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
      window.removeEventListener("blur", clearWhistle);
      audio.stopAll();
      feel.current.clear();
      controls.dispose();
      keyboard.current = null;
      game.current?.dispose();
      game.current = null;
      if (tools) delete (window as unknown as { __propGame?: PropHuntGame }).__propGame;
    };
  }, [onStatus, onSnapshot, gl, audio, roles]);

  useFrame((_, delta) => {
    const g = game.current,
      controls = keyboard.current;
    if (!g || !controls) return;
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
      const inputs: MovementInput[] = [own, IDLE_INPUT, IDLE_INPUT];
      for (const { id, bot } of bots.current) inputs[id] = holdBots.current ? IDLE_INPUT : bot.update(g);
      const start = performance.now();
      const event = g.step(inputs, whistlePressed.current && !inputOff ? [0] : []);
      whistlePressed.current = false;
      readout.current.simulationMs += performance.now() - start;
      readout.current.steps++;
      if (event) controls.clear();
      for (const e of g.events) handleEvent(g, e);
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
      if (event === "reset") {
        bots.current.forEach(({ bot }) => bot.reset());
        resetView(g);
      }
      if (event === "search" && role === "seeker") callout("ARA!", "info");
      if (event === "finished") {
        if (round.reason === "ammo" && role === "seeker") callout("MERMİN BİTTİ!", "warn");
        else callout(round.outcome === (role === "seeker" ? "seeker" : "hiders") ? "KAZANDIN!" : "KAYBETTİN", "win");
        framing.current = { age: 0, off: false };
      }
      accumulator.current -= PHYSICS.step;
    }
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
        node.quaternion.slerpQuaternions(pose.previousQ, pose.currentQ, alpha);
        if (node.scale.x !== 1) node.scale.setScalar(1);
      });
      const hips = bean.getObjectByName("pelvis")!.position,
        floor = surfaceBelow(hips.x, hips.z, hips.y);
      visuals.setShadow(player.id, Number.isFinite(floor) && hips.y - floor < 2.2 ? s.feet.set(hips.x, floor, hips.z) : null);
    }
    // ── Who the camera follows ──
    if (round.alive[0] || role === "seeker") v.spectating = null;
    else if (v.spectating === null && !reveals.current[0].active) v.spectating = round.seeker;
    else if (v.spectating === null && reveals.current[0].age >= REVEAL + 0.4) {
      v.spectating = round.seeker;
      v.follow.blend = 0.5;
    }
    if (v.spectating !== null && v.spectating !== round.seeker && !round.alive[v.spectating]) v.spectating = round.seeker;
    const focus = v.spectating ?? 0;
    const focusProp = props.current[focus];
    let pivotX: number, pivotZ: number, feet: number, lift: number, airborne: boolean;
    if (focusProp.family) {
      s.v.lerpVectors(focusProp.previous, focusProp.current, alpha);
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
    const ownBean = beans.current[0];
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
      const bot = bots.current.find((b) => b.id === round.seeker)?.bot as SeekerBot | undefined;
      const pitch = own ? v.pitch : bot?.input.aimPitch ?? 0.2;
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
        aimHit.current = shot ? { hit: shot.hit, target: shot.target, decoy: shot.decoy } : null;
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
    const canPick = role === "hider" && round.alive[0] && !g.disguiseOf(0) && (round.phase === "hiding" || round.phase === "search");
    if (r.pickIn <= 0) {
      r.pickIn = 0.1;
      const found = canPick ? g.nearestDecoy(0) : null;
      pick.current = found ? { index: found.index } : null;
    }
    if (canPick && pick.current) {
      const d = g.decoys[pick.current.index];
      visuals.setTarget(s.feet.set(d.x, d.y, d.z), d.family, time.current);
    } else visuals.setTarget(null, null, time.current);
    // ── Per-frame HUD: timer, prompt, crosshair, the blindfold ──
    const { timer, bar, prompt, crosshair, blind, blindTime } = hud.current;
    const remaining = round.remaining;
    const phaseLength = round.phase === "hiding" ? PROP_HUNT.timing.hiding : round.phase === "search" ? PROP_HUNT.timing.search : 1;
    if (timer) timer.textContent = round.phase === "hiding" || round.phase === "search" ? (remaining < 10 ? remaining.toFixed(1) : String(Math.ceil(remaining))) : "";
    if (bar) bar.style.transform = `scaleX(${round.phase === "hiding" || round.phase === "search" ? remaining / phaseLength : 0})`;
    if (timer?.parentElement) timer.parentElement.dataset.panic = round.phase === "search" && remaining <= 10 ? "true" : "false";
    if (prompt) {
      const E = "E";
      const worn = g.disguiseOf(0);
      const text = !canPick && !(worn && round.alive[0])
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
    const me = g.physics.players[0].body.translation(),
      round2 = (n: number) => Math.round(n * 100) / 100,
      name = (id: PlayerId) => `${PLAYERS[id].label} (${g.roles[id] === "seeker" ? "arayan" : "saklanan"})`;
    const disguiseText = PLAYERS.map((p) => {
      const w = g.disguiseOf(p.id);
      return w ? `${p.label}: ${PROP_FAMILIES[w.family].name}` : null;
    })
      .filter(Boolean)
      .join(" · ");
    const whistleText = g.round.hiders.map((id) => `${PLAYERS[id].label} ${g.whistles[id]}×`).join(" · ");
    const lines = [
      `Tur: ${round.phase} · ${remaining.toFixed(1)} sn · rol ${role === "seeker" ? "Arayan" : "Saklanan"} · mermi ${g.ammo}/${PROP_HUNT.seeker.ammo} · saklı ${round.hidden.length}/2`,
      `Düzen: tur ${g.layoutRound + 1} · tohum ${g.layout.seed ?? "sabit"} · kimlik ${g.layout.id} · ${g.decoys.length} eşya · ${g.layout.active.length} tür · değişen ${g.layoutChanged === null ? "—" : `%${Math.round(g.layoutChanged * 100)}`}`,
      `Islık: ${whistleText} · sezgi ${g.sense.pulses} kez (${g.sense.armed ? "hazır" : "alandan çık"}) · kamera ${activeView(seekerViewNow.current, role) === "first" ? "birinci şahıs" : "omuz"}`,
      `Kılıklar: ${disguiseText || "—"}${pick.current ? ` · yakın eşya ${PROP_FAMILIES[g.decoys[pick.current.index].family].name} #${pick.current.index}` : ""}`,
      `Botlar: ${bots.current.map(({ id, bot }) => `${name(id)} ${bot.mode}`).join(" · ")}${holdBots.current ? " · DURDURULDU" : ""}`,
      `Konum: x ${me.x.toFixed(2)} · y ${(me.y - 0.78).toFixed(2)} · z ${me.z.toFixed(2)} · kamera ${pose.boom.toFixed(1)} m · eğim ${Math.round((v.pitch * 180) / Math.PI)}°`,
      `${Math.round(r.fps)} FPS · ${r.physicsMs.toFixed(2)} ms adım · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · ${g.physics.map.colliders.length} statik`,
      ...(tools ? [`Hata ayıklama: H botlar ${holdBots.current ? "duruyor" : "oynuyor"} · K süre atla · G dekor (${scenery.current?.visible === false ? "kapalı" : "açık"})`] : []),
    ];
    debug.textContent = lines.join("\n");
    debug.dataset.prop = JSON.stringify({
      phase: round.phase,
      tick: round.tick,
      remaining: round2(remaining),
      role,
      roles: g.roles,
      alive: round.alive,
      ammo: g.ammo,
      hidden: round.hidden,
      outcome: round.outcome,
      reason: round.reason,
      endedAt: round.endedAt,
      layout: { round: g.layoutRound, seed: g.layout.seed, id: g.layout.id, decoys: g.decoys.length, active: g.layout.active, changed: g.layoutChanged === null ? null : round2(g.layoutChanged), scenes: g.layout.scenes },
      reveal: g.reveal,
      whistles: g.whistles,
      manualWhistles: g.manualWhistles,
      manualWhistleCooldown: g.manualWhistleCooldown,
      heard: whistles.current,
      sense: { pulses: g.sense.pulses, armed: g.sense.armed, outside: g.sense.outside, dwell: g.sense.dwell, felt: senses.current, enabled: proximityEnabled },
      view: activeView(seekerViewNow.current, role),
      camera: [camera.position.x, camera.position.y, camera.position.z].map(round2),
      fov: Math.round((camera as PerspectiveCamera).fov),
      ownHead: beans.current[0]?.getObjectByName("head")?.visible ?? null,
      disguises: PLAYERS.map((p) => {
        const w = g.disguiseOf(p.id);
        if (!w) return null;
        const b = w.body.translation();
        return { family: w.family, at: [b.x, b.y, b.z].map(round2), yaw: round2(w.yaw), grounded: w.grounded, travelled: round2(w.travelled) };
      }),
      players: g.physics.players.map((c) => {
        const at = c.body.translation();
        return [at.x, at.y - 0.78, at.z].map(round2).concat(c.eliminated ? 0 : 1);
      }),
      me: { pos: [me.x, me.y - 0.78, me.z].map(round2), feet: round2(g.feet(g.physics.players[0])) },
      pick: pick.current,
      bots: bots.current.map(({ id, bot }) => ({ id, mode: bot.mode, target: bot instanceof SeekerBot ? bot.target : (bot as HiderBot).spot?.family ?? null })),
      yaw: Math.round((v.yaw * 180) / Math.PI),
      pitch: Math.round((v.pitch * 180) / Math.PI),
      boom: round2(pose.boom),
      spectating: v.spectating,
      blocked,
      aim: aimHit.current,
      stats: g.stats,
      log: log.current,
      lastShot: lastShot.current,
      toggleCooldown: g.toggleCooldown,
      fps: Math.round(r.fps),
      physicsMs: Math.round(r.physicsMs * 1000) / 1000,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      colliders: g.physics.map.colliders.length,
      holdBots: holdBots.current,
      scenery: scenery.current?.visible !== false,
    });
  });

  /** One simulation event's presentation (sounds come from the game's feedback). */
  function handleEvent(g: PropHuntGame, e: PropHuntEvent) {
    const s = scratch.current;
    if (e.type === "disguise") {
      log.current.disguises++;
      visuals.poof(s.v.set(e.at.x, e.at.y, e.at.z));
      if (e.id === 0) callout(`${PROP_FAMILIES[e.family].name} oldun`, "info", true);
    } else if (e.type === "undisguise") {
      visuals.poof(s.v.set(e.at.x, e.at.y, e.at.z));
    } else if (e.type === "refused") {
      log.current.refusals++;
      if (e.id === 0 && e.why !== "cooldown") callout(REFUSALS[e.why], "warn", true);
    } else if (e.type === "shot") {
      log.current.shots++;
      const own = e.shooter === 0;
      if (own) view.current.kick = Math.min(0.06, view.current.kick + 0.03);
      // The tracer leaves the blaster's muzzle (presentation), ends where the simulation's shot stopped.
      const muzzle = visuals.blaster.visible ? s.muzzle.set(0, 0.21, BLASTER_MUZZLE).multiplyScalar(visuals.blaster.scale.x).applyQuaternion(visuals.blaster.quaternion).add(visuals.blaster.position) : s.muzzle.set(e.origin.x, e.origin.y, e.origin.z);
      visuals.shot(muzzle, s.w.set(e.end.x, e.end.y, e.end.z), e.hit);
      lastShot.current = { hit: e.hit, target: e.target, decoy: e.decoy, ammo: e.ammo, end: [e.end.x, e.end.y, e.end.z].map((n) => Math.round(n * 100) / 100), tick: g.round.tick };
      if (own && e.hit === "decoy") callout("Boş!", "miss", true);
    } else if (e.type === "found") {
      log.current.finds++;
      const reveal = reveals.current[e.id];
      reveal.active = true;
      reveal.age = 0;
      reveal.at.set(e.at.x, e.at.y, e.at.z);
      reveal.yaw = e.yaw;
      visuals.reveal(reveal.at);
      if (e.id === 0) callout("BULUNDUN!", "found");
      else callout(e.by === 0 ? "BULDUN!" : "BULUNDU!", "found");
    } else if (e.type === "dry") {
      if (e.shooter === 0) callout("Mermi yok", "warn", true);
    } else if (e.type === "whistleCooldown") {
      if (e.id === 0) callout("Islık hazır değil", "info", true);
    } else if (e.type === "whistle") {
      // Heard where the hider is: panned and faded by distance, muffled through walls — no marker.
      const l = listener.current,
        dx = e.at.x - l.x,
        dy = e.at.y - l.y,
        dz = e.at.z - l.z,
        d = Math.hypot(dx, dy, dz),
        own = g.disguiseOf(e.id)?.collider.handle;
      let muffled = false;
      if (d > 0.5) {
        ray.origin = l;
        ray.dir = { x: dx / d, y: dy / d, z: dz / d };
        muffled = !!g.physics.world.castRay(ray, d - 0.3, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined, (collider) => collider.handle !== own);
      }
      whistles.current.push({ id: e.id, muffled, distance: Math.round(d * 10) / 10 });
      audio.playSpatial("propWhistle", WHISTLE_RECIPE, e.at, { ...WHISTLE_AUDIO, muffle: muffled ? WHISTLE_MUFFLE : null });
    } else if (e.type === "near" && e.seeker === 0 && proximityNow.current) {
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
          costume={localCostumeForSlot(costumeId, player.id)}
          ref={(bean) => {
            beans.current[player.id] = bean;
          }}
        />
      ))}
    </>
  );
}
