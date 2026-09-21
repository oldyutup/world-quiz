import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Vector3, type Group, type PerspectiveCamera } from "three";
import { bindKeyboard } from "../input/keyboard";
import Arena from "./Arena";
import PlayerBean from "./PlayerBean";
import { initializePhysics, PHYSICS, PlaygroundPhysics } from "./physics";

type ArenaStatus = "loading" | "playing" | "fallen" | "error" | "graphics-error";

class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() {
    return this.state.failed
      ? <div className="pl-scene-notice" role="alert">Arena açılamadı. WebGL 2 destekli bir tarayıcıda tekrar dene.</div>
      : this.props.children;
  }
}

function Playground({ onStatus }: { onStatus: (status: ArenaStatus) => void }) {
  const bean = useRef<Group>(null);
  const simulation = useRef<PlaygroundPhysics | null>(null);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const previous = useRef(new Vector3());
  const current = useRef(new Vector3());
  const accumulator = useRef(0);
  const { camera, size } = useThree();

  useEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const distance = Math.max(1, 1.5 / (size.width / Math.max(1, size.height)));
    perspective.position.set(0, 12 * distance, 14 * distance);
    perspective.lookAt(0, 0, 0);
    perspective.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  useEffect(() => {
    let cancelled = false;
    const controls = bindKeyboard();
    keyboard.current = controls;
    void initializePhysics().then(() => {
      if (cancelled) return;
      const physics = new PlaygroundPhysics();
      simulation.current = physics;
      accumulator.current = 0;
      current.current.copy(physics.player.translation());
      previous.current.copy(current.current);
      onStatus("playing");
    }).catch(() => {
      if (!cancelled) onStatus("error");
    });
    return () => {
      cancelled = true;
      controls.dispose();
      keyboard.current = null;
      simulation.current?.dispose();
      simulation.current = null;
    };
  }, [onStatus]);

  useFrame((_, delta) => {
    const physics = simulation.current;
    const controls = keyboard.current;
    if (!physics || !controls || !bean.current) return;
    // Never try to catch up minutes of physics after a hidden tab or debugger pause.
    if (document.hidden || delta > 0.25) {
      accumulator.current = 0;
      controls.clear();
      return;
    }
    accumulator.current += Math.min(delta, 0.1);
    while (accumulator.current >= PHYSICS.step) {
      previous.current.copy(current.current);
      const event = physics.step(controls.input);
      controls.input.jump = false;
      current.current.copy(physics.player.translation());
      if (event) {
        controls.clear();
        onStatus(event === "fell" ? "fallen" : "playing");
        if (event === "respawned") previous.current.copy(current.current);
      }
      accumulator.current -= PHYSICS.step;
    }
    bean.current.visible = !physics.fallen;
    bean.current.position.lerpVectors(previous.current, current.current, accumulator.current / PHYSICS.step);
    if (controls.input.x || controls.input.z) {
      const target = Math.atan2(controls.input.x, controls.input.z);
      const difference = Math.atan2(Math.sin(target - bean.current.rotation.y), Math.cos(target - bean.current.rotation.y));
      bean.current.rotation.y += difference * (1 - Math.exp(-12 * delta));
    }
  });

  return <><Arena /><PlayerBean ref={bean} /></>;
}

export default function ArenaScene({ onExit }: { onExit: () => void }) {
  const [status, setStatus] = useState<ArenaStatus>("loading");
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => { viewport.current?.focus(); }, []);

  return (
    <div className="party-lab pl-playground">
      <header className="pl-arena-header">
        <div><span className="pl-eyebrow">PARTY LAB / YEREL TEST</span><h2>Biraz hareket, biraz kaos.</h2></div>
        <button className="pl-button pl-join" type="button" onClick={onExit}>Lobiye Dön</button>
      </header>
      <div className="pl-viewport" ref={viewport} tabIndex={0} role="region"
        aria-label="Yerel 3D test arenası" aria-describedby="pl-controls"
        onPointerDown={() => viewport.current?.focus()}>
        <SceneBoundary onError={() => setStatus("graphics-error")}>
          <Canvas dpr={[1, 1.5]} camera={{ position: [0, 12, 14], fov: 45, near: 0.1, far: 180 }}
            gl={{ antialias: true, alpha: true }}
            fallback={<div className="pl-scene-notice" role="alert">Bu arena için WebGL 2 desteği gerekiyor.</div>}>
            <hemisphereLight args={["#fff2d9", "#537b7b", 1.8]} />
            <directionalLight position={[4, 10, 6]} intensity={2.2} color="#fff2d9" />
            <Playground onStatus={setStatus} />
          </Canvas>
        </SceneBoundary>
        {status !== "playing" && status !== "graphics-error" && (
          <div className="pl-arena-message" role="status" aria-live="polite">
            {status === "loading" && "Arena hazırlanıyor…"}
            {status === "fallen" && <><strong>Düştün!</strong><span>Bir daha deneyelim.</span></>}
            {status === "error" && "Fizik motoru yüklenemedi. Lobiye dönüp tekrar dene."}
          </div>
        )}
      </div>
      <footer className="pl-arena-footer" id="pl-controls">
        <div><span><kbd>WASD</kbd> — Hareket</span><span><kbd>SPACE</kbd> — Zıpla</span></div>
        <span>Tek oyuncu · Yerel deneme</span>
      </footer>
    </div>
  );
}
