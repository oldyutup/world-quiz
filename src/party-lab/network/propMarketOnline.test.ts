import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import { initializePhysics, IDLE_INPUT } from "../../../shared/party-lab/simulation/physics";
import { PropRoundSimulation, PropRotation } from "../../../shared/party-lab/simulation/propRound";
import { PROP_TICKS } from "../../../shared/party-lab/simulation/prophunt/config";
import { retire } from "../../../shared/party-lab/simulation/layers/game";
import { familyMask, reconstructPropLayout } from "../../../shared/party-lab/simulation/prophunt/wire";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { NET } from "../../../shared/party-lab/network/protocol";
import { DEFAULT_PROP_MAP, validPropSettings, validPropSettingsPatch } from "../../../shared/party-lab/propSettings";
import { MARKET_DEALER } from "../../../shared/party-lab/maps/marketLayout";
import { CAMP_DEALER } from "../../../shared/party-lab/maps/propHuntLayout";
import { ALL_PROP_FAMILY_IDS, MARKET_FAMILY_IDS } from "../../../shared/party-lab/maps/propHuntProps";
import { PROP_MAP_CHOICE_LABEL } from "../../../shared/party-lab/maps/propTypes";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts";
import { PropPrediction } from "./prediction/propRig";

before(() => initializePhysics());
const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const pack = new Packr({ useRecords: false });
/** A round on `choice`, through the introduction into hiding (the rotation and the map's chain advance there). */
function round(rotation: PropRotation, choice: "camp" | "market" | "random", random: () => number = Math.random, counters = newRoomCounters()) {
  const sim = new PropRoundSimulation(counters, rotation);
  sim.mapChoice = choice;
  sim.random = random;
  assert.ok(sim.start([0, 1, 2]));
  sim.round.tick = PROP_TICKS.countdown - 1;
  sim.step(idle);
  assert.equal(sim.phase, "playing");
  return sim;
}

test("protocol 25: the map setting is a lobby field of its own (Orman Kampı / Market / Rastgele, default Rastgele); ammo and proximity unchanged", () => {
  assert.equal(NET.version, 25);
  assert.equal(DEFAULT_PROP_MAP, "random");
  assert.deepEqual(PROP_MAP_CHOICE_LABEL, { camp: "Orman Kampı", market: "Market", random: "Rastgele" });
  for (const map of ["camp", "market", "random"]) assert.ok(validPropSettingsPatch({ map }));
  assert.ok(validPropSettingsPatch({ map: "market", ammo: 10 }));
  for (const invalid of [{ map: "forest" }, { map: 1 }, { map: null }, { map: "market", winner: 1 }]) assert.equal(validPropSettingsPatch(invalid), false);
  // The round's settings (the snapshot's) stay ammo + proximity: the map travels on its own.
  assert.equal(validPropSettings({ ammo: 15, proximity: true, map: "market" }), false);
});

test("a market round online: the snapshot names its map; one snapshot rebuilds the market layout, its family mask and a market disguise", () => {
  const sim = round(new PropRotation(4242), "market");
  assert.equal(sim.game.map.id, "market");
  sim.round.tick = PROP_TICKS.hiding - 1;
  sim.step(idle);
  retire(sim.physics.players[1]);
  sim.game.disguises.wear(1, "cart", { x: 1.3, y: 0.02, z: -1.0 }, 0);
  const snapshot = sim.snapshot([0, 0, 0]);
  snapshot.prediction = sim.prediction(1);
  const wire = snapshot.prop!;
  assert.equal(wire.map, "market");
  assert.equal(wire.index, 0);
  assert.equal(wire.families, (1 << MARKET_FAMILY_IDS.length) - 1, "all twelve in play");
  assert.equal(wire.families, familyMask("market", sim.game.layout.active));
  assert.equal(wire.disguise[1][0], ALL_PROP_FAMILY_IDS.indexOf("cart"));
  assert.equal(reconstructPropLayout(wire).id, sim.game.layout.id);
  assert.equal(sim.game.layout.id, MARKET_DEALER.roundLayout(4242, 0).id);
  // The wire is still plain data (MessagePack round trip).
  assert.deepEqual((pack.unpack(pack.pack(wire)) as typeof wire).map, "market");
  const rig = new PropPrediction(1);
  assert.ok(rig.accept(snapshot));
  assert.equal(rig.game?.map.id, "market");
  assert.equal(rig.game?.layout.id, sim.game.layout.id);
  assert.equal(rig.game?.disguiseOf(1)?.family, "cart");
  assert.throws(() => reconstructPropLayout({ ...wire, map: "forest" as "market" }));
  assert.throws(() => reconstructPropLayout({ ...wire, map: "camp" }), "a market layout is not the camp's");
  rig.dispose();
  sim.dispose();
});

test("Rastgele: each round draws its map; a cancelled introduction keeps the draw; each map's layouts chain on their own; seats keep rotating", () => {
  const rotation = new PropRotation(77),
    counters = newRoomCounters(),
    draws = [0.1, 0.9, 0.2, 0.7, 0.3];
  let k = 0;
  const random = () => draws[k++ % draws.length];
  // A cancelled introduction: the same map and the same layout next time.
  const first = new PropRoundSimulation(counters, rotation);
  first.mapChoice = "random";
  first.random = random;
  assert.ok(first.start([0, 1, 2]));
  const map = first.game.map.id,
    hash = first.game.layout.id;
  first.cancelCountdown();
  assert.ok(first.start([0, 1, 2]));
  assert.equal(first.game.map.id, map);
  assert.equal(first.game.layout.id, hash);
  first.dispose();
  // The draw is spent only when hiding begins: the next round played takes it.
  const played: string[] = [],
    seekers: number[] = [];
  const sims = draws.map(() => {
    const sim = round(rotation, "random", random, counters);
    played.push(sim.game.map.id);
    seekers.push(sim.round.seeker);
    const result = { map: sim.game.map.id, index: sim.game.layoutRound, id: sim.game.layout.id };
    sim.dispose();
    return result;
  });
  assert.deepEqual(played, ["camp", "market", "camp", "market", "camp"]);
  assert.deepEqual(seekers, [0, 1, 2, 0, 1]);
  assert.deepEqual(sims.map((s) => s.index), [0, 0, 1, 1, 2], "each map counts its own rounds");
  let camp = null,
    market = null;
  for (const s of sims) {
    const dealer = s.map === "camp" ? CAMP_DEALER : MARKET_DEALER,
      previous = s.map === "camp" ? camp : market,
      layout = dealer.roundLayout(77, s.index, previous);
    assert.equal(layout.id, s.id);
    if (s.map === "camp") camp = layout;
    else market = layout;
  }
  assert.equal(rotation.chains.camp.index, 2);
  assert.equal(rotation.chains.market.index, 1);
});

test("a chosen map is played every round; the default simulation (no room) stays on the camp", () => {
  const rotation = new PropRotation(9);
  for (let r = 0; r < 3; r++) {
    const sim = round(rotation, "market", mulberry32(r));
    assert.equal(sim.game.map.id, "market");
    sim.dispose();
  }
  const plain = new PropRoundSimulation();
  assert.equal(plain.mapChoice, "camp");
  assert.ok(plain.start([0, 1, 2]));
  assert.equal(plain.game.map.id, "camp");
  plain.dispose();
});
