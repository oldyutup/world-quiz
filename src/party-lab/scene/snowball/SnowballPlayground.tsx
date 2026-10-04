import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Fog, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { initializePhysics } from '../physics';
import type { AudioManager } from '../../audio/AudioManager';
import { SNOWBALL as C } from './config';
import { SnowballGame, type SnowSnapshot } from './game';
import { snowVisual } from './visual';
import { snowballArenaCamera } from './camera';
import { snowballScreenInput } from './screenInput';

export interface SnowMetrics { frames:number[]; js:number[]; physics:number[]; drawCalls:number; triangles:number; dynamicBodies:number; invalidBodies:number; droppedSeconds:number }
declare global { interface Window { __snowball?: { game:SnowballGame; metrics:SnowMetrics; camera:PerspectiveCamera } } }
export default function SnowballPlayground({players,onStatus,onSnapshot,paused,audio}:{
  players:2|3;onStatus:(s:'loading'|'ready'|'error')=>void;onSnapshot:(s:SnowSnapshot)=>void;paused:boolean;audio:AudioManager;
}) {
  const {camera,gl,scene,size}=useThree(), visual=useMemo(()=>snowVisual(players),[players]);
  const game=useRef<SnowballGame|null>(null), keys=useRef(new Set<string>()), stopped=useRef(paused);
  const edgeLabels=useRef<(HTMLElement|null)[]>([]);
  const clock=useRef({acc:0,publish:0,ready:false,lastPhase:'',count:0,alive:Number(players)});
  const metrics=useRef<SnowMetrics>({frames:[],js:[],physics:[],drawCalls:0,triangles:0,dynamicBodies:players,invalidBodies:0,droppedSeconds:0});
  const tmp=useMemo(()=>({at:new Vector3(),screen:new Vector3(),previous:Array.from({length:players},()=>({p:new Vector3(),q:new Quaternion()}))}),[players]);
  const debug=new URLSearchParams(window.location.search).get('snowballDebug')==='1';
  useLayoutEffect(()=>{
    const cam=camera as PerspectiveCamera, pose=snowballArenaCamera(size.width,size.height);
    const previous={position:cam.position.clone(),rotation:cam.quaternion.clone(),fov:cam.fov};
    cam.position.set(...pose.position);cam.lookAt(...pose.target);cam.fov=pose.fov;
    cam.updateProjectionMatrix();cam.updateMatrixWorld();
    // Restore the incoming lens/pose when leaving this local mode. In particular,
    // Snowball must not leave its framing on Rooftop's reused Canvas camera.
    return()=>{cam.position.copy(previous.position);cam.quaternion.copy(previous.rotation);cam.fov=previous.fov;cam.updateProjectionMatrix();cam.updateMatrixWorld();};
  },[camera,size.width,size.height]);
  useLayoutEffect(()=>{const bg=scene.background,fog=scene.fog;scene.background=new Color('#c8dfe8');scene.fog=new Fog('#c8dfe8',48,100);return()=>{scene.background=bg;scene.fog=fog;};},[scene]);
  useEffect(()=>{
    let live=true;onStatus('loading');
    initializePhysics().then(()=>{if(!live)return;const g=new SnowballGame(players);game.current=g;
      if(debug)window.__snowball={game:g,metrics:metrics.current,camera:camera as PerspectiveCamera};
      onStatus('ready');onSnapshot(g.snapshot());
    }).catch(()=>{if(live)onStatus('error');});
    return()=>{live=false;if(window.__snowball?.game===game.current)delete window.__snowball;game.current?.dispose();game.current=null;};
  },[players,debug,onStatus,onSnapshot,camera]);
  useEffect(()=>()=>visual.dispose(),[visual]);
  useLayoutEffect(()=>{
    stopped.current=paused; if(paused){keys.current.clear();clock.current.acc=0;}
    const clear=()=>{keys.current.clear();clock.current.acc=0;};
    const key=(e:KeyboardEvent,down:boolean)=>{
      if(!down)keys.current.delete(e.code);
      if(e.code==='Escape'){clear();return;}
      // DOM focus is restored before R3F receives resumed props. Keep fresh keys
      // from that window; the paused clock cannot consume them behind a menu.
      if(!(e.target as HTMLElement)?.closest?.('.pl-viewport')||document.querySelector('.pl-menu-root'))return;
      if(!['KeyW','KeyS','KeyA','KeyD'].includes(e.code))return;
      e.preventDefault();if(down)keys.current.add(e.code);
    };
    const down=(e:KeyboardEvent)=>key(e,true),up=(e:KeyboardEvent)=>key(e,false);
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',clear);document.addEventListener('visibilitychange',clear);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',clear);};
  },[paused]);
  useFrame((_,delta)=>{
    const g=game.current;if(!g)return;const start=performance.now(),c=clock.current,m=metrics.current;
    const dt=Math.min(delta,0.075), frozen=stopped.current||document.hidden||!!document.querySelector('.pl-menu-root');
    if(!frozen){c.acc+=dt;m.droppedSeconds+=Math.max(0,delta-dt);}else c.acc=0;
    const x=Number(keys.current.has('KeyD'))-Number(keys.current.has('KeyA'));
    const z=Number(keys.current.has('KeyS'))-Number(keys.current.has('KeyW'));
    while(c.acc>=C.step){
      g.balls.forEach((b,i)=>{const p=b.body.translation(),q=b.body.rotation();tmp.previous[i].p.set(p.x,p.y,p.z);tmp.previous[i].q.set(q.x,q.y,q.z,q.w);});
      const me=g.balls[0],velocity=me.body.linvel();
      const input=snowballScreenInput(x,z,me.heading,Math.hypot(velocity.x,velocity.z));
      const phase=g.phase;g.step(input);if(debug&&phase!=='roundOver'&&phase!=='results')m.physics.push(g.physicsMs);
      g.hits.forEach(hit=>{visual.burst(hit);if(!frozen)audio.playSfx({name:'heavyBump',intensity:Math.min(0.8,hit.energy/16)});});
      c.acc-=C.step;
      if(phase!==g.phase)c.ready=false;
    }
    const alpha=c.acc/C.step;
    g.balls.forEach((b,i)=>{
      const p=b.body.translation(),q=b.body.rotation(),ball=visual.balls[i],marker=visual.markers[i],label=visual.labels[i];
      ball.position.set(p.x,p.y,p.z);ball.quaternion.set(q.x,q.y,q.z,q.w);
      if(c.ready&&!frozen&&g.phase==='playing'){ball.position.lerp(tmp.previous[i].p,1-alpha);ball.quaternion.slerp(tmp.previous[i].q,1-alpha);}
      ball.visible=b.alive;marker.visible=b.alive&&p.y>0&&Math.hypot(p.x,p.z)<g.radius;label.visible=b.alive;
      marker.position.set(p.x,0.025,p.z);marker.rotation.y=-b.heading;label.position.copy(ball.position).add(tmp.at.set(0,1.8,0));
    });
    c.ready=true;
    visual.platform.scale.set(g.radius,1,g.radius);visual.platform.visible=g.radius>0;visual.center.visible=g.radius>2.1;visual.update(frozen?0:dt);
    // Only off-screen rivals get edge markers. Number + colour matches the HUD.
    for(let i=1;i<players;i++){
      if(!edgeLabels.current[i]?.isConnected)edgeLabels.current[i]=document.querySelector(`[data-snow-edge="${i}"]`);
      const label=edgeLabels.current[i];if(!label)continue;
      tmp.screen.copy(visual.balls[i].position).project(camera);
      const behind=tmp.screen.z>1;
      label.hidden=g.phase!=='playing'||!g.balls[i].alive||(!behind&&Math.abs(tmp.screen.x)<0.92&&Math.abs(tmp.screen.y)<0.85);
      if(!label.hidden){let x=tmp.screen.x*(behind?-1:1),y=tmp.screen.y*(behind?-1:1);const scale=Math.max(Math.abs(x),Math.abs(y),0.001);x/=scale;y/=scale;
        label.style.left=`${50+x*44}%`;label.style.top=`${50-y*26}%`;label.style.setProperty('--bearing',`${Math.atan2(x,y)}rad`);
      }
    }
    const alive=g.balls.filter(b=>b.alive).length,count=g.phase==='countdown'?Math.ceil(C.countdown-g.phaseTime):0;
    if(!frozen&&count!==c.count&&count>0)audio.playSfx({name:'countdown',step:count});c.count=count;
    if(alive<c.alive){g.balls.filter(b=>!b.alive).forEach(b=>visual.burst(b.body.translation()));}c.alive=alive;
    if(c.lastPhase!==g.phase&&g.phase==='roundOver'&&!frozen)audio.playSfx({name:'winner',intensity:0.5});c.lastPhase=g.phase;
    c.publish+=dt;if(c.publish>0.1){c.publish=0;onSnapshot(g.snapshot());}
    if(debug&&!frozen){m.frames.push(delta*1000);m.js.push(performance.now()-start);m.drawCalls=Math.max(m.drawCalls,gl.info.render.calls);m.triangles=Math.max(m.triangles,gl.info.render.triangles);m.invalidBodies=g.invalidBodies;
      for(const list of [m.frames,m.js,m.physics])if(list.length>12000)list.splice(0,list.length-12000);
    }
  });
  return <><hemisphereLight args={['#e6f2ff','#6687a3',1.8]}/><directionalLight position={[-10,22,8]} intensity={2} color="#f4f2e9"/><primitive object={visual.root}/></>;
}
