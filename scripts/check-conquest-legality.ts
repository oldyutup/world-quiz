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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
