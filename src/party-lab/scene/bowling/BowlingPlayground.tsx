import {BowlingOnlineController,type BowlingOnline} from "./online";
import { flushSync } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Group, Matrix4, Quaternion, Vector3, TextureLoader, EquirectangularReflectionMapping, SRGBColorSpace, type PerspectiveCamera } from 'three';
import { initializePhysics } from '../physics';
import { PARTS } from '../ragdoll/config';
import { length, rotate } from '../ragdoll/math';
import PlayerBean from '../PlayerBean';
import { playerCostumeAtSlot, localCostumeForSlot, type SelectableCostumeId } from '../visual/costumes';
import { BowlingGame } from './game';
import { BowlingClock } from './clock';
import { BOWLING, COURSE, roadHeight, botThrow } from './config';
import { bowlingCamera, BOWLING_DRIVE_PRESETS, bowlingCameraSession } from './camera';
import { bowlingDust } from './effects';
import { BowlingEngine } from './audio';
import type { AudioManager } from '../../audio/AudioManager';
import { bowlingVisual } from './visual';
import { BOWLING_PALETTE as palette } from './palette';
import type { BowlingSnapshot } from './BowlingHud';

export interface BowlingDebugAPI { game: BowlingGame; }
declare global { interface Window { __bowling?: BowlingDebugAPI; } }
let nextCourseSeed = Math.floor(Math.random()*0xffffffff);
export default function BowlingPlayground({ players, onStatus, onSnapshot, paused, costumeId, debug, audio, online }: {
  online?: BowlingOnline; audio: AudioManager; players: 2 | 3; onStatus: (s: 'loading' | 'ready' | 'error') => void;
  onSnapshot: (s: BowlingSnapshot) => void; paused: boolean; costumeId: SelectableCostumeId; debug: boolean;
}) {
  const [courseSeed] = useState(() => online?.lobby.game?.bowling?.seed ?? (debug && new URLSearchParams(window.location.search).has("bowlingSeed") ? (Number(new URLSearchParams(window.location.search).get("bowlingSeed")) >>> 0) : nextCourseSeed++));
  const kit = useLoader(GLTFLoader, '/party-lab/maps/bowling/bowling-kit.glb');
  const sky = useLoader(TextureLoader, '/party-lab/maps/bowling/sky-day.webp');
  sky.mapping=EquirectangularReflectionMapping;sky.colorSpace=SRGBColorSpace;
  const visual = useMemo(() => bowlingVisual(kit.scene, courseSeed), [kit, courseSeed]);
  const dustTexture=useLoader(TextureLoader,'/party-lab/maps/bowling/dust.webp');
  const dust=useMemo(()=>bowlingDust(dustTexture),[dustTexture]);
  const engine=useMemo(()=>new BowlingEngine(),[]);
  const feedback=useRef({phase:'countdown',ejected:false,knocked:0,impact:false,count:0,vertical:0,landed:false,stuntHits:0});
  const { camera, gl, scene } = useThree();
  // A cached texture primitive can retain stale R3F attachment metadata across
  // keyed restarts. Own the scene background explicitly and restore it on exit.
  useLayoutEffect(() => {
    const previous=scene.background;scene.background=sky;
    return () => { if(scene.background===sky)scene.background=previous; };
  },[scene,sky]);
  const net=useRef<BowlingOnlineController|null>(null);
  if(net.current&&online)Object.assign(net.current.options,online);
  const game = useRef<BowlingGame | null>(null), character = useRef<Group>(null);
  const [slot, setSlot] = useState(0);
  const input = useRef({ left: false, right: false, throttle: false, brake: false, eject: false, angleUp: false, angleDown: false });
  const cameraFeedback = useRef({ serial: 0, held: false, until: 0 });
  const inputSuspended = useRef(paused);
  const clock = useRef({ simulation: new BowlingClock(), scaling: [] as number[], publish: 0, frames: [] as number[], ccd: [] as number[], steps: [] as number[], js: [] as number[], effects: [] as number[], destructibles: [] as number[], lastTurn: -1, cameraCost: 0, cameraSamples: 0, cameraReady: false });
  const tmp = useMemo(() => ({ carP: new Vector3(), carQ: new Quaternion(), p: new Vector3(), q: new Quaternion(), scale: new Vector3(COURSE.pinScale, COURSE.pinScale, COURSE.pinScale), matrix: new Matrix4(), look: new Vector3(), at: new Vector3(), target: new Vector3(), poses: Array.from({ length: 19 }, () => ({ p: new Vector3(), q: new Quaternion() })) }), []);
  useEffect(() => {
    let alive = true; onStatus('loading');
    initializePhysics().then(() => {
      if (!alive) return;
      const g = new BowlingGame(players, courseSeed, !!online); game.current = g;
      if(online)net.current=new BowlingOnlineController({...online},courseSeed,players);
      if (debug) { g.world.profilerEnabled=true; window.__bowling = { game: g }; }
      onStatus('ready');
    }).catch(() => { if (alive) onStatus('error'); });
    return () => { alive = false; if (window.__bowling?.game === game.current) delete window.__bowling; net.current?.dispose();net.current=null;game.current?.dispose(); game.current = null; };
  }, [players, debug, onStatus, courseSeed]);
  useEffect(() => () => visual.dispose(), [visual]);
  useEffect(()=>{const unlock=(event:Event)=>{if(event.isTrusted&&!document.hidden)engine.unlock();},silence=()=>engine.silence();window.addEventListener('keydown',unlock);window.addEventListener('pointerdown',unlock);window.addEventListener('blur',silence);document.addEventListener('visibilitychange',silence);return()=>{window.removeEventListener('keydown',unlock);window.removeEventListener('pointerdown',unlock);window.removeEventListener('blur',silence);document.removeEventListener('visibilitychange',silence);engine.dispose();audio.stopAll();};},[engine,audio]);
  useEffect(()=>()=>dust.dispose(),[dust]);
  useLayoutEffect(() => {
    inputSuspended.current = paused;
    const clear = () => { cameraFeedback.current.held = false; input.current = { left: false, right: false, throttle: false, brake: false, eject: false, angleUp: false, angleDown: false }; if(!net.current)game.current?.cancelCharge(); };
    if(paused) clear();
    const key = (e: KeyboardEvent, down: boolean) => {
      if (e.code === 'KeyV' && !down) cameraFeedback.current.held = false;
      // Clear synchronously on Esc, before React commits the menu.
      // A queued Space event must never eject behind the menu.
      if (e.code === 'Escape') { if(down&&!e.repeat){inputSuspended.current=true;clear();}return; }
      // The DOM parent restores focus before R3F can commit its resumed props.
      // Capture fresh viewport keys during that tiny window. The paused physics
      // clock cannot consume them until resume; menu/form keys stay excluded.
      if (!(e.target as HTMLElement)?.closest?.('.pl-viewport') || document.querySelector('.pl-menu-root')) return;
      if (e.code === 'KeyV') {
        e.preventDefault();
        const feedback = cameraFeedback.current;
        if (down && !e.repeat && !feedback.held && !paused && !inputSuspended.current && game.current?.phase === 'drive') {
          bowlingCameraSession.preset = (bowlingCameraSession.preset + 1) % BOWLING_DRIVE_PRESETS.length;
          feedback.serial++;
          feedback.until = performance.now() + 1250;
          clock.current.publish = 1;
        }
        feedback.held = down;
        return;
      }
      if (!['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) return;
      e.preventDefault(); const k = input.current;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') k.left = down;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') k.right = down;
      if (e.code === 'KeyW') k.throttle = down;
      if (e.code === 'KeyS') k.brake = down;
      if(e.code==='ArrowUp') k.angleUp=down;
      if(e.code==='ArrowDown') k.angleDown=down;
      if(e.code==='Space') k.eject=down;
    };
    const down = (e: KeyboardEvent) => key(e, true), up = (e: KeyboardEvent) => key(e, false);
    const visibility = () => { if (document.hidden) clear(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', visibility); };
  }, [paused]);
  useFrame((_, delta) => {
    const g = game.current; if (!g) return;
    const started = performance.now(), c = clock.current, dt = Math.min(delta, 0.1);
    const bodies = [...PARTS.map(n => g.character.parts[n].body), ...g.pins.map(p => p.body)];
    if (c.lastTurn !== g.score.turn) { c.lastTurn = g.score.turn; setSlot(g.phase === 'score' || g.phase === 'results' ? g.lastPlayer : g.score.current); }
    const scalingStart=performance.now();let physicsCost=0,stepStart=0,beforePhase=g.phase;
    const frameInput={ steer: Number(input.current.left) - Number(input.current.right), throttle: Number(input.current.throttle), brake: Number(input.current.brake), eject: input.current.eject, pitch:Number(input.current.angleUp||input.current.throttle)-Number(input.current.angleDown||input.current.brake) };
    if(net.current)net.current.advance(g,delta,frameInput,paused||inputSuspended.current||document.hidden);
    else c.simulation.advance(g,paused||inputSuspended.current||document.hidden?0:dt,{ steer: Number(input.current.left) - Number(input.current.right), throttle: Number(input.current.throttle), brake: Number(input.current.brake), eject: input.current.eject, pitch:Number(input.current.angleUp||input.current.throttle)-Number(input.current.angleDown||input.current.brake) },()=>{
      bodies.forEach((b,i)=>{const p=b.translation(),q=b.rotation();tmp.poses[i].p.set(p.x,p.y,p.z);tmp.poses[i].q.set(q.x,q.y,q.z,q.w);});
      const cp=g.car.body.translation(),cq=g.car.body.rotation();tmp.carP.set(cp.x,cp.y,cp.z);tmp.carQ.set(cq.x,cq.y,cq.z,cq.w);
      stepStart=performance.now();beforePhase=g.phase;
    },()=>{
      if(debug){c.ccd.push(g.world.timingCcd());if(c.ccd.length>1200)c.ccd.shift();}
      const cost=performance.now()-stepStart;physicsCost+=cost;c.steps.push(cost);if(c.steps.length>1200)c.steps.shift();
      if(beforePhase!==g.phase)bodies.forEach((b,i)=>{const p=b.translation(),q=b.rotation();tmp.poses[i].p.set(p.x,p.y,p.z);tmp.poses[i].q.set(q.x,q.y,q.z,q.w);});
    });
    // Recover if the parent menu's Esc debounce rejected the open request.
    if(inputSuspended.current&&!paused&&!document.querySelector('.pl-menu-root')) inputSuspended.current=false;
    c.scaling.push(performance.now()-scalingStart-physicsCost);if(c.scaling.length>240)c.scaling.shift();
    if ((g.phase === 'drive' || g.phase === 'countdown') && slot !== g.score.current) setSlot(g.score.current);
    const alpha = net.current ? 1 : c.simulation.accumulator / BOWLING.step;
    bodies.forEach((b, i) => {
      const p = b.translation(), q = b.rotation();
      tmp.p.set(p.x, p.y, p.z); tmp.q.set(q.x, q.y, q.z, q.w);
      if (g.phase === 'flight' && feedback.current.phase===g.phase) { tmp.p.lerp(tmp.poses[i].p, 1 - alpha); tmp.q.slerp(tmp.poses[i].q, 1 - alpha); }
      if (i < 9) { const part = character.current?.children[i]; if (part) { part.position.copy(tmp.p); part.quaternion.copy(tmp.q); } }
      else { tmp.matrix.compose(tmp.p, tmp.q, tmp.scale); visual.pins.setMatrixAt(i - 9, tmp.matrix); }
    });
    visual.pins.instanceMatrix.needsUpdate = true;
    const destructionStart=performance.now();visual.stunts.update(g.car.stuntStates,g.obstacles);
    c.destructibles.push(performance.now()-destructionStart);if(c.destructibles.length>240)c.destructibles.shift();
    const f=feedback.current,quiet=paused||document.hidden||!document.hasFocus();
    // Bots use the same deterministic throttle selection as their existing driver.
    const throttle=online?(online.lobby.game?.bowling?.throttle??0):g.phase==='drive'?(g.score.current===0?Number(input.current.throttle):botThrow(g.seed,g.score.current,g.score.round).throttle):0;
    engine.step(g.car.speed,throttle,!quiet&&(g.phase==='drive'||g.phase==='countdown'),audio.settings);
    if(!quiet){
      if(g.car.hitCount>f.stuntHits){
        audio.playSfx({name:'heavyBump',intensity:.55});dust.burst(g.car.body.translation());
      }
      // Only successful eject() sets ejected. Selection, missed launches and Nudge do not.
      if(!f.ejected&&g.ejected){audio.playSfx({name:'fall',actor:g.score.current});dust.burst(g.car.body.translation());}
      if(g.phase==='countdown')f.landed=false;
      const pelvis=g.character.body.translation(),vertical=g.character.body.linvel().y;
      if(g.phase==='flight'&&!f.landed&&g.landed){f.landed=true;audio.playSfx({name:'floorFlop',intensity:.8});dust.burst(pelvis);}
      f.vertical=vertical;
      if(!f.impact&&g.impact){audio.playSfx({name:'heavyBump',intensity:.6});dust.burst(pelvis);}
      if(g.knocked===10&&f.knocked<10)dust.burst({x:0,y:2,z:BOWLING.headZ});
      if(g.phase==='flight'&&g.landed&&pelvis.y<.8&&length(g.character.body.linvel())>3)dust.trail(pelvis,dt,false);
      if(g.phase==='drive'&&g.car.grounded&&g.car.speed>5)dust.trail(g.car.body.translation(),dt,Math.abs(g.car.heading)>.2||input.current.brake);
      if(g.knocked>f.knocked)audio.playSfx({name:g.knocked===10?'winner':'lightBump',intensity:.7});
      const count=g.phase==='countdown'?Math.ceil((BOWLING.countdown-g.phaseTime)/.7):0;
      if(count!==f.count&&count>0)audio.playSfx({name:'countdown',step:count});f.count=count;
    }
    f.ejected=g.ejected;f.stuntHits=g.car.hitCount;f.phase=g.phase;f.knocked=g.knocked;f.impact=g.impact;const effectStart=performance.now();dust.step(quiet?0:dt);if(dust.points.visible){c.effects.push(performance.now()-effectStart);if(c.effects.length>120)c.effects.shift();}
    const carPosition=g.car.body.translation(), carRotation=g.car.body.rotation();
    visual.car.position.set(carPosition.x,carPosition.y,carPosition.z);visual.shadow.position.set(carPosition.x,roadHeight(carPosition.z)+.03,carPosition.z);visual.shadow.rotation.z=-g.car.heading;visual.shadow.visible=carPosition.z<BOWLING.rampStart||carPosition.z>BOWLING.rampLip;visual.car.quaternion.set(carRotation.x,carRotation.y,carRotation.z,carRotation.w);
    if(c.cameraReady){visual.car.position.lerp(tmp.carP,1-alpha);visual.car.quaternion.slerp(tmp.carQ,1-alpha);}
    // Before eject only the upper driver is shown in the cockpit. No ragdoll bodies simulate.
    if(character.current) {
      const seated=!g.ejected;
      character.current.visible=seated || g.phase==='flight' || g.phase==='score' || g.phase==='results';
      if(seated) {
        character.current.children.forEach((part,i)=>{
          part.visible=i<3;
          if(i<3){tmp.p.set(0,i===0?.12:i===1?.48:.94,-.35).applyQuaternion(visual.car.quaternion);part.position.copy(visual.car.position).add(tmp.p);part.quaternion.copy(visual.car.quaternion);}
        });
      } else character.current.children.forEach(part=>{part.visible=true;});
    }
    const cameraStarted = debug ? performance.now() : 0;
    const pose = bowlingCamera(g.phase, g.character.body.translation(), g.impact, carPosition, g.ejected?g.airHeading:g.car.heading, g.phase==='flight'?length(g.character.body.linvel()):g.car.speed, (camera as PerspectiveCamera).aspect, bowlingCameraSession.preset);
    tmp.at.set(pose.position.x, pose.position.y, pose.position.z); tmp.target.set(pose.target.x, pose.target.y, pose.target.z);
    const blend = c.cameraReady ? 1 - Math.exp(-dt / (g.impact ? 0.45 : 0.22)) : 1;
    camera.position.lerp(tmp.at, blend); tmp.look.lerp(tmp.target, blend); camera.up.set(0, 1, 0); camera.lookAt(tmp.look);
    const cam = camera as PerspectiveCamera; cam.fov += (pose.fov - (g.charging?6:0) - cam.fov) * blend; cam.updateProjectionMatrix(); c.cameraReady = true;
    if (debug) { c.cameraCost += performance.now() - cameraStarted; c.cameraSamples++; }
    c.frames.push(delta * 1000); if (c.frames.length > 240) c.frames.shift();
    c.js.push(performance.now() - started); if (c.js.length > 240) c.js.shift();
    c.publish += dt;
    if (g.charging || beforePhase!==g.phase || c.publish > 0.1) {
      c.publish = 0;
      const mean = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(3);
      const sorted = [...c.steps].sort((a, b) => a - b);
      const data = debug ? { online:!!online, prediction:net.current?.prediction.metrics, seed: g.seed, variant: (g.seed+g.score.round-1)%6, obstacles:g.obstacles, grounded:g.car.grounded, stuntHits:g.car.hitCount, landed:g.landed, pitchBudget:g.pitchBudget, phase: g.phase, player: g.score.current, round: g.score.round, turn: g.score.turn, car: g.car.body.translation(), charging:g.charging, nudgeUsed:g.nudgeUsed, angle:g.angle,angleDirection:g.angleDirection, measurement:g.measurement, measurements:g.measurements, heading: g.car.heading, timeScale:g.timeScale,tailTime:g.tailTime,realThrowTime:g.realThrowTime,scalingMs:mean(c.scaling),simulationTime:c.simulation.simulationTime,driveTime: g.driveTime, ejectPosition: g.ejectPosition, inherited: g.inherited, missedEject: g.missedEject, speed: g.speed, ragdollSpeed: +length(g.character.body.linvel()).toFixed(2), knocked: g.knocked, mask: g.mask, pinTilts: g.pins.map(p => +(Math.acos(Math.max(-1, Math.min(1, rotate(p.body.rotation(), { x: 0, y: 1, z: 0 }).y))) * 180 / Math.PI).toFixed(1)), elapsed: +g.elapsed.toFixed(2), retries: g.retries, fps: +(1000 / mean(c.frames)).toFixed(1), jsFrameMs: mean(c.js), ccdAvgMs:mean(c.ccd),ccdMaxMs:Math.max(0,...c.ccd),physicsAvgMs: mean(c.steps), physicsMaxMs: sorted[sorted.length-1]??0, physicsP99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0, destructibleUpdateAvgMs:mean(c.destructibles), particleUpdateAvgMs: mean(c.effects), particles: dust.active, drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, dynamicBodies: g.world.bodies.len(), activeBodies: bodies.filter(b=>b.isEnabled()&&!b.isSleeping()).length+(g.car.body.isSleeping()?0:1), colliders: g.world.colliders.len(), totals: g.score.totals, throws: g.score.throws, durations: g.durations, pelvis: g.character.body.translation(), cameraUpdateMs: c.cameraCost / Math.max(1, c.cameraSamples), cameraPreset: bowlingCameraSession.preset, cameraFov: cam.fov, camera: camera.position.toArray() } : undefined;
      const publishSnapshot = () => onSnapshot({ phase: g.phase, player: g.phase === 'score' || g.phase === 'results' ? g.lastPlayer : g.score.current, round: g.phase === 'score' ? Math.floor((g.score.turn - 1) / players) + 1 : g.score.round, totals: g.score.totals, throws: g.score.throws.map(t => [...t]), speed: g.phase==='flight'?length(g.character.body.linvel()):g.car.speed, countdown: Math.max(1,Math.ceil((BOWLING.countdown-g.phaseTime)/.7)), charging:g.charging,nudgeUsed:g.nudgeUsed,angle:g.angle,angleDirection:g.angleDirection,airHint:g.phase==='flight'&&!g.impact, inZone: g.inLaunchRegion||g.launchCommitted, missedEject:g.missedEject, knocked: g.knocked, lastPoints: g.lastPoints, lastPlayer: g.lastPlayer, winners: g.score.winners, retry: g.retryNotice, cameraPreset: bowlingCameraSession.preset, cameraNotice: performance.now() < cameraFeedback.current.until ? cameraFeedback.current.serial : 0, debug: data });
      // Commit the instrument before the next keyboard event: release must lock
      // the needle the player actually saw, without a deferred React frame.
      if(g.charging) { flushSync(publishSnapshot);if(!net.current)g.acknowledgeLaunchAngle(); } else publishSnapshot();
    }
  });
  return <>
    <fog attach="fog" args={[palette.fog, 170, 330]} />
    <hemisphereLight args={[palette.skyLight, palette.groundLight, 2]} /><directionalLight position={[-8, 16, -5]} intensity={2.4} color={palette.sunlight} />
    <primitive object={visual.root} /><primitive object={dust.points} />
    <PlayerBean ref={character} costume={online?playerCostumeAtSlot(online.lobby.players,online.lobby.game?.bowling?.seats[slot]??0):localCostumeForSlot(costumeId, slot)} color={['#f6c773', '#e985a2', '#79bbed'][slot]} />

  </>;
}
