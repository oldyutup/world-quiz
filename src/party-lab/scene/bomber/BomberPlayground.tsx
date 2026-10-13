import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import type { Bindings } from "../../input/bindings";
import { bindKeyboard } from "../../input/keyboard";
import { BomberBot, type BomberBotLevel } from "../../../../shared/party-lab/simulation/bomber/bots";
import type { BomberGame } from "../../../../shared/party-lab/simulation/bomber/game";
import { cellCenter } from "../../../../shared/party-lab/simulation/bomber/arena";
import { wireEvents, type BomberWire } from "../../../../shared/party-lab/simulation/bomber/wire";
import { bomberVisual } from "./visual";
import { fitBomberCamera } from "./layout";
import { renderPortraits } from "./portraits";
import { LocalBomber, OnlineBomberSource, toScreen, type BomberControls, type BomberFrame, type BomberLook, type BomberSource } from "./source";

declare global {
  interface Window {
    /**
     * `?bomberDebug=1`: the source, the latest frame shown, and an autopilot: set it to a bot
     * level and this player is played by that bot through the same controls as the keyboard.
     */
    __bomber?: { source: BomberSource; frame: BomberFrame | null; autopilot: BomberBotLevel | null };
  }
}

/** The game the autopilot reads: the local game, or online the prediction's copy of the server's. */
const gameOf = (source: BomberSource): BomberGame | null => (source instanceof LocalBomber ? source.game : source instanceof OnlineBomberSource ? (source.prediction?.game ?? null) : null);

/**
 * The Bombacı arena: a fixed camera above the round arena, this player's start at the bottom of
 * the screen. The arena comes from `source` (the server online, a local game with bots); the
 * view decides nothing. WASD walk along the screen, the jump key (Space) puts a bomb down.
 */
export default function BomberPlayground({ source, looks, first, bindings, paused, audio, onStatus, onFrame, onPortraits }: {
  source: BomberSource;
  looks: readonly BomberLook[];
  /** The round's first section: the arena is built from it once. */
  first: BomberWire;
  bindings: Bindings;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The frame shown, about ten times a second and on every phase change (the HUD). */
  onFrame?: (frame: BomberFrame) => void;
  /** The players' character pictures for the HUD (once). */
  onPortraits?: (urls: string[]) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visual = useMemo(() => bomberVisual(looks, first), [looks, first]);
  useEffect(() => () => visual.dispose(), [visual]);
  const camera = useMemo(() => Object.assign(new PerspectiveCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  useLayoutEffect(() => {
    const bg = scene.background;
    scene.background = new Color("#1c2735");
    return () => {
      scene.background = bg;
    };
  }, [scene]);
  const now = useRef({ source, paused, onFrame });
  now.current = { source, paused, onFrame };
  const seen = useRef({ phase: "", count: 0, published: 0, frame: null as BomberFrame | null, event: -1, fit: "", alive: true, bombs: new Set<string>() });
  const controls = useRef<{ keys: ReturnType<typeof bindKeyboard> | null; suspended: boolean; bot: BomberBot | null; presses: number }>({ keys: null, suspended: false, bot: null, presses: 0 });

  useEffect(() => {
    onStatus("ready");
  }, [onStatus]);
  useEffect(() => {
    if (!onPortraits) return;
    try {
      onPortraits(renderPortraits(gl, looks));
    } catch {
      onPortraits(looks.map(() => ""));
    }
  }, [gl, looks, onPortraits]);
  useEffect(() => {
    const surface = gl.domElement.closest<HTMLElement>(".pl-viewport") ?? gl.domElement;
    const keys = bindKeyboard(surface, bindings);
    controls.current.keys = keys;
    controls.current.suspended = false;
    if (new URLSearchParams(window.location.search).get("bomberDebug") === "1")
      window.__bomber = {
        get source() {
          return now.current.source;
        },
        get frame() {
          return seen.current.frame;
        },
        autopilot: null,
      };
    return () => {
      keys.dispose();
      controls.current.keys = null;
      if (window.__bomber) delete window.__bomber;
    };
  }, [gl, bindings]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, paused, onFrame } = now.current,
      menu = !!document.querySelector(".pl-menu-root"),
      off = paused || document.hidden || menu;
    const keys = controls.current.keys;
    // Only on a change: suspending clears the keys held.
    if (keys && controls.current.suspended !== off) {
      controls.current.suspended = off;
      keys.setSuspended(off);
    }
    let input: BomberControls = { x: 0, z: 0, bomb: false };
    if (keys && !off) {
      const intent = keys.readIntent();
      input = { x: intent.x, z: intent.z, bomb: intent.jump };
    }
    // Debug autopilot: a bot plays this player through the same controls.
    const level = window.__bomber?.autopilot ?? null,
      game = level ? gameOf(source) : null,
      self = s.frame?.self ?? -1;
    if (level && game && self >= 0 && !off) {
      const c = controls.current;
      if (!c.bot || c.bot.level !== level || c.bot.lane !== self) c.bot = new BomberBot(level, self, Math.random);
      const out = c.bot.input(game),
        screen = toScreen(out.x, out.z, s.frame?.yaw ?? 0);
      input = { x: screen.x, z: screen.z, bomb: out.bombs > c.presses };
      c.presses = out.bombs;
    }
    const frame = source.frame(dt, input, off);
    if (!frame) return;
    s.frame = frame;
    const fit = `${camera.uuid}:${size.width}x${size.height}:${frame.yaw.toFixed(4)}`;
    if (fit !== s.fit) {
      s.fit = fit;
      fitBomberCamera(camera, size.width, size.height, frame.yaw);
    }
    visual.update(frame, dt);
    const wire = frame.wire,
      quiet = paused || document.hidden;
    // Events once each (not those already there when this view opened, e.g. after a reconnect).
    const events = wireEvents(wire);
    const opening = s.event < 0;
    for (const e of events) {
      if (e.id <= s.event) continue;
      if (opening) continue;
      if (e.kind === "boom") {
        visual.blast(e.cell);
        if (!quiet) audio.playSfx({ name: "bombBlast", intensity: e.owner === frame.self ? 1 : 0.75, x: pan(e.cell, frame.yaw) });
      } else if (e.kind === "kill") {
        const at = cellCenter(e.cell),
          self = e.by === e.victim;
        if (e.by >= 0) visual.popup(self ? "−1" : "+1", self ? "#ff6b5a" : (looks[e.by]?.color ?? "#fff"), at.x, at.z);
        if (!quiet) audio.playSfx({ name: "death", intensity: e.victim === frame.self ? 1 : 0.7, x: pan(e.cell, frame.yaw) });
      } else if (e.kind === "fall" && !quiet) audio.playSfx({ name: "heavyBump", intensity: 1 });
    }
    s.event = Math.max(s.event, events.length ? events[events.length - 1].id : 0);
    // Own bomb down (predicted or local): a tick. Back from the dead: the respawn cue.
    for (const b of frame.bombs)
      if (!s.bombs.has(b.key)) {
        s.bombs.add(b.key);
        if (b.owner === frame.self && !quiet && b.key[0] !== "s") audio.playSfx({ name: "bombTick", intensity: 0.8 });
      }
    if (s.bombs.size > 64) s.bombs = new Set(frame.bombs.map((b) => b.key));
    const alive = frame.self >= 0 && frame.alive[frame.self];
    if (alive && !s.alive && wire.phase === "playing" && !quiet) audio.playSfx({ name: "respawn" });
    s.alive = alive || frame.self < 0;
    const count = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && count > 0 && count !== s.count) audio.playSfx({ name: "countdown", step: count });
    s.count = count;
    const changed = wire.phase !== s.phase;
    if (!quiet && changed && s.phase) {
      if (wire.phase === "playing") audio.playSfx({ name: "roundStart" });
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
      <hemisphereLight args={["#fff8ea", "#55606e", 1.7]} />
      <directionalLight color="#fff1d6" position={[-6, 14, 9]} intensity={2.1} />
      <primitive object={visual.root} />
    </>
  );
}
/** Where a cell is across the screen, in metres (the sound pans with it). */
function pan(cell: number, yaw: number) {
  const at = cellCenter(cell);
  return toScreen(at.x, at.z, yaw).x * 1.2;
}
