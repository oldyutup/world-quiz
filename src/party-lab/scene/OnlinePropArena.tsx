import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Bindings } from "../input/bindings";
import { bindLook, loadLookMode, saveLookMode, type LookController, type LookMode, type LookStatus } from "../input/look";
import type { LobbySnapshot } from "../network/types";
import type { GameStream } from "../network/gameStream";
import type { NetDiagnostics } from "../network/diagnostics";
import type { AnyInputPacket } from "../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../shared/party-lab/intent";
import type { PlayerId } from "./players";
import { ArenaMenu, ArenaStatus, MenuButton, ControlHint, useArenaMenu, useDebugPanel } from "./ArenaChrome";
import { usePartyAudio } from "../audio/PartyAudio";
import { controlHint } from "./arenaMenu";
import OnlinePropView from "./prophunt/OnlinePropView";
import OnlinePropHud from "./prophunt/OnlinePropHud";
import type { PropSnapshot, PropHudElements } from "./prophunt/PropHuntPlayground";
import type { SeekerView } from "./prophunt/propCamera";

interface Props {
  lobby: LobbySnapshot; stream: GameStream; bindings: Bindings; paused: boolean;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
  onLeave: () => void; onBindings: (bindings: Bindings) => void; bindingsSaved: boolean;
  diagnostics?: NetDiagnostics | null; debug?: boolean;
}
export default function OnlinePropArena(props: Props) {
  const { lobby, bindings, paused, onLeave } = props;
  const { audio, settings } = usePartyAudio();
  const viewport = useRef<HTMLDivElement>(null);
  const hud = useRef<PropHudElements>({ debug: null, timer: null, bar: null, callout: null, prompt: null, crosshair: null, blind: null, blindTime: null, sense: null, senseGlow: null, reveals: [] });
  const [snapshot, setSnapshot] = useState<PropSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "graphics-error">("loading");
  const [view, setView] = useState<SeekerView>("third");
  const [lookMode, setLookMode] = useState<LookMode>(loadLookMode), [lookStatus, setLookStatus] = useState<LookStatus>("unlocked");
  const look = useRef<LookController | null>(null), lookNow = useRef(lookMode); lookNow.current = lookMode;
  const menu = useArenaMenu(!paused), menuOpen = menu.view !== null, inputOff = paused || menuOpen;
  const debug = useDebugPanel(!!props.debug);
  const self = lobby.players.find((p) => p.id === lobby.selfId), slot = (self?.slot ?? 0) as PlayerId;
  const wire = lobby.game?.mode === "prop_hunt" ? lobby.game.prop : null;
  const role = wire?.seeker === slot ? "seeker" : "hider";
  const names = [0, 1, 2].map((id) => lobby.players.find((p) => p.slot === id)?.nickname ?? "Ayrıldı");
  const out = !!wire && !(wire.alive & (1 << slot));
  const { lockEnded } = menu;
  useEffect(() => { if (!inputOff) viewport.current?.focus(); }, [inputOff]);
  useEffect(() => {
    if (!viewport.current) return;
    const controller = bindLook(viewport.current, lookNow.current, setLookStatus, lockEnded); look.current = controller;
    return () => { controller.dispose(); look.current = null; };
  }, [lockEnded]);
  useEffect(() => { look.current?.setMode(lookMode); saveLookMode(lookMode); }, [lookMode]);
  useEffect(() => { look.current?.setEnabled(!inputOff); }, [inputOff]);
  return <div className="party-lab pl-playground pl-immersive" data-mode="prop_hunt">
    <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Saklambaç" data-mode="prop_hunt" data-look={lookMode} onPointerDown={() => viewport.current?.focus()}>
      <Canvas dpr={[1, 1.5]} camera={{ position: [0, 8, 9], fov: 52, near: 0.1, far: 180 }} gl={{ antialias: true, alpha: true }}>
        {wire && <OnlinePropView key={`${lobby.round}:${slot}`} lobby={lobby} stream={props.stream} sendInput={props.sendInput} slot={slot} role={role} onStatus={setStatus} onSnapshot={setSnapshot} hud={hud} bindings={bindings} paused={paused} menuOpen={menuOpen || lobby.status !== "connected"} audio={audio} shakeEnabled={settings.cameraShake} look={look} view={view} onView={setView} proximityEnabled={wire.settings.proximity} />}
      </Canvas>
      <MenuButton onOpen={() => menu.setView("main")} />
      {snapshot && wire && <OnlinePropHud snapshot={snapshot} hud={hud} debugOpen={!!props.debug && debug.open} slot={slot} names={names} ammoMax={wire.settings.ammo} proximity={wire.settings.proximity} whistleSeconds={Math.ceil(wire.whistle[slot] / 60)} />}
      <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating} /></div>
      {(status === "loading" || status === "error") && <div className="pl-arena-message" role="status"><strong>{status === "error" ? "Arena yüklenemedi" : "Arena bağlanıyor…"}</strong></div>}
      {lookMode === "lock" && lookStatus !== "locked" && !inputOff && !out && wire?.phase !== "results" && <div className="pl-arena-message pl-look-prompt"><strong>Kamerayı çevirmek için arenaya tıkla</strong><span>Fare ya da trackpad ile çevir · Esc menü</span></div>}
      <ControlHint text={controlHint(bindings, role === "seeker" ? "propSeeker" : "propHider", lookMode).replace("15 mermi", `${wire?.settings.ammo ?? 15} mermi`)} playing={lobby.phase === "playing"} replay={menu.hintReplay} hidden={menuOpen || out} />
    </div>
    {menu.view && <ArenaMenu view={menu.view} setView={menu.setView} onResume={() => menu.setView(null)} onLeave={onLeave} lobby={lobby} modeName="Saklambaç" bindings={bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} look={{ mode: lookMode, onChange: setLookMode }} debug={props.debug ? { open: debug.open, onToggle: debug.toggle } : null}>
      {role === "seeker" && <label className="pl-menu-row"><span>Kamera</span><select value={view} onChange={e => setView(e.target.value === "first" ? "first" : "third")}><option value="third">Omuz üstü (3. şahıs)</option><option value="first">Birinci şahıs (FPS)</option></select></label>}
    </ArenaMenu>}
  </div>;
}
