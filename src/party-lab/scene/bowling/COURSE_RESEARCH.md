# FlatOut 2 Bowling course research, before implementation

Sources inspected in headed Chrome, 2026-09-27:
A. All School Gameplays, FlatOut 2 – All Stunts, https://www.youtube.com/watch?v=cZ8lAE6iLns . Bowling chapter 1:16. Frames inspected at 1:18, 1:23, 1:24, 1:26, 1:28, 1:31–32. The 1:26 seek later buffered; do not infer motion from the frozen frame.
B. RetroDetect, Flatout 2 PS2 Gameplay (Mini Game Bowling), https://www.youtube.com/watch?v=CkoPcujJRoU . Frames inspected at 0:01, 0:05, 0:06, 0:08, 0:09, 0:10, 0:11, 0:14, 0:16. Paused frame advance used around descent and launch.
C. Original PC manual, printed p8, https://cdn.cloudflare.steamstatic.com/steam/apps/2990/manuals/manual_en.pdf . Confirms angle sweep during slow motion, release launch, aerobatics and one upward Nudge. No course dimensions.

No Ultimate Carnage, fan recreation, or existing Party Lab research used as evidence.

## Comparison before changing geometry

All metre values below are INFERENCES, never official dimensions. The rendered game HUD speed is only an approximate scale: acceleration, camera perspective, launch slow motion, and video seek/frame accuracy limit precision. Confidence refers to the observation; dimension confidence is separately listed below.

| Feature | FlatOut 2 observation | Evidence | Confidence | Current Party Lab (read from code) | Recommended Party Lab change |
|---|---|---|---|---|---|
| Total shape | Straight high staging, steep enclosed descent, lower rise, substantially longer lower road, clear launch, long narrow target alley | A 1:18–1:32; B 0:01–0:16 | HIGH | 264m bounds, 248m spawn-to-end; short lower road | Rebalance to ~310m bounds, longer lower obstacle sequence |
| Start elevation | Elevated above stadium floor; not a mountain | A 1:18/23; B 0:01/08 | HIGH | 34m | 26m |
| Start plateau | Short level staging road before falling out of sight | B 0:01/05/06 | HIGH | 20m platform, car only 4m before crest | 20m platform, car 8m before crest |
| Downhill angle | Steep central drop; rounded crest and foot, not one sharp planar wedge | A 1:23/24; B 0:08/09 | MEDIUM | 27.2° max, 24.1° average | Similar dramatic pitch, shorter 58m descent, distinct 8m crest and 18m compression |
| Downhill length | A few seconds accelerating from ~55 to ~119km/h | B 0:06–0:08 | MEDIUM | 76m horizontal | 58m horizontal |
| Visibility | Distant target sign visible at spawn; actual lower road hidden by crest and sides | A 1:18/23; B 0:01/08 | HIGH | High chase camera/open sides | Lower staging camera, tall off-road structure and crest; keep arena skyline visible |
| Flat section | Several seconds at ~130–160km/h after descent | B 0:09–0:14; A 1:24–1:28 | HIGH | 40m hill foot to ramp | 114m foot to ramp, scaled for our 79km/h car |
| Bump/kicker | Small convex rise at corridor exit before obstacle road | A 1:24; B 0:08/09 | MEDIUM | None after hill | 12m × 0.8m smooth hump after foot; verify actual brief unloading |
| Obstacle families | Giant bowling balls on road; ball storage/chutes on sides; tiny impact fragments visible in A. No verified barrel, tyre or crate slalom | A 1:18/26/28; B 0:10/11 | HIGH balls; LOW destructibility | Oversized pins and crates | Original coloured spherical bowling hazards; no claimed FO2 crate family |
| Obstacle role | Occupy alternating road regions, line choice and loss of composure; moving balls appear in different road positions across footage, precise motion/destruction not resolved | A/B obstacle frames | MEDIUM | 12 breakaway sensors in ~18m | Four separated decision groups, authored offsets; cheap contact response, balls roll away cosmetically |
| Density | Small number of large, readable hazards, open gaps | A 1:26; B 0:10/11 | HIGH | Dense close-packed gate/split rack | 4–6 large balls; 16–22m group spacing |
| Width | Several car widths, tight relative to stadium; low curb lower down, tall structural sides on descent | A 1:23/26; B 0:08/11 | HIGH | 14m road | 12m road (about six chassis widths, 2.8 car lengths) |
| Final approach | Straight/open yellow-marked launch area after balls | A 1:28; B 0:14 | HIGH | Last obstacle z1.95; prep z6 | Last obstacle z-12; clear approach to ramp z22; angle zone z6 retained |
| Launch ramp | Low launch edge/platform, not a tall ski-jump; tall adjacent ramps belong to other stadium props | A 1:28/32; B 0:14/16 | MEDIUM | 7m × 1.6m rise | Low eased 7m × 1m ramp |
| Rack distance | Long visually coherent wooden alley; airtime and sliding both possible | A 1:31/32; B 0:16 | HIGH qualitative | 100m lip to head pin | 90m first candidate; measure flight without retuning flight constants |
| Pin deck | Narrow contrasting wood surface, backstop, sign and side pyrotechnic framing | A 1:32; B 0:16 | HIGH | Broad 14m lane, small backdrop | Narrower 10m target deck, original large backboard/stands; preserve 1.5m pins |
| Arena scenery | Enclosing grandstands, lights, steel structures, big screens, unrelated stunt props and an open stadium floor | A/B all | HIGH | Tree-lined open strip, repeated portals | Original stadium seating tiers, light masts, scaffold towers, parked CC0 vehicles, service paddock |

## Estimated FlatOut proportions and uncertainty

| Inferred dimension | Estimate/range | Confidence | Evidence/method |
|---|---|---|---|
| Vehicle reference | 4–5m long, 1.8–2.1m wide | LOW | Generic full-size stunt coupe assumption, not an official vehicle dimension |
| Road width | 10–14m, roughly 5–7 vehicle widths | MEDIUM | A1:26 and B0:11 near vehicle/curb comparison |
| Starting deck height | 20–35m above arena | LOW | A1:23 drop relative to roadway width and repeated scaffold bays |
| Plateau ahead of car | 8–18m | LOW | B0:01–06, starting acceleration and car lengths |
| Hill run | 50–85m horizontal | LOW | B0:06–09, HUD 55→119→132km/h; crest/foot times are approximate |
| Hill mean angle | 20–30°; central grade roughly 30–40° | LOW | Drop/run range and A1:23 steep corridor perspective |
| Bottom easing | 8–20m | LOW | A1:24/B0:08–09 road curvature compared to car length |
| Exit rise | 0.5–1.5m over 8–16m | LOW | A1:24 raised horizon, B0:09 vehicle pitch; no surveyed mesh |
| Lower road to launch | 130–200m | LOW | B0:09–14 at 132–160km/h gives ~180–200m if real-time; discount slow-angle interval; A corroborates long lower straight |
| Balls | ~3–5m diameter; roughly 4–6 visible hazards across sequence | MEDIUM diameter / LOW exact count | B0:10/11 near car, A1:26; occlusion prevents definitive count |
| Group spacing | ~20–40m | LOW | Perspective scale and passage timing at 130km/h |
| Clear final approach | ~25–50m | LOW | A1:28 and B0:14, roughly 0.7–1.3 seconds at high speed, slow-motion timing uncertain |
| Launch rise/run | ~0–1.5m rise, 4–10m run; near full road width | LOW | A1:28/B0:14; visible low edge, no clearly measurable tall ramp |
| Lip to rack | ~80–140m | LOW | A1:31/32 alley proportions and B0:16 launch speed ~160km/h; not a measured complete flight |
| Rack deck elevation | Near arena floor, below elevated start and at/below launch edge | MEDIUM | A1:32 and B0:16 |
| Pin height | ~1.5–2.5m | LOW | Ragdoll/pin relative scale, distant perspective |
| Total spawn to backstop | ~280–420m | LOW | Sum of broad component ranges; not a survey |

## Deliberate adaptation

Our car is capped at 22m/s rather than footage speeds approaching 44m/s. Use 114m lower section rather than copying a speculative 180m, retain 90m flight corridor to preserve approved low-gravity flight and aftertouch. These are measured-gameplay design decisions, not FlatOut facts. The scene is a late-afternoon outdoor Party Lab stunt meet viewed from a desktop by casual local players; blue/teal structural paint, warm wood and amber launch marks retain its own visual language. Do not copy FlatOut graphics/signs/UI.

Obstacle destructibility and round-to-round source variation are NOT established. Party Lab's six authored static layouts and cosmetic ball breakup are explicitly its own replayability/performance adaptation. The balls will use physical chassis overlap and calibrated speed/heading consequence; no extra debris rigid bodies. No invention of an unverified barrel/crate course.
