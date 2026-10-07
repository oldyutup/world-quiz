import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GAME_MODES,MODE_SELECTIONS,MODE_NAMES,MixedRotation,mixedCycle} from '../../../shared/party-lab/modes';
import {NET} from '../../../shared/party-lab/network/protocol';
const added=['crate_rain','snowball_fight','kart_race','classic_bowling']as const;
test('protocol 13 compact registry exposes twelve unique modes and all four approved names',()=>{
 assert.equal(NET.version,14);assert.equal(GAME_MODES.length,12);assert.equal(new Set(GAME_MODES).size,12);assert.equal(MODE_SELECTIONS.length,14);
 assert.deepEqual(added.map(m=>MODE_NAMES[m]),['Kutu Yağmuru','Kartopu Savaşı','Araba Yarışı','Klasik Bowling']);
});
for(const players of [2,3])test(`Mixed ${players}P: deterministic complete eligible bags, no duplicates or boundary repeat`,()=>{
 const expected=GAME_MODES.filter(m=>m!=='prop_hunt'||players===3);assert.equal(expected.length,players===3?12:11);
 for(const seed0 of [0,1,71,123456]){let seed=seed0;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32),r=new MixedRotation(random);r.setPlayers(players);let last:typeof GAME_MODES[number]|null=null;
 for(let bag=0;bag<200;bag++){const actual=[];for(let i=0;i<expected.length;i++){const mode=r.next;assert.notEqual(mode,last);actual.push(mode);last=mode;r.played();}assert.deepEqual([...actual].sort(),[...expected].sort());for(const mode of added)assert.equal(actual.filter(m=>m===mode).length,1);}
 }
 for(const mode of expected){const bag=mixedCycle(mode,()=>0,players);assert.notEqual(bag[0],mode);assert.deepEqual([...bag].sort(),[...expected].sort());}
});
test('Mixed player-count changes recompute eligibility while retaining the last-mode boundary',()=>{
 const r=new MixedRotation(()=>.73);let last=r.next;r.played();for(const count of [2,3,2,3]){r.setPlayers(count);assert.notEqual(r.next,last);assert.equal(r.remaining.length,count===3?12:11);assert.equal(r.remaining.includes('prop_hunt'),count===3);last=r.next;r.played();}
});
