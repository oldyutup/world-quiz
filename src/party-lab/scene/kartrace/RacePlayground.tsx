import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Fog, TextureLoader, EquirectangularReflectionMapping, SRGBColorSpace, type PerspectiveCamera } from 'three';
import type { AudioManager } from '../../audio/AudioManager';
import { initializePhysics } from '../physics';
import { RaceOnlineController,type RaceOnline } from './online';
import { RaceGame, type RaceSnapshot } from './game';
import { RaceTrack } from './track';
import { RACE } from './config';
import { raceVisual } from './visual';
import { cameraSession, newCamera, updateCamera, VIEWS } from './camera';
import { RaceEngine } from './audio';
import { bindKeyboard } from '../../input/keyboard';
import { raceInputBindings, readRaceInput, type RaceBindings } from './controls';
export interface RaceMetrics {frames:number[];js:number[];physics:number[];drawCalls:number;triangles:number;geometries:number;textures:number;droppedSeconds:number}
declare global {interface Window {__kartRace?:{game:RaceGame;metrics:RaceMetrics;camera:PerspectiveCamera;view:ReturnType<typeof newCamera>;online?:RaceOnlineController}}}
export default function RacePlayground({players,paused,onStatus,onSnapshot,audio,bindings,online}:{online?:RaceOnline;bindings:RaceBindings;players:2|3;paused:boolean;onStatus:(s:'loading'|'ready'|'error')=>void;onSnapshot:(s:RaceSnapshot)=>void;audio:AudioManager}){
  const {camera,gl,scene}=useThree(),kit=useLoader(GLTFLoader,'/party-lab/maps/bowling/bowling-kit.glb');
  const sky=useLoader(TextureLoader,'/party-lab/maps/bowling/sky-day.webp');sky.mapping=EquirectangularReflectionMapping;sky.colorSpace=SRGBColorSpace;
  const visual=useMemo(()=>raceVisual(kit.scene,new RaceTrack(),players),[kit,players]);
  const engine=useMemo(()=>new RaceEngine(),[]),game=useRef<RaceGame|null>(null),keyboard=useRef<ReturnType<typeof bindKeyboard>|null>(null),stopped=useRef(paused),view=useRef(newCamera());
  const currentBindings=useRef(bindings);currentBindings.current=bindings;
  const network=useRef<RaceOnlineController|null>(null),onlineRef=useRef(online);onlineRef.current=online;if(network.current&&online)Object.assign(network.current.options,online);
  const resetQueued=useRef(false);
  const timing=useRef({acc:0,publish:0,count:0,viewUntil:0,reset:0,impactAt:0});
  const metrics=useRef<RaceMetrics>({frames:[],js:[],physics:[],drawCalls:0,triangles:0,geometries:0,textures:0,droppedSeconds:0});
  const debug=new URLSearchParams(window.location.search).get('raceDebug')==='1';
  useLayoutEffect(()=>{
    const cam=camera as PerspectiveCamera,old={p:cam.position.clone(),q:cam.quaternion.clone(),fov:cam.fov,near:cam.near,far:cam.far,bg:scene.background,fog:scene.fog};
    cam.near=.1;cam.far=700;cam.updateProjectionMatrix();scene.background=sky;scene.fog=new Fog('#c6ded9',180,470);
    return()=>{cam.position.copy(old.p);cam.quaternion.copy(old.q);cam.fov=old.fov;cam.near=old.near;cam.far=old.far;cam.updateProjectionMatrix();scene.background=old.bg;scene.fog=old.fog;};
  },[camera,scene,sky]);
  useEffect(()=>{
    let live=true;onStatus('loading');initializePhysics().then(()=>{if(!live)return;const g=new RaceGame(players);game.current=g;if(onlineRef.current){g.bots=false;network.current=new RaceOnlineController(onlineRef.current,players);}view.current=newCamera();if(debug)window.__kartRace={game:g,metrics:metrics.current,camera:camera as PerspectiveCamera,view:view.current,online:network.current??undefined};onStatus('ready');onSnapshot(g.snapshot());}).catch(e=>{console.error('Race initialization failed',e);if(live)onStatus('error');});
    return()=>{live=false;if(window.__kartRace?.game===game.current)delete window.__kartRace;network.current?.dispose();network.current=null;game.current?.dispose();game.current=null;};
  },[players,onStatus,onSnapshot,camera,debug]);
  useEffect(()=>()=>visual.dispose(),[visual]);
  useEffect(()=>{const unlock=(e:Event)=>{if(e.isTrusted&&!document.hidden)engine.unlock();},quiet=()=>engine.silence();window.addEventListener('keydown',unlock);window.addEventListener('pointerdown',unlock);window.addEventListener('blur',quiet);document.addEventListener('visibilitychange',quiet);return()=>{window.removeEventListener('keydown',unlock);window.removeEventListener('pointerdown',unlock);window.removeEventListener('blur',quiet);document.removeEventListener('visibilitychange',quiet);engine.dispose();audio.stopAll();};},[engine,audio]);
  useEffect(()=>{
    const input=bindKeyboard(gl.domElement,raceInputBindings(currentBindings.current));keyboard.current=input;input.setSuspended(stopped.current);
    const clearPending=()=>{resetQueued.current=false;timing.current.acc=0;};
    window.addEventListener('blur',clearPending);window.addEventListener('pointercancel',clearPending);document.addEventListener('visibilitychange',clearPending);
    return()=>{input.dispose();keyboard.current=null;window.removeEventListener('blur',clearPending);window.removeEventListener('pointercancel',clearPending);document.removeEventListener('visibilitychange',clearPending);};
  },[gl]);
  useLayoutEffect(()=>{keyboard.current?.setBindings(raceInputBindings(bindings));},[bindings]);
  useLayoutEffect(()=>{
    stopped.current=paused;keyboard.current?.setSuspended(paused);
    if(paused){resetQueued.current=false;timing.current.acc=0;engine.silence();audio.stopAll();}
  },[paused,engine,audio]);
  useFrame((_,delta)=>{
    const g=game.current;if(!g)return;const start=performance.now(),t=timing.current,m=metrics.current,dt=Math.min(.0667,delta),frozen=stopped.current||document.hidden||!!document.querySelector('.pl-menu-root');
    if(frozen)t.acc=0;else{t.acc+=dt;m.droppedSeconds+=Math.max(0,delta-dt);}
    const read=keyboard.current&&!frozen?readRaceInput(keyboard.current.manager):{drive:{throttle:0,brake:0,steer:0,reset:false},camera:false};
    if(read.camera){cameraSession.preset=(cameraSession.preset+1)%VIEWS.length;t.viewUntil=performance.now()+1400;}
    resetQueued.current ||= !!read.drive.reset;
    const input={...read.drive,reset:resetQueued.current};
    if(network.current){network.current.advance(g,delta,input,frozen);resetQueued.current=false;t.acc=0;const count=g.phase==='countdown'?Math.ceil(g.countdown):0;if(count>0&&count!==t.count)audio.playSfx({name:'countdown',step:count});t.count=count;for(const e of g.events)audio.playSfx({name:e.kind==='impact'?'bodyHit':e.kind==='finish'?'winner':e.kind==='reset'?'recovery':'roundStart',intensity:e.intensity});}
    while(t.acc>=RACE.step){g.step(input);resetQueued.current=false;input.reset=false;t.acc-=RACE.step;if(debug&&g.phase==='racing')m.physics.push(g.physicsMs);
      const count=g.phase==='countdown'?Math.ceil(g.countdown):0;if(count>0&&count!==t.count)audio.playSfx({name:'countdown',step:count});t.count=count;
      for(const e of g.events){if(e.kind==='impact'){if(g.time-t.impactAt>.12){audio.playSfx({name:'bodyHit',intensity:e.intensity});t.impactAt=g.time;}}else if(e.id===0||e.kind==='start')audio.playSfx({name:e.kind==='start'?'roundStart':e.kind==='finish'?'winner':e.kind==='lap'?'roundStart':'recovery',intensity:.55});}
    }
    const self=network.current?.self??0;
    visual.update(g,network.current||frozen?1:t.acc/RACE.step);
    if(g.progress[self].resets!==t.reset){view.current.ready=false;t.reset=g.progress[self].resets;}
    const p=visual.cars[self].position,pose=updateCamera(view.current,g.world,p,visual.cars[self].rotation.y,g.cars[self].speed,dt),cam=camera as PerspectiveCamera;
    cam.position.set(pose.position.x,pose.position.y,pose.position.z);cam.lookAt(pose.target.x,pose.target.y,pose.target.z);cam.fov=pose.fov;cam.updateProjectionMatrix();
    engine.step(g.cars[self].speed,input.throttle,!frozen&&g.phase!=='results',audio.settings,g.cars[self].grass);
    t.publish+=dt;if(t.publish>.08){t.publish=0;onSnapshot({...g.snapshot(self),camera:performance.now()<t.viewUntil?VIEWS[cameraSession.preset].label:undefined});}
    if(debug&&!frozen&&g.phase!=='results'){m.frames.push(delta*1000);m.js.push(performance.now()-start);m.drawCalls=Math.max(m.drawCalls,gl.info.render.calls);m.triangles=Math.max(m.triangles,gl.info.render.triangles);m.geometries=gl.info.memory.geometries;m.textures=gl.info.memory.textures;for(const a of [m.frames,m.js,m.physics])if(a.length>15000)a.splice(0,a.length-15000);}
  });
  return <><hemisphereLight args={['#f5eeda','#8b9e77',2.1]}/><directionalLight position={[-35,60,20]} color="#f9e7c8" intensity={2.4}/><primitive object={visual.root}/></>;
}
