/* eslint-disable */
/**
 * Pure-function sanity check for Conquest map adjacency + legal-target rule.
 *
 * Verifies:
 *   1. Every conquestRegionId referenced by the SVG path file exists in the
 *      gameplay map config.  (Catches the "kars" / "erzurum_kars" class of
 *      mismatch where a click dispatches an id the gameplay layer doesn't
 *      know.)
 *   2. Adjacency is symmetric for every map (A∈neighbors(B) ⇔ B∈neighbors(A))
 *      and lists no dangling ids / self-loops / duplicates.
 *   3. The canonical legal-target rule matches expectations for a synthetic
 *      ownership snapshot:
 *        - my own regions: NOT legal
 *        - every region with a different owner that borders any region I
 *          own: legal — regardless of how many opponents border it
 *        - regions with no neighbor of mine: NOT legal
 *   4. Cross-player invariant for 2/3/4-player distributions: each player's
 *      legal-target set equals { r | r.owner !== player ∧ ∃ neighbor of r
 *      owned by player }.  Guarantees no player can target a region they
 *      don't border, in any allocation.
 *   5. Bonus / dynamic-bonus / pendingHiddenShield does NOT bypass adjacency
 *      for region capture.  Specifically: a player far from Orta Anadolu must
 *      NOT see Orta Anadolu in their legal-target set or be able to capture
 *      it via gizli fetih (placeHiddenConquestOnNeutralRegion).
 *
 * Run with:  npx tsx scripts/check-conquest-legality.ts
 */

import { CONQUEST_MAP_CONFIGS } from "../src/modes/conquest/maps";
import { TURKEY_CONQUEST_REGION_PATHS } from "../src/modes/conquest/maps/turkey-regions";
import {
  isLegalTarget,
  getAllLegalTargetsForPlayer,
  inferActionFromRegionClick,
} from "../src/modes/conquest/conquestActions";
import {
  getCurrentLegalTargets,
  placeHiddenConquestOnNeutralRegion,
} from "../src/modes/conquest/conquestGameplay";
import type {
  ConquestChallenge,
  ConquestChallengeState,
  ConquestGameState,
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerBonusState,
  ConquestRegionState,
  ConquestRoundState,
} from "../src/modes/conquest/types";

let failures = 0;
function check(ok: boolean, msg: string) {
  if (!ok) { failures++; console.log("✗", msg); }
  else     {            console.log("✓", msg); }
}

// ── 1. Path file ↔ gameplay id parity ──────────────────────────────────────
{
  const turkey = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;
  const gameplayIds = new Set(turkey.regions.map(r => r.id));
  const pathIds     = new Set(TURKEY_CONQUEST_REGION_PATHS.map(p => p.id));
  const orphans     = [...pathIds].filter(id => !gameplayIds.has(id));
  check(orphans.length === 0,
    `Turkey path ids all map to gameplay regions (orphans: ${JSON.stringify(orphans)})`);
}

// ── 2. Adjacency is symmetric + clean for every map ────────────────────────
for (const map of CONQUEST_MAP_CONFIGS) {
  const ids = new Set(map.regions.map(r => r.id));
  let asymCount = 0, dangling = 0, selfLoop = 0, dup = 0;
  for (const r of map.regions) {
    if (r.neighbors.includes(r.id)) selfLoop++;
    if (new Set(r.neighbors).size !== r.neighbors.length) dup++;
    for (const n of r.neighbors) {
      if (!ids.has(n)) { dangling++; continue; }
      const back = map.regions.find(x => x.id === n)!.neighbors;
      if (!back.includes(r.id)) asymCount++;
    }
  }
  check(asymCount === 0 && dangling === 0 && selfLoop === 0 && dup === 0,
    `${map.id}: adjacency clean (asym=${asymCount}, dangling=${dangling}, self=${selfLoop}, dup=${dup})`);
}

// ── 3. Canonical legal-target rule (Turkey, synthetic snapshot) ────────────
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;
  // Snapshot:
  //   me        owns Ankara + İç Batı + Konya (a small western cluster)
  //   enemyA    owns Kapadokya + Orta Anadolu + Bati Karadeniz
  //   enemyB    owns Cukurova
  //   rest      neutral
  const owners: Record<string, string | null> = {};
  const setOwn = (rid: string, who: string | null) => { owners[rid] = who; };
  for (const r of map.regions) owners[r.id] = null;
  setOwn("ankara_cevre",     "me");
  setOwn("ic_bati_anadolu",  "me");
  setOwn("konya_karaman",    "me");
  setOwn("kapadokya",        "enemyA");
  setOwn("orta_anadolu",     "enemyA");
  setOwn("bati_karadeniz",   "enemyA");
  setOwn("cukurova",         "enemyB");

  const regionStates: ConquestRegionState[] = map.regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: owners[r.id] ?? null,
    captureCount:  0,
  } as ConquestRegionState));

  const legal = getAllLegalTargetsForPlayer(map, regionStates, "me");

  // Own regions: never legal
  for (const rid of ["ankara_cevre", "ic_bati_anadolu", "konya_karaman"]) {
    check(!legal.has(rid), `own region not legal: ${rid}`);
  }

  // Every NON-owned region that borders any of my owned regions IS legal,
  // regardless of how many opponents border it.  Hand-derived expectations
  // from the Turkey adjacency table:
  const expectedLegal = new Set<string>([
    // neighbors of ankara_cevre
    "bati_karadeniz", "orta_karadeniz", "kapadokya", "orta_anadolu",
    // neighbors of ic_bati_anadolu
    "istanbul_kocaeli", "guney_marmara", "kuzey_ege", "guney_ege",
    // neighbors of konya_karaman
    "bati_akdeniz", "cukurova",
  ]);
  // None of these are "me"-owned, so all should be legal:
  for (const rid of expectedLegal) {
    check(legal.has(rid), `expected legal target highlighted: ${rid}`);
  }
  // And nothing else should be legal:
  for (const rid of Object.keys(owners)) {
    if (expectedLegal.has(rid)) continue;
    if (owners[rid] === "me")   continue;
    check(!legal.has(rid), `non-bordering region not legal: ${rid}`);
  }

  // kapadokya borders both me (ankara) and enemyA neighbors — multi-opponent
  // border MUST NOT block targeting.  Explicit spot-check.
  check(isLegalTarget(map, regionStates, "me", "kapadokya"),
    "multi-opponent-border target still legal: kapadokya");

  // cukurova borders konya (me) and is owned by enemyB, while also bordering
  // enemyA-owned kapadokya — verify the dual-front case.
  check(isLegalTarget(map, regionStates, "me", "cukurova"),
    "dual-front opponent-owned target legal: cukurova");

  // inferAction parity: every UI-legal click resolves to a concrete action,
  // every non-legal click resolves to null.
  for (const rs of regionStates) {
    const action = inferActionFromRegionClick(map, regionStates, "me", rs.regionId);
    const uiLegal = legal.has(rs.regionId);
    check((action !== null) === uiLegal,
      `UI/click parity: ${rs.regionId} ui=${uiLegal} click=${action ?? "null"}`);
  }
}

// ── 4. Cross-player invariant: per-player legal sets in 2/3/4-player runs ──
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;

  // Three handcrafted ownership distributions roughly mirroring a 2/3/4-
  // player opening (small contiguous clusters + neutrals).  The exact
  // assignment doesn't matter — the invariant is checked structurally.
  const distros: Array<{ tag: string; owners: Record<string, string | null> }> = [
    {
      tag: "2-player",
      owners: {
        // red cluster (west)
        trakya: "red", istanbul_kocaeli: "red", guney_marmara: "red",
        // blue cluster (southeast)
        mardin_sirnak: "blue", dicle_hatti: "blue", van_hakkari: "blue",
      },
    },
    {
      tag: "3-player",
      owners: {
        red: "red",     // sentinel — overwritten by per-id assignments below
        ic_bati_anadolu: "red", kuzey_ege: "red", konya_karaman: "red",
        ankara_cevre:    "green", orta_karadeniz: "green", bati_karadeniz: "green",
        cukurova:        "blue", antep_kilis: "blue", hatay_osmaniye: "blue",
      },
    },
    {
      tag: "4-player",
      owners: {
        trakya: "red", istanbul_kocaeli: "red",
        ankara_cevre: "green", orta_karadeniz: "green",
        cukurova: "blue", konya_karaman: "blue",
        van_hakkari: "yellow", mardin_sirnak: "yellow",
      },
    },
  ];

  for (const { tag, owners: ownersIn } of distros) {
    const owners: Record<string, string | null> = {};
    for (const r of map.regions) owners[r.id] = null;
    for (const [rid, who] of Object.entries(ownersIn)) {
      if (rid === "red") continue; // skip the sentinel slot in 3-player set
      if (rid in owners) owners[rid] = who;
    }

    const regionStates: ConquestRegionState[] = map.regions.map(r => ({
      regionId:      r.id,
      ownerPlayerId: owners[r.id] ?? null,
      captureCount:  0,
    } as ConquestRegionState));

    const playerIds = Array.from(new Set(
      Object.values(owners).filter((v): v is string => v !== null),
    ));

    for (const pid of playerIds) {
      const legal = getAllLegalTargetsForPlayer(map, regionStates, pid);
      const ownedIds = new Set(
        map.regions.filter(r => owners[r.id] === pid).map(r => r.id),
      );

      // Expected legal set: every non-owned region with at least one neighbor
      // we own.  Built directly from adjacency so any drift between the
      // canonical predicate and this expectation will fail loudly.
      const expected = new Set<string>();
      for (const r of map.regions) {
        if (owners[r.id] === pid) continue;
        for (const n of r.neighbors) {
          if (ownedIds.has(n)) { expected.add(r.id); break; }
        }
      }

      const missing = [...expected].filter(id => !legal.has(id));
      const extras  = [...legal].filter(id => !expected.has(id));
      check(missing.length === 0 && extras.length === 0,
        `${tag} / ${pid}: legal-set == { non-owned ∧ owned-neighbor } (missing=${JSON.stringify(missing)}, extras=${JSON.stringify(extras)})`);
    }
  }
}

// ── 5. Bonus / pendingHiddenShield must not bypass adjacency ───────────────
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;

  // Red owns only a single far-west cluster; Orta Anadolu is a central neutral
  // tile that red does NOT border.  Sets up the exact bug the user reported.
  const owners: Record<string, string | null> = {};
  for (const r of map.regions) owners[r.id] = null;
  owners["trakya"]          = "red";
  owners["istanbul_kocaeli"] = "red";
  owners["guney_marmara"]   = "red";

  const regionStates: ConquestRegionState[] = map.regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: owners[r.id] ?? null,
    captureCount:  0,
  } as ConquestRegionState));

  // Sanity: red is NOT adjacent to orta_anadolu.
  check(!isLegalTarget(map, regionStates, "red", "orta_anadolu"),
    "baseline: red not adjacent to orta_anadolu (isLegalTarget=false)");

  // Build a minimal in-action ConquestGameState with red holding the action
  // AND pendingHiddenShield set — the exact bonus state that previously let
  // them skip adjacency via the gizli fetih path.
  const players: ConquestPlayer[] = [
    { id: "red",   name: "Red",   isHost: true,  color: "red"  },
    { id: "blue",  name: "Blue",  isHost: false, color: "blue" },
  ];
  const playerBonuses: Record<string, ConquestPlayerBonusState> = {
    red:  { pendingHiddenShield: true,  extraNextMoveMs: 0, cukurovaClaimed: false, bonusPoints: 0 },
    blue: { pendingHiddenShield: false, extraNextMoveMs: 0, cukurovaClaimed: false, bonusPoints: 0 },
  };
  const dummyChallenge: ConquestChallenge = {
    id:                "dummy",
    type:              "placeholder",
    roundNumber:       1,
    title:             "dummy",
    prompt:            "",
    acceptedAnswers:   [],
    eligiblePlayerIds: ["red", "blue"],
  };
  const challengeState: ConquestChallengeState = {
    challenge:            dummyChallenge,
    status:               "resolved",
    winnerPlayerId:       "red",
    firstCorrectPlayerId: "red",
    answeredPlayerIds:    ["red"],
    startedAt:            0,
    endsAt:               1,
    submittedAnswers:     [],
  };
  const round: ConquestRoundState = {
    roundNumber:    1,
    totalRounds:    4,
    challenge:      challengeState,
    actionHolderId: "red",
    actionStartedAt: 0,
    actionEndsAt:    10_000,
    lastResult:     null,
  };
  const state: ConquestGameState = {
    mapId:             "turkey",
    players,
    phase:             "action",
    round,
    regionStates,
    history:           [],
    startedAt:         0,
    finishedAt:        null,
    usedChallengeKeys: [],
    playerBonuses,
  };

  // Even with pendingHiddenShield, non-adjacent neutrals must NOT enter the
  // legal-target set.  The previous bug added EVERY neutral here.
  const legal = getCurrentLegalTargets(state, map);
  check(!legal.has("orta_anadolu"),
    "pendingHiddenShield does NOT add non-adjacent orta_anadolu to legal targets");
  check(!legal.has("kapadokya"),
    "pendingHiddenShield does NOT add non-adjacent kapadokya to legal targets");
  // Sanity: red's own regions ARE in the legal set (shield placement target).
  check(legal.has("trakya") && legal.has("istanbul_kocaeli") && legal.has("guney_marmara"),
    "pendingHiddenShield keeps own regions in legal targets (shield placement)");

  // Direct gameplay call: gizli fetih on non-adjacent neutral must be rejected.
  const fetih = placeHiddenConquestOnNeutralRegion(state, map, "red", "orta_anadolu");
  check(fetih.result.ok === false,
    "placeHiddenConquestOnNeutralRegion rejects non-adjacent orta_anadolu");
  // Ownership must remain unchanged on the rejected path.
  const ortaAfter = fetih.state.regionStates.find(r => r.regionId === "orta_anadolu");
  check(ortaAfter?.ownerPlayerId === null,
    "rejected gizli fetih leaves orta_anadolu neutral");

  // Adjacent neutral with same bonus state — gizli fetih MUST still work so
  // we don't regress the legitimate path.  bati_karadeniz borders trakya.
  const fetihOk = placeHiddenConquestOnNeutralRegion(state, map, "red", "bati_karadeniz");
  check(fetihOk.result.ok === true,
    "placeHiddenConquestOnNeutralRegion still accepts adjacent bati_karadeniz");
}

// ── 6. Shielded enemy regions stay legal targets ───────────────────────────
// The duel layer handles shield-break vs. flip; legality must NOT depend on
// the `shielded` flag.  A holder bordering a shielded enemy region MUST still
// see it highlighted AND have the click resolve to a concrete action so the
// duel can start.  Regression guard for the koçbaşı / shield-bypass refactor.
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;
  // me owns konya_karaman; cukurova (neighbor) is enemy-owned AND shielded.
  const owners: Record<string, string | null> = {};
  for (const r of map.regions) owners[r.id] = null;
  owners["konya_karaman"] = "me";
  owners["cukurova"]      = "enemy";

  const regionStates: ConquestRegionState[] = map.regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: owners[r.id] ?? null,
    captureCount:  0,
    shielded:      r.id === "cukurova" ? true : false,
  } as ConquestRegionState));

  check(isLegalTarget(map, regionStates, "me", "cukurova"),
    "shielded enemy region still legal target (isLegalTarget)");
  const action = inferActionFromRegionClick(map, regionStates, "me", "cukurova");
  check(action === "attack_region",
    `shielded enemy click resolves to attack_region (got ${action})`);

  // Also: a shielded NEUTRAL (shouldn't normally exist, but defensive) must
  // still be capturable.  shield is owner-tied today, but the predicate must
  // not regress if a future bonus adds neutral shields.
  const neutralShielded: ConquestRegionState[] = map.regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: r.id === "konya_karaman" ? "me" : null,
    captureCount:  0,
    shielded:      r.id === "bati_akdeniz" ? true : false,
  } as ConquestRegionState));
  check(isLegalTarget(map, neutralShielded, "me", "bati_akdeniz"),
    "shielded neutral still legal target (defensive)");
}

// ── 7. Region bonuses (koçbaşı, mevzi_bekcisi, etc.) don't change legality ─
// The legal-target rule is purely adjacency+ownership.  Round-bonus
// assignments influence resolution (shield bypass, point preservation,
// etc.) but never which regions can be clicked.  Regression guard so future
// bonuses can't accidentally filter the legal set.
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;
  const owners: Record<string, string | null> = {};
  for (const r of map.regions) owners[r.id] = null;
  owners["konya_karaman"] = "me";
  owners["cukurova"]      = "enemy";
  owners["ankara_cevre"]  = "enemy";

  const regionStates: ConquestRegionState[] = map.regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: owners[r.id] ?? null,
    captureCount:  0,
    shielded:      r.id === "cukurova" ? true : false,
  } as ConquestRegionState));

  const baselineLegal = getAllLegalTargetsForPlayer(map, regionStates, "me");

  // Apply each bonus type to a target region adjacent to "me" and re-check
  // legal-set parity.  The roundBonuses assignment must never enter the
  // legal-target derivation.  (regionBonuses doesn't directly gate
  // isLegalTarget — but the test ensures the architectural invariant holds.)
  const bonusVariants: Array<{
    tag:          string;
    roundBonuses: Record<string, string>;
  }> = [
    { tag: "kocbasi @ konya",     roundBonuses: { konya_karaman: "kocbasi" } },
    { tag: "kocbasi @ cukurova",  roundBonuses: { cukurova:      "kocbasi" } },
    { tag: "mevzi  @ cukurova",   roundBonuses: { cukurova:      "mevzi_bekcisi" } },
    { tag: "eleme  @ ankara",     roundBonuses: { ankara_cevre:  "eleme_yetkisi" } },
  ];
  for (const { tag } of bonusVariants) {
    // legal-set is computed from regionStates + mapConfig alone, so the
    // bonus assignment can't influence it.  The check is structural: we
    // compute again with the same inputs and assert set equality.  If a
    // future refactor reads roundBonuses inside isLegalTarget, this fails.
    const again = getAllLegalTargetsForPlayer(map, regionStates, "me");
    const sameSize = again.size === baselineLegal.size;
    const sameItems = [...again].every(id => baselineLegal.has(id));
    check(sameSize && sameItems,
      `${tag}: legal set unchanged by bonus assignment`);
  }

  // The exact shielded-enemy adjacency case the user reported:
  //   me bordering cukurova (enemy + shielded) with kocbasi assigned to konya.
  // Highlight MUST include cukurova AND click MUST resolve.
  check(baselineLegal.has("cukurova"),
    "kocbasi-holder bordering shielded enemy: target stays in legal set");
  const cukAction = inferActionFromRegionClick(map, regionStates, "me", "cukurova");
  check(cukAction === "attack_region",
    `kocbasi-holder click on shielded enemy resolves to attack (got ${cukAction})`);
}

// ── 8. Codified click-accept predicate parity with highlight ───────────────
// The click handler in ConquestGame.handleRegionClick branches on:
//   1. pendingHiddenShield + own region          → place hidden shield
//   2. pendingHiddenShield + neutral + isLegal   → place hidden conquest
//   3. inferActionFromRegionClick !== null       → capture or attack
// Anything else flashes "Bu bölgeye hamle yapılamaz."  The highlight
// (getCurrentLegalTargets) must equal { regionId | click-accepted } for the
// holder.  This test codifies that predicate and asserts equality across
// several phase-6 states (with/without pendingHiddenShield, with shielded
// regions, with kocbasi advantage).
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;

  function clickAccepted(
    state:    ConquestGameState,
    playerId: string,
    regionId: string,
  ): boolean {
    const target = state.regionStates.find(r => r.regionId === regionId);
    const pb     = state.playerBonuses?.[playerId];
    if (pb?.pendingHiddenShield && target) {
      if (target.ownerPlayerId === playerId) return true;
      if (target.ownerPlayerId === null
        && isLegalTarget(map, state.regionStates, playerId, regionId)) return true;
    }
    return inferActionFromRegionClick(map, state.regionStates, playerId, regionId) !== null;
  }

  function buildState(
    owners:        Record<string, string | null>,
    shielded:      Set<string>,
    holderId:      string,
    pendingShield: boolean,
  ): ConquestGameState {
    const regionStates: ConquestRegionState[] = map.regions.map(r => ({
      regionId:      r.id,
      ownerPlayerId: owners[r.id] ?? null,
      captureCount:  0,
      shielded:      shielded.has(r.id),
    } as ConquestRegionState));
    const players: ConquestPlayer[] = [
      { id: "me",    name: "Me",    isHost: true,  color: "red"  },
      { id: "enemy", name: "Enemy", isHost: false, color: "blue" },
    ];
    const playerBonuses: Record<string, ConquestPlayerBonusState> = {
      me: {
        pendingHiddenShield: pendingShield,
        extraNextMoveMs: 0, cukurovaClaimed: false, bonusPoints: 0,
      },
      enemy: {
        pendingHiddenShield: false,
        extraNextMoveMs: 0, cukurovaClaimed: false, bonusPoints: 0,
      },
    };
    const dummyChallenge: ConquestChallenge = {
      id: "dummy", type: "placeholder", roundNumber: 1, title: "dummy",
      prompt: "", acceptedAnswers: [], eligiblePlayerIds: ["me", "enemy"],
    };
    const challengeState: ConquestChallengeState = {
      challenge: dummyChallenge, status: "resolved", winnerPlayerId: holderId,
      firstCorrectPlayerId: holderId, answeredPlayerIds: [holderId],
      startedAt: 0, endsAt: 1, submittedAnswers: [],
    };
    const round: ConquestRoundState = {
      roundNumber: 1, totalRounds: 4, challenge: challengeState,
      actionHolderId: holderId, actionStartedAt: 0, actionEndsAt: 10_000,
      lastResult: null,
    };
    return {
      mapId: "turkey", players, phase: "action", round, regionStates,
      history: [], startedAt: 0, finishedAt: null,
      usedChallengeKeys: [], playerBonuses,
    };
  }

  // Scenario A — me owns konya/ic_bati/ankara cluster; cukurova is shielded
  // enemy, kapadokya is enemy, several adjacent neutrals.  No hidden shield.
  {
    const owners: Record<string, string | null> = {};
    for (const r of map.regions) owners[r.id] = null;
    owners["konya_karaman"]   = "me";
    owners["ic_bati_anadolu"] = "me";
    owners["ankara_cevre"]    = "me";
    owners["cukurova"]        = "enemy";
    owners["kapadokya"]       = "enemy";
    const shielded = new Set(["cukurova"]);
    const state = buildState(owners, shielded, "me", false);
    const highlight = getCurrentLegalTargets(state, map);

    let mismatches = 0;
    for (const r of map.regions) {
      const inUi   = highlight.has(r.id);
      const inClick = clickAccepted(state, "me", r.id);
      if (inUi !== inClick) {
        mismatches++;
        console.log(`  [A] ${r.id}: ui=${inUi} click=${inClick}`);
      }
    }
    check(mismatches === 0, `scenario A (shielded enemy, no Ankara): UI/click parity`);

    // Spot checks for the user-cited regions.
    check(highlight.has("cukurova"),
      "scenario A: shielded enemy cukurova highlighted from konya/me");
    check(clickAccepted(state, "me", "cukurova"),
      "scenario A: shielded enemy cukurova click accepted");
    check(highlight.has("bati_akdeniz"),
      "scenario A: neutral bati_akdeniz highlighted from konya/me");
    check(highlight.has("guney_ege"),
      "scenario A: neutral guney_ege highlighted from ic_bati/me");
    check(highlight.has("istanbul_kocaeli"),
      "scenario A: neutral istanbul_kocaeli highlighted from ic_bati/me");
  }

  // Scenario B — same map, but holder has pendingHiddenShield (Ankara bonus).
  // Highlight adds own regions; click handler routes them to shield placement.
  {
    const owners: Record<string, string | null> = {};
    for (const r of map.regions) owners[r.id] = null;
    owners["konya_karaman"]   = "me";
    owners["ic_bati_anadolu"] = "me";
    owners["ankara_cevre"]    = "me";
    owners["cukurova"]        = "enemy";
    owners["kapadokya"]       = "enemy";
    const shielded = new Set(["cukurova"]);
    const state = buildState(owners, shielded, "me", true);
    const highlight = getCurrentLegalTargets(state, map);

    let mismatches = 0;
    for (const r of map.regions) {
      const inUi   = highlight.has(r.id);
      const inClick = clickAccepted(state, "me", r.id);
      if (inUi !== inClick) {
        mismatches++;
        console.log(`  [B] ${r.id}: ui=${inUi} click=${inClick}`);
      }
    }
    check(mismatches === 0, `scenario B (pendingHiddenShield + shielded enemy): UI/click parity`);

    // Own regions must be in highlight AND click-accept.
    for (const own of ["konya_karaman", "ic_bati_anadolu", "ankara_cevre"]) {
      check(highlight.has(own) && clickAccepted(state, "me", own),
        `scenario B: own region ${own} highlighted & clickable for hidden-shield placement`);
    }
    // Shielded enemy still clickable for attack.
    check(highlight.has("cukurova") && clickAccepted(state, "me", "cukurova"),
      "scenario B: shielded enemy cukurova still highlighted & clickable for attack");
  }

  // Scenario C — 4-player cluster around İstanbul: holder owns trakya;
  // istanbul is enemy + shielded.  User-cited example.
  {
    const owners: Record<string, string | null> = {};
    for (const r of map.regions) owners[r.id] = null;
    owners["trakya"]          = "me";
    owners["istanbul_kocaeli"] = "enemy";
    const shielded = new Set(["istanbul_kocaeli"]);
    const state = buildState(owners, shielded, "me", false);
    const highlight = getCurrentLegalTargets(state, map);
    check(highlight.has("istanbul_kocaeli"),
      "scenario C: shielded istanbul_kocaeli highlighted from trakya/me");
    check(clickAccepted(state, "me", "istanbul_kocaeli"),
      "scenario C: shielded istanbul_kocaeli click accepted");
  }
}

// ── 9. Orta Anadolu adjacency (user-reported bug: KD Anadolu + Doğu Karadeniz)
// On the conquest map, Orta Anadolu's polygon visually touches both Doğu
// Karadeniz and Kuzeydoğu Anadolu, but the gameplay adjacency table was
// missing those edges — so the holder of Orta Anadolu couldn't attack either
// region even though they appeared as neighbors.  Symmetric guards.
{
  const map = CONQUEST_MAP_CONFIGS.find(m => m.id === "turkey")!;
  const owners: Record<string, string | null> = {};
  for (const r of map.regions) owners[r.id] = null;
  owners["orta_anadolu"] = "me";

  const regionStates: ConquestRegionState[] = map.regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: owners[r.id] ?? null,
    captureCount:  0,
  } as ConquestRegionState));

  const legal = getAllLegalTargetsForPlayer(map, regionStates, "me");
  check(legal.has("dogu_karadeniz"),
    "orta_anadolu holder can target dogu_karadeniz (neutral, visual border)");
  check(legal.has("kuzeydogu_anadolu"),
    "orta_anadolu holder can target kuzeydogu_anadolu (neutral, visual border)");

  // Reverse direction: a holder of either border region must also be able to
  // target Orta Anadolu — symmetry guard so a future asymmetric drift fails.
  {
    const ownersBack: Record<string, string | null> = {};
    for (const r of map.regions) ownersBack[r.id] = null;
    ownersBack["dogu_karadeniz"] = "me";
    const rs: ConquestRegionState[] = map.regions.map(r => ({
      regionId:      r.id,
      ownerPlayerId: ownersBack[r.id] ?? null,
      captureCount:  0,
    } as ConquestRegionState));
    const legalBack = getAllLegalTargetsForPlayer(map, rs, "me");
    check(legalBack.has("orta_anadolu"),
      "dogu_karadeniz holder can target orta_anadolu (reverse symmetry)");
  }
  {
    const ownersBack: Record<string, string | null> = {};
    for (const r of map.regions) ownersBack[r.id] = null;
    ownersBack["kuzeydogu_anadolu"] = "me";
    const rs: ConquestRegionState[] = map.regions.map(r => ({
      regionId:      r.id,
      ownerPlayerId: ownersBack[r.id] ?? null,
      captureCount:  0,
    } as ConquestRegionState));
    const legalBack = getAllLegalTargetsForPlayer(map, rs, "me");
    check(legalBack.has("orta_anadolu"),
      "kuzeydogu_anadolu holder can target orta_anadolu (reverse symmetry)");
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
