import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Group, Quaternion, Vector3, type PerspectiveCamera } from "three";
import Arena from "./Arena";
import PlayerBean from "./PlayerBean";
import { playerCostumeAtSlot } from "./visual/costumes";
import { PLAYERS } from "./players";
import { PARTS } from "./ragdoll/config";
import { bindKeyboard } from "../input/keyboard";
import type { Bindings } from "../input/bindings";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { LocalPrediction } from "../network/prediction/localPrediction";
import type { PlayerId } from "./players";
import type { AnyInputPacket } from "../../../shared/party-lab/network/protocol";
import OnlineBarnArena from "./OnlineBarnArena";
import OnlineLayerArena from "./OnlineLayerArena";
import OnlineColorArena from "./OnlineColorArena";
import type { MovementInput } from "../input/types";
import type { LobbySnapshot } from "../network/types";
import type { GameStream } from "../network/gameStream";
import type { NetDiagnostics } from "../network/diagnostics";
import { linkDebugLines } from "../network/debugFormat";
import { NET, neutralIntent } from "../../../shared/party-lab/network/protocol";
import { ONLINE_ARENA_MAP_ID } from "../../../shared/party-lab/maps";
import { usePartyAudio } from "../audio/PartyAudio";
import { CameraFeel } from "../audio/feel";
import { MODE_NAMES } from "../../../shared/party-lab/modes";
import { ArenaMenu, ArenaStatus, ControlHint, MenuButton, useArenaMenu, useDebugPanel } from "./ArenaChrome";
import { controlHint } from "./arenaMenu";
import { ACCUMULATOR_START, FrameClock, frameTime } from "./frameClock";

class GraphicsBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <p role="alert">
        3D arena açılamadı. Sayfayı yenileyip tekrar katılabilirsin.
      </p>
    ) : (
      this.props.children
    );
  }
}
interface Props {
  lobby: LobbySnapshot;
  stream: GameStream;
  bindings: Bindings;
  /** The arena is hidden (Controls opened from the lobby): no input, no presentation. */
  paused: boolean;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
  onLeave: () => void;
  onBindings: (bindings: Bindings) => void;
  bindingsSaved: boolean;
  diagnostics?: NetDiagnostics | null;
  debug?: boolean;
}
const conditions = ["Aktif", "Sersem", "Baygın", "Toparlanıyor"];
function OnlineView({
  lobby,
  stream,
  bindings,
  paused,
  menuOpen,
  sendInput,
  performanceLabel,
  netLabel,
  diagnostics,
  debug = false,
}: Props & {
  /** Esc menu over the arena: local input stops, the match and its presentation go on. */
  menuOpen: boolean;
  performanceLabel: React.RefObject<HTMLSpanElement>;
  netLabel: React.RefObject<HTMLPreElement>;
}) {
  const { gl, camera, size } = useThree();
  const { audio, settings } = usePartyAudio();
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  const beans = useRef<(Group | null)[]>([]);
  const controls = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const base = useRef(new Vector3());
  const prediction = useRef<LocalPrediction | null>(null);
  const accumulator = useRef(ACCUMULATOR_START);
  const follow = useRef(new Vector3());
  const followTarget = useRef(new Vector3());
  const netRefresh = useRef(0);
  const qa = useRef(new Quaternion()),
    qb = useRef(new Quaternion());
  const feel = useRef(new CameraFeel());
  const sample = useRef({ seconds: 0, frames: 0, renderMs: 0 });
  const clock = useRef(new FrameClock());
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const inputOff = paused || menuOpen;
  useEffect(() => {
    if (self?.slot === undefined) return;
    let cancelled = false;
    void initializePhysics()
      .then(() => {
        if (!cancelled)
          prediction.current = new LocalPrediction(self.slot as PlayerId);
      })
      .catch(() => {
        /* Authoritative interpolation remains usable if WASM is unavailable. */
      });
    return () => {
      cancelled = true;
      prediction.current?.dispose();
      prediction.current = null;
    };
  }, [self?.slot]);
  useLayoutEffect(() => {
    stream.setPresentationEnabled(!paused);
    return () => stream.setPresentationEnabled(true);
  }, [stream, paused]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) {
        stream.discardEvents();
        controls.current?.clear();
        prediction.current?.suspend();
        accumulator.current = ACCUMULATOR_START;
        sendInput(neutralIntent());
        audio.stopAll();
        feel.current.clear();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [stream, audio, sendInput]);
  // Debug only: main-thread stalls (Chrome) separate a client hitch from a network one.
  useEffect(() => {
    if (!debug || !diagnostics || typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          diagnostics.longTask(entry.duration, performance.now());
      });
      observer.observe({ entryTypes: ["longtask"] });
      return () => observer.disconnect();
    } catch {
      return; // Long Tasks API is Chromium-only.
    }
  }, [debug, diagnostics]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const distance = Math.max(1, 1.5 / (size.width / Math.max(1, size.height)));
    perspective.position.set(0, 12 * distance, 14 * distance);
    perspective.lookAt(0, 0, 0);
    base.current.copy(camera.position);
    perspective.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  useEffect(() => {
    const adapter = bindKeyboard(gl.domElement, bindings);
    controls.current = adapter;
    adapter.setSuspended(
      inputOff ||
        lobby.status !== "connected" ||
        lobby.phase !== "playing" ||
        !self?.participating
    );
    return () => {
      adapter.dispose();
      controls.current = null;
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    };
  }, [gl, audio, sendInput]);
  useLayoutEffect(() => {
    controls.current?.setBindings(bindings);
    controls.current?.setSuspended(
      inputOff ||
        lobby.status !== "connected" ||
        lobby.phase !== "playing" ||
        !self?.participating
    );
    if (
      inputOff ||
      lobby.status !== "connected" ||
      lobby.phase !== "playing" ||
      !self?.participating
    ) {
      prediction.current?.suspend();
      accumulator.current = ACCUMULATOR_START;
      // Behind the Esc menu the round (and this camera's follow) goes on.
      if (paused || !menuOpen) follow.current.set(0, 0, 0);
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    }
  }, [
    bindings,
    inputOff,
    paused,
    menuOpen,
    lobby.status,
    lobby.phase,
    self?.participating,
    sendInput,
    audio,
  ]);
  useFrame((_frame, rendererDt) => {
    const start = performance.now();
    // Presentation runs on a smoothed frame clock (see frameClock.ts).
    const dt = clock.current.step(frameTime(start), rendererDt);
    const shownAt = clock.current.time;
    // The debug overlay reports real frame hitches, not the smoothed step.
    if (debug) diagnostics?.frame(rendererDt * 1000, start);
    const enabled =
      !inputOff &&
      !document.hidden &&
      lobby.status === "connected" &&
      lobby.phase === "playing" &&
      !!self?.participating;
    const predictor = prediction.current;
    const latest = stream.snapshots.latest;
    if (enabled && latest) predictor?.reconcile(latest, start);
    if (!enabled || dt > 0.25) {
      controls.current?.clear();
      predictor?.suspend();
      accumulator.current = ACCUMULATOR_START;
      if (dt > 0.25) sendInput(neutralIntent());
    } else {
      accumulator.current += Math.min(dt, 0.05);
      const ticks =
        accumulator.current + 1e-6 >= 1 / NET.inputHz
          ? Math.min(
              3,
              Math.floor((accumulator.current + 1e-6) * NET.physicsHz)
            )
          : 0;
      if (ticks > 0 && controls.current) {
        accumulator.current -= ticks / NET.physicsHz;
        const intent = controls.current.readIntent();
        const packet = sendInput(intent);
        if (packet) {
          const result = predictor?.advance(packet, ticks, start);
          if (result?.swing && self) {
            const event = {
              name: "punchSwing" as const,
              actor: self.slot,
              x: predictor!.rig.character.body.translation().x,
            };
            if (audio.playSfx(event))
              stream.markLocalSwing(packet.round, self.slot, packet.seq);
          }
        }
      }
    }
    const localPose = enabled
      ? predictor?.pose(
          Math.min(dt, 0.1),
          Math.min(1, accumulator.current * NET.physicsHz)
        )
      : null;
    const frame = stream.snapshots.sample(shownAt);
    camera.position.copy(base.current);
    if (!frame) return;
    const { a, b, alpha } = frame;
    for (const player of PLAYERS) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      const local = player.id === self?.slot;
      bean.visible =
        !!(b.snapshot.mask & b.snapshot.alive & (1 << player.id)) &&
        (!local ||
          !latest ||
          !!(latest.snapshot.mask & latest.snapshot.alive & (1 << player.id)));
      const predicted = local && localPose ? localPose : null;
      for (let i = 0; i < PARTS.length; i++) {
        const part = bean.children[i],
          offset = (player.id * PARTS.length + i) * 7;
        if (predicted) {
          const at = i * 7;
          part.position.set(
            predicted[at],
            predicted[at + 1],
            predicted[at + 2]
          );
          part.quaternion.set(
            predicted[at + 3],
            predicted[at + 4],
            predicted[at + 5],
            predicted[at + 6]
          );
        } else {
          part.position.set(
            a.values[offset] + (b.values[offset] - a.values[offset]) * alpha,
            a.values[offset + 1] +
              (b.values[offset + 1] - a.values[offset + 1]) * alpha,
            a.values[offset + 2] +
              (b.values[offset + 2] - a.values[offset + 2]) * alpha
          );
          qa.current.set(
            a.values[offset + 3],
            a.values[offset + 4],
            a.values[offset + 5],
            a.values[offset + 6]
          );
          qb.current.set(
            b.values[offset + 3],
            b.values[offset + 4],
            b.values[offset + 5],
            b.values[offset + 6]
          );
          part.quaternion.copy(qa.current).slerp(qb.current, alpha);
        }
        if (PARTS[i] === "head") {
          const stars = part.getObjectByName("stars");
          if (stars) {
            stars.visible = [1, 2].includes(b.snapshot.states[player.id]);
            stars.rotation.y += dt * 3;
          }
        }
      }
    }
    for (const event of stream.drain(
      b.snapshot.round,
      stream.snapshots.renderMs
    )) {
      if (!paused && !document.hidden && lobby.status === "connected") {
        audio.playSfx(event);
        feel.current.trigger(event, self?.slot ?? -1);
      }
    }
    const localBean = self ? beans.current[self.slot] : null;
    if (localBean?.visible && !reduced && !paused) {
      const p = localBean.children[0].position;
      followTarget.current.set(
        Math.max(-0.65, Math.min(0.65, p.x * 0.1)),
        Math.max(0, Math.min(0.15, (p.y - 0.8) * 0.05)),
        Math.max(-0.65, Math.min(0.65, p.z * 0.1))
      );
    } else followTarget.current.set(0, 0, 0);
    follow.current.lerp(
      followTarget.current,
      1 - Math.exp(-Math.min(dt, 0.1) / 0.12)
    );
    camera.position.add(follow.current);
    camera.lookAt(follow.current);
    const [x, y] = feel.current.step(
      dt,
      settings.cameraShake && !reduced && !paused
    );
    camera.position.x += x;
    camera.position.y += y;
    netRefresh.current += dt;
    if (debug && diagnostics && netLabel.current && netRefresh.current >= 0.5) {
      netRefresh.current = 0;
      netLabel.current.textContent = linkDebugLines(diagnostics, start).join("\n");
    }
    const stats = sample.current;
    stats.frames++;
    stats.seconds += dt;
    stats.renderMs += performance.now() - start;
    if (stats.seconds >= 2) {
      if (performanceLabel.current && debug) {
        const m = predictor?.metrics;
        performanceLabel.current.textContent = `${Math.round(
          stats.frames / stats.seconds
        )} FPS · ${localPose ? "yerel tahmin" : "sunucu görünümü"} · ${
          m ? (m.stepMs / Math.max(1, m.steps)).toFixed(2) : "—"
        } ms/tahmin · hata ${m?.error.toFixed(3) ?? "—"} m · ort/max ${
          m ? (m.totalError / Math.max(1, m.reconciliations)).toFixed(3) : "—"
        }/${m?.maxError.toFixed(3) ?? "—"} · düzeltme ${m?.corrections ?? 0}/${
          m?.hard ?? 0
        } sert · bekleyen ${predictor?.history.records.length ?? 0} · ACK ${
          m?.ackDelayMs.toFixed(0) ?? "—"
        } ms`;
      }
      stats.frames = stats.seconds = stats.renderMs = 0;
    }
  });
  return (
    <>
      <Arena mapId={ONLINE_ARENA_MAP_ID} />
      {PLAYERS.map((player) => (
        <PlayerBean
          key={player.id}
          color={player.color}
          costume={playerCostumeAtSlot(lobby.players, player.id)}
          ref={(node) => {
            beans.current[player.id] = node;
          }}
        />
      ))}
    </>
  );
}
/**
 * The round's mode comes from the server (lobby state, set with the phase); the view
 * never guesses it from poses or map data. Rooftop Brawl keeps its original view.
 */
export default function OnlineArena(props: Props) {
  if (props.lobby.mode === "barn_shootout") return <OnlineBarnArena {...props} />;
  if (props.lobby.mode === "layer_chaos") return <OnlineLayerArena {...props} />;
  if (props.lobby.mode === "color_chaos") return <OnlineColorArena {...props} />;
  return <OnlineRooftopArena {...props} />;
}
function OnlineRooftopArena(props: Props) {
  const { lobby, onLeave, bindings, paused } = props;
  const viewport = useRef<HTMLDivElement>(null),
    performanceLabel = useRef<HTMLSpanElement>(null),
    netLabel = useRef<HTMLPreElement>(null);
  const menu = useArenaMenu(!paused);
  const menuOpen = menu.view !== null;
  const debugPanel = useDebugPanel(!!props.debug);
  const game = lobby.game;
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  const result =
    lobby.winner < 0
      ? "Berabere!"
      : `${
          lobby.players.find((p) => p.slot === lobby.winner)?.nickname ??
          `Oyuncu ${lobby.winner + 1}`
        } kazandı!`;
  useEffect(() => {
    if (!paused && !menuOpen) viewport.current?.focus();
  }, [paused, menuOpen]);
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="rooftop_brawl">
      <div
        className="pl-viewport"
        tabIndex={0}
        ref={viewport}
        role="region"
        aria-label="Online 3D arena"
        data-mode="rooftop_brawl"
        onPointerDown={() => viewport.current?.focus()}
      >
        <GraphicsBoundary>
          <Canvas
            dpr={[1, 1.5]}
            camera={{ position: [0, 12, 14], fov: 45, near: 0.1, far: 180 }}
            gl={{ antialias: true, alpha: true }}
            fallback={<p>Bu arena için WebGL 2 gerekiyor.</p>}
          >
            <OnlineView
              {...props}
              menuOpen={menuOpen}
              performanceLabel={performanceLabel}
              netLabel={netLabel}
            />
          </Canvas>
        </GraphicsBoundary>
        <MenuButton onOpen={() => menu.setView("main")} />
        <div className="pl-round-hud">
          <ul className="pl-roster">
            {lobby.players.map((p) => (
              <li
                key={p.id}
                className={
                  p.participating && game && !(game.alive & (1 << p.slot))
                    ? "pl-eliminated"
                    : ""
                }
              >
                <span
                  className="pl-player-dot"
                  style={{ backgroundColor: p.color }}
                />
                <span>
                  <b>
                    {p.nickname} {p.id === lobby.selfId && <small>Sen</small>}
                  </b>
                  <span>
                    {!p.participating
                      ? "İzliyor"
                      : game && !(game.alive & (1 << p.slot))
                      ? "Elendi"
                      : conditions[game?.states[p.slot] ?? 0]}
                  </span>
                  {!p.connected && <small>Yeniden bağlanıyor</small>}
                  {p.participating && game && (
                    <span className="pl-combat-label">
                      {
                        game.grips
                          .slice(p.slot * 2, p.slot * 2 + 2)
                          .filter((v) => v >= 0).length
                      }{" "}
                      el tutuş · {Math.round(game.meters[p.slot])} sersemleme
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <span className="pl-round-clock">{lobby.seconds} sn</span>
        </div>
        <div className="pl-arena-side">
          <ArenaStatus lobby={lobby} spectating={!self?.participating} />
          {/* Always present: the performance line is also the automation readout. */}
          <div className="pl-debug-panel" hidden={!debugPanel.open} aria-hidden="true">
            <span className="pl-perf" ref={performanceLabel} />
            {props.debug && <pre className="pl-net-debug" ref={netLabel} />}
          </div>
        </div>
        {(lobby.phase === "countdown" ||
          lobby.phase === "results" ||
          !game) && (
          <div
            className={`pl-arena-message pl-round-message${
              lobby.phase === "results" ? " pl-result-pulse" : ""
            }`}
            role="status"
          >
            <strong>
              {lobby.phase === "countdown"
                ? lobby.seconds
                : lobby.phase === "results"
                ? result
                : "Arena bağlanıyor…"}
            </strong>
            <span>
              {lobby.phase === "results"
                ? "Yeni tur için lobiye dönülüyor."
                : lobby.phase === "countdown"
                ? "Hazır ol!"
                : ""}
            </span>
          </div>
        )}
        <ControlHint
          text={controlHint(bindings, "rooftop")}
          playing={lobby.phase === "playing"}
          replay={menu.hintReplay}
          hidden={menuOpen}
        />
      </div>
      {menu.view && (
        <ArenaMenu
          view={menu.view}
          setView={menu.setView}
          onResume={() => menu.setView(null)}
          onLeave={onLeave}
          lobby={lobby}
          modeName={MODE_NAMES.rooftop_brawl}
          bindings={bindings}
          onBindings={props.onBindings}
          bindingsSaved={props.bindingsSaved}
          debug={props.debug ? { open: debugPanel.open, onToggle: debugPanel.toggle } : null}
        />
      )}
    </div>
  );
}
