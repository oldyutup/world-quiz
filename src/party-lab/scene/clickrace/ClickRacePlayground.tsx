import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { Color, OrthographicCamera } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AudioManager } from "../../audio/AudioManager";
import type { ClickWire } from "../../../../shared/party-lab/simulation/clickrace/wire";
import { RaceEngine } from "../kartrace/audio";
import { clickRaceVisual, type ClickLaneLook } from "./visual";
import { ClickPresses, bindClickInput } from "./input";
import { racing, type ClickFrame, type ClickSource } from "./online";
import { clickInsets, fitClickView } from "./layout";

declare global {
  interface Window {
    /** `?clickDebug=1`: the race source and the latest counted state it shows. */
    __clickRace?: { source: ClickSource; presses: ClickPresses; lane: number; wire: ClickWire | undefined };
  }
}

/**
 * The Tıklama Yarışı arena: a fixed top-down orthographic camera over the whole track.
 * The race comes from `source`: the server online, a local game with bots in the Yerel
 * Test Arenası. Cars only move to what the source counted.
 */
export default function ClickRacePlayground({ source, lanes, self, presses, paused, audio, onStatus, onFrame }: {
  source: ClickSource;
  lanes: readonly ClickLaneLook[];
  /** This player's lane, −1 when watching. */
  self: number;
  presses: ClickPresses;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The race shown, about ten times a second and on every phase change (local HUD). */
  onFrame?: (frame: ClickFrame) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const kit = useLoader(GLTFLoader, "/party-lab/maps/bowling/bowling-kit.glb");
  const visual = useMemo(() => clickRaceVisual(kit.scene, lanes), [kit, lanes]);
  useEffect(() => () => visual.dispose(), [visual]);
  const engine = useMemo(() => new RaceEngine(), []);
  // The arena's own camera, whatever the Canvas was made with.
  const camera = useMemo(() => Object.assign(new OrthographicCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  const now = useRef({ source, self, paused, onFrame });
  now.current = { source, self, paused, onFrame };
  const seen = useRef({ phase: "", count: 0, pressAt: -Infinity, wire: undefined as ClickWire | undefined, published: 0 });

  useLayoutEffect(() => {
    const bg = scene.background;
    scene.background = new Color("#bcd3c0");
    return () => {
      scene.background = bg;
    };
  }, [scene]);
  useEffect(() => {
    onStatus("ready");
  }, [onStatus]);
  useEffect(() => {
    const surface = gl.domElement.closest<HTMLElement>(".pl-viewport");
    if (!surface) return;
    const enabled = () => !now.current.paused && !document.hidden && !document.querySelector(".pl-menu-root");
    const unbind = bindClickInput(surface, presses, enabled, () => {
      engine.unlock();
      void audio.unlock();
      if (!now.current.source.press(performance.now())) return;
      seen.current.pressAt = performance.now();
      visual.burst(now.current.self);
    });
    if (new URLSearchParams(window.location.search).get("clickDebug") === "1")
      window.__clickRace = { get source() { return now.current.source; }, presses, get lane() { return now.current.self; }, get wire() { return seen.current.wire; } };
    const quiet = () => engine.silence();
    window.addEventListener("blur", quiet);
    document.addEventListener("visibilitychange", quiet);
    return () => {
      unbind();
      window.removeEventListener("blur", quiet);
      document.removeEventListener("visibilitychange", quiet);
      if (window.__clickRace?.presses === presses) delete window.__clickRace;
    };
  }, [gl, presses, visual, engine, audio]);
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => {
    if (paused) engine.silence();
  }, [paused, engine]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, self, paused, onFrame } = now.current;
    const view = fitClickView(lanes.length, size.width, size.height, clickInsets(size.width, size.height));
    camera.position.set(...view.position);
    camera.up.set(...view.up);
    camera.lookAt(0, 0, 0);
    Object.assign(camera, { left: view.left, right: view.right, top: view.top, bottom: view.bottom, near: 1, far: 300, zoom: 1 });
    camera.updateProjectionMatrix();
    const frame = source.frame(dt, paused || document.hidden || !!document.querySelector(".pl-menu-root"));
    if (!frame) {
      visual.update([], [], dt, view.portrait);
      return;
    }
    const wire = frame.wire;
    s.wire = wire;
    // Where the server has each car now: its last position carried on at its speed for the
    // snapshot's age (at most one snapshot interval), so cars flow between snapshots.
    const ahead = Math.min(frame.age, 0.1);
    visual.update(
      wire.distance.map((distance, lane) => (distance + wire.speed[lane] * ahead) / wire.track),
      wire.speed,
      dt,
      view.portrait
    );
    const quiet = paused || document.hidden;
    const count = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && count > 0 && count !== s.count) audio.playSfx({ name: "countdown", step: count });
    s.count = count;
    const changed = wire.phase !== s.phase;
    if (!quiet && changed && s.phase) {
      if (wire.phase === "racing") audio.playSfx({ name: "roundStart" });
      if (wire.phase === "results") audio.playSfx({ name: frame.winner < 0 ? "draw" : "winner", intensity: 0.5 });
    }
    s.phase = wire.phase;
    if (onFrame && (changed || (s.published += dt) >= 0.1)) {
      s.published = 0;
      onFrame(frame);
    }
    // Engine: its pitch climbs with this player's car speed (top speed ≈ the race engine's top).
    const throttle = performance.now() - s.pressAt < 160 ? 1 : 0,
      speed = self >= 0 ? wire.speed[self] : 0;
    engine.step(speed * 3, throttle, !quiet && racing(wire, self), audio.settings);
  });
  return (
    <>
      <hemisphereLight args={["#f3eddb", "#819b89", 2.1]} />
      <directionalLight color="#ffe5bd" position={[-10, 24, 14]} intensity={2.3} />
      <primitive object={visual.root} />
    </>
  );
}
