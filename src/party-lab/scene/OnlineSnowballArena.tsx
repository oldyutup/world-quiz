import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { Bindings } from '../input/bindings';
import type { NetDiagnostics } from '../network/diagnostics';
import { usePartyAudio } from '../audio/PartyAudio';
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from './ArenaChrome';
import SnowballPlayground from './snowball/SnowballPlayground';
import SnowballHud from './snowball/SnowballHud';
import type { SnowSnapshot } from './snowball/game';
import type { SnowballOnline } from './snowball/online';
interface Props extends SnowballOnline {bindings:Bindings;paused:boolean;onLeave:()=>void;onBindings:(b:Bindings)=>void;bindingsSaved:boolean;diagnostics?:NetDiagnostics|null;debug?:boolean;}
export default function OnlineSnowballArena(props:Props){
  const {lobby,paused}=props,{audio}=usePartyAudio(),viewport=useRef<HTMLDivElement>(null);
  const [snapshot,setSnapshot]=useState<SnowSnapshot|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const menu=useArenaMenu(!paused),off=paused||menu.view!==null||lobby.status!=='connected';
  const retained=useRef(lobby.game);if(lobby.game?.snowball)retained.current=lobby.game;
  const game=lobby.game??retained.current,wire=game?.snowball,self=lobby.players.find(p=>p.id===lobby.selfId);
  const names=wire?.seats.map(id=>lobby.players.find(p=>p.slot===id)?.nickname??'Ayrıldı'),index=wire?.seats.indexOf(self?.slot??-1)??-1;
  useEffect(()=>{if(!off)viewport.current?.focus();},[off]);
  return <div className="party-lab pl-playground pl-immersive" data-mode="snowball_brawl">
    <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Kartopu Çarpışması" onPointerDown={()=>viewport.current?.focus()}>
      <Canvas dpr={[1,1.5]} camera={{position:[0,12,14],fov:45,near:.1,far:180}} gl={{antialias:true,alpha:true}}>
        <Suspense fallback={null}>{wire&&<SnowballPlayground key={`${lobby.round}:${wire.seed}`} players={wire.seats.length===3?3:2} audio={audio} onStatus={setStatus} onSnapshot={setSnapshot} paused={off} names={names} self={index} online={{lobby,stream:props.stream,sendInput:props.sendInput,diagnostics:props.diagnostics}}/>}</Suspense>
      </Canvas>
      <MenuButton onOpen={()=>menu.setView('main')}/>
      {snapshot&&wire&&<SnowballHud snapshot={snapshot} names={names} self={index}/>}
      <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating}/></div>
      {status!=='ready'&&<div className="pl-arena-message" role="status"><strong>{status==='error'?'Arena yüklenemedi':'Arena bağlanıyor…'}</strong></div>}
    </div>
    {menu.view&&<ArenaMenu view={menu.view} setView={menu.setView} onResume={()=>menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Kartopu Çarpışması" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved}
      controlsContent={<div className="pl-snow-controls" data-party-controls><button className="pl-button pl-join" onClick={()=>menu.setView('main')}>← Menüye Dön</button><h2 id="pl-menu-title">Kartopu kontrolleri</h2><p>W / S · Ekranda yukarı / aşağı<br/>A / D · Ekranda sol / sağ<br/>Esc · Menü</p><p>Kamera sabit kalır. Ters yöne basarak frenle. Maç menü açıkken sürer.</p></div>}>
      <p>Son kalan kartopu turu kazanır. 3 tur. Buz 28 saniye sonra daralmaya başlar, 36 saniyeden sonra hızlanır.</p>
    </ArenaMenu>}
  </div>;
}
