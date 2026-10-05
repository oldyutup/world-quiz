import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputManager } from '../../input/inputManager';
import { defaultBindings } from '../../input/defaults';
import { changeBinding } from '../../input/bindings';
import { changeRaceBinding, defaultRaceExtras, raceBindings, raceHelp, raceInputBindings, readRaceInput, validRaceExtras } from './controls';

test('Race defaults consume semantic actions; original shared Space remains jump', () => {
  const shared = defaultBindings(), bindings = raceBindings(shared, defaultRaceExtras()), manager = new InputManager(raceInputBindings(bindings));
  manager.setBindingDown('Space', true);
  assert.equal(readRaceInput(manager).drive.handbrake, true);
  assert.deepEqual(shared, defaultBindings());
  const otherMode = new InputManager(shared); otherMode.setBindingDown('Space', true);
  assert.equal(otherMode.readIntent().jump, true);
});
test('handbrake rebind removes old key, updates help, preserves holds and restores default', () => {
  const defaults = raceBindings(defaultBindings(), defaultRaceExtras());
  const rebound = changeRaceBinding(defaults, 'raceHandbrake', 0, 'KeyH')!;
  const manager = new InputManager(raceInputBindings(rebound));
  manager.setBindingDown('Space', true); assert.equal(readRaceInput(manager).drive.handbrake, false);
  manager.setBindingDown('KeyH', true); assert.equal(readRaceInput(manager).drive.handbrake, true);
  assert.equal(readRaceInput(manager).drive.handbrake, true);
  assert.deepEqual(raceHelp(rebound).find(h => h.action === 'raceHandbrake'), { action: 'raceHandbrake', key: 'H', label: 'El freni' });
  manager.setBindings(raceInputBindings(defaults)); manager.setBindingDown('KeyH', true);
  assert.equal(readRaceInput(manager).drive.handbrake, false);
  manager.setBindingDown('Space', true); assert.equal(readRaceInput(manager).drive.handbrake, true);
});
test('shared accelerate and steer bindings, Race camera/reset aliases and edges all work', () => {
  let shared = changeBinding(defaultBindings(), 'moveForward', 0, 'KeyI')!;
  shared = changeBinding(shared, 'moveLeft', 0, 'KeyJ')!;
  const bindings = raceBindings(shared, { raceHandbrake: ['KeyH', 'MouseRight'], raceCamera: ['KeyC', null], raceReset: ['KeyT', null] });
  const manager = new InputManager(raceInputBindings(bindings));
  for (const key of ['KeyW', 'KeyA', 'KeyV', 'KeyR']) manager.setBindingDown(key, true);
  assert.deepEqual(readRaceInput(manager), { drive: { throttle: 0, brake: 0, steer: 0, handbrake: false, reset: false }, camera: false });
  for (const key of ['KeyI', 'KeyJ', 'KeyC', 'KeyT', 'MouseRight']) manager.setBindingDown(key, true);
  assert.deepEqual(readRaceInput(manager), { drive: { throttle: 1, brake: 0, steer: 1, handbrake: true, reset: true }, camera: true });
  assert.equal(readRaceInput(manager).camera, false); assert.equal(readRaceInput(manager).drive.reset, false);
  manager.setSuspended(true); manager.setBindingDown('KeyI', true); assert.equal(readRaceInput(manager).drive.throttle, 0);
  manager.setSuspended(false); manager.setBindingDown('ArrowUp', true); assert.equal(readRaceInput(manager).drive.throttle, 1);
  manager.clear(); assert.equal(readRaceInput(manager).drive.throttle, 0);
});
test('conflicts are Race scoped and pre-existing shared movement profiles stay usable', () => {
  const defaults = raceBindings(defaultBindings(), defaultRaceExtras());
  assert.equal(changeRaceBinding(defaults, 'raceHandbrake', 0, 'KeyW'), null);
  assert.equal(changeRaceBinding(defaults, 'raceHandbrake', 0, null), null);
  assert.ok(changeRaceBinding(defaults, 'raceHandbrake', 0, 'KeyF')); // punch inactive in Race
  const shared = { ...defaultBindings(), moveForward: ['KeyV', 'ArrowUp'] as const };
  const effective = raceBindings(shared, defaultRaceExtras());
  assert.deepEqual(effective.moveForward, shared.moveForward);
  assert.ok(!effective.raceCamera.includes('KeyV'));
  assert.deepEqual(effective.raceReset, defaults.raceReset);
  const manager = new InputManager(raceInputBindings(effective)); manager.setBindingDown('KeyV', true);
  assert.equal(readRaceInput(manager).drive.throttle, 1); assert.equal(readRaceInput(manager).camera, false);
  assert.ok(raceHelp(effective).find(h => h.action === 'raceCamera')?.key);
});
test('invalid stored Race profiles cannot inject shared bindings or remove required actions', () => {
  assert.ok(validRaceExtras(defaultRaceExtras()));
  assert.equal(validRaceExtras({ ...defaultRaceExtras(), raceHandbrake: [null, null] }), false);
  assert.equal(validRaceExtras({ ...defaultRaceExtras(), moveForward: ['KeyQ', null] }), false);
  assert.equal(validRaceExtras({}), false);
});
