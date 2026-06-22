---
target: Ülke Yaz mobil HUD (TopBar)
total_score: 24
p0_count: 1
p1_count: 4
timestamp: 2026-06-20T11-09-05Z
slug: src-app-tsx-ulkeyaz-mobile-hud-topbar
---
# Critique — Ülke Yaz mobil HUD (`TopBar`, `src/App.tsx` + `.control-bar` CSS)

Scope: single-player map-game control bar on mobile / narrow viewport (`.control-bar.gt-map-game`, ≤600px) + native. Register: product.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | On mobile `.gt-map-game .bar-bottom{display:none}` hides ✓/✗ feedback line; idle shows dead "0/197" |
| 2 | Match System / Real World | 3 | Turkish labels clear; "Serbest/Süreli" understandable |
| 3 | User Control and Freedom | 3 | Reset/Pas/Menü present; mode locked during timed play (correct) |
| 4 | Consistency and Standards | 2 | Mode expressed 3 ways; Süreli=red vs Serbest=blue; raw emoji vs EmojiIcon SVG system |
| 5 | Error Prevention | 3 | Input disabled until mode chosen; low-stakes reset |
| 6 | Recognition Rather Than Recall | 2 | Disabled input tells you to "choose a mode" but the control is elsewhere; mode state split |
| 7 | Flexibility and Efficiency | 2 | Gear→panel→nested dropdown to change duration/region; slow one-handed; no presets |
| 8 | Aesthetic and Minimalist Design | 2 | Equal-weight grey pills, dead input is largest element, no focal point — cold "map-tool" feel |
| 9 | Error Recovery | 3 | Wrong guess shakes input red, but text feedback hidden on mobile |
| 10 | Help and Documentation | 2 | `.map-hint{display:none}` on mobile; no first-run guidance beyond placeholder |
| **Total** | | **24/40** | **Needs work** |

## Anti-Patterns Verdict

**LLM assessment:** Not "AI slop" in the generic sense — it's a real, working, restrained dark bar. The failure is the product-register one: *strangeness without purpose* plus *inverted hierarchy*. The biggest, most prominent element in the idle state (the full-width 2px-bordered input) is disabled and dead; the real primary action (start) is two small `btn-sm` buttons, one of them red. The top row is a string of same-treatment grey pills (back / score / gear) with no focal point, which is exactly the "soğuk kurumsal/harita aracı" feeling PRODUCT.md lists as an anti-reference.

**Deterministic scan:** Unavailable — `detect.mjs` entrypoint exists but its bundled engine (`detector/detect-antipatterns.mjs`) is missing from this install; real attempt made twice, both exit 1. Substitute manual grep over the HUD scope found: **no** CSS absolute-ban signals in `.control-bar` (no gradient-text, side-stripe, glass, or gradients — good); **~20 raw emoji/glyph literals** in the `TopBar` JSX (⚙️ ✕ ✓ ✗ ← ∞ ⏱ 🌍 🔶 🏷️ 🎮 🟡) bypassing the project's EmojiIcon SVG system; **`btn-danger` (red) on the "Süreli" start button** (`App.tsx:1294`).

**Visual overlays:** None — no browser-automation tool in this session; no user-visible overlay was produced.

## Overall Impression

It works and it's clean, but it reads as a *settings toolbar with a disabled text field*, not as the entrance to a geography game. The single biggest opportunity: invert the inversion. In idle, the screen should sell "tap to start a round," not present a greyed-out box that says "pick a mode" while the mode control hides at the bottom. Everything else (warmth, segmented mode control, status on mobile) follows from fixing that.

## What's Working

- **Restraint is real.** No gradient text, no glass, no side-stripes, no fake-premium gradients in the bar CSS. The Tek Ses discipline mostly holds (blue identity, Bebas for numbers via `.score-n`/`.timer-num`). A clean base to build warmth onto.
- **The timer ring** (`.timer-ring-wrap` SVG) is a genuinely nice, legible status object — the one element with real character.
- **Single source of truth for settings.** The mobile gear panel re-renders the same `Dropdown`/`DDItem` and inherits disabled-during-play logic, so behavior stays consistent across breakpoints even though the layout differs.

## Priority Issues

**[P0] Inverted hierarchy: the dead input is the hero, the CTA is an afterthought.**
- Why it matters: In idle the full-width disabled `.guess-input` (opacity .38, "Önce bir mod seç") dominates the layout while the actual start action is two `btn-sm` buttons. Users look at the biggest thing first; here it does nothing. This is the root of "ana aksiyon netleşmiyor."
- Fix: In idle, drop or shrink the disabled input. Make a single prominent "Başla" the hero, paired with a Serbest/Süreli segmented toggle. The text input appears (and enables) only once a round starts.
- Suggested command: `layout` (then `onboard` for the idle/empty state).

**[P1] "Süreli" start is red (`btn-danger`).**
- Why it matters: Red is reserved for errors/destructive (DESIGN.md Tek Ses). On a start button it reads as "dangerous/stop," and pits the two modes against each other (safe blue vs scary red) instead of presenting them as peers. A first-timer can read red as "delete/cancel."
- Fix: Both modes share one neutral/identity treatment inside a segmented control; keep red for errors only.
- Suggested command: `colorize` (+ `clarify` for the labels).

**[P1] Mode / duration / region are fragmented across three surfaces.**
- Why it matters: "Serbest/Süreli" appears as start buttons (input row), as text in the read-only info chip, and as a dropdown in the gear panel. Region/duration live in both the chip and the panel. Three places to read one piece of state breaks single-source recognition and inflates the "equal weight / dağınık" feeling.
- Fix: One settings affordance + one segmented mode control. The info chip *reflects* current settings, it doesn't restate a control.
- Suggested command: `layout`.

**[P1] Equal-weight, cold top row with no focal point.**
- Why it matters: `.back-btn`, `.score-pill`, and the gear button all use `surface2` + `1.5px border` + muted text + pill/rounded shape. Nothing is primary, nothing is warm — the literal definition of the "soğuk harita aracı" anti-reference. The map behind it then reads as wallpaper, not playfield.
- Fix: Establish hierarchy (back recedes to a quiet icon; the start/score gets weight) and bring in the §1.2 warmth direction (warmer surface, one identity accent) so the bar feels like a game header.
- Suggested command: `bolder` / `colorize`.

**[P1] Status and help disappear on mobile — and feedback becomes color-only.**
- Why it matters: `.gt-map-game .bar-bottom{display:none}` removes the `✓ Doğru / ✗ Bulunamadı` line, the best-badge, and the name toggle on mobile; `.map-hint{display:none}` removes the hint. Correct/wrong then signals **only** via input border color (green/red) — which violates PRODUCT.md's "anlam asla yalnız renge dayanmaz" rule and fails colorblind users.
- Fix: Keep a compact, icon+text feedback affordance on mobile (e.g. a transient toast/inline chip), not a color-only border.
- Suggested command: `harden` (+ `clarify`).

**[P2] Raw emoji glyphs bypass the EmojiIcon SVG system.**
- Why it matters: ~20 raw literals (⚙️ ✕ ✓ ✗ ← ∞ ⏱ 🌍 …) render differently per OS — the exact inconsistency the project's EmojiIcon SVG layer was built to eliminate. Looks accidental and off-brand on some devices.
- Fix: Route HUD glyphs through `EmojiIcon` or inline stroke SVG (matching the LeaderboardModal compass/coin precedent).
- Suggested command: `polish`.

## Persona Red Flags

**Jordan (first-time casual, mobile):** Opens Ülke Yaz to a large greyed box reading "Önce bir mod seç" and two small buttons, one of them **red**. No hint (hidden on mobile). May read the red "Süreli" as cancel/stop, or stall not knowing Serbest vs Süreli. Confusion at step 1.

**Selin (one-handed commuter — project persona, "tek elle, boş vakitte"):** Wants a quick round on the bus. To change duration/region she must reach the **top-right** gear (hardest zone for a right thumb), open the panel, open a nested dropdown, then pick — 3+ taps in the worst reach zone. Friction against the "hızlı bir tur" job-to-be-done.

**Deniz (colorblind — PRODUCT.md AA target):** On mobile the ✓/✗ text is hidden; correct vs wrong is conveyed by green vs red input border only. Cannot reliably tell a right answer from a wrong one. Direct violation of the colorblind rule.

## Minor Observations

- Idle score pill shows "0/197" — dead information before a round; adds to top-row noise.
- "İsimler" (labels) toggle exists both in `.bar-bottom` (hidden on mobile) and the gear panel — duplicated control.
- Cross-surface: modal titles use Bebas Neue (display) while the rest of the UI is DM Sans; the HUD itself mostly follows "Sayılar Bebas, Cümleler DM," but the display↔body jump at modal boundaries is the font-inconsistency the brief flagged. Worth a dedicated `typeset` pass on the modal layer.
- The gear panel and desktop dropdowns are two layouts for the same settings — maintenance cost; a single responsive settings surface would be simpler.

## Questions to Consider

- What if idle showed one confident "Başla" with a segmented Serbest|Süreli toggle, and the text field only appeared once play began?
- Does the region/duration picker need to live in the HUD at all, or could it be a pre-round step so the in-game bar carries only score + timer + a quiet menu?
- What would the warmest honest version of this bar look like — game header, not settings toolbar — without breaking Tek Ses?
- If feedback couldn't use color at all, how would a player know they were right?
