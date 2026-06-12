/**
 * korNoktaGameTypes — Kör Nokta gameplay V1 ortak tipleri ve yardımcıları.
 *
 * game_state jsonb kontratı 20260713120000_kornokta_gameplay.sql ile
 * birebir aynıdır; server tek yazıcıdır, client yalnız okur. Faz süreleri
 * server'da sabittir (role 4 sn / observe 30 sn / guess 20 sn / guess_reveal
 * 6 sn / judgement 15 sn / reveal 15 sn); client geri sayımı
 * phaseEndsAt − getSyncedNowMs() üzerinden render eder.
 */

import { korNoktaScenes, type KorNoktaScene } from "./korNoktaScenes";

export type KnPhase =
  | "role_reveal"
  | "observe_report"
  | "detective_guess"
  | "guess_reveal"
  | "report_judgement"
  | "round_reveal"
  | "final_results";

export type KnCategory = "geography" | "architecture" | "people" | "period";

export type KnRole = "detective" | "reporter" | "mole" | "spectator";

export interface KnReport {
  text: string;
  at: number;
}

/** detective_guess fazında kilitlenen pin (yalnız konum). */
export interface KnGuess {
  lat: number;
  lng: number;
}

/** guess_reveal'den itibaren dolu: mesafe + harita skoru (tahmin yoksa 0). */
export interface KnMapResult {
  distanceKm: number | null;
  mapScore: number;
}

/** report_judgement fazında kilitlenen dedektif değerlendirmesi. */
export interface KnJudgement {
  /** Rapor sahibinin player_id'si ya da "none" (= "Köstebek yoktu"). */
  suspect: string;
  useful: string | null;
}

export interface KnRoundResult {
  distanceKm: number | null;
  mapScore: number;
  caught: boolean;
  scores: Record<string, number>;
}

export interface KnRound {
  sceneId: string;
  detectiveId: string;
  moleId: string | null;
  assignments: Record<string, KnCategory>;
  reportOrder: string[];
  reports: Record<string, KnReport>;
  guess: KnGuess | null;
  mapResult: KnMapResult | null;
  judgement: KnJudgement | null;
  result: KnRoundResult | null;
}

export interface KnGameState {
  version: number;
  roundCount: number;
  playerOrder: string[];
  scenes: Array<{ id: string; lat: number; lng: number; banned: string[]; cats: KnCategory[] }>;
  totals: Record<string, number>;
  roundIndex: number;
  phase: KnPhase;
  phaseEndsAt: number | null;
  rounds: KnRound[];
}

const KN_PHASES: readonly string[] = [
  "role_reveal",
  "observe_report",
  "detective_guess",
  "guess_reveal",
  "report_judgement",
  "round_reveal",
  "final_results",
];

/** Realtime'dan gelen jsonb'yi güvenli şekilde KnGameState'e indirger.
 *  Şekil tutmuyorsa null döner; UI "durum okunamadı" fallback'ine düşer. */
export function parseKnGameState(value: unknown): KnGameState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.roundIndex !== "number") return null;
  if (typeof v.phase !== "string" || !KN_PHASES.includes(v.phase)) return null;
  if (!Array.isArray(v.rounds) || !Array.isArray(v.playerOrder)) return null;
  if (typeof v.roundCount !== "number") return null;
  if (!v.rounds[v.roundIndex as number]) return null;
  return value as KnGameState;
}

export function getKnRole(round: KnRound, playerId: string): KnRole {
  if (round.detectiveId === playerId) return "detective";
  if (round.moleId === playerId) return "mole";
  if (round.assignments[playerId]) return "reporter";
  return "spectator";
}

export function findKnScene(sceneId: string): KorNoktaScene | null {
  return korNoktaScenes.find(s => s.id === sceneId) ?? null;
}

export const KN_CATEGORY_LABELS: Record<KnCategory, string> = {
  geography:    "Coğrafya / İklim",
  architecture: "Mimari / Yapılar",
  people:       "İnsan / Kıyafet",
  period:       "Dönem / Teknoloji",
};

export const KN_CATEGORY_HINTS: Record<KnCategory, string> = {
  geography:    "Sadece arazi, hava, bitki örtüsü, su, kıyı, dağ, ova gibi şeyleri yaz.",
  architecture: "Sadece yapılar, malzeme, biçim, sokak dokusu gibi şeyleri yaz.",
  people:       "Sadece insanlar, kıyafetler, eşyalar, uğraşlar gibi şeyleri yaz.",
  period:       "Sadece dönem hissi, teknoloji seviyesi, araç gereç gibi şeyleri yaz.",
};

/** Anonim rapor etiketi: reportOrder içindeki sıra → "A" | "B" | "C" | "D". */
export function knReportLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Spec §9: 1500 altı kötü tahmin sayılır (köstebek kazanma eşiği). */
export const KN_GOOD_GUESS_THRESHOLD = 1500;

/**
 * Maç için sahne planı kurar: havuz karıştırılır, tur sayısı havuzdan
 * büyükse havuz yeniden karıştırılarak devam edilir (ardışık tekrar
 * engellenir). Dönen dizi start_game RPC'sinin p_scenes payload'ıdır.
 */
export function buildKnScenePlan(roundCount: number): Array<{
  id: string;
  lat: number;
  lng: number;
  banned: string[];
  cats: KnCategory[];
}> {
  const plan: KorNoktaScene[] = [];
  let deck: KorNoktaScene[] = [];
  while (plan.length < roundCount) {
    if (deck.length === 0) {
      deck = [...korNoktaScenes];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      // Yeni deste önceki planın son sahnesiyle başlamasın.
      const last = plan[plan.length - 1];
      if (last && deck.length > 1 && deck[0].id === last.id) {
        [deck[0], deck[1]] = [deck[1], deck[0]];
      }
    }
    plan.push(deck.shift() as KorNoktaScene);
  }
  return plan.map(s => ({
    id: s.id,
    lat: s.location.lat,
    lng: s.location.lng,
    banned: s.bannedWords,
    cats: s.categories,
  }));
}
