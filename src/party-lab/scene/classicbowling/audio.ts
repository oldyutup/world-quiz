import type { AudioManager } from '../../audio/AudioManager';
import type { Recipe } from '../../audio/sfx';
import type { ClassicGame, ClassicEvent } from './game';
const recipe = (frequency: number, end: number, duration: number, noise: number, gain: number, notes?: number[]): Recipe => ({ frequency, end, duration, noise, gain, notes, priority: 1, cooldown: .05 });
const sounds: Record<ClassicEvent | 'roll', Recipe> = {
  release: recipe(145, 75, .16, .4, .12),
  pin: recipe(680, 170, .14, .65, .2),
  gutter: recipe(135, 65, .3, .4, .13),
  strike: recipe(440, 620, .8, .01, .19, [1, 1.25, 1.5, 2]),
  spare: recipe(390, 490, .6, .01, .17, [1, 1.25, 1.5]),
  score: recipe(300, 360, .22, .04, .1),
  roll: recipe(72, 67, .27, .42, .045),
};
/** Reuses the existing bounded voice pool. Each original procedural buffer is cached once. */
export function classicAudio(audio: AudioManager) {
  let rollAt = 0, impactAt = -1;
  const keys = Object.keys(sounds).map(k => `classic-bowling-${k}`);
  const play = (name: keyof typeof sounds, gain = 1) => audio.playSpatial(`classic-bowling-${name}`, sounds[name], { x: 0, y: 0, z: 0 }, { refDistance: 100, maxDistance: 100, rolloff: 0, spatial: 0, gain });
  return {
    update(g: ClassicGame) {
      for (const event of g.events) {
        if (event === 'pin' && g.time - impactAt < .065) continue;
        if (event === 'pin') impactAt = g.time;
        play(event);
      }
      if (g.phase === 'rolling' && g.ball && g.time >= rollAt) {
        const v = g.ball.linvel();
        if (g.ball.translation().z < 11.65) play('roll', Math.min(1, Math.hypot(v.x, v.z) / 7));
        rollAt = g.time + .22;
      }
    },
    stop() { for (const key of keys) audio.stopSpatial(key); },
  };
}
