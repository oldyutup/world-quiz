import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import type { Bindings } from "../../input/bindings";
import { isHit } from "../../../../shared/party-lab/simulation/rhythm/game";
import { RhythmBot, type RhythmBotLevel } from "../../../../shared/party-lab/simulation/rhythm/bots";
import { rhythmVisual, fitRhythmCamera } from "./visual";
import { RhythmMusic } from "./music";
import { drawLane, type LanePress } from "./lanes";
import { NoteKeys, bindRhythmInput, noteBindings, noteLabels } from "./input";
import type { PressOutcome, RhythmFrame, RhythmLook, RhythmSource } from "./source";
import { renderPortraits } from "../bomber/portraits";

declare global {
  interface Window {
    /**
     * `?rhythmDebug=1`: the source, the latest frame shown, every press this screen judged
     * (its moment, key and outcome) and an autopilot: set it to a bot level and this player is
     * played by that bot through the real keys (key events at the moments it picks).
     */
    __rhythm?: { source: RhythmSource; frame: RhythmFrame | null; autopilot: RhythmBotLevel | null; presses: (PressOutcome & { key: number })[]; music: RhythmMusic };
  }
}

/**
 * The Ritim Ustası arena: a disco stage with the dancers (the 3D scene) above the lanes block
 * (the HUD's canvases, drawn here every frame). The round comes from `source` (the server
 * online, a local game with bots); the view decides nothing. The four note keys press notes;
 * a hit plays its melody note at once. `holdMusic` (the local arena, which pauses with its
 * menu) stops the band while `paused`.
 */
export default function RhythmPlayground({ source, looks, self, bindings, paused, holdMusic = false, audio, onStatus, onFrame, onPortraits }: {
  source: RhythmSource;
  looks: readonly RhythmLook[];
  /** This player's lane, −1 when watching. */
  self: number;
  bindings: Bindings;
  paused: boolean;
  holdMusic?: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The frame shown, about ten times a second, on every phase change and on every new result (the HUD). */
  onFrame?: (frame: RhythmFrame) => void;
  /** The players' character pictures for the HUD (once). */
  onPortraits?: (urls: string[]) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visual = useMemo(() => rhythmVisual(looks, self), [looks, self]);
  useEffect(() => () => visual.dispose(), [visual]);
  const music = useMemo(() => new RhythmMusic(audio), [audio]);
  useEffect(() => () => music.dispose(), [music]);
  const camera = useMemo(() => Object.assign(new PerspectiveCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  useLayoutEffect(() => {
    const bg = scene.background;
    scene.background = new Color("#0f0c1f");
    return () => {
      scene.background = bg;
    };
  }, [scene]);
  const keys = useMemo(() => new NoteKeys(noteBindings(bindings)), [bindings]);
  const labels = useMemo(() => noteLabels(bindings), [bindings]);
  const now = useRef({ source, paused, holdMusic, onFrame });
  now.current = { source, paused, holdMusic, onFrame };
  const seen = useRef({ phase: "", count: 0, published: 0, frame: null as RhythmFrame | null, fit: "", signature: "", off: false, press: null as LanePress | null, canvases: [] as HTMLCanvasElement[], scan: 0 });
  const pilot = useRef<{ bot: RhythmBot | null; round: number; timers: number[] }>({ bot: null, round: -1, timers: [] });

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
    const unbind = bindRhythmInput(keys, enabled, (key, at) => {
      void audio.unlock();
      const { source } = now.current,
        outcome = source.press(at, key),
        frame = seen.current.frame;
      if (!outcome) return;
      seen.current.press = { at: outcome.at, key };
      window.__rhythm?.presses.push({ ...outcome, key });
      // A hit plays its melody note at once, for as long as the note is written.
      if (frame && outcome.grade !== null && isHit(outcome.grade)) {
        const note = frame.song.notes[outcome.note];
        if (note) music.playMelody(note, note.end - outcome.at);
      }
    });
    const p = pilot.current;
    if (new URLSearchParams(window.location.search).get("rhythmDebug") === "1")
      window.__rhythm = {
        get source() {
          return now.current.source;
        },
        get frame() {
          return seen.current.frame;
        },
        autopilot: null,
        presses: [],
        music,
      };
    return () => {
      unbind();
      p.timers.forEach((timer) => window.clearTimeout(timer));
      p.timers = [];
      if (window.__rhythm) delete window.__rhythm;
    };
  }, [keys, audio, music]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, paused, holdMusic, onFrame } = now.current,
      off = paused || document.hidden || !!document.querySelector(".pl-menu-root");
    // Input cut (menu, chat, hidden page): no key stays held.
    if (off !== s.off) {
      s.off = off;
      if (off) keys.clear();
    }
    const frame = source.frame(dt, off);
    if (!frame) return;
    s.frame = frame;
    const wire = frame.wire,
      wall = performance.now();
    const fit = `${camera.uuid}:${size.width}x${size.height}`;
    if (fit !== s.fit) {
      s.fit = fit;
      fitRhythmCamera(camera, size.width, size.height);
    }
    // The band: from just before BAŞLA until the song is over (held while the local menu pauses the round).
    const clock = source.clock(wall);
    music.setSong(frame.song);
    music.update(clock ?? frame.now, wall, !(holdMusic && off) && clock !== null && wire.phase !== "results" && (wire.phase === "playing" || clock > -300));
    visual.update(frame, dt);

    // The lanes, into the HUD's canvases.
    const hud = gl.domElement.closest<HTMLElement>(".pl-viewport");
    if (hud && (s.canvases.length !== wire.seats.length || s.canvases.some((c) => !c.isConnected) || ++s.scan % 60 === 0)) s.canvases = [...hud.querySelectorAll<HTMLCanvasElement>("canvas[data-rh-lane]")];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const canvas of s.canvases) {
      const lane = Number(canvas.dataset.rhLane),
        view = frame.lanes[lane],
        look = looks[lane];
      if (!view || !look) continue;
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      if (!w || !h) continue;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLane(ctx, w, h, frame.song, frame.now, view, { color: look.color, self: lane === frame.self, labels, status: wire.out[lane] ? "out" : "" }, lane === frame.self ? s.press : null);
    }

    // Debug autopilot: a bot plays this player through the real keys.
    const level = window.__rhythm?.autopilot ?? null,
      p = pilot.current;
    if (level && frame.self >= 0 && !off && wire.phase === "playing") {
      if (!p.bot || p.bot.level !== level || p.round !== frame.round) {
        p.bot = new RhythmBot(level, Math.random);
        p.round = frame.round;
      }
      const codes = [bindings.moveForward[0], bindings.moveLeft[0], bindings.moveBackward[0], bindings.moveRight[0]];
      const key = (code: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, bubbles: true }));
      for (const press of p.bot.next(frame.song.notes, frame.now + 80, true)) {
        const code = codes[press.key] ?? "KeyW";
        p.timers.push(
          window.setTimeout(() => {
            key(code, true);
            p.timers.push(window.setTimeout(() => key(code, false), 45));
          }, Math.max(0, press.at - frame.now))
        );
      }
      if (p.timers.length > 400) p.timers = p.timers.slice(-200);
    }

    const quiet = paused || document.hidden;
    const step = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && step > 0 && step !== s.count) audio.playSfx({ name: "countdown", step });
    s.count = step;
    const changed = wire.phase !== s.phase;
    if (!quiet && changed && s.phase && wire.phase === "results") audio.playSfx({ name: frame.winner < 0 ? "draw" : "winner", intensity: 0.5 });
    s.phase = wire.phase;
    // The HUD at once for a new result (the combo grows), else about ten times a second.
    const signature = frame.lanes.map((v) => `${v.results.size}:${v.strays.length}:${v.score}:${v.combo}`).join(",");
    let fresh = false;
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
      <hemisphereLight args={["#f3e9ff", "#3a2c55", 1.6]} />
      <directionalLight color="#fff0f6" position={[-4, 8, 9]} intensity={2.2} />
      <pointLight color="#ff7ad9" position={[-4, 3.5, 2]} intensity={14} distance={14} decay={1.6} />
      <pointLight color="#7ac8ff" position={[4, 3.5, 2]} intensity={14} distance={14} decay={1.6} />
      <primitive object={visual.root} />
    </>
  );
}
