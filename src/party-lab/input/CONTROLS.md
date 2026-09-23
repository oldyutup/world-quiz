# Configurable Party Lab controls

## Scope and initial state

The initial working tree already contained Phase 3C active-ragdoll changes: nine
modified tracked Party Lab files plus untracked combat/ragdoll modules, tests and
documentation. All 44 original local tests passed before this task. The existing
Phase 4A Colyseus room/chat server was inspected and left unchanged. Existing work
was preserved; no reset, stash, commit, push, deployment or gameplay networking.

## Online compatibility (Phase 4B.2)

Online uses these same local bindings and focus protections. It transmits only
abstract intent at up to 60 Hz; the server validates and applies it at 60 Hz. Opening
settings neutralizes your input without pausing the shared round. Control storage
and customization remain entirely local. Local movement/jump and harmless punch
motion use an isolated predicted rig; input history is cleared on settings,
disconnect, stale snapshots and round changes. See
[PREDICTION.md](../../../shared/party-lab/PREDICTION.md).

## Architecture

- `actions.ts`: extensible action names, Turkish labels, and device-free human
  intent (`x`, `z`, `jump`, `punch`, `grab`, `lift`).
- `bindings.ts`, `defaults.ts`: two slots per action, supported physical bindings,
  readable labels, schema validation and conflict checks. Primary cannot be
  removed. Secondary can be changed/removed; same-action aliases are valid.
- `inputManager.ts`: pure held/pressed/released action state. Bindings are ORed
  before edge detection. A second held alias cannot duplicate a Punch edge;
  Grab persists until the last alias releases. Axes normalize diagonals.
- `keyboard.ts`, `device.ts`: arena device adapter, all raw key/button processing,
  scoped context menu handling, focus/visibility cleanup and suspension.
- `capture.ts`: captures down/up/click in the input layer. The opening click and
  repeated opener key are ignored. Assignment completes after release so the
  resulting click cannot activate another settings button. Escape cancels.
- `storage.ts`: guarded localStorage access and version validation. Denied writes
  leave working session controls and display a clear persistence warning.
- `ControlsSettings.tsx`: Turkish settings, available from landing and arena.
  Local simulation is paused and its grips/strikes are cancelled on opening.
  Binding changes do not recreate the physics world. The arena resumes focused;
  landing navigation and binding capture restore keyboard focus.

No raw keyboard or mouse checks enter ragdoll, bots, rounds, knockout or combat.
Future device adapters can feed the action layer; future networking can consume
abstract intent. Neither controllers nor networking are implemented here.

## Defaults

| Action | Primary | Secondary |
| --- | --- | --- |
| Hareket İleri | KeyW | ArrowUp |
| Hareket Geri | KeyS | ArrowDown |
| Sola Git | KeyA | ArrowLeft |
| Sağa Git | KeyD | ArrowRight |
| Zıpla | Space | none |
| Yumruk | KeyF | MouseLeft |
| Tut | KeyE | MouseRight |
| Kaldır | ShiftLeft | ShiftRight |

Normal trackpad click is MouseLeft. OS-exposed secondary click is MouseRight;
keyboard E always provides Grab. Middle mouse is available for custom bindings,
never required. Turkish mouse labels are Sol Tık, Sağ Tık, Orta Tık.

Keys use physical `KeyboardEvent.code` positions, independent of keyboard layout.
Letters, numbers, arrows, common punctuation/navigation keys, standalone Ctrl/Alt
and both Shifts are accepted. Escape cancels; Command/Meta, IME composition and
Ctrl/Alt browser shortcut chords are reserved. Ctrl/Alt assignments are therefore
best used for standalone actions, not movement/lift chords. Shift supports chords.

## Mode-specific meaning (Barn sprint)

One binding can mean different gameplay per mode. Kaldır (Shift by default) lifts a
grabbed player on the rooftop; in the barn, `scene/arenas/barnControls.ts` reads the
same held action as Sprint (`MovementInput.sprint`) and sends no lift. No action was
added, so saved `party-lab-controls-v1` maps stay valid and a rebound Kaldır key also
sprints in the barn. The barn footer shows "Koş"; settings note "Ambarda: Koş".

The shared ragdoll controller applies sprint: target speed and step cadence ×
`RAGDOLL.sprintMultiplier` (1.4), eased by a 0…1 `Character.sprint` blend over
`RAGDOLL.sprintRamp` (0.25 s) in and out. Rooftop input never sets it, so its blend
stays 0 and rooftop movement is bit-identical. Before the barn goes online, the
input packet needs a sprint flag and the prediction snapshot needs `Character.sprint`.

## Barn contextual attack and pickup

In the barn the same bindings are read contextually (`barnIntent`): Yumruk (F / left
click) is the attack — a punch unarmed, a shot armed, and held for the SMG's automatic
fire (`attackHeld` from `InputManager.isActionDown`) — and Tut (E / right click) picks up
the nearest weapon (`pickup`, the pressed edge). The rooftop's punch/grab/lift fields are
never sent in the barn, so no grab or lift can start there. The footer shows "Saldır
(yumruk / ateş)" and "Silah al"; settings add "Ambarda: …".

Pointer Lock: while locked, the browser sends mouse events to the lock element, so the
barn binds gameplay mouse presses to the viewport (`KeyboardOptions.mouseSurface`). The
click that acquires the lock is look input: `LookController.claimsClick` claims it
(recorded as it requests the lock, so the listener order does not matter) and
`bindKeyboard`'s `claimMouse` drops it — taking the lock never punches or fires. In drag
mode the left button looks and F attacks. The rooftop passes no options (unchanged).

## Gameplay compatibility

`CombatSimulation` resolves human Punch into an existing physical hand strike.
Accepted punches alternate left then right. Cooldown/KO rejection does not consume
the alternation. If the preferred hand holds a grip, the free hand can punch;
neither occupied hand attacks. Bot per-hand intent and decision behavior remain
unchanged. Contact detection, impact-part weighting, stun, knockout and recovery
are untouched.

Holding Grab selects the available hand closest to a valid reachable part. Only
that hand initially reaches. Once acquired, the other seeks the same opponent;
a distinct part is preferred if within actual palm acquisition range. One hand
remains valid when the other cannot reach. Existing physical range, line of sight,
cycle checks, protection, constraints, fatigue and overload apply. The target and
hands are never teleported. Releasing Grab drops both grips. Lift quality,
resistance, carrying and momentum release remain in their existing physical paths.

## Persistence and conflicts

Key: `party-lab-controls-v1`. JSON schema:

```json
{
  "version": 1,
  "bindings": {
    "moveForward": ["KeyW", "ArrowUp"],
    "moveBackward": ["KeyS", "ArrowDown"],
    "moveLeft": ["KeyA", "ArrowLeft"],
    "moveRight": ["KeyD", "ArrowRight"],
    "jump": ["Space", null],
    "punch": ["KeyF", "MouseLeft"],
    "grab": ["KeyE", "MouseRight"],
    "lift": ["ShiftLeft", "ShiftRight"]
  }
}
```

All eight actions and two slots per action are validated, including known binding
codes, nonempty primary and cross-action conflicts. Invalid, missing or unsupported
data falls back to a fresh default map. Settings reject cross-action conflicts
with the conflicting action's name; they never silently replace another action.
“Varsayılana Dön” persists a fresh default map. No account/server persistence.

Arena footer and contextual hints derive current bindings, including all movement
aliases. Changing F to G keeps Sol Tık and replaces F in the HUD. Combat state
labels also show accepted left/right physical punches when otherwise unoccupied.

## Validation

Commands:

```sh
node --import tsx --test src/party-lab/input/*.test.ts src/party-lab/scene/*.test.ts
npx tsc --noEmit --incremental false
npx vite build --outDir /tmp/party-lab-controls-build
npm --prefix servers/party-lab test
npm --prefix servers/party-lab run typecheck
npm --prefix servers/party-lab run build
```

Local tests cover defaults, input aliases and edges, normalized movement, custom
primary/secondary/removal, conflicts, invalid persistence and reset, focus and
capture safety, mouse buttons, browser scroll suppression, alternating physical
strikes, one/two-hand acquisition, restricted second-hand targeting, release
momentum, grabbed-player agency, and all existing physics/bot/round regressions.
The existing deterministic 12-round Rapier soak test remains included.

Server regressions pass 11/11. Root TypeScript, server typecheck/build and frontend
production build pass. Vite retains pre-existing large chunk and mixed
static/dynamic import warnings. Server tests require local socket access.

Browser checks and remaining hands-on limitations are recorded in the completion
report. Native UI automation cannot sustain independent key/button holds, so
physical trackpad hold, lift/carry/throw and struggle feel still need human testing.

Final local result: **63/63 passing** (the four obsolete tap/hold mapping tests
were updated for separate Punch/Grab semantics; all original physics, bot, round
and soak regression tests remain).

Safari verified landing → Kontroller, exact defaults, F → G rebinding with left
click retained, a clear rejected E conflict, Escape cancellation/focus restoration,
reload persistence, G in the arena HUD, middle mouse assignment, secondary removal,
settings from the arena, and reset returning F to settings and HUD. Rendering,
bot combat, grips, elimination and round restart were observed. F and left-click
inputs were exercised, but combat conditions/bots made individual live strikes
hard to isolate reliably. Exact arm alternation, F/MouseLeft equivalence, G replacing
F, held E/MouseRight equivalence, lift and release are verified by automated input
and Rapier tests; do not treat these as a completed human feel/playability test.

Remaining manual checks: sustained E/right-click grabs, Shift with Grab, ordinary
physical MacBook trackpad/two-finger OS behavior, longer carry/turn/release throws,
struggle feel and live custom G punch isolation. These need a human holding inputs;
no device-specific gesture or simultaneous-hold support is claimed from automation.

## Files changed by this task

Created (relative to `src/party-lab/`): `ControlsSettings.tsx`,
`input/actions.ts`, `input/bindings.ts`, `input/capture.ts`,
`input/controls.test.ts`, `input/defaults.ts`, `input/device.ts`,
`input/inputManager.ts`, `input/storage.ts`, `input/CONTROLS.md`.

Modified from the initial working tree: `PartyLabRoot.tsx`, `party-lab.css`,
`input/keyboard.ts`, `input/keyboard.test.ts`, `input/types.ts`,
`scene/ArenaScene.tsx`, `scene/combat.ts`, `scene/combat/grab.ts`,
`scene/combat.test.ts`, `scene/RAGDOLL.md`.

Final diff was checked against the initial snapshot as well as Git. No unrelated
Torble, package/lockfile, network or server source files changed. The pre-existing
uncommitted player rendering, physics, bot, round and other combat files remain.
