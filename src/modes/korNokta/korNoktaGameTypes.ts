/**
 * korNoktaGameTypes — Kör Nokta TAKIM modu (game_state version 3) tipleri.
 *
 * game_state jsonb kontratı 20260618120000_kornokta_question_flow.sql ile
 * birebir aynıdır; server tek yazıcıdır, client yalnız okur. İki takım
 * (Mavi/Kırmızı) aynı sahneyle oynar; her takımda her tur 1 dedektif rotasyonla
 * döner. Casus (iç değer "mole"; yalnız 3v3+) KARŞI takım dedektifinin seçtiği
 * sorulara anonim cevap verir — cevabı yalnız o dedektifin tahmin ekranında
 * görünür. Puanlama mesafe bazlı 0–5000 (takım başına, tur tur birikir).
 *
 * Yeni akış (v3): dedektif inceleme fazında soru havuzundan 5 soru seçer
 * (observe_report), raporcular/casuslar bu sorulara Evet/Hayır/Emin değilim ile
 * cevap verir (answer_questions), dedektif anonim cevaplara göre haritada tahmin
 * yapar (detective_guess). Eski serbest-metin rapor akışı kaldırıldı.
 *
 * Faz süreleri server'da sabittir (role 4 / observe 20 / answer 20 / guess 20 /
 * reveal 15); client geri sayımı phaseEndsAt − getSyncedNowMs() üzerinden render eder.
 */

import { korNoktaScenes, type KorNoktaScene } from "./korNoktaScenes";
import { korNoktaRealScenes } from "./korNoktaRealScenes";
import { buildKnQuestionPoolFor } from "./korNoktaQuestions";
import type { KnAnswerValue, KnQuestionCategory, KnSceneSourceType } from "./korNoktaQuestions";

/**
 * Gerçek dünya (Panoramax, CC-BY-SA) test sahnelerini CANLI eşleşme havuzuna
 * dahil eder. Varsayılan KAPALI: kapalıyken buildKnScenePlan davranışı eskisiyle
 * BİREBİR aynıdır (yalnız AI/tarihi sahneler). Tam oyun-döngüsü testi için true yap.
 * (Kör Nokta web-only; gerçek sahneler native bundle'a girmez.)
 */
export const KN_INCLUDE_REAL_SCENES = true;

/** Tüm bilinen sahneler (AI + gerçek). findKnScene id'leri her zaman buradan çözer. */
export const korNoktaAllScenes: KorNoktaScene[] = [...korNoktaScenes, ...korNoktaRealScenes];

/** start_game'in kullandığı aktif havuz (flag'e göre). */
const korNoktaActivePool: KorNoktaScene[] = KN_INCLUDE_REAL_SCENES
  ? korNoktaAllScenes
  : korNoktaScenes;

export type KnPhase =
  | "role_reveal"
  | "observe_report"   // inceleme + dedektif soru seçimi
  | "answer_questions" // raporcu/casus cevaplama
  | "detective_guess"
  | "round_reveal"
  | "final_results";

export type KnCategory = "geography" | "architecture" | "people" | "period";

/** İç rol değeri; UI'da "mole" → "Casus" gösterilir (DB/state değişmez). */
export type KnRole = "detective" | "reporter" | "mole" | "spectator";

/** Takım sabiti — hardcode yerine kullanılır (ileride 3. takım eklenebilir). */
export type KnTeam = "blue" | "red";
export const KN_TEAMS = ["blue", "red"] as const;

/** Eski serbest-metin rapor (v2). v3 akışında YAZILMAZ; tip geri-uyumluluk için durur. */
export interface KnReport {
  text: string;
  at: number;
}

/** Bir oyuncunun bir tura verdiği cevaplar: soru id → Evet/Hayır/Emin değilim. */
export type KnAnswerMap = Record<string, KnAnswerValue>;

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
  /** İki takımın tüm raporcuları (casus dahil) → kategori (rol tespiti için anahtar set). */
  assignments: Record<string, KnCategory>;
  /** Her dedektifin GÖRECEĞİ anonim cevaplayıcı sırası (casus routing dahil). */
  reportOrder: Record<KnTeam, string[]>;
  /**
   * Bu turun 12 aday soru id'si — server build_round'da bir kez üretip KALICI
   * yazar (3/kategori, karışık sıra). İki takım dedektifi de AYNI listeyi görür;
   * seçim/fallback/cevap-eşleşmesi yalnız bu sete dayanır (tek doğru kaynak).
   */
  questionCandidates: string[];
  /** Her takım dedektifinin bu tur seçtiği soru id'leri (questionCandidates altkümesi, ≤5). */
  selectedQuestions: Record<KnTeam, string[]>;
  /** Cevaplar: oyuncu id → (soru id → cevap). Casus karşı dedektifin sorularını cevaplar. */
  answers: Record<string, KnAnswerMap>;
  /** Eski serbest rapor (v2). v3'te boş kalır. */
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
  /** Kategori → soru id[] sözlüğü (server tur başına aday üretirken kullanır). */
  questionPool: Record<KnQuestionCategory, string[]>;
  totals: Record<KnTeam, number>;
  roundIndex: number;
  phase: KnPhase;
  phaseEndsAt: number | null;
  rounds: KnTeamRound[];
}

const KN_PHASES: readonly string[] = [
  "role_reveal",
  "observe_report",
  "answer_questions",
  "detective_guess",
  "round_reveal",
  "final_results",
];

/** Realtime'dan gelen jsonb'yi güvenli şekilde v3 KnGameState'e indirger.
 *  Şekil tutmuyorsa (veya eski v1/v2 blob) null döner; UI fallback'e düşer.
 *  v3'e atlama bilinçlidir: eski rapor-temelli oyunlar yeni client'ta render
 *  edilmesin (fallback ekranı → yeniden katıl). */
export function parseKnGameState(value: unknown): KnGameState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 3) return null;
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

/**
 * Cevaplayıcının HANGİ dedektifin sorularını cevaplayacağı = reportOrder'da
 * yer aldığı takım. Dürüst raporcu kendi takımının, casus KARŞI takımın
 * dedektifine düşer (routing build_round'da reportOrder'a kodlanır). Bulunamazsa null.
 */
export function getKnAnswerTargetTeam(round: KnTeamRound, playerId: string): KnTeam | null {
  if ((round.reportOrder?.blue ?? []).includes(playerId)) return "blue";
  if ((round.reportOrder?.red ?? []).includes(playerId)) return "red";
  return null;
}

/** Bu turun 12 aday soru id'si (server üretti; eksik/eski tur → boş). */
export function getKnQuestionCandidates(round: KnTeamRound): string[] {
  return round.questionCandidates ?? [];
}

/** Bir takım dedektifinin bu tur seçtiği soru id'leri (eksik alan → boş). */
export function getKnSelectedQuestions(round: KnTeamRound, team: KnTeam): string[] {
  return round.selectedQuestions?.[team] ?? [];
}

/** Bir oyuncunun bu turdaki cevapları (eksik alan → boş). */
export function getKnPlayerAnswers(round: KnTeamRound, playerId: string): KnAnswerMap {
  return round.answers?.[playerId] ?? {};
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

/** Bir sahnenin kaynak türü (undefined = tarihi/AI). */
export function knSceneSourceType(scene: KorNoktaScene): KnSceneSourceType {
  return scene.sourceType ?? "historical_ai";
}

/**
 * Sahnenin ülke anahtarı (sahne planında ardışık aynı-ülke tekrarını engellemek
 * için). Öncelik: scene.countryKey → gerçek-sahne id öneki (kn_real_NN_<cc>_) →
 * regionLabel'ın son segmenti. Hepsi normalize (lowercase + trim).
 */
export function knSceneCountry(scene: KorNoktaScene): string {
  const key = scene.countryKey?.trim().toLowerCase();
  if (key) return key;
  const m = /^kn_real_\d+_([a-z]{2})_/.exec(scene.id);
  if (m) return m[1];
  const parts = scene.regionLabel.split(",");
  const last = parts[parts.length - 1] ?? scene.id;
  return last.trim().toLowerCase() || scene.id;
}

/* Aynı odada yakın geçmişte oynanan sahneleri (yumuşak) tekrar seçmeme için
 * client-side hafıza. Host plan kurarken okunur; plan kurulduktan sonra yazılır.
 * localStorage yoksa/erişilemezse sessizce devre dışı kalır. */
const KN_RECENT_KEY = "kn_recent_scene_ids";
const KN_RECENT_MAX = 12;

export function readKnRecentScenes(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(KN_RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushKnRecentScenes(ids: string[]): void {
  if (!ids.length) return;
  try {
    const prev = readKnRecentScenes();
    const merged = [...ids, ...prev]
      .filter((id, i, a) => a.indexOf(id) === i) // en yeni başta, tekilleştir
      .slice(0, KN_RECENT_MAX);
    globalThis.localStorage?.setItem(KN_RECENT_KEY, JSON.stringify(merged));
  } catch {
    /* ignore */
  }
}

export interface KnScenePlanEntry {
  id: string;
  lat: number;
  lng: number;
  banned: string[];
  cats: KnCategory[];
  /** Sahne türüne göre filtrelenmiş soru havuzu — server build_round per-scene. */
  questionPool: Record<KnQuestionCategory, string[]>;
}

/**
 * Maç için sahne planı kurar. Katmanlı seçim (her katman boşalırsa bir üst
 * kümeye güvenli düşüş → ASLA kilitlenmez):
 *   • Sert kural: maç içinde aynı sceneId tekrar etmez (havuz tükenirse sıfırlanır
 *     ama hemen önceki sahne yine hariç).
 *   • Ülke aralığı: önceki turla aynı ülke seçilmez (alternatif varsa).
 *   • Yakın geçmiş (yumuşak): opts.recentSceneIds elenir (alternatif varsa).
 *   • sourceType çeşitliliği (yumuşak): önceki turdan farklı tür tercih edilir.
 * Dönen dizi start_game RPC'sinin p_scenes payload'ıdır (her sahne kendi soru
 * havuzunu taşır). Plan yine server'da sanitize edilir (tek yazıcı korunur).
 */
export function buildKnScenePlan(
  roundCount: number,
  opts?: { recentSceneIds?: string[] },
): KnScenePlanEntry[] {
  const pool = korNoktaActivePool;
  const recent = new Set(opts?.recentSceneIds ?? []);
  const used = new Set<string>();
  const chosen: KorNoktaScene[] = [];

  for (let r = 0; r < roundCount; r++) {
    const prev = chosen[chosen.length - 1];

    // Sert kural: maç içinde tekrar yok. Havuz tükendiyse sıfırla (kilitlenmez),
    // hemen önceki sahneyi yine de hariç tut.
    let base = pool.filter(s => !used.has(s.id));
    if (base.length === 0) {
      used.clear();
      base = prev ? pool.filter(s => s.id !== prev.id) : [...pool];
      if (base.length === 0) base = [...pool];
    }

    let cand = base;
    if (prev) {
      const prevCountry = knSceneCountry(prev);
      const diffCountry = cand.filter(s => knSceneCountry(s) !== prevCountry);
      if (diffCountry.length) cand = diffCountry;
    }
    if (recent.size) {
      const notRecent = cand.filter(s => !recent.has(s.id));
      if (notRecent.length) cand = notRecent;
    }
    if (prev) {
      const prevSource = knSceneSourceType(prev);
      const diffSource = cand.filter(s => knSceneSourceType(s) !== prevSource);
      if (diffSource.length) cand = diffSource;
    }

    const pick = cand[Math.floor(Math.random() * cand.length)];
    used.add(pick.id);
    chosen.push(pick);
  }

  return chosen.map(s => ({
    id: s.id,
    lat: s.location.lat,
    lng: s.location.lng,
    banned: s.bannedWords,
    cats: s.categories,
    questionPool: buildKnQuestionPoolFor(knSceneSourceType(s)),
  }));
}
