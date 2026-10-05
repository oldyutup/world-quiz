import { FightOnlineController, type FightOnline } from './online';
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Fog, type PerspectiveCamera } from 'three';
import { initializePhysics } from '../physics';
import type { AudioManager } from '../../audio/AudioManager';
import type { LookController } from '../../input/look';
import { FIGHT as C, clamp, relativeMove, type FightInput } from './config';
import { SnowFightGame, type FightSnapshot } from './game';
import { CAMERA, newCamera, updateCamera } from './camera';
import { fightVisual } from './visual';
export interface FightMetrics {frames:number[];js:number[];physics:number[];drawCalls:number;triangles:number;geometries:number;textures:number;droppedSeconds:number}
declare global {interface Window {__snowFight?:{online?:FightOnlineController;game:SnowFightGame;metrics:FightMetrics;camera:PerspectiveCamera;view:{yaw:number;pitch:number;pose:ReturnType<typeof newCamera>}}}}

export default function SnowFightPlayground({players,onStatus,onSnapshot,paused,audio,look,online}:{online?:FightOnline;players:2|3;onStatus:(s:'loading'|'ready'|'error')=>void;onSnapshot:(s:FightSnapshot)=>void;paused:boolean;audio:AudioManager;look:MutableRefObject<LookController|null>}){
  const {camera,gl,scene}=useThree();
  const onlineNow=useRef(online);onlineNow.current=online;const network=useRef<FightOnlineController|null>(null);
  const visual=useMemo(()=>fightVisual(players,onlineNow.current?.lobby.game?.fight?.seats.map(slot=>onlineNow.current!.lobby.players.find(p=>p.slot===slot)?.nickname??"Ayrıldı")),[players]),game=useRef<SnowFightGame|null>(null);
  const keys=useRef(new Set<string>()),mouse=useRef({down:false,press:false}),stopped=useRef(paused);
  const view=useRef({yaw:Math.PI,pitch:Number(CAMERA.pitch),pose:newCamera()});
  const timing=useRef({acc:0,publish:0,hitUntil:0,count:0,respawns:0});
  const metrics=useRef<FightMetrics>({frames:[],js:[],physics:[],drawCalls:0,triangles:0,geometries:0,textures:0,droppedSeconds:0});
  const debug=new URLSearchParams(window.location.search).get('fightDebug')==='1';
  useLayoutEffect(()=>{
    const cam=camera as PerspectiveCamera,old={p:cam.position.clone(),q:cam.quaternion.clone(),fov:cam.fov,bg:scene.background,fog:scene.fog};
    cam.fov=CAMERA.fov;cam.updateProjectionMatrix();scene.background=new Color('#cbdfe1');scene.fog=new Fog('#cbdfe1',35,76);
    return()=>{cam.position.copy(old.p);cam.quaternion.copy(old.q);cam.fov=old.fov;cam.updateProjectionMatrix();scene.background=old.bg;scene.fog=old.fog;};
  },[camera,scene]);
  useEffect(()=>{
    let live=true;onStatus('loading');
    initializePhysics().then(()=>{
      if(!live)return;const seed=Number(new URLSearchParams(window.location.search).get('fightSeed')??71),g=new SnowFightGame(players,onlineNow.current?.lobby.game?.fight?.seed??(Number.isFinite(seed)?seed:71));game.current=g;
      if(onlineNow.current){network.current=new FightOnlineController(onlineNow.current,players,onlineNow.current.lobby.game!.fight!.seed);network.current.self=Math.max(0,onlineNow.current.lobby.game!.fight!.seats.indexOf(network.current.slot));}
      view.current.yaw=g.players[network.current?.self??0].yaw;view.current.pose=newCamera();timing.current.respawns=0;
      if(debug)window.__snowFight={online:network.current??undefined,game:g,metrics:metrics.current,camera:camera as PerspectiveCamera,view:view.current};
      onStatus('ready');onSnapshot(g.snapshot());
    }).catch(e=>{console.error('Snowball Fight initialization failed',e);if(live)onStatus('error');});
    return()=>{live=false;if(window.__snowFight?.game===game.current)delete window.__snowFight;network.current?.dispose();network.current=null;game.current?.dispose();game.current=null;audio.stopAll();};
  },[players,onStatus,onSnapshot,audio,camera,debug]);
  useEffect(()=>()=>visual.dispose(),[visual]);
  useLayoutEffect(()=>{
    stopped.current=paused;look.current?.setEnabled(!paused);
    const clear=()=>{keys.current.clear();mouse.current={down:false,press:false};timing.current.acc=0;};
    if(paused){clear();audio.stopAll();}
    const key=(e:KeyboardEvent,down:boolean)=>{
      if(!down)keys.current.delete(e.code);if(e.code==='Escape'){clear();return;}
      if(!(e.target as HTMLElement)?.closest?.('.pl-viewport')||document.querySelector('.pl-menu-root'))return;
      if(!['KeyW','KeyA','KeyS','KeyD','KeyE','KeyC','ControlLeft','ControlRight','ShiftLeft','ShiftRight','Space'].includes(e.code))return;
      e.preventDefault();if(down)keys.current.add(e.code);
    };
    const down=(e:KeyboardEvent)=>key(e,true),up=(e:KeyboardEvent)=>key(e,false);
    const click=(e:MouseEvent)=>{if(e.button!==0||stopped.current||look.current?.claimsClick(e)||!(e.target as HTMLElement)?.closest?.('.pl-viewport')||document.querySelector('.pl-menu-root'))return;if(!mouse.current.down)mouse.current.press=true;mouse.current.down=true;};
    const release=()=>{mouse.current.down=false;};
    const lock=()=>{if(!document.pointerLockElement)clear();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('mousedown',click);window.addEventListener('mouseup',release);window.addEventListener('blur',clear);document.addEventListener('visibilitychange',clear);document.addEventListener('pointerlockchange',lock);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('mousedown',click);window.removeEventListener('mouseup',release);window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',clear);document.removeEventListener('pointerlockchange',lock);};
  },[paused,audio,look]);
  useFrame((_,delta)=>{
    const g=game.current;if(!g)return;const start=performance.now(),clock=timing.current,m=metrics.current,v=view.current,cam=camera as PerspectiveCamera,dt=Math.min(.06,delta);
    const frozen=stopped.current||document.hidden||!!document.querySelector('.pl-menu-root')||(!g.autoHuman&&look.current?.status!=='locked');
    if(!frozen){const d=look.current?.consume();if(d){v.yaw-=d.dx*CAMERA.sensitivity;v.pitch=clamp(v.pitch+d.dy*CAMERA.sensitivity,CAMERA.minPitch,CAMERA.maxPitch);}}
    const player=g.players[network.current?.self??0];
    if(player.respawns!==clock.respawns){clock.respawns=player.respawns;v.pose=newCamera();const at=player.body.translation();v.yaw=Math.atan2(-at.x,-at.z);v.pitch=CAMERA.pitch;}
    const pose=updateCamera(v.pose,g.solids,player.body.translation(),v.yaw,v.pitch,player.crouch,dt);
    cam.position.set(pose.position.x,pose.position.y,pose.position.z);cam.lookAt(pose.position.x+pose.forward.x,pose.position.y+pose.forward.y,pose.position.z+pose.forward.z);cam.updateMatrixWorld();
    if(frozen)clock.acc=0;else{clock.acc+=dt;m.droppedSeconds+=Math.max(0,delta-dt);}
    const k=keys.current,move=relativeMove(Number(k.has('KeyD'))-Number(k.has('KeyA')),Number(k.has('KeyS'))-Number(k.has('KeyW')),v.yaw);
    const input:FightInput={...move,yaw:v.yaw,jump:k.has('Space'),sprint:k.has('ShiftLeft')||k.has('ShiftRight'),crouch:k.has('KeyC')||k.has('ControlLeft')||k.has('ControlRight'),gather:k.has('KeyE'),throw:mouse.current.press,aim:g.aimPoint(pose.position,pose.forward,network.current?.self??0)};
    if(network.current){Object.assign(network.current.options,onlineNow.current);network.current.advance(g,delta,input,v.pitch,frozen);clock.acc=C.step;}
    while(clock.acc>=C.step){
      if(!network.current)g.step(input);clock.acc-=C.step;input.throw=false;mouse.current.press=false;
      if(debug&&g.phase==='playing')m.physics.push(g.physicsMs);
      for(const e of g.events){
        if(e.kind==='impact'||e.kind==='hit'||e.kind==='ko')visual.burst(e.p,e.kind==='ko'||e.head);
        if(e.kind==='hit'&&e.actor===(network.current?.self??0))clock.hitUntil=g.time+.17;
        const names={throw:'throw',pack:'release',gather:'grab',impact:'floorFlop',hit:'bodyHit',ko:'knockout',respawn:'recovery',start:'roundStart',finish:g.snapshot().leaders.length===1?'winner':'draw',jump:'jump'} as const;
        audio.playSfx({name:names[e.kind],intensity:e.kind==='impact'?.22:e.kind==='hit'?.55:.5});
      }
      const count=g.phase==='countdown'?Math.ceil(C.countdown-g.countdown):0;if(count>0&&clock.count!==count)audio.playSfx({name:'countdown',step:count});clock.count=count;
      if(g.phase==='results')look.current?.setEnabled(false);
    }
    visual.update(g,frozen?0:dt,network.current?1:frozen?1:clock.acc/C.step,pose.boom,network.current?.self??0);
    clock.publish+=dt;if(clock.publish>.07){clock.publish=0;onSnapshot({...g.snapshot(network.current?.self??0),hitMarker:g.time<clock.hitUntil});}
    if(debug&&!frozen&&g.phase!=='results'){
      m.frames.push(delta*1000);m.js.push(performance.now()-start);m.drawCalls=Math.max(m.drawCalls,gl.info.render.calls);m.triangles=Math.max(m.triangles,gl.info.render.triangles);m.geometries=gl.info.memory.geometries;m.textures=gl.info.memory.textures;
      for(const a of[m.frames,m.js,m.physics])if(a.length>16000)a.splice(0,a.length-16000);
    }
  });
  return <><hemisphereLight args={['#f4f0e5','#96b9c5',2.0]}/><directionalLight color="#ffe5c5" position={[-12,20,10]} intensity={2.3}/><primitive object={visual.root}/></>;
}
