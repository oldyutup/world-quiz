import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, OrthographicCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import { pivotX } from "../../../../shared/party-lab/simulation/goldminer/mine";
import { itemKind, itemState, type GoldWire } from "../../../../shared/party-lab/simulation/goldminer/wire";
import { goldMinerVisual, type GoldLaneLook } from "./visual";
import { ClickPresses, bindClickInput } from "../clickrace/input";
import { hookViews, type GoldFrame, type GoldSource, type HookView } from "./online";
import { fitGoldView, goldInsets } from "./layout";
import { bankSound, catchSound, goldAudio } from "./audio";

declare global {
  interface Window {
    /** `?goldDebug=1`: the mine source, the latest frame it showed, this player's lane and the presses. */
    __goldMiner?: { source: GoldSource; presses: ClickPresses; lane: number; frame: GoldFrame | null };
  }
}

/**
 * The Altın Madenci arena: a fixed orthographic side view of the whole mine. The mine comes
 * from `source`: the server online, a local game with bots in the Yerel Test Arenası. Hooks
 * are drawn from the source's numbers at the source's clock; the view decides nothing.
 */
export default function GoldMinerPlayground({ source, lanes, first, self, presses, paused, audio, onStatus, onFrame }: {
  source: GoldSource;
  lanes: readonly GoldLaneLook[];
  /** The round's first wire: the items are built from it once. */
  first: GoldWire;
  /** This player's lane, −1 when watching. */
  self: number;
  presses: ClickPresses;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The mine shown, about ten times a second and on every phase change (local HUD). */
  onFrame?: (frame: GoldFrame) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visual = useMemo(() => goldMinerVisual(lanes, first), [lanes, first]);
  useEffect(() => () => visual.dispose(), [visual]);
  const sounds = useMemo(() => goldAudio(audio), [audio]);
  useEffect(() => () => sounds.stop(), [sounds]);
  // The arena's own camera, whatever the Canvas was made with.
  const camera = useMemo(() => Object.assign(new OrthographicCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  const now = useRef({ source, self, paused, onFrame });
  now.current = { source, self, paused, onFrame };
  const seen = useRef({ phase: "", count: 0, published: 0, frame: null as GoldFrame | null, states: [] as HookView["state"][], banked: new Set<number>(), reel: [] as number[] });

  useLayoutEffect(() => {
    const bg = scene.background;
    scene.background = new Color("#cfe4e6");
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
      void audio.unlock();
      now.current.source.press(performance.now());
    });
    if (new URLSearchParams(window.location.search).get("goldDebug") === "1")
      window.__goldMiner = { get source() { return now.current.source; }, presses, get lane() { return now.current.self; }, get frame() { return seen.current.frame; } };
    return () => {
      unbind();
      if (window.__goldMiner?.presses === presses) delete window.__goldMiner;
    };
  }, [gl, presses, audio]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, paused, onFrame } = now.current;
    const view = fitGoldView(size.width, size.height, goldInsets(size.width, size.height));
    camera.position.set(view.x, view.y, 50);
    camera.up.set(0, 1, 0);
    camera.lookAt(view.x, view.y, 0);
    Object.assign(camera, { left: view.left, right: view.right, top: view.top, bottom: view.bottom, near: 1, far: 200, zoom: 1 });
    camera.updateProjectionMatrix();
    const frame = source.frame(dt, paused || document.hidden || !!document.querySelector(".pl-menu-root"));
    if (!frame) return;
    s.frame = frame;
    const wire = frame.wire,
      views = hookViews(frame);
    visual.update(wire, views, dt);
    const quiet = paused || document.hidden,
      lanesCount = wire.seats.length,
      pan = (lane: number) => pivotX(lane, lanesCount) / 9;
    // Hook cues: a shot, a catch (by weight) or an empty turn, the reel while it comes up.
    views.forEach((v, lane) => {
      const before = s.states[lane] ?? "swing";
      s.states[lane] = v.state;
      if (quiet || wire.out[lane]) return;
      if (before === "swing" && v.state === "out") sounds.play("shot", pan(lane), lane === now.current.self ? 1 : 0.6);
      if (before === "out" && v.state === "back") sounds.play(v.item >= 0 ? catchSound(itemKind(wire, v.item)) : "edge", pan(lane));
      if (v.state === "back" && v.item >= 0) {
        s.reel[lane] = (s.reel[lane] ?? 0) + dt;
        const heavy = ["rock", "big"].includes(itemKind(wire, v.item));
        if (s.reel[lane] > (heavy ? 0.16 : 0.09)) {
          s.reel[lane] = 0;
          sounds.play("reel", pan(lane), lane === now.current.self ? 1 : 0.5);
        }
      }
    });
    // An item up: "+points" in its finder's colour above their winch, and its chime (not for
    // what was already up when this view opened, e.g. after a reconnect).
    const opening = s.phase === "";
    wire.state.forEach((_, i) => {
      if (s.banked.has(i) || itemState(wire, i) !== "banked" || frame.now < wire.at[i]) return;
      s.banked.add(i);
      if (opening) return;
      const lane = wire.by[i],
        look = lanes[lane];
      visual.popup(`+${wire.value[i]}`, look?.color ?? "#f3d27a", pivotX(lane, lanesCount), 0.25);
      if (!quiet) sounds.play(bankSound(itemKind(wire, i)), pan(lane));
    });
    const count = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && count > 0 && count !== s.count) audio.playSfx({ name: "countdown", step: count });
    s.count = count;
    const changed = wire.phase !== s.phase;
    if (!quiet && changed && s.phase) {
      if (wire.phase === "mining") audio.playSfx({ name: "roundStart" });
      if (wire.phase === "results") audio.playSfx({ name: frame.winner < 0 ? "draw" : "winner", intensity: 0.5 });
    }
    s.phase = wire.phase;
    if (onFrame && (changed || (s.published += dt) >= 0.1)) {
      s.published = 0;
      onFrame(frame);
    }
  });
  return (
    <>
      <hemisphereLight args={["#fff6e2", "#6d4c32", 1.9]} />
      <directionalLight color="#ffe8c2" position={[-7, 12, 14]} intensity={2.2} />
      <primitive object={visual.root} />
    </>
  );
}
