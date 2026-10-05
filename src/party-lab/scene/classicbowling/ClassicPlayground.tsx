import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, type PerspectiveCamera } from 'three';
import { initializePhysics } from '../physics';
import { bindKeyboard } from '../../input/keyboard';
import type { Bindings } from '../../input/bindings';
import type { AudioManager } from '../../audio/AudioManager';
import { ClassicOnlineController,type ClassicOnline } from './online';
import { ClassicGame, type ClassicSnapshot } from './game';
import { classicVisual } from './visual';
import { classicCamera } from './camera';
import { classicAudio } from './audio';

export interface ClassicMetrics { frames: number[]; js: number[]; physics: number[]; drawCalls: number; triangles: number; geometries: number; textures: number }
declare global { interface Window { __classicBowling?: { game: ClassicGame; metrics: ClassicMetrics; camera: PerspectiveCamera; audio: AudioManager; online?:ClassicOnlineController } } }
export default function ClassicPlayground({ players, bindings, paused, onStatus, onSnapshot, audio, online }: {
  online?:ClassicOnline; players: 2 | 3; bindings: Bindings; paused: boolean; onStatus: (s: 'loading' | 'ready' | 'error') => void; onSnapshot: (s: ClassicSnapshot) => void; audio: AudioManager;
}) {
  const { camera, gl, scene } = useThree();
  const game = useRef<ClassicGame | null>(null), keyboard = useRef<ReturnType<typeof bindKeyboard> | null>(null);
  const visual = useMemo(classicVisual, []), view = useMemo(classicCamera, []), sound = useMemo(() => classicAudio(audio), [audio]);
  const currentBindings = useRef(bindings); currentBindings.current = bindings;
  const network=useRef<ClassicOnlineController|null>(null),onlineRef=useRef(online);onlineRef.current=online;if(network.current&&online)Object.assign(network.current.options,online);
  const stopped = useRef(paused), clock = useRef(0);
  const metrics = useRef<ClassicMetrics>({ frames: [], js: [], physics: [], drawCalls: 0, triangles: 0, geometries: 0, textures: 0 });
  const debug = new URLSearchParams(window.location.search).get('classicDebug') === '1';
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera;
    const old = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, near: cam.near, far: cam.far, background: scene.background, fog: scene.fog };
    scene.background = new Color('#c4d4c9'); scene.fog = null; cam.near = .05; cam.far = 65; cam.updateProjectionMatrix();
    return () => { cam.position.copy(old.p); cam.quaternion.copy(old.q); cam.fov = old.fov; cam.near = old.near; cam.far = old.far; cam.updateProjectionMatrix(); scene.background = old.background; scene.fog = old.fog; };
  }, [camera, scene]);
  useEffect(() => {
    let live = true; onStatus('loading');
    initializePhysics().then(() => {
      if (!live) return;
      const g = new ClassicGame(players); game.current = g;if(onlineRef.current){g.bots=false;network.current=new ClassicOnlineController(onlineRef.current);}
      if (debug) window.__classicBowling = { game: g, metrics: metrics.current, camera: camera as PerspectiveCamera, audio,online:network.current??undefined };
      onSnapshot(network.current?network.current.snapshot(g):g.snapshot()); onStatus('ready');
    }).catch(error => { console.error('Classic Bowling initialization failed', error); if (live) onStatus('error'); });
    return () => { live = false; if (window.__classicBowling?.game === game.current) delete window.__classicBowling; network.current=null;game.current?.dispose(); game.current = null; };
  }, [players, onStatus, onSnapshot, debug, camera, audio]);
  useEffect(() => () => visual.dispose(), [visual]);
  useEffect(() => {
    const input = bindKeyboard(gl.domElement, currentBindings.current); keyboard.current = input; input.setSuspended(stopped.current);
    const quiet = () => sound.stop();
    window.addEventListener('blur', quiet); document.addEventListener('visibilitychange', quiet);
    return () => { input.dispose(); keyboard.current = null; sound.stop(); window.removeEventListener('blur', quiet); document.removeEventListener('visibilitychange', quiet); };
  }, [gl, sound]);
  useLayoutEffect(() => { keyboard.current?.setBindings(bindings); }, [bindings]);
  useLayoutEffect(() => { stopped.current = paused; keyboard.current?.setSuspended(paused); if (paused) sound.stop(); }, [paused, sound]);
  useFrame((_, delta) => {
    const g = game.current; if (!g) return;
    const start = performance.now(), frozen = stopped.current || document.hidden;
    const phase = g.phase;
    const selecting = phase === 'position' || phase === 'direction' || phase === 'power';
    if(network.current){network.current.advance(g,delta,keyboard.current?.readIntent().jump??false,frozen);if(!frozen)sound.update(g);}
    else if (!frozen) {
      const edge = keyboard.current?.readIntent().jump ?? false;
      // A human press locks the sample already on screen, before the next sweep step.
      const lockDisplayed = edge && selecting && g.score.seat === 0 && !g.autoHuman;
      g.advance(lockDisplayed ? 0 : delta, edge); sound.update(g);
    }
    visual.update(g);
    if (!frozen) view.update(camera as PerspectiveCamera, g, Math.min(delta, .1), reducedMotion);
    clock.current += delta;
    if (selecting || phase !== g.phase) {
      // Commit the HUD before this frame paints, alongside the ball and arrow.
      clock.current = 0; flushSync(() => onSnapshot(network.current?network.current.snapshot(g):g.snapshot()));
    } else if (clock.current >= 1 / 30) { clock.current = 0; onSnapshot(network.current?network.current.snapshot(g):g.snapshot()); }
    if (debug && !frozen) {
      const m = metrics.current; m.frames.push(delta * 1000); m.js.push(performance.now() - start);
      if (g.phase === 'rolling') m.physics.push(g.physicsMs);
      m.drawCalls = Math.max(m.drawCalls, gl.info.render.calls); m.triangles = Math.max(m.triangles, gl.info.render.triangles); m.geometries = gl.info.memory.geometries; m.textures = gl.info.memory.textures;
      for (const a of [m.frames, m.js, m.physics]) if (a.length > 12000) a.splice(0, a.length - 12000);
    }
  });
  return <><hemisphereLight args={['#f4e8cf', '#8ba59b', 2.3]} /><directionalLight position={[-3, 7, -1]} color="#f6e1bd" intensity={2} /><primitive object={visual.root} /></>;
}
