/**
 * flagGroupLogic.ts — Bayrak Bilmece Çok Oyunculu (flag_group_*) için SAF
 * (yan etkisiz, React'sız) yardımcılar.
 *
 * Buradaki fonksiyonlar hem FlagGroupGame.tsx tarafından hem de
 * scripts/check-flag-group-logic.ts testi tarafından kullanılır. Amaç: skor
 * türetme, kazanan/sıralama ve host bayrak-sırası mantığını izole, test
 * edilebilir tek yerde tutmak.
 *
 * TASARIM NOTU — ATOMİK İLK-DOĞRU:
 *   Turun kazananı SERVER'da belirlenir (flag_group_claims UNIQUE(room_id,
 *   country_code) → yalnız ilk başarılı insert). Bu modül yalnız server'ın
 *   yazdığı claim satırlarını OKUYUP skor/sıralama TÜRETİR; hiçbir kazananı
 *   client-side "seçmez". `computeScores` her oyuncunun gerçek (bayrak-kodu)
 *   claim sayısını verir = kazandığı tur sayısı = puanı.
 */

/**
 * PAS SENTİNEL — bir turun "Pas Geç çoğunluğu" ile kapandığını işaretleyen
 * claim satırının country_code öneki. Server (flag_group_toggle_pass_vote)
 * çoğunluk oluşunca flag_group_claims tablosuna `pass:<flag>` yazar. Bu,
 * TURUN ÇÖZÜMÜNÜ gerçek claim'lerle AYNI UNIQUE(room, game_seq, round)
 * bucket'ına koyar → pas ile doğru-cevap "tek çözüm" için atomik yarışır
 * (biri bucket'ı alır, diğeri unique_violation). `<flag>` = paslanan bayrak
 * kodu; reconnect'te host hangi bayrağın gösterildiğini bundan çıkarır
 * (tekrar-gösterim önlenir). `:` içerdiği için skor sayımından da elenir. */
export const FG_PASS_PREFIX = "pass:";

/** country_code bir Pas Geç sentinel'i mi? */
export function isPassClaim(countryCode: string): boolean {
  return typeof countryCode === "string" && countryCode.startsWith(FG_PASS_PREFIX);
}

/** Pas sentinel'inden paslanan bayrak kodunu çıkarır (değilse null). */
export function passClaimFlagCode(countryCode: string): string | null {
  if (!isPassClaim(countryCode)) return null;
  const code = countryCode.slice(FG_PASS_PREFIX.length);
  return code.length > 0 ? code : null;
}

/**
 * Pas Geç çoğunluk eşiği (SALT ÇOĞUNLUK): floor(N/2)+1.
 *   2→2, 3→2, 4→3, 5→3, 10→6. Server bunu KİLİT altında aktif ('playing')
 *   oyuncu sayısıyla hesaplar; bu saf sürüm client'ta yalnız GÖSTERİM içindir.
 */
export function requiredPassVotes(activeCount: number): number {
  const n = Math.max(0, Math.floor(activeCount));
  return Math.floor(n / 2) + 1;
}

/** Bir claim gerçek bir tur-cevabı mı? (sentinel/pas/prefix'li kodlar sayılmaz.) */
export function isScoringClaim(countryCode: string): boolean {
  // flag_group modunda skor sayılan claim.country_code her zaman düz bir bayrak
  // kodudur (örn. "tr"). Pas sentinel'i (`pass:<flag>`) ve herhangi bir ":"
  // içeren sentinel savunma amaçlı elenir → skor üretmez.
  return !!countryCode && !isPassClaim(countryCode) && !countryCode.includes(":");
}

/**
 * Bir oyun oturumunda GÖSTERİLMİŞ tüm bayrak kodları. Gerçek claim → country_code;
 * pas sentinel'i (`pass:<flag>`) → <flag>. Host reconnect/restore'da usedFlags
 * exclude setini kurarken kullanılır ki PASLANMIŞ bayrak da tekrar gösterilmesin
 * (gerçek claim yoksa bile). Sıra korunmaz (Set'e beslenir).
 */
export function shownFlagCodes(claims: FGClaimLike[]): string[] {
  const out: string[] = [];
  for (const c of claims) {
    const passed = passClaimFlagCode(c.country_code);
    if (passed) out.push(passed);
    else if (isScoringClaim(c.country_code)) out.push(c.country_code);
  }
  return out;
}

export interface FGClaimLike {
  player_id: string;
  country_code: string;
}

export interface FGPlayerLike {
  id: string;
  name: string;
  status: string;
}

export interface LeaderRow {
  playerId: string;
  name: string;
  score: number;
  rank: number; // 1-based; eşit skor → aynı rank
}

/** playerId → puan (gerçek claim sayısı). */
export function computeScores(claims: FGClaimLike[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const c of claims) {
    if (!isScoringClaim(c.country_code)) continue;
    scores.set(c.player_id, (scores.get(c.player_id) ?? 0) + 1);
  }
  return scores;
}

/**
 * Skor tablosu: en yüksekten en düşüğe, eşitlikte STABİL sıra (players
 * dizisindeki mevcut sıra = katılım sırası). Eşit skorlar aynı rank alır.
 */
export function buildLeaderboard(
  players: FGPlayerLike[],
  claims: FGClaimLike[],
): LeaderRow[] {
  const scores = computeScores(claims);
  const rows = players.map((p, order) => ({
    playerId: p.id,
    name: p.name,
    score: scores.get(p.id) ?? 0,
    order,
  }));
  rows.sort((a, b) => b.score - a.score || a.order - b.order);

  let lastScore = Number.POSITIVE_INFINITY;
  let lastRank = 0;
  return rows.map((r, i) => {
    const rank = r.score === lastScore ? lastRank : i + 1;
    lastScore = r.score;
    lastRank = rank;
    return { playerId: r.playerId, name: r.name, score: r.score, rank };
  });
}

export interface WinnerInfo {
  /** En yüksek skoru paylaşan oyuncu id'leri (0 = hiç puan yok). */
  winnerIds: string[];
  /** Birden fazla lider varsa (veya hiç puan yoksa) beraberlik. */
  isTie: boolean;
  topScore: number;
}

/** Skor tablosundan kazanan(lar)ı / beraberliği türetir. */
export function resolveWinners(leaderboard: LeaderRow[]): WinnerInfo {
  if (leaderboard.length === 0) return { winnerIds: [], isTie: false, topScore: 0 };
  const topScore = leaderboard[0].score;
  const leaders = leaderboard.filter((r) => r.score === topScore);
  // Kimse puan almadıysa "kazanan yok" → beraberlik.
  if (topScore === 0) return { winnerIds: [], isTie: true, topScore: 0 };
  return { winnerIds: leaders.map((r) => r.playerId), isTie: leaders.length > 1, topScore };
}

/** Verilen turun kazananı (bayrak kodunu ilk claim eden oyuncu) ya da null. */
export function roundWinnerId(
  claims: FGClaimLike[],
  currentFlag: string | null,
): string | null {
  if (!currentFlag) return null;
  const c = claims.find((x) => x.country_code === currentFlag);
  return c ? c.player_id : null;
}

/** Tüm oyuncular lobide (status='waiting') mı? Host başlatma kapısı. */
export function allPlayersReady(players: FGPlayerLike[]): boolean {
  return players.length > 0 && players.every((p) => p.status === "waiting");
}

/**
 * Host bayrak-sırası: sıralı (progression) diziden HENÜZ gösterilmemiş ilk
 * bayrak kodunu döner. `usedCodes` şu ana kadar gösterilen bayrakları içerir.
 * Kalmadıysa null → host oyunu bitirir.
 */
export function pickNextFlagCode(
  orderedCodes: string[],
  usedCodes: Set<string>,
): string | null {
  for (const code of orderedCodes) {
    if (!usedCodes.has(code)) return code;
  }
  return null;
}
