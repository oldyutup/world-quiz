import {Suspense,useMemo,useRef,useState} from 'react';
import {Canvas} from '@react-three/fiber';
import type {Bindings} from '../input/bindings';
import {usePartyAudio} from '../audio/PartyAudio';
import {ArenaMenu,ArenaStatus,MenuButton,useArenaMenu} from './ArenaChrome';
import RacePlayground from './kartrace/RacePlayground';
import RaceHud from './kartrace/RaceHud';
import RaceControls from './kartrace/RaceControls';
import {loadRaceExtras,saveRaceExtras,raceBindings,type RaceExtras} from './kartrace/controls';
import type {RaceSnapshot} from './kartrace/game';
import type {RaceOnline} from './kartrace/online';
interface Props extends RaceOnline {bindings:Bindings;paused:boolean;onLeave:()=>void;onBindings:(b:Bindings)=>void;bindingsSaved:boolean;}
export default function OnlineRaceArena(props:Props){
 const {lobby,paused}=props,{audio}=usePartyAudio(),viewport=useRef<HTMLDivElement>(null);
 const [snapshot,setSnapshot]=useState<RaceSnapshot|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 const [extras,setExtras]=useState(loadRaceExtras),[saved,setSaved]=useState(true),bindings=useMemo(()=>raceBindings(props.bindings,extras),[props.bindings,extras]);
 const updateExtras=(value:RaceExtras)=>{setExtras(value);setSaved(saveRaceExtras(value));};
 const menu=useArenaMenu(!paused),off=paused||menu.view!==null||menu.chatOpen||lobby.status!=='connected';
 const retained=useRef(lobby.game);if(lobby.game?.race)retained.current=lobby.game;
 const game=lobby.game??retained.current,wire=game?.race,self=lobby.players.find(p=>p.id===lobby.selfId),names=wire?.seats.map(id=>lobby.players.find(p=>p.slot===id)?.nickname??'Ayrıldı'),index=wire?.seats.indexOf(self?.slot??-1)??-1;
 return <div className="party-lab pl-playground pl-immersive" data-mode="kart_race">
  <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Araba Yarışı" onPointerDown={()=>viewport.current?.focus()}>
   <Canvas dpr={[1,1.5]} camera={{position:[0,12,14],fov:68,near:.1,far:700}} gl={{antialias:true,alpha:true}}>
    <Suspense fallback={null}>{wire&&<RacePlayground key={lobby.round} players={wire.seats.length===3?3:2} audio={audio} bindings={bindings} onStatus={setStatus} onSnapshot={setSnapshot} paused={off} online={{lobby,stream:props.stream,sendInput:props.sendInput}}/>}</Suspense>
   </Canvas>
   <MenuButton onOpen={()=>menu.setView('main')}/>
   {snapshot&&wire&&<RaceHud snapshot={snapshot} names={names} self={index} bindings={bindings}/>}
   <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating}/></div>
   {status!=='ready'&&<div className="pl-arena-message" role="status"><strong>{status==='error'?'Arena yüklenemedi':'Arena bağlanıyor…'}</strong></div>}
  </div>
  {menu.view&&<ArenaMenu view={menu.view} setView={menu.setView} onResume={()=>menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Araba Yarışı" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} controlsContent={<RaceControls online bindings={bindings} shared={props.bindings} onShared={props.onBindings} onExtras={updateExtras} saved={props.bindingsSaved&&saved} onClose={()=>menu.setView('main')}/>}><p>3 tur. Maç menü açıkken sürer.</p></ArenaMenu>}
 </div>;
}
