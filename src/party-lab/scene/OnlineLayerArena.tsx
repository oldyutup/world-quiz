import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
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
import { LayerPredictionRig } from "../network/prediction/layerRig";
import type { LobbySnapshot } from "../network/types";
import type { GameStream } from "../network/gameStream";
import type { NetDiagnostics } from "../network/diagnostics";
import { linkDebugLines } from "../network/debugFormat";
import { NET, neutralIntent, type AnyInputPacket, type GameSnapshot } from "../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../shared/party-lab/intent";
import { LAYER_NAMES, LAYER_TILES, layerBelow } from "../../../shared/party-lab/maps/layers";
import { breakTicks, schedulePhase, type SchedulePhase } from "../../../shared/party-lab/simulation/layers/config";
import { decodeLayerSnapshot, LAYER_FLAG, LayerTileKnowledge, type DecodedLayers } from "../../../shared/party-lab/simulation/layers/wire";
import { TILE_STAGES } from "../../../shared/party-lab/simulation/layers/timeline";
import { MODE_NAMES } from "../../../shared/party-lab/modes";
import { ArenaMenu, ArenaStatus, ControlHint, MenuButton, useArenaMenu, useDebugPanel } from "./ArenaChrome";
import { controlHint } from "./arenaMenu";
import { ACCUMULATOR_START, FrameClock, frameTime } from "./frameClock";
import { usePartyAudio } from "../audio/PartyAudio";
import { CameraFeel } from "../audio/feel";
import { layerIntent, landingMarker } from "./layers/controls";
import { LayerFall } from "./layers/fall";
import { clampLayerPitch, LAYER_CAMERA, LayerFollow, updateLayerCamera, type LayerCameraState } from "./layers/layerCamera";
import { LayerTileVisuals } from "./layers/tileVisuals";
import { LayerEnvironment } from "./layers/LayerPlayground";
import LayerSkyScenery from "./layers/LayerSkyScenery";

/** Seconds the camera stays on a fall that left the round before following someone else (the local arena's). */
const SPECTATE_HOLD = 1.2;
const PHASE_BANNERS: Record<SchedulePhase, string> = { normal: "", fast: "Hızlanıyor", collapse: "Çöküş" };
const HIT_SOUNDS = new Set(["headHit", "bodyHit", "limbHit"]);
const STAND = 0.78;
/** One letter per tile stage (automation readout). */
const STAGE_CODES = "smwcbg";

interface Props {
  lobby: LobbySnapshot;
  stream: GameStream;
  bindings: Bindings;
  /** The arena is hidden (Controls opened from the lobby): no input, no presentation. */
  paused: boolean;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
  onLeave: () => void;
  onBindings: (bindings: Bindings) => void;
  bindingsSaved: boolean;
  diagnostics?: NetDiagnostics | null;
  debug?: boolean;
}
interface Hud {
  clock: HTMLElement | null;
  banner: HTMLElement | null;
  debug: HTMLPreElement | null;
  net: HTMLPreElement | null;
}
/** What the React HUD shows from the frame loop (republished only when it changes). */
interface ViewState {
  /** Who the camera follows while the local player is out or only watching (null: themself). */
  spectating: PlayerId | null;
}

const decoded = new WeakMap<GameSnapshot, DecodedLayers | null>();
/** A snapshot's tile section, validated once. */
function layersOf(s: GameSnapshot | undefined | null) {
  if (!s) return null;
  if (!decoded.has(s)) decoded.set(s, decodeLayerSnapshot(s.layers));
  return decoded.get(s) ?? null;
}
const flag = (d: DecodedLayers | null, slot: number, bit: number) => !!d && slot >= 0 && slot < PLAYERS.length && !!(d.flags[slot] & bit);

function LayerOnlineView({
  lobby,
  stream,
  bindings,
  paused,
  menuOpen,
  sendInput,
  diagnostics,
  debug = false,
  look,
  hud,
  viewport,
  onView,
}: Props & {
  /** Esc menu over the arena: local input stops, the match and its presentation go on. */
  menuOpen: boolean;
  look: MutableRefObject<LookController | null>;
  hud: MutableRefObject<Hud>;
  viewport: RefObject<HTMLDivElement>;
  onView: (view: ViewState) => void;
}) {
  const { gl, camera } = useThree();
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
  const visuals = useMemo(() => new LayerTileVisuals(), []);
  useEffect(() => () => visuals.dispose(), [visuals]);
  /** Tile state known from this round's snapshots, on any round tick. */
  const tiles = useRef(new LayerTileKnowledge());
  const view = useRef({
    round: -1,
    yaw: 0,
    pitch: LAYER_CAMERA.restPitch,
    aimReady: false,
    follow: new LayerFollow(),
    camera: { drop: 0, boom: null } as LayerCameraState,
    spectating: null as PlayerId | null,
    published: { spectating: null as PlayerId | null },
    banner: "normal" as SchedulePhase,
    time: 0,
  });
  /** Per character: normal play (jumps included) or falling between layers. */
  const falls = useRef(PLAYERS.map(() => new LayerFall()));
  /** A body that left the round keeps falling on screen for SPECTATE_HOLD (presentation only). */
  const ghosts = useRef(PLAYERS.map(() => ({ active: false, started: false, age: 0, v: new Vector3(), pose: new Float32Array(63) })));
  /** Whether each body was present on the drawn timeline last frame. */
  const shownBody = useRef(PLAYERS.map(() => false));
  const lastLocal = useRef({ predicted: false, pose: new Float32Array(63), v: new Vector3() });
  const debrisDone = useRef(new Uint8Array(LAYER_TILES.length));
  const hitFlash = useRef(PLAYERS.map(() => 0));
  const agreement = useRef<{ t: number; stages: string }[]>([]);
  const lastApplied = useRef(-1);
  const scratch = useRef({ pelvis: new Vector3(), q: new Quaternion(), fwd: new Vector3(), a: new Quaternion(), b: new Quaternion() });
  const sample = useRef({ seconds: 0, frames: 0, jsMs: 0, fps: 0, hud: 0, net: 0 });
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

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
  useEffect(() => {
    if (slot < 0) return;
    let cancelled = false;
    void initializePhysics()
      .then(() => {
        if (!cancelled) prediction.current = new LocalPrediction(slot, "layer_chaos");
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
      accumulator.current = ACCUMULATOR_START;
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
  const active = !paused && !menuOpen && lobby.status === "connected" && lobby.phase === "playing" && participating;
  useLayoutEffect(() => {
    controls.current?.setBindings(bindings);
    controls.current?.setSuspended(!active);
    if (!active) {
      prediction.current?.suspend();
      accumulator.current = ACCUMULATOR_START;
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    }
  }, [bindings, active, sendInput, audio]);
  // Spectating: Q / E cycle through the players still in (what this screen shows).
  const cycleRef = useRef<(step: 1 | -1) => void>(() => {});
  const inputOffNow = useRef(paused || menuOpen);
  inputOffNow.current = paused || menuOpen;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (inputOffNow.current || isUIInput(event.target) || event.repeat) return;
      if (event.code === "KeyQ") cycleRef.current(-1);
      else if (event.code === "KeyE") cycleRef.current(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useFrame((_frame, rendererDt) => {
    const start = performance.now();
    const dt = clock.current.step(frameTime(start), rendererDt);
    const shownAt = clock.current.time;
    if (debug) diagnostics?.frame(rendererDt * 1000, start);
    const v = view.current;
    v.time += dt;
    const predictor = prediction.current;
    const latestFrame = stream.snapshots.latest;
    const current = latestFrame?.snapshot.mode === "layer_chaos" ? latestFrame : null;
    const latest = current?.snapshot ?? null;
    const now = layersOf(latest);
    // Out of the round (fell, or only watching): no input at all, the view spectates.
    const enabled = active && !document.hidden && !!latest && !!(latest.alive & (1 << slot));
    // ── Tile knowledge from every new snapshot (complete state each time) ──
    if (latest && now && latest.seq !== lastApplied.current) {
      lastApplied.current = latest.seq;
      if (tiles.current.apply(latest.round, now)) {
        let stages = "";
        for (let id = 0; id < LAYER_TILES.length; id++) stages += STAGE_CODES[TILE_STAGES.indexOf(tiles.current.stage(id, now.t))];
        agreement.current.push({ t: latest.phase === "playing" || latest.phase === "results" ? now.t : -1, stages });
        if (agreement.current.length > 24) agreement.current.shift();
      }
    }
    // ── New round: fresh camera, falls, tiles on screen ──
    if (latest && latest.round !== v.round) {
      v.round = latest.round;
      v.aimReady = false;
      v.follow.reset();
      v.camera = { drop: 0, boom: null };
      v.spectating = null;
      v.banner = "normal";
      ghosts.current.forEach((g) => (g.active = g.started = false));
      shownBody.current.fill(false);
      debrisDone.current.fill(0);
      lastLocal.current.predicted = false;
      visuals.reset();
      visuals.setMarker({ kind: "none" }, 0);
      for (const p of PLAYERS) falls.current[p.id].reset(current!.values[p.id * 63 + 1]);
    }
    if (enabled && current) predictor?.reconcile(current, start);
    if (!paused && !menuOpen) {
      const { dx, dy } = look.current?.consume() ?? { dx: 0, dy: 0 };
      v.yaw -= dx * LAYER_CAMERA.sensitivity;
      v.pitch = clampLayerPitch(v.pitch + dy * LAYER_CAMERA.sensitivity);
    }
    // Start behind the own body (or the first player in the round), facing its spawn's way.
    if (current && !v.aimReady) {
      const who = participating && latest!.mask & (1 << slot) ? slot : PLAYERS.find((p) => latest!.mask & (1 << p.id))?.id;
      if (who !== undefined) {
        const o = who * 63;
        scratch.current.q.set(current.values[o + 3], current.values[o + 4], current.values[o + 5], current.values[o + 6]);
        const fwd = scratch.current.fwd.set(0, 0, 1).applyQuaternion(scratch.current.q);
        v.yaw = Math.atan2(fwd.x, fwd.z);
        v.pitch = LAYER_CAMERA.restPitch;
        v.aimReady = true;
      }
    }
    // ── Input and prediction (60 Hz ticks, one packet per frame) ──
    if (!enabled || dt > 0.25) {
      controls.current?.clear();
      predictor?.suspend();
      accumulator.current = ACCUMULATOR_START;
      if (dt > 0.25) sendInput(neutralIntent());
    } else {
      accumulator.current += Math.min(dt, 0.05);
      const ticks = accumulator.current + 1e-6 >= 1 / NET.inputHz ? Math.min(3, Math.floor((accumulator.current + 1e-6) * NET.physicsHz)) : 0;
      const c = controls.current;
      if (ticks > 0 && c) {
        accumulator.current -= ticks / NET.physicsHz;
        const packet = sendInput(layerIntent(c.readIntent(), v.yaw));
        if (packet) {
          const result = predictor?.advance(packet, ticks, start);
          if (result?.swing && slot >= 0) {
            const x = predictor!.rig.character.body.translation().x;
            if (audio.playSfx({ name: "punchSwing", actor: slot, x })) stream.markLocalSwing(packet.round, slot, packet.seq);
          }
        }
      }
    }
    const alpha = Math.min(1, accumulator.current * NET.physicsHz);
    const localPose = enabled ? predictor?.pose(Math.min(dt, 0.1), alpha) : null;
    const rig = predictor?.active && predictor.rig instanceof LayerPredictionRig ? predictor.rig : null;
    const sampled = stream.snapshots.sample(shownAt);
    if (!sampled || sampled.b.snapshot.mode !== "layer_chaos") return;
    const { a, b } = sampled;
    const la = layersOf(a.snapshot),
      lb = layersOf(b.snapshot);
    // Round ticks of the two timelines: the remote one (interpolated snapshots) and the own predicted
    // one. A playing snapshot's `t` is the tick its next step will use, so it shows the field as of
    // tick t − 1 (the predicted pose likewise shows the rig's newest tick, `tick − 1`).
    const shownTick = (s: GameSnapshot, d: DecodedLayers | null) => (!d ? 0 : s.phase === "playing" ? Math.max(0, d.t - 1) : d.t);
    const renderTick =
      la && lb && a.snapshot.round === b.snapshot.round
        ? shownTick(a.snapshot, la) + (shownTick(b.snapshot, lb) - shownTick(a.snapshot, la)) * sampled.alpha
        : shownTick(b.snapshot, lb);
    const predictedTick = localPose && rig ? predictor!.predictedTick(alpha) : null;
    const k = tiles.current;
    // ── Bodies ──
    const { a: qa, b: qb } = scratch.current;
    const span = Math.max(1, b.snapshot.tick - a.snapshot.tick) / NET.physicsHz;
    const localNowAlive = !!latest && !!(latest.alive & (1 << slot));
    for (const player of PLAYERS) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const id = player.id,
        local = id === slot,
        ghost = ghosts.current[id];
      const inMatch = !!(b.snapshot.mask & (1 << id));
      const predicted = local && localPose ? localPose : null;
      const body = predicted ? true : flag(lb, id, LAYER_FLAG.body);
      // The own body stopped being predicted because the server eliminated it: keep it falling from where it was drawn.
      if (local && !predicted && lastLocal.current.predicted && latest && !localNowAlive && !ghost.started) {
        ghost.pose.set(lastLocal.current.pose);
        ghost.v.copy(lastLocal.current.v);
        ghost.active = ghost.started = true;
        ghost.age = 0;
      }
      // A body leaving the drawn timeline (eliminated): its last drawn pose keeps falling.
      if (!body && shownBody.current[id] && !ghost.started && inMatch) {
        for (let i = 0; i < PARTS.length; i++) {
          const part = bean.children[i];
          ghost.pose.set([part.position.x, part.position.y, part.position.z, part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w], i * 7);
        }
        const o = id * 63;
        ghost.v.set((b.values[o] - a.values[o]) / span, (b.values[o + 1] - a.values[o + 1]) / span, (b.values[o + 2] - a.values[o + 2]) / span);
        ghost.active = ghost.started = true;
        ghost.age = 0;
      }
      shownBody.current[id] = body && inMatch;
      if (ghost.active) {
        ghost.age += dt;
        if (ghost.age >= SPECTATE_HOLD) ghost.active = false;
      }
      bean.visible = inMatch && (ghost.active || (body && !ghost.started));
      if (!bean.visible) continue;
      for (let i = 0; i < PARTS.length; i++) {
        const part = bean.children[i],
          at = i * 7,
          offset = (id * PARTS.length + i) * 7;
        if (ghost.active) {
          const t = ghost.age;
          part.position.set(
            ghost.pose[at] + ghost.v.x * t,
            ghost.pose[at + 1] + ghost.v.y * t + 0.5 * PHYSICS.gravity * t * t,
            ghost.pose[at + 2] + ghost.v.z * t
          );
          part.quaternion.set(ghost.pose[at + 3], ghost.pose[at + 4], ghost.pose[at + 5], ghost.pose[at + 6]);
        } else if (predicted) {
          part.position.set(predicted[at], predicted[at + 1], predicted[at + 2]);
          part.quaternion.set(predicted[at + 3], predicted[at + 4], predicted[at + 5], predicted[at + 6]);
        } else {
          part.position.set(
            a.values[offset] + (b.values[offset] - a.values[offset]) * sampled.alpha,
            a.values[offset + 1] + (b.values[offset + 1] - a.values[offset + 1]) * sampled.alpha,
            a.values[offset + 2] + (b.values[offset + 2] - a.values[offset + 2]) * sampled.alpha
          );
          qa.set(a.values[offset + 3], a.values[offset + 4], a.values[offset + 5], a.values[offset + 6]);
          qb.set(b.values[offset + 3], b.values[offset + 4], b.values[offset + 5], b.values[offset + 6]);
          part.quaternion.copy(qa).slerp(qb, sampled.alpha);
        }
      }
      hitFlash.current[id] = Math.max(0, hitFlash.current[id] - dt);
      const skin = (bean.children[0]?.getObjectByName("skin") as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
      if (skin) skin.emissiveIntensity = (hitFlash.current[id] / 0.15) * 0.7;
      // Falls: the own predicted body on its own ticks, everyone else on the remote timeline.
      const pelvis = bean.children[0].position;
      if (!ghost.started) {
        if (local && predicted && rig && predictedTick !== null) {
          k.viewTick = Math.floor(predictedTick);
          falls.current[id].update(k, pelvis.x, pelvis.y, pelvis.z, rig.character.body.linvel().y);
        } else if (body) {
          k.viewTick = Math.floor(renderTick);
          const o = id * 63;
          falls.current[id].update(k, pelvis.x, pelvis.y, pelvis.z, (b.values[o + 1] - a.values[o + 1]) / span);
        }
      }
    }
    lastLocal.current.predicted = !!localPose && !!rig;
    if (localPose && rig) {
      lastLocal.current.pose.set(localPose);
      lastLocal.current.v.copy(rig.character.body.linvel());
    }
    // ── Events on the remote timeline (the own ones at once) ──
    for (const event of stream.drain(b.snapshot.round, stream.snapshots.renderMs, (e) => e.actor === slot || e.target === slot)) {
      if (paused || document.hidden || lobby.status !== "connected") continue;
      audio.playSfx(event);
      feel.current.trigger(event, slot);
      if (HIT_SOUNDS.has(event.name) && event.target !== undefined && event.target >= 0 && event.target < PLAYERS.length) hitFlash.current[event.target] = 0.15;
    }
    // ── Who the camera follows ──
    const drawnAlive = (id: number) => !!(b.snapshot.mask & (1 << id)) && !!(b.snapshot.alive & (1 << id)) && !ghosts.current[id].started;
    const survivors = PLAYERS.filter((p) => drawnAlive(p.id)).map((p) => p.id);
    const ownGhost = slot >= 0 ? ghosts.current[slot] : null;
    const playingSelf = participating && !!(b.snapshot.mask & (1 << slot)) && (localNowAlive || lobby.phase !== "playing") && !ownGhost?.started;
    if (playingSelf || (ownGhost?.active && participating)) v.spectating = null;
    else {
      const watching = v.spectating ?? (participating ? slot : null);
      const ghost = watching !== null ? ghosts.current[watching] : null;
      const stillIn = watching !== null && drawnAlive(watching);
      const doneFalling = !ghost?.active;
      if ((!stillIn && doneFalling && survivors.length) || (watching === null && survivors.length)) {
        const from = watching !== null ? beans.current[watching]?.children[0]?.position : null;
        v.spectating = from
          ? survivors.reduce((best, id) => {
              const p = beans.current[id]?.children[0]?.position,
                q = beans.current[best]?.children[0]?.position;
              return p && q && p.distanceToSquared(from) < q.distanceToSquared(from) ? id : best;
            })
          : survivors[0];
        v.follow.blend = 0.5;
      }
    }
    cycleRef.current = (step) => {
      if (v.spectating === null || !survivors.length) return;
      const at = survivors.indexOf(v.spectating);
      v.spectating = survivors[(at + step + survivors.length) % survivors.length];
      v.follow.blend = 0.5;
    };
    if (v.published.spectating !== v.spectating) {
      v.published.spectating = v.spectating;
      onView({ spectating: v.spectating });
    }
    const focus = (v.spectating ?? (slot >= 0 ? slot : survivors[0] ?? 0)) as PlayerId;
    const focusBean = beans.current[focus];
    const pelvis = scratch.current.pelvis;
    if (focusBean?.children[0]) pelvis.copy(focusBean.children[0].position);
    const focusGhost = ghosts.current[focus];
    const focusPredicted = focus === slot && !!localPose && !!rig && predictedTick !== null;
    // Tiles follow the followed body's timeline: the own predicted ticks while playing, else the remote ones.
    const tileTick = focusPredicted ? predictedTick! : renderTick;
    k.viewTick = Math.floor(tileTick);
    const o = focus * 63;
    const vy = focusGhost.active
      ? focusGhost.v.y + PHYSICS.gravity * focusGhost.age
      : focusPredicted
      ? rig!.character.body.linvel().y
      : (b.values[o + 1] - a.values[o + 1]) / span;
    const fall = falls.current[focus];
    const focusAlive = drawnAlive(focus) || (focus === slot && focusPredicted);
    const phase = b.snapshot.phase;
    const marker = focusAlive && phase === "playing" ? landingMarker(k, fall.falling, pelvis.x, pelvis.y, pelvis.z, vy) : ({ kind: "none" } as const);
    const landingY = marker.kind === "safe" ? LAYER_TILES[marker.tile].top : marker.kind === "danger" ? marker.y : null;
    const pivot = v.follow.update(pelvis, fall, landingY, dt);
    const cam = updateLayerCamera(k, pivot, v.yaw, v.pitch, v.camera, dt);
    camera.position.set(cam.position.x, cam.position.y, cam.position.z);
    camera.lookAt(pivot.x, pivot.y - v.follow.lookDrop, pivot.z);
    const [shakeX, shakeY] = feel.current.step(dt, settings.cameraShake && !reduced && !paused);
    camera.position.x += shakeX;
    camera.position.y += shakeY;
    // ── Tiles: pieces for tiles that just went, then every tile's stage ──
    const visTick = phase === "playing" || phase === "results" ? Math.max(0, tileTick) : 0;
    const whole = Math.floor(visTick);
    const fresh: number[] = [];
    for (let id = 0; id < LAYER_TILES.length; id++) {
      if (debrisDone.current[id] || whole < k.goneTick(id)) continue;
      debrisDone.current[id] = 1;
      // Only a tile seen going now falls as a piece (not one already gone on arrival).
      if (k.goneTick(id) > whole - 20) fresh.push(id);
    }
    if (fresh.length) visuals.spawnDebris(fresh, v.time);
    visuals.update(k, visTick, v.time, dt, focusAlive || focusGhost.active ? pelvis.y : null);
    visuals.setMarker(marker, v.time);
    // ── Anti-stall announcements ──
    const schedule = phase === "playing" ? schedulePhase(whole) : "normal";
    if (schedule !== v.banner) {
      v.banner = schedule;
      const banner = hud.current.banner;
      if (banner && PHASE_BANNERS[schedule]) {
        banner.textContent = PHASE_BANNERS[schedule];
        banner.getAnimations().forEach((animation) => animation.cancel());
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
    // Measurement hook (`?partyDebug=1` and a harness-provided `window.__layerTrace` array only): one row per frame.
    const trace = debug ? (window as { __layerTrace?: unknown[] }).__layerTrace : undefined;
    if (trace && slot >= 0) {
      const own = beans.current[slot]?.children[0]?.position;
      if (own) trace.push({ t: start, dt, x: own.x, y: own.y, z: own.z, predicted: !!localPose, tick: predictedTick ?? renderTick, camX: camera.position.x, camY: camera.position.y, camZ: camera.position.z });
    }
    // ── HUD clock (10 Hz), debug and automation readout ──
    const stats = sample.current;
    stats.frames++;
    stats.seconds += dt;
    stats.jsMs += performance.now() - start;
    if (stats.seconds >= 2) {
      stats.fps = stats.frames / stats.seconds;
      if (debug && hud.current.debug) hud.current.debug.dataset.jsMs = (stats.jsMs / stats.frames).toFixed(2);
      stats.frames = stats.seconds = stats.jsMs = 0;
    }
    stats.hud += dt;
    if (stats.hud < 0.1) return;
    stats.hud = 0;
    const clockText = latest && latest.phase === "playing" && now ? `${Math.floor(now.t / 60)} sn` : "";
    const clockNode = hud.current.clock;
    if (clockNode && clockNode.textContent !== clockText) {
      clockNode.textContent = clockText;
      clockNode.hidden = !clockText;
    }
    const out = hud.current.debug;
    if (out) {
      const own = slot >= 0 ? beans.current[slot]?.children[0]?.position : null;
      out.dataset.layers = JSON.stringify({
        round: latest?.round ?? -1,
        phase,
        t: now?.t ?? null,
        // The newest snapshot's authoritative pelvis per slot (what every client received for tick `t`).
        snap: current && now ? PLAYERS.map((p) => [0, 1, 2].map((k) => Math.round(current.values[p.id * 63 + k] * 1000) / 1000)) : null,
        renderTick: +renderTick.toFixed(2),
        predictedTick: predictedTick === null ? null : +predictedTick.toFixed(2),
        tileTick: +tileTick.toFixed(2),
        agreement: agreement.current.slice(-12),
        alive: PLAYERS.map((p) => (latest ? !!(latest.alive & (1 << p.id)) : false)),
        flags: now?.flags ?? null,
        outAt: now?.outAt ?? null,
        result: now?.result ?? null,
        winner: lobby.winner,
        spectating: v.spectating,
        focus,
        falling: fall.falling,
        marker: marker.kind,
        layer: layerBelow(pelvis.y - 0.3),
        pos: own ? [own.x, own.y - STAND, own.z].map((n) => Math.round(n * 100) / 100) : null,
        bodies: PLAYERS.map((p) => {
          const q = beans.current[p.id]?.children[0]?.position;
          return beans.current[p.id]?.visible && q ? [q.x, q.y - STAND, q.z].map((n) => Math.round(n * 100) / 100) : null;
        }),
        prediction: predictor
          ? { active: predictor.active, hard: predictor.metrics.hard, corrections: predictor.metrics.corrections, maxError: +predictor.metrics.maxError.toFixed(4), pending: predictor.history.records.length, restoredTiles: predictor.rig instanceof LayerPredictionRig ? predictor.rig.restored : 0 }
          : null,
        link: lobby.link,
        fps: Math.round(stats.fps),
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
      });
      if (debug) {
        const counts = k.counts(whole);
        const layer = layerBelow(pelvis.y - 0.3);
        const m = predictor?.metrics;
        const s = diagnostics?.server;
        out.textContent = [
          `Katman: ${layer === -1 ? "boşluk" : `L${layer + 1} ${LAYER_NAMES[layer]}`} · Hayatta: ${survivors.length} · Süre: ${(whole / 60).toFixed(1)} sn · karo zamanı ${focusPredicted ? "tahmin" : "uzak"} ${tileTick.toFixed(1)} (sunucu ${now?.t ?? "—"})`,
          `Karolar: sağlam ${counts.solid} · işaretli ${counts.marked} · uyarı ${counts.warn} · çatlak ${counts.crack} · kırık ${counts.break} · yok ${counts.gone} · kırılma ${(breakTicks(whole) / 60).toFixed(2)} sn`,
          `Konum: x ${pelvis.x.toFixed(2)} · y ${(pelvis.y - STAND).toFixed(2)} · z ${pelvis.z.toFixed(2)} · düşüş: ${fall.falling ? "katmanlar arası" : "yok"} · iniş: ${marker.kind} · bom ${cam.boom.toFixed(2)} m · eğim ${Math.round((cam.pitch * 180) / Math.PI)}°`,
          `${Math.round(stats.fps)} FPS · ${gl.info.render.calls} çizim · ${(gl.info.render.triangles / 1000).toFixed(1)}k üçgen · JS ${out.dataset.jsMs ?? "—"} ms/kare · ${localPose ? "yerel tahmin" : "sunucu görünümü"} · ${m ? (m.stepMs / Math.max(1, m.steps)).toFixed(2) : "—"} ms/tahmin · hata ${m?.error.toFixed(3) ?? "—"} m · max ${m?.maxError.toFixed(3) ?? "—"} · düzeltme ${m?.corrections ?? 0}/${m?.hard ?? 0} sert · bekleyen ${predictor?.history.records.length ?? 0} · ACK ${m?.ackDelayMs.toFixed(0) ?? "—"} ms · geri gelen karo ${rig?.restored ?? 0}`,
          `karo bölümü ${s?.layers?.sectionBytes ?? "—"} B · snapshot ${s?.snapshotBytes ?? "—"} B · kurulan ${s?.layers ? (s.layers.encodeUs).toFixed(0) : "—"} µs · kurulu ${s?.layers?.armed ?? "—"} · yok ${s?.layers?.gone ?? "—"}`,
        ].join("\n");
      }
    }
    stats.net += 0.1;
    if (debug && diagnostics && hud.current.net && stats.net >= 0.5) {
      stats.net = 0;
      hud.current.net.textContent = linkDebugLines(diagnostics, start).join("\n");
    }
  });

  return (
    <>
      <LayerEnvironment />
      <LayerSkyScenery />
      <primitive object={visuals.group} />
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

const RESULT_TEXT: Record<string, string> = {
  "all-fell": "Son oyuncular aynı anda düştü. ",
  timeout: "Süre sınırı. ",
  forfeit: "Rakip oyundan ayrıldı. ",
};

/** Katman Kaosu online: the approved elevated chase camera, server-authoritative tiles, falls and results. */
export default function OnlineLayerArena(props: Props) {
  const { lobby, onLeave, bindings, paused } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const hud = useRef<Hud>({ clock: null, banner: null, debug: null, net: null });
  const [lookMode, setLookMode] = useState<LookMode>(loadLookMode);
  const [lookStatus, setLookStatus] = useState<LookStatus>("unlocked");
  const [viewState, setViewState] = useState<ViewState>({ spectating: null });
  const look = useRef<LookController | null>(null);
  const lookModeNow = useRef(lookMode);
  lookModeNow.current = lookMode;
  const menu = useArenaMenu(!paused);
  const menuOpen = menu.view !== null;
  const inputOff = paused || menuOpen;
  const debugPanel = useDebugPanel(!!props.debug);
  const game = lobby.game?.mode === "layer_chaos" ? lobby.game : null;
  const layers = layersOf(game);
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  useEffect(() => {
    if (!inputOff) viewport.current?.focus();
  }, [inputOff]);
  // A lock the browser ended (Esc, focus loss) opens the menu; the page never re-locks on its
  // own: after "Oyuna Dön" the look prompt asks for a click, and that click only takes the lock.
  const { lockEnded } = menu;
  useEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    const controller = bindLook(surface, lookModeNow.current, setLookStatus, lockEnded);
    look.current = controller;
    return () => {
      controller.dispose();
      look.current = null;
    };
  }, [lockEnded]);
  useEffect(() => {
    look.current?.setMode(lookMode);
    saveLookMode(lookMode);
  }, [lookMode]);
  useEffect(() => {
    look.current?.setEnabled(!inputOff);
  }, [inputOff]);
  const inMatch = (slot: number) => !!game && !!(game.mask & (1 << slot));
  const roster = lobby.players.filter((p) => inMatch(p.slot) || p.id === lobby.selfId).sort((x, y) => x.slot - y.slot);
  const selfIn = !!self && inMatch(self.slot);
  const selfOut = selfIn && lobby.phase === "playing" && !!game && !(game.alive & (1 << self!.slot));
  const watched = viewState.spectating !== null ? lobby.players.find((p) => p.slot === viewState.spectating) : null;
  const winner = lobby.winner >= 0 ? lobby.players.find((p) => p.slot === lobby.winner) : null;
  const status = (slot: number, connected: boolean) => {
    if (!inMatch(slot)) return "İzliyor";
    if (layers && layers.flags[slot] & LAYER_FLAG.forfeit) return "Ayrıldı";
    if (!connected) return "Yeniden bağlanıyor";
    return game && !(game.alive & (1 << slot)) ? "Düştü" : "Oyunda";
  };
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="layer_chaos">
      <div
        className="pl-viewport"
        tabIndex={0}
        ref={viewport}
        role="region"
        aria-label="Online Katman Kaosu"
        data-look={lookMode}
        data-mode="layer_chaos"
        onPointerDown={() => viewport.current?.focus()}
      >
        <Canvas
          dpr={[1, 1.5]}
          camera={{ position: [0, 20, 8], fov: LAYER_CAMERA.fov, near: 0.1, far: 240 }}
          gl={{ antialias: true, alpha: true }}
          fallback={<p>Bu arena için WebGL 2 gerekiyor.</p>}
        >
          <LayerOnlineView {...props} menuOpen={menuOpen} look={look} hud={hud} viewport={viewport} onView={setViewState} />
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        <div className="pl-round-hud">
          <ul className="pl-roster" aria-label="Oyuncu durumları">
            {roster.map((p) => (
              <li key={p.id} className={inMatch(p.slot) && game && !(game.alive & (1 << p.slot)) ? "pl-eliminated" : ""}>
                <span className="pl-player-dot" style={{ backgroundColor: p.color }} aria-hidden="true" />
                <span>
                  <b>
                    {p.nickname} {p.id === lobby.selfId && <small>Sen</small>}
                  </b>
                  <span>{status(p.slot, p.connected)}</span>
                </span>
              </li>
            ))}
          </ul>
          <span className="pl-round-clock" aria-label="Geçen süre" hidden ref={(el) => void (hud.current.clock = el)} />
        </div>
        <div className="pl-layer-banner" aria-live="polite" ref={(el) => void (hud.current.banner = el)} />
        <div className="pl-arena-side">
          <ArenaStatus lobby={lobby} spectating={!self?.participating} />
          {/* Always present (hidden unless the debug panel is open): scripts read `data-layers`. */}
          <div className="pl-debug-panel" hidden={!debugPanel.open} aria-hidden="true">
            <pre className="pl-layer-debug" ref={(el) => void (hud.current.debug = el)} />
            {props.debug && <pre className="pl-net-debug" ref={(el) => void (hud.current.net = el)} />}
          </div>
        </div>
        {watched && (lobby.phase === "playing" || lobby.phase === "countdown") && (
          <div className="pl-layer-spectate" role="status">
            İzleniyor: <b style={{ color: watched.color }}>{watched.nickname}</b>
            <span> · Q / E değiştir</span>
          </div>
        )}
        {lookMode === "lock" && lookStatus !== "locked" && !inputOff && lobby.phase !== "results" && !selfOut && selfIn && (
          <div className="pl-arena-message pl-look-prompt" role="status">
            <strong>{lookStatus === "error" ? "İmleç kilitlenemedi" : "Kamerayı çevirmek için arenaya tıkla"}</strong>
            <span>
              {lookStatus === "error"
                ? "Tekrar tıkla ya da Esc menüsündeki Bakış ayarından “Sürükleyerek bak”ı seç."
                : "Fare ya da trackpad ile çevir · Esc menü"}
            </span>
          </div>
        )}
        {(lobby.phase === "countdown" || lobby.phase === "results" || !game || selfOut) && (
          <div className={`pl-arena-message pl-round-message${lobby.phase === "results" ? " pl-result-pulse" : ""}`} role="status" aria-atomic="true">
            {!game ? (
              <strong>Arena bağlanıyor…</strong>
            ) : lobby.phase === "countdown" ? (
              <>
                <strong>{lobby.seconds}</strong>
                <span>Hazır ol! Bastığın karo kırılır. Alt katmana düşmek serbest; en alttan düşen elenir.</span>
              </>
            ) : lobby.phase === "results" ? (
              <>
                <strong style={winner ? { color: winner.color } : undefined}>{winner ? `${winner.nickname} kazandı!` : "Berabere!"}</strong>
                <span>
                  {(layers?.result && RESULT_TEXT[layers.result]) ?? ""}
                  {layers ? `${(layers.t / 60).toFixed(1)} sn · ` : ""}Yeni tur için lobiye dönülüyor.
                </span>
              </>
            ) : (
              <>
                <strong>Düştün!</strong>
                <span>Son katmanın altına düştün. Diğerlerini izle.</span>
              </>
            )}
          </div>
        )}
        <ControlHint text={controlHint(bindings, "layers", lookMode)} playing={lobby.phase === "playing"} replay={menu.hintReplay} hidden={menuOpen || selfOut || !selfIn} />
      </div>
      {menu.view && (
        <ArenaMenu
          view={menu.view}
          setView={menu.setView}
          onResume={() => menu.setView(null)}
          onLeave={onLeave}
          lobby={lobby}
          modeName={MODE_NAMES.layer_chaos}
          bindings={bindings}
          onBindings={props.onBindings}
          bindingsSaved={props.bindingsSaved}
          look={{ mode: lookMode, onChange: setLookMode }}
          debug={props.debug ? { open: debugPanel.open, onToggle: debugPanel.toggle } : null}
        />
      )}
    </div>
  );
}
