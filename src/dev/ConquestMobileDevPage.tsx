/**
 * ConquestMobileDevPage — dev-only measurement harness for the Kuşatma
 * MOBILE gameplay shell.
 *
 * Why this exists: the real gameplay screen is behind a live Supabase room
 * with 2+ players and a host-authoritative clock, so iterating on layout by
 * playing real matches costs ~10 minutes per look.  This page mounts the
 * SAME components the mobile branch of ConquestGame renders
 * (MobileConquestLayout / MobileHeader / MobileScoreStrip / TurkeyConquestMap
 * / MobileBottomSheet / ConquestChallengePanel / ConquestActionPanel) against
 * frozen mock state, so every layout question can be answered in one reload.
 *
 * It is NOT a gameplay simulator — nothing here talks to the network, and no
 * rule is evaluated.  Treat divergence from real gameplay as a harness bug.
 *
 * Scenes (?scene=):
 *   challenge  — question phase, multiple choice
 *   typing     — question phase, free-text answer (keyboard case)
 *   action     — move phase ("Hamle sırası sende")
 *   result     — round result
 *   intro      — game-start "Kuşatma başlıyor" card
 *
 * Dev-only: main.tsx gates the import behind `import.meta.env.DEV`, so this
 * module and its chunk never exist in a production build.
 */

import { useEffect, useMemo, useState } from "react";
import "../App.css";

import MobileConquestLayout from "../modes/conquest/mobile/MobileConquestLayout";
import MobileHeader from "../modes/conquest/mobile/MobileHeader";
import MobileScoreStrip from "../modes/conquest/mobile/MobileScoreStrip";
import MobileBonusStrip from "../modes/conquest/mobile/MobileBonusStrip";
import MobileBottomSheet from "../modes/conquest/mobile/MobileBottomSheet";
import TurkeyConquestMap from "../modes/conquest/TurkeyConquestMap";
import ConquestMapViewport from "../modes/conquest/mobile/ConquestMapViewport";
import MobileJokerRail from "../modes/conquest/mobile/MobileJokerRail";
import MobileRotateHint from "../modes/conquest/mobile/MobileRotateHint";
import { buildMobileJokerEntries } from "../modes/conquest/mobile/mobileJokers";
import ConquestChallengePanel from "../modes/conquest/ConquestChallengePanel";
import ConquestActionPanel from "../modes/conquest/ConquestActionPanel";
import { useIsMobile } from "../lib/useIsMobile";
import { useGameplayOrientation } from "../lib/useGameplayOrientation";
import { TURKEY_CONQUEST_REGION_PATHS } from "../modes/conquest/maps/turkey-regions";
import { getBonusPoolEntry } from "../modes/conquest/bonusPool";
import type {
  ConquestChallengeState,
  ConquestPlayer,
  ConquestPlayerBonusState,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundBonusAssignment,
} from "../modes/conquest/types";

type Scene = "challenge" | "typing" | "action" | "result" | "intro";

const SCENES: Scene[] = ["challenge", "typing", "action", "result", "intro"];

// ── Mock match ───────────────────────────────────────────────────────────────

const PLAYERS: ConquestPlayer[] = [
  { id: "p1", name: "Enes",      isHost: true  },
  { id: "p2", name: "Zeynep",    isHost: false },
  { id: "p3", name: "Mehmet K.", isHost: false },
  { id: "p4", name: "Ayşe",      isHost: false },
];

const PLAYER_COLORS: Record<string, ConquestPlayerColor> = {
  p1: "blue", p2: "red", p3: "green", p4: "yellow",
};

const PLAYER_POINTS: Record<string, number> = { p1: 34, p2: 28, p3: 19, p4: 12 };
const REGION_COUNTS: Record<string, number> = { p1: 6, p2: 5, p3: 4, p4: 3 };

const ALL_REGION_IDS = TURKEY_CONQUEST_REGION_PATHS.map(r => r.id as ConquestRegionId);

/** Deterministic ownership spread so the map never renders all-neutral. */
const REGION_STATES: ConquestRegionState[] = ALL_REGION_IDS.map((regionId, i) => {
  const owner =
    i % 4 === 0 && i < 24 ? "p1" :
    i % 4 === 1 && i < 21 ? "p2" :
    i % 4 === 2 && i < 17 ? "p3" :
    i % 4 === 3 && i < 13 ? "p4" : null;
  return {
    regionId,
    ownerPlayerId: owner,
    shielded: regionId === "istanbul_kocaeli",
  };
});

/** Six bonus tiles spread across the map — the "joker" visibility case. */
const BONUS_PLACEMENT: Array<[string, string]> = [
  ["ankara_cevre",      "kahin"],
  ["guney_ege",         "liman"],
  ["dogu_karadeniz",    "karadeniz_extra_time"],
  ["istanbul_kocaeli",  "istanbul_defense"],
  ["kapadokya",         "eleme_yetkisi"],
  ["cukurova",          "cukurova_score"],
];
const ROUND_BONUS_MAP: ConquestRoundBonusAssignment = Object.fromEntries(
  BONUS_PLACEMENT,
) as ConquestRoundBonusAssignment;

const PLAYER_BONUSES: Record<string, ConquestPlayerBonusState> = {
  p1: {
    pendingHiddenShield: true,
    extraNextMoveMs: 5000,
    cukurovaClaimed: false,
    bonusPoints: 6,
    eliminatorCharges: 1,
    matchGoldEarned: 20,
  } as ConquestPlayerBonusState,
  p2: {
    pendingHiddenShield: false,
    extraNextMoveMs: 0,
    cukurovaClaimed: false,
    bonusPoints: 2,
  } as ConquestPlayerBonusState,
  p3: {} as ConquestPlayerBonusState,
  p4: {} as ConquestPlayerBonusState,
};

const LEGAL_TARGETS = new Set<ConquestRegionId>([
  "kapadokya", "orta_anadolu", "konya_karaman", "bati_akdeniz", "guney_ege",
]);

const BONUS_GUIDE_ENTRIES = BONUS_PLACEMENT.map(([regionId, type]) => {
  const entry = getBonusPoolEntry(type as never)!;
  return {
    regionId:    regionId as ConquestRegionId,
    regionLabel: regionId,
    def: {
      regionId:    regionId as ConquestRegionId,
      type:        entry.type,
      icon:        entry.icon,
      label:       entry.label,
      description: entry.description,
    },
  };
});

function makeChallenge(kind: "choices" | "text"): ConquestChallengeState {
  const now = Date.now();
  return {
    challenge: {
      id:          "c1",
      type:        "quiz",
      roundNumber: 3,
      title:       kind === "choices"
        ? "Hangi ülkenin başkenti Canberra'dır?"
        : "Bu bayrak hangi ülkeye ait?",
      prompt: kind === "choices" ? undefined : "Ülke adını yaz",
      eligiblePlayerIds: PLAYERS.map(p => p.id),
      choices: kind === "choices"
        ? ["Avustralya", "Yeni Zelanda", "Fiji", "Papua Yeni Gine"]
        : undefined,
      flag: kind === "text" ? "🇯🇵" : undefined,
    },
    status:         "active",
    winnerPlayerId: null,
    startedAt:      now - 6000,
    endsAt:         now + 14000,
  } as ConquestChallengeState;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ConquestMobileDevPage() {
  const params = new URLSearchParams(window.location.search);
  const initial = (params.get("scene") as Scene) ?? "challenge";
  const [scene, setScene] = useState<Scene>(
    SCENES.includes(initial) ? initial : "challenge",
  );
  const { isMobile, orientation } = useIsMobile();
  // Real hook, real code path: on web this must report "unsupported" and take
  // no native action, leaving the rotate hint as the whole fallback.
  const gameplayOrientation = useGameplayOrientation(isMobile);
  const [tick, setTick] = useState(0);

  // Keep the timers alive so the countdown bar renders a realistic width.
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  const challengeState = useMemo(
    () => makeChallenge(scene === "typing" ? "text" : "choices"),
    [scene],
  );
  const msRemaining = Math.max(0, challengeState.endsAt - Date.now());
  void tick;

  // Mirror the hook's verdict onto <html> so the headless probe can read it.
  useEffect(() => {
    document.documentElement.dataset.cqOrientation =
      `${gameplayOrientation.status}:${gameplayOrientation.isNative ? "native" : "web"}`;
  }, [gameplayOrientation.status, gameplayOrientation.isNative]);

  // Mirrors ConquestGame: the question panel is suppressed while the
  // game-start overlay owns the screen, so the intro scene must not render
  // a phase panel either or the harness would flatter the real layout.
  const dockMode: "panel" | "compact" =
    scene === "challenge" || scene === "typing" ? "panel" : "compact";
  const showPhasePanel = scene !== "intro";

  const jokerEntries = buildMobileJokerEntries({
    bonus:           PLAYER_BONUSES.p1,
    hasOpenShield:   true,
    hasHiddenShield: false,
    heldRegions: [
      { regionId: "ankara_cevre", regionLabel: "Ankara",    type: "kahin" },
      { regionId: "guney_ege",    regionLabel: "Güney Ege", type: "liman" },
    ],
  });

  const mapNode = (
    <TurkeyConquestMap
      regionStates={REGION_STATES}
      players={PLAYERS}
      playerColors={PLAYER_COLORS}
      legalTargetIds={scene === "action" ? LEGAL_TARGETS : new Set()}
      /* Always interactive in the harness, and every accepted selection is
         counted on `window.__cqTest` so the gesture check script can assert
         "a drag never selects a region" against the real component. */
      onRegionClick={() => {
        const t = (window as unknown as { __cqTest?: { regionClicks: number } });
        if (!t.__cqTest) t.__cqTest = { regionClicks: 0 };
        t.__cqTest.regionClicks += 1;
      }}
      roundBonuses={ROUND_BONUS_MAP}
      viewerIsHolder={scene === "action"}
    />
  );

  const phasePanel =
    scene === "action" ? (
      <ConquestActionPanel
        actionHolder={PLAYERS[0]}
        holderColor="blue"
        noMovesLeft={false}
        lastResult={null}
        msRemaining={12000}
        totalMs={20000}
        hasPendingHiddenShield
        onSkip={() => {}}
      />
    ) : scene === "result" ? (
      <section className="cq-round-result-panel">
        <div className="cq-rrc-icon">🏰</div>
        <div className="cq-rrc-title">Kapadokya fethedildi</div>
        <div className="cq-rrc-subtitle">Enes bölgeyi ele geçirdi (+5 puan)</div>
        <div className="cq-rrc-hint">Sonraki tur birazdan başlıyor…</div>
      </section>
    ) : (
      <ConquestChallengePanel
        challengeState={challengeState}
        players={PLAYERS}
        playerColors={PLAYER_COLORS}
        myPlayerId="p1"
        alreadyAnswered={false}
        msRemaining={msRemaining}
        onSubmitAnswer={() => {}}
        eliminatedChoice={scene === "challenge" ? "Fiji" : null}
      />
    );

  const scoreStrip = (
    <MobileScoreStrip
      players={PLAYERS}
      playerColors={PLAYER_COLORS}
      playerPoints={PLAYER_POINTS}
      regionCounts={REGION_COUNTS}
      playerBonuses={PLAYER_BONUSES}
      openShieldOwners={new Set(["p1"])}
      hiddenShieldOwners={new Set()}
      actionHolderId={scene === "action" ? "p1" : null}
      myPlayerId="p1"
      neutralCount={6}
      neutralPoints={21}
      kahinPreview={scene === "challenge" ? "Başkent" : null}
    />
  );

  const sheetHandle =
    scene === "action"  ? <strong>Hamle sırası sende</strong> :
    scene === "result"  ? <strong>Tur sonucu</strong> :
                          <strong>Soru — 14sn</strong>;

  const overlays = (
    <>
      {scene === "intro" && (
        /* Mirrors MobileToastSlot's real markup (.mcq-toast-slot >
           .mcq-toast.<className>) — the compact mobile intro sizing is
           scoped to that chain, so a bare div here would show desktop
           sizing and flatter the layout. */
        <div className="mcq-toast-slot" data-kind="game-intro">
          <div className="mcq-toast cq-duel-overlay-toast cq-game-intro-overlay">
            <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
            <div className="cq-bonus-toast-text">
              <div className="cq-bonus-toast-title">Kuşatma başlıyor</div>
              <div className="cq-bonus-toast-detail">
                Her turda bir soru sorulur. İlk doğru cevabı veren oyuncu hamle
                hakkını kazanır ve haritada bir bölgeyi fetheder. En çok puanı
                toplayan kazanır; bonus bölgeler ekstra güç verir.
              </div>
            </div>
          </div>
        </div>
      )}
      {orientation === "portrait" && showPhasePanel && (
        <MobileBottomSheet
          phaseKey={scene}
          state={scene === "result" ? "expanded" : "expanded"}
          dismissible
          handle={sheetHandle}
        >
          <div className="mcq-sheet-panel">{phasePanel}</div>
        </MobileBottomSheet>
      )}
    </>
  );

  return (
    <div className="app duel-screen cq-screen cq-game-screen" data-theme="conquest">
      <MeasureProbe />
      {params.get("measure") !== "1" && (
        <DevSceneSwitcher scene={scene} setScene={setScene} isMobile={isMobile} orientation={orientation} />
      )}
      <MobileConquestLayout
        orientation={orientation}
        header={
          <MobileHeader
            roundNumber={3}
            totalRounds={8}
            onBack={() => {}}
            onHelp={() => {}}
            helpActive={false}
            accountGold={1240}
          />
        }
        scoreStrip={scoreStrip}
        bonusStrip={
          orientation === "portrait"
            ? <MobileBonusStrip entries={BONUS_GUIDE_ENTRIES as never} />
            : undefined
        }
        jokerRail={
          <MobileJokerRail
            entries={jokerEntries}
            variant={orientation === "landscape" ? "rail" : "row"}
          />
        }
        map={<ConquestMapViewport>{mapNode}</ConquestMapViewport>}
        boardNote={
          orientation === "portrait"
            ? <MobileRotateHint
                visible={gameplayOrientation.status !== "locking"}
                matchKey={scene}
              />
            : undefined
        }
        dockMode={dockMode}
        dock={
          orientation === "landscape" && dockMode === "panel"
            ? <div className="mcq-dock-panel">{phasePanel}</div>
            : undefined
        }
        floating={
          orientation === "landscape" && dockMode === "compact" && showPhasePanel
            ? <div className="mcq-float-panel">{phasePanel}</div>
            : undefined
        }
        overlays={overlays}
      />
    </div>
  );
}

/**
 * Measurement probe — with `?measure=1` the page renders a JSON blob of the
 * key layout rects into `#cq-measure` so a `--dump-dom` run can read exact
 * numbers instead of eyeballing pixels.  `mapInk` is the SVG's real rendered
 * content box (getBBox mapped through the CTM), i.e. how much of the screen
 * the Türkiye landmass actually occupies — the number this whole exercise is
 * trying to move.
 */
function MeasureProbe() {
  const [json, setJson] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement | null;
      const r = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
          x: +b.x.toFixed(1), y: +b.y.toFixed(1),
          w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        };
      };
      const svg = q(".cq-turkey-map-svg") as unknown as SVGSVGElement | null;
      let mapInk = null;
      if (svg) {
        // Union the region fill paths only — FX layers and labels would
        // inflate the box past the landmass.
        const paths = Array.from(svg.querySelectorAll(".cq-map-region"));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of paths) {
          const b = (p as SVGGraphicsElement).getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top);
          x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
        }
        if (Number.isFinite(x0)) {
          mapInk = {
            x: +x0.toFixed(1), y: +y0.toFixed(1),
            w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1),
          };
        }
      }
      const vw = window.innerWidth, vh = window.innerHeight;
      const out = {
        viewport: { w: vw, h: vh },
        header:   r(q(".mcq-header")),
        strip:    r(q(".mcq-strip")),
        bonus:    r(q(".mcq-bonus-strip")),
        mapSlot:  r(q(".mcq-map-slot")),
        vp:       r(q(".mcq-mapvp")),
        vpInner:  r(q(".mcq-mapvp-inner")),
        mapWrap:  r(q(".cq-turkey-map-wrap")),
        svg:      r(q(".cq-turkey-map-svg")),
        dock:     r(q(".mcq-dock-slot")),
        sheet:    r(q(".mcq-sheet")),
        mapInk,
        mapInkPctOfViewport: mapInk
          ? +((mapInk.w * mapInk.h) / (vw * vh) * 100).toFixed(1)
          : null,
        wrapTransform: (() => {
          const el = q(".cq-turkey-map-wrap");
          return el ? getComputedStyle(el).transform : null;
        })(),
        orientationStatus: document.documentElement.dataset.cqOrientation ?? null,
        docScrollW: document.documentElement.scrollWidth,
        docScrollH: document.documentElement.scrollHeight,
      };
      setJson(JSON.stringify(out));
    }, 1200);
    return () => window.clearTimeout(id);
  }, []);
  return <pre id="cq-measure" style={{ display: "none" }}>{json}</pre>;
}

/** Tiny floating scene picker. Marked data-dev-ui so measurement scripts can
 *  exclude it from any layout assertion. */
function DevSceneSwitcher({
  scene, setScene, isMobile, orientation,
}: {
  scene: Scene;
  setScene: (s: Scene) => void;
  isMobile: boolean;
  orientation: string;
}) {
  return (
    <div
      data-dev-ui="scene-switcher"
      style={{
        position: "fixed", zIndex: 99999, bottom: 2, left: 2,
        display: "flex", gap: 3, alignItems: "center",
        font: "9px/1 monospace", background: "rgba(0,0,0,.75)",
        padding: "2px 4px", borderRadius: 4, color: "#9fb",
        pointerEvents: "auto",
      }}
    >
      <span style={{ color: "#ff0" }}>
        {window.innerWidth}×{window.innerHeight}
      </span>
      {SCENES.map(s => (
        <button
          key={s}
          onClick={() => setScene(s)}
          style={{
            font: "9px/1 monospace", padding: "3px 4px", cursor: "pointer",
            background: s === scene ? "#58a6ff" : "#222", color: s === scene ? "#000" : "#ccc",
            border: 0, borderRadius: 3,
          }}
        >
          {s}
        </button>
      ))}
      <span>{isMobile ? orientation : "desktop"}</span>
    </div>
  );
}
