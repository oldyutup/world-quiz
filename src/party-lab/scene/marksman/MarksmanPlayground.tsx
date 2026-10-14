import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import { MARKSMAN as M } from "../../../../shared/party-lab/simulation/marksman/config";
import { MarksmanBot, type MarksmanBotLevel } from "../../../../shared/party-lab/simulation/marksman/bots";
import { GALLERY, fitMarksmanCamera, laneX, projectMarksman, slotPoint } from "./layout";
import { marksmanVisual } from "./visual";
import { marksmanAudio } from "./audio";
import { botView, laneViews, type MarksmanFrame, type MarksmanLook, type MarksmanSource } from "./source";
import { AimKeys, bindMarksmanInput } from "./input";
import type { ClickPresses } from "../clickrace/input";
import { renderPortraits } from "../bomber/portraits";

declare global {
  interface Window {
    /**
     * `?marksmanDebug=1`: the source, the latest frame shown and an autopilot: set it to a bot
     * level and this player is played by that bot through the real keys (aim keys held, fire
     * pressed at the moments it picks).
     */
    __marksman?: { source: MarksmanSource; frame: MarksmanFrame | null; lane: number; autopilot: MarksmanBotLevel | null; shots: number };
  }
}

/**
 * The Nişancı arena: a fixed camera behind the players at the gallery. The gallery comes from
 * `source` (the server online, a local game with bots); the view decides nothing. The aim keys
 * (A / D) turn this player's aim while held, the fire key (Space) shoots.
 */
export default function MarksmanPlayground({ source, looks, self, presses, aimKeys, paused, audio, onStatus, onFrame, onPortraits }: {
  source: MarksmanSource;
  looks: readonly MarksmanLook[];
  /** This player's lane, −1 when watching. */
  self: number;
  presses: ClickPresses;
  aimKeys: AimKeys;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The frame shown, about ten times a second, on every phase change and on every new hit (the HUD). */
  onFrame?: (frame: MarksmanFrame) => void;
  /** The players' character pictures for the HUD (once). */
  onPortraits?: (urls: string[]) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visual = useMemo(() => marksmanVisual(looks, self), [looks, self]);
  useEffect(() => () => visual.dispose(), [visual]);
  const sounds = useMemo(() => marksmanAudio(audio), [audio]);
  useEffect(() => () => sounds.stop(), [sounds]);
  const camera = useMemo(() => Object.assign(new PerspectiveCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  useLayoutEffect(() => {
    const bg = scene.background;
    scene.background = new Color("#1d3940");
    return () => {
      scene.background = bg;
    };
  }, [scene]);
  const now = useRef({ source, self, paused, onFrame });
  now.current = { source, self, paused, onFrame };
  const seen = useRef({ phase: "", count: 0, published: 0, frame: null as MarksmanFrame | null, fit: "", hits: new Set<string>(), shots: [] as number[], opened: false, off: false, signature: "" });
  const pilot = useRef<{ bot: MarksmanBot | null; aim: number; held: string | null; timers: number[] }>({ bot: null, aim: 0, held: null, timers: [] });

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
    const enabled = () => !now.current.paused && !document.hidden && !document.querySelector(".pl-menu-root");
    const unbind = bindMarksmanInput(
      presses,
      aimKeys,
      enabled,
      () => {
        void audio.unlock();
        if (now.current.source.fire(performance.now()) && window.__marksman) window.__marksman.shots++;
      },
      () => now.current.source.aim(aimKeys.aim)
    );
    const p = pilot.current;
    if (new URLSearchParams(window.location.search).get("marksmanDebug") === "1")
      window.__marksman = {
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
        shots: 0,
      };
    return () => {
      unbind();
      p.timers.forEach((timer) => window.clearTimeout(timer));
      if (window.__marksman) delete window.__marksman;
    };
  }, [presses, aimKeys, audio]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, paused, onFrame } = now.current,
      off = paused || document.hidden || !!document.querySelector(".pl-menu-root");
    // Input cut (menu, chat, hidden page): no key stays held, the aim goes back to the middle.
    if (off !== s.off) {
      s.off = off;
      if (off) {
        aimKeys.clear();
        presses.clear();
        source.aim(0);
      }
    }
    const frame = source.frame(dt, off);
    if (!frame) return;
    s.frame = frame;
    const wire = frame.wire,
      count = wire.seats.length;
    const fit = `${camera.uuid}:${size.width}x${size.height}:${count}`;
    if (fit !== s.fit) {
      s.fit = fit;
      fitMarksmanCamera(camera, size.width, size.height, count);
      // The HUD puts each player's card over their stretch and the floating words over the targets.
      const hud = gl.domElement.closest<HTMLElement>(".pl-viewport");
      for (let lane = 0; lane < count; lane++) {
        hud?.style.setProperty(`--pl-mm-x-${lane}`, `${projectMarksman(camera, size.width, size.height, laneX(lane, count), GALLERY.targetY, GALLERY.targetZ).x.toFixed(1)}px`);
        for (let slot = 0; slot < M.slots; slot++) {
          const p = slotPoint(lane, count, slot);
          hud?.style.setProperty(`--pl-mm-x-${lane}-${slot}`, `${projectMarksman(camera, size.width, size.height, p.x, p.y, p.z).x.toFixed(1)}px`);
        }
      }
      hud?.style.setProperty("--pl-mm-y", `${projectMarksman(camera, size.width, size.height, 0, GALLERY.targetY + GALLERY.radius + 0.25, GALLERY.targetZ).y.toFixed(1)}px`);
    }
    const views = laneViews(frame);
    visual.update(frame, views, dt);
    // Debug autopilot: a bot plays this player through the real keys.
    const level = window.__marksman?.autopilot ?? null,
      lane = frame.self,
      p = pilot.current;
    const key = (code: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, bubbles: true }));
    const hold = (aim: number) => {
      if (aim === p.aim) return;
      if (p.held) key(p.held, false);
      p.held = aim === 0 ? null : [...(aim < 0 ? aimKeys.left : aimKeys.right)][0];
      if (p.held) key(p.held, true);
      p.aim = aim;
    };
    if (level && lane >= 0 && !off) {
      if (!p.bot || p.bot.level !== level) p.bot = new MarksmanBot(level, Math.random);
      for (const shot of p.bot.next(botView(frame, lane), frame.now + 40))
        p.timers.push(
          window.setTimeout(() => {
            hold(shot.aim);
            const fire = [...presses.bindings][0] ?? "Space";
            key(fire, true);
            key(fire, false);
          }, Math.max(0, shot.at - frame.now))
        );
      hold(p.bot.aim(frame.now));
    } else if (p.held) hold(0);

    const quiet = paused || document.hidden,
      pan = (l: number) => (l - (count - 1) / 2) / Math.max(1, count - 1);
    // Each shot and each hit once (not what had happened before this view opened: a reconnect).
    const hitKeys = views.flatMap((v, l) => v.hits.map((h) => ({ key: `${l}:${h.wave}:${h.slot}`, l, h })));
    if (!s.opened) {
      s.opened = true;
      hitKeys.forEach(({ key: k }) => s.hits.add(k));
      s.shots = views.map((v) => v.shotAt);
    }
    views.forEach((v, l) => {
      if (v.shotAt <= (s.shots[l] ?? -1e9)) return;
      s.shots[l] = v.shotAt;
      if (!quiet && wire.phase === "shooting") sounds.play("shot", pan(l), l === frame.self ? 1 : 0.45);
    });
    let fresh = false;
    for (const { key: k, l, h } of hitKeys) {
      if (s.hits.has(k)) continue;
      s.hits.add(k);
      fresh = true;
      if (quiet) continue;
      const mine = l === frame.self;
      sounds.play(h.points === M.points.bomb ? "bomb" : h.points === M.points.good ? "good" : "slow", pan(l), mine ? 1 : 0.4);
    }
    const step = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && step > 0 && step !== s.count) audio.playSfx({ name: "countdown", step });
    s.count = step;
    const changed = wire.phase !== s.phase;
    if (!quiet && changed && s.phase) {
      if (wire.phase === "shooting") audio.playSfx({ name: "roundStart" });
      if (wire.phase === "results") audio.playSfx({ name: frame.winner < 0 ? "draw" : "winner", intensity: 0.5 });
    }
    s.phase = wire.phase;
    // The HUD at once for a new hit (the floating word), else about ten times a second.
    const signature = hitKeys.map((h) => h.key).join(",") + `|${views.map((v) => v.score).join(",")}`;
    if (signature !== s.signature) {
      s.signature = signature;
      fresh = true;
    }
    if (onFrame && (changed || fresh || (s.published += dt) >= 0.1)) {
      s.published = 0;
      onFrame(frame);
    }
  });
  return (
    <>
      <hemisphereLight args={["#fff4e2", "#5b4a3c", 1.7]} />
      <directionalLight color="#fff0d8" position={[-6, 14, 10]} intensity={2.1} />
      <pointLight color="#ffd9a0" position={[0, 3.6, -8]} intensity={18} distance={22} decay={1.6} />
      <primitive object={visual.root} />
    </>
  );
}
