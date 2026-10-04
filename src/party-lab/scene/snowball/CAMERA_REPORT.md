# Kartopu Çarpışması — fixed arena camera

Camera-comfort pass, 2026-10-04. Local only, protocol 10. This report supersedes the camera and keyboard descriptions in the original `REPORT.md`; that prototype report and its measurements are preserved.

## 1. Rooftop behavior inspected

The **local** Rooftop camera is inside `ArenaScene.tsx` → `Playground`. It places the perspective camera at `(0, 12d, 14d)`, looks at world origin, and uses the Canvas's 45° vertical FOV, near 0.1, far 180. Here `d = max(1, 1.5 / viewportAspect)`: narrower viewports move the camera farther away along the same line. Its elevated three-quarter view frames the 14 × 11 m rooftop.

The base position is restored each frame. There is no player/centroid follow, heading follow, orbit, speed zoom, or camera smoothing in the local Rooftop branch. Rotation is fixed. Its optional impact feedback adds only a short positional shake: 0.15 s decay, maximum strength 0.022 or 0.035 for knockouts; no rotation.

For comparison, `OnlineArena.tsx` retains the same orientation/base framing and adds a small smoothed local-player translation: X/Z = 10% of player position, capped at ±0.65; Y capped at 0.15; exponential smoothing with a 0.12 s time constant and a 0.1 s delta cap. It translates both the camera and its look target equally, so this does not orbit either. That online behavior was inspected only.

## 2. Reused principles

`camera.ts` mirrors the **local** Rooftop pose, origin target, 12:14 elevation ratio, 45° lens and narrow-viewport framing formula. The original inline Rooftop code was left intact instead of extracting a shared helper and changing other modes.

Snowball scales the base distance by 1.6 to fit its existing 20 m disk, players and edge departures. It does not copy impact shake. Its old heading-follow chase camera, speed-dependent distance/height, spectator camera transitions and V presets were removed.

## 3. Final position, orientation and FOV

At both requested viewport sizes, 1440 × 900 and 1366 × 768:

| Property | Value |
| --- | --- |
| Position | `(0, 19.2, 22.4)` |
| Look target | `(0, 0, 0)` |
| Orientation | Fixed toward world −Z, approximately 40.60° downward, zero roll |
| Vertical FOV | 45° |
| Near / far | Existing Canvas values: 0.1 / 180 |
| Narrow viewport rule | Multiply distance by `max(1, 1.5 / aspect)` |

The pose is set when the mode mounts or viewport size changes. It is never calculated from a ball's heading, rotation, velocity, position, alive state, score or arena shrink radius. Leaving Snowball restores the incoming camera pose and lens.

## 4. Follow and zoom

None. No centroid follow, pan, yaw, orbit, dynamic zoom, speed FOV or shake. Shrink and round transitions happen inside the same framing. Viewport resizing is the only framing adjustment.

## 5. Movement reference

The keyboard now requests Rooftop's fixed world/screen directions: **W = −Z/up into the arena, S = +Z/down, A = −X/left, D = +X/right**. Opposing keys cancel; diagonal input is bounded.

`screenInput.ts` translates that direction request into the existing throttle/steer motor. It does not assign body transforms, velocities or heading, and does not modify acceleration, turn-rate, speed limits, grip or collision coefficients. The existing speed-dependent steering limit still applies. Opposite direction requests use the existing brake/reverse path, so momentum cannot reverse instantly. Reverse retains its original lower speed/acceleration. The sphere's visual/physical quaternion has no role in the input basis.

Only the human keyboard adapter changed. Bots continue to call the same unchanged motor with their original inputs.

## 6. V behavior

No Snowball V action remains. Its intro, controls panel and menu hints have been updated. Bowling and Prop Hunt V implementations are byte-identical to the camera-task backup.

## 7. Headed Chrome validation

Validation uses installed Google Chrome with `headless:false`, real Playwright keyboard down/up events, and the normal browser render/physics loop. Controlled scenarios place the initial bodies through the existing debug access; they do not fake keyboard intent or manually advance physics. Full matches run in real time with the original bots, countdown, shrink, scoring and three-round lifecycle.

Results and screenshots are stored outside the repository in `/private/tmp/snowball-camera-comfort-20261004/`.

| Viewport | Players | Completed rounds | Active round times (s) | Average FPS |
| --- | --- | --- | --- | --- |
| 1440 × 900 | Human + 1 bot | 3 / 3 | 50.51, 50.43, 50.18 | 60.00 |
| 1440 × 900 | Human + 2 bots | 3 / 3 | 50.38, 50.79, 51.01 | 60.00 |
| 1366 × 768 | Human + 1 bot | 3 / 3 | 51.06, 15.81, 50.32 | 60.00 |
| 1366 × 768 | Human + 2 bots | 3 / 3 | 51.09, 50.17, 51.07 | 60.00 |

All four matches reached the results screen; replay returned to round-one countdown. Across 40,072 sampled match frames, maximum change in camera position, quaternion components and FOV was **exactly zero**. 8,255 of those frames were during shrink. No living ball center left the measured viewport, and no invalid physics body was recorded. Unit projection checks also cover the sphere/label extents beyond the platform edge.

Both sizes passed real-keyboard W/S/A/D direction checks, including W/A after different prior headings; twelve alternating A/D presses; 18 seconds circling a stationary rival; 10 m/s opposing head-on impacts; outward 5 m/s near-edge recovery; a ball spinning at 20 rad/s; and V remaining a no-op. Camera orientation stayed fixed through steering, spin, contact and falls. Platform edges and the shrink boundary stayed readable in the captured views. The orbiting behavior is gone; subjective comfort remains for the user's manual playtest.

A final numeric input cleanup makes a settled heading send exact zero steering rather than a floating-point remainder after wrapping 2π. The 1366 × 768 matches and a repeat of the controlled scenarios use this final adapter. One initial countdown/partial attempt restarted under development hot reload; the table includes only the three subsequently completed rounds.

Three additional Snowball → Rooftop → Snowball cycles passed with the module already cached. Snowball always returned to `(0,19.2,22.4)`, 45°. Rooftop always returned to its expected `(0,12,14)`, origin-facing quaternion and 45° lens at the tested viewport. No browser page errors occurred.

## 8. Rooftop and scope preservation

The entire original `Playground` function, including Rooftop camera setup, frame updates and shake, is byte-identical to the camera-task backup. The only `ArenaScene.tsx` edits in this pass are Snowball control instructions.

Snowball `game.ts`, `config.ts`, `bots.ts`, `visual.ts` and `snowball.css` are unchanged. All existing mode implementation files, online lists, Mixed, protocol, server and PartyRoom retain their baseline bytes. No commit, push or deploy was performed.

External backup of the existing uncommitted work: `/private/tmp/snowball-camera-comfort-20261004/before-camera.tar.gz`. Companion `before-hashes.json` and `before.diff` preserve the source hashes and original working diff.

## 9. Tests and build

- Existing Snowball physics/rules tests plus new camera/input tests: 19 passed.
- Rooftop and keyboard/control regression tests: 42 passed.
- TypeScript `npx tsc --noEmit`: passed.
- Production `npm run build`: passed, with the existing bundle-size warning.
- `git diff --check`: passed.
- Before/after SHA-256 audit: 325 of 328 existing files are byte-identical; the only changed existing files are the three camera/control presentation files listed below. New files are listed separately.

The camera tests project the full platform, sphere/label extents and departure margin into both viewport sizes. Input tests cover cardinal directions from multiple prior headings, bounded diagonal commands, braking/coasting and independence from sphere orientation.

## 10. Files changed in this pass

| File | Change |
| --- | --- |
| `src/party-lab/scene/snowball/camera.ts` | New fixed Rooftop-style framing helper |
| `src/party-lab/scene/snowball/screenInput.ts` | Fixed screen-direction keyboard adapter |
| `src/party-lab/scene/snowball/camera.test.ts` | Camera framing and input regression tests |
| `src/party-lab/scene/snowball/SnowballPlayground.tsx` | Fixed camera lifecycle, remove chase/V, use adapter |
| `src/party-lab/scene/snowball/SnowballHud.tsx` | Intro control text only |
| `src/party-lab/scene/ArenaScene.tsx` | Snowball menu/control text only |
| `src/party-lab/scene/snowball/CAMERA_REPORT.md` | This report |

Other Snowball prototype files and `ArenaChrome.tsx` already had uncommitted work before this pass; those changes were preserved.
