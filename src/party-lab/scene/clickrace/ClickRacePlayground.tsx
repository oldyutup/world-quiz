import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { Color, type OrthographicCamera } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AudioManager } from "../../audio/AudioManager";
import type { GameStream } from "../../network/gameStream";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { ClickWire } from "../../../../shared/party-lab/simulation/clickrace/wire";
import { RaceEngine } from "../kartrace/audio";
import { clickRaceVisual, type ClickLaneLook } from "./visual";
import { ClickPresses, bindClickInput } from "./input";
import { ClickRaceClient } from "./online";
import { clickInsets, fitClickView } from "./layout";

export interface ClickRaceOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
declare global {
  interface Window {
    /** `?clickDebug=1`: the press client and the latest counted state the server sent. */
    __clickRace?: { client: ClickRaceClient; presses: ClickPresses; lane: number; wire: ClickWire | undefined };
  }
}

/**
 * The Tıklama Yarışı arena: a fixed top-down camera over the whole track. Presses go to
 * the server stamped; the cars only ever move to what the server counted.
 */
export default function ClickRacePlayground({ online, round, lanes, self, presses, paused, audio, onStatus }: {
  online: ClickRaceOnline;
  round: number;
  lanes: readonly ClickLaneLook[];
  /** This player's lane, −1 when watching. */
  self: number;
  presses: ClickPresses;
  paused: boolean;
  audio: AudioManager;
  onStatus: (status: "loading" | "ready" | "error") => void;
}) {
  const { camera, gl, scene, size } = useThree();
  const kit = useLoader(GLTFLoader, "/party-lab/maps/bowling/bowling-kit.glb");
  const visual = useMemo(() => clickRaceVisual(kit.scene, lanes), [kit, lanes]);
  useEffect(() => () => visual.dispose(), [visual]);
  const client = useMemo(() => new ClickRaceClient(), []);
  const engine = useMemo(() => new RaceEngine(), []);
  const now = useRef({ online, self, paused });
  now.current = { online, self, paused };
  const seen = useRef({ round: -1, clicks: [] as number[], phase: "", count: 0, pressAt: -Infinity, recent: [] as number[] });

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
  const racing = (wire: ClickWire | undefined) => {
    const lane = now.current.self;
    return !!wire && wire.phase === "racing" && lane >= 0 && wire.finish[lane] < 0 && !wire.out[lane];
  };
  useEffect(() => {
    const surface = gl.domElement.closest<HTMLElement>(".pl-viewport");
    if (!surface) return;
    const enabled = () => !now.current.paused && !document.hidden && !document.querySelector(".pl-menu-root");
    const unbind = bindClickInput(surface, presses, enabled, () => {
      engine.unlock();
      void audio.unlock();
      const latest = now.current.online.stream.snapshots.latest;
      if (!client.press(performance.now(), racing(latest?.snapshot.click))) return;
      const s = seen.current;
      s.pressAt = performance.now();
      s.recent.push(s.pressAt);
      visual.burst(now.current.self);
    });
    if (new URLSearchParams(window.location.search).get("clickDebug") === "1") window.__clickRace = { client, presses, get lane() { return now.current.self; }, get wire() { return now.current.online.stream.snapshots.latest?.snapshot.click; } };
    const quiet = () => engine.silence();
    window.addEventListener("blur", quiet);
    document.addEventListener("visibilitychange", quiet);
    return () => {
      unbind();
      window.removeEventListener("blur", quiet);
      document.removeEventListener("visibilitychange", quiet);
      if (window.__clickRace?.client === client) delete window.__clickRace;
    };
  }, [gl, presses, client, visual, engine, audio]);
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => {
    if (paused) engine.silence();
  }, [paused, engine]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1),
      { stream, sendInput } = now.current.online,
      latest = stream.snapshots.latest,
      wire = latest?.snapshot.click,
      s = seen.current;
    const cam = camera as OrthographicCamera;
    const view = fitClickView(lanes.length, size.width, size.height, clickInsets(size.width, size.height));
    (cam as OrthographicCamera & { manual?: boolean }).manual = true;
    cam.position.set(...view.position);
    cam.up.set(...view.up);
    cam.lookAt(0, 0, 0);
    Object.assign(cam, { left: view.left, right: view.right, top: view.top, bottom: view.bottom, near: 1, far: 300, zoom: 1 });
    cam.updateProjectionMatrix();
    if (!latest || !wire || latest.snapshot.round !== round) {
      visual.update([], dt, view.portrait);
      return;
    }
    client.observe(wire, round, latest.received);
    client.flush((stamps) => !!sendInput({ x: 0, z: 0, jump: false, click: { seq: 0, round, stamps } }));
    // Other cars puff when the server moves them; this player's car puffed on the press.
    if (s.round !== round) {
      s.round = round;
      s.clicks = [...wire.clicks];
      s.phase = "";
      s.count = 0;
    }
    wire.clicks.forEach((clicks, lane) => {
      if (lane !== now.current.self && clicks > (s.clicks[lane] ?? 0)) visual.burst(lane, clicks - (s.clicks[lane] ?? 0));
      s.clicks[lane] = clicks;
    });
    visual.update(wire.clicks.map((clicks) => clicks / wire.track), dt, view.portrait);
    const quiet = now.current.paused || document.hidden;
    const count = wire.phase === "countdown" ? Math.ceil(wire.countdown) : 0;
    if (!quiet && count > 0 && count !== s.count) audio.playSfx({ name: "countdown", step: count });
    s.count = count;
    if (!quiet && wire.phase !== s.phase && s.phase) {
      if (wire.phase === "racing") audio.playSfx({ name: "roundStart" });
      if (wire.phase === "results") audio.playSfx({ name: latest.snapshot.winner < 0 ? "draw" : "winner", intensity: 0.5 });
    }
    s.phase = wire.phase;
    // Engine: revs with this player's own pressing.
    const t = performance.now();
    while (s.recent.length && s.recent[0] < t - 1000) s.recent.shift();
    const rate = s.recent.length,
      throttle = t - s.pressAt < 160 ? 1 : 0;
    engine.step((rate / 12) * 25, throttle, !quiet && racing(wire), audio.settings);
  });
  return (
    <>
      <hemisphereLight args={["#f3eddb", "#819b89", 2.1]} />
      <directionalLight color="#ffe5bd" position={[-10, 24, 14]} intensity={2.3} />
      <primitive object={visual.root} />
    </>
  );
}
