import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Vector3, type Group, type PerspectiveCamera } from "three";
import { bindKeyboard } from "../input/keyboard";
import Arena from "./Arena";
import PlayerBean from "./PlayerBean";
import { initializePhysics, PHYSICS } from "./physics";
import { LocalRoundSimulation } from "./localRound";
import { PLAYERS } from "./players";
import type { RoundSnapshot } from "./roundLogic";

type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";

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

function Playground({ onStatus, onRound }: {
  onStatus: (status: ArenaStatus) => void;
  onRound: (snapshot: RoundSnapshot) => void;
}) {
  const beans = useRef<(Group | null)[]>([]);
  const simulation = useRef<LocalRoundSimulation | null>(null);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const poses = useRef(PLAYERS.map(() => ({ previous: new Vector3(), current: new Vector3() })));
  const accumulator = useRef(0);
  const publishedRevision = useRef(-1);
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
      const local = new LocalRoundSimulation();
      simulation.current = local;
      accumulator.current = 0;
      for (const player of local.physics.players) {
        poses.current[player.id].current.copy(player.body.translation());
        poses.current[player.id].previous.copy(poses.current[player.id].current);
      }
      publishedRevision.current = local.round.revision;
      onRound(local.round.snapshot());
      onStatus("ready");
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
  }, [onStatus, onRound]);

  useFrame((_, delta) => {
    const local = simulation.current;
    const controls = keyboard.current;
    if (!local || !controls) return;
    // Never try to catch up minutes of physics after a hidden tab or debugger pause.
    if (document.hidden || delta > 0.25) {
      accumulator.current = 0;
      controls.clear();
      return;
    }
    accumulator.current += Math.min(delta, 0.1);
    while (accumulator.current >= PHYSICS.step) {
      for (const pose of poses.current) pose.previous.copy(pose.current);
      const event = local.step(controls.input);
      controls.input.jump = false;
      if (event) controls.clear();
      for (const player of local.physics.players) {
        const pose = poses.current[player.id];
        pose.current.copy(player.body.translation());
        if (event === "reset") {
          pose.previous.copy(pose.current);
          beans.current[player.id]?.rotation.set(0, 0, 0);
        }
      }
      if (publishedRevision.current !== local.round.revision) {
        publishedRevision.current = local.round.revision;
        onRound(local.round.snapshot());
      }
      accumulator.current -= PHYSICS.step;
    }
    for (const player of local.physics.players) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const pose = poses.current[player.id];
      bean.visible = !player.eliminated;
      bean.position.lerpVectors(pose.previous, pose.current, accumulator.current / PHYSICS.step);
      const velocity = player.body.linvel();
      if (local.round.phase === "playing" && Math.hypot(velocity.x, velocity.z) > 0.15) {
        const target = Math.atan2(velocity.x, velocity.z);
        const difference = Math.atan2(Math.sin(target - bean.rotation.y), Math.cos(target - bean.rotation.y));
        bean.rotation.y += difference * (1 - Math.exp(-12 * delta));
      }
    }
  });

  return <><Arena />{PLAYERS.map(player => (
    <PlayerBean key={player.id} color={player.color} ref={bean => { beans.current[player.id] = bean; }} />
  ))}</>;
}

export default function ArenaScene({ onExit }: { onExit: () => void }) {
  const [status, setStatus] = useState<ArenaStatus>("loading");
  const [round, setRound] = useState<RoundSnapshot | null>(null);
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
            <Playground onStatus={setStatus} onRound={setRound} />
          </Canvas>
        </SceneBoundary>
        {status === "ready" && round && (
          <>
            <div className="pl-round-hud">
              <ul className="pl-roster" aria-label="Oyuncu durumları">
                {PLAYERS.map(player => (
                  <li key={player.id} className={round.alive[player.id] ? "" : "pl-eliminated"}>
                    <span className="pl-player-dot" style={{ backgroundColor: player.color }} aria-hidden="true" />
                    <span><b>{player.label} <small>{player.id === 0 ? "Sen" : "Bot"}</small></b>
                      <span>{round.alive[player.id] ? "Aktif" : "Elendi"}</span></span>
                  </li>
                ))}
              </ul>
              {round.phase === "playing" && <span className="pl-round-clock" aria-label={`Kalan süre: ${round.seconds} saniye`}>{round.seconds} sn</span>}
            </div>
            {(round.phase !== "playing" || !round.alive[0]) && (
              <div className="pl-arena-message pl-round-message" role="status" aria-atomic="true">
                {round.phase === "countdown" && <><strong>{round.seconds}</strong><span>Hazır ol!</span></>}
                {round.phase === "playing" && <><strong>Düştün!</strong><span>Diğer oyuncuları izle.</span></>}
                {round.phase === "results" && <>
                  <strong style={{ color: round.winner === null ? undefined : PLAYERS[round.winner].color }}>
                    {round.winner === null ? "Berabere!" : `${PLAYERS[round.winner].label} kazandı!`}
                  </strong>
                  <span>{round.reason === "timeout" ? "Süre doldu. " : ""}Yeni tur birazdan.</span>
                </>}
              </div>
            )}
          </>
        )}
        {status !== "ready" && status !== "graphics-error" && (
          <div className="pl-arena-message" role="status" aria-live="polite">
            {status === "loading" && "Arena hazırlanıyor…"}
            {status === "error" && "Fizik motoru yüklenemedi. Lobiye dönüp tekrar dene."}
          </div>
        )}
      </div>
      <footer className="pl-arena-footer" id="pl-controls">
        <div><span><kbd>WASD</kbd> — Hareket</span><span><kbd>SPACE</kbd> — Zıpla</span></div>
        <span>1 oyuncu + 2 yerel bot</span>
      </footer>
    </div>
  );
}
