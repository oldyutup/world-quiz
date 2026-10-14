import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Fog, PerspectiveCamera } from "three";
import type { AudioManager } from "../../audio/AudioManager";
import type { Bindings } from "../../input/bindings";
import { bindKeyboard } from "../../input/keyboard";
import { GiftBot, type GiftBotLevel, type GiftBotView } from "../../../../shared/party-lab/simulation/gifts/bots";
import { reachAt, type GiftReach } from "../../../../shared/party-lab/simulation/gifts/reach";
import { homeCenter } from "../../../../shared/party-lab/maps/gifts";
import { renderPortraits } from "../bomber/portraits";
import { giftAudio } from "./audio";
import { fitGiftCamera } from "./layout";
import { LocalGift, type GiftControls, type GiftFrame, type GiftLook, type GiftSource } from "./source";
import { GiftVisuals } from "./visuals";

declare global {
  interface Window {
    /**
     * `?giftDebug=1`: the source, the latest frame shown, and an autopilot: set it to a bot level
     * and this player is played by that bot through the same controls as the keyboard.
     */
    __gift?: { source: GiftSource; frame: GiftFrame | null; autopilot: GiftBotLevel | null; reach: GiftReach["kind"] | null };
  }
}
/** What the HUD needs: the frame and what this player's Tut would take now. */
export interface GiftShown {
  frame: GiftFrame;
  reach: GiftReach["kind"] | null;
}

/** A round as a bot sees it, from a drawn frame (the debug autopilot online). */
class FrameView implements GiftBotView {
  frame!: GiftFrame;
  private readonly last = [0, 1, 2].map(() => ({ x: 0, z: 0, vx: 0, vz: 0, seen: false }));
  see(frame: GiftFrame, dt: number) {
    this.frame = frame;
    for (const slot of [0, 1, 2]) {
      const pose = frame.poses[slot],
        l = this.last[slot];
      if (!pose) {
        l.seen = false;
        continue;
      }
      if (l.seen && dt > 0) {
        l.vx = l.vx * 0.6 + ((pose[0] - l.x) / dt) * 0.4;
        l.vz = l.vz * 0.6 + ((pose[2] - l.z) / dt) * 0.4;
      }
      l.x = pose[0];
      l.z = pose[2];
      l.seen = true;
    }
  }
  get round() { return { phase: this.frame.phase, tick: Math.floor(this.frame.tick) }; }
  get seats() { return this.frame.gift.seats as (0 | 1 | 2)[]; }
  get pile() { return this.frame.gift.pile; }
  get home() { return this.frame.gift.home; }
  get carrying() { return this.frame.gift.carrying; }
  get boxes() { return this.frame.gift.boxes; }
  get stun() { return this.frame.gift.stunUntil.map((end) => Math.max(0, Math.ceil(end - this.frame.tick))); }
  get guard() { return this.frame.gift.guardUntil.map((end) => Math.max(0, Math.ceil(end - this.frame.tick))); }
  playing(slot: number) { return !!this.frame.poses[slot] && this.frame.gift.seats.includes(slot); }
  homeOf(slot: number) { return homeCenter(this.frame.gift.players, Math.max(0, this.frame.gift.seats.indexOf(slot))); }
  position(slot: number) { const p = this.frame.poses[slot]; return p ? { x: p[0], y: p[1], z: p[2] } : { x: 0, y: 0, z: 0 }; }
  velocity(slot: number) { return { x: this.last[slot].vx, z: this.last[slot].vz }; }
  reachOf(slot: 0 | 1 | 2) { return reachAt(this.position(slot), slot, this.frame.gift, Math.floor(this.frame.tick)); }
}
/** A world-space intent back to device controls for a view looking up the screen along `yaw` (inverse of `layerIntent`). */
function toControls(x: number, z: number, yaw: number) {
  const forward = x * Math.sin(yaw) + z * Math.cos(yaw),
    right = -x * Math.cos(yaw) + z * Math.sin(yaw);
  return { x: right, z: -forward };
}

/**
 * The Hediye Kapmaca yard: a fixed camera above it, this player's home at the bottom of the
 * screen. The round comes from `source` (the server online, a local game with bots); the view
 * decides nothing. WASD walk along the screen, Tut (E) takes a box, Yumruk (F) punches.
 */
export default function GiftPlayground({ source, looks, seats, bindings, paused, audio, onStatus, onFrame, onPortraits }: {
  source: GiftSource;
  /** Per seat. */
  looks: readonly GiftLook[];
  seats: readonly number[];
  bindings: Bindings;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
  /** The frame shown, about ten times a second and on every phase change (the HUD). */
  onFrame?: (shown: GiftShown) => void;
  onPortraits?: (urls: string[]) => void;
}) {
  const { gl, scene, size, set, get } = useThree();
  const visuals = useMemo(() => new GiftVisuals(looks, seats), [looks, seats]);
  useEffect(() => () => visuals.dispose(), [visuals]);
  const sounds = useMemo(() => giftAudio(audio), [audio]);
  useEffect(() => () => sounds.stop(), [sounds]);
  const camera = useMemo(() => Object.assign(new PerspectiveCamera(), { manual: true }), []);
  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);
  useLayoutEffect(() => {
    const background = scene.background,
      fog = scene.fog;
    scene.background = new Color("#1b2a3a");
    scene.fog = new Fog("#1b2a3a", 60, 160);
    return () => {
      scene.background = background;
      scene.fog = fog;
    };
  }, [scene]);
  const now = useRef({ source, paused, onFrame });
  now.current = { source, paused, onFrame };
  const seen = useRef({ phase: "", published: 0, frame: null as GiftFrame | null, fit: "", first: true, view: new FrameView(), bot: null as GiftBot | null });
  const keys = useRef<{ keys: ReturnType<typeof bindKeyboard> | null; suspended: boolean }>({ keys: null, suspended: false });

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
    const bound = bindKeyboard(surface, bindings);
    keys.current.keys = bound;
    keys.current.suspended = false;
    if (new URLSearchParams(window.location.search).get("giftDebug") === "1")
      window.__gift = {
        get source() {
          return now.current.source;
        },
        get frame() {
          return seen.current.frame;
        },
        autopilot: null,
        reach: null,
      };
    return () => {
      bound.dispose();
      keys.current.keys = null;
      if (window.__gift) delete window.__gift;
    };
  }, [gl, bindings]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      s = seen.current,
      { source, paused, onFrame } = now.current,
      off = paused || document.hidden;
    const k = keys.current.keys;
    // Only on a change: suspending clears the keys held.
    if (k && keys.current.suspended !== off) {
      keys.current.suspended = off;
      k.setSuspended(off);
    }
    let controls: GiftControls = { x: 0, z: 0, jump: false, punch: false, pickup: false };
    if (k && !off) {
      const pickup = k.manager.wasActionPressed("grab"),
        intent = k.readIntent();
      controls = { x: intent.x, z: intent.z, jump: intent.jump, punch: intent.punch, pickup };
    }
    // Debug autopilot: a bot plays this player through the same controls.
    const level = window.__gift?.autopilot ?? null;
    if (source instanceof LocalGift) {
      if (level && (!source.autopilot || source.autopilot.level !== level)) {
        source.autopilot = new GiftBot(0, level, 99);
        source.autopilot.reset();
      } else if (!level) source.autopilot = null;
    } else if (level && s.frame && s.frame.self >= 0 && !off) {
      if (!s.bot || s.bot.level !== level || s.bot.slot !== s.frame.self) {
        s.bot = new GiftBot(s.frame.self as 0 | 1 | 2, level, 99);
        s.bot.reset();
      }
      const out = s.bot.update(s.view),
        c = toControls(out.x, out.z, s.frame.yaw);
      controls = { x: c.x, z: c.z, jump: false, punch: !!out.punch, pickup: !!out.pickup };
    }
    const frame = source.frame(delta, controls, off);
    if (!frame) return;
    s.frame = frame;
    s.view.see(frame, dt);
    const fit = `${camera.uuid}:${size.width}x${size.height}:${frame.yaw.toFixed(4)}`;
    if (fit !== s.fit) {
      s.fit = fit;
      fitGiftCamera(camera, size.width, size.height, frame.yaw);
    }
    if (s.first) {
      // A reconnect must not replay the events already there.
      visuals.skipEvents(frame.gift.events);
      s.first = false;
    }
    const fresh = visuals.update(frame, dt),
      quiet = off;
    // Sounds: punches and bumps from the simulation, then the box events (each once).
    if (!quiet) for (const event of frame.feedback) audio.playSfx(event);
    const pan = (x: number, z: number) => {
      const right = -x * Math.cos(frame.yaw) + z * Math.sin(frame.yaw);
      return Math.max(-1, Math.min(1, right / 9));
    };
    if (!quiet)
      for (const e of fresh) {
        const mine = e.actor === frame.self;
        if (e.kind === "pile" || e.kind === "loose") sounds.play("take", pan(e.x, e.z), mine ? 1 : 0.55);
        else if (e.kind === "deposit") sounds.play("home", pan(e.x, e.z), mine ? 1 : 0.5);
        else if (e.kind === "steal") {
          sounds.play("steal", pan(e.x, e.z), mine ? 1 : 0.6);
          if (e.owner === frame.self) sounds.play("stolen", 0, 1);
        } else if (e.kind === "knock") sounds.play("knock", pan(e.x, e.z), mine || e.owner === frame.self ? 1 : 0.6);
        else if (e.kind === "home") sounds.play("land", pan(e.x, e.z), 0.7);
        else if (e.kind === "drop") sounds.play("land", pan(e.x, e.z), 0.5);
      }
    // The countdown, start and result cues come with the simulation's feedback (local and online).
    const changed = frame.phase !== s.phase;
    s.phase = frame.phase;
    // What Tut would take now (the hint): the server's rule on the drawn body.
    const own = frame.self >= 0 ? frame.poses[frame.self] : null,
      reach = own && frame.phase === "playing" && !frame.gift.carrying[frame.self] ? reachAt({ x: own[0], z: own[2] }, frame.self, frame.gift, Math.floor(frame.tick))?.kind ?? null : null;
    if (window.__gift) window.__gift.reach = reach;
    if (onFrame && (changed || (s.published += dt) >= 0.1)) {
      s.published = 0;
      onFrame({ frame, reach });
    }
  });
  return (
    <>
      <hemisphereLight args={["#fff8ec", "#5a6574", 1.55]} />
      <directionalLight color="#fff1d8" position={[-7, 16, 8]} intensity={2.2} />
      <primitive object={visuals.root} />
    </>
  );
}
