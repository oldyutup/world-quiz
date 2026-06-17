/**
 * korNoktaGameTypes — Kör Nokta TAKIM modu (game_state version 2) tipleri.
 *
 * game_state jsonb kontratı 20260714123000_kornokta_teams_gameplay.sql ile
 * birebir aynıdır; server tek yazıcıdır, client yalnız okur. İki takım
 * (Mavi/Kırmızı) aynı sahneyle oynar; her takımda her tur 1 dedektif rotasyonla
 * döner. Köstebek (yalnız 3v3+) raporunu KARŞI takım dedektifine anonim
 * gönderir. Puanlama mesafe bazlı 0–5000 (takım başına, tur tur birikir).
 *
 * Faz süreleri server'da sabittir (role 4 / observe 30 / guess 20 / reveal 15);
 * client geri sayımı phaseEndsAt − getSyncedNowMs() üzerinden render eder.
 */

import { korNoktaScenes, type KorNoktaScene } from "./korNoktaScenes";
import { korNoktaRealScenes } from "./korNoktaRealScenes";

/**
 * Gerçek dünya (Panoramax, CC-BY-SA) test sahnelerini CANLI eşleşme havuzuna
 * dahil eder. Varsayılan KAPALI: kapalıyken buildKnScenePlan davranışı eskisiyle
 * BİREBİR aynıdır (yalnız AI/tarihi sahneler). Tam oyun-döngüsü testi için true yap.
 * (Kör Nokta web-only; gerçek sahneler native bundle'a girmez.)
 */
export const KN_INCLUDE_REAL_SCENES = false;

/** Tüm bilinen sahneler (AI + gerçek). findKnScene id'leri her zaman buradan çözer. */
export const korNoktaAllScenes: KorNoktaScene[] = [...korNoktaScenes, ...korNoktaRealScenes];

/** start_game'in kullandığı aktif havuz (flag'e göre). */
const korNoktaActivePool: KorNoktaScene[] = KN_INCLUDE_REAL_SCENES
  ? korNoktaAllScenes
  : korNoktaScenes;

export type KnPhase =
  | "role_reveal"
  | "observe_report"
  | "detective_guess"
  | "round_reveal"
  | "final_results";

export type KnCategory = "geography" | "architecture" | "people" | "period";

export type KnRole = "detective" | "reporter" | "mole" | "spectator";

/** Takım sabiti — hardcode yerine kullanılır (ileride 3. takım eklenebilir). */
export type KnTeam = "blue" | "red";
export const KN_TEAMS = ["blue", "red"] as const;

export interface KnReport {
  text: string;
  at: number;
}

/** detective_guess fazında kilitlenen pin (yalnız konum). */
export interface KnGuess {
  lat: number;
  lng: number;
}

/** Tur sonu takım sonucu: mesafe + 0–5000 harita skoru (tahmin yoksa 0). */
export interface KnTeamResult {
  distanceKm: number | null;
  score: number;
}

export interface KnTeamRound {
  sceneId: string;
  detectives: Record<KnTeam, string>;
  moles: Record<KnTeam, string | null>;
  /** İki takımın tüm raporcuları → kategori. */
  assignments: Record<string, KnCategory>;
  /** Her dedektifin GÖRECEĞİ anonim rapor sırası (köstebek routing dahil). */
  reportOrder: Record<KnTeam, string[]>;
  reports: Record<string, KnReport>;
  guesses: Record<KnTeam, KnGuess | null>;
  results: Record<KnTeam, KnTeamResult> | null;
}

export interface KnGameState {
  version: number;
  roundCount: number;
  moleEnabled: boolean;
  teams: Record<KnTeam, string[]>;
  detectiveOrder: Record<KnTeam, string[]>;
  scenes: Array<{ id: string; lat: number; lng: number; banned: string[]; cats: KnCategory[] }>;
  totals: Record<KnTeam, number>;
  roundIndex: number;
  phase: KnPhase;
  phaseEndsAt: number | null;
  rounds: KnTeamRound[];
}

const KN_PHASES: readonly string[] = [
  "role_reveal",
  "observe_report",
  "detective_guess",
  "round_reveal",
  "final_results",
];

/** Realtime'dan gelen jsonb'yi güvenli şekilde v2 KnGameState'e indirger.
 *  Şekil tutmuyorsa (veya eski v1 blob) null döner; UI fallback'e düşer. */
export function parseKnGameState(value: unknown): KnGameState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 2) return null;
  if (typeof v.roundIndex !== "number") return null;
  if (typeof v.phase !== "string" || !KN_PHASES.includes(v.phase)) return null;
  if (typeof v.roundCount !== "number") return null;
  if (!Array.isArray(v.rounds)) return null;
  const teams = v.teams as Record<string, unknown> | undefined;
  if (!teams || !Array.isArray(teams.blue) || !Array.isArray(teams.red)) return null;
  if (!v.rounds[v.roundIndex as number]) return null;
  return value as KnGameState;
}

/** Oyuncunun bu turdaki rolü. */
export function getKnRole(round: KnTeamRound, playerId: string): KnRole {
  if (round.detectives.blue === playerId || round.detectives.red === playerId) {
    return "detective";
  }
  if (round.moles.blue === playerId || round.moles.red === playerId) {
    return "mole";
  }
  if (round.assignments[playerId]) return "reporter";
  return "spectator";
}

/** Oyuncunun takımı (lobi/oyun boyunca sabit). Bulunamazsa null. */
export function getKnTeam(state: KnGameState, playerId: string): KnTeam | null {
  if (state.teams.blue.includes(playerId)) return "blue";
  if (state.teams.red.includes(playerId)) return "red";
  return null;
}

export const KN_TEAM_LABELS: Record<KnTeam, string> = {
  blue: "Mavi Takım",
  red:  "Kırmızı Takım",
};

export function findKnScene(sceneId: string): KorNoktaScene | null {
  return korNoktaAllScenes.find(s => s.id === sceneId) ?? null;
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

/** Anonim rapor etiketi: sıra → "A" | "B" | "C" | ... */
export function knReportLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

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
      deck = [...korNoktaActivePool];
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
