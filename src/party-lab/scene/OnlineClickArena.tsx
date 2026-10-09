import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import ClickRacePlayground from "./clickrace/ClickRacePlayground";
import { OnlineClickSource, type ClickRaceOnline } from "./clickrace/online";
import ClickRaceHud from "./clickrace/ClickRaceHud";
import { ClickPresses, pressBindings, pressLabel } from "./clickrace/input";
import type { ClickLaneLook } from "./clickrace/visual";
import type { LobbySnapshot } from "../network/types";

interface Props extends ClickRaceOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineClickArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.click) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.click,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's cars are built once: a player who leaves keeps their car, name and colour.
  const cast = useRef<{ key: string; looks: ClickLaneLook[]; source: OnlineClickSource }>({ key: "", looks: [], source: new OnlineClickSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot, lane) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı", self: lane === selfLane };
      }),
      source: new OnlineClickSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane),
    };
  const { looks, source } = cast.current;
  source.online = { stream: props.stream, sendInput: props.sendInput };
  const hudLanes = useMemo(
    () => looks.map((look, lane) => ({ name: look.name, color: look.color, connected: lobby.players.find((p) => p.slot === wire?.seats[lane])?.connected ?? false })),
    [looks, lobby.players, wire?.seats]
  );
  const [presses] = useState(() => new ClickPresses(pressBindings(props.bindings)));
  useEffect(() => {
    presses.bindings = pressBindings(props.bindings);
    presses.clear();
  }, [presses, props.bindings]);
  const keys = pressLabel(props.bindings);
  const winnerLane = wire && game ? wire.seats.indexOf(game.winner) : -1;
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="click_race">
      <div ref={viewport} className="pl-viewport" data-mode="click_race" tabIndex={0} role="region" aria-label="Online Tıklama Yarışı">
        <Canvas orthographic dpr={[1, 1.5]} camera={{ position: [0, 60, 0], near: 1, far: 300, zoom: 1 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && (
              <ClickRacePlayground key={key} source={source} lanes={looks} self={selfLane} presses={presses} paused={off} audio={audio} onStatus={setStatus} />
            )}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {wire && <ClickRaceHud wire={wire} lanes={hudLanes} self={selfLane} winner={winnerLane} keys={keys} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Tıklama Yarışı" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>Yumruk tuşu ({keys}) ya da dokunma: her basış arabayı bir adım ilerletir. Basılı tutmak sayılmaz. Maç menü açıkken sürer.</p>
        </ArenaMenu>
      )}
    </div>
  );
}
