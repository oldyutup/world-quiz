import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initializePhysics, IDLE_INPUT, PlaygroundPhysics } from "./physics";
import { LocalRoundSimulation } from "./localRound";
import { connect, restore } from "./ragdoll/character";
import type { PlayerId } from "./players";
import type { MovementInput } from "../input/types";
import { BARN_MAP, SPAWN_CANDIDATES, TRAPS, WEAPON_SPOTS } from "../../../shared/party-lab/maps/barn";
import { ROOFTOP_MAP } from "../../../shared/party-lab/maps/rooftop";
import { BARN_COMBAT } from "../../../shared/party-lab/simulation/barn/config";
import { aimDirection, aimEye, shoulderEye } from "../../../shared/party-lab/simulation/barn/hitscan";
import { PickupDirector } from "../../../shared/party-lab/simulation/barn/pickups";
import { falloff, newWeapon, shotDamage, shotDirections, tickWeapon, tryFire, type WeaponKind } from "../../../shared/party-lab/simulation/barn/weapons";
import { SFX } from "../../../shared/party-lab/feedback/sfx";
import { SFX_NAMES } from "../../../shared/party-lab/feedback/events";
import { BarnCombat } from "../../../shared/party-lab/simulation/barn/combat";
import { BARN_CAMERA, aimDirection as cameraAim, cameraRight } from "./arenas/barnCamera";
import { barnIntent } from "./arenas/barnControls";
import { InputManager } from "../input/inputManager";
import { bindLook } from "../input/look";
import { bindKeyboard } from "../input/keyboard";
import { CombatSimulation } from "./combat";

before(() => initializePhysics());

type P = { x: number; y: number; z: number };
const STEP = 1 / 60;
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const angle = (a: P, b: P) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));

/** A barn with combat, past the 3 s countdown. */
function barnRound(seed = 1) {
  const local = new LocalRoundSimulation(seeded(seed), undefined, BARN_MAP, { explore: true, barnCombat: true });
  for (let i = 0; i < 60 * 3.1; i++) local.step(IDLE_INPUT);
  assert.equal(local.round.phase, "playing");
  return local;
}
/** Stand a character on a floor point facing `yaw`; a dummy then holds that spot. */
function place(local: LocalRoundSimulation, id: PlayerId, at: P, yaw: number) {
  const character = local.physics.players[id];
  restore(character, { x: at.x, y: at.y + 1.6, z: at.z }, yaw);
  connect(local.physics.world, character);
  const f = local.barn!.fighters[id];
  f.home = { ...f.home, x: at.x, y: at.y, z: at.z, yaw };
}
const still = (yaw: number): MovementInput => ({ x: 0, z: 0, jump: false, facing: yaw });
function settle(local: LocalRoundSimulation, yaw: number, seconds = 1) {
  for (let i = 0; i < 60 * seconds; i++) local.step(still(yaw));
}
/** Aim straight at a point: the aim line through the shooter's own torso (well inside the eye bound). */
function aimAt(local: LocalRoundSimulation, id: PlayerId, target: P): MovementInput {
  const c = local.physics.players[id],
    p = c.body.translation(),
    t = c.parts.torso.body.translation();
  const dx = target.x - t.x,
    dy = target.y - t.y,
    dz = target.z - t.z,
    d = Math.hypot(dx, dy, dz);
  return { x: 0, z: 0, jump: false, facing: Math.atan2(dx, dz), aimPitch: -Math.asin(dy / d), aimEye: { x: t.x - p.x, y: t.y - p.y, z: t.z - p.z } };
}
const torso = (local: LocalRoundSimulation, id: PlayerId) => ({ ...local.physics.players[id].parts.torso.body.translation() });
/** Shooter (slot 0) and target (dummy slot 1) facing each other on a floor. */
function duel(seed: number, shooter: P, target: P) {
  const local = barnRound(seed);
  const yaw = Math.atan2(target.x - shooter.x, target.z - shooter.z);
  place(local, 0, shooter, yaw);
  place(local, 1, target, yaw + Math.PI);
  place(local, 2, SPAWN_CANDIDATES.S4, SPAWN_CANDIDATES.S4.yaw);
  settle(local, yaw);
  return { local, barn: local.barn!, yaw };
}
function fireOnce(local: LocalRoundSimulation, target: P | (() => P), extra: Partial<MovementInput> = {}) {
  const point = typeof target === "function" ? target() : target;
  local.step({ ...aimAt(local, 0, point), attack: true, ...extra });
  return { shots: [...local.barn!.shots], hits: [...local.barn!.hits], notices: [...local.barn!.notices] };
}
const damageTo = (hits: { target: number; damage: number }[], id: number) => hits.filter((h) => h.target === id).reduce((n, h) => n + h.damage, 0);
/** A clear side to stand beside each weapon spot (no wall, cover, barrel or drop edge). */
const APPROACH: Readonly<Record<string, { x: number; z: number }>> = {
  W1: { x: 0, z: -1 },
  W2: { x: 1, z: 0 },
  W3: { x: 1, z: 0 },
  W4: { x: 0, z: -1 },
  W5: { x: 0, z: -1 },
  W6: { x: 0, z: -1 },
  W7: { x: -1, z: 0 },
};
function near(spot: string, distance: number): P {
  const s = WEAPON_SPOTS[spot as keyof typeof WEAPON_SPOTS],
    d = APPROACH[spot];
  return { x: s.x + d.x * distance, y: s.y, z: s.z + d.z * distance };
}
const EAST_LANE = { shooter: (d: number) => ({ x: 13.5 - d, y: 0, z: -1 }), target: { x: 13.5, y: 0, z: -1 } };

// ─── Weapon rules (pure) ────────────────────────────────────────────────────

test("no reload: the shotgun holds exactly 1 shell, the SMG exactly 10 rounds; empty means nothing fires", () => {
  const shotgun = newWeapon("shotgun");
  assert.equal(shotgun.ammo, 1);
  assert.equal(tryFire(shotgun, true, true), true);
  assert.equal(shotgun.ammo, 0);
  for (let i = 0; i < 120; i++) {
    tickWeapon(shotgun, STEP, true);
    assert.equal(tryFire(shotgun, true, true), false, "no second shell");
  }
  const smg = newWeapon("smg");
  assert.equal(smg.ammo, 10);
  let fired = 0;
  for (let i = 0; i < 600; i++) {
    tickWeapon(smg, STEP, true);
    if (tryFire(smg, i === 0, true)) fired++;
  }
  assert.equal(fired, 10, "exactly 10 rounds, the 11th never fires");
  assert.equal(smg.ammo, 0);
});

test("SMG: ~9.5 rounds/s while held, first round on the press, nothing banked while released", () => {
  const smg = newWeapon("smg"),
    at: number[] = [];
  for (let i = 0; i < 200 && smg.ammo > 0; i++) {
    tickWeapon(smg, STEP, true);
    if (tryFire(smg, i === 0, true)) at.push(i);
  }
  assert.equal(at[0], 0);
  const rate = (at.length - 1) / ((at[at.length - 1] - at[0]) * STEP);
  assert.ok(rate > 9 && rate <= 10, `${rate.toFixed(2)} rounds/s`);
  // Taps: released between presses never fire faster than the interval, and never bank.
  const tap = newWeapon("smg");
  assert.ok(tryFire(tap, true, false));
  tickWeapon(tap, STEP, false);
  assert.equal(tryFire(tap, true, false), false, "inside the interval");
  for (let i = 0; i < 60; i++) tickWeapon(tap, STEP, false);
  assert.equal(tap.cooldown, 0);
});

test("damage: shotgun 15/pellet to 4 m, weak by 12 m, nothing past 14 m; SMG 14/round at normal range", () => {
  assert.equal(shotDamage("shotgun", 0.5), 15);
  assert.equal(shotDamage("shotgun", 4), 15);
  assert.ok(shotDamage("shotgun", 8) < 11 && shotDamage("shotgun", 8) > 5);
  assert.ok(falloff("shotgun", 12) <= 0.2 + 1e-9 && shotDamage("shotgun", 12) <= 3);
  assert.equal(shotDamage("shotgun", 14.01), 0);
  assert.equal(8 * shotDamage("shotgun", 2), 120, "8 pellets × 15 = 120 point blank");
  assert.equal(7 * shotDamage("shotgun", 2), 105, "7 pellets already kill");
  for (const d of [1, 6, 12, 20, 22]) assert.equal(shotDamage("smg", d), 14, `${d} m`);
  assert.equal(7 * 14, 98);
  assert.ok(shotDamage("smg", 30) < 14 && shotDamage("smg", 30) >= 7);
  assert.equal(shotDamage("smg", 41), 0);
});

test("spread: 8 pellets inside the 5.5° cone, never clumped; SMG rounds inside their (growing) cone", () => {
  const aim = aimDirection(0.7, 0.2),
    random = seeded(9);
  for (let n = 0; n < 50; n++) {
    const pellets = shotDirections("shotgun", aim, BARN_COMBAT.shotgun.spread, random);
    assert.equal(pellets.length, 8);
    for (const p of pellets) {
      assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 1) < 1e-9);
      assert.ok(angle(p, aim) <= BARN_COMBAT.shotgun.spread + 1e-9);
    }
    assert.ok(angle(pellets[0], aim) <= BARN_COMBAT.shotgun.spread * 0.15 + 1e-9, "one near the centre");
    assert.ok(pellets.slice(1).every((p) => angle(p, aim) >= BARN_COMBAT.shotgun.spread * 0.55 - 1e-9), "the rest on a ring");
    const [round] = shotDirections("smg", aim, BARN_COMBAT.smg.spread, random);
    assert.ok(angle(round, aim) <= BARN_COMBAT.smg.spread + 1e-9);
  }
  const smg = newWeapon("smg");
  for (let i = 0; i < 10; i++) tryFire(smg, true, true), tickWeapon(smg, 0.2, true);
  assert.ok(BARN_COMBAT.smg.spread + smg.bloom <= BARN_COMBAT.smg.maxSpread + 1e-12, "bloom is capped");
});

test("aim: the simulation's aim line is the chase camera's; a client's eye point is bounded", () => {
  assert.equal(BARN_COMBAT.aim.pivotHeight, BARN_CAMERA.pivotHeight);
  assert.equal(BARN_COMBAT.aim.shoulder, BARN_CAMERA.shoulder);
  for (const yaw of [0, 1, 2.5, -2]) {
    const right = cameraRight(yaw),
      eye = shoulderEye(yaw);
    assert.ok(Math.abs(eye.x - right.x * BARN_CAMERA.shoulder) < 1e-12 && Math.abs(eye.z - right.z * BARN_CAMERA.shoulder) < 1e-12);
    for (const pitch of [-0.4, 0, 0.5]) {
      const a = aimDirection(yaw, pitch),
        b = cameraAim(yaw, pitch);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-12);
    }
  }
  const pelvis = { x: 3, y: 0.78, z: -2 };
  const far = aimEye(pelvis, 0.4, { x: 40, y: 10, z: -30 }),
    base = shoulderEye(0.4);
  const offset = Math.hypot(far.x - pelvis.x - base.x, far.y - pelvis.y - base.y, far.z - pelvis.z - base.z);
  assert.ok(Math.abs(offset - BARN_COMBAT.aim.maxEyeOffset) < 1e-9, `clamped to ${offset.toFixed(3)} m`);
  const bogus = aimEye(pelvis, 0.4, { x: NaN, y: 0, z: 0 });
  assert.ok(Math.abs(bogus.y - pelvis.y - BARN_COMBAT.aim.pivotHeight) < 1e-12, "non-finite input falls back to the shoulder");
});

// ─── Shotgun in the real barn ───────────────────────────────────────────────

test("shotgun: one shot, then it is gone (the next press is a punch); a centred close shot kills from full health", () => {
  for (const seed of [1, 2, 3, 4]) {
    const { local, barn } = duel(seed, EAST_LANE.shooter(2), EAST_LANE.target);
    try {
      barn.fighters[0].weapon = newWeapon("shotgun");
      const shot = fireOnce(local, () => torso(local, 1));
      assert.equal(shot.shots.length, 1);
      assert.equal(shot.shots[0].pellets.length, 8);
      assert.equal(barn.fighters[0].weapon, null, "the shotgun disappears after its only shell");
      assert.ok(shot.notices.some((n) => n.type === "empty" && n.id === 0 && n.kind === "shotgun"));
      assert.equal(damageTo(shot.hits, 1), 120, "all eight pellets at 2 m");
      assert.equal(barn.fighters[1].alive, false);
      assert.equal(barn.fighters[1].hp, 0);
      local.step(still(0));
      local.step({ ...aimAt(local, 0, torso(local, 1)), attack: true });
      assert.equal(barn.shots.length, 0, "no second shot");
      assert.equal(barn.stats.punches, 1, "unarmed again: the attack is a punch");
    } finally {
      local.dispose();
    }
  }
});

test("point blank from the real crosshair line (0.45 m right, head high, looking down): the shot still lands", () => {
  // Found in the browser: pitched fully down (35°) at a dummy ~0.9 m away, the crosshair
  // met it 0.77 m from the shooter's torso; the old rule then fired along the look
  // direction from the torso, a parallel line 0.45 m left and 0.7 m lower, and missed.
  for (const pitch of [BARN_CAMERA.maxPitch]) {
    const { local, barn } = duel(5, EAST_LANE.shooter(0.8), EAST_LANE.target);
    try {
      barn.fighters[0].weapon = newWeapon("shotgun");
      const me = local.physics.players[0].body.translation(),
        target = local.physics.players[1].parts.torso.body.translation();
      let yaw = Math.atan2(target.x - me.x, target.z - me.z);
      for (let i = 0; i < 6; i++) {
        const eye = aimEye(me, yaw);
        yaw = Math.atan2(target.x - eye.x, target.z - eye.z);
      }
      const aim = barn.hitscan.aim(local.physics.players[0], yaw, pitch);
      const onTarget = barn.hitscan.cast(aimEye(me, yaw), aimDirection(yaw, pitch), 5, 0);
      assert.equal(onTarget?.target?.id, 1, "the crosshair is on the target");
      const reach = Math.hypot(aim.point.x - aim.origin.x, aim.point.y - aim.origin.y, aim.point.z - aim.origin.z);
      assert.ok(reach < 1, `pitch ${pitch.toFixed(2)}: met ${reach.toFixed(2)} m from the torso (the case that used to miss)`);
      const toward = { x: (aim.point.x - aim.origin.x) / reach, y: (aim.point.y - aim.origin.y) / reach, z: (aim.point.z - aim.origin.z) / reach };
      assert.ok(angle(aim.direction, toward) < 1e-6, "the shot heads for the crosshair's point, not along the offset look line");
      local.step({ x: 0, z: 0, jump: false, facing: yaw, aimPitch: pitch, attack: true });
      const dealt = damageTo(barn.hits, 1);
      assert.ok(dealt >= 90, `pitch ${pitch.toFixed(2)}: ${dealt} damage`);
    } finally {
      local.dispose();
    }
  }
});

test("shotgun distance: kills up to ~4 m, sometimes at 5 m, never from 6 m; weak by 12 m", () => {
  const kills = (d: number) => {
    let n = 0,
      least = Infinity;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { local, barn } = duel(seed, EAST_LANE.shooter(d), EAST_LANE.target);
      try {
        barn.fighters[0].weapon = newWeapon("shotgun");
        const shot = fireOnce(local, () => torso(local, 1));
        least = Math.min(least, damageTo(shot.hits, 1));
        if (!barn.fighters[1].alive) n++;
      } finally {
        local.dispose();
      }
    }
    return { n, least };
  };
  assert.equal(kills(3).n, 6, "3 m: every centred shot kills");
  assert.ok(kills(4).n >= 5, "4 m: nearly always");
  const five = kills(5).n;
  assert.ok(five >= 1 && five <= 5, `5 m: ${five}/6`);
  assert.equal(kills(6).n, 0, "6 m: never");
  // 12 m down the hub/east wing (clear of the central pile): chip damage only.
  const { local, barn } = duel(3, { x: 2.5, y: 0, z: -1 }, { x: 14.5, y: 0, z: -1 });
  try {
    barn.fighters[0].weapon = newWeapon("shotgun");
    const shot = fireOnce(local, () => torso(local, 1));
    const dealt = damageTo(shot.hits, 1);
    assert.ok(dealt > 0 && dealt <= 24, `12 m: ${dealt}`);
    assert.equal(barn.fighters[1].alive, true);
  } finally {
    local.dispose();
  }
});

test("shotgun: an off-centre shot at 3 m lands only some pellets and does not kill", () => {
  for (const seed of [1, 2, 3]) {
    const { local, barn } = duel(seed, EAST_LANE.shooter(3), EAST_LANE.target);
    try {
      barn.fighters[0].weapon = newWeapon("shotgun");
      const shot = fireOnce(local, () => {
        const t = torso(local, 1);
        return { ...t, z: t.z + 0.62 };
      });
      const hit = shot.hits.find((h) => h.target === 1);
      assert.ok(hit && hit.pellets! < 7 && hit.pellets! >= 1, `${hit?.pellets} pellets`);
      assert.equal(barn.fighters[1].alive, true);
    } finally {
      local.dispose();
    }
  }
});

test("shotgun knockback: a surviving target is shoved ~1–2.5 m, staggers and stays on its feet", () => {
  const { local, barn } = duel(2, EAST_LANE.shooter(2), EAST_LANE.target);
  try {
    barn.fighters[1].hp = 10_000; // survive the full 120 to measure the shove
    barn.fighters[0].weapon = newWeapon("shotgun");
    const before = { ...local.physics.players[1].body.translation() };
    fireOnce(local, () => torso(local, 1));
    assert.ok(barn.fighters[1].stagger.time > 0 && barn.fighters[1].stagger.posture >= 0.6, "stagger never below the measured safe posture");
    let lowest = 1;
    for (let i = 0; i < 150; i++) {
      local.step(still(Math.PI / 2));
      const q = local.physics.players[1].parts.torso.body.rotation();
      lowest = Math.min(lowest, 1 - 2 * (q.x * q.x + q.z * q.z));
    }
    const after = local.physics.players[1].body.translation(),
      shove = Math.hypot(after.x - before.x, after.z - before.z);
    assert.ok(shove > 1 && shove < 2.8, `shoved ${shove.toFixed(2)} m`);
    assert.ok(after.x > before.x, "away from the shooter");
    assert.ok(lowest > 0.6, `lowest uprightness ${lowest.toFixed(2)}`);
    assert.ok(local.physics.isGrounded(1), "back on its feet");
  } finally {
    local.dispose();
  }
});

// ─── SMG in the real barn ───────────────────────────────────────────────────

test("SMG: 7 hits at 6 m leave 2 HP, the 8th kills; rounds 9–10 pass the body; the 11th press cannot fire", () => {
  const { local, barn } = duel(3, EAST_LANE.shooter(6), EAST_LANE.target);
  try {
    barn.fighters[0].weapon = newWeapon("smg");
    const hp: number[] = [];
    for (let round = 1; round <= 11; round++) {
      const shot = fireOnce(local, () => torso(local, 1));
      if (round <= 10) assert.equal(shot.shots.length, 1, `round ${round} fires`);
      else assert.equal(shot.shots.length, 0, "round 11 cannot fire");
      if (round <= 8) {
        assert.equal(damageTo(shot.hits, 1), 14, `round ${round}: one 14 HP hit`);
        hp.push(barn.fighters[1].hp);
      }
      if (round === 9 || round === 10) assert.ok(shot.shots[0].pellets.every((p) => p.target === null), "dead bodies are not hit");
      if (round === 10) {
        assert.equal(barn.fighters[0].weapon, null, "the SMG disappears after its 10th round");
        assert.ok(shot.notices.some((n) => n.type === "empty" && n.kind === "smg"));
      }
      for (let i = 0; i < 20; i++) local.step(aimAt(local, 0, torso(local, 1)));
    }
    assert.deepEqual(hp, [86, 72, 58, 44, 30, 16, 2, 0]);
    assert.equal(barn.fighters[1].deaths, 1);
  } finally {
    local.dispose();
  }
});

test("SMG held: all 10 rounds in ~1 s of automatic fire, small knockback, the target never topples", () => {
  const { local, barn } = duel(5, EAST_LANE.shooter(6), EAST_LANE.target);
  try {
    barn.fighters[1].hp = 10_000;
    barn.fighters[0].weapon = newWeapon("smg");
    const before = { ...local.physics.players[1].body.translation() };
    const at: number[] = [];
    let hits = 0,
      lowest = 1;
    for (let i = 0; i < 90; i++) {
      local.step({ ...aimAt(local, 0, torso(local, 1)), attack: i === 0, attackHeld: true });
      if (barn.shots.length) at.push(i);
      hits += barn.hits.filter((h) => h.target === 1).length;
      const q = local.physics.players[1].parts.torso.body.rotation();
      lowest = Math.min(lowest, 1 - 2 * (q.x * q.x + q.z * q.z));
    }
    assert.equal(at.length, 10);
    assert.ok((at[9] - at[0]) * STEP > 0.85 && (at[9] - at[0]) * STEP < 1.05, `${((at[9] - at[0]) * STEP).toFixed(2)} s`);
    assert.equal(barn.fighters[0].weapon, null);
    assert.ok(hits >= 9, `${hits}/10 held-fire hits at 6 m`);
    const after = local.physics.players[1].body.translation();
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.6, "a wobble, not a shove");
    assert.ok(lowest > 0.8, `lowest uprightness ${lowest.toFixed(2)}`);
  } finally {
    local.dispose();
  }
});

// ─── Cover, walls, upper floor ──────────────────────────────────────────────

test("cover and walls stop every pellet and round: crates, the barn's walls, a rail", () => {
  const cases: [string, P, P][] = [
    ["north mouth crates", { x: -1.57, y: 0, z: -5.5 }, { x: -1.57, y: 0, z: -10 }],
    ["wall between the south and west wings", { x: -3.5, y: 0, z: 8 }, { x: -8, y: 0, z: 1.5 }],
  ];
  for (const [label, shooter, target] of cases)
    for (const kind of ["shotgun", "smg"] as WeaponKind[]) {
      const { local, barn } = duel(4, shooter, target);
      try {
        barn.fighters[0].weapon = newWeapon(kind);
        const shot = fireOnce(local, () => torso(local, 1));
        assert.equal(shot.shots.length, 1);
        assert.ok(shot.shots[0].pellets.every((p) => p.blocked && p.target === null), `${label} (${kind}) blocks`);
        assert.equal(barn.fighters[1].hp, 100, `${label} (${kind}): no damage`);
      } finally {
        local.dispose();
      }
    }
  // Upper floor, standing a metre back from the void's north rail: the rail takes the shot.
  const { local, barn } = duel(4, { x: 0, y: 3, z: -5 }, { x: -2.5, y: 0, z: 2.5 });
  try {
    barn.fighters[0].weapon = newWeapon("smg");
    const shot = fireOnce(local, () => torso(local, 1));
    assert.ok(shot.shots[0].pellets[0].blocked && Math.abs(shot.shots[0].pellets[0].end.z + 4.05) < 0.1, "stopped by the rail");
    assert.equal(barn.fighters[1].hp, 100);
  } finally {
    local.dispose();
  }
});

test("upper floor ↔ ground floor: shots go both ways past an open drop edge", () => {
  const upper = { x: 2.8, y: 3, z: -4.6 },
    ground = { x: 2.5, y: 0, z: 1.5 };
  for (const [shooter, target] of [
    [upper, ground],
    [ground, upper],
  ]) {
    const { local, barn } = duel(6, shooter, target);
    try {
      barn.fighters[0].weapon = newWeapon("smg");
      const input = aimAt(local, 0, torso(local, 1));
      assert.ok(Math.abs(input.aimPitch!) < -BARN_CAMERA.minPitch + 0.05, "within the camera's pitch range");
      const shot = fireOnce(local, () => torso(local, 1));
      assert.equal(damageTo(shot.hits, 1), 14, `${shooter.y > 0 ? "down" : "up"} through the drop edge`);
    } finally {
      local.dispose();
    }
  }
});

// ─── Punch ──────────────────────────────────────────────────────────────────

test("unarmed attack is a physical punch: 12 HP per landed hit, 0.5 s apart, no knockout collapse", () => {
  const { local, barn } = duel(2, { x: 12.7, y: 0, z: -1 }, EAST_LANE.target);
  try {
    let landed = 0,
      presses = 0,
      lowest = 1;
    for (let i = 0; i < 60 * 6; i++) {
      const a = local.physics.players[0].body.translation(),
        b = local.physics.players[1].body.translation(),
        d = Math.hypot(b.x - a.x, b.z - a.z);
      // Walk back into reach after each shove; press every 0.5 s.
      const move = d > 0.95 ? { x: (b.x - a.x) / d, z: (b.z - a.z) / d } : { x: 0, z: 0 };
      const press = i % 30 === 0;
      if (press) presses++;
      local.step({ ...move, jump: false, facing: Math.atan2(b.x - a.x, b.z - a.z), attack: press });
      for (const h of barn.hits) {
        assert.equal(h.source, "punch");
        assert.equal(h.damage, BARN_COMBAT.punch.damage);
        landed++;
      }
      assert.equal(barn.shots.length, 0, "no weapon, no shots");
      if (barn.fighters[1].alive) {
        const q = local.physics.players[1].parts.torso.body.rotation();
        lowest = Math.min(lowest, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
    }
    assert.equal(barn.stats.punches, presses, "every press on cooldown starts a punch");
    assert.ok(landed >= 6, `${landed}/${presses} punches landed`);
    assert.equal(barn.fighters[1].hp, Math.max(0, 100 - 12 * landed));
    assert.ok(lowest > 0.6, `punched dummy stays up (${lowest.toFixed(2)})`);
  } finally {
    local.dispose();
  }
});

test("punches alone can kill: 9 landed punches (12 HP each) take a full-health player down", () => {
  const { local, barn } = duel(3, { x: 12.7, y: 0, z: -1 }, EAST_LANE.target);
  try {
    for (let i = 0; i < 60 * 15 && barn.fighters[1].alive; i++) {
      const a = local.physics.players[0].body.translation(),
        b = local.physics.players[1].body.translation(),
        d = Math.hypot(b.x - a.x, b.z - a.z);
      const move = d > 0.95 ? { x: (b.x - a.x) / d, z: (b.z - a.z) / d } : { x: 0, z: 0 };
      local.step({ ...move, jump: false, facing: Math.atan2(b.x - a.x, b.z - a.z), attack: i % 30 === 0 });
    }
    assert.equal(barn.fighters[1].alive, false);
    assert.equal(barn.stats.punchHits, 9);
  } finally {
    local.dispose();
  }
});

test("armed: the same attack fires instead of punching", () => {
  const { local, barn } = duel(2, { x: 12.5, y: 0, z: -1 }, EAST_LANE.target);
  try {
    barn.fighters[0].weapon = newWeapon("smg");
    const shot = fireOnce(local, () => torso(local, 1));
    assert.equal(shot.shots.length, 1);
    assert.equal(barn.stats.punches, 0);
    assert.equal(barn.fighters[0].punch.age, -1);
  } finally {
    local.dispose();
  }
});

// ─── Bear traps ─────────────────────────────────────────────────────────────

function crossTrap(local: LocalRoundSimulation, sprint = false, seconds = 2.5) {
  const t = TRAPS.T1,
    barn = local.barn!;
  place(local, 0, { x: t.x - 3, y: 0, z: t.z }, Math.PI / 2);
  settle(local, Math.PI / 2, 0.5);
  const log = { snapStep: -1, x: [] as number[], jumped: false, held: 0, lowest: 1, groundedAtRelease: false };
  for (let i = 0; i < 60 * seconds; i++) {
    const heldBefore = barn.fighters[0].trapped > 0;
    local.step({ x: 1, z: 0, jump: heldBefore, facing: Math.PI / 2, sprint });
    if (barn.notices.some((n) => n.type === "trap" && n.id === 0)) log.snapStep = i;
    if (barn.fighters[0].trapped > 0) {
      log.held++;
      log.x.push(local.physics.players[0].body.translation().x);
      if (local.physics.players[0].body.linvel().y > 2) log.jumped = true;
      const q = local.physics.players[0].parts.torso.body.rotation();
      log.lowest = Math.min(log.lowest, 1 - 2 * (q.x * q.x + q.z * q.z));
      // (Jump is still pressed on the step the hold ends, so check while held.)
      log.groundedAtRelease = local.physics.isGrounded(0);
    }
  }
  return log;
}

test("bear trap: 25 damage, ~1.1 s held in place (no walking or jumping), still upright; rearms after 10 s", () => {
  for (const sprint of [false, true]) {
    const local = barnRound(7);
    try {
      const barn = local.barn!;
      const log = crossTrap(local, sprint);
      assert.ok(log.snapStep >= 0, "sprung");
      assert.equal(barn.fighters[0].hp, 75);
      assert.ok(Math.abs(log.held * STEP - BARN_COMBAT.trap.hold) < 0.05, `held ${(log.held * STEP).toFixed(2)} s`);
      assert.ok(Math.max(...log.x) - Math.min(...log.x) < 0.5, `slid ${(Math.max(...log.x) - Math.min(...log.x)).toFixed(2)} m while held`);
      assert.equal(log.jumped, false, "jump is disabled in the trap");
      assert.ok(log.lowest > 0.6, `no ragdoll collapse (${log.lowest.toFixed(2)})`);
      assert.ok(log.groundedAtRelease, "on its feet when released");
      const trap = barn.traps.find((t) => t.id === "T1")!;
      assert.equal(trap.armed, false);
      settle(local, Math.PI / 2, BARN_COMBAT.trap.rearm - 2.2);
      assert.equal(trap.armed, false, "still sprung before 10 s");
      settle(local, Math.PI / 2, 0.5);
      assert.equal(trap.armed, true, "rearmed");
    } finally {
      local.dispose();
    }
  }
});

test("bear trap: aiming and attacking still work while held", () => {
  const local = barnRound(7);
  try {
    const barn = local.barn!;
    const t = TRAPS.T1;
    place(local, 0, { x: t.x - 3, y: 0, z: t.z }, Math.PI / 2);
    settle(local, Math.PI / 2, 0.5);
    for (let i = 0; i < 120 && barn.fighters[0].trapped <= 0; i++) local.step({ x: 1, z: 0, jump: false, facing: Math.PI / 2 });
    assert.ok(barn.fighters[0].trapped > 0);
    barn.fighters[0].weapon = newWeapon("smg");
    const before = local.physics.players[0].facing;
    for (let i = 0; i < 20; i++) local.step({ x: 0, z: 0, jump: false, facing: 0 });
    assert.ok(Math.abs(local.physics.players[0].facing - before) > 0.5, "the body turns to the aim");
    local.step({ x: 0, z: 0, jump: false, facing: 0, attack: true, aimPitch: 0 });
    assert.equal(barn.shots.length, 1, "fires from the trap");
  } finally {
    local.dispose();
  }
});

test("spawn protection: a protected player walks over an armed trap and takes no damage", () => {
  const local = barnRound(7);
  try {
    const barn = local.barn!;
    barn.fighters[0].protection = 10;
    const log = crossTrap(local, false, 1.5);
    assert.equal(log.snapStep, -1);
    assert.equal(barn.fighters[0].hp, 100);
    assert.equal(barn.traps.find((t) => t.id === "T1")!.armed, true);
  } finally {
    local.dispose();
  }
});

// ─── Death and respawn ──────────────────────────────────────────────────────

test("death: HP ≤ 0 drops the weapon out of existence and goes full ragdoll; the body is not a target; respawn ~2 s later at full health, unarmed and protected", () => {
  const { local, barn } = duel(8, EAST_LANE.shooter(5), EAST_LANE.target);
  try {
    barn.fighters[0].weapon = newWeapon("smg");
    barn.fighters[1].weapon = newWeapon("shotgun");
    barn.fighters[1].hp = 10;
    const shot = fireOnce(local, () => torso(local, 1));
    assert.ok(shot.hits.some((h) => h.target === 1 && h.killed));
    const dead = barn.fighters[1];
    assert.equal(dead.alive, false);
    assert.equal(dead.weapon, null, "held weapon removed immediately");
    assert.equal(barn.drives[1].posture, 0, "full ragdoll");
    assert.ok(shot.notices.some((n) => n.type === "death" && n.id === 1 && n.by === 0));
    // Dead: no attack, no pickup, not hittable.
    let stepsDead = 1;
    for (let i = 0; i < 20; i++, stepsDead++) {
      local.step({ ...aimAt(local, 0, torso(local, 1)), attackHeld: true });
      for (const s of barn.shots) assert.ok(s.pellets.every((p) => p.target !== 1));
    }
    assert.ok(local.physics.players[1].parts.torso.body.isEnabled(), "the body stays in the world");
    while (!dead.alive && stepsDead < 60 * 3) {
      local.step(still(Math.PI / 2));
      stepsDead++;
    }
    assert.ok(Math.abs(stepsDead * STEP - BARN_COMBAT.death.respawn) < 0.05, `respawned after ${(stepsDead * STEP).toFixed(2)} s`);
    assert.equal(dead.hp, 100);
    assert.equal(dead.weapon, null);
    assert.ok(dead.protection > 0.95);
    const spawn = SPAWN_CANDIDATES[dead.home.id];
    const b = local.physics.players[1].body.translation();
    assert.ok(Math.hypot(b.x - spawn.x, b.z - spawn.z) < 0.2, `standing on ${dead.home.id}`);
    const shooter = local.physics.players[0].body.translation();
    assert.ok(Math.hypot(shooter.x - spawn.x, shooter.z - spawn.z) >= BARN_COMBAT.respawn.clearance, "away from the living");
    assert.equal(barn.drives[1].posture, 1, "a normal standing ragdoll again");
  } finally {
    local.dispose();
  }
});

test("respawn protection blocks damage for ~1 s, and ends early when the player attacks", () => {
  const { local, barn } = duel(8, EAST_LANE.shooter(3), EAST_LANE.target);
  try {
    barn.fighters[1].protection = BARN_COMBAT.death.protection;
    barn.fighters[0].weapon = newWeapon("smg");
    const shot = fireOnce(local, () => torso(local, 1));
    assert.ok(shot.shots[0].pellets[0].target === 1, "the round still stops at the body");
    assert.equal(barn.fighters[1].hp, 100, "no damage while protected");
    settle(local, Math.PI / 2, 1.1);
    fireOnce(local, () => torso(local, 1));
    assert.equal(barn.fighters[1].hp, 86, "protection over");
    barn.fighters[0].protection = 1;
    barn.fighters[0].weapon = null;
    local.step({ ...still(Math.PI / 2), attack: true });
    assert.equal(barn.fighters[0].protection, 0, "attacking ends protection");
  } finally {
    local.dispose();
  }
});

test("a dead player cannot attack, pick up or trigger traps", () => {
  const physics = new PlaygroundPhysics(undefined, BARN_MAP);
  try {
    const barn = new BarnCombat(physics, undefined, seeded(9));
    const inputs: MovementInput[] = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
    const step = () => {
      const out = barn.step(inputs, STEP);
      physics.step(out.inputs, out.drives);
      barn.afterStep();
    };
    // A known pickup with room for the shooter 3 m north of it (the random initial layout
    // depends on the spawn positions, and a hayloft spot would put the shooter outside the wall).
    barn.pickups.active.splice(0, barn.pickups.active.length, { spot: "W4", kind: "smg" });
    const spot = "W4",
      at = near(spot, 0.5);
    restore(physics.players[0], { x: at.x, y: at.y + 1.6, z: at.z }, 0);
    connect(physics.world, physics.players[0]);
    for (let i = 0; i < 60; i++) step();
    // Slot 1 shoots slot 0 (1 HP) from 3 m.
    const shooterAt = { x: at.x, y: at.y, z: at.z - 3 };
    restore(physics.players[1], { x: shooterAt.x, y: shooterAt.y + 1.6, z: shooterAt.z }, 0);
    connect(physics.world, physics.players[1]);
    for (let i = 0; i < 60; i++) step();
    barn.fighters[0].hp = 1;
    barn.fighters[1].weapon = newWeapon("smg");
    const t = physics.players[1].parts.torso.body.translation(),
      target = physics.players[0].parts.torso.body.translation(),
      p1 = physics.players[1].body.translation();
    const d = Math.hypot(target.x - t.x, target.y - t.y, target.z - t.z);
    inputs[1] = { x: 0, z: 0, jump: false, attack: true, facing: Math.atan2(target.x - t.x, target.z - t.z), aimPitch: -Math.asin((target.y - t.y) / d), aimEye: { x: t.x - p1.x, y: t.y - p1.y, z: t.z - p1.z } };
    step();
    inputs[1] = IDLE_INPUT;
    const me = barn.fighters[0];
    assert.equal(me.alive, false);
    // An armed trap right under the body.
    const trap = barn.traps[0] as { x: number; y: number; z: number; armed: boolean };
    const body = physics.players[0].body.translation();
    Object.assign(trap, { x: body.x, y: at.y, z: body.z, armed: true });
    const pickupsBefore = barn.pickups.active.length;
    inputs[0] = { ...IDLE_INPUT, attack: true, attackHeld: true, pickup: true };
    for (let i = 0; i < 60; i++) {
      step();
      assert.equal(barn.shots.length, 0);
      assert.equal(barn.notices.filter((n) => n.type === "pickup" || n.type === "trap").length, 0);
    }
    assert.equal(barn.stats.punches, 0);
    assert.equal(me.weapon, null);
    assert.equal(barn.pickups.active.length, pickupsBefore);
    assert.equal(trap.armed, true);
  } finally {
    physics.dispose();
  }
});

// ─── Pickups ────────────────────────────────────────────────────────────────

test("pickup: E within ~1.1 m equips at once; out of reach does nothing; armed swaps and the old weapon is destroyed", () => {
  const local = barnRound(11);
  try {
    const barn = local.barn!,
      me = barn.fighters[0];
    assert.equal(barn.pickups.active.length, BARN_COMBAT.pickups.active);
    const first = barn.pickups.active[0];
    place(local, 0, near(first.spot, 1.6), -Math.PI / 2);
    settle(local, -Math.PI / 2, 0.5);
    local.step({ ...still(-Math.PI / 2), pickup: true });
    assert.equal(me.weapon, null, "1.6 m: out of reach");
    place(local, 0, near(first.spot, 0.8), -Math.PI / 2);
    settle(local, -Math.PI / 2, 0.5);
    local.step({ ...still(-Math.PI / 2), pickup: true });
    const equipped = barn.fighters[0].weapon;
    assert.equal(equipped?.kind, first.kind, "0.8 m: equipped");
    assert.equal(equipped?.ammo, BARN_COMBAT[first.kind].ammo);
    assert.ok(!barn.pickups.active.some((p) => p.spot === first.spot), "the spot is empty");
    // Swap at another spot: the held weapon is replaced, nothing is dropped.
    const second = barn.pickups.active[0];
    const activeBefore = barn.pickups.active.length;
    place(local, 0, near(second.spot, 0.8), -Math.PI / 2);
    settle(local, -Math.PI / 2, 0.5);
    local.step({ ...still(-Math.PI / 2), pickup: true });
    assert.equal(barn.fighters[0].weapon?.kind, second.kind);
    assert.ok(barn.notices.some((n) => n.type === "pickup" && n.replaced === first.kind));
    assert.equal(barn.pickups.active.length, activeBefore - 1, "the old weapon did not become a pickup");
  } finally {
    local.dispose();
  }
});

test("replacement: 4 s after a pickup, a weapon appears at another spot (telegraphed ~0.8 s), clear of living players", () => {
  const local = barnRound(12);
  try {
    const barn = local.barn!;
    const taken = barn.pickups.active[0];
    place(local, 0, near(taken.spot, 0.8), -Math.PI / 2);
    settle(local, -Math.PI / 2, 0.3);
    local.step({ ...still(-Math.PI / 2), pickup: true });
    const t0 = barn.pickups.time;
    let telegraphAt = -1,
      appeared: { spot: string; at: number } | null = null;
    for (let i = 0; i < 60 * 5 && !appeared; i++) {
      local.step(still(-Math.PI / 2));
      const p = barn.pickups.pending[0];
      if (telegraphAt < 0 && p?.spot) telegraphAt = barn.pickups.time - t0;
      const n = barn.notices.find((x) => x.type === "appear");
      if (n && n.type === "appear") appeared = { spot: n.spot, at: barn.pickups.time - t0 };
    }
    assert.ok(appeared, "a replacement appeared");
    assert.ok(Math.abs(appeared!.at - BARN_COMBAT.pickups.replace) < 0.05, `after ${appeared!.at.toFixed(2)} s`);
    assert.ok(Math.abs(appeared!.at - telegraphAt - BARN_COMBAT.pickups.telegraph) < 0.05, "telegraphed first");
    assert.notEqual(appeared!.spot, taken.spot, "never the spot just emptied");
    assert.equal(barn.pickups.active.length, BARN_COMBAT.pickups.active);
    const s = WEAPON_SPOTS[appeared!.spot as keyof typeof WEAPON_SPOTS];
    for (const c of local.physics.players) {
      const b = c.body.translation();
      assert.ok(Math.hypot(b.x - s.x, (b.y - 0.78 - s.y) * 1.5, b.z - s.z) >= BARN_COMBAT.pickups.clearance, "not next to anyone");
    }
    assert.equal(new Set(barn.pickups.active.map((p) => p.spot)).size, barn.pickups.active.length, "one weapon per spot");
  } finally {
    local.dispose();
  }
});

test("pickup director: always 3 weapons on distinct spots, both kinds present, no immediate reuse, no two-spot ping-pong", () => {
  const spots = Object.entries(WEAPON_SPOTS).map(([id, p]) => ({ id, ...p }));
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = seeded(seed),
      director = new PickupDirector(spots, random);
    const players = [{ x: 0.5, y: 0.78, z: 13 }];
    director.reset(players);
    const history: string[] = [];
    for (let cycle = 0; cycle < 60; cycle++) {
      assert.equal(director.active.length, 3);
      assert.equal(new Set(director.active.map((a) => a.spot)).size, 3);
      assert.ok(new Set(director.active.map((a) => a.kind)).size === 2, "never all the same kind");
      // A player walks to one weapon and takes it.
      const target = director.active[Math.floor(random() * 3)],
        at = director.spot(target.spot);
      players[0] = { x: at.x, y: at.y + 0.78, z: at.z };
      director.take(target);
      history.push(target.spot);
      let appeared: string | null = null;
      for (let t = 0; t < 60 * 5 && !appeared; t++) appeared = director.tick(STEP, players)[0]?.spot ?? null;
      assert.ok(appeared && appeared !== target.spot);
    }
    // Alternating between two spots (A B A B …) never lasts.
    let pingPong = 0;
    for (let i = 3; i < history.length; i++)
      if (history[i] === history[i - 2] && history[i - 1] === history[i - 3] && history[i] !== history[i - 1]) pingPong++;
    assert.ok(pingPong <= 2, `seed ${seed}: ${pingPong} ping-pong steps`);
  }
});

test("initial weapons are spread over the barn: three spots at least 9 m apart, both kinds", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const local = barnRound(seed);
    try {
      const active = local.barn!.pickups.active,
        at = active.map((p) => WEAPON_SPOTS[p.spot as keyof typeof WEAPON_SPOTS]);
      assert.equal(active.length, 3);
      assert.equal(new Set(active.map((p) => p.kind)).size, 2);
      for (let i = 0; i < at.length; i++)
        for (let j = i + 1; j < at.length; j++) assert.ok(Math.hypot(at[i].x - at[j].x, at[i].z - at[j].z) >= 9, `seed ${seed}`);
    } finally {
      local.dispose();
    }
  }
});

// ─── Input, audio and rooftop isolation ─────────────────────────────────────

test("barn intent: F / left click is the attack (held for automatic fire), E / right click picks up, Shift sprints; no grab or lift reaches the barn", () => {
  const input = new InputManager();
  input.setBindingDown("MouseLeft", true);
  input.setBindingDown("KeyE", true);
  input.setBindingDown("ShiftLeft", true);
  const held = input.isActionDown("punch"),
    pickup = input.wasActionPressed("grab");
  const intent = barnIntent(input.readIntent(), 0.3, { attackHeld: held, pickup, aimPitch: 0.2 });
  assert.equal(intent.attack, true);
  assert.equal(intent.attackHeld, true);
  assert.equal(intent.pickup, true);
  assert.equal(intent.sprint, true);
  assert.equal(intent.aimPitch, 0.2);
  for (const key of ["punch", "grab", "lift", "left", "right", "punchLeft", "punchRight"] as const) assert.equal(intent[key], undefined, key);
  // Next step: still held (automatic fire) but no new press and no new pickup.
  const next = barnIntent(input.readIntent(), 0.3, { attackHeld: input.isActionDown("punch"), pickup: input.wasActionPressed("grab") });
  assert.equal(next.attack, false);
  assert.equal(next.attackHeld, true);
  assert.equal(next.pickup, false);
});

function fakeDom(run: (env: { win: EventTarget; doc: EventTarget & { pointerLockElement: unknown }; viewport: HTMLElement; canvas: HTMLElement }) => void) {
  const win = new EventTarget(),
    doc = Object.assign(new EventTarget(), {
      pointerLockElement: null as unknown,
      activeElement: null,
      exitPointerLock() {
        doc.pointerLockElement = null;
        doc.dispatchEvent(new Event("pointerlockchange"));
      },
    });
  class Element extends EventTarget {
    closest(selector: string) {
      return selector === "[tabindex]" ? viewport : null;
    }
    focus() {}
    requestPointerLock() {
      // Grant synchronously (the harsher order: the lock exists before the key adapter sees the click).
      doc.pointerLockElement = this;
      doc.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    }
  }
  const viewport = new Element() as unknown as HTMLElement,
    canvas = new Element() as unknown as HTMLElement;
  const keys = ["window", "document", "HTMLElement"] as const;
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    window: { value: win, configurable: true },
    document: { value: doc, configurable: true },
    HTMLElement: { value: Element, configurable: true },
  });
  try {
    run({ win, doc, viewport, canvas });
  } finally {
    keys.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}
const mouse = (type: string, button = 0) => Object.assign(new Event(type, { cancelable: true }), { button, buttons: button === 0 ? 1 : 2 });

test("the click that takes Pointer Lock never punches or fires; locked clicks (delivered to the lock element) do", () =>
  fakeDom(({ viewport, canvas, win }) => {
    for (const lookFirst of [true, false]) {
      let look: ReturnType<typeof bindLook> | null = null;
      const bind = () => (look = bindLook(viewport, "lock", () => {}));
      if (lookFirst) bind();
      const keys = bindKeyboard(canvas, undefined, { mouseSurface: viewport, claimMouse: (e) => look?.claimsClick(e) ?? false });
      if (!lookFirst) bind();
      viewport.dispatchEvent(mouse("mousedown"));
      win.dispatchEvent(mouse("mouseup"));
      assert.equal(keys.readIntent().punch, false, `acquiring click is not an attack (look bound ${lookFirst ? "first" : "second"})`);
      assert.equal((document as unknown as { pointerLockElement: unknown }).pointerLockElement, viewport);
      viewport.dispatchEvent(mouse("mousedown"));
      assert.equal(keys.manager.isActionDown("punch"), true, "locked: held for automatic fire");
      assert.equal(keys.readIntent().punch, true, "locked: attack");
      win.dispatchEvent(mouse("mouseup"));
      viewport.dispatchEvent(mouse("mousedown", 2));
      assert.equal(keys.manager.wasActionPressed("grab"), true, "locked right click: pick up");
      win.dispatchEvent(mouse("mouseup", 2));
      keys.readIntent();
      keys.dispose();
      look!.dispose();
      (document as unknown as { pointerLockElement: unknown }).pointerLockElement = null;
    }
    // Drag mode: the left button looks, F still attacks.
    const look = bindLook(viewport, "drag", () => {});
    const keys = bindKeyboard(canvas, undefined, { mouseSurface: viewport, claimMouse: (e) => look.claimsClick(e) });
    viewport.dispatchEvent(mouse("mousedown"));
    assert.equal(keys.readIntent().punch, false, "drag button is look input");
    win.dispatchEvent(mouse("mouseup"));
    keys.dispose();
    look.dispose();
  }));

test("barn sound cues exist and are short; the rooftop never emits them", () => {
  const barnCues = ["weaponPickup", "shotgunFire", "smgFire", "bulletHit", "weaponEmpty", "trapSnap", "death", "respawn"] as const;
  for (const name of barnCues) {
    assert.ok(SFX_NAMES.includes(name));
    assert.ok(SFX[name].duration <= 0.6);
  }
  const heard = new Set<string>();
  const local = new LocalRoundSimulation(seeded(1), (e) => heard.add(e.name), ROOFTOP_MAP);
  try {
    assert.equal(local.barn, null);
    for (let i = 0; i < 60 * 20; i++) local.step({ x: Math.sin(i / 50), z: Math.cos(i / 70), jump: i % 90 === 0, punch: i % 40 === 0, grab: i % 200 > 150, lift: i % 200 > 170, attack: true, attackHeld: true, pickup: true });
    for (const name of barnCues) assert.ok(!heard.has(name), name);
  } finally {
    local.dispose();
  }
});

test("rooftop isolation: barn intent fields change nothing on the rooftop (identical simulation with and without them)", () => {
  const run = (withBarnFields: boolean) => {
    const local = new LocalRoundSimulation(seeded(5), undefined, ROOFTOP_MAP);
    const trace: number[] = [];
    try {
      for (let i = 0; i < 60 * 12; i++) {
        const base: MovementInput = { x: Math.sin(i / 40), z: -Math.cos(i / 55), jump: i % 70 === 0, punch: i % 35 === 0, grab: i % 240 > 180, lift: i % 240 > 200 };
        local.step(withBarnFields ? { ...base, attack: true, attackHeld: true, pickup: true, aimPitch: 0.3, aimEye: { x: 5, y: 5, z: 5 } } : base);
        if (i % 30 === 0) for (const c of local.physics.players) trace.push(c.body.translation().x, c.body.translation().y, c.body.translation().z);
      }
      return { trace, stats: { ...local.combat.stats } };
    } finally {
      local.dispose();
    }
  };
  const a = run(false),
    b = run(true);
  assert.deepEqual(b.trace, a.trace);
  assert.deepEqual(b.stats, a.stats);
  assert.ok(a.stats.punches > 0, "rooftop punches still work");
  // The rooftop combat class and physics are untouched by barn combat.
  const p = new PlaygroundPhysics(undefined, ROOFTOP_MAP);
  try {
    assert.doesNotThrow(() => new CombatSimulation(p));
  } finally {
    p.dispose();
  }
});

// ─── Idle anchor and S3 (online Barn prerequisites) ─────────────────────────

test("idle anchor: standing still drifts < 0.15 m in 30 s (armed and unarmed, ground and upper floor); moving is unchanged", () => {
  for (const armed of [false, true])
    for (const at of [SPAWN_CANDIDATES.S1, SPAWN_CANDIDATES.S3, SPAWN_CANDIDATES.S6]) {
      const local = barnRound(3);
      place(local, 0, at, at.yaw);
      if (armed) local.barn!.fighters[0].weapon = newWeapon("smg");
      settle(local, at.yaw, 1.5);
      const a = { ...local.physics.players[0].body.translation() };
      let lowest = 1;
      for (let i = 0; i < 60 * 30; i++) {
        local.step(still(at.yaw));
        const q = local.physics.players[0].parts.torso.body.rotation();
        lowest = Math.min(lowest, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
      const b = local.physics.players[0].body.translation();
      const drift = Math.hypot(b.x - a.x, b.z - a.z);
      assert.ok(drift < 0.15, `${armed ? "armed" : "unarmed"} at ${at.x},${at.z}: ${drift.toFixed(3)} m in 30 s (was 0.85–2.2 m)`);
      assert.ok(lowest > 0.85, "stays upright");
      local.dispose();
    }
  // Walking speed and the stop are untouched (the anchor only engages below 0.3 m/s).
  const local = barnRound(4);
  place(local, 0, { x: 15, y: 0, z: 0.5 }, -Math.PI / 2);
  settle(local, -Math.PI / 2, 1);
  const start = local.physics.players[0].body.translation().x;
  for (let i = 0; i < 60; i++) local.step({ x: -1, z: 0, jump: false, facing: -Math.PI / 2 });
  const v = local.physics.players[0].body.linvel();
  assert.ok(Math.abs(Math.hypot(v.x, v.z) - 4.6) < 0.2, `walk ${Math.hypot(v.x, v.z).toFixed(2)} m/s`);
  const released = local.physics.players[0].body.translation().x;
  for (let i = 0; i < 90; i++) local.step(still(-Math.PI / 2));
  const stop = Math.abs(local.physics.players[0].body.translation().x - released);
  assert.ok(stop > 0.9 && stop < 1.5, `stopping distance ${stop.toFixed(2)} m (walk ~1.2 m)`);
  assert.ok(start - released > 3.5);
  local.dispose();
});

test("S3 fairness: a player standing on the S3 spawn can be shot in the body from the ground floor (west wing, south hub)", () => {
  const local = barnRound(5);
  const s3 = SPAWN_CANDIDATES.S3;
  // Measured with the real hitscan over 419 ground spots: the body (torso/pelvis) is reachable
  // from 25 of them — the west wing through the open D7 edge, the hub's south side and the south
  // wing's mouth through the void's west opening. At the old corner (−5, −5): none, only the head.
  const spots: { x: number; z: number }[] = [
    { x: -16, z: 3 },
    { x: -13, z: 2 },
    { x: -10, z: 0 },
    { x: -2, z: 6 },
    { x: -1, z: 7 },
    { x: 0, z: 8 },
  ];
  let bodyHits = 0;
  for (const g of spots) {
    place(local, 1, s3, s3.yaw);
    place(local, 0, { x: g.x, y: 0, z: g.z }, Math.atan2(s3.x - g.x, s3.z - g.z));
    place(local, 2, SPAWN_CANDIDATES.S2, SPAWN_CANDIDATES.S2.yaw);
    settle(local, Math.atan2(s3.x - g.x, s3.z - g.z), 0.7);
    local.barn!.fighters[1].hp = 100;
    local.barn!.fighters[1].protection = 0;
    local.barn!.fighters[0].weapon = newWeapon("smg");
    const target = local.physics.players[1].parts.torso.body.translation();
    const out = fireOnce(local, { ...target });
    if (out.hits.some((h) => h.target === 1)) bodyHits++;
  }
  assert.ok(bodyHits >= 5, `torso shots from the ground floor landed from ${bodyHits}/6 spots (the old corner: none)`);
  local.dispose();
});
