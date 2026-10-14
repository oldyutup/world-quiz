import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import { YARD, fitTowerCamera, projectTower, yardX } from "./layout";
import { towerVisual } from "./visual";
import { towerAudio } from "./audio";
import { botView, yardViews, type TowerFrame, type TowerLook, type TowerSource } from "./source";
import { ClickPresses, bindClickInput } from "../clickrace/input";
import { renderPortraits } from "../bomber/portraits";
import { TowerBot, type TowerBotLevel } from "../../../../shared/party-lab/simulation/boxtower/bots";

declare global {
  interface Window {
    /**
     * `?towerDebug=1`: the source, the latest frame shown and an autopilot: set it to a bot level
     * and this player is played by that bot, pressing the drop key at the moments it picks.
     */
    __boxTower?: { source: TowerSource; frame: TowerFrame | null; lane: number; autopilot: TowerBotLevel | null; presses: number };
  }
}

/**
 * The Kutu Kulesi arena: a fixed camera in front of the row of yards. The yards come from
 * `source` (the server online, a local game with bots); the view decides nothing. The drop key
 * (Space by default) drops this player's box.
 */
export default function TowerPlayground({ source, looks, self, presses, paused, audio, onStatus, onFrame, onPortraits }: {
  source: TowerSource;
  looks: readonly TowerLook[];
  /** This player's lane, −1 when watching. */
  self: number;
  presses: ClickPresses;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The frame shown, about ten times a second and on every phase change (the HUD). */
  onFrame?: (frame: TowerFrame) => void;
  /** The players' character pictures for the HUD (once). */
  onPortraits?: (urls: string[]) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visual = useMemo(() => towerVisual(looks, self), [looks, self]);
  useEffect(() => () => visual.dispose(), [visual]);
  const sounds = useMemo(() => towerAudio(audio), [audio]);
  useEffect(() => () => sounds.stop(), [sounds]);
  const camera = useMemo(() => Object.assign(new PerspectiveCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  useLayoutEffect(() => {
    const bg = scene.background;
    scene.background = new Color("#bcd9ee");
    return () => {
      scene.background = bg;
    };
  }, [scene]);
  const now = useRef({ source, self, paused, onFrame });
  now.current = { source, self, paused, onFrame };
  const seen = useRef({ phase: "", count: 0, published: 0, frame: null as TowerFrame | null, fit: "", landed: [] as number[], dropped: -1, opened: false });
  const pilot = useRef<{ bot: TowerBot | null; timer: number }>({ bot: null, timer: 0 });

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
    const surface = gl.domElement.closest<HTMLElement>(".pl-viewport");
    if (!surface) return;
    const enabled = () => !now.current.paused && !document.hidden && !document.querySelector(".pl-menu-root");
    const unbind = bindClickInput(surface, presses, enabled, () => {
      void audio.unlock();
      if (now.current.source.press(performance.now()) && window.__boxTower) window.__boxTower.presses++;
    });
    if (new URLSearchParams(window.location.search).get("towerDebug") === "1")
      window.__boxTower = {
        get source() {
          return now.current.source;
        },
        get frame() {
          return seen.current.frame;
        },
        get lane() {
          return now.current.self;
        },
        autopilot: null,
        presses: 0,
      };
    return () => {
      unbind();
      window.clearTimeout(pilot.current.timer);
      if (window.__boxTower) delete window.__boxTower;
    };
  }, [gl, presses, audio]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, paused, onFrame } = now.current,
      off = paused || document.hidden || !!document.querySelector(".pl-menu-root");
    const frame = source.frame(dt, off);
    if (!frame) return;
    s.frame = frame;
    const wire = frame.wire,
      count = wire.seats.length;
    const fit = `${camera.uuid}:${size.width}x${size.height}:${count}`;
    if (fit !== s.fit) {
      s.fit = fit;
      fitTowerCamera(camera, size.width, size.height, count);
      // The HUD puts each player's card over their yard.
      const hud = gl.domElement.closest<HTMLElement>(".pl-viewport");
      for (let lane = 0; lane < count; lane++) hud?.style.setProperty(`--pl-tower-x-${lane}`, `${projectTower(camera, size.width, size.height, yardX(lane, count), YARD.wallTop).x.toFixed(1)}px`);
    }
    const views = yardViews(frame);
    visual.update(frame, views, dt);
    // Debug autopilot: a bot presses the drop key for this player at the moments it picks.
    const level = window.__boxTower?.autopilot ?? null,
      lane = frame.self;
    if (level && lane >= 0 && !off) {
      const p = pilot.current;
      if (!p.bot || p.bot.level !== level) p.bot = new TowerBot(level, Math.random);
      const at = p.bot.next(botView(frame, lane), frame.now + 40);
      if (at !== null) {
        const key = [...presses.bindings].find((b) => !b.startsWith("Mouse")) ?? "Space";
        p.timer = window.setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: key, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: key, bubbles: true }));
        }, Math.max(0, at - frame.now));
      }
    }
    const quiet = paused || document.hidden,
      pan = (l: number) => (l - (count - 1) / 2) / Math.max(1, count - 1);
    // Each box once: a swish when this player's drops, a thud (and a lift or a miss) when any lands.
    // Not for what was already down when this view opened (a reconnect).
    if (!s.opened) {
      s.opened = true;
      s.landed = views.map((v) => v.landed?.drop ?? 0);
      s.dropped = frame.self >= 0 ? wire.drops[frame.self] : -1;
    }
    views.forEach((v, l) => {
      if (!v.landed || v.landed.drop <= (s.landed[l] ?? 0)) return;
      s.landed[l] = v.landed.drop;
      if (quiet) return;
      const mine = l === frame.self;
      sounds.play("thud", pan(l), mine ? 1 : 0.55);
      sounds.play(v.landed.good ? "good" : "miss", pan(l), mine ? 1 : 0.4);
    });
    const ownDrop = frame.self >= 0 ? Math.max(wire.drops[frame.self], frame.pending?.drop ?? 0) : -1;
    if (ownDrop > s.dropped) {
      s.dropped = ownDrop;
      if (!quiet) sounds.play("drop", pan(frame.self));
    }
    const step = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && step > 0 && step !== s.count) audio.playSfx({ name: "countdown", step });
    s.count = step;
    const changed = wire.phase !== s.phase;
    if (!quiet && changed && s.phase) {
      if (wire.phase === "stacking") audio.playSfx({ name: "roundStart" });
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
      <hemisphereLight args={["#fff8ec", "#6f7f62", 1.8]} />
      <directionalLight color="#fff0d8" position={[-8, 18, 16]} intensity={2.2} />
      <primitive object={visual.root} />
    </>
  );
}
