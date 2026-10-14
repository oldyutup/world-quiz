import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import MarksmanPlayground from "./marksman/MarksmanPlayground";
import MarksmanHud from "./marksman/MarksmanHud";
import { OnlineMarksmanSource, laneViews, type MarksmanFrame, type MarksmanLook, type MarksmanOnline } from "./marksman/source";
import { AimKeys, aimBindings, aimLabel, fireBindings, fireLabel } from "./marksman/input";
import { ClickPresses } from "./clickrace/input";
import type { LobbySnapshot } from "../network/types";

interface Props extends MarksmanOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}
export default function OnlineMarksmanArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [frame, setFrame] = useState<MarksmanFrame | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.marksman) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    wire = game?.marksman,
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfLane = wire ? wire.seats.indexOf(self?.slot ?? -1) : -1;
  // A round's players are built once: someone who leaves keeps their stretch, name and colour.
  const cast = useRef<{ key: string; looks: MarksmanLook[]; source: OnlineMarksmanSource }>({ key: "", looks: [], source: new OnlineMarksmanSource({ stream: props.stream, sendInput: props.sendInput }, -1, -1) });
  const key = wire ? `${round}:${wire.seats.join(",")}:${selfLane}` : "";
  if (wire && cast.current.key !== key)
    cast.current = {
      key,
      looks: wire.seats.map((slot) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı" };
      }),
      source: new OnlineMarksmanSource({ stream: props.stream, sendInput: props.sendInput }, round, selfLane),
    };
  const { looks, source } = cast.current;
  source.online = { stream: props.stream, sendInput: props.sendInput };
  const hudLanes = useMemo(
    () => looks.map((look, lane) => ({ name: look.name, color: look.color, portrait: portraits[lane] ?? "", connected: lobby.players.find((p) => p.slot === wire?.seats[lane])?.connected ?? false })),
    [looks, portraits, lobby.players, wire?.seats]
  );
  const onPortraits = useCallback((urls: string[]) => setPortraits(urls), []);
  const [presses] = useState(() => new ClickPresses(fireBindings(props.bindings)));
  const [aimKeys] = useState(() => new AimKeys(aimBindings(props.bindings).left, aimBindings(props.bindings).right));
  useEffect(() => {
    presses.bindings = fireBindings(props.bindings);
    presses.clear();
    Object.assign(aimKeys, aimBindings(props.bindings));
    aimKeys.clear();
  }, [presses, aimKeys, props.bindings]);
  const keys = useMemo(() => ({ aim: aimLabel(props.bindings), fire: fireLabel(props.bindings) }), [props.bindings]);
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  const shown = frame && frame.round === round ? frame : null;
  const views = useMemo(() => (shown ? laneViews(shown) : []), [shown]);
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="marksman">
      <div ref={viewport} className="pl-viewport" data-mode="marksman" tabIndex={0} role="region" aria-label="Online Nişancı">
        <Canvas dpr={[1, 2]} camera={{ position: [0, 6, 16], fov: 34, near: 0.3, far: 400 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {wire && <MarksmanPlayground key={key} source={source} looks={looks} self={selfLane} presses={presses} aimKeys={aimKeys} paused={off} audio={audio} onStatus={setStatus} onFrame={setFrame} onPortraits={onPortraits} />}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {wire && <MarksmanHud wire={shown?.wire ?? wire} now={shown?.now ?? 0} views={views} lanes={hudLanes} self={selfLane} winner={wire.seats.indexOf(game?.winner ?? -1)} keys={keys} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Nişancı" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>
            Önünde kendi renginde üç yuva var. {keys.aim} basılı tutunca nişanın sola/sağa döner, bırakınca ortaya gelir; {keys.fire} ile ateş et. Hedef açıldıktan sonra yarım saniye içinde vurursan +5, geç vurursan +2. İki canın var: ilk bomba −5 ve 1 saniye
            ateş edemezsin, ikinci bomba seni eler. Tek kişi ayakta kalırsa o kazanır; 45 saniye dolarsa ayakta kalanlardan en çok puanı toplayan. Maç menü açıkken sürer.
          </p>
        </ArenaMenu>
      )}
    </div>
  );
}
