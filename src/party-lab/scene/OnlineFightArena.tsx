import {Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {Canvas} from '@react-three/fiber';
import type {Bindings} from '../input/bindings';
import {bindLook,type LookController,type LookStatus} from '../input/look';
import {usePartyAudio} from '../audio/PartyAudio';
import {ArenaMenu,ArenaStatus,MenuButton,useArenaMenu} from './ArenaChrome';
import SnowFightPlayground from './snowfight/SnowFightPlayground';
import SnowFightHud from './snowfight/SnowFightHud';
import type {FightSnapshot} from './snowfight/game';
import type {FightOnline} from './snowfight/online';
interface Props extends FightOnline {bindings:Bindings;paused:boolean;onLeave:()=>void;onBindings:(b:Bindings)=>void;bindingsSaved:boolean;}
export default function OnlineFightArena(props:Props){
 const {lobby,paused}=props,{audio}=usePartyAudio(),viewport=useRef<HTMLDivElement>(null),look=useRef<LookController|null>(null);
 const [snapshot,setSnapshot]=useState<FightSnapshot|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[lookStatus,setLookStatus]=useState<LookStatus>('unlocked');
 const menu=useArenaMenu(!paused),off=paused||menu.view!==null||menu.chatOpen||lobby.status!=='connected';
 const lockEnded=useCallback(()=>menu.setView('main'),[menu.setView]);
 useEffect(()=>{if(!viewport.current)return;const c=bindLook(viewport.current,'lock',setLookStatus,lockEnded);look.current=c;return()=>{c.dispose();look.current=null;};},[lockEnded]);
 useEffect(()=>{look.current?.setEnabled(!off);if(!off)viewport.current?.focus();},[off]);
 const retained=useRef(lobby.game);if(lobby.game?.fight)retained.current=lobby.game;
 const game=lobby.game??retained.current,wire=game?.fight,self=lobby.players.find(p=>p.id===lobby.selfId),names=wire?.seats.map(id=>lobby.players.find(p=>p.slot===id)?.nickname??'Ayrıldı'),index=wire?.seats.indexOf(self?.slot??-1)??-1;
 return <div className="party-lab pl-playground pl-immersive" data-mode="snowball_fight">
  <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Kartopu Savaşı" data-look="lock" onPointerDown={()=>viewport.current?.focus()}>
   <Canvas dpr={[1,1.5]} camera={{position:[0,12,14],fov:68,near:.1,far:180}} gl={{antialias:true,alpha:true}}>
    <Suspense fallback={null}>{wire&&<SnowFightPlayground key={`${lobby.round}:${wire.seed}`} players={wire.seats.length===3?3:2} audio={audio} onStatus={setStatus} onSnapshot={setSnapshot} paused={off} look={look} online={{lobby,stream:props.stream,sendInput:props.sendInput}}/>}</Suspense>
   </Canvas>
   <MenuButton onOpen={()=>menu.setView('main')}/>
   {snapshot&&wire&&<SnowFightHud snapshot={snapshot} lookStatus={lookStatus} names={names} self={index}/>}
   <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating}/></div>
   {status!=='ready'&&<div className="pl-arena-message" role="status"><strong>{status==='error'?'Arena yüklenemedi':'Arena bağlanıyor…'}</strong></div>}
  </div>
  {menu.view&&<ArenaMenu view={menu.view} setView={menu.setView} onResume={()=>menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Kartopu Savaşı" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} controlsContent={<div data-party-controls><button className="pl-button pl-join" onClick={()=>menu.setView('main')}>← Menüye Dön</button><h2 id="pl-menu-title">Kartopu Savaşı kontrolleri</h2><p>WASD · Hareket<br/>SHIFT · Koş<br/>SPACE · Zıpla<br/>C / CTRL · Çömel<br/>E basılı tut · Kar Topla<br/>Mouse1 · Fırlat<br/>Fare · Nişan al</p></div>}><p>80 saniyede en yüksek skor kazanır. Maç menü açıkken sürer.</p></ArenaMenu>}
 </div>;
}
