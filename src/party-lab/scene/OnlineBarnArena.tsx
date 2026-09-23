import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import RAPIER from "@dimforge/rapier3d-compat";
import { Euler, Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from "three";
import Arena from "./Arena";
import PlayerBean from "./PlayerBean";
import { playerCostumeAtSlot } from "./visual/costumes";
import { PLAYERS, type PlayerId } from "./players";
import { PARTS } from "./ragdoll/config";
import { bindKeyboard } from "../input/keyboard";
import { actionBindingLabel, type Bindings } from "../input/bindings";
import { ACTIONS, ACTION_LABELS, BARN_ACTION_LABELS } from "../input/actions";
import { bindLook, loadLookMode, saveLookMode, type LookController, type LookMode, type LookStatus } from "../input/look";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { LocalPrediction, type PredictedShot } from "../network/prediction/localPrediction";
import { BarnPredictionRig } from "../network/prediction/barnRig";
import type { LobbySnapshot } from "../network/types";
import type { GameStream } from "../network/gameStream";
import type { NetDiagnostics } from "../network/diagnostics";
import { linkDebugLines } from "../network/debugFormat";
import {
  BARN_FIGHTER_FIELDS,
  BARN_FLAG,
  NET,
  WEAPON_CODES,
  neutralIntent,
  type AnyInputPacket,
  type GameEvent,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../shared/party-lab/intent";
import { arenaMap } from "../../../shared/party-lab/maps";
import { TRAPS, WEAPON_SPOTS } from "../../../shared/party-lab/maps/barn";
import { BARN_COMBAT } from "../../../shared/party-lab/simulation/barn/config";
import { shotDirections, weaponRange, type WeaponKind } from "../../../shared/party-lab/simulation/barn/weapons";
import { castHistoric, type HistoricView } from "../../../shared/party-lab/simulation/barn/rewind";
import { MODE_NAMES } from "../../../shared/party-lab/modes";
import { usePartyAudio } from "../audio/PartyAudio";
import { CameraFeel } from "../audio/feel";
import { BARN_CAMERA, barnCameraBlockers, clampPitch, ownCharacterOpacity, smoothing, updateChaseCamera } from "./arenas/barnCamera";
import { barnIntent } from "./arenas/barnControls";
import { BarnBridge, HELD_SCALE, MUZZLE, type BarnPropsView, type HeldView } from "./arenas/barnView";
import { GRIP, HIT_GLOW, PUNCH_GLOW, SHIELD_GLOW, UP, VIEW_KICK, WEAPON_NAMES } from "./arenas/barnPresentation";

const SPOT_IDS = Object.keys(WEAPON_SPOTS) as (keyof typeof WEAPON_SPOTS)[];
const TRAP_IDS = Object.keys(TRAPS);
const HIT_SOUNDS = new Set(["headHit", "bodyHit", "limbHit"]);
const PELVIS = 0.78;
/** A barn fighter's integer fields in a snapshot. */
function fighterOf(s: GameSnapshot | undefined, slot: number) {
  const f = s?.barn?.f;
  if (!f || slot < 0) return null;
  const o = slot * BARN_FIGHTER_FIELDS;
  if (o + BARN_FIGHTER_FIELDS > f.length) return null;
  return {
    alive: !!(f[o] & BARN_FLAG.alive),
    present: !!(f[o] & BARN_FLAG.present),
    hp: f[o + 1],
    weapon: (WEAPON_CODES[f[o + 2]] ?? null) as WeaponKind | null,
    ammo: f[o + 3],
    kills: f[o + 4],
    deaths: f[o + 5],
    respawnIn: f[o + 6] / 10,
    protection: f[o + 7] / 10,
    trapped: f[o + 8] / 10,
    pitch: f[o + 9] / 100,
  };
}
const cm = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n / 100 : NaN);

interface Props {
  lobby: LobbySnapshot;
  stream: GameStream;
  bindings: Bindings;
  paused: boolean;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
  onLeave: () => void;
  onControls: () => void;
  diagnostics?: NetDiagnostics | null;
  debug?: boolean;
}
interface Hud {
  timer: HTMLElement | null;
  scores: (HTMLElement | null)[];
  hp: HTMLElement | null;
  hpBar: HTMLElement | null;
  weapon: HTMLElement | null;
  ammo: HTMLElement | null;
  status: HTMLElement | null;
  crosshair: HTMLElement | null;
  hitmarker: HTMLElement | null;
  vignette: HTMLElement | null;
  death: HTMLElement | null;
  deathTime: HTMLElement | null;
  hint: HTMLElement | null;
  feed: HTMLElement | null;
  performance: HTMLElement | null;
  net: HTMLPreElement | null;
}
const emptyHud = (): Hud => ({
  timer: null,
  scores: [],
  hp: null,
  hpBar: null,
  weapon: null,
  ammo: null,
  status: null,
  crosshair: null,
  hitmarker: null,
  vignette: null,
  death: null,
  deathTime: null,
  hint: null,
  feed: null,
  performance: null,
  net: null,
});
function flash(element: HTMLElement | null, frames: Keyframe[], duration: number) {
  element?.getAnimations().forEach((a) => a.cancel());
  element?.animate(frames, { duration, easing: "ease-out" });
}
const setText = (element: HTMLElement | null, cache: Record<string, string>, key: string, text: string) => {
  if (cache[key] === text) return;
  cache[key] = text;
  if (element) element.textContent = text;
};

function BarnOnlineView({
  lobby,
  stream,
  bindings,
  paused,
  sendInput,
  diagnostics,
  debug = false,
  look,
  hud,
  viewport,
}: Props & { look: MutableRefObject<LookController | null>; hud: MutableRefObject<Hud>; viewport: RefObject<HTMLDivElement> }) {
  const { gl, camera } = useThree();
  const { audio, settings } = usePartyAudio();
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  const slot = (self?.slot ?? -1) as PlayerId;
  const beans = useRef<(Group | null)[]>([]);
  const controls = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const prediction = useRef<LocalPrediction | null>(null);
  const accumulator = useRef(0);
  const aim = useRef({ yaw: 0, pitch: BARN_CAMERA.restPitch });
  const aimReady = useRef(false);
  const wasAlive = useRef(true);
  const pivot = useRef<Vector3 | null>(null);
  const boom = useRef<number | null>(null);
  const eye = useRef<{ x: number; y: number; z: number } | null>(null);
  const viewKick = useRef(0);
  const viewTick = useRef(0);
  const held = useRef<HeldView[]>(PLAYERS.map(() => ({ kind: null, grip: new Vector3(), aim: new Quaternion(), kick: 0 })));
  const hitFlash = useRef(PLAYERS.map(() => 0));
  const bridge = useMemo(() => new BarnBridge(), []);
  const blockers = useMemo(() => barnCameraBlockers(arenaMap("barn")), []);
  const crosshair = useRef({ point: new Vector3(), hit: false, player: -1 });
  const rendered = useRef<HistoricView>({ tick: 0, poses: new Float32Array(PLAYERS.length * 63), hittable: PLAYERS.map(() => false) });
  const feel = useRef(new CameraFeel());
  const ray = useRef(new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
  const scratch = useRef({ euler: new Euler(0, 0, 0, "YXZ"), q: new Quaternion(), q2: new Quaternion(), v: new Vector3(), fwd: new Vector3() });
  const hudCache = useRef<Record<string, string>>({});
  const hudTime = useRef(0);
  const netRefresh = useRef(0);
  const feed = useRef<{ text: string; until: number }[]>([]);
  const sample = useRef({ seconds: 0, frames: 0, jsMs: 0, hitConfirmMs: NaN, lastShotAt: -1, localShots: 0 });
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Chase camera lens (restored for other views).
  useEffect(() => {
    const perspective = camera as PerspectiveCamera,
      previous = perspective.fov;
    perspective.fov = BARN_CAMERA.fov;
    perspective.updateProjectionMatrix();
    return () => {
      perspective.fov = previous;
      perspective.updateProjectionMatrix();
    };
  }, [camera]);
  useEffect(() => {
    if (slot < 0) return;
    let cancelled = false;
    void initializePhysics()
      .then(() => {
        if (!cancelled) prediction.current = new LocalPrediction(slot, "barn_shootout");
      })
      .catch(() => {
        /* Authoritative interpolation remains usable if WASM is unavailable. */
      });
    return () => {
      cancelled = true;
      prediction.current?.dispose();
      prediction.current = null;
    };
  }, [slot]);
  useLayoutEffect(() => {
    stream.setPresentationEnabled(!paused);
    return () => stream.setPresentationEnabled(true);
  }, [stream, paused]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (!document.hidden) return;
      stream.discardEvents();
      controls.current?.clear();
      prediction.current?.suspend();
      accumulator.current = 0;
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [stream, audio, sendInput]);
  useEffect(() => {
    if (!debug || !diagnostics || typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) diagnostics.longTask(entry.duration, performance.now());
      });
      observer.observe({ entryTypes: ["longtask"] });
      return () => observer.disconnect();
    } catch {
      return;
    }
  }, [debug, diagnostics]);
  // Gameplay mouse presses arrive on the Pointer Lock element (the viewport); the lock-taking click is look input.
  useEffect(() => {
    const surface = viewport.current ?? gl.domElement;
    const adapter = bindKeyboard(gl.domElement, bindings, { mouseSurface: surface, claimMouse: (event) => look.current?.claimsClick(event) ?? false });
    controls.current = adapter;
    return () => {
      adapter.dispose();
      controls.current = null;
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    };
  }, [gl, audio, sendInput]);
  const active = !paused && lobby.status === "connected" && lobby.phase === "playing" && !!self?.participating;
  useLayoutEffect(() => {
    controls.current?.setBindings(bindings);
    controls.current?.setSuspended(!active);
    if (!active) {
      prediction.current?.suspend();
      accumulator.current = 0;
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    }
  }, [bindings, active, sendInput, audio]);

  /** Predicted local shot: flash, tracer, recoil and sound now; damage waits for the server. */
  const presentLocalShot = (shot: PredictedShot) => {
    const rig = prediction.current?.rig;
    if (!(rig instanceof BarnPredictionRig)) return;
    const { v, q } = scratch.current;
    const view = held.current[slot];
    q.copy(view.aim);
    const muzzle = view.grip.clone().add(v.set(0, 0, MUZZLE[shot.kind] * HELD_SCALE).applyQuaternion(q));
    const torso = rig.character.parts.torso.body.translation();
    const target = crosshair.current.hit ? crosshair.current.point : v.set(Math.sin(aim.current.yaw), -Math.sin(aim.current.pitch), Math.cos(aim.current.yaw)).multiplyScalar(40).add(muzzle);
    const d = { x: target.x - torso.x, y: target.y - torso.y, z: target.z - torso.z },
      length = Math.hypot(d.x, d.y, d.z) || 1;
    const direction = { x: d.x / length, y: d.y / length, z: d.z / length },
      range = weaponRange(shot.kind);
    const pellets = shotDirections(shot.kind, direction, shot.spread, Math.random).map((dir) => {
      ray.current.origin = torso;
      ray.current.dir = dir;
      const wall = rig.world.castRay(ray.current, range, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
      const body = castHistoric(rendered.current, torso, dir, wall ? wall.timeOfImpact : range, slot, () => true);
      const t = body ? body.distance : wall ? wall.timeOfImpact : range;
      // Predicted: a wall puff only. Whether a body was hit is the server's (hit marker).
      return { end: { x: torso.x + dir.x * t, y: torso.y + dir.y * t, z: torso.z + dir.z * t }, target: null, blocked: !body && !!wall };
    });
    bridge.frame.shots.push({ kind: shot.kind, muzzle, pellets });
    view.kick = 1;
    viewKick.current = Math.min(0.06, viewKick.current + VIEW_KICK[shot.kind]);
    const name = shot.kind === "shotgun" ? "shotgunFire" : "smgFire";
    audio.playSfx({ name, actor: slot, x: torso.x, intensity: 1 });
    stream.markLocalShot(slot, name);
    sample.current.lastShotAt = performance.now();
    sample.current.localShots++;
  };

  /** Confirmed server events: tracers of other players' shots, hit markers, damage, kill feed. */
  const presentEvent = (event: GameEvent) => {
    const d = event.barn;
    const actor = event.actor ?? -1,
      target = event.target ?? -1;
    if ((event.name === "shotgunFire" || event.name === "smgFire") && d?.ends && d.struck && actor >= 0 && actor < PLAYERS.length) {
      const kind: WeaponKind = event.name === "shotgunFire" ? "shotgun" : "smg";
      const view = held.current[actor],
        { v, q } = scratch.current;
      q.copy(view.aim);
      const muzzle = view.grip.clone().add(v.set(0, 0, MUZZLE[kind] * HELD_SCALE).applyQuaternion(q));
      const pellets = d.struck.slice(0, 16).map((struck, i) => ({
        end: { x: cm(d.ends![i * 3]), y: cm(d.ends![i * 3 + 1]), z: cm(d.ends![i * 3 + 2]) },
        target: struck >= 0 ? (struck as PlayerId) : null,
        blocked: struck === -2,
      }));
      if (pellets.every((p) => Number.isFinite(p.end.x) && Number.isFinite(p.end.y) && Number.isFinite(p.end.z)))
        bridge.frame.shots.push({ kind, muzzle, pellets });
      view.kick = 1;
      if (actor === slot) viewKick.current = Math.min(0.06, viewKick.current + VIEW_KICK[kind]);
      return;
    }
    const damage = d?.damage ?? 0;
    const hitByMe = actor === slot && target !== slot && damage > 0 && (event.name === "bulletHit" || HIT_SOUNDS.has(event.name));
    if (hitByMe) {
      if (sample.current.lastShotAt >= 0 && event.name === "bulletHit") sample.current.hitConfirmMs = performance.now() - sample.current.lastShotAt;
      const marker = hud.current.hitmarker;
      marker?.classList.toggle("pl-hitmarker-kill", !!d?.killed);
      flash(marker, [{ opacity: 1, transform: "translate(-50%, -50%) scale(1.3)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(1)" }], d?.killed ? 420 : 220);
    }
    const hurtMe = damage > 0 && ((target === slot && (event.name === "bulletHit" || HIT_SOUNDS.has(event.name))) || (event.name === "trapSnap" && actor === slot));
    if (hurtMe) flash(hud.current.vignette, [{ opacity: Math.min(1, 0.35 + damage / 60) }, { opacity: 0 }], d?.killed ? 900 : 450);
    const victim = event.name === "trapSnap" ? actor : target;
    if (damage > 0 && victim >= 0 && victim < PLAYERS.length) hitFlash.current[victim] = 0.15;
    if ((HIT_SOUNDS.has(event.name) || event.name === "trapSnap") && d?.point?.length === 3) {
      const point = new Vector3(cm(d.point[0]), cm(d.point[1]), cm(d.point[2]));
      if (Number.isFinite(point.x + point.y + point.z)) bridge.frame.impacts.push({ point, body: event.name !== "trapSnap", strong: !!d.killed });
    }
    if (event.name === "death" && actor >= 0) {
      const name = (s: number) => lobby.players.find((p) => p.slot === s)?.nickname ?? `Oyuncu ${s + 1}`;
      const by = d?.by ?? -1;
      feed.current.push({ text: by >= 0 ? `${name(by)} ⟶ ${name(actor)}` : `${name(actor)} düştü`, until: performance.now() + 4000 });
      if (feed.current.length > 4) feed.current.shift();
    }
  };

  useFrame((frame, dt) => {
    const start = performance.now();
    if (debug) diagnostics?.frame(dt * 1000, start);
    const enabled = active && !document.hidden;
    const predictor = prediction.current;
    const latest = stream.snapshots.latest;
    const current = latest?.snapshot.mode === "barn_shootout" ? latest : null;
    if (enabled && current) predictor?.reconcile(current, start);
    if (!paused) {
      const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
      aim.current.yaw -= dx * BARN_CAMERA.sensitivity;
      aim.current.pitch = clampPitch(aim.current.pitch + dy * BARN_CAMERA.sensitivity);
    }
    // Start facing the spawn's way; after a respawn, snap the camera to the new spawn.
    const me = fighterOf(current?.snapshot, slot);
    if (current && me) {
      if ((!aimReady.current || (me.alive && !wasAlive.current)) && me.present) {
        // The authoritative body's facing (spawn yaw right after a (re)spawn), from its pelvis.
        const o = slot * 63 + 0,
          pose = current.values;
        scratch.current.q.set(pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]);
        const fwd = scratch.current.fwd.set(0, 0, 1).applyQuaternion(scratch.current.q);
        aim.current = { yaw: Math.atan2(fwd.x, fwd.z), pitch: BARN_CAMERA.restPitch };
        pivot.current = null;
        boom.current = null;
        eye.current = null;
        aimReady.current = true;
      }
      wasAlive.current = me.alive;
    }
    if (!enabled || dt > 0.25) {
      controls.current?.clear();
      predictor?.suspend();
      accumulator.current = 0;
      if (dt > 0.25) sendInput(neutralIntent());
    } else {
      accumulator.current += Math.min(dt, 0.05);
      const ticks = accumulator.current + 1e-6 >= 1 / NET.inputHz ? Math.min(3, Math.floor((accumulator.current + 1e-6) * NET.physicsHz)) : 0;
      const c = controls.current;
      if (ticks > 0 && c) {
        accumulator.current -= ticks / NET.physicsHz;
        // Read held/pressed first: readIntent() consumes the edges.
        const attackHeld = c.manager.isActionDown("punch"),
          pickup = c.manager.wasActionPressed("grab");
        const intent = barnIntent(c.readIntent(), aim.current.yaw, { attackHeld, pickup, aimPitch: aim.current.pitch, aimEye: eye.current ?? undefined });
        // The remote poses on screen when this input was read (lag compensation).
        intent.viewTick = viewTick.current;
        const packet = sendInput(intent);
        if (packet) {
          const result = predictor?.advance(packet, ticks, start);
          if (result?.swing && slot >= 0) {
            const x = predictor!.rig.character.body.translation().x;
            if (audio.playSfx({ name: "punchSwing", actor: slot, x })) stream.markLocalSwing(packet.round, slot, packet.seq);
          }
          for (const shot of result?.shots ?? []) presentLocalShot(shot);
        }
      }
      // Rounds a reconciliation revealed that no first run showed: once, now.
      if (predictor) for (const shot of predictor.lateShots.splice(0)) presentLocalShot(shot);
    }
    const localPose = enabled ? predictor?.pose(Math.min(dt, 0.1)) : null;
    const sampled = stream.snapshots.sample(start);
    if (!sampled || sampled.b.snapshot.mode !== "barn_shootout") return;
    viewTick.current = (stream.snapshots.renderMs * NET.physicsHz) / 1000;
    const { a, b, alpha } = sampled;
    const qa = scratch.current.q,
      qb = scratch.current.q2;
    const view = rendered.current;
    for (const player of PLAYERS) {
      const bean = beans.current[player.id];
      const shown = fighterOf(b.snapshot, player.id);
      const inPlay = !!(b.snapshot.mask & (1 << player.id));
      view.hittable[player.id] = false;
      if (!bean) continue;
      bean.visible = inPlay && !!shown?.present;
      const local = player.id === slot;
      const predicted = local && localPose ? localPose : null;
      for (let i = 0; i < PARTS.length; i++) {
        const part = bean.children[i],
          offset = (player.id * PARTS.length + i) * 7;
        if (predicted) {
          const at = i * 7;
          part.position.set(predicted[at], predicted[at + 1], predicted[at + 2]);
          part.quaternion.set(predicted[at + 3], predicted[at + 4], predicted[at + 5], predicted[at + 6]);
        } else {
          part.position.set(
            a.values[offset] + (b.values[offset] - a.values[offset]) * alpha,
            a.values[offset + 1] + (b.values[offset + 1] - a.values[offset + 1]) * alpha,
            a.values[offset + 2] + (b.values[offset + 2] - a.values[offset + 2]) * alpha
          );
          qa.set(a.values[offset + 3], a.values[offset + 4], a.values[offset + 5], a.values[offset + 6]);
          qb.set(b.values[offset + 3], b.values[offset + 4], b.values[offset + 5], b.values[offset + 6]);
          part.quaternion.copy(qa).slerp(qb, alpha);
        }
        const k = offset;
        view.poses[k] = part.position.x;
        view.poses[k + 1] = part.position.y;
        view.poses[k + 2] = part.position.z;
        view.poses[k + 3] = part.quaternion.x;
        view.poses[k + 4] = part.quaternion.y;
        view.poses[k + 5] = part.quaternion.z;
        view.poses[k + 6] = part.quaternion.w;
      }
      // The crosshair can be "on" living remote players as drawn (what the server rewinds to).
      view.hittable[player.id] = !local && bean.visible && !!shown?.alive;
      hitFlash.current[player.id] = Math.max(0, hitFlash.current[player.id] - dt);
      const skin = (bean.children[0]?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
      if (skin) {
        const now = fighterOf(latest?.snapshot, player.id);
        const hit = hitFlash.current[player.id] > 0,
          shielded = !!now?.alive && (now?.protection ?? 0) > 0;
        skin.emissive.copy(hit ? HIT_GLOW : shielded ? SHIELD_GLOW : PUNCH_GLOW);
        skin.emissiveIntensity = hit ? (hitFlash.current[player.id] / 0.15) * 0.9 : shielded ? 0.3 + 0.2 * Math.sin(frame.clock.elapsedTime * 16) : 0;
      }
    }
    for (const event of stream.drain(b.snapshot.round, stream.snapshots.renderMs, (e) => e.actor === slot || e.target === slot)) {
      if (paused || document.hidden || lobby.status !== "connected") continue;
      audio.playSfx(event);
      feel.current.trigger(event, slot);
      presentEvent(event);
    }
    // ─── Chase camera ───────────────────────────────────────────────────────
    // A spectator (joined mid-round) has no body: follow the first player in the round.
    const followSlot = self?.participating ? slot : (PLAYERS.find((p) => b.snapshot.mask & (1 << p.id))?.id ?? -1);
    const own = followSlot >= 0 ? beans.current[followSlot] : null;
    const pelvisNode = own?.children[0];
    if (own && pelvisNode) {
      const p = pelvisNode.position;
      if (!pivot.current) pivot.current = new Vector3(p.x, p.y + BARN_CAMERA.pivotHeight, p.z);
      else {
        const kxz = smoothing(dt, BARN_CAMERA.followXZ),
          ky = smoothing(dt, BARN_CAMERA.followY);
        pivot.current.x += (p.x - pivot.current.x) * kxz;
        pivot.current.z += (p.z - pivot.current.z) * kxz;
        pivot.current.y += (p.y + BARN_CAMERA.pivotHeight - pivot.current.y) * ky;
      }
      const rig = updateChaseCamera(blockers, pivot.current, aim.current.yaw, aim.current.pitch, boom.current, dt);
      boom.current = rig.boom;
      camera.position.set(rig.position.x, rig.position.y, rig.position.z);
      camera.lookAt(rig.position.x + rig.look.x, rig.position.y + rig.look.y, rig.position.z + rig.look.z);
      camera.rotateX(viewKick.current);
      viewKick.current *= Math.exp(-dt / 0.07);
      const lk = rig.look,
        t = Math.max(0, (pivot.current.x - rig.position.x) * lk.x + (pivot.current.y - rig.position.y) * lk.y + (pivot.current.z - rig.position.z) * lk.z);
      eye.current = { x: rig.position.x + lk.x * t - p.x, y: rig.position.y + lk.y * t - p.y, z: rig.position.z + lk.z * t - p.z };
      const skin = (own.children[0]?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
      if (skin && followSlot === slot) {
        const opacity = ownCharacterOpacity(rig.boom),
          transparent = opacity < 0.999;
        if (skin.transparent !== transparent) {
          skin.transparent = transparent;
          skin.depthWrite = !transparent;
          skin.needsUpdate = true;
        }
        skin.opacity = opacity;
      }
      // What the crosshair is on: static barn (the prediction world) or a remote player as drawn.
      const world = predictor?.rig instanceof BarnPredictionRig ? predictor.rig.world : null;
      let wall = 80;
      if (world) {
        ray.current.origin = rig.position;
        ray.current.dir = rig.look;
        const hit = world.castRay(ray.current, 80, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
        if (hit) wall = hit.timeOfImpact;
      }
      const body = castHistoric(view, rig.position, rig.look, wall, slot, () => true);
      const distance = body ? body.distance : wall;
      crosshair.current.hit = !!body || wall < 80;
      crosshair.current.player = body?.id ?? -1;
      crosshair.current.point.set(rig.position.x + lk.x * distance, rig.position.y + lk.y * distance, rig.position.z + lk.z * distance);
      // Armed: warn when the body's line to the crosshair's point is blocked (shots leave the torso).
      const mark = hud.current.crosshair;
      const rigNow = predictor?.rig instanceof BarnPredictionRig ? predictor.rig : null;
      if (mark && world && rigNow) {
        const from = rigNow.character.parts.torso.body.translation(),
          to = crosshair.current.point,
          gap = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z),
          reach = Math.max(0, gap - 0.15);
        let blocked = false;
        if (predictor?.active && rigNow.fighter.alive && rigNow.fighter.weapon && crosshair.current.hit && gap > 0.5) {
          ray.current.origin = from;
          ray.current.dir = { x: (to.x - from.x) / gap, y: (to.y - from.y) / gap, z: (to.z - from.z) / gap };
          blocked = !!world.castRay(ray.current, reach, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
        }
        const flag = blocked ? "true" : "false";
        if (mark.dataset.blocked !== flag) mark.dataset.blocked = flag;
      }
    }
    const [shakeX, shakeY] = feel.current.step(dt, settings.cameraShake && !reduced && !paused);
    camera.position.x += shakeX;
    camera.position.y += shakeY;
    // ─── Held weapons, pickups, traps, effects ──────────────────────────────
    const rigNow = predictor?.rig instanceof BarnPredictionRig && predictor.active ? predictor.rig : null;
    const { euler, q, v, fwd } = scratch.current;
    for (const player of PLAYERS) {
      const heldView = held.current[player.id],
        bean = beans.current[player.id],
        torso = bean?.children[1];
      if (!bean || !torso) continue;
      const local = player.id === slot;
      const shown = fighterOf(local ? latest?.snapshot : b.snapshot, player.id);
      heldView.kind = local && rigNow ? (rigNow.fighter.alive ? rigNow.fighter.weapon?.kind ?? null : null) : shown?.alive ? shown.weapon : null;
      if (!bean.visible) heldView.kind = null;
      fwd.set(0, 0, 1).applyQuaternion(torso.quaternion);
      const facing = local && rigNow ? rigNow.character.facing : Math.atan2(fwd.x, fwd.z);
      const pitch = local ? aim.current.pitch : shown?.pitch ?? 0;
      heldView.grip.copy(GRIP).applyQuaternion(q.setFromAxisAngle(UP, facing)).add(torso.position);
      heldView.grip.y += Math.max(-0.3, Math.min(0.3, -Math.sin(pitch) * 0.45));
      euler.set(pitch, local ? aim.current.yaw : facing, 0, "YXZ");
      if (local && crosshair.current.hit && v.copy(crosshair.current.point).sub(heldView.grip).length() > 1.2) {
        v.normalize();
        euler.set(-Math.asin(Math.max(-1, Math.min(1, v.y))), Math.atan2(v.x, v.z), 0, "YXZ");
      }
      heldView.aim.setFromEuler(euler);
      heldView.kick *= Math.exp(-dt / 0.06);
    }
    const props: BarnPropsView | null = current?.snapshot.barn
      ? (() => {
          const s = current.snapshot.barn!;
          const pickups: { spot: string; kind: WeaponKind }[] = [];
          for (let i = 0; i + 1 < s.p.length; i += 2) {
            const spot = SPOT_IDS[s.p[i]],
              kind = WEAPON_CODES[s.p[i + 1]];
            if (spot && kind) pickups.push({ spot, kind });
          }
          const telegraphs: { spot: string; progress: number }[] = [];
          for (let i = 0; i + 1 < s.t.length; i += 2) if (SPOT_IDS[s.t[i]]) telegraphs.push({ spot: SPOT_IDS[s.t[i]], progress: Math.max(0, Math.min(1, s.t[i + 1] / 100)) });
          const traps = TRAP_IDS.map((id, i) => {
            const rearm = (s.r[i * 2] ?? 0) / 10,
              sprung = (s.r[i * 2 + 1] ?? 255) / 10;
            return { id, armed: rearm <= 0, sprungFor: sprung >= 25.5 ? Infinity : sprung, rearmIn: rearm, holding: rearm > 0 && sprung < BARN_COMBAT.trap.hold };
          });
          return { pickups, telegraphs, traps };
        })()
      : null;
    bridge.frame.elapsed = frame.clock.elapsedTime;
    bridge.frame.dt = dt;
    bridge.frame.held = held.current;
    bridge.frame.props = props;
    bridge.publish();
    // Debug only: this frame's own body, for frame-accurate input→screen timing in tests.
    if (debug && hud.current.performance && own?.children[0]) {
      const q = own.children[0].position;
      hud.current.performance.dataset.frame = `${performance.now().toFixed(1)},${q.x.toFixed(4)},${q.z.toFixed(4)},${sample.current.localShots}`;
    }
    // ─── HUD (DOM only when a value changes) ────────────────────────────────
    hudTime.current += dt;
    const h = hud.current,
      cache = hudCache.current;
    if (hudTime.current >= 0.1 && current) {
      hudTime.current = 0;
      const snap = current.snapshot;
      setText(h.timer, cache, "timer", `${Math.floor(snap.seconds / 60)}:${String(snap.seconds % 60).padStart(2, "0")}`);
      for (const player of lobby.players) {
        const f = fighterOf(snap, player.slot);
        const row = h.scores[player.slot];
        if (!f || !row) continue;
        const text = `${f.kills}|${f.deaths}|${f.alive ? "" : "dead"}`;
        if (cache[`score${player.slot}`] !== text) {
          cache[`score${player.slot}`] = text;
          (row.querySelector("[data-kills]") as HTMLElement).textContent = String(f.kills);
          (row.querySelector("[data-deaths]") as HTMLElement).textContent = String(f.deaths);
          row.dataset.dead = f.alive ? "false" : "true";
        }
      }
      if (me && self?.participating) {
        const rigFighter = rigNow?.fighter;
        const weapon = rigFighter ? rigFighter.weapon : me.weapon ? { kind: me.weapon, ammo: me.ammo } : null;
        setText(h.hp, cache, "hp", String(me.hp));
        if (cache.bar !== String(me.hp) && h.hpBar) {
          h.hpBar.style.setProperty("--hp", `${me.hp}%`);
          h.hpBar.dataset.low = me.hp <= 30 ? "true" : "false";
        }
        cache.bar = String(me.hp);
        setText(h.weapon, cache, "weapon", weapon ? WEAPON_NAMES[weapon.kind] : "Silah yok");
        setText(h.ammo, cache, "ammo", weapon ? `${weapon.ammo} ${"●".repeat(weapon.ammo)}${"○".repeat(Math.max(0, BARN_COMBAT[weapon.kind].ammo - weapon.ammo))}` : "Yumruk");
        setText(h.status, cache, "status", !me.alive ? "" : me.trapped > 0 ? `Ayı kapanı · ${me.trapped.toFixed(1)} sn` : me.protection > 0 ? "Doğuş koruması" : "");
        const dead = me.alive ? "alive" : "dead";
        if (cache.dead !== dead && h.death) h.death.hidden = me.alive;
        cache.dead = dead;
        if (!me.alive) setText(h.deathTime, cache, "deathTime", `${me.respawnIn.toFixed(1)} sn içinde yeniden doğacaksın`);
        // Pickup prompt from the newest pickups and where the body is drawn.
        let prompt = "";
        const pelvis = own?.children[0]?.position;
        if (me.alive && pelvis && props && snap.phase === "playing")
          for (const pickup of props.pickups) {
            const s = WEAPON_SPOTS[pickup.spot as keyof typeof WEAPON_SPOTS];
            if (Math.hypot(pelvis.x - s.x, pelvis.z - s.z) <= BARN_COMBAT.pickup.radius && Math.abs(pelvis.y - PELVIS - s.y) <= BARN_COMBAT.pickup.height) {
              prompt = `${actionBindingLabel(bindings, "grab")}: ${WEAPON_NAMES[pickup.kind]} al${weapon ? ` (elindeki ${WEAPON_NAMES[weapon.kind]} yok olur)` : ""}`;
              break;
            }
          }
        if (!prompt && me.alive && me.trapped > 0) prompt = "Ayı kapanı! Kurtulana kadar yürüyemez, zıplayamazsın — nişan alıp saldırabilirsin.";
        setText(h.hint, cache, "hint", prompt);
      }
      const now = performance.now();
      feed.current = feed.current.filter((f) => f.until > now);
      setText(h.feed, cache, "feed", feed.current.map((f) => f.text).join("\n"));
      // Automation/debug readout (both clients' agreement is checked from these).
      if (h.performance) {
        const pelvis = own?.children[0]?.position;
        h.performance.dataset.combat = JSON.stringify({
          tick: snap.tick,
          phase: snap.phase,
          seconds: snap.seconds,
          at: pelvis ? [+pelvis.x.toFixed(2), +(pelvis.y - PELVIS).toFixed(2), +pelvis.z.toFixed(2)] : null,
          // Every body as drawn on this screen (own: predicted; others: interpolated).
          bodies: PLAYERS.map((p) => {
            const q = beans.current[p.id]?.children[0]?.position;
            return beans.current[p.id]?.visible && q ? [+q.x.toFixed(2), +(q.y - PELVIS).toFixed(2), +q.z.toFixed(2)] : null;
          }),
          fighters: PLAYERS.map((p) => fighterOf(snap, p.id)),
          predicted: rigNow ? { weapon: rigNow.fighter.weapon?.kind ?? null, ammo: rigNow.fighter.weapon?.ammo ?? 0 } : null,
          pickups: props?.pickups.map((p) => `${p.spot}:${p.kind}`) ?? [],
          traps: props?.traps.map((t) => `${t.id}:${t.armed ? "armed" : t.rearmIn.toFixed(1)}`) ?? [],
          crosshair: crosshair.current.player,
          yaw: +aim.current.yaw.toFixed(3),
          pitch: +aim.current.pitch.toFixed(3),
          prediction: predictor ? { active: predictor.active, hard: predictor.metrics.hard, corrections: predictor.metrics.corrections, maxError: +predictor.metrics.maxError.toFixed(4), pending: predictor.history.records.length } : null,
          shotEchoMs: Number.isFinite(stream.lastShotEchoMs) ? Math.round(stream.lastShotEchoMs) : null,
          localShotAt: sample.current.lastShotAt >= 0 ? Math.round(sample.current.lastShotAt) : null,
          link: lobby.link,
          hitConfirmMs: Number.isFinite(sample.current.hitConfirmMs) ? Math.round(sample.current.hitConfirmMs) : null,
        });
      }
    }
    netRefresh.current += dt;
    if (debug && diagnostics && h.net && netRefresh.current >= 0.5) {
      netRefresh.current = 0;
      const s = diagnostics.server;
      const barnLine = `barn snapshot ${s?.snapshotBytes ?? "—"} B · geri sarma son ${s?.rewind ? Math.round(s.rewind.lastMs) : "—"} ms / max ${s?.rewind ? Math.round(s.rewind.maxMs) : "—"} ms · kırpılan ${s?.rewind?.clampedOld ?? "—"} · gelecek ${s?.rewind?.rejectedFuture ?? "—"} · atış yankısı ${Number.isFinite(stream.lastShotEchoMs) ? Math.round(stream.lastShotEchoMs) : "—"} ms · isabet onayı ${Number.isFinite(sample.current.hitConfirmMs) ? Math.round(sample.current.hitConfirmMs) : "—"} ms`;
      h.net.textContent = [...linkDebugLines(diagnostics, start), barnLine].join("\n");
    }
    const stats = sample.current;
    stats.frames++;
    stats.seconds += dt;
    stats.jsMs += performance.now() - start;
    if (stats.seconds >= 2) {
      if (h.performance && debug) {
        const m = predictor?.metrics;
        h.performance.textContent = `${Math.round(stats.frames / stats.seconds)} FPS · ${gl.info.render.calls} çizim · JS ${(stats.jsMs / stats.frames).toFixed(2)} ms/kare · ${localPose ? "yerel tahmin" : "sunucu görünümü"} · ${
          m ? (m.stepMs / Math.max(1, m.steps)).toFixed(2) : "—"
        } ms/tahmin · hata ${m?.error.toFixed(3) ?? "—"} m · ort/max ${m ? (m.totalError / Math.max(1, m.reconciliations)).toFixed(3) : "—"}/${m?.maxError.toFixed(3) ?? "—"} · düzeltme ${m?.corrections ?? 0}/${m?.hard ?? 0} sert · bekleyen ${predictor?.history.records.length ?? 0} · ACK ${m?.ackDelayMs.toFixed(0) ?? "—"} ms`;
      }
      stats.frames = stats.seconds = stats.jsMs = 0;
    }
  });

  return (
    <>
      <Arena mapId="barn" barn={bridge} />
      {PLAYERS.map((player) => (
        <PlayerBean
          key={player.id}
          color={player.color}
          costume={playerCostumeAtSlot(lobby.players, player.id)}
          ref={(node) => {
            beans.current[player.id] = node;
          }}
        />
      ))}
    </>
  );
}

/** Barn Shootout online: third-person chase camera, server-authoritative combat. */
export default function OnlineBarnArena(props: Props) {
  const { lobby, onLeave, onControls, bindings, paused } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const hud = useRef<Hud>(emptyHud());
  const [lookMode, setLookMode] = useState<LookMode>(loadLookMode);
  const [lookStatus, setLookStatus] = useState<LookStatus>("unlocked");
  const look = useRef<LookController | null>(null);
  const lookModeNow = useRef(lookMode);
  lookModeNow.current = lookMode;
  const game = lobby.game;
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  useEffect(() => {
    if (!paused) viewport.current?.focus();
  }, [paused]);
  useEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    const controller = bindLook(surface, lookModeNow.current, setLookStatus);
    look.current = controller;
    return () => {
      controller.dispose();
      look.current = null;
    };
  }, []);
  useEffect(() => {
    look.current?.setMode(lookMode);
    saveLookMode(lookMode);
  }, [lookMode]);
  useEffect(() => {
    look.current?.setEnabled(!paused);
  }, [paused]);
  const scores = lobby.players
    .filter((p) => !game || game.mask & (1 << p.slot))
    .map((p) => ({ player: p, f: fighterOf(game ?? undefined, p.slot) }))
    .sort((x, y) => (y.f?.kills ?? 0) - (x.f?.kills ?? 0) || (x.f?.deaths ?? 0) - (y.f?.deaths ?? 0));
  const winner = lobby.winner >= 0 ? lobby.players.find((p) => p.slot === lobby.winner) : null;
  return (
    <div className="party-lab pl-playground">
      <header className="pl-arena-header">
        <div>
          <span className="pl-eyebrow">PARTY LAB / ONLINE · {lobby.code} · {MODE_NAMES.barn_shootout.toLocaleUpperCase("tr-TR")}</span>
          <h2>Ambar Çatışması</h2>
        </div>
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
        <button className="pl-button pl-join" onClick={onControls}>
          Kontroller
        </button>
        <button className="pl-button pl-join" data-sfx="uiBack" onClick={onLeave}>
          Odadan Ayrıl
        </button>
      </header>
      <p className={`pl-online-status${lobby.status === "connected" && lobby.link === "degraded" ? " is-degraded" : ""}`} role="status">
        {lobby.status === "connected"
          ? lobby.link === "degraded"
            ? "Bağlantı yavaş: sunucudan veri gecikiyor. Bağlantı kesilmedi."
            : "Sunucuya bağlı"
          : lobby.status === "reconnecting"
          ? "Bağlantı kesildi. Yeniden bağlanılıyor…"
          : "Bağlantı kapandı."}
        {!self?.participating ? " · İzliyorsun. Sonraki tur lobide hazır olabilirsin." : ""}
      </p>
      <div
        className="pl-viewport"
        tabIndex={0}
        ref={viewport}
        role="region"
        aria-label="Online Ambar Çatışması"
        data-look={lookMode}
        data-combat="barn"
        data-mode="barn_shootout"
        onPointerDown={() => viewport.current?.focus()}
      >
        <Canvas
          dpr={[1, 1.5]}
          camera={{ position: [0, 3, 8], fov: BARN_CAMERA.fov, near: 0.1, far: 180 }}
          gl={{ antialias: true, alpha: true }}
          fallback={<p>Bu arena için WebGL 2 gerekiyor.</p>}
        >
          <BarnOnlineView {...props} look={look} hud={hud} viewport={viewport} />
        </Canvas>
        <div className="pl-barn-top" aria-label="Süre ve skor">
          <span className="pl-barn-timer" ref={(el) => void (hud.current.timer = el)} aria-label="Kalan süre">
            {Math.floor((game?.seconds ?? lobby.seconds) / 60)}:{String((game?.seconds ?? lobby.seconds) % 60).padStart(2, "0")}
          </span>
        </div>
        <ol className="pl-barn-scores" aria-label="Skor tablosu">
          <li className="pl-barn-score-head" aria-hidden="true">
            <span />
            <span>Öldürme</span>
            <span>Ölüm</span>
          </li>
          {scores.map(({ player, f }) => (
            <li key={player.id} ref={(el) => void (hud.current.scores[player.slot] = el)} data-self={player.id === lobby.selfId ? "true" : "false"}>
              <span>
                <span className="pl-player-dot" style={{ backgroundColor: player.color }} />
                {player.nickname}
                {!player.connected && <small> · bağlanıyor</small>}
              </span>
              <b data-kills>{f?.kills ?? 0}</b>
              <span data-deaths>{f?.deaths ?? 0}</span>
            </li>
          ))}
        </ol>
        <pre className="pl-barn-feed" aria-live="polite" ref={(el) => void (hud.current.feed = el)} />
        <div className="pl-damage-vignette" aria-hidden="true" ref={(el) => void (hud.current.vignette = el)} />
        <div className="pl-hitmarker" aria-hidden="true" ref={(el) => void (hud.current.hitmarker = el)} />
        <div className="pl-crosshair" aria-hidden="true" ref={(el) => void (hud.current.crosshair = el)} />
        <div className="pl-barn-hud" aria-label="Can ve silah">
          <div className="pl-barn-health">
            <span className="pl-barn-hp" aria-label="Can">
              <b ref={(el) => void (hud.current.hp = el)}>{BARN_COMBAT.health}</b>
              <small>HP</small>
            </span>
            <span className="pl-barn-hp-bar" ref={(el) => void (hud.current.hpBar = el)} />
          </div>
          <div className="pl-barn-weapon">
            <b ref={(el) => void (hud.current.weapon = el)}>Silah yok</b>
            <span ref={(el) => void (hud.current.ammo = el)}>Yumruk</span>
          </div>
          <span className="pl-barn-status" role="status" ref={(el) => void (hud.current.status = el)} />
        </div>
        <div className="pl-combat-hint" ref={(el) => void (hud.current.hint = el)} />
        <div className="pl-arena-message pl-barn-death" role="status" hidden ref={(el) => void (hud.current.death = el)}>
          <strong>Öldün!</strong>
          <span ref={(el) => void (hud.current.deathTime = el)} />
        </div>
        {lookMode === "lock" && lookStatus !== "locked" && !paused && lobby.phase !== "results" && (
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
        {lookMode === "drag" && lookStatus !== "dragging" && <div className="pl-look-chip">Bakmak için basılı tutup sürükle</div>}
        {(lobby.phase === "countdown" || lobby.phase === "results" || !game) && (
          <div className={`pl-arena-message pl-round-message${lobby.phase === "results" ? " pl-result-pulse" : ""}`} role="status">
            <strong style={winner ? { color: winner.color } : undefined}>
              {lobby.phase === "countdown" ? lobby.seconds : lobby.phase === "results" ? (winner ? `${winner.nickname} kazandı!` : "Berabere!") : "Arena bağlanıyor…"}
            </strong>
            <span>
              {lobby.phase === "results"
                ? `${scores.map(({ player, f }) => `${player.nickname} ${f?.kills ?? 0}`).join(" · ")} · Yeni tur için lobiye dönülüyor.`
                : lobby.phase === "countdown"
                ? "En çok öldüren kazanır · 2:30"
                : ""}
            </span>
          </div>
        )}
      </div>
      <footer className="pl-online-footer">
        <span>
          {ACTIONS.filter((a) => a === "punch" || a === "grab" || a === "lift" || a === "jump")
            .map((a) => `${actionBindingLabel(bindings, a)}: ${BARN_ACTION_LABELS[a] ?? ACTION_LABELS[a]}`)
            .join(" · ")}
        </span>
        <span ref={(el) => void (hud.current.performance = el)} />
      </footer>
      {props.debug && <pre className="pl-net-debug" ref={(el) => void (hud.current.net = el)} aria-hidden="true" />}
    </div>
  );
}
