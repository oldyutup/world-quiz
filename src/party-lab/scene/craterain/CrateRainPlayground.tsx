import { CrateOnlineController, type CrateOnline } from './online';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Fog, type PerspectiveCamera } from 'three';
import { initializePhysics } from '../physics';
import type { AudioManager } from '../../audio/AudioManager';
import type { SelectableCostumeId } from '../visual/costumes';
import { CRATE_RAIN as C } from './config';
import { CrateRainGame, type CrateSnapshot } from './game';
import { CrateCamera, nextCrateView, type CrateView } from './camera';
import { CrateInput, bindCrateInput, type CrateBindings } from './controls';
import { bindLook, type LookController } from '../../input/look';
import { CrateWarningsAudio } from './warnings';
import { crateVisual } from './visual';

export interface CrateMetrics { frames: number[]; js: number[]; physics: number[]; drawCalls: number; triangles: number; geometries: number; textures: number; droppedSeconds: number }
declare global { interface Window { __crateRain?: { online?: CrateOnlineController; visual: ReturnType<typeof crateVisual>; game: CrateRainGame; metrics: CrateMetrics; camera: PerspectiveCamera; controller: CrateCamera; view: CrateView; warningAudio: CrateWarningsAudio; audio: AudioManager } } }
export default function CrateRainPlayground({ players, onStatus, onSnapshot, paused, audio, costumeId, bindings, view, onView, onLockLost, online }: {
  online?: CrateOnline; onLockLost: () => void; bindings: CrateBindings; view: CrateView; onView: (view: CrateView) => void; players: 2 | 3; onStatus: (status: 'loading' | 'ready' | 'error') => void; onSnapshot: (s: CrateSnapshot) => void; paused: boolean; audio: AudioManager; costumeId: SelectableCostumeId;
}) {
  const { camera, gl, scene } = useThree();
  const onlineNow=useRef(online);onlineNow.current=online;const network=useRef<CrateOnlineController|null>(null);
  const visual = useMemo(() => crateVisual(players, costumeId, onlineNow.current?.lobby.game?.crate?.seats.map(slot=>onlineNow.current!.lobby.players.find(p=>p.slot===slot)?.nickname??"Ayrıldı")), [players, costumeId]);
  const game = useRef<CrateRainGame | null>(null), stopped = useRef(paused);
  const controller = useMemo(() => new CrateCamera(), []), warningAudio = useMemo(() => new CrateWarningsAudio(), []);
  const input = useMemo(() => new CrateInput(bindings), [bindings]), look = useRef<LookController | null>(null);
  const currentView = useRef(view); currentView.current = view;
  const timing = useRef({ acc: 0, publish: 0, count: 0, phase: '', alive: Number(players) });
  const metrics = useRef<CrateMetrics>({ frames: [], js: [], physics: [], drawCalls: 0, triangles: 0, geometries: 0, textures: 0, droppedSeconds: 0 });
  const debug = new URLSearchParams(window.location.search).get('crateDebug') === '1';
  useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera;
    const previous = { position: cam.position.clone(), rotation: cam.quaternion.clone(), fov: cam.fov, near: cam.near };
    return () => { cam.position.copy(previous.position); cam.quaternion.copy(previous.rotation); cam.fov = previous.fov; cam.near = previous.near; cam.updateProjectionMatrix(); cam.updateMatrixWorld(); };
  }, [camera]);
  useLayoutEffect(() => { const bg = scene.background, fog = scene.fog; scene.background = new Color('#c6d6c9'); scene.fog = new Fog('#c6d6c9', 52, 100); return () => { scene.background = bg; scene.fog = fog; }; }, [scene]);
  useEffect(() => {
    let live = true; onStatus('loading');
    initializePhysics().then(() => {
      if (!live) return;
      const query = new URLSearchParams(window.location.search), seed = Number(query.get('crateSeed') ?? Math.floor(Math.random() * 100000));
      const g = new CrateRainGame(players, onlineNow.current?.lobby.game?.crate?.seed ?? (Number.isFinite(seed) ? seed : 71)); game.current = g;
      if(onlineNow.current)network.current=new CrateOnlineController(onlineNow.current,players,g.seed);
      controller.reset(g,network.current?.self??0);
      if (debug) window.__crateRain = { online: network.current??undefined, visual, game: g, metrics: metrics.current, camera: camera as PerspectiveCamera, controller, view: currentView.current, warningAudio, audio };
      onStatus('ready'); onSnapshot(g.snapshot());
    }).catch(error => { console.error('Crate Rain initialization failed', error); if (live) onStatus('error'); });
    return () => { live = false; if (window.__crateRain?.game === game.current) delete window.__crateRain; network.current?.dispose();network.current=null;game.current?.dispose(); game.current = null; audio.stopAll(); };
  }, [players, onStatus, onSnapshot, debug, camera, audio, controller, warningAudio, visual]);
  useEffect(() => () => visual.dispose(), [visual]);
  useLayoutEffect(() => {
    stopped.current = paused;
    input.clear(); timing.current.acc = 0;
    look.current?.setEnabled(!paused && game.current?.phase !== 'results');
    if (paused) audio.stopAll();
  }, [paused, audio, input]);
  useEffect(() => {
    const surface = gl.domElement.closest<HTMLElement>('.pl-viewport'); if (!surface) return;
    const enabled = () => !stopped.current && !document.hidden && !document.querySelector('.pl-menu-root');
    const unbind = bindCrateInput(surface, input, enabled, () => { void audio.unlock(); });
    const mouse = bindLook(surface, 'lock', () => {}, onLockLost); look.current = mouse; mouse.setEnabled(enabled() && game.current?.phase !== 'results');
    return () => { unbind(); mouse.dispose(); look.current = null; };
  }, [gl, input, audio, onLockLost]);
  useFrame((_, delta) => {
    const g = game.current; if (!g) return;
    const start = performance.now(), clock = timing.current, m = metrics.current;
    const frozen = stopped.current || document.hidden || !!document.querySelector('.pl-menu-root'), dt = Math.min(delta, 0.075);
    if (frozen) clock.acc = 0; else { clock.acc += dt; m.droppedSeconds += Math.max(0, delta - dt); }
    if (frozen) input.clear();
    look.current?.setEnabled(!frozen && g.phase !== 'results');
    const intent = input.read();
    if (intent.camera && !frozen) { currentView.current = nextCrateView(currentView.current); onView(currentView.current); }
    const movement = controller.steer(intent, currentView.current, frozen ? 0 : dt, look.current?.consume());
    if(network.current){Object.assign(network.current.options,onlineNow.current);network.current.advance(g,delta,movement,frozen);clock.acc=0;if(!frozen)g.hits.forEach(hit=>{visual.burst(hit);audio.playSpatial('crate-impact',{frequency:130,end:55,duration:.20,noise:.75,gain:.13,priority:1,cooldown:.12},hit,{refDistance:3,maxDistance:16,rolloff:1,gain:.7,spatial:.75});});}
    while (!network.current && clock.acc >= C.step) {
      const phase = g.phase; g.step(movement); clock.acc -= C.step;
      if (debug && phase !== 'roundOver' && phase !== 'results') m.physics.push(g.physicsMs);
      g.hits.forEach(hit => { visual.burst(hit); audio.playSpatial('crate-impact', { frequency: 130, end: 55, duration: .20, noise: .75, gain: .13, priority: 1, cooldown: .12 }, hit, { refDistance: 3, maxDistance: 16, rolloff: 1, gain: .7, spatial: .75 }); });
    }
    const alive = g.players.filter(p => p.alive).length, count = g.phase === 'countdown' ? Math.ceil(C.countdown - g.phaseTime) : 0;
    if (!frozen && count > 0 && count !== clock.count) audio.playSfx({ name: 'countdown', step: count }); clock.count = count;
    if (!frozen && alive < clock.alive) audio.playSfx({ name: 'knockout', intensity: 0.55 }); clock.alive = alive;
    if (!frozen && g.phase !== clock.phase) { if (g.phase === 'playing') audio.playSfx({ name: 'roundStart' }); if (g.phase === 'roundOver') audio.playSfx({ name: g.winner < 0 ? 'draw' : 'winner', intensity: 0.5 }); } clock.phase = g.phase;
    const pose = controller.update(camera as PerspectiveCamera, g, currentView.current, dt, network.current ? 1 : clock.acc / C.step, network.current?.self??0);
    audio.setListener(pose.position, pose.forward);
    if (!frozen && g.phase === 'playing') warningAudio.update(g, audio, pose.position);
    visual.update(g, frozen ? 0 : dt, controller.hiddenPlayer ? pose.player : -1, network.current ? 1 : clock.acc / C.step);
    if (debug && window.__crateRain) window.__crateRain.view = currentView.current;
    clock.publish += dt; if (clock.publish > 0.1) { clock.publish = 0; onSnapshot(g.snapshot(network.current?.self??0)); }
    if (debug && !frozen) {
      m.frames.push(delta * 1000); m.js.push(performance.now() - start); m.drawCalls = Math.max(m.drawCalls, gl.info.render.calls); m.triangles = Math.max(m.triangles, gl.info.render.triangles); m.geometries = gl.info.memory.geometries; m.textures = gl.info.memory.textures;
      for (const a of [m.frames, m.js, m.physics]) if (a.length > 16000) a.splice(0, a.length - 16000);
    }
  });
  return <><hemisphereLight args={['#f3eddb', '#819b89', 2.0]} /><directionalLight color="#ffe5bd" position={[-8, 20, 12]} intensity={2.4} /><primitive object={visual.root} /></>;
}
