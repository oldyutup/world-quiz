import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import type { Bindings } from "../../input/bindings";
import { bindKeyboard } from "../../input/keyboard";
import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";
import { RUSH_AT, TRAIN as BY_TRAIN, type TrailGame } from "../../../../shared/party-lab/simulation/trails/game";
import { trainState } from "../../../../shared/party-lab/simulation/trails/train";
import { TrailBot, type TrailBotLevel } from "../../../../shared/party-lab/simulation/trails/bots";
import { trailVisual } from "./visual";
import { fitTrailCamera } from "./layout";
import { trailAudio } from "./audio";
import { renderPortraits } from "../bomber/portraits";
import { LocalTrails, OnlineTrailSource, keysOf, type TrailControls, type TrailFrame, type TrailLook, type TrailSource } from "./source";

declare global {
  interface Window {
    /**
     * `?trailDebug=1`: the source, the latest frame shown, and an autopilot: set it to a bot
     * level and this player is played by that bot through the same controls as the keyboard.
     */
    __trail?: { source: TrailSource; frame: TrailFrame | null; autopilot: TrailBotLevel | null };
  }
}

/** The game the autopilot reads: the local game, or online the prediction's copy of the server's. */
const gameOf = (source: TrailSource): TrailGame | null => (source instanceof LocalTrails ? source.game : source instanceof OnlineTrailSource ? (source.prediction?.game ?? null) : null);

/**
 * The Işık İzi arena: a fixed camera above it, the same for everyone (W up the screen, the rail
 * straight across). The arena comes from `source` (the server online, a local game with bots);
 * the view decides nothing. The movement keys (WASD and the arrows) point where to run.
 */
export default function TrailPlayground({ source, looks, bindings, paused, audio, onStatus, onFrame, onPortraits }: {
  source: TrailSource;
  looks: readonly TrailLook[];
  bindings: Bindings;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The frame shown, about ten times a second and on every phase change (the HUD). */
  onFrame?: (frame: TrailFrame) => void;
  /** The players' character pictures for the HUD (once). */
  onPortraits?: (urls: string[]) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visual = useMemo(() => trailVisual(looks), [looks]);
  useEffect(() => () => visual.dispose(), [visual]);
  const sounds = useMemo(() => trailAudio(audio), [audio]);
  useEffect(() => () => sounds.stop(), [sounds]);
  const camera = useMemo(() => Object.assign(new PerspectiveCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  useLayoutEffect(() => {
    const bg = scene.background,
      clipping = gl.localClippingEnabled;
    scene.background = new Color("#04060c");
    // The train is cut off at the side walls (it comes out of the tunnels).
    gl.localClippingEnabled = true;
    return () => {
      scene.background = bg;
      gl.localClippingEnabled = clipping;
    };
  }, [scene, gl]);
  const now = useRef({ source, paused, onFrame });
  now.current = { source, paused, onFrame };
  const seen = useRef({ phase: "", count: 0, published: 0, frame: null as TrailFrame | null, fit: "", alive: [] as boolean[], train: "", rush: false });
  const controls = useRef<{ keys: ReturnType<typeof bindKeyboard> | null; suspended: boolean; bot: TrailBot | null }>({ keys: null, suspended: false, bot: null });

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
    if (new URLSearchParams(window.location.search).get("trailDebug") === "1")
      window.__trail = {
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
      if (window.__trail) delete window.__trail;
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
    let input: TrailControls = { x: 0, z: 0 };
    if (keys && !off) {
      const intent = keys.readIntent();
      input = keysOf(intent.x, intent.z);
    }
    // Debug autopilot: a bot plays this player through the same controls.
    const level = window.__trail?.autopilot ?? null,
      game = level ? gameOf(source) : null,
      self = s.frame?.self ?? -1;
    if (level && game && self >= 0 && !off) {
      const c = controls.current;
      if (!c.bot || c.bot.level !== level || c.bot.lane !== self) c.bot = new TrailBot(level, self, Math.random);
      input = c.bot.input(game);
    }
    const frame = source.frame(dt, input, off);
    if (!frame) return;
    s.frame = frame;
    const fit = `${camera.uuid}:${size.width}x${size.height}`;
    if (fit !== s.fit) {
      s.fit = fit;
      fitTrailCamera(camera, size.width, size.height);
    }
    visual.update(frame, dt);
    const wire = frame.wire,
      quiet = paused || document.hidden,
      playing = wire.phase === "playing";
    // Crashes: once each, where they happened.
    frame.alive.forEach((alive, lane) => {
      if (s.alive[lane] && !alive && playing && !quiet) {
        const pan = Math.max(-1, Math.min(1, frame.x[lane] / (L.width / 2)));
        sounds.play("crash", pan, lane === frame.self ? 1 : 0.75);
        if (wire.cause[lane] !== BY_TRAIN) sounds.play("zap", pan, 0.8);
        audio.playSfx({ name: "death", intensity: lane === frame.self ? 1 : 0.6, x: pan * 6 });
      }
    });
    s.alive = [...frame.alive];
    // The train: the horn when its warning starts, the rumble as it comes in.
    const train = playing ? trainState(frame.step) : null,
      key = train ? `${train.k}:${train.phase}` : "";
    if (train && key !== s.train && !quiet) {
      if (train.phase === "warn") sounds.play("horn", train.dir > 0 ? -0.8 : 0.8);
      if (train.phase === "run") sounds.play("rumble", 0, 1);
    }
    s.train = key;
    const rush = playing && frame.step > RUSH_AT;
    if (rush && !s.rush && !quiet) sounds.play("rush");
    s.rush = rush;
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
      <hemisphereLight args={["#dfe9ff", "#202638", 1.6]} />
      <directionalLight color="#fff4e2" position={[-6, 14, 9]} intensity={2} />
      <primitive object={visual.root} />
    </>
  );
}
