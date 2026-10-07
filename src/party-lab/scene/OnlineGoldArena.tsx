import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import GoldMinerPlayground from "./goldminer/GoldMinerPlayground";
import { OnlineGoldSource, type GoldMinerOnline } from "./goldminer/online";
import GoldMinerHud from "./goldminer/GoldMinerHud";
import { ClickPresses, pressBindings, pressLabel } from "./clickrace/input";
import type { GoldLaneLook } from "./goldminer/visual";
import type { GoldWire } from "../../../shared/party-lab/simulation/goldminer/wire";
import type { LobbySnapshot } from "../network/types";

interface Props extends GoldMinerOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineGoldArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.gold) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.gold,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's miners are built once: a player who leaves keeps their winch, name and colour.
  const cast = useRef<{ key: string; looks: GoldLaneLook[]; first: GoldWire | null; source: OnlineGoldSource }>({ key: "", looks: [], first: null, source: new OnlineGoldSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot, lane) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı", self: lane === selfLane };
      }),
      first: wire,
      source: new OnlineGoldSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane),
    };
  const { looks, source, first } = cast.current;
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
    <div className="party-lab pl-playground pl-immersive" data-mode="gold_miner">
      <div ref={viewport} className="pl-viewport" data-mode="gold_miner" tabIndex={0} role="region" aria-label="Online Altın Madenci">
        <Canvas orthographic dpr={[1, 1.5]} camera={{ position: [0, 0, 50], near: 1, far: 200, zoom: 1 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && first && (
              <GoldMinerPlayground key={key} source={source} lanes={looks} first={first} self={selfLane} presses={presses} paused={off} audio={audio} onStatus={setStatus} />
            )}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {wire && <GoldMinerHud wire={wire} lanes={hudLanes} self={selfLane} winner={winnerLane} keys={keys} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Altın Madenci" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>Kanca sallanır; yumruk tuşu ({keys}), sol tık ya da dokunma onu o anki açıyla fırlatır. İlk değdiği eşyayı çeker: ağır olan yavaş gelir. Küçük altın 50, büyük altın 250, elmas 400, taş 10, çuval 20–400 puan. Maç menü açıkken sürer.</p>
        </ArenaMenu>
      )}
    </div>
  );
}
