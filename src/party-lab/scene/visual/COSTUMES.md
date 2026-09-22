# Party Lab visual costumes

`PlayerBean` wraps `createCharacterVisual(color, costume)`. The returned root has
exactly the nine `PARTS` groups in their existing order. Local rendering still
finds these by name; online rendering still addresses them by index. Each group
has a `skin` mesh, and the head retains `stars`. The arenas continue to write
all positions/quaternions and combat feedback. No renderer code writes physics.

Stable visual IDs are `default`, `cat`, `anchovy` and `gazelle`; missing/unknown
visual IDs resolve to `default`. The landing offers the three animal costumes
and saves the chosen ID under `party-lab-costume-v1`, falling back to cat for
invalid or inaccessible storage. Room create/join admission carries only that
ID. The server validates it against the shared three-ID whitelist, falls back
to cat for invalid admission values, and stores it on each player's room schema.
Reconnect retains the same player schema entry. Online visuals use the player's
synced ID; slot is used only to find the corresponding physics pose and retain
its color accent. Local play uses the chosen costume for the human and the other
two costumes for bots. The `default` visual remains a rendering fallback.
Future costumes can add an ID and a part builder without changing the transform
adapter.

The base retains the original capsules, sphere head, slot color and oval eyes.
The cat adds a rounded cream torso/pelvis, calico orange/brown vertex colors,
beveled ears with pink interiors, cream face insert, dark oval eyes, a pink hood
nose, pink paw pads, a slot-colored collar with a small bell, and a curved striped
tail. The ears are merged into the head mesh; the tail into the pelvis mesh.
They follow full body rotations during collapse, lift and throw, with no
independent simulation, collision, joints or secondary animation.

The reference supplies the silhouette and palette. Plush fibers, fabric seams,
fine whiskers, sculpted toes and detailed embroidery are omitted. All geometry
is procedural Three.js; materials use rough shading and vertex colors. No
textures, asset downloads, GLTF, custom shaders or extra frame loops.

Geometry is merged per part and shared by live instances of the same costume
and color. Each player owns one skin material so hit flashes cannot leak between
players. Ref-counted resources are disposed when their last owner leaves;
React layout-effect setup/cleanup also handles StrictMode remounts.

## Cat checkpoint validation, 2026-09-22

- Full Party Lab input/scene/audio/network suite: **109/109 passed**, including
  physical punch, grip, KO/recovery, carry/release/throw and prediction tests.
- Added checks for both visual roots, ordered/named pose compatibility, finite
  geometry, ear/tail transform attachment in arbitrary rotations, triangle
  budget, shared geometry ownership, per-player flashes and remount cleanup.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run build`: passed; existing Vite large-chunk warning remains.
- Chrome: local cat and two base bots rendered; animated base collapse/stars
  observed. Two actual online browser clients joined/readied; cat rendered for
  its owner and remote observer. Punch/jump inputs exercised online. A temporary
  front/rear close-up confirmed eyes, ears, pads, collar/bell and tail, then the
  temporary preview was removed.
- Short active samples: local **60 FPS**, ~1.2 ms physics; online **60 FPS**,
  ~0.36–0.43 ms prediction, zero hard corrections, ~21–24 ms ACK turnaround.
  These are development observations, not a controlled GPU benchmark.
- Base: **1,944 triangles**; cat: **5,712 triangles**. Both have **9 skin draw
  calls**, plus 3 only when stars are visible. Previous visuals used 9 bodies
  plus 2 separate eye draws. No meaningful slowdown observed in these samples;
  low-end hardware and sustained three-player performance remain unmeasured.
- No networking synchronization changes, so the server regression suite was
  not rerun. Existing uncommitted prediction/server work was preserved; baseline
  diff comparison confirms only the costume import/prop were added to OnlineArena.

## Limitations

Full live cat KO/grab/carry/throw visual readability still needs hands-on testing:
native automation cannot reliably sustain the required simultaneous keys.
The underlying mechanics pass their existing tests, and ear/tail attachment is
verified independently, but these are not a complete manual visual playtest.
The tail is rigid relative to the pelvis; decorative geometry can intersect
other bodies/the floor during extreme poses. Color patches are deliberately
coarse. Body articulation stays visible and is less plush than the reference.
No physics, prediction, authority, audio, controls, maps or unrelated Torble code
was changed for this checkpoint. No deployment, commit or push.

## Anchovy / hamsi checkpoint, 2026-09-22

Added only the `anchovy` ID and part builder, using the same paint/oval/merge
helpers, geometry cache, material ownership and transform adapter. Slot 1 now
wears hamsi in both modes; slot 0 remains cat and slot 2 remains default.
The cat builder and its visuals are unchanged. No synchronized state was added.

Hamsi keeps the existing rounded humanoid proportions. Blue-gray body and hood,
a cream/silver belly, large funny fish eyes above the separate Party Lab face,
a tiny hood mouth, dorsal fin, side fins, silver fin rays, two-lobed tail and
slot-colored neckline provide the fish identity. Dorsal/side fins are merged into
head geometry; the tail is merged into pelvis geometry. Knockout stars are lifted
above the dorsal fin. Fins are small beveled plates, with no extra colliders,
textures, shaders, asset pipeline, skeletal system or secondary motion.
Plush fibers, embroidered spots, fabric seams and detailed fin ribs are omitted.

Validation:

- Full input/scene/audio/network suite: **110/110 passed**. Existing physical
  KO, grab, carry, throw and prediction/reconciliation coverage remains green.
  After final tail simplification, all 3 visual tests passed again.
- Visual tests cover the default/cat/anchovy ordered body contract, finite meshes,
  dorsal and tail tip attachment, both side-fin tips under multiple rotations,
  star clearance, triangle budget and existing resource ownership behavior.
- `npx tsc --noEmit --incremental false` and `npm run build` passed. Existing
  large-chunk warning remains. Git diff and saved pre-task file comparisons
  confirm only four costume-related files changed; cat/physics/combat/network/
  controls/audio code was preserved. Server tests were not required or rerun.
- Chrome close-up: front/side/rear inspected. Local bot movement and being grabbed
  observed with attached fins/tail. Two browser clients joined/readied online;
  owner and remote hamsi rendered, and movement/punch/jump inputs were exercised.
- Local samples: **60 FPS**, ~1.0–1.2 ms physics. Online hamsi owner: **60 FPS**,
  ~0.46 ms prediction, 0 hard corrections, ~21 ms ACK turnaround. These are short
  same-machine development samples, not a controlled low-end benchmark.
- **5,420 triangles**, **9 skin draw calls**, plus 3 when stars are visible.
  Geometry/material lifetime and allocation behavior reuse the existing system;
  no per-frame costume work or meaningful slowdown observed.

Full live hamsi KO/carry/throw readability still needs hands-on testing. The
mechanics pass existing tests and attachment transforms are tested, but native
input automation does not reliably sustain simultaneous grab/lift controls.
Decorations are rigid relative to their parent body and can clip during extreme
contact poses. The dorsal fin is narrow from some angles; finer markings are
intentionally omitted. No gazelle, selection UI, maps or other costumes were added
at this historical anchovy checkpoint.

## Gazelle / ceylan checkpoint, 2026-09-22

Added the `gazelle` ID and part builder to the existing system. All three local
and online slots now show a different costume: cat, anchovy, gazelle. This remains
a fixed visual test assignment. The costume is derived from slot on every client;
the room/player schema and input/snapshot protocol are unchanged. The cat and
anchovy builders were left as they were.

Gazelle keeps the same rounded humanoid body. It has tan/caramel color blocking,
a cream face and belly, two broad ears with pink interiors, short branched
antlers, a few cream head/flank/back spots, dark hands and feet, a short tan tail
with a cream tip, and the unchanged Party Lab oval face style. A narrow collar
uses the existing slot color. The ears and antlers are merged into the head mesh;
the tail is merged into the pelvis mesh. No additional animation, physics or
per-frame visual update was introduced. The described reference direction is
reduced to solid shapes and colors; no texture, fibers, GLTF or shader is used.

Validation:

- Full Party Lab input/scene/audio/network suite: **111/111 passed**, including
  physical KO, grab, carry, throw and prediction/reconciliation regressions.
  `npx tsc --noEmit --incremental false` and `npm run build` passed. Existing
  production chunk warnings remain. Server tests were not run because no network
  or room/player state changed.
- Visual tests cover all four costume IDs, nine ordered body-local meshes,
  finite geometry, ear/antler/tail tip attachment under rotations, antler height,
  star clearance and the shared resource lifecycle. Gazelle is **5,648 triangles**
  and **nine skin draw calls** (plus three only during stun/KO stars).
- Chrome front/side/back review and the local arena showed a clear deer silhouette.
  The local gazelle grabbed the anchovy with both hands without visible antler
  interference. Local active-play sample: **60 FPS**, ~1.6 ms physics per step.
  Three browser clients joined/readied and all three costumes rendered online.
  Gazelle owner movement/jump/punch input was exercised. Short owner sample:
  **60 FPS**, ~0.45 ms prediction step, 0 hard corrections, ~24 ms ACK turnaround.
  These are same-machine observations, not a controlled low-end benchmark.
- Git diff and saved pre-task file comparisons were inspected. Only the costume
  ID mapping, builder, visual tests and this note changed in this task. Earlier
  uncommitted work remains in place. No physics, combat, controls, audio or other
  Torble code changed.

Full live gazelle KO/carry/throw visual readability still needs hands-on testing;
the existing physical mechanics and body-local attachment tests are green, but
native automation cannot reliably sustain simultaneous grab/lift controls.
Rigid visual pieces can clip in extreme poses. Small cream spots and antler
branches are subtle at the arena camera distance.
