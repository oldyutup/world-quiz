import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial, type PerspectiveCamera } from "three";
import PlayerBean from "./PlayerBean";
import { playerCostumeAtSlot } from "./visual/costumes";
import { PLAYERS, type PlayerId } from "./players";
import { PARTS } from "./ragdoll/config";
import { bindKeyboard } from "../input/keyboard";
import { isUIInput } from "../input/device";
import type { Bindings } from "../input/bindings";
import { bindLook, loadLookMode, saveLookMode, type LookController, type LookMode, type LookStatus } from "../input/look";
import { initializePhysics, PHYSICS } from "../../../shared/party-lab/simulation/physics";
import { LocalPrediction } from "../network/prediction/localPrediction";
import { BombPredictionRig } from "../network/prediction/bombRig";
import type { LobbySnapshot } from "../network/types";
import type { GameStream } from "../network/gameStream";
import type { NetDiagnostics } from "../network/diagnostics";
import { linkDebugLines } from "../network/debugFormat";
import { NET, neutralIntent, LAYER_FLAG, type AnyInputPacket, type GameSnapshot } from "../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../shared/party-lab/intent";
import { decodeBombSnapshot, type DecodedBomb } from "../../../shared/party-lab/simulation/bomb/wire";
import { BOMB_TAG, BOMB_TICKS } from "../../../shared/party-lab/simulation/bomb/config";
import { BOMB_TRAPS, surfaceBelow } from "../../../shared/party-lab/maps/bomb";
import type { BombTrap } from "../../../shared/party-lab/simulation/bomb/traps";
import { MODE_NAMES } from "../../../shared/party-lab/modes";
import { ArenaMenu, ArenaStatus, ControlHint, MenuButton, useArenaMenu, useDebugPanel } from "./ArenaChrome";
import { controlHint } from "./arenaMenu";
import { ACCUMULATOR_START, FrameClock, frameTime } from "./frameClock";
import { usePartyAudio } from "../audio/PartyAudio";
import { CameraFeel } from "../audio/feel";
import { layerIntent } from "./layers/controls";
import { BombEnvironment } from "./bomb/BombPlayground";
import BombScenery from "./bomb/BombScenery";
import { BOMB_CAMERA, bombCameraBlockers, bombCameraPose, bombOwnOpacity, BombFollow, clampBombPitch } from "./bomb/bombCamera";
import { BombIcon } from "./bomb/BombHud";
import { BOMB_RED, BombVisuals, FUSE_PANIC, type CarrierView } from "./bomb/visuals";
import type { BombKit } from "./bomb/scenery";

const decoded = new WeakMap<GameSnapshot, DecodedBomb | null>();
const bombOf = (snapshot: GameSnapshot | null | undefined) => {
  if (!snapshot) return null;
  if (!decoded.has(snapshot)) decoded.set(snapshot, decodeBombSnapshot(snapshot.bomb));
  return decoded.get(snapshot) ?? null;
};
const STAND = 0.78;
const SPECTATE_HOLD = 1.4;

interface Props {
  lobby: LobbySnapshot;
  stream: GameStream;
  bindings: Bindings;
  paused: boolean;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
  onLeave: () => void;
  onBindings: (bindings: Bindings) => void;
  bindingsSaved: boolean;
  diagnostics?: NetDiagnostics | null;
  debug?: boolean;
}
interface HudRefs {
  fuse: HTMLElement | null;
  bar: HTMLElement | null;
  callout: HTMLElement | null;
  arrow: HTMLElement | null;
  vignette: HTMLElement | null;
  debug: HTMLPreElement | null;
  net: HTMLPreElement | null;
}
interface ViewState { spectating: PlayerId | null; }

function OnlineBombView({ lobby, stream, bindings, paused, menuOpen, sendInput, diagnostics, debug = false, look, viewport, hud, onView }: Props & {
  menuOpen: boolean;
  look: MutableRefObject<LookController | null>;
  viewport: RefObject<HTMLDivElement>;
  hud: MutableRefObject<HudRefs>;
  onView: (state: ViewState) => void;
}) {
  const { gl, camera, size } = useThree();
  const { audio, settings } = usePartyAudio();
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  const slot = (self?.slot ?? -1) as PlayerId;
  const participating = !!self?.participating;
  const beans = useRef<(Group | null)[]>([]);
  const controls = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const prediction = useRef<LocalPrediction | null>(null);
  const accumulator = useRef(ACCUMULATOR_START);
  const clock = useRef(new FrameClock());
  const feel = useRef(new CameraFeel());
  const visuals = useMemo(() => new BombVisuals(), []);
  const blockers = useMemo(bombCameraBlockers, []);
  const scenery = useRef<Group | null>(null);
  const onKit = useCallback((kit: BombKit | null) => visuals.setKit(kit), [visuals]);
  const view = useRef({
    round: -1,
    yaw: 0,
    pitch: BOMB_CAMERA.restPitch as number,
    aimReady: false,
    follow: new BombFollow(),
    boom: { boom: null as number | null },
    sprint: 0,
    fov: BOMB_CAMERA.fov as number,
    spectating: null as PlayerId | null,
    published: null as PlayerId | null,
    time: 0,
  });
  const ghosts = useRef(PLAYERS.map(() => ({ active: false, age: 0, pose: new Float32Array(63), v: new Vector3(), spin: 0 })));
  const wasAlive = useRef([false, false, false]);
  const hitFlash = useRef([0, 0, 0]);
  const lastCarrier = useRef<number | null>(null);
  const sample = useRef({ seconds: 0, frames: 0, jsMs: 0, fps: 0, hud: 0, net: 0 });
  const scratch = useRef({ q0: new Quaternion(), q1: new Quaternion(), pelvis: new Vector3(), head: new Vector3(), feet: new Vector3(), shield: new Vector3(), point: new Vector3(), slow: PLAYERS.map(() => new Vector3()), slowAt: PLAYERS.map((): Vector3 | null => null), slowLeft: [0, 0, 0] });
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => () => visuals.dispose(), [visuals]);
  useEffect(() => {
    const perspective = camera as PerspectiveCamera, previous = perspective.fov;
    perspective.fov = BOMB_CAMERA.fov;
    perspective.updateProjectionMatrix();
    return () => { perspective.fov = previous; perspective.updateProjectionMatrix(); };
  }, [camera]);
  useEffect(() => {
    if (slot < 0) return;
    let cancelled = false;
    void initializePhysics().then(() => { if (!cancelled) prediction.current = new LocalPrediction(slot, "bomb_tag"); }).catch(() => {});
    return () => { cancelled = true; prediction.current?.dispose(); prediction.current = null; };
  }, [slot]);
  useLayoutEffect(() => { stream.setPresentationEnabled(!paused); return () => stream.setPresentationEnabled(true); }, [stream, paused]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)"), update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (!document.hidden) return;
      stream.discardEvents(); controls.current?.clear(); prediction.current?.suspend(); accumulator.current = ACCUMULATOR_START;
      sendInput(neutralIntent()); audio.stopAll(); feel.current.clear();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [stream, sendInput, audio]);
  useEffect(() => {
    if (!debug || !diagnostics || typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => diagnostics.longTask(entry.duration, performance.now())));
      observer.observe({ entryTypes: ["longtask"] });
      return () => observer.disconnect();
    } catch { return; }
  }, [debug, diagnostics]);
  useEffect(() => {
    const surface = viewport.current ?? gl.domElement;
    const adapter = bindKeyboard(gl.domElement, bindings, { mouseSurface: surface, claimMouse: (event) => look.current?.claimsClick(event) ?? false });
    controls.current = adapter;
    return () => { adapter.dispose(); controls.current = null; sendInput(neutralIntent()); audio.stopAll(); feel.current.clear(); };
  }, [gl, bindings, sendInput, audio]);
  const active = !paused && !menuOpen && lobby.status === "connected" && lobby.phase === "playing" && participating;
  useLayoutEffect(() => {
    controls.current?.setBindings(bindings);
    controls.current?.setSuspended(!active);
    if (!active) { prediction.current?.suspend(); accumulator.current = ACCUMULATOR_START; sendInput(neutralIntent()); }
  }, [bindings, active, sendInput]);
  const cycle = useRef<(step: 1 | -1) => void>(() => {});
  const blocked = useRef(paused || menuOpen);
  blocked.current = paused || menuOpen;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (blocked.current || isUIInput(event.target) || event.repeat) return;
      if (event.code === "KeyQ") cycle.current(-1);
      else if (event.code === "KeyE") cycle.current(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const callout = (text: string, tone: "bomb" | "safe" | "boom" | "info" | "trap", small = false) => {
    const node = hud.current.callout;
    if (!node) return;
    node.textContent = text; node.dataset.tone = tone; node.dataset.small = small ? "true" : "false";
    node.getAnimations().forEach((a) => a.cancel());
    node.animate([
      { opacity: 0, transform: "translate(-50%, -50%) scale(0.6)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1.06)", offset: 0.15 },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.58 },
      { opacity: 0, transform: "translate(-50%, -110%) scale(0.85)" },
    ], { duration: small ? 850 : 1250, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
  };

  useFrame((_frame, rendererDt) => {
    const started = performance.now(), dt = clock.current.step(frameTime(started), rendererDt), shownAt = clock.current.time;
    if (debug) diagnostics?.frame(rendererDt * 1000, started);
    const v = view.current; v.time += dt;
    const latestFrame = stream.snapshots.latest;
    const current = latestFrame?.snapshot.mode === "bomb_tag" ? latestFrame : null;
    const latest = current?.snapshot ?? null;
    const now = bombOf(latest);
    const enabled = active && !!latest && !!(latest.alive & (1 << slot));
    const predictor = prediction.current;
    if (latest && latest.round !== v.round) {
      v.round = latest.round; v.aimReady = false; v.follow.reset(); v.boom.boom = null; v.spectating = null;
      ghosts.current.forEach((g) => (g.active = false)); wasAlive.current.fill(false); lastCarrier.current = now?.carrier ?? null; visuals.clear();
    }
    if (enabled && current) predictor?.reconcile(current, started);
    if (!paused && !menuOpen) {
      const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
      v.yaw -= dx * BOMB_CAMERA.sensitivity; v.pitch = clampBombPitch(v.pitch + dy * BOMB_CAMERA.sensitivity);
    }
    const sampled = stream.snapshots.sample(shownAt);
    const displayedTick = Math.max(0, Math.floor(stream.snapshots.renderMs * NET.physicsHz / 1000));
    if (!enabled || dt > 0.25) {
      controls.current?.clear(); predictor?.suspend(); accumulator.current = ACCUMULATOR_START;
      if (dt > 0.25) sendInput(neutralIntent());
    } else {
      accumulator.current += Math.min(dt, 0.05);
      const ticks = accumulator.current + 1e-6 >= 1 / NET.inputHz ? Math.min(3, Math.floor((accumulator.current + 1e-6) * NET.physicsHz)) : 0;
      if (ticks > 0 && controls.current) {
        accumulator.current -= ticks / NET.physicsHz;
        const intent = layerIntent(controls.current.readIntent(), v.yaw); intent.viewTick = displayedTick;
        const packet = sendInput(intent);
        if (packet) {
          const result = predictor?.advance(packet, ticks, started);
          if (result?.swing && slot >= 0) {
            const x = predictor!.rig.character.body.translation().x;
            if (audio.playSfx({ name: "punchSwing", actor: slot, x })) stream.markLocalSwing(packet.round, slot, packet.seq);
          }
        }
      }
    }
    const localPose = enabled ? predictor?.pose(Math.min(dt, 0.1), Math.min(1, accumulator.current * NET.physicsHz)) : null;
    const rig = predictor?.active && predictor.rig instanceof BombPredictionRig ? predictor.rig : null;
    if (!sampled || sampled.b.snapshot.mode !== "bomb_tag") return;
    const { a, b, alpha } = sampled, drawn = bombOf(b.snapshot);
    if (!drawn) return;
    const span = Math.max(1, b.snapshot.tick - a.snapshot.tick) / NET.physicsHz;
    for (const player of PLAYERS) {
      const bean = beans.current[player.id]; if (!bean) continue;
      const id = player.id, local = id === slot, alive = !!(b.snapshot.alive & (1 << id)), inMatch = !!(b.snapshot.mask & (1 << id));
      const predicted = local && localPose ? localPose : null, ghost = ghosts.current[id];
      if (wasAlive.current[id] && !alive && inMatch && !ghost.active) {
        for (let i = 0; i < PARTS.length; i++) {
          const node = bean.children[i];
          ghost.pose.set([node.position.x, node.position.y, node.position.z, node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w], i * 7);
        }
        const o = id * 63; ghost.v.set((b.values[o] - a.values[o]) / span, 5.8, (b.values[o + 2] - a.values[o + 2]) / span);
        ghost.spin = id % 2 ? 7 : -7; ghost.age = 0; ghost.active = true;
      }
      wasAlive.current[id] = alive;
      if (ghost.active) { ghost.age += dt; if (ghost.age >= SPECTATE_HOLD) ghost.active = false; }
      bean.visible = inMatch && (alive || ghost.active);
      visuals.setShadow(id, null);
      if (!bean.visible) continue;
      for (let i = 0; i < PARTS.length; i++) {
        const node = bean.children[i], at = i * 7, offset = (id * PARTS.length + i) * 7;
        if (ghost.active) {
          const t = ghost.age;
          node.position.set(ghost.pose[at] + ghost.v.x * t, ghost.pose[at + 1] + ghost.v.y * t + 0.5 * PHYSICS.gravity * t * t, ghost.pose[at + 2] + ghost.v.z * t);
          node.quaternion.set(ghost.pose[at + 3], ghost.pose[at + 4], ghost.pose[at + 5], ghost.pose[at + 6]); node.rotateY(ghost.spin * t);
          node.scale.setScalar(Math.max(0.01, 1 - (t / SPECTATE_HOLD) ** 1.4));
        } else if (predicted) {
          node.position.set(predicted[at], predicted[at + 1], predicted[at + 2]); node.quaternion.set(predicted[at + 3], predicted[at + 4], predicted[at + 5], predicted[at + 6]); node.scale.setScalar(1);
        } else {
          node.position.set(a.values[offset] + (b.values[offset] - a.values[offset]) * alpha, a.values[offset + 1] + (b.values[offset + 1] - a.values[offset + 1]) * alpha, a.values[offset + 2] + (b.values[offset + 2] - a.values[offset + 2]) * alpha);
          scratch.current.q0.set(a.values[offset + 3], a.values[offset + 4], a.values[offset + 5], a.values[offset + 6]);
          scratch.current.q1.set(b.values[offset + 3], b.values[offset + 4], b.values[offset + 5], b.values[offset + 6]);
          node.quaternion.copy(scratch.current.q0).slerp(scratch.current.q1, alpha); node.scale.setScalar(1);
        }
      }
      hitFlash.current[id] = Math.max(0, hitFlash.current[id] - dt);
      const skin = (bean.children[0]?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
      if (skin) skin.emissiveIntensity = (hitFlash.current[id] / 0.15) * 0.7;
      if (!ghost.active) {
        const hips = bean.children[0].position, floor = surfaceBelow(hips.x, hips.z, hips.y);
        if (Number.isFinite(floor) && hips.y - floor < 2.2) visuals.setShadow(id, scratch.current.feet.set(hips.x, floor, hips.z));
      }
    }
    // Confirmed events are the only source of transfer arcs and blast presentation.
    for (const event of stream.drain(b.snapshot.round, stream.snapshots.renderMs, (e) => e.actor === slot || e.target === slot)) {
      if (paused || document.hidden || lobby.status !== "connected") continue;
      audio.playSfx(event); feel.current.trigger(event, slot);
      if ((event.name === "bodyHit" || event.name === "headHit" || event.name === "limbHit") && event.target !== undefined) hitFlash.current[event.target] = 0.15;
      if (event.name === "bombPass" && event.actor !== undefined && event.target !== undefined) {
        const head = beans.current[event.actor]?.getObjectByName("head");
        if (head) visuals.handOff(scratch.current.point.set(head.position.x, head.position.y + 0.3, head.position.z));
        if (event.actor === slot) callout("KURTULDUN!", "safe"); else if (event.target === slot) callout("BOMBA SENDE!", "bomb");
      } else if (event.name === "bombBlast" && event.actor !== undefined) {
        const bean = beans.current[event.actor], hips = bean?.getObjectByName("pelvis")?.position;
        if (hips) visuals.explode(hips, Math.max(0, surfaceBelow(hips.x, hips.z, hips.y)));
        callout("BOOM!", "boom");
      } else if (event.name === "trapSnap" && event.actor === slot) callout("TUZAK! Yavaşladın", "trap", true);
    }
    // Bomb/trap visuals from the drawn authoritative section.
    const carrier = drawn.carrier;
    let carrierView: CarrierView | null = null;
    const carrierBean = carrier !== null && !!(b.snapshot.alive & (1 << carrier)) ? beans.current[carrier] : null;
    const lit = drawn.fuseEnd !== null;
    const renderRoundTick = drawn.tick + (stream.snapshots.renderMs - (b.snapshot.tick * 1000) / NET.physicsHz) * NET.physicsHz / 1000;
    const fuseSeconds = lit ? Math.max(0, (drawn.fuseEnd! - renderRoundTick) / NET.physicsHz) : drawn.nextFuse !== null ? Math.max(0, (drawn.nextFuse - renderRoundTick) / NET.physicsHz) : 0;
    if (carrierBean) {
      const head = carrierBean.getObjectByName("head")!.position, hips = carrierBean.getObjectByName("pelvis")!.position, floor = surfaceBelow(hips.x, hips.z, hips.y);
      carrierView = { head: scratch.current.head.set(head.x, head.y + 0.3, head.z), feet: scratch.current.feet.set(hips.x, Number.isFinite(floor) ? floor : hips.y - STAND, hips.z), lit, fuse: fuseSeconds };
    }
    let shield: Vector3 | null = null;
    if (drawn.previous !== null && drawn.tagBackEnd !== null && drawn.tagBackEnd > renderRoundTick) {
      const hips = beans.current[drawn.previous]?.getObjectByName("pelvis")?.position;
      if (hips) { const floor = surfaceBelow(hips.x, hips.z, hips.y); shield = scratch.current.shield.set(hips.x, Number.isFinite(floor) ? floor : hips.y - STAND, hips.z); }
    }
    visuals.update(v.time, dt, carrierView, shield);
    const traps: BombTrap[] = BOMB_TRAPS.map((point, id) => ({ id, ...point, armed: !!(drawn.armedMask & (1 << id)), rearmIn: Math.max(0, drawn.rearmAt[id] - renderRoundTick), by: null }));
    for (const p of PLAYERS) {
      scratch.current.slowAt[p.id] = null; scratch.current.slowLeft[p.id] = 0;
      if (drawn.slowUntil[p.id] <= renderRoundTick) continue;
      const hips = beans.current[p.id]?.getObjectByName("pelvis")?.position;
      if (!hips) continue;
      const floor = surfaceBelow(hips.x, hips.z, hips.y);
      scratch.current.slowAt[p.id] = scratch.current.slow[p.id].set(hips.x, Number.isFinite(floor) ? floor : hips.y - STAND, hips.z);
      scratch.current.slowLeft[p.id] = Math.min(1, (drawn.slowUntil[p.id] - renderRoundTick) / BOMB_TICKS.trapSlow);
    }
    visuals.updateTraps(v.time, dt, traps, scratch.current.slowAt, scratch.current.slowLeft);
    if (lastCarrier.current !== carrier) lastCarrier.current = carrier;
    // Spectator target and chase camera.
    const survivors = PLAYERS.filter((p) => !!(b.snapshot.alive & (1 << p.id))).map((p) => p.id);
    const selfGhost = slot >= 0 ? ghosts.current[slot] : null;
    if ((slot >= 0 && !!(b.snapshot.alive & (1 << slot))) || selfGhost?.active) v.spectating = null;
    else if (survivors.length && (v.spectating === null || !survivors.includes(v.spectating))) {
      const from = beans.current[slot]?.children[0]?.position;
      v.spectating = from ? survivors.reduce((best, id) => beans.current[id]!.children[0].position.distanceToSquared(from) < beans.current[best]!.children[0].position.distanceToSquared(from) ? id : best) : survivors[0];
      v.follow.blend = 0.5;
    }
    cycle.current = (step) => {
      if (v.spectating === null || !survivors.length) return;
      const at = survivors.indexOf(v.spectating); v.spectating = survivors[(at + step + survivors.length) % survivors.length]; v.follow.blend = 0.5;
    };
    if (v.published !== v.spectating) { v.published = v.spectating; onView({ spectating: v.spectating }); }
    const focus = (v.spectating ?? (slot >= 0 ? slot : survivors[0] ?? 0)) as PlayerId;
    const pelvis = beans.current[focus]?.getObjectByName("pelvis")?.position;
    if (pelvis) scratch.current.pelvis.copy(pelvis);
    if (!v.aimReady && pelvis) { v.yaw = Math.atan2(-pelvis.x, -pelvis.z); v.aimReady = true; }
    const focusRig = focus === slot ? rig : null;
    const vy = focusRig?.character.body.linvel().y ?? 0;
    const pivot = v.follow.update(scratch.current.pelvis, vy, dt);
    v.sprint += (((focusRig?.character.sprint ?? 0) as number) - v.sprint) * (1 - Math.exp(-Math.min(dt, 0.1) / BOMB_CAMERA.sprintEase));
    const pose = bombCameraPose(blockers, pivot, v.yaw, v.pitch, v.sprint, v.boom, dt);
    camera.position.set(pose.position.x, pose.position.y, pose.position.z); camera.lookAt(pivot.x, pivot.y, pivot.z);
    const fov = BOMB_CAMERA.fov + BOMB_CAMERA.sprintFov * v.sprint;
    if (Math.abs(fov - v.fov) > 0.02) { v.fov = fov; (camera as PerspectiveCamera).fov = fov; (camera as PerspectiveCamera).updateProjectionMatrix(); }
    const [shakeX, shakeY] = feel.current.step(dt, settings.cameraShake && !reduced && !paused); camera.position.x += shakeX; camera.position.y += shakeY;
    const skin = (beans.current[focus]?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
    if (skin) { const opacity = bombOwnOpacity(pose.boom), transparent = opacity < 0.999; if (skin.transparent !== transparent) { skin.transparent = transparent; skin.depthWrite = !transparent; skin.needsUpdate = true; } skin.opacity = opacity; }
    // Authoritative HUD clock, projected pointer and carrier vignette.
    const latestRoundTick = now && latestFrame ? now.tick + Math.max(0, (started - latestFrame.received) * NET.physicsHz / 1000) : renderRoundTick;
    const secondsLeft = now?.fuseEnd !== null && now?.fuseEnd !== undefined ? Math.max(0, (now.fuseEnd - latestRoundTick) / NET.physicsHz) : now?.nextFuse !== null && now?.nextFuse !== undefined ? Math.max(0, (now.nextFuse - latestRoundTick) / NET.physicsHz) : 0;
    if (hud.current.fuse) hud.current.fuse.textContent = (now?.fuseEnd !== null || now?.nextFuse !== null) ? secondsLeft.toFixed(1) : "";
    if (hud.current.bar) hud.current.bar.style.transform = `scaleX(${now?.fuseEnd !== null ? secondsLeft / BOMB_TAG.fuse : 0})`;
    if (hud.current.fuse?.parentElement) hud.current.fuse.parentElement.dataset.panic = now?.fuseEnd !== null && secondsLeft <= FUSE_PANIC ? "true" : "false";
    const mine = now?.fuseEnd !== null && now?.carrier === slot;
    if (hud.current.vignette) hud.current.vignette.style.opacity = mine ? String(0.3 + 0.35 * Math.max(0, (FUSE_PANIC - secondsLeft) / FUSE_PANIC)) : "0";
    const target = now?.carrier !== null && now?.carrier !== undefined ? (now.carrier === focus ? survivors.find((id) => id !== focus) ?? null : now.carrier) : null;
    const arrow = hud.current.arrow, node = target !== null ? beans.current[target]?.getObjectByName("head") : null;
    let arrowShown = false;
    if (arrow && node) {
      const p = scratch.current.point.copy(node.position).project(camera), behind = p.z > 1;
      let nx = behind ? -p.x : p.x, ny = behind ? -p.y : p.y;
      if (behind || Math.abs(nx) > 0.94 || Math.abs(ny) > 0.9) {
        const k = Math.max(Math.abs(nx) / 0.86, Math.abs(ny) / 0.8, 1e-6); nx /= k; ny /= k;
        arrow.style.transform = `translate(${(((nx + 1) / 2) * size.width).toFixed(1)}px, ${(((1 - ny) / 2) * size.height).toFixed(1)}px) translate(-50%, -50%)`;
        const targetId = target as PlayerId;
        arrow.style.setProperty("--angle", `${Math.atan2(-ny, nx).toFixed(3)}rad`); arrow.dataset.kind = targetId === now?.carrier ? "bomb" : "target"; arrow.style.color = targetId === now?.carrier ? BOMB_RED : PLAYERS[targetId].color; arrowShown = true;
      }
    }
    if (arrow) arrow.dataset.shown = String(arrowShown);
    const stats = sample.current; stats.frames++; stats.seconds += dt; stats.jsMs += performance.now() - started; stats.hud += dt;
    if (stats.seconds >= 2) {
      stats.fps = stats.frames / stats.seconds;
      if (debug && hud.current.debug) hud.current.debug.dataset.jsMs = (stats.jsMs / stats.frames).toFixed(2);
      stats.frames = stats.seconds = stats.jsMs = 0;
    }
    if (stats.hud >= 0.1 && hud.current.debug) {
      stats.hud = 0;
      const out = hud.current.debug;
      out.dataset.bomb = JSON.stringify({ round: latest?.round, phase: latest?.phase, carrier: now?.carrier, fuseEnd: now?.fuseEnd, nextFuse: now?.nextFuse, tick: now?.tick, traps: now?.rearmAt, slowed: now?.slowUntil, alive: PLAYERS.map((p) => !!(latest!.alive & (1 << p.id))), spectating: v.spectating, prediction: predictor ? { active: predictor.active, corrections: predictor.metrics.corrections, hard: predictor.metrics.hard, maxError: +predictor.metrics.maxError.toFixed(3) } : null, fps: Math.round(stats.fps), calls: gl.info.render.calls, triangles: gl.info.render.triangles });
      if (debug) out.textContent = [
        `Bomba: ${now?.carrier ?? "—"} · fitil sonu ${now?.fuseEnd ?? "—"} · görüntü ${secondsLeft.toFixed(2)} sn · önceki ${now?.previous ?? "—"}`,
        `Tuzak: maske ${now?.armedMask ?? "—"} · yeniden ${now?.rearmAt.join(",") ?? "—"} · yavaş ${now?.slowUntil.join(",") ?? "—"}`,
        `${Math.round(stats.fps)} FPS · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · JS ${out.dataset.jsMs ?? "—"} ms/kare · tahmin ${predictor ? (predictor.metrics.stepMs / Math.max(1, predictor.metrics.steps)).toFixed(2) : "—"} ms/adım · snapshot ${diagnostics?.server?.snapshotBytes ?? "—"} B`,
      ].join("\n");
    }
    stats.net += dt;
    if (debug && diagnostics && hud.current.net && stats.net >= 0.5) { stats.net = 0; hud.current.net.textContent = linkDebugLines(diagnostics, started).join("\n"); }
  });

  return <>
    <BombEnvironment />
    <group ref={scenery}><BombScenery onKit={onKit} /></group>
    <primitive object={visuals.group} />
    {PLAYERS.map((player) => <PlayerBean key={player.id} color={player.color} costume={playerCostumeAtSlot(lobby.players, player.id)} ref={(node) => { beans.current[player.id] = node; }} />)}
  </>;
}

const RESULT_TEXT: Record<string, string> = { "all-fell": "Son oyuncular aynı anda elendi. ", timeout: "Süre sınırı. ", forfeit: "Rakip oyundan ayrıldı. " };

export default function OnlineBombArena(props: Props) {
  const { lobby, bindings, paused, onLeave } = props;
  const viewport = useRef<HTMLDivElement>(null), hud = useRef<HudRefs>({ fuse: null, bar: null, callout: null, arrow: null, vignette: null, debug: null, net: null });
  const [lookMode, setLookMode] = useState<LookMode>(loadLookMode), [lookStatus, setLookStatus] = useState<LookStatus>("unlocked"), [view, setView] = useState<ViewState>({ spectating: null });
  const look = useRef<LookController | null>(null), lookNow = useRef(lookMode); lookNow.current = lookMode;
  const menu = useArenaMenu(!paused), menuOpen = menu.view !== null, inputOff = paused || menuOpen, debugPanel = useDebugPanel(!!props.debug);
  const game = lobby.game?.mode === "bomb_tag" ? lobby.game : null, bomb = bombOf(game), self = lobby.players.find((p) => p.id === lobby.selfId);
  useEffect(() => { if (!inputOff) viewport.current?.focus(); }, [inputOff]);
  const { lockEnded } = menu;
  useEffect(() => {
    const surface = viewport.current; if (!surface) return;
    const controller = bindLook(surface, lookNow.current, setLookStatus, lockEnded); look.current = controller;
    return () => { controller.dispose(); look.current = null; };
  }, [lockEnded]);
  useEffect(() => { look.current?.setMode(lookMode); saveLookMode(lookMode); }, [lookMode]);
  useEffect(() => { look.current?.setEnabled(!inputOff); }, [inputOff]);
  const inMatch = (slot: number) => !!game && !!(game.mask & (1 << slot));
  const roster = lobby.players.filter((p) => inMatch(p.slot) || p.id === lobby.selfId).sort((a, b) => a.slot - b.slot);
  const selfIn = !!self && inMatch(self.slot), selfOut = selfIn && lobby.phase === "playing" && !!game && !(game.alive & (1 << self!.slot));
  const watched = view.spectating !== null ? lobby.players.find((p) => p.slot === view.spectating) : null, winner = lobby.winner >= 0 ? lobby.players.find((p) => p.slot === lobby.winner) : null;
  const carrierPlayer = bomb?.carrier !== null && bomb?.carrier !== undefined ? lobby.players.find((p) => p.slot === bomb.carrier) : null;
  const lit = bomb?.fuseEnd !== null && bomb?.fuseEnd !== undefined;
  const status = (slot: number, connected: boolean) => {
    if (!inMatch(slot)) return "İzliyor";
    if (bomb && bomb.flags[slot] & LAYER_FLAG.forfeit) return "Ayrıldı";
    if (!connected) return "Yeniden bağlanıyor";
    if (game && !(game.alive & (1 << slot))) return "Patladı";
    if (bomb?.carrier === slot) return lit ? "BOMBA" : "Sıradaki";
    if (bomb?.previous === slot && bomb.tagBackEnd !== null && bomb.tagBackEnd > bomb.tick) return "Korumalı";
    return "Oyunda";
  };
  return <div className="party-lab pl-playground pl-immersive" data-mode="bomb_tag">
    <div className="pl-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Online Bomba Sende" data-look={lookMode} data-mode="bomb_tag" onPointerDown={() => viewport.current?.focus()}>
      <Canvas dpr={[1, 1.5]} camera={{ position: [0, 8, 9], fov: BOMB_CAMERA.fov, near: 0.1, far: 180 }} gl={{ antialias: true, alpha: true }} fallback={<p>Bu arena için WebGL 2 gerekiyor.</p>}>
        <OnlineBombView {...props} menuOpen={menuOpen} look={look} viewport={viewport} hud={hud} onView={setView} />
      </Canvas>
      <MenuButton onOpen={() => menu.setView("main")} />
      <div className="pl-bomb-vignette" aria-hidden="true" ref={(el) => void (hud.current.vignette = el)} />
      <div className="pl-round-hud"><ul className="pl-roster" aria-label="Oyuncu durumları">{roster.map((p) => <li key={p.id} className={inMatch(p.slot) && game && !(game.alive & (1 << p.slot)) ? "pl-eliminated" : ""} data-bomb={bomb?.carrier === p.slot && game && !!(game.alive & (1 << p.slot)) ? (lit ? "lit" : "next") : undefined}>
        <span className="pl-player-dot" style={{ backgroundColor: p.color }} aria-hidden="true" /><span><b>{p.nickname} {p.id === lobby.selfId && <small>Sen</small>}</b><span className="pl-bomb-status">{bomb?.carrier === p.slot && <BombIcon lit={lit} />}{status(p.slot, p.connected)}</span></span>
      </li>)}</ul></div>
      {lobby.phase === "playing" && carrierPlayer && <div className="pl-bomb-chip" data-phase={lit ? "armed" : "pending"} data-mine={carrierPlayer.id === lobby.selfId || undefined} role="status">
        <span className="pl-bomb-chip-icon"><BombIcon lit={lit} /></span><span className="pl-bomb-chip-name"><b style={{ color: carrierPlayer.id === lobby.selfId ? undefined : carrierPlayer.color }}>{carrierPlayer.id === lobby.selfId ? (lit ? "Bomba sende!" : "Sıradaki sensin") : lit ? carrierPlayer.nickname : `Sıradaki: ${carrierPlayer.nickname}`}</b><small>{lit ? (carrierPlayer.id === lobby.selfId ? "F ile yakındaki oyuncuya ver" : "Kaç, yakalanma!") : "Yeni fitil birazdan yanıyor"}</small></span>
        <span className="pl-bomb-fuse" ref={(el) => void (hud.current.fuse = el)} /><span className="pl-bomb-bar" aria-hidden="true"><span ref={(el) => void (hud.current.bar = el)} /></span>
      </div>}
      <div className="pl-bomb-callout" aria-hidden="true" ref={(el) => void (hud.current.callout = el)} />
      <div className="pl-bomb-arrow" aria-hidden="true" data-shown="false" ref={(el) => void (hud.current.arrow = el)}><span className="pl-bomb-arrow-head" /><BombIcon /></div>
      <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating} /><div className="pl-debug-panel" hidden={!debugPanel.open} aria-hidden="true"><pre className="pl-bomb-debug" ref={(el) => void (hud.current.debug = el)} />{props.debug && <pre className="pl-net-debug" ref={(el) => void (hud.current.net = el)} />}</div></div>
      {watched && <div className="pl-layer-spectate" role="status">İzleniyor: <b style={{ color: watched.color }}>{watched.nickname}</b><span> · Q / E değiştir</span></div>}
      {lookMode === "lock" && lookStatus !== "locked" && !inputOff && lobby.phase !== "results" && !selfOut && selfIn && <div className="pl-arena-message pl-look-prompt" role="status"><strong>{lookStatus === "error" ? "İmleç kilitlenemedi" : "Kamerayı çevirmek için arenaya tıkla"}</strong><span>{lookStatus === "error" ? "Tekrar tıkla ya da Esc menüsünden sürükleyerek bakışı seç." : "Fare ya da trackpad ile çevir · Esc menü"}</span></div>}
      {(lobby.phase === "countdown" || lobby.phase === "results" || !game || selfOut) && <div className={`pl-arena-message pl-round-message${lobby.phase === "results" ? " pl-result-pulse" : ""}`} role="status" aria-atomic="true">
        {!game ? <strong>Arena bağlanıyor…</strong> : lobby.phase === "countdown" ? <><strong>{lobby.seconds}</strong><span>{carrierPlayer ? (carrierPlayer.id === lobby.selfId ? "Bomba sende! Yakındaki oyuncuya F ile ver." : `Bomba ${carrierPlayer.nickname} oyuncusunda. Kaç!`) : "Hazır ol!"}</span></> : lobby.phase === "results" ? <><strong style={winner ? { color: winner.color } : undefined}>{winner ? `${winner.nickname} kazandı!` : "Berabere!"}</strong><span>{(bomb?.result && RESULT_TEXT[bomb.result]) ?? ""}{bomb ? `${(bomb.tick / 60).toFixed(1)} sn · ` : ""}Yeni tur için lobiye dönülüyor.</span></> : <><strong>Patladın!</strong><span>Diğerlerini izle.</span></>}
      </div>}
      <ControlHint text={controlHint(bindings, "bomb", lookMode)} playing={lobby.phase === "playing"} replay={menu.hintReplay} hidden={menuOpen || selfOut || !selfIn} />
    </div>
    {menu.view && <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={onLeave} lobby={lobby} modeName={MODE_NAMES.bomb_tag} bindings={bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} look={{ mode: lookMode, onChange: setLookMode }} debug={props.debug ? { open: debugPanel.open, onToggle: debugPanel.toggle } : null} />}
  </div>;
}
