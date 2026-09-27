import { BOWLING } from './config.js';
import { BowlingGame, IDLE_INPUT, type BowlingInput } from './game.js';
/** 240 Hz presentation ticks decouple selection/easing from fixed 60 Hz physics.
 * Pausing simply stops advance; no timestep mutation and no dropped sim steps. */
export class BowlingClock {
  accumulator=0;
  presentationAccumulator=0;
  simulationTime=0;
  realTime=0;
  advance(game:BowlingGame, seconds:number, input:BowlingInput=IDLE_INPUT, before?:()=>void, after?:()=>void) {
    const tick=1/240;
    this.presentationAccumulator+=seconds;
    while(this.presentationAccumulator+1e-10>=tick) {
      game.present(tick,input);
      this.accumulator+=tick*game.timeScale;
      this.realTime+=tick;
      while(this.accumulator+1e-10>=BOWLING.step) {
        before?.();game.step(input,0);after?.();
        this.accumulator-=BOWLING.step;this.simulationTime+=BOWLING.step;
      }
      this.presentationAccumulator-=tick;
    }
  }
}
