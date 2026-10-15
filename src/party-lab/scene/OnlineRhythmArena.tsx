import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import RhythmPlayground from "./rhythm/RhythmPlayground";
import RhythmHud from "./rhythm/RhythmHud";
import { OnlineRhythmSource, type RhythmFrame, type RhythmLook, type RhythmOnline } from "./rhythm/source";
import { noteLabels } from "./rhythm/input";
import { RHYTHM as R } from "../../../shared/party-lab/simulation/rhythm/config";
import type { LobbySnapshot } from "../network/types";

interface Props extends RhythmOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineRhythmArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [frame, setFrame] = useState<RhythmFrame | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.rhythm) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.rhythm,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's players are built once: someone who leaves keeps their lane, name and colour.
  const cast = useRef<{ key: string; looks: RhythmLook[]; source: OnlineRhythmSource }>({ key: "", looks: [], source: new OnlineRhythmSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı" };
      }),
      source: new OnlineRhythmSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane),
    };
  const { looks, source } = cast.current;
  source.online = { stream: props.stream, sendInput: props.sendInput };
  const hudLanes = useMemo(
    () => looks.map((look, lane) => ({ name: look.name, color: look.color, portrait: portraits[lane] ?? "", connected: lobby.players.find((p) => p.slot === wire?.seats[lane])?.connected ?? false })),
    [looks, portraits, lobby.players, wire?.seats]
  );
  const onPortraits = useCallback((urls: string[]) => setPortraits(urls), []);
  const labels = useMemo(() => noteLabels(props.bindings), [props.bindings]);
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  const shown = frame && frame.round === round ? frame : null;
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="rhythm_master">
      <div ref={viewport} className="pl-viewport" data-mode="rhythm_master" tabIndex={0} role="region" aria-label="Online Ritim Ustası">
        <Canvas dpr={[1, 2]} camera={{ position: [0, 2, 12], fov: 28, near: 0.5, far: 80 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && <RhythmPlayground key={key} source={source} looks={looks} self={selfLane} bindings={props.bindings} paused={off} audio={audio} onStatus={setStatus} onFrame={setFrame} onPortraits={onPortraits} />}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {shown && <RhythmHud frame={shown} lanes={hudLanes} labels={labels} afterRound={afterRoundText(!!lobby.board)} />}
        <div className="pl-arena-side">
          <ArenaStatus lobby={lobby} spectating={!self?.participating} />
        </div>
        {status !== "ready" && (
          <div className="pl-arena-message" role="status">
            <strong>{status === "error" ? "Arena yüklenemedi" : "Arena bağlanıyor…"}</strong>
          </div>
        )}
      </div>
      {menu.view && (
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Ritim Ustası" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>
            Notalar şeridinde sağdan sola kayar. Nota çemberin üstüne geldiği anda üstünde yazan tuşa bas ({labels.join(" ")} ya da oklar). Tam zamanında MÜKEMMEL +{R.points.perfect}, biraz erken ya da geç İYİ +{R.points.good}. Iskalamak, yanlış tuş ya da boşa basmak puan
            düşürmez ama komboyu sıfırlar; yanlış tuş o notayı da kaybettirir. En uzun kombonun ×{R.comboBonus} katı sonda bonus olarak eklenir. Doğru vuruşta melodi çalar. Maç menü açıkken sürer.
          </p>
        </ArenaMenu>
      )}
    </div>
  );
}
