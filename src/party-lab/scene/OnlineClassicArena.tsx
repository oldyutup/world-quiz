import {Suspense,useRef,useState} from 'react';
import {Canvas} from '@react-three/fiber';
import type {Bindings} from '../input/bindings';
import {usePartyAudio} from '../audio/PartyAudio';
import {ArenaMenu,ArenaStatus,MenuButton,useArenaMenu} from './ArenaChrome';
import ClassicPlayground from './classicbowling/ClassicPlayground';
import ClassicHud from './classicbowling/ClassicHud';
import ClassicControls from './classicbowling/ClassicControls';
import type {ClassicSnapshot} from './classicbowling/game';
import type {ClassicOnline} from './classicbowling/online';
interface Props extends ClassicOnline {bindings:Bindings;paused:boolean;onLeave:()=>void;onBindings:(b:Bindings)=>void;bindingsSaved:boolean;}
export default function OnlineClassicArena(props:Props){
 const {lobby,paused}=props,{audio}=usePartyAudio(),viewport=useRef<HTMLDivElement>(null);
 const [snapshot,setSnapshot]=useState<ClassicSnapshot|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 const menu=useArenaMenu(!paused),off=paused||menu.view!==null||menu.chatOpen||lobby.status!=='connected';
 const retained=useRef(lobby.game);if(lobby.game?.classic)retained.current=lobby.game;
 const game=lobby.game??retained.current,wire=game?.classic,self=lobby.players.find(p=>p.id===lobby.selfId),names=wire?.seats.map(id=>lobby.players.find(p=>p.slot===id)?.nickname??'Ayrıldı');
 return <div className="party-lab pl-playground pl-immersive" data-mode="classic_bowling">
  <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Klasik Bowling" onPointerDown={()=>viewport.current?.focus()}>
   <Canvas dpr={[1,1.5]} camera={{position:[0,3.35,-6.4],fov:46,near:.05,far:65}} gl={{antialias:true,alpha:true}}>
    <Suspense fallback={null}>{wire&&<ClassicPlayground key={`${lobby.round}:${wire.seed}`} players={wire.seats.length===3?3:2} audio={audio} bindings={props.bindings} onStatus={setStatus} onSnapshot={setSnapshot} paused={off} online={{lobby,stream:props.stream,sendInput:props.sendInput,diagnostics:props.diagnostics}}/>}</Suspense>
   </Canvas>
   <MenuButton onOpen={()=>menu.setView('main')}/>
   {snapshot&&wire&&<ClassicHud snapshot={snapshot} names={names} bindings={props.bindings}/>}
   <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating}/></div>
   {status!=='ready'&&<div className="pl-arena-message" role="status"><strong>{status==='error'?'Arena yüklenemedi':'Arena bağlanıyor…'}</strong></div>}
  </div>
  {menu.view&&<ArenaMenu view={menu.view} setView={menu.setView} onResume={()=>menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Klasik Bowling" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} controlsContent={<ClassicControls bindings={props.bindings} onBindings={props.onBindings} onClose={()=>menu.setView('main')}/>}><p>Her pin 1 puan. Kişi başı 3 tur, en fazla 30 puan. Maç menü açıkken sürer.</p></ArenaMenu>}
 </div>;
}
