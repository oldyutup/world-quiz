# FlatOut 2 evidence, researched before gameplay changes

Research date: 2026-09-27. Scope: LOCAL Human Bowling. No FlatOut assets or code imported.

## Sources

- **M**: [Official PC manual, printed p. 8 (PDF spread 5)](https://cdn.akamai.steamstatic.com/steam/apps/2990/manuals/manual_en.pdf). Primary documentation. Controls also appear on printed p. 3.
- **V**: [J4cobLIVE, FlatOut 2 Bowling / Kingpin gameplay](https://www.youtube.com/watch?v=REYK365FQ5E). Viewed in headed Chrome. Inspected timestamps: 0:44 approach, 1:09 launch instruction, 1:28 airborne strategy, 3:25 final-round rack approach. The achievement screen at 0:29 shows a 150-point perfect-score target. This is FlatOut 2, not Ultimate Carnage.
- **G**: [Grawl's 2006 PC walkthrough](https://gamefaqs.gamespot.com/pc/929089-flatout-2/faqs/44311), Bowling section. Recommends Nudge just before pins. Firsthand gameplay guide, not engine documentation.
- **D**: [FlatOut 2, ragdoll physics description](https://en.wikipedia.org/wiki/FlatOut_2#Ragdoll_physics). Secondary description of aerobatics drag and Nudge drag reduction; these particular statements lack a cited underlying technical source. Medium confidence, no numerical constants established.
- **R**: [GamesRadar contemporary review](https://www.gamesradar.com/flatout-2-review/2/). Describes fast run-up along a mostly straight track and Bowling's accuracy emphasis.
- **I**: [FlatOut 2 stunt video guide with inputs](https://steamcommunity.com/sharedfiles/filedetails/?id=3616763377&l=english). Discovered as corroborating player guidance, not used as proof of unseen video contents.

## Evidence table

FACT = directly documented or seen. INFERENCE = interpretation, not recovered engine behavior. ADAPTATION = our original numerical or structural choice.

| Mechanic | FlatOut 2 evidence | Source | Confidence | Previous Party Lab difference |
|---|---|---|---|---|
| Acceleration/run-up | FACT: fast runway approach, car determines general direction. | M, V 0:44, R | High | Existing downhill but obstacle losses recovered easily. |
| Trigger | FACT: hold launch in the launch area, release to eject. | M | High | Could start charging anywhere. |
| Angle | FACT: automatic increasing angle while held. | M, V 1:09 | High | Manual Up/Down angle choice. |
| Separate power | No independent launch-power control described or seen. INFERENCE: approach speed supplies energy; conversion formula unknown. | M, V | High for controls; medium for formula | Extra 0.6–14 m/s selected with a power meter. |
| Slow motion | FACT: holding launch slows action. Exact ratio unknown. | M | High | 0.4× already present. |
| Release timing | FACT: release selects angle. INFERENCE: release position/heading couples timing to trajectory. | M, V | High/medium | Power compensated for speed errors. |
| Aerobatics | FACT: four directional inputs provide limited trajectory correction. | M, V 1:28 | High | Broad correction allowance. |
| Drag | Reported: excessive correction slows the driver and can cause shortfall. | D | Medium | Correction nearly free. |
| Nudge | FACT: one small upward action per launch. Reported: slight drag reduction. | M, D; V/G for late-rack strategy | High upward/once; medium drag | Missing. |
| Landing/slide | FACT: rotating loose body, descending rack entry. Ground-friction formula and ideal slide length unverified. | V 3:25 | High visual; low coefficients | Existing physical impact/slide retained. |
| Pins | FACT: physical body/pin collisions; guide favors upper head-pin contact and late Nudge. | V, G | High observation; strategy not universal | Close, light pins generated broad cascades. |
| Rounds/scoring | FACT: HUD shows 1/5 and 5/5, ten pins, 150 perfect-score target. Exact spare/bonus accounting not fully verified. | V | High observed displays | Three fresh racks, raw total /30. |
| Obstacles/course | FACT: stadium runway, near-course structures/props, stop edge, lane/rack beyond. INFERENCE: approach precision and retained speed matter; exact collision losses unknown. | V 0:44, 1:09 | High layout, medium role | Both ±2.8 m bypasses stayed clear on every seed. |

## Decisions made before implementation

Remove independent power and manual launch-angle selection. Keep the existing fixed-step bullet clock; start its preparation on a valid hold. Base ejection on measured car velocity. Add directional physical posture control with explicit drag and one upward Nudge. Preserve loose joints, tumble and ground momentum. Measure runway/rack timing rather than claiming a metre-for-metre replica.

The harder difficulty requirement is a **Party Lab adaptation**. V demonstrates a repeatable strike strategy; research does not support claiming that original FlatOut 2 cannot be solved. Exact deterministic inputs can still reproduce our physical outcome. The validation target is that a forgiving straight-line recipe does not produce routine strikes across readable layouts and realistic timing variation.

## Deliberate differences

Original Party Lab/Kenney art and sounds; no copied logos, textures, graphics or physics code. SPACE replaces CTRL. Three alternating local throws and raw pin totals remain for short matches, unlike the observed five-round event. No online, career, gear selection, vehicle upgrades or FlatOut scoring bonuses. Our speed gain, gravity, angle range/rate, drag, Nudge, obstacles, pin mass and friction are original tuning values, not verified FlatOut constants. No source establishes a real 100 m rack distance; the retained distance is justified only by measured 3–6 second flight windows.
