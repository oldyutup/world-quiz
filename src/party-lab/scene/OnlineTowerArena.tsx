import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import TowerPlayground from "./boxtower/TowerPlayground";
import TowerHud from "./boxtower/TowerHud";
import { OnlineTowerSource, yardViews, type TowerFrame, type TowerLook, type TowerOnline } from "./boxtower/source";
import { dropBindings, dropLabel } from "./boxtower/input";
import { ClickPresses } from "./clickrace/input";
import type { LobbySnapshot } from "../network/types";

interface Props extends TowerOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineTowerArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [frame, setFrame] = useState<TowerFrame | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.tower) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.tower,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's players are built once: someone who leaves keeps their yard, name and colour.
  const cast = useRef<{ key: string; looks: TowerLook[]; source: OnlineTowerSource }>({ key: "", looks: [], source: new OnlineTowerSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı" };
      }),
      source: new OnlineTowerSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane),
    };
  const { looks, source } = cast.current;
  source.online = { stream: props.stream, sendInput: props.sendInput };
  const hudLanes = useMemo(
    () => looks.map((look, lane) => ({ name: look.name, color: look.color, portrait: portraits[lane] ?? "", connected: lobby.players.find((p) => p.slot === wire?.seats[lane])?.connected ?? false })),
    [looks, portraits, lobby.players, wire?.seats]
  );
  const onPortraits = useCallback((urls: string[]) => setPortraits(urls), []);
  const [presses] = useState(() => new ClickPresses(dropBindings(props.bindings)));
  useEffect(() => {
    presses.bindings = dropBindings(props.bindings);
    presses.clear();
  }, [presses, props.bindings]);
  const keys = dropLabel(props.bindings);
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  const shown = frame && frame.round === round ? frame : null;
  const best = useMemo(() => (shown ? yardViews(shown).map((v) => v.best) : []), [shown]);
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="box_tower">
      <div ref={viewport} className="pl-viewport" data-mode="box_tower" tabIndex={0} role="region" aria-label="Online Kutu Kulesi">
        <Canvas dpr={[1, 2]} camera={{ position: [0, 6, 40], fov: 26, near: 0.5, far: 600 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && <TowerPlayground key={key} source={source} looks={looks} self={selfLane} presses={presses} paused={off} audio={audio} onStatus={setStatus} onFrame={setFrame} onPortraits={onPortraits} />}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {wire && <TowerHud wire={shown?.wire ?? wire} now={shown?.now ?? 0} best={best} lanes={hudLanes} self={selfLane} winner={wire.seats.indexOf(game?.winner ?? -1)} keys={keys} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Kutu Kulesi" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>Kutun alanının üstünde sağa sola kayar. {keys} ile bırak: o an ortasının altındaki sütuna düşer. Bir sütunda 10 kutuyu ilk dizen kazanır; 60 saniye dolarsa en yüksek sütunu olan. Kendi en yüksek sütunun uzadıkça kutu hızlanır. Maç menü açıkken sürer.</p>
        </ArenaMenu>
      )}
    </div>
  );
}
