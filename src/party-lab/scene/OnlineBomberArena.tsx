import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { bindingLabel } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import BomberPlayground from "./bomber/BomberPlayground";
import BomberHud from "./bomber/BomberHud";
import { OnlineBomberSource, type BomberFrame, type BomberLook, type BomberOnline } from "./bomber/source";
import { BOMBER_DPR } from "./bomber/layout";
import type { BomberWire } from "../../../shared/party-lab/simulation/bomber/wire";
import type { LobbySnapshot } from "../network/types";

interface Props extends BomberOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineBomberArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [frame, setFrame] = useState<BomberFrame | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.bomber) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.bomber,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's players are built once: someone who leaves keeps their name, colour and costume.
  const cast = useRef<{ key: string; looks: BomberLook[]; first: BomberWire | null; source: OnlineBomberSource }>({ key: "", looks: [], first: null, source: new OnlineBomberSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı" };
      }),
      first: wire,
      source: new OnlineBomberSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane, self?.slot ?? -1),
    };
  const { looks, source, first } = cast.current;
  source.online = { stream: props.stream, sendInput: props.sendInput };
  const hudLanes = useMemo(
    () => looks.map((look, lane) => ({ name: look.name, color: look.color, portrait: portraits[lane] ?? "", connected: lobby.players.find((p) => p.slot === wire?.seats[lane])?.connected ?? false })),
    [looks, portraits, lobby.players, wire?.seats]
  );
  const onPortraits = useCallback((urls: string[]) => setPortraits(urls), []);
  const keys = bindingLabel(props.bindings.jump[0]);
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  const shown = frame && frame.round === round ? frame : null;
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="bomber">
      <div ref={viewport} className="pl-viewport" data-mode="bomber" tabIndex={0} role="region" aria-label="Online Bombacı">
        {/* At least 2 device pixels per CSS pixel: at 1.5 a Retina screen showed the arena soft. */}
        <Canvas dpr={BOMBER_DPR} camera={{ position: [0, 20, 8], fov: 32, near: 0.5, far: 400 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && first && <BomberPlayground key={key} source={source} looks={looks} first={first} bindings={props.bindings} paused={off} audio={audio} onStatus={setStatus} onFrame={setFrame} onPortraits={onPortraits} />}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {wire && <BomberHud wire={shown?.wire ?? wire} step={shown?.step ?? wire.step} lanes={hudLanes} self={selfLane} winner={wire.seats.indexOf(game?.winner ?? -1)} keys={keys} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Bombacı" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>WASD ile yürü (W ekranın yukarısı), {keys} ile bulunduğun hücreye bomba koy (en fazla 2). Patlama ışın ve halka boyunca 3 hücre gider, kutuyu kırar, sütunda durur. Rakibi vurmak +1, kendi bomban −1. Son 15 saniyede dış halkalar çöker. Maç menü açıkken sürer.</p>
        </ArenaMenu>
      )}
    </div>
  );
}
