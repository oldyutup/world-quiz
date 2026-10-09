import {Suspense,useEffect,useRef,useState} from 'react';
import {Canvas} from '@react-three/fiber';
import type {Bindings} from '../input/bindings';
import type {NetDiagnostics} from '../network/diagnostics';
import {usePartyAudio} from '../audio/PartyAudio';
import {ArenaMenu,ArenaStatus,MenuButton,useArenaMenu,useDebugPanel} from './ArenaChrome';
import BowlingPlayground from './bowling/BowlingPlayground';
import BowlingHud,{type BowlingSnapshot} from './bowling/BowlingHud';
import type {BowlingOnline} from './bowling/online';
interface Props extends BowlingOnline {bindings:Bindings;paused:boolean;onLeave:()=>void;onBindings:(b:Bindings)=>void;bindingsSaved:boolean;diagnostics?:NetDiagnostics|null;debug?:boolean;}
export default function OnlineBowlingArena(props:Props){
 const {lobby,paused}=props,{audio}=usePartyAudio(),viewport=useRef<HTMLDivElement>(null);
 const [snapshot,setSnapshot]=useState<BowlingSnapshot|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 const menu=useArenaMenu(!paused),debug=useDebugPanel(!!props.debug),off=paused||menu.view!==null||menu.chatOpen||lobby.status!=='connected';
 // The session clears its presentation stream while reconnecting. Keep this
 // scene mounted so camera selection and one-shot eject audio survive the gap.
 const retainedGame=useRef(lobby.game);
 if(lobby.game?.bowling)retainedGame.current=lobby.game;
 const game=lobby.game??retainedGame.current,wire=game?.bowling,self=lobby.players.find(p=>p.id===lobby.selfId);
 const viewLobby=game===lobby.game?lobby:{...lobby,game};
 useEffect(()=>{if(!off)viewport.current?.focus();},[off]);
 return <div className="party-lab pl-playground pl-immersive" data-mode="human_bowling">
  <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online İnsan Bowlingi" onPointerDown={()=>viewport.current?.focus()}>
   <Canvas dpr={[1,1.5]} camera={{position:[0,12,14],fov:45,near:.1,far:180}} gl={{antialias:true,alpha:true}}>
    <Suspense fallback={null}>{wire&&<BowlingPlayground key={`${lobby.round}:${wire.seed}`} players={wire.seats.length===3?3:2} audio={audio} onStatus={setStatus} onSnapshot={setSnapshot} paused={off} costumeId={self?.costumeId??'cat'} debug={!!props.debug} online={{lobby:viewLobby,stream:props.stream,sendInput:props.sendInput}} />}</Suspense>
   </Canvas>
   <MenuButton onOpen={()=>menu.setView('main')} />
   {snapshot&&wire&&<BowlingHud snapshot={snapshot} debugOpen={!!props.debug&&debug.open} names={wire.seats.map(id=>lobby.players.find(p=>p.slot===id)?.nickname??'Ayrıldı')} self={wire.seats.indexOf(self?.slot??-1)} />}
   <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating} /></div>
   {status!=='ready'&&<div className="pl-arena-message" role="status"><strong>{status==='error'?'Arena yüklenemedi':'Arena bağlanıyor…'}</strong></div>}
  </div>
  {menu.view&&<ArenaMenu view={menu.view} setView={menu.setView} onResume={()=>menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="İnsan Bowlingi" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} debug={props.debug?{open:debug.open,onToggle:debug.toggle}:null}><p>W gaz · S fren · A / D direksiyon · V kamera. Sarı bölgede SPACE tut, bırakınca fırla. Havada WASD ile yön ver, SPACE ile tek Nudge kullan.</p></ArenaMenu>}
 </div>;
}
