/**
 * QA-ONLY · Kuşatma map-rect phase-invariance harness entry.
 *
 * Standalone vite entry that mounts the REAL ConquestGame (real component tree,
 * real desktop shell + safe-stage geometry hook + real phase panels) across the
 * 5 gameplay phases and exposes the map-rect measurement on <body>.  Driven by
 * design/conquest/board/qa-phase-rect.ts.
 *
 * Lives under design/ — NOT referenced by src/main.tsx, NOT a vite build input
 * (vite only bundles index.html), NOT in tsconfig `include` ("src" only).  So it
 * never enters the production app, the shipping bundle, or any production route.
 * Served by `vite` dev on demand at /design/conquest/board/qa-phase-harness.html.
 *
 * URL:  …/qa-phase-harness.html?p=<0..4>
 */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/App.css";
import ConquestGame from "../../../src/modes/conquest/ConquestGame";
import { createInitialConquestGameState } from "../../../src/modes/conquest/conquestGameplay";
import { getConquestMapConfig } from "../../../src/modes/conquest/maps";
import { CONQUEST_DEFAULT_SETTINGS } from "../../../src/modes/conquest/types";
import type { ConquestGameState, ConquestPlayer } from "../../../src/modes/conquest/types";

const PLAYERS: ConquestPlayer[] = [
  { id: "host", name: "Ev Sahibi", isHost: true },
  { id: "me", name: "Sen", isHost: false },
];
const SETTINGS = { ...CONQUEST_DEFAULT_SETTINGS, map: "turkey" as const, rounds: 8 as const };

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const NOW = Date.now();

/** Real base state (phase "challenge"). */
const base = createInitialConquestGameState(getConquestMapConfig("turkey")!, PLAYERS, 8);

function withIntro(future: boolean): ConquestGameState {
  const s = clone(base);
  s.gameIntroEndsAt = future ? NOW + 600_000 : NOW - 1_000;
  return s;
}
function answered(): ConquestGameState {
  const s = withIntro(false);
  s.round.challenge.submittedAnswers = [
    { playerId: "me", playerName: "Sen", answer: "Cevap", correct: true, at: NOW },
  ];
  s.round.challenge.answeredPlayerIds = ["me"];
  return s;
}
function reveal(): ConquestGameState {
  const s = answered();
  s.phase = "reveal";
  s.round.challenge.status = "resolved";
  s.round.challenge.winnerPlayerId = "me";
  s.round.challenge.firstCorrectPlayerId = "me";
  return s;
}
function action(): ConquestGameState {
  const s = reveal();
  s.phase = "action";
  s.round.actionHolderId = "me";
  s.round.actionStartedAt = NOW;
  s.round.actionEndsAt = NOW + 15_000;
  return s;
}

const PHASES: Array<{ key: string; state: ConquestGameState }> = [
  { key: "tur-baslangici", state: withIntro(true) },
  { key: "soru-karti", state: withIntro(false) },
  { key: "cevap-kaydedildi", state: answered() },
  { key: "reveal", state: reveal() },
  { key: "action", state: action() },
];

function Harness() {
  const p = Math.max(0, Math.min(PHASES.length - 1, Number(new URLSearchParams(location.search).get("p") ?? "0")));
  const phase = PHASES[p];

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const wrap = document.querySelector(".cq-turkey-map-wrap");
      const svg = document.querySelector(".cq-turkey-map-svg") as SVGSVGElement | null;
      if (!wrap || !svg) { raf = requestAnimationFrame(measure); return; }
      const w = wrap.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      const ctm = svg.getScreenCTM();
      const round = (n: number) => Math.round(n * 100) / 100;
      const fmt = (r: DOMRect) => [round(r.width), round(r.height), round(r.top), round(r.left)].join(",");
      document.body.setAttribute("data-phase", phase.key);
      document.body.setAttribute("data-rect-wrap", fmt(w));
      document.body.setAttribute("data-rect-svg", fmt(s));
      document.body.setAttribute("data-ctm", ctm ? `${round(ctm.a)},${round(ctm.d)},${round(ctm.e)},${round(ctm.f)}` : "none");

      const HITS: Record<string, [number, number, string]> = {
        trakya: [90, 56, "Trakya"], istanbul_kocaeli: [190, 85, "İstanbul"],
        ankara_cevre: [380, 165, "Ankara"], dogu_karadeniz: [720, 132, "Doğu Kara."],
        cukurova: [462, 374, "Çukurova"], antep_kilis: [610, 368, "Antep"],
        mardin_sirnak: [837, 339, "Mardin"], van_hakkari: [906, 258, "Van"],
      };
      const hits: string[] = [];
      if (ctm) {
        const pt = svg.createSVGPoint();
        for (const [id, [nx, ny, label]] of Object.entries(HITS)) {
          pt.x = nx; pt.y = ny;
          const sp = pt.matrixTransform(ctm);
          const el = document.elementFromPoint(sp.x, sp.y) as Element | null;
          const region = el?.closest?.(".cq-map-region") ?? null;
          const aria = region?.getAttribute("aria-label") ?? "";
          hits.push(`${id}:${aria.startsWith(label) ? "1" : "0"}`);
        }
      }
      document.body.setAttribute("data-hits", hits.join(";"));
      document.body.setAttribute("data-ready", "1");
    };
    const t = setTimeout(() => { raf = requestAnimationFrame(measure); }, 350);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); };
  }, [phase.key]);

  return (
    <>
      {/* Hide the DEV-only debug panels so the harness shows the production look.
          They're position:fixed and never feed the geometry hook → no measurement impact. */}
      <style>{`.cq-debug-panel{display:none!important}`}</style>
      <ConquestGame
        roomCode="QA01"
        roomId="qa-room"
        settings={SETTINGS}
        players={PLAYERS}
        gameState={phase.state}
        isHost={false}
        myPlayerId="me"
        profile={null}
        onPushGameState={() => {}}
        onReturnToLobby={() => {}}
        onLeaveRoom={() => {}}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
