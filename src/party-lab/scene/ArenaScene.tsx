import { usePartyAudio } from "../audio/PartyAudio";
import type { AudioManager } from "../audio/AudioManager";
import { CameraFeel } from "../audio/feel";
import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Vector3,
  Quaternion,
  type Group,
  type Mesh,
  type MeshStandardMaterial,
  type PerspectiveCamera,
} from "three";
import { bindKeyboard } from "../input/keyboard";
import Arena from "./Arena";
import { ACTION_LABELS, ACTIONS } from "../input/actions";
import { actionBindingLabel, type Bindings } from "../input/bindings";
import PlayerBean from "./PlayerBean";
import { localCostumeForSlot, type SelectableCostumeId } from "./visual/costumes";
import { PARTS } from "./ragdoll/config";
import { COMBAT } from "./combatConfig";
import { initializePhysics, PHYSICS } from "./physics";
import { LocalRoundSimulation } from "./localRound";
import { PLAYERS } from "./players";
import type { RoundSnapshot } from "./roundLogic";
import {
  ARENA_MAP_IDS,
  arenaMap,
  DEFAULT_ARENA_MAP_ID,
  type ArenaMapId,
} from "../../../shared/party-lab/maps";

type ArenaStatus = "loading" | "ready" | "error" | "graphics-error";
interface CombatHudElements {
  labels: (HTMLSpanElement | null)[];
  meters: (HTMLProgressElement | null)[];
  hint: HTMLDivElement | null;
  performance: HTMLSpanElement | null;
}

class SceneBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? (
      <div className="pl-scene-notice" role="alert">
        Arena açılamadı. WebGL 2 destekli bir tarayıcıda tekrar dene.
      </div>
    ) : (
      this.props.children
    );
  }
}

function Playground({
  onStatus,
  onRound,
  hud,
  bindings,
  paused,
  audio,
  shakeEnabled,
  costumeId,
  mapId,
}: {
  mapId: ArenaMapId;
  onStatus: (status: ArenaStatus) => void;
  onRound: (snapshot: RoundSnapshot) => void;
  hud: MutableRefObject<CombatHudElements>;
  bindings: Bindings;
  paused: boolean;
  audio: AudioManager;
  shakeEnabled: boolean;
  costumeId: SelectableCostumeId;
}) {
  const beans = useRef<(Group | null)[]>([]);
  const simulation = useRef<LocalRoundSimulation | null>(null);
  const keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const poses = useRef(
    PLAYERS.map(() =>
      PARTS.map(() => ({
        previous: new Vector3(),
        current: new Vector3(),
        previousQ: new Quaternion(),
        currentQ: new Quaternion(),
      }))
    )
  );
  const accumulator = useRef(0);
  const publishedRevision = useRef(-1);
  const { camera, size, gl } = useThree();
  const hudTime = useRef(0);
  const cameraBase = useRef(new Vector3());
  const feel = useRef(new CameraFeel());
  const performanceSample = useRef({
    time: 0,
    frames: 0,
    simulationMs: 0,
    steps: 0,
  });

  useEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const distance = Math.max(1, 1.5 / (size.width / Math.max(1, size.height)));
    perspective.position.set(0, 12 * distance, 14 * distance);
    perspective.lookAt(0, 0, 0);
    cameraBase.current.copy(perspective.position);
    perspective.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  useLayoutEffect(() => {
    keyboard.current?.setBindings(bindings);
    keyboard.current?.setSuspended(paused);
    if (paused) { simulation.current?.combat.stop(); audio.stopAll(); feel.current.clear(); }
  }, [bindings, paused]);

  useEffect(() => {
    let cancelled = false;
    const controls = bindKeyboard(gl.domElement, bindings);
    controls.setSuspended(paused);
    keyboard.current = controls;
    void initializePhysics()
      .then(() => {
        if (cancelled) return;
        const local = new LocalRoundSimulation(Math.random, event => { audio.playSfx(event); feel.current.trigger(event); }, arenaMap(mapId));
        simulation.current = local;
        accumulator.current = 0;
        for (const player of local.physics.players) {
          PARTS.forEach((name, index) => {
            const pose = poses.current[player.id][index],
              body = player.parts[name].body;
            pose.current.copy(body.translation());
            pose.previous.copy(pose.current);
            pose.currentQ.copy(body.rotation());
            pose.previousQ.copy(pose.currentQ);
          });
        }
        publishedRevision.current = local.round.revision;
        onRound(local.round.snapshot());
        onStatus("ready");
      })
      .catch(() => {
        if (!cancelled) onStatus("error");
      });
    return () => {
      cancelled = true;
      audio.stopAll();
      feel.current.clear();
      camera.position.copy(cameraBase.current);
      controls.dispose();
      keyboard.current = null;
      simulation.current?.dispose();
      simulation.current = null;
    };
  }, [onStatus, onRound, gl, audio, mapId]);

  useFrame((frame, delta) => {
    const local = simulation.current;
    const controls = keyboard.current;
    if (!local || !controls) return;
    camera.position.copy(cameraBase.current);
    // Never try to catch up minutes of physics after a hidden tab or debugger pause.
    if (paused || document.hidden || delta > 0.25) {
      accumulator.current = 0;
      controls.clear();
      feel.current.clear();
      return;
    }
    accumulator.current += Math.min(delta, 0.1);
    while (accumulator.current >= PHYSICS.step) {
      for (const character of poses.current)
        for (const pose of character) {
          pose.previous.copy(pose.current);
          pose.previousQ.copy(pose.currentQ);
        }
      const start = performance.now();
      const event = local.step(controls.readIntent());
      performanceSample.current.simulationMs += performance.now() - start;
      performanceSample.current.steps++;
      if (event) controls.clear();
      for (const player of local.physics.players) {
        PARTS.forEach((name, index) => {
          const pose = poses.current[player.id][index],
            body = player.parts[name].body;
          pose.current.copy(body.translation());
          pose.currentQ.copy(body.rotation());
          if (event === "reset") {
            pose.previous.copy(pose.current);
            pose.previousQ.copy(pose.currentQ);
          }
        });
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
      bean.visible = !player.eliminated;
      const combat = local.combat.players[player.id];
      PARTS.forEach((name, index) => {
        const node = bean.getObjectByName(name)!,
          pose = poses.current[player.id][index];
        node.position.lerpVectors(
          pose.previous,
          pose.current,
          accumulator.current / PHYSICS.step
        );
        node.quaternion.slerpQuaternions(
          pose.previousQ,
          pose.currentQ,
          accumulator.current / PHYSICS.step
        );
        const mesh = node.getObjectByName("skin") as Mesh;
        (mesh.material as MeshStandardMaterial).emissiveIntensity =
          (combat.flash / COMBAT.punch.flash) * 0.7;
      });
      const stars = bean.getObjectByName("stars")!;
      stars.visible =
        combat.condition.state === "KNOCKED_OUT" ||
        combat.condition.state === "DAZED";
      stars.rotation.y = frame.clock.elapsedTime * 3;
    }
    const [shakeX, shakeY] = feel.current.step(delta, shakeEnabled);
    camera.position.x += shakeX; camera.position.y += shakeY;
    const sample = performanceSample.current;
    sample.time += delta;
    sample.frames++;
    if (sample.time >= 2) {
      if (hud.current.performance)
        hud.current.performance.textContent = `${Math.round(
          sample.frames / sample.time
        )} FPS · ${(sample.simulationMs / Math.max(1, sample.steps)).toFixed(
          1
        )} ms fizik · 27 gövde / 24 eklem`;
      sample.time = sample.frames = sample.simulationMs = sample.steps = 0;
    }
    // Imperative DOM meters at 10Hz, not React state or full component rerenders.
    hudTime.current += delta;
    if (hudTime.current >= 0.1) {
      hudTime.current = 0;
      for (const player of local.combat.players) {
        const label = hud.current.labels[player.id],
          meter = hud.current.meters[player.id];
        const active =
          local.round.phase === "playing" &&
          !local.physics.players[player.id].eliminated;
        const state = player.condition.state,
          grips = local.combat.grips.count(player.id);
        const text = !active
          ? ""
          : state === "KNOCKED_OUT"
          ? "Baygın"
          : state === "RECOVERING"
          ? "Toparlanıyor"
          : state === "DAZED"
          ? "Sersem"
          : local.combat.grips.incoming[player.id].size
          ? "Tutuluyor"
          : grips
          ? `${grips} elle tutuyor`
          : player.punches[0].age >= 0
          ? "Sol yumruk"
          : player.punches[1].age >= 0
          ? "Sağ yumruk"
          : "Hazır";
        if (label && label.textContent !== text) label.textContent = text;
        if (meter) meter.value = active ? player.condition.meter : 0;
      }
      const human = local.combat.players[0];
      const text =
        local.round.phase !== "playing" || local.physics.players[0].eliminated
          ? ""
          : human.condition.state === "KNOCKED_OUT"
          ? "Bayıldın! Birazdan toparlanacaksın."
          : human.condition.state === "RECOVERING"
          ? "Ayağa kalkıyorsun…"
          : local.combat.grips.incoming[0].size
          ? "Tutuldun! Uzaklaş, zıpla veya boş elinle karşılık ver."
          : local.combat.grips.count(0)
          ? `${actionBindingLabel(bindings, "lift")}: kaldır · Savurmak için tutmayı bırak.`
          : `${actionBindingLabel(bindings, "punch")}: yumruk · ${actionBindingLabel(bindings, "grab")}: basılı tut ve yakala.`;
      if (hud.current.hint && hud.current.hint.textContent !== text)
        hud.current.hint.textContent = text;
    }
  });

  return (
    <>
      <Arena mapId={mapId} />
      {PLAYERS.map((player) => (
        <PlayerBean
          key={player.id}
          color={player.color}
          costume={localCostumeForSlot(costumeId, player.id)}
          ref={(bean) => {
            beans.current[player.id] = bean;
          }}
        />
      ))}
    </>
  );
}

export default function ArenaScene({ onExit, bindings, paused, onControls, costumeId }: {
  onExit: () => void;
  bindings: Bindings;
  paused: boolean;
  onControls: () => void;
  costumeId: SelectableCostumeId;
}) {
  const { audio, settings } = usePartyAudio();
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const [status, setStatus] = useState<ArenaStatus>("loading");
  const [mapId, setMapId] = useState<ArenaMapId>(DEFAULT_ARENA_MAP_ID);
  const [round, setRound] = useState<RoundSnapshot | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const combatHud = useRef<CombatHudElements>({
    labels: [],
    meters: [],
    hint: null,
    performance: null,
  });

  useEffect(() => {
    if (!paused) viewport.current?.focus();
  }, [paused]);

  return (
    <div className="party-lab pl-playground">
      <header className="pl-arena-header">
        <div>
          <span className="pl-eyebrow">PARTY LAB / YEREL TEST · {arenaMap(mapId).name.toLocaleUpperCase("tr-TR")}</span>
          <h2>Biraz hareket, biraz kaos.</h2>
        </div>
        <label className="pl-map-select">
          <span>Harita</span>
          <select
            value={mapId}
            onChange={(event) => {
              setStatus("loading");
              setRound(null);
              setMapId(event.target.value as ArenaMapId);
              // Keep arrow keys for the game, not for switching maps mid-round.
              requestAnimationFrame(() => viewport.current?.focus());
            }}
          >
            {ARENA_MAP_IDS.map((id) => (
              <option key={id} value={id}>{arenaMap(id).name}</option>
            ))}
          </select>
        </label>
        <button className="pl-button pl-join" type="button" onClick={onControls}>Kontroller</button>
        <button className="pl-button pl-join" type="button" onClick={onExit} data-sfx="uiBack">
          Lobiye Dön
        </button>
      </header>
      <div
        className="pl-viewport"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Yerel 3D test arenası"
        aria-describedby="pl-controls"
        onPointerDown={() => viewport.current?.focus()}
      >
        <SceneBoundary onError={() => setStatus("graphics-error")}>
          <Canvas
            dpr={[1, 1.5]}
            camera={{ position: [0, 12, 14], fov: 45, near: 0.1, far: 180 }}
            gl={{ antialias: true, alpha: true }}
            fallback={
              <div className="pl-scene-notice" role="alert">
                Bu arena için WebGL 2 desteği gerekiyor.
              </div>
            }
          >
            <Playground
              key={mapId}
              mapId={mapId}
              onStatus={setStatus}
              onRound={setRound}
              hud={combatHud}
              bindings={bindings}
              paused={paused}
              audio={audio}
              shakeEnabled={settings.cameraShake && !reducedMotion}
              costumeId={costumeId}
            />
          </Canvas>
        </SceneBoundary>
        {status === "ready" && round && (
          <>
            <div className="pl-round-hud">
              <ul className="pl-roster" aria-label="Oyuncu durumları">
                {PLAYERS.map((player) => (
                  <li
                    key={player.id}
                    className={round.alive[player.id] ? "" : "pl-eliminated"}
                  >
                    <span
                      className="pl-player-dot"
                      style={{ backgroundColor: player.color }}
                      aria-hidden="true"
                    />
                    <span>
                      <b>
                        {player.label}{" "}
                        <small>{player.id === 0 ? "Sen" : "Bot"}</small>
                      </b>
                      <span>{round.alive[player.id] ? "Aktif" : "Elendi"}</span>
                      <span
                        className="pl-combat-label"
                        ref={(element) => {
                          combatHud.current.labels[player.id] = element;
                        }}
                      />
                      <progress
                        className="pl-stun-meter"
                        max={COMBAT.knockout.threshold}
                        defaultValue={0}
                        aria-label={`${player.label} sersemleme birikimi`}
                        ref={(element) => {
                          combatHud.current.meters[player.id] = element;
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              {round.phase === "playing" && (
                <span
                  className="pl-round-clock"
                  aria-label={`Kalan süre: ${round.seconds} saniye`}
                >
                  {round.seconds} sn
                </span>
              )}
            </div>
            <div
              className="pl-combat-hint"
              ref={(element) => {
                combatHud.current.hint = element;
              }}
            />
            {(round.phase !== "playing" || !round.alive[0]) && (
              <div
                className={`pl-arena-message pl-round-message${round.phase === "results" ? " pl-result-pulse" : ""}`}
                role="status"
                aria-atomic="true"
              >
                {round.phase === "countdown" && (
                  <>
                    <strong>{round.seconds}</strong>
                    <span>Hazır ol!</span>
                  </>
                )}
                {round.phase === "playing" && (
                  <>
                    <strong>Düştün!</strong>
                    <span>Diğer oyuncuları izle.</span>
                  </>
                )}
                {round.phase === "results" && (
                  <>
                    <strong
                      style={{
                        color:
                          round.winner === null
                            ? undefined
                            : PLAYERS[round.winner].color,
                      }}
                    >
                      {round.winner === null
                        ? "Berabere!"
                        : `${PLAYERS[round.winner].label} kazandı!`}
                    </strong>
                    <span>
                      {round.reason === "timeout" ? "Süre doldu. " : ""}Yeni tur
                      birazdan.
                    </span>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {status !== "ready" && status !== "graphics-error" && (
          <div className="pl-arena-message" role="status" aria-live="polite">
            {status === "loading" && "Arena hazırlanıyor…"}
            {status === "error" &&
              "Fizik motoru yüklenemedi. Lobiye dönüp tekrar dene."}
          </div>
        )}
      </div>
      <footer className="pl-arena-footer" id="pl-controls">
        <div>
          {ACTIONS.map(action => <span key={action}>
            <kbd>{actionBindingLabel(bindings, action)}</kbd> {ACTION_LABELS[action]}
          </span>)}
        </div>
        <span
          ref={(element) => {
            combatHud.current.performance = element;
          }}
        >
          1 oyuncu + 2 yerel bot · Aktif ragdoll testi
        </span>
      </footer>
    </div>
  );
}
