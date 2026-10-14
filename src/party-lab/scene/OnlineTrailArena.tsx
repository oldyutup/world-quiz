import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import TrailPlayground from "./trails/TrailPlayground";
import TrailHud from "./trails/TrailHud";
import { OnlineTrailSource, type TrailFrame, type TrailLook, type TrailOnline } from "./trails/source";
import { TRAIL_DPR } from "./trails/layout";
import type { LobbySnapshot } from "../network/types";

interface Props extends TrailOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineTrailArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [frame, setFrame] = useState<TrailFrame | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.trail) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.trail,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's players are built once: someone who leaves keeps their name, colour and costume.
  const cast = useRef<{ key: string; looks: TrailLook[]; source: OnlineTrailSource }>({ key: "", looks: [], source: new OnlineTrailSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı" };
      }),
      source: new OnlineTrailSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane, self?.slot ?? -1),
    };
  const { looks, source } = cast.current;
  source.online = { stream: props.stream, sendInput: props.sendInput };
  const hudLanes = useMemo(
    () => looks.map((look, lane) => ({ name: look.name, color: look.color, portrait: portraits[lane] ?? "", connected: lobby.players.find((p) => p.slot === wire?.seats[lane])?.connected ?? false })),
    [looks, portraits, lobby.players, wire?.seats]
  );
  const onPortraits = useCallback((urls: string[]) => setPortraits(urls), []);
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  const shown = frame && frame.round === round ? frame : null;
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="light_trails">
      <div ref={viewport} className="pl-viewport" data-mode="light_trails" tabIndex={0} role="region" aria-label="Online Işık İzi">
        <Canvas dpr={TRAIL_DPR} camera={{ position: [0, 20, 8], fov: 32, near: 0.5, far: 400 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && <TrailPlayground key={key} source={source} looks={looks} bindings={props.bindings} paused={off} audio={audio} onStatus={setStatus} onFrame={setFrame} onPortraits={onPortraits} />}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {wire && <TrailHud wire={shown?.wire ?? wire} step={shown?.step ?? wire.step} lanes={hudLanes} self={selfLane} winner={wire.seats.indexOf(game?.winner ?? -1)} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Işık İzi" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>Hiç durmadan koşarsın; WASD ya da ok tuşları yönü gösterir (W ekranın yukarısı), karakter o yöne yumuşakça döner. Arkanda kalan ışık izi 4,5 saniyede söner ama göründüğü sürece öldürür, kendi izin de. Duvara, ize, trene ya da başka bir oyuncuya kafa kafaya çarpan elenir. Raylar kırmızı yanınca tren geliyor demektir. Son 15 saniyede herkes hızlanır. Maç menü açıkken sürer ve tuş basılı değilken düz gidersin.</p>
        </ArenaMenu>
      )}
    </div>
  );
}
