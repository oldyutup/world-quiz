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
import { PLAYERS } from "./players";
import { PARTS } from "./ragdoll/config";
import { bindKeyboard } from "../input/keyboard";
import type { Bindings } from "../input/bindings";
import { bindingLabel } from "../input/bindings";
import type { MovementInput } from "../input/types";
import type { LobbySnapshot } from "../network/types";
import type { GameStream } from "../network/gameStream";
import { NET, neutralIntent } from "../../../shared/party-lab/network/protocol";
import { usePartyAudio } from "../audio/PartyAudio";
import { CameraFeel } from "../audio/feel";

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
  paused: boolean;
  sendInput: (input: MovementInput) => void;
  onLeave: () => void;
  onControls: () => void;
}
const conditions = ["Aktif", "Sersem", "Baygın", "Toparlanıyor"];
function OnlineView({
  lobby,
  stream,
  bindings,
  paused,
  sendInput,
  performanceLabel,
}: Props & { performanceLabel: React.RefObject<HTMLSpanElement> }) {
  const { gl, camera, size } = useThree();
  const { audio, settings } = usePartyAudio();
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  const beans = useRef<(Group | null)[]>([]);
  const controls = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const base = useRef(new Vector3());
  const qa = useRef(new Quaternion()),
    qb = useRef(new Quaternion());
  const feel = useRef(new CameraFeel());
  const live = useRef({ paused, lobby, self });
  live.current = { paused, lobby, self };
  const sample = useRef({ seconds: 0, frames: 0, renderMs: 0 });
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useLayoutEffect(() => {
    stream.setPresentationEnabled(!paused);
    return () => stream.setPresentationEnabled(true);
  }, [stream, paused]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) {
        stream.discardEvents();
        controls.current?.clear();
        sendInput(neutralIntent());
        audio.stopAll();
        feel.current.clear();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [stream, audio, sendInput]);
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
    const timer = window.setInterval(() => {
      const { paused, lobby, self } = live.current;
      const enabled =
        !paused &&
        !document.hidden &&
        lobby.status === "connected" &&
        lobby.phase === "playing" &&
        !!self?.participating;
      if (!enabled) adapter.clear();
      sendInput(enabled ? adapter.readIntent() : neutralIntent());
    }, 1000 / NET.inputHz);
    return () => {
      window.clearInterval(timer);
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
      paused ||
        lobby.status !== "connected" ||
        lobby.phase !== "playing" ||
        !self?.participating
    );
    if (paused) {
      sendInput(neutralIntent());
      audio.stopAll();
      feel.current.clear();
    }
  }, [
    bindings,
    paused,
    lobby.status,
    lobby.phase,
    self?.participating,
    sendInput,
    audio,
  ]);
  useFrame((_frame, dt) => {
    const start = performance.now();
    const frame = stream.snapshots.sample(start);
    camera.position.copy(base.current);
    if (!frame) return;
    const { a, b, alpha } = frame;
    for (const player of PLAYERS) {
      const bean = beans.current[player.id];
      if (!bean) continue;
      bean.visible = !!(b.snapshot.mask & b.snapshot.alive & (1 << player.id));
      for (let i = 0; i < PARTS.length; i++) {
        const part = bean.children[i],
          offset = (player.id * PARTS.length + i) * 7;
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
    const [x, y] = feel.current.step(
      dt,
      settings.cameraShake && !reduced && !paused
    );
    camera.position.x += x;
    camera.position.y += y;
    const stats = sample.current;
    stats.frames++;
    stats.seconds += dt;
    stats.renderMs += performance.now() - start;
    if (stats.seconds >= 2) {
      if (performanceLabel.current)
        performanceLabel.current.textContent = `${Math.round(
          stats.frames / stats.seconds
        )} FPS · ${(stats.renderMs / stats.frames).toFixed(
          2
        )} ms çizim hazırlığı · 20 Hz sunucu`;
      stats.frames = stats.seconds = stats.renderMs = 0;
    }
  });
  return (
    <>
      <Arena />
      {PLAYERS.map((player) => (
        <PlayerBean
          key={player.id}
          color={player.color}
          ref={(node) => {
            beans.current[player.id] = node;
          }}
        />
      ))}
    </>
  );
}
export default function OnlineArena(props: Props) {
  const { lobby, onLeave, onControls, bindings } = props;
  const viewport = useRef<HTMLDivElement>(null),
    performanceLabel = useRef<HTMLSpanElement>(null);
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
    viewport.current?.focus();
  }, []);
  return (
    <div className="party-lab pl-playground">
      <header className="pl-arena-header">
        <div>
          <span className="pl-eyebrow">PARTY LAB / ONLINE · {lobby.code}</span>
          <h2>Aynı arena. Gerçek arkadaşlar.</h2>
        </div>
        <button className="pl-button pl-join" onClick={onControls}>
          Kontroller
        </button>
        <button
          className="pl-button pl-join"
          data-sfx="uiBack"
          onClick={onLeave}
        >
          Odadan Ayrıl
        </button>
      </header>
      <p className="pl-online-status" role="status">
        {lobby.status === "connected"
          ? "Sunucuya bağlı"
          : lobby.status === "reconnecting"
          ? "Bağlantı kesildi. Yeniden bağlanılıyor…"
          : "Bağlantı kapandı."}
        {!self?.participating
          ? " · İzliyorsun. Sonraki tur lobide hazır olabilirsin."
          : ""}
      </p>
      <div
        className="pl-viewport"
        tabIndex={0}
        ref={viewport}
        role="region"
        aria-label="Online 3D arena"
        onPointerDown={() => viewport.current?.focus()}
      >
        <GraphicsBoundary>
          <Canvas
            dpr={[1, 1.5]}
            camera={{ position: [0, 12, 14], fov: 45, near: 0.1, far: 180 }}
            gl={{ antialias: true, alpha: true }}
            fallback={<p>Bu arena için WebGL 2 gerekiyor.</p>}
          >
            <hemisphereLight args={["#fff2d9", "#537b7b", 1.8]} />
            <directionalLight
              position={[4, 10, 6]}
              intensity={2.2}
              color="#fff2d9"
            />
            <OnlineView {...props} performanceLabel={performanceLabel} />
          </Canvas>
        </GraphicsBoundary>
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
      </div>
      <footer className="pl-online-footer">
        <span>
          {bindings.punch
            .filter(Boolean)
            .map((b) => bindingLabel(b!))
            .join(" / ")}
          : Yumruk ·{" "}
          {bindings.grab
            .filter(Boolean)
            .map((b) => bindingLabel(b!))
            .join(" / ")}
          : Tut ·{" "}
          {bindings.lift
            .filter(Boolean)
            .map((b) => bindingLabel(b!))
            .join(" / ")}
          : Kaldır
        </span>
        <span ref={performanceLabel} />
      </footer>
    </div>
  );
}
