# Party Lab: local active ragdoll prototype (Phase 3C)

Open `http://127.0.0.1:5173/party-lab` with `npm run dev -- --host 127.0.0.1`, then
choose **Yerel Test Arenası**. The separate room/chat server is not needed for this
local arena. No gameplay is networked. No dependency or hosting changes were made.

## Controls

Controls are now configurable from **Kontroller** on the landing page or local
arena. See [CONTROLS.md](../input/CONTROLS.md) for the action architecture, storage,
settings safety, test results, and browser verification.

| Input (defaults) | Action |
| --- | --- |
| WASD / arrow keys | Move and turn toward movement intent |
| Space | Jump when grounded and sufficiently upright/conscious |
| F / normal left click | Punch on press; accepted strikes alternate left/right |
| Hold E / right click | One hand acquires, then the other seeks the same opponent |
| Either Shift while grabbing | Physically lift/heave/carry |
| Release all Grab bindings | Release both grips, retaining physical momentum |

The human intent contains `x`, `z`, `jump`, `punch`, `grab`, and `lift`, with no
physical key names. Bots retain their independent per-hand gameplay intents.
Hands, contacts, per-hand cooldowns, grip forces, resistance and lifting remain
physical. A held hand does not punch; the free hand can counterattack. Failed
punch attempts do not advance alternation. Reset starts again with the left hand.
Focus loss clears inputs; opening settings pauses the local simulation and cancels
active strikes/grips, without changing body transforms or velocities. The arena
context menu is suppressed only when its right button has a gameplay binding.

## Bodies and joints

Each player has nine dynamic bodies, all rendered from their actual transforms:
pelvis, torso, head, two upper arms, two forearm/hands, and two single-segment legs.
There is no invisible master capsule, kinematic root, skeleton, or animation rig.

| Part | Mass (kg) | Collider radius / capsule half-segment |
| --- | --- | --- |
| Pelvis | 0.70 | 0.29 / 0.07 |
| Torso | 0.80 | 0.32 / 0.12 |
| Head | 0.35 | Ball radius 0.29 |
| Each upper arm | 0.20 | 0.115 / 0.15 |
| Each forearm/hand | 0.175 | 0.13 / 0.12 |
| Each leg | 0.40 | 0.16 / 0.18 |

Total mass is **3.4 kg per character**. Standing height is approximately 1.92 units.
Inertia is isotropic with a **0.035 kg·m² floor** to keep tiny limbs stable under
point forces. This is deliberate game tuning, not an anatomical mass model.
Same-character collisions are filtered; opponents and static geometry still collide.
CCD is enabled on all character parts.

Each character has six limited revolute joints and two ball shoulders:

| Joint | Limit (radians) | Motor torque cap |
| --- | --- | --- |
| Spine | −0.55 to 0.55 | 12 |
| Neck | −0.75 to 0.75 | 4 |
| Each elbow | −2.60 to 0.15 | 6 |
| Each hip | −1.30 to 1.30 | 14 |
| Each shoulder | Soft relative-angle cone 2.80 | Active corrective torque 1.20; passive limit torque 2 |

At full attendance: **27 dynamic bodies, 24 anatomical joints** (18 hinges and
6 ball joints), plus four static colliders. Eliminated characters' nine bodies are
disabled. Up to six additional hand holds use bounded point forces, **not additional
Rapier joints**. There are no environment-grab constraints.

Rapier 0.20's spherical descriptor returns a generic joint wrapper in this installed
build. Its ball constraint works, but that returned object does not expose the
spherical motor methods advertised by its declarations. Shoulders therefore use
equal/opposite corrective torque impulses; hinges use native force-based motors.
No engine internals or dependency changes were used. Reference:
[Rapier joints](https://rapier.rs/docs/user_guides/javascript/joints/).

## Active balance and movement

`ragdoll/character.ts` owns body construction, joint definitions, and spawn reset.
`ragdoll/controller.ts` drives the real pelvis/torso, joint motors, and physical hands.
`ragdoll/math.ts` has renderer-independent vector/quaternion helpers.

The controller applies capped upright/yaw torques to pelvis and torso, limited
hinge motors, and alternating hip targets. A short downward static-ground query
allows a bounded vertical stand-up force on the real pelvis. This assistance is
disabled in KO and beyond ground range. It is an intentional simplification of
balance and leg support; this is not a fully autonomous biped gait optimizer.
Small bumps, pulls, and poorly balanced landings still rotate and displace bodies.

| Parameter | Phase 3C |
| --- | --- |
| Simulation / gravity | 60 Hz / −20 |
| Speed / ground acceleration / air acceleration | 4.6 / 25 / 5 |
| Braking / linear damping / angular damping | 9 / 0.45 / 1.4 |
| Friction / jump speed / jump cooldown | 0.55 / 6.5 / 0.45 s |
| Ground margin / support range / target pelvis height | 0.10 / 0.97 / 0.76 |
| Support spring / damping / upward force cap | 180 / 35 / 190 |
| Upright spring / damping / torque cap | 18 / 3.8 / 18 |
| Hinge motor stiffness / damping | 25 / 2.5 |
| Shoulder correction stiffness / damping / cap | 1.2 / 0.3 / 1.2 |
| Gait amplitude / frequency / facing turn speed | 0.22 rad / 7 rad/s / 5 rad/s |
| Hand target spring / damping / idle force cap | 100 / 8 / 24 |
| Linear / angular speed safety limits | 18 units/s / 20 rad/s |
| Maximum part-to-pelvis separation / fall threshold | 2.6 / −5 |

Compared with Phase 3B, speed was 5.2, ground acceleration 32, air acceleration 10,
braking 10, friction 0.3, jump speed 7.5, and mass 1. Gravity and linear damping are
unchanged. The new values and distributed mass serve the articulated controller.
Ground checks use the lower legs and torso orientation, exclude dynamic bodies,
and cannot be granted by head/arm wall contact. There is a jump cooldown as well.

## Punches and consciousness

Each hand has independent startup/active/recovery and cooldown state. The arm is
driven toward a forward, inward physical target. Only actual active forearm contact
(with a 0.055 contact margin) can score a hit. A distant opponent or one behind the
strike cannot be hit by a cone query. Only one target contact scores per swing.

Strength uses relative physical hand/body velocity and horizontal impact alignment.
Contacts weight the actual hit collider: head 58, torso/pelvis 39, limb 15 at full
quality. Closing speed below 0.7 does not count; full quality is reached at 3.2.
Thus two clean head hits or three clean body hits can cause a KO; glancing/slow
hits contribute less. Ordinary idle contact does not accumulate stun.

| Parameter | Value |
| --- | --- |
| Startup / active / recovery | 0.08 / 0.27 / 0.32 s |
| Per-hand cooldown / minimum alternate interval | 0.80 / 0.22 s |
| Punch hand force cap / contact impulse assist | 60 / 1.6 maximum |
| Recoil fraction / hit flash | 0.18 / 0.15 s |
| Daze threshold / KO threshold | 42 / 100 |
| Dazed posture / movement | 0.40 / 0.50 |
| Meter decay / quiet delay | 9 per second / 1 s |
| Initial KO / maximum KO age | 2.0 / 2.6 s |
| Extra hit extension while KO | 0.15 s, always bounded by total KO age |
| Recovery ramp / post-recovery KO immunity | 1.3 / 1.4 s |
| Recovery meter | 15 |

CONSCIOUS → DAZED weakens balance. Reaching 100 enters KNOCKED_OUT: upright,
locomotion, hand assistance, and active joint motors turn off. The articulated
body collapses under contacts and gravity. Passive anatomical limits remain.
RECOVERING ramps posture from 15% toward normal without rotation/position snapping.
Resistance returns immediately on recovery (40% initially), so a waking target can
fight a hold. Recovery does not guarantee standing if an opponent is still pulling.

## Independent grips, struggle, lift and release

`combat/grab.ts` tracks each owner's left/right grip, target player, target part,
body-local contact anchor, fatigue, overload, and reverse membership. Self grabs,
invalid targets, cycles, eliminated targets and distant targets are rejected.
Two hands may attach to different parts of the same player (or the same part).

Hands seek a visible nearby part, then require a close actual palm-to-surface
distance. Each grip applies equal/opposite capped spring/damping impulses at its
physical contact points. The target always stays simulated. No character is welded
to another, and no target transform or lift Y velocity is overwritten.

| Parameter | Value |
| --- | --- |
| Palm acquisition distance / reach-search distance | 0.24 / 1.65 |
| Root separation / hand-anchor separation break | 2.50 / 0.85 |
| Grip spring / damping | 160 / 8 |
| One-hand force / each hand of a paired grip | 48 / 78 |
| Overload break | >125% force demand for 0.22 s |
| Maximum grip duration / target re-grab protection | 8.0 / 0.60 s |
| Continuous active resistance / passive fatigue | 0.85/s / 0.04/s |
| Stress fatigue coefficient | 0.25/s |
| Two-hand escape scaling | 0.46 |
| Dazed / KO resistance | 0.45 / 0.015 |
| Meaningful turn bonus / gate | 0.08 / 0.50 s |
| Grounded jump bonus / gate | 0.15 / 0.60 s |
| Lift quality: one / two hands | 0.32 / 1.0 |
| Lift vulnerability: KO / dazed / conscious | 1.0 / 0.65 / 0.12 |
| Active resistance reduction to lift quality | Up to 75% |
| Lift maximum distance / hand-height increase / forward target | 1.70 / 1.05 / 0.65 |
| Reach-hand force / additional full-quality lift force | 28 / 100 |
| Carry movement multiplier | 0.65 |
| Optional release assist / required previous lift / cooldown | 0.65 horizontal impulse / 0.25 s / 0.70 s |

Pulling away, turning and grounded jumps build fatigue while the actual constraint
load can overload a grip. Two hands withstand more load and slow fatigue. KO has
almost no active resistance, but distance/overload/time limits still apply. There
is no raw button-mash multiplier.

Shift raises physical hand targets and increases their bounded servo force according
to grip count, vulnerability, resistance and distance. Force travels through the
held body parts. A healthy resisting opponent is deliberately hard to lift. Release
removes only that hand's hold and preserves existing velocities. Momentum from
movement and rotation is the main throw; Shift plus movement after a lift permits
one small horizontal assist, not a canned launch.

## Bots

Bots remain removable input producers. They approach imperfectly, choose either
hand, respect per-hand cooldowns, try a second grip, lift visible vulnerable targets,
steer toward an edge, and release there or after their hold plan expires. When held
they wait before resisting, may jump, and sometimes turn back to punch the grabber.
They use the exact same grip and physical controllers as the human.

Decisions are spaced 0.75–1.55 s; grab chance is 35% (also favors KO targets),
reaction delay 0.35–0.75 s, planned hold 2.2–3.8 s, second-hand delay 0.35 s.
Bots do not receive hit, force, mass, cooldown, or escape bonuses.

## Lifecycle and safety

`LocalRoundSimulation` runs intent/combat, body controllers, one shared Rapier
step, contact punches, elimination cleanup, then the unchanged round rules.
Countdown blocks combat; results release grips and cancel strikes. Reset clears
all grip references/reverse references, condition timers/immunity, punches, bot
intent, body rotations and velocities. All 24 anatomical joints are removed and
recreated; no previous-round joint survives. Dispose frees the world and input
listeners, including under repeated StrictMode mounts.

Finite-transform checks and body-separation checks quarantine a broken character
and eliminate it instead of stepping invalid state. Linear/angular caps are safety
guards, not the movement controller. Transform writes happen only on construction,
round reset, and exceptional invalid-state quarantine. No normal gameplay teleports.

## Validation and performance

Commands from the repository root:

```sh
node --import tsx --test src/party-lab/input/*.test.ts src/party-lab/scene/*.test.ts
npx tsc --noEmit --incremental false
npx vite build --outDir /tmp/party-lab-phase3c-build
```

Server regression commands from `servers/party-lab`: `npm test`,
`npm run typecheck`, `npm run build`. Server tests require local port access.

Final checks passed: **44 local tests**, **11 server regression tests**, root
TypeScript, frontend production build, server TypeScript/build, and diff whitespace
checks. The frontend build retains the existing large-chunk warnings.

Tests migrate the obsolete upright-body expectations while retaining locomotion,
jump/contact, elimination, reset, world cleanup, input cleanup and unchanged round
tests. New checks cover hit-part weighting, actual arm motion/contact, KO collapse
and physical recovery, both hands and reverse references, invalid/cyclic grabs,
overload/escape, actual one-vs-two-hand lift, a fallen target's lift/carry/release,
an edge elimination, and bot decisions.

The deterministic 12-round actual-Rapier run completed 18,348 fixed steps: 163 hits,
17 head hits, 5 KOs, 191 grips, 68 second-hand acquisitions, 19 fatigue escapes,
15 overload breaks, 28 lift activations, and 7 assisted releases. It produced human
wins, bot wins and draws, with no invalid bodies or stale holds. Two angular-speed
clamps occurred; the observed pre-clamp peak was 20.79 rad/s (limit 20). Peak linear
speed was 16.30. Node simulation with per-step assertions averaged about 0.13 ms/step
on this machine; this is not a low-end-PC or browser benchmark.

The arena retains the camera and DPR cap 1–1.5, no textures, postprocessing or dynamic
shadows. Transforms are interpolated per physical part through refs. HUD condition
updates are imperative at 10 Hz. A two-second on-screen sample reports browser FPS,
simulation milliseconds per step, and allocated body/joint counts for playtesting.

Safari confirmed articulated rendering, physical arm motion after a left-hand tap,
bot one- and two-hand grips, a bot grabbing the human, elimination and a winner
screen. Short active-play samples showed **60 FPS and 0.9–1.0 ms per physics step**
on this machine. Results-phase timing is lower because the simulation freezes;
that sample is not used as an active-play measurement. This is not a low-end-PC
benchmark. Live inspection was interrupted at times by concurrent browser activity.
Sustained mouse/key combinations are not supported by the available native
automation, so manual lift/carry/struggle/throw feel is not claimed as verified.
These scenarios are covered by actual physics tests, but need human playtesting.

## Deliberate limitations before networking

- The legs are single segments and hips/spine/neck use one-axis hinges. Shoulders
  use a broad soft cone; this is a small game ragdoll, not human biomechanics.
- Pelvis ground-support and upright torques are active assists. Foot placement is
  procedural, not a full balance planner. The character can step over the low bumper.
- Self-collision is disabled and limb inertia is inflated for stability. Anatomical
  limits, held poses, grip acquisition and carrying silhouettes still need tuning.
- KO frequency depends on real contact quality, so bot bouts produce many glancing
  arm contacts. Hit feel, head targeting, wake-up timing, one-hand escape and the
  short carrying opportunity should be judged hands-on before server work.
- Two cap activations in the long simulation were small overshoots, not NaNs or
  exploding rigs; additional adversarial and low-end-device playtesting is warranted.

The landing page, room/chat modules, Colyseus server, Supabase, other Torble games,
routes and packages remain unchanged. No deployment, commit, push or networking.
