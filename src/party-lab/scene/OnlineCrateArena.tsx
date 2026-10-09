import {Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Canvas} from '@react-three/fiber';
import type {Bindings} from '../input/bindings';
import {usePartyAudio} from '../audio/PartyAudio';
import {ArenaMenu,ArenaStatus,MenuButton,useArenaMenu} from './ArenaChrome';
import CrateRainPlayground from './craterain/CrateRainPlayground';
import CrateRainHud from './craterain/CrateRainHud';
import CrateControls from './craterain/CrateControls';
import {crateBindings,loadCrateOverrides,saveCrateOverrides,type CrateOverrides} from './craterain/controls';
import type {CrateSnapshot} from './craterain/game';
import type {CrateOnline} from './craterain/online';
import type {CrateView} from './craterain/camera';
interface Props extends CrateOnline {bindings:Bindings;paused:boolean;onLeave:()=>void;onBindings:(b:Bindings)=>void;bindingsSaved:boolean;}
export default function OnlineCrateArena(props:Props){
  const {lobby,paused}=props,{audio}=usePartyAudio(),viewport=useRef<HTMLDivElement>(null);
  const [snapshot,setSnapshot]=useState<CrateSnapshot|null>(null),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[view,setView]=useState<CrateView>('third');
  const [overrides,setOverrides]=useState(loadCrateOverrides),[saved,setSaved]=useState(true),bindings=useMemo(()=>crateBindings(props.bindings,overrides),[props.bindings,overrides]);
  const update=useCallback((next:CrateOverrides)=>{setOverrides(next);setSaved(saveCrateOverrides(next));},[]);
  const menu=useArenaMenu(!paused),off=paused||menu.view!==null||menu.chatOpen||lobby.status!=='connected';
  const lockEnded=useCallback(()=>menu.setView('main'),[menu.setView]);
  const retained=useRef(lobby.game);if(lobby.game?.crate)retained.current=lobby.game;
  const game=lobby.game??retained.current,wire=game?.crate,self=lobby.players.find(p=>p.id===lobby.selfId);
  const names=wire?.seats.map(id=>lobby.players.find(p=>p.slot===id)?.nickname??'Ayrıldı'),index=wire?.seats.indexOf(self?.slot??-1)??-1;
  useEffect(()=>{if(!off)viewport.current?.focus();},[off]);
  return <div className="party-lab pl-playground pl-immersive" data-mode="crate_rain">
    <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Kutu Yağmuru" onPointerDown={()=>viewport.current?.focus()}>
      <Canvas dpr={[1,1.5]} camera={{position:[0,12,14],fov:66,near:.06,far:180}} gl={{antialias:true,alpha:true}}>
        <Suspense fallback={null}>{wire&&<CrateRainPlayground key={`${lobby.round}:${wire.seed}`} players={wire.seats.length===3?3:2} audio={audio} onStatus={setStatus} onSnapshot={setSnapshot} paused={off} bindings={bindings} view={view} onView={setView} onLockLost={lockEnded} costumeId={self?.costumeId??'cat'} online={{lobby,stream:props.stream,sendInput:props.sendInput}}/>}</Suspense>
      </Canvas>
      <MenuButton onOpen={()=>menu.setView('main')}/>
      {snapshot&&wire&&<CrateRainHud snapshot={snapshot} bindings={bindings} view={view} names={names} self={index}/>}
      <div className="pl-arena-side"><ArenaStatus lobby={lobby} spectating={!self?.participating}/></div>
      {status!=='ready'&&<div className="pl-arena-message" role="status"><strong>{status==='error'?'Arena yüklenemedi':'Arena bağlanıyor…'}</strong></div>}
    </div>
    {menu.view&&<ArenaMenu view={menu.view} setView={menu.setView} onResume={()=>menu.setView(null)} onLeave={props.onLeave} lobby={lobby} modeName="Kutu Yağmuru" bindings={props.bindings} onBindings={props.onBindings} bindingsSaved={props.bindingsSaved} controlsContent={<CrateControls bindings={bindings} onChange={update} saved={saved} onClose={()=>menu.setView('main')}/>}><p>3 tur. Kutulara tırman, 20 saniye dayan. Maç menü açıkken sürer.</p></ArenaMenu>}
  </div>;
}
