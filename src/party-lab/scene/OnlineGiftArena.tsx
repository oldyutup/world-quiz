import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { actionBindingLabel } from "../input/bindings";
import { usePartyAudio } from "../audio/PartyAudio";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "./ArenaChrome";
import { afterRoundText } from "./arenaMenu";
import { playerCostumeAtSlot } from "./visual/costumes";
import GiftPlayground, { type GiftShown } from "./gifts/GiftPlayground";
import GiftHud from "./gifts/GiftHud";
import { OnlineGiftSource, type GiftLook, type GiftOnline } from "./gifts/source";
import { GIFT_DPR } from "./gifts/layout";
import { decodeGiftWire } from "../../../shared/party-lab/simulation/gifts/wire";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { LocalPrediction } from "../network/prediction/localPrediction";
import type { LobbySnapshot } from "../network/types";

interface Props extends GiftOnline {
  lobby: LobbySnapshot;
  bindings: Bindings;
  paused: boolean;
  onLeave: () => void;
  onBindings: (b: Bindings) => void;
  bindingsSaved: boolean;
}

/**
 * Online Hediye Kapmaca: the server's yard drawn by the shared playground (own body predicted,
 * everyone else a moment behind), the HUD beside it. The Esc menu and the chat stop this
 * player's input only; the round goes on.
 */
export default function OnlineGiftArena(props: Props) {
  const { lobby, paused } = props,
    { audio } = usePartyAudio(),
    viewport = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [shown, setShown] = useState<GiftShown | null>(null);
  const [portraits, setPortraits] = useState<string[]>([]);
  const menu = useArenaMenu(!paused),
    off = paused || menu.view !== null || menu.chatOpen || lobby.status !== "connected";
  const retained = useRef(lobby.game);
  if (lobby.game?.gift) retained.current = lobby.game;
  const game = lobby.game ?? retained.current,
    gift = useMemo(() => decodeGiftWire(game?.gift), [game?.gift]),
    round = game?.round ?? -1,
    self = lobby.players.find((p) => p.id === lobby.selfId),
    selfSlot = self && gift?.seats.includes(self.slot) ? self.slot : -1;
  // A round's players are built once: someone who leaves keeps their name, colour and costume.
  const cast = useRef<{ key: string; looks: GiftLook[]; seats: number[]; source: OnlineGiftSource | null }>({ key: "", looks: [], seats: [], source: null });
  const key = gift ? `${round}:${gift.seats.join(",")}:${selfSlot}` : "";
  if (gift && cast.current.key !== key) {
    cast.current.source?.dispose();
    cast.current = {
      key,
      looks: gift.seats.map((slot) => {
        const player = lobby.players.find((p) => p.slot === slot);
        return { color: player?.color ?? "#c9c4b6", costume: playerCostumeAtSlot(lobby.players, slot), name: player?.nickname ?? "Ayrıldı" };
      }),
      seats: [...gift.seats],
      source: new OnlineGiftSource({ stream: props.stream, sendInput: props.sendInput }, round, selfSlot),
    };
  }
  const { looks, seats, source } = cast.current;
  if (source) source.online = { stream: props.stream, sendInput: props.sendInput };
  // The prediction rig needs the physics engine; built once per round for a player in it.
  useEffect(() => {
    if (!source || source.slot < 0) return;
    let cancelled = false;
    void initializePhysics()
      .then(() => {
        if (!cancelled && !source.prediction) source.prediction = new LocalPrediction(source.slot as 0 | 1 | 2, "gift_grab");
      })
      .catch(() => setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [source]);
  useEffect(() => () => cast.current.source?.dispose(), []);
  useLayoutEffect(() => {
    props.stream.setPresentationEnabled(!paused);
    return () => props.stream.setPresentationEnabled(true);
  }, [props.stream, paused]);
  const hudLanes = useMemo(
    () => looks.map((look, seat) => ({ name: look.name, color: look.color, portrait: portraits[seat] ?? "", connected: lobby.players.find((p) => p.slot === seats[seat])?.connected ?? false })),
    [looks, portraits, lobby.players, seats]
  );
  const onPortraits = useCallback((urls: string[]) => setPortraits(urls), []);
  const keys = { pickup: actionBindingLabel(props.bindings, "grab").split(" / ")[0], punch: actionBindingLabel(props.bindings, "punch").split(" / ")[0] };
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  const current = shown && shown.frame.round === round ? shown : null;
  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="gift_grab">
      <div ref={viewport} className="pl-viewport" data-mode="gift_grab" tabIndex={0} role="region" aria-label="Online Hediye Kapmaca">
        <Canvas dpr={GIFT_DPR} camera={{ position: [0, 20, 10], fov: 30, near: 0.5, far: 400 }} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            {gift && source && <GiftPlayground key={key} source={source} looks={looks} seats={seats} bindings={props.bindings} paused={off} audio={audio} onStatus={setStatus} onFrame={setShown} onPortraits={onPortraits} />}
          </Suspense>
        </Canvas>
        <MenuButton onOpen={() => menu.setView("main")} />
        {current && <GiftHud frame={current.frame} reach={current.reach} lanes={hudLanes} keys={keys} afterRound={afterRoundText(!!lobby.board)} />}
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
        <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Hediye Kapmaca" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}>
          <p>
            WASD ile yürü (W ekranın yukarısı). {keys.pickup} ile kutu al: ortadaki yığından, yerden ya da rakibin evinden (içine girip). Kendi evine girince kutu kendiliğinden bırakılır. Aynı anda tek kutu taşınır; taşırken yumruk atamazsın. {keys.punch} ile yumruk: kutu taşıyana isabet edersen kutu düşer, o 1 saniye sersemler. 40 saniyede evinde en çok kutusu olan kazanır. Maç menü açıkken sürer.
          </p>
        </ArenaMenu>
      )}
    </div>
  );
}
