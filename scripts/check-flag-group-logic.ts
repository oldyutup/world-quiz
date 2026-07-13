/**
 * check-flag-group-logic.ts — Bayrak Bilmece Çok Oyunculu SAF mantık +
 * claim-atomikliği (SQL semantiği simülasyonu) testi.
 *
 *   npx tsx scripts/check-flag-group-logic.ts
 *
 * NOT: RLS/gerçek eşzamanlılık ancak canlı Postgres'te doğrulanır (migration
 * henüz deploy edilmedi). Buradaki AtomicClaimTable, flag_group_submit_claim'in
 * SQL sözleşmesini birebir taklit eder:
 *   • Oda satırı FOR UPDATE ile kilitli okunur → submit, o anki (kilitli) oda
 *     anlık görüntüsünü (game_seq, round, current_flag) görür.
 *   • country_code <> current_flag → 'stale' (yanlış/eski-tur cevabı skor yazmaz).
 *   • UNIQUE(room_id, game_seq, round) → tur başına tek kazanan; ikinci 'dup'.
 *   • game_seq her oyunda artar → aynı ülke yeni oyunda serbest; eski claim çakışmaz.
 */
import { readFileSync } from "node:fs";
import {
  computeScores,
  buildLeaderboard,
  resolveWinners,
  roundWinnerId,
  allPlayersReady,
  pickNextFlagCode,
  isScoringClaim,
  isPassClaim,
  passClaimFlagCode,
  requiredPassVotes,
  shownFlagCodes,
  type FGClaimLike,
} from "../src/components/flagGroupLogic";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
function eq(a: unknown, b: unknown, label: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${label}  (got ${JSON.stringify(a)})`);
}
/** serverAdvanceFlag sonucunu başarı (AdvanceResult) olarak daraltır; beklenmedik
 *  red gelirse testi patlatır. Başarı bekleyen çağrı yerlerinde kullanılır. */
function asAdv(r: AdvanceResult | AdvanceReject): AdvanceResult {
  if ("rejected" in r) { throw new Error(`beklenmedik advance reddi: ${r.rejected}`); }
  return r;
}

/** flag_group_rooms satırının submit anındaki (FOR UPDATE ile kilitli) görüntüsü.
 *  flagSeq = gösterilen-bayrak kimliği (atomik anahtar). Verilmezse tarihsel
 *  1:1 varsayımıyla round'a düşer (eski test senaryolarıyla geriye-uyum). */
interface RoomSnapshot { gameSeq: number; round: number; currentFlag: string; flagSeq?: number }
type SubmitResult = { claimed: boolean; reason?: "dup" | "stale" };

/** flag_group_submit_claim SQL sözleşmesinin birebir modeli.
 *  Atomik anahtar artık UNIQUE(room, game_seq, FLAG_SEQ) — tur (round) DEĞİL →
 *  aynı round'da ikinci bayrak (yeni flag_seq) eski sentinel'le çakışmaz. */
class AtomicClaimTable {
  private rows: Array<FGClaimLike & { gameSeq: number; flagSeq: number }> = [];
  private seen = new Set<string>();               // UNIQUE(room, game_seq, flag_seq)
  submit(playerId: string, countryCode: string, room: RoomSnapshot): SubmitResult {
    const flagSeq = room.flagSeq ?? room.round;
    // 1) server-otoriter bayrak kapağı: yalnız MEVCUT bayrağın doğru cevabı sayılır
    if (countryCode !== room.currentFlag) return { claimed: false, reason: "stale" };
    // 2) UNIQUE(room, game_seq, flag_seq) → gösterilen bayrak başına tek kazanan
    const key = `${room.gameSeq}:${flagSeq}`;
    if (this.seen.has(key)) return { claimed: false, reason: "dup" };
    this.seen.add(key);
    this.rows.push({ player_id: playerId, country_code: countryCode, gameSeq: room.gameSeq, flagSeq });
    return { claimed: true };
  }
  all(): FGClaimLike[] { return this.rows.map(r => ({ player_id: r.player_id, country_code: r.country_code })); }
}

console.log("1) ATOMİK TEK-KAZANAN — aynı turda eşzamanlı iki doğru cevap");
{
  const t = new AtomicClaimTable();
  const room: RoomSnapshot = { gameSeq: 1, round: 1, currentFlag: "tr" };
  const r1 = t.submit("p1", "tr", room);   // FOR UPDATE → önce kilidi alan
  const r2 = t.submit("p2", "tr", room);   // aynı (game_seq,round) → dup
  assert(r1.claimed === true, "ilk gönderen turu kazanır");
  assert(r2.claimed === false && r2.reason === "dup", "ikinci 'dup' (çift puan YOK)");
  const s = computeScores(t.all());
  eq(s.get("p1") ?? 0, 1, "p1=1"); eq(s.get("p2") ?? 0, 0, "p2=0");
}

console.log("2) ESKİ ROUND cevabı, round ilerledikten sonra reddedilir");
{
  const t = new AtomicClaimTable();
  // round 1 timeout ile geçti (kazanan yok). Host round 2'ye ilerletti (flag='us').
  const advanced: RoomSnapshot = { gameSeq: 1, round: 2, currentFlag: "us" };
  // Geç gelen "tr" (round 1 cevabı) — submit FOR UPDATE ile GÜNCEL odayı görür:
  const r = t.submit("p1", "tr", advanced);
  assert(r.claimed === false && r.reason === "stale", "eski-tur 'tr' cevabı 'stale' (süresi dolmuş tur PUANLANMAZ)");
  eq(computeScores(t.all()).get("p1") ?? 0, 0, "eski-tur cevabı skor üretmedi");
}

console.log("3) AYNI ÜLKE yeni oyun oturumunda tekrar → claim KABUL edilir");
{
  const t = new AtomicClaimTable();
  eq(t.submit("p1", "tr", { gameSeq: 1, round: 1, currentFlag: "tr" }), { claimed: true }, "oyun1: 'tr' kazanıldı");
  // Yeni oyun: start_game game_seq'i artırdı (2). Aynı ülke 'tr' 1. turda yine gelebilir.
  eq(t.submit("p2", "tr", { gameSeq: 2, round: 1, currentFlag: "tr" }), { claimed: true },
    "oyun2: aynı 'tr' YENİDEN kabul (farklı game_seq → çakışma yok)");
}

console.log("4) SESSION reset sonrası eski claim yeni oyunu ETKİLEMEZ");
{
  const t = new AtomicClaimTable();
  // Oyun1: iki tur oynandı (claim'ler temizlenmese bile game_seq izole eder).
  t.submit("p1", "tr", { gameSeq: 1, round: 1, currentFlag: "tr" });
  t.submit("p1", "us", { gameSeq: 1, round: 2, currentFlag: "us" });
  // Oyun2 (game_seq=2): round 1 yine 'tr' — eski (1,1) claim'i engellememeli.
  const r = t.submit("p2", "tr", { gameSeq: 2, round: 1, currentFlag: "tr" });
  assert(r.claimed === true, "oyun2 round1 'tr' kabul (eski game_seq=1 claim'i bloklamadı)");
  // Oyun2 skoru YALNIZ oyun2'ye ait olmalı — ama not: computeScores tüm satırları
  // sayar; gerçekte start_game claims'i siler + game_seq izole eder (çift savunma).
}

console.log("5) Skor türetme (sentinel/geçersiz sayılmaz)");
{
  assert(isScoringClaim("tr"), "düz bayrak kodu skor sayılır");
  assert(!isScoringClaim("TIMEOUT:R1:tr"), "sentinel skor sayılmaz");
  const claims: FGClaimLike[] = [
    { player_id: "a", country_code: "tr" }, { player_id: "a", country_code: "us" },
    { player_id: "b", country_code: "de" }, { player_id: "a", country_code: "TIMEOUT:R4:fr" },
  ];
  const s = computeScores(claims);
  eq(s.get("a") ?? 0, 2, "a = 2 gerçek claim"); eq(s.get("b") ?? 0, 1, "b = 1 gerçek claim");
}

console.log("6) Sıralama (desc + stabil eşitlik + rank)");
{
  const players = [
    { id: "a", name: "Ada", status: "playing" }, { id: "b", name: "Bora", status: "playing" },
    { id: "c", name: "Cem", status: "playing" },
  ];
  const claims: FGClaimLike[] = [
    { player_id: "b", country_code: "tr" }, { player_id: "b", country_code: "us" },
    { player_id: "a", country_code: "de" }, { player_id: "c", country_code: "fr" },
  ];
  const lb = buildLeaderboard(players, claims);
  eq(lb.map(r => r.playerId), ["b", "a", "c"], "en yüksek skor önce (b=2, a=1, c=1 stabil)");
  eq(lb.map(r => r.rank), [1, 2, 2], "eşit skorlar aynı rank");
  eq(lb.map(r => r.score), [2, 1, 1], "skorlar doğru");
}

console.log("7) Kazanan / beraberlik");
{
  const single = buildLeaderboard(
    [{ id: "a", name: "A", status: "waiting" }, { id: "b", name: "B", status: "waiting" }],
    [{ player_id: "a", country_code: "tr" }]);
  eq(resolveWinners(single).winnerIds, ["a"], "tek kazanan a");
  assert(!resolveWinners(single).isTie, "beraberlik değil");
  const tie = buildLeaderboard(
    [{ id: "a", name: "A", status: "waiting" }, { id: "b", name: "B", status: "waiting" }],
    [{ player_id: "a", country_code: "tr" }, { player_id: "b", country_code: "us" }]);
  eq(resolveWinners(tie).winnerIds.sort(), ["a", "b"], "eşit skor → iki lider");
  assert(resolveWinners(tie).isTie, "beraberlik true");
  const zero = buildLeaderboard([{ id: "a", name: "A", status: "waiting" }], []);
  eq(resolveWinners(zero).winnerIds, [], "kimse puan almadı → kazanan yok");
  assert(resolveWinners(zero).isTie, "sıfır-puan beraberlik");
}

console.log("8) Round kazananı + host bayrak sırası + başlatma kapısı");
{
  eq(roundWinnerId([{ player_id: "x", country_code: "tr" }], "tr"), "x", "mevcut bayrağı claim eden = kazanan");
  eq(roundWinnerId([{ player_id: "x", country_code: "tr" }], "us"), null, "farklı bayrak → kazanan yok");
  const seq = ["tr", "us", "de", "fr"];
  const used = new Set<string>(["tr", "us"]);
  eq(pickNextFlagCode(seq, used), "de", "kullanılmamış ilk bayrak");
  used.add("de"); used.add("fr");
  eq(pickNextFlagCode(seq, used), null, "hepsi kullanıldı → null");
  assert(allPlayersReady([{ id: "a", name: "A", status: "waiting" }, { id: "b", name: "B", status: "waiting" }]),
    "hepsi waiting → başlatılabilir");
  assert(!allPlayersReady([{ id: "a", name: "A", status: "waiting" }, { id: "b", name: "B", status: "finished" }]),
    "biri sonuç ekranında → başlatılamaz");
  assert(!allPlayersReady([]), "oyuncu yok → başlatılamaz");
}

// ══════════════════════════════════════════════════════════════════════════
//  PAS GEÇ (flag_group_toggle_pass_vote) — SQL sözleşmesi simülasyonu
// ══════════════════════════════════════════════════════════════════════════
// RoundEngine, submit_claim + toggle_pass_vote'un AYNI flag_group_rooms satırını
// FOR UPDATE ile kilitlemesini modeller → işlemler SERİdir. Turun çözümü tek
// yerde: flag_group_claims UNIQUE(game_seq, round) bucket'ı. Pas çoğunluğu bu
// bucket'a `pass:<flag>` sentinel yazar → doğru claim ile ATOMİK yarışır.

type PassResult = {
  voted: boolean; vote_count: number; required: number; active: number;
  resolved: boolean; passed: boolean; stale?: boolean; error?: string;
};

/** Bayrak tur süresi (server FLAG_TIMEOUT_SEC=10 ile birebir). */
const FLAG_TIMEOUT_MS = 10_000;

/** flag_group_advance_flag sözleşmesinin sonucu (server-otoriter karar).
 *  noop=true → çift-ilerletme guard'ı (stale flag_seq) → hiçbir mutation yok. */
type AdvanceResult = { round: number; flagSeq: number; passed: boolean; finalized: boolean; noop?: boolean };
/** advance_flag reddi (raise): erken advance / geçersiz next_flag. */
type AdvanceReject = { rejected: "round_active" | "next_flag_invalid" | "next_flag_unchanged" };

class RoundEngine {
  gameSeq: number; round: number; flagSeq: number; flag: string; hostId: string;
  totalRounds: number;                                      // finalize kararı için
  flagShownAt: number;                                      // current_flag_at (ms) — timeout guard
  private active = new Set<string>();                       // status='playing' üyeler
  private resolved = new Map<string, "claim" | "pass">();   // key `${gs}:${flagSeq}`
  // Çözüm satırının SAHİBİ (flag_group_claims.player_id). Gerçek claim → claimer;
  // pas sentinel → HOST (FK ON DELETE CASCADE yetim-silme güvenliği). removePlayer
  // FK cascade'ini bu owner üzerinden modeller.
  private resolvedBy = new Map<string, string>();
  private votes = new Map<string, Set<string>>();           // key `${gs}:${flagSeq}` → playerIds

  constructor(gameSeq: number, round: number, flag: string, activeIds: string[], hostId?: string, opts?: { flagSeq?: number; totalRounds?: number; flagShownAt?: number }) {
    this.gameSeq = gameSeq; this.round = round; this.flag = flag;
    this.flagSeq = opts?.flagSeq ?? round;                  // tarihsel 1:1 (round==flag_seq)
    this.totalRounds = opts?.totalRounds ?? 999;            // eski finalize-nötr testler için
    this.flagShownAt = opts?.flagShownAt ?? 0;              // varsayılan → nowMs=∞ ile timeout dolmuş sayılır
    activeIds.forEach(id => this.active.add(id));
    this.hostId = hostId ?? activeIds[0];                    // varsayılan host = ilk oyuncu
  }
  // Atomik anahtar artık game_seq + FLAG_SEQ (round DEĞİL).
  private key(gs = this.gameSeq, fs = this.flagSeq) { return `${gs}:${fs}`; }
  required() { return Math.floor(this.active.size / 2) + 1; }   // floor(N/2)+1 (server ile birebir)
  private voteSet() {
    const k = this.key();
    if (!this.votes.has(k)) this.votes.set(k, new Set());
    return this.votes.get(k)!;
  }
  voteCount() { return this.voteSet().size; }
  resolutionOf(gs: number, fs: number) { return this.resolved.get(`${gs}:${fs}`) ?? null; }
  resolutionOwnerOf(gs: number, fs: number) { return this.resolvedBy.get(`${gs}:${fs}`) ?? null; }

  /** flag_group_submit_claim sözleşmesi (kilit altında). Sahip = claimer. */
  submitClaim(playerId: string, code: string): SubmitResult {
    if (code !== this.flag) return { claimed: false, reason: "stale" };          // eski/yanlış bayrak
    const k = this.key();
    if (this.resolved.has(k)) return { claimed: false, reason: "dup" };           // bucket dolu (claim VEYA pas)
    this.resolved.set(k, "claim");
    this.resolvedBy.set(k, playerId);
    return { claimed: true };
  }

  /** flag_group_toggle_pass_vote sözleşmesi (kilit altında). Sentinel sahibi = HOST.
   *  fs verilmezse tarihsel 1:1 (fs = r) — eski senaryolar aynen çalışır. */
  togglePass(playerId: string, gs: number, r: number, fs: number = r): PassResult {
    const active = this.active.size;
    const required = this.required();
    // adım 2: aktif ('playing') üyelik — atılan/ayrılan oyuncunun satırı yok.
    if (!this.active.has(playerId)) {
      return { voted: false, vote_count: this.voteCount(), required, active, resolved: false, passed: false, error: "player_room_mismatch" };
    }
    // adım 4: bayat/kapalı guard → gösterilen bayrak (game_seq, flag_seq) güncel
    //         değilse YAZMA YOK. round DEĞİL, flag_seq gerçek kimliktir.
    if (gs !== this.gameSeq || fs !== this.flagSeq) {
      return { voted: false, vote_count: this.voteCount(), required, active, resolved: this.resolved.has(this.key()), passed: false, stale: true };
    }
    // adım 5: bu gösterilen bayrak zaten çözüldü mü (claim veya pas)? → no-op.
    if (this.resolved.has(this.key())) {
      return { voted: false, vote_count: this.voteCount(), required, active, resolved: true, passed: false };
    }
    // adım 6: TOGGLE — kendi oyu varsa geri çek, yoksa ekle.
    const set = this.voteSet();
    let voted: boolean;
    if (set.has(playerId)) { set.delete(playerId); voted = false; }
    else { set.add(playerId); voted = true; }
    const count = set.size;
    // adım 8: çoğunluk → pas sentinel (bucket'ı doldurur, sahip = HOST).
    let resolved = false, passed = false;
    if (count >= required) {
      this.resolved.set(this.key(), "pass");
      this.resolvedBy.set(this.key(), this.hostId);
      resolved = true; passed = true;
    }
    return { voted, vote_count: count, required, active, resolved, passed };
  }

  /** Reconnect/retry: aynı tuple INSERT → ON CONFLICT DO NOTHING (idempotent). */
  rawInsertVote(playerId: string) { this.voteSet().add(playerId); }

  /** Oyuncu ayrıl/atıl → player row silinir → FK ON DELETE CASCADE: oyları VE
   *  o oyuncunun SAHİBİ olduğu çözüm (claim/sentinel) satırlarını düşürür. */
  removePlayer(playerId: string) {
    this.active.delete(playerId);
    for (const set of this.votes.values()) set.delete(playerId);
    for (const [k, owner] of [...this.resolvedBy.entries()]) {
      if (owner === playerId) { this.resolvedBy.delete(k); this.resolved.delete(k); }
    }
  }

  /** flag_group_advance_flag SQL sözleşmesi (host, kilit altında). SERVER karar
   *  verir. next_flag doğrulaması + erken-advance (timeout) guard'ı dahil.
   *    • nextFlag = null → havuz tükendi (MEŞRU finalize sinyali).
   *    • nextFlag ≠ null → boş/whitespace/^[a-z]{2}$ dışı → next_flag_invalid;
   *      current_flag ile aynı → next_flag_unchanged (REDDEDİLİR, mutation yok).
   *    • PAS → round DEĞİŞMEZ, flag_seq++; claim → round+1; ikisi de flag_seq++.
   *    • Çözüm YOK → yalnız server timeout (flagShownAt + 10sn) DOLDUYSA ilerler;
   *      dolmadıysa round_active (REDDEDİLİR, mutation yok). nowMs verilmezse ∞
   *      (dolmuş sayılır → eski/timeout-nötr testler etkilenmez). */
  serverAdvanceFlag(nextFlag: string | null, nowMs: number = Number.POSITIVE_INFINITY, expectedFlagSeq?: number): AdvanceResult | AdvanceReject {
    // Çift-ilerletme guard'ı (SQL: p_flag_seq güncel flag_seq değilse → no-op,
    // HİÇBİR mutation yok). Client bayat flag_seq gönderdiyse durum değişmez.
    if (expectedFlagSeq !== undefined && expectedFlagSeq !== this.flagSeq) {
      return { round: this.round, flagSeq: this.flagSeq, passed: false, finalized: false, noop: true };
    }
    // next_flag doğrulaması (mutation ÖNCESİ). null → finalize sinyali (geçerli).
    let hasNext = false;
    if (nextFlag !== null) {
      const nf = nextFlag.trim().toLowerCase();
      if (!/^[a-z]{2}$/.test(nf)) return { rejected: "next_flag_invalid" };       // boş/whitespace/bozuk
      if (nf === (this.flag ?? "").toLowerCase()) return { rejected: "next_flag_unchanged" };
      hasNext = true;
      nextFlag = nf;
    }
    const res = this.resolved.get(this.key());
    const passed = res === "pass";
    const hasClaim = res === "claim";

    if (passed) {
      if (!hasNext) return { round: this.round, flagSeq: this.flagSeq, passed: true, finalized: true };
      this.flagSeq += 1; this.flag = nextFlag!;               // round DEĞİŞMEZ
      return { round: this.round, flagSeq: this.flagSeq, passed: true, finalized: false };
    }

    // Çözüm YOK → gerçek server timeout dolmalı; aksi hâlde erken-advance reddi.
    if (!hasClaim && nowMs < this.flagShownAt + FLAG_TIMEOUT_MS) {
      return { rejected: "round_active" };
    }

    const nextRound = this.round + 1;
    if (nextRound > this.totalRounds || !hasNext) {
      return { round: this.round, flagSeq: this.flagSeq, passed: false, finalized: true };
    }
    this.round = nextRound; this.flagSeq += 1; this.flag = nextFlag!;
    return { round: this.round, flagSeq: this.flagSeq, passed: false, finalized: false };
  }

  /** Eski stil manuel ilerletme (round + flag_seq birlikte artar). */
  advance(nextRound: number, nextFlag: string) { this.round = nextRound; this.flagSeq += 1; this.flag = nextFlag; }
  /** start_game: game_seq++ (monoton), flag_seq=1. Eski oylar/çözümler anahtar izolasyonuyla inert. */
  startNewGame(gameSeq: number, flag: string) { this.gameSeq = gameSeq; this.round = 1; this.flagSeq = 1; this.flag = flag; }
}

console.log("9) QUORUM formülü (floor(N/2)+1) — salt çoğunluk");
{
  eq(requiredPassVotes(2), 2, "2 oyuncu → 2 oy");
  eq(requiredPassVotes(3), 2, "3 oyuncu → 2 oy");
  eq(requiredPassVotes(4), 3, "4 oyuncu → 3 oy");
  eq(requiredPassVotes(5), 3, "5 oyuncu → 3 oy");
  eq(requiredPassVotes(6), 4, "6 oyuncu → 4 oy");
  eq(requiredPassVotes(10), 6, "10 oyuncu → 6 oy");
}

console.log("10) 2 oyuncu — 1 oy quorum OLUŞTURMAZ, 2 oy OLUŞTURUR");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b"]);
  const r1 = e.togglePass("a", 1, 1);
  assert(r1.voted && r1.vote_count === 1 && r1.required === 2 && !r1.resolved, "1/2 → quorum yok");
  const r2 = e.togglePass("b", 1, 1);
  assert(r2.voted && r2.vote_count === 2 && r2.resolved && r2.passed, "2/2 → PAS ile kapandı");
  eq(e.resolutionOf(1, 1), "pass", "tur çözümü = pass");
}

console.log("11) 3 oyuncu — 2 oy quorum; 4 oyuncu — 2 yetmez, 3 gerekir");
{
  const e3 = new RoundEngine(1, 1, "tr", ["a", "b", "c"]);
  eq(e3.togglePass("a", 1, 1).required, 2, "3 oyuncu required=2");
  assert(e3.togglePass("b", 1, 1).passed, "3 oyuncuda 2. oy pas eder");

  const e4 = new RoundEngine(1, 1, "tr", ["a", "b", "c", "d"]);
  const a = e4.togglePass("a", 1, 1); const b = e4.togglePass("b", 1, 1);
  assert(a.required === 3 && !a.resolved && !b.resolved, "4 oyuncuda 2 oy YETMEZ (required 3)");
  assert(e4.togglePass("c", 1, 1).passed, "4 oyuncuda 3. oy pas eder");
}

console.log("12) 5 oyuncu → 3 gerekir · 10 oyuncu → 6 gerekir");
{
  const e5 = new RoundEngine(1, 1, "tr", ["a", "b", "c", "d", "e"]);
  assert(!e5.togglePass("a", 1, 1).resolved && !e5.togglePass("b", 1, 1).resolved, "5'te 2 oy yetmez");
  assert(e5.togglePass("c", 1, 1).passed && e5.togglePass("c", 1, 1).required === 3, "5'te 3. oy pas (required 3)");

  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const e10 = new RoundEngine(1, 1, "tr", ids);
  for (let i = 0; i < 5; i++) assert(!e10.togglePass(ids[i], 1, 1).resolved, `10'da ${i + 1}. oy pas etmez`);
  const sixth = e10.togglePass(ids[5], 1, 1);
  assert(sixth.passed && sixth.required === 6, "10 oyuncuda 6. oy pas eder (required 6)");
}

console.log("13) TEKİLLEŞTİRME — aynı oyuncu aynı turda iki oy oluşturamaz + toggle geri çekme");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c", "d"]);   // required 3
  const v1 = e.togglePass("a", 1, 1);
  assert(v1.voted && v1.vote_count === 1, "a ilk oy → 1");
  const v2 = e.togglePass("a", 1, 1);                            // tekrar tıkla → geri çek
  assert(!v2.voted && v2.vote_count === 0, "a tekrar tıkla → oy GERİ ÇEKİLDİ (0)");
  // reconnect/retry: aynı tuple raw insert iki kez → ON CONFLICT DO NOTHING
  e.rawInsertVote("a"); e.rawInsertVote("a");
  eq(e.voteCount(), 1, "duplicate INSERT → tek satır (reconnect duplicate oy YOK)");
}

console.log("14) YENİ ROUND — eski oylar etkisiz (tur-anahtarı game_seq:round)");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c"]);        // required 2
  e.togglePass("a", 1, 1);                                        // round1: 1/2 (pas etmez)
  e.advance(2, "us");                                             // game_seq=1 sabit, round=2
  const r2 = e.togglePass("b", 1, 2);
  assert(r2.voted && r2.vote_count === 1, "round2 SIFIRDAN başlar (eski round1 oyu sayılmaz)");
  assert(!r2.resolved, "round2'de tek oy pas etmez");
}

console.log("15) YENİ GAME_SEQ — eski oyunun oyları/çözümü yeni oyunu ETKİLEMEZ");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b"]);            // required 2
  assert(e.togglePass("a", 1, 1).voted, "oyun1 r1: a oy");
  assert(e.togglePass("b", 1, 1).passed, "oyun1 r1: PAS ile kapandı");
  eq(e.resolutionOf(1, 1), "pass", "oyun1 r1 çözümü=pass");
  e.startNewGame(2, "tr");                                       // game_seq=2, round=1, aynı bayrak
  assert(e.resolutionOf(2, 1) === null, "oyun2 r1 AÇIK (eski game_seq çözümü sızmaz)");
  const n = e.togglePass("a", 2, 1);
  assert(n.voted && n.vote_count === 1, "oyun2 r1 oyları SIFIRDAN (eski oylar inert)");
}

console.log("16) STALE tur oyu reddedilir (client bayat game_seq/round)");
{
  const e = new RoundEngine(1, 3, "de", ["a", "b", "c"]);
  const stale = e.togglePass("a", 1, 2);                        // client hâlâ round 2'de
  assert(!stale.voted && stale.stale === true, "bayat round oyu YAZILMAZ (stale)");
  eq(e.voteCount(), 0, "stale oy tur sayacını değiştirmedi");
  const staleGs = e.togglePass("a", 0, 3);                      // bayat game_seq
  assert(!staleGs.voted && staleGs.stale === true, "bayat game_seq oyu 'stale'");
}

console.log("17) ATILAN / AYRILAN oyuncu oy VEREMEZ");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c"]);
  e.removePlayer("c");                                           // kick/leave → player row silindi
  const r = e.togglePass("c", 1, 1);
  assert(!r.voted && r.error === "player_room_mismatch", "atılan/ayrılan oyuncu oy veremez");
}

console.log("18) OYUNCU AYRILINCA quorum aktif sayıya göre yeniden hesaplanır");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c", "d"]);   // required 3
  e.togglePass("a", 1, 1); const before = e.togglePass("b", 1, 1);
  assert(before.required === 3 && !before.resolved, "4 aktif → required 3, 2 oy yetmez");
  e.removePlayer("d");                                           // non-voter ayrıldı → 3 aktif
  eq(e.required(), 2, "ayrılma sonrası required=2 (3 aktif)");
  // Yeni eşikte 2 oy artık yeter: b geri çek + tekrar oyla → 2/2 pas.
  e.togglePass("b", 1, 1);                                       // unvote → 1/2
  const decisive = e.togglePass("b", 1, 1);                     // vote → 2/2
  assert(decisive.passed && decisive.required === 2, "güncel eşikte (2) çoğunluk pas eder");
}

console.log("19) CLAIM önce → pas turu TEKRAR kapatamaz, skor korunur");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c"]);       // required 2
  const claim = e.submitClaim("a", "tr");
  assert(claim.claimed, "a doğru cevabı önce claim etti");
  const p1 = e.togglePass("b", 1, 1);
  assert(p1.resolved && !p1.passed, "pas: tur zaten kapandı (round_closed, passed=false)");
  const p2 = e.togglePass("c", 1, 1);
  assert(p2.resolved && !p2.passed, "ikinci pas oyu da turu paslamaz");
  eq(e.resolutionOf(1, 1), "claim", "tur çözümü CLAIM kalır (pas override etmez)");
  // Sentinel değil gerçek claim → skor a'ya yazılır (pas sentinel skor yazmaz).
  eq(computeScores([{ player_id: "a", country_code: "tr" }]).get("a") ?? 0, 1, "kazanan skoru korunur");
}

console.log("20) PAS önce → sonraki doğru claim SKOR YAZAMAZ ('dup')");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b"]);            // required 2
  e.togglePass("a", 1, 1);
  assert(e.togglePass("b", 1, 1).passed, "pas çoğunluğu turu kapattı");
  const late = e.submitClaim("a", "tr");                        // araya giren doğru cevap
  assert(!late.claimed && late.reason === "dup", "pas sonrası claim 'dup' (skor YOK)");
  eq(e.resolutionOf(1, 1), "pass", "tur çözümü PAS kalır");
}

console.log("21) EŞZAMANLI iki vote çoğunluk → tur BİR KEZ kapanır (kilit seri)");
{
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c"]);       // required 2
  e.togglePass("a", 1, 1);                                       // 1/2
  const b = e.togglePass("b", 1, 1);                            // 2/2 → pas (kilidi ilk alan)
  const c = e.togglePass("c", 1, 1);                            // kilidi sonra alan → round_closed
  assert(b.passed, "ilk çoğunluk-oyu turu paslar");
  assert(c.resolved && !c.passed, "ikinci eşzamanlı oy: ikinci kez PASLAMAZ (tek çözüm)");
  eq(e.resolutionOf(1, 1), "pass", "tek çözüm satırı: pass");
}

console.log("22) TIMEOUT + PAS aynı anda → DB'de tek çözüm (timeout DB'ye yazmaz)");
{
  // Timeout client-side'dır (DB'ye yazmaz); pas sentinel tek DB çözümüdür.
  const e = new RoundEngine(1, 1, "tr", ["a", "b"]);           // required 2
  e.togglePass("a", 1, 1);
  assert(e.togglePass("b", 1, 1).passed, "pas turu kapattı");
  // Süre dolduğunda geç gelen bir cevap denemesi → bucket dolu → dup.
  const afterTimeout = e.submitClaim("a", "tr");
  assert(!afterTimeout.claimed && afterTimeout.reason === "dup", "timeout+pas: tur ikinci kez kapanmaz");
}

console.log("23) SON TUR pas → tur çözülür (host normal finalize eder)");
{
  // Son tur da pas ile kapanabilir; client isLast → finalize akışı devreye
  // girer (bu saf katmanda yalnız 'pas çözümü oluştu' doğrulanır).
  const e = new RoundEngine(1, 5, "fr", ["a", "b", "c"]);      // game_seq=1, round 5 = son
  e.togglePass("a", 1, 5);
  assert(e.togglePass("b", 1, 5).passed, "son tur PAS ile kapandı → normal finalize'ı besler");
  eq(e.resolutionOf(1, 5), "pass", "son tur çözümü=pass");
}

console.log("24) PAS SENTİNEL — skor sayımına girmez, paslanan bayrak çıkarılır");
{
  assert(isPassClaim("pass:tr"), "'pass:tr' pas sentinel'i");
  assert(!isPassClaim("tr"), "düz kod pas sentinel'i değil");
  eq(passClaimFlagCode("pass:tr"), "tr", "sentinel'den paslanan bayrak çıkarılır");
  eq(passClaimFlagCode("tr"), null, "düz kod → null");
  assert(!isScoringClaim("pass:tr"), "pas sentinel'i SKOR sayılmaz");
  // Karışık claims: 2 gerçek + 1 pas sentinel → skor yalnız gerçeklerden.
  const claims: FGClaimLike[] = [
    { player_id: "a", country_code: "tr" },
    { player_id: "b", country_code: "us" },
    { player_id: "a", country_code: "pass:de" },   // paslanan tur (kimse puan almaz)
  ];
  eq(computeScores(claims).get("a") ?? 0, 1, "a = 1 (pas sentinel'i skor yazmadı)");
  // Host reconnect exclude seti: paslanan 'de' de gösterilmiş sayılır.
  const shown = shownFlagCodes(claims).sort();
  eq(shown, ["de", "tr", "us"], "shownFlagCodes: gerçek + paslanan bayraklar (tekrar önlenir)");
}

console.log("25) FK CASCADE güvenliği — pas sentinel HOST'a bağlı, decider ayrılınca SİLİNMEZ");
{
  // flag_group_claims.player_id NOT NULL + ON DELETE CASCADE. Sentinel'i host'a
  // bağlamak → decider (veya herhangi non-host) ayrılınca cascade sentinel'i
  // silmez → paslanan tur "çözülü" kalır (host advance iptal olmaz).
  const e = new RoundEngine(1, 1, "tr", ["a", "b", "c"], "a");   // host=a, required 2
  e.togglePass("b", 1, 1);                                        // 1/2
  const dec = e.togglePass("c", 1, 1);                            // 2/2 → pas (decider = c)
  assert(dec.passed, "c çoğunluğu tamamladı (decider)");
  eq(e.resolutionOwnerOf(1, 1), "a", "sentinel SAHİBİ = host (decider c DEĞİL)");
  e.removePlayer("c");                                            // decider reveal penceresinde ayrıldı
  eq(e.resolutionOf(1, 1), "pass", "host-sahipli sentinel: decider ayrılınca cascade SİLMEZ (tur çözülü kalır)");

  // Karşıt kanıt: sahip non-host olsaydı (gerçek-claim gibi) → cascade siler.
  const g = new RoundEngine(1, 1, "tr", ["a", "b", "c"], "a");
  g.submitClaim("c", "tr");                                       // sahip = c (claimer)
  eq(g.resolutionOwnerOf(1, 1), "c", "claim sahibi = claimer");
  g.removePlayer("c");
  eq(g.resolutionOf(1, 1), null, "sahip ayrılınca cascade siler → bu yüzden sentinel HOST'a bağlanır");
}

// ══════════════════════════════════════════════════════════════════════════
//  PAS TUR TÜKETMEZ — flag_seq (gösterilen-bayrak kimliği) semantiği
// ══════════════════════════════════════════════════════════════════════════
// serverAdvanceFlag = flag_group_advance_flag SQL sözleşmesi: SERVER, mevcut
// (game_seq, flag_seq) çözümünü kilit altında okuyup round ilerlemesine karar
// verir. PAS → round DEĞİŞMEZ + flag_seq++; claim/timeout → round+1 (+flag_seq++);
// nextFlag null → havuz tükendi → finalize.

console.log("26) PAS TURU TÜKETMEZ — TUR 4/5 flag_seq 7 paslanır → TUR HÂLÂ 4/5, flag_seq 8");
{
  // game_seq 3, round 4/5, flag_seq 7 (Nikaragua 'ni'). host=a, required=2.
  const e = new RoundEngine(3, 4, "ni", ["a", "b", "c"], "a", { flagSeq: 7, totalRounds: 5 });
  e.togglePass("b", 3, 4, 7);
  const passed = e.togglePass("c", 3, 4, 7);
  assert(passed.passed, "flag_seq 7 çoğunlukla paslandı");
  eq(e.resolutionOf(3, 7), "pass", "flag_seq 7 çözümü = pass");
  const adv = asAdv(e.serverAdvanceFlag("us"));             // host aday sonraki bayrak
  assert(!adv.finalized, "pas → oyun BİTMEZ");
  eq(adv.round, 4, "TUR HÂLÂ 4/5 (pas turu TÜKETMEZ)");
  eq(adv.flagSeq, 8, "flag_seq 8 (yeni bayrak, aynı tur)");

  // (test 3) Yeni bayrağın (flag_seq 8) doğru claim'i KABUL — eski sentinel bloklamaz.
  assert(e.submitClaim("b", "us").claimed, "yeni bayrak flag_seq 8 doğru claim KABUL (eski 'pass:ni' sentinel'i çakışmaz)");
  // (test 4) Eski flag_seq 7'ye ait claim/vote artık STALE.
  eq(e.submitClaim("a", "ni"), { claimed: false, reason: "stale" }, "eski bayrak 'ni' cevabı 'stale' (current flag artık 'us')");
  assert(e.togglePass("a", 3, 4, 7).stale === true, "eski flag_seq 7 pas oyu 'stale' reddedilir");
}

console.log("27) PAS VOTE yeni flag_seq'de 0/N — eski oylar sızmaz");
{
  const e = new RoundEngine(1, 2, "tr", ["a", "b", "c"], "a", { flagSeq: 3, totalRounds: 5 }); // required 2
  e.togglePass("a", 1, 2, 3);
  assert(e.togglePass("b", 1, 2, 3).passed, "flag_seq 3 paslandı (2/2)");
  eq(e.voteCount(), 2, "flag_seq 3 oy sayısı = 2");
  e.serverAdvanceFlag("us");                                // → flag_seq 4, round HÂLÂ 2
  eq(e.voteCount(), 0, "yeni flag_seq 4'te oy sayısı 0/N");
  const v = e.togglePass("a", 1, 2, 4);
  assert(v.voted && v.vote_count === 1, "yeni bayrakta oylama sıfırdan (1/2)");
}

console.log("28) FİNAL TUR PAS → oyun BİTMEZ, aynı final turda yeni bayrak; sonra doğru → biter");
{
  // round 5/5 = son tur, flag_seq 9. required 2.
  const e = new RoundEngine(1, 5, "fr", ["a", "b", "c"], "a", { flagSeq: 9, totalRounds: 5 });
  e.togglePass("b", 1, 5, 9);
  assert(e.togglePass("c", 1, 5, 9).passed, "son tur (5/5) paslandı");
  const adv = asAdv(e.serverAdvanceFlag("de"));
  assert(!adv.finalized, "SON TUR pas → oyun BİTMEZ (finalize yok)");
  eq(adv.round, 5, "aynı final tur (5/5) korunur");
  eq(adv.flagSeq, 10, "final tur altında yeni bayrak (flag_seq 10)");
  // Bu yeni bayrak doğru bilinince NORMAL kural işler → oyun biter (son tur claim).
  assert(e.submitClaim("a", "de").claimed, "final turun yeni bayrağı (flag_seq 10) doğru bilindi");
  assert(asAdv(e.serverAdvanceFlag("gr")).finalized, "final tur claim → oyun BİTER (mevcut oyun kuralı)");
}

console.log("29) CLAIM önce → tek çözüm=claim; sonra round NORMAL ilerler (pas turu değil)");
{
  const e = new RoundEngine(2, 3, "tr", ["a", "b", "c"], "a", { flagSeq: 5, totalRounds: 5 }); // required 2
  assert(e.submitClaim("a", "tr").claimed, "a doğru cevabı önce claim etti");
  const p = e.togglePass("b", 2, 3, 5);
  assert(p.resolved && !p.passed, "pas: bayrak zaten claim ile çözüldü (round_closed)");
  eq(e.resolutionOf(2, 5), "claim", "tek çözüm = claim (pas override etmez)");
  const adv = asAdv(e.serverAdvanceFlag("us"));
  assert(!adv.finalized && adv.round === 4 && adv.flagSeq === 6, "claim çözümü → round 3→4 ilerler, flag_seq 6");
}

console.log("30) TIMEOUT (DB çözümü yok) → round NORMAL ilerler, flag_seq++");
{
  const e = new RoundEngine(1, 2, "tr", ["a", "b"], "a", { flagSeq: 2, totalRounds: 5 });
  assert(e.resolutionOf(1, 2) === null, "timeout: DB'de çözüm satırı yok");
  const adv = asAdv(e.serverAdvanceFlag("us"));
  assert(!adv.finalized && adv.round === 3 && adv.flagSeq === 3, "timeout → round 2→3, flag_seq 3 (mevcut davranış korunur)");
}

console.log("31) AYNI BAYRAK pas sonrası TEKRAR SEÇİLMEZ (host havuzu + shownFlagCodes)");
{
  const seq = ["tr", "us", "de", "fr", "ni"];
  // tur1 'tr' gösterildi + paslandı → host used'e 'tr' ekler (current + shownFlagCodes).
  const shown = shownFlagCodes([
    { player_id: "h", country_code: "pass:tr" },   // paslanan bayrak
    { player_id: "b", country_code: "us" },        // claim edilen bayrak
  ]).sort();
  eq(shown, ["tr", "us"], "shownFlagCodes: paslanan 'tr' + claim 'us' ikisi de 'gösterildi'");
  const next = pickNextFlagCode(seq, new Set(shown));
  eq(next, "de", "paslanan+claim edilen atlanır → sıradaki 'de' (aynı bayrak tekrar gelmez)");
}

console.log("32) POOL TÜKENDİ (nextFlag null) → advance finalize eder (pas VEYA claim)");
{
  const ePass = new RoundEngine(1, 3, "tr", ["a", "b"], "a", { flagSeq: 8, totalRounds: 10 });
  ePass.togglePass("a", 1, 3, 8);
  assert(ePass.togglePass("b", 1, 3, 8).passed, "flag_seq 8 paslandı");
  assert(asAdv(ePass.serverAdvanceFlag(null)).finalized, "pas + havuz tükendi (nextFlag null) → finalize");

  const eClaim = new RoundEngine(1, 3, "tr", ["a", "b"], "a", { flagSeq: 8, totalRounds: 10 });
  assert(eClaim.submitClaim("a", "tr").claimed, "flag_seq 8 claim edildi");
  assert(asAdv(eClaim.serverAdvanceFlag(null)).finalized, "claim + havuz tükendi → finalize");
}

// ══════════════════════════════════════════════════════════════════════════
//  GÜVENLİK — erken-advance (timeout) guard'ı + next_flag doğrulaması +
//  stale flag_seq no-op + eski set_next_round revoke (migration statik denetimi)
// ══════════════════════════════════════════════════════════════════════════

console.log("33) ERKEN ADVANCE — çözüm yok + server timeout DOLMAMIŞ → round_active reddi (mutation yok)");
{
  // Bayrak t=1000ms'de gösterildi; timer 10sn. Host t=5000ms'de (henüz <11000)
  // advance dener → hiç claim/pas yok → REDDEDİLİR, state DEĞİŞMEZ.
  const e = new RoundEngine(1, 2, "tr", ["a", "b"], "a", { flagSeq: 4, totalRounds: 5, flagShownAt: 1000 });
  const r = e.serverAdvanceFlag("us", 5000);
  assert("rejected" in r && r.rejected === "round_active", "timer dolmadan advance → round_active reddi");
  eq(e.round, 2, "current_round DEĞİŞMEDİ"); eq(e.flagSeq, 4, "flag_seq DEĞİŞMEDİ"); eq(e.flag, "tr", "current_flag DEĞİŞMEDİ");
}

console.log("34) TIMEOUT DOLDU (çözüm yok) → advance round+flag_seq'i doğru ilerletir");
{
  const e = new RoundEngine(1, 2, "tr", ["a", "b"], "a", { flagSeq: 4, totalRounds: 5, flagShownAt: 1000 });
  const r = asAdv(e.serverAdvanceFlag("us", 12000));   // t=12000 >= 1000+10000 → dolmuş
  assert(!r.finalized && r.round === 3 && r.flagSeq === 5, "server timeout dolunca round 2→3, flag_seq 5");
}

console.log("35) PAS sentinel → timeout BEKLEMEDEN yeni bayrak, round AYNI");
{
  // Pas t=3000ms'de çözüldü (timer dolmadan). Host t=4000ms'de advance → pas
  // dalı timeout guard'ına GİRMEZ (çözüm var), yeni bayrak gelir, round aynı.
  const e = new RoundEngine(1, 4, "tr", ["a", "b"], "a", { flagSeq: 6, totalRounds: 5, flagShownAt: 0 });
  e.togglePass("a", 1, 4, 6);
  assert(e.togglePass("b", 1, 4, 6).passed, "flag_seq 6 paslandı (t erken)");
  const r = asAdv(e.serverAdvanceFlag("us", 4000));    // timer dolmamış ama pas var
  assert(!r.finalized && r.round === 4 && r.flagSeq === 7, "pas → timeout beklemeden yeni bayrak, round 4 sabit");
}

console.log("36) GERÇEK CLAIM → timeout BEKLEMEDEN round ilerler");
{
  const e = new RoundEngine(1, 4, "tr", ["a", "b"], "a", { flagSeq: 6, totalRounds: 5, flagShownAt: 0 });
  assert(e.submitClaim("a", "tr").claimed, "flag_seq 6 claim (t erken)");
  const r = asAdv(e.serverAdvanceFlag("us", 3000));    // timer dolmamış ama claim var
  assert(!r.finalized && r.round === 5 && r.flagSeq === 7, "claim → timeout beklemeden round 4→5");
}

console.log("37) next_flag DOĞRULAMASI — boş/bozuk/aynı REDDEDİLİR; null = finalize sinyali");
{
  const mk = () => new RoundEngine(1, 2, "tr", ["a", "b"], "a", { flagSeq: 3, totalRounds: 5 });
  // Çözüm var (claim) ki timeout guard'ı yolu kesmesin — yalnız next_flag'i sına.
  const withClaim = () => { const e = mk(); e.submitClaim("a", "tr"); return e; };
  assert(("rejected" in withClaim().serverAdvanceFlag("")     ) , "boş next_flag reddedilir");
  assert(("rejected" in withClaim().serverAdvanceFlag("   ")  ) , "whitespace next_flag reddedilir");
  assert(("rejected" in withClaim().serverAdvanceFlag("USA")  ) , "3 harf next_flag reddedilir (biçim)");
  assert(("rejected" in withClaim().serverAdvanceFlag("t1")   ) , "harf-dışı next_flag reddedilir");
  const empt = withClaim().serverAdvanceFlag("");
  assert("rejected" in empt && empt.rejected === "next_flag_invalid", "boş → next_flag_invalid");
  const same = withClaim().serverAdvanceFlag("tr");   // current_flag ile aynı
  assert("rejected" in same && same.rejected === "next_flag_unchanged", "current_flag ile aynı → next_flag_unchanged");
  const sameCase = withClaim().serverAdvanceFlag("TR"); // büyük/küçük harf normalize
  assert("rejected" in sameCase && sameCase.rejected === "next_flag_unchanged", "'TR' de aynı sayılır (normalize)");
  // null → MEŞRU finalize sinyali (havuz tükendi), REDDEDİLMEZ (claim + son yoksa finalize).
  const nullRes = asAdv(withClaim().serverAdvanceFlag(null));
  assert(nullRes.finalized === true, "null next_flag → finalize (havuz tükendi, reddedilmez)");
  // Geçerli farklı kod → kabul.
  const ok = asAdv(withClaim().serverAdvanceFlag("us"));
  assert(!ok.finalized && ok.round === 3, "geçerli farklı 'us' → kabul, round ilerler");
}

console.log("38) STALE flag_seq çağrısı → no-op (çift-ilerletme guard'ı, mutation yok)");
{
  const e = new RoundEngine(1, 2, "tr", ["a", "b"], "a", { flagSeq: 5, totalRounds: 5, flagShownAt: 0 });
  e.submitClaim("a", "tr");
  asAdv(e.serverAdvanceFlag("us", 3000, 5));           // expected 5 == current → ilerler → flag_seq 6
  eq(e.flagSeq, 6, "ilk advance flag_seq 5→6");
  const stale = e.serverAdvanceFlag("de", 3000, 5) as AdvanceResult;  // client hâlâ 5 gönderiyor (bayat)
  assert(stale.noop === true, "bayat flag_seq (5) çağrısı → no-op");
  eq(e.flagSeq, 6, "no-op sonrası flag_seq DEĞİŞMEDİ (6)"); eq(e.round, 3, "round DEĞİŞMEDİ");
}

console.log("39) MIGRATION statik denetim — eski set_next_round EXECUTE revoke edilmiş");
{
  const sql = readFileSync("supabase/migrations/20260731120000_flag_group_flag_sequence.sql", "utf8");
  const norm = sql.replace(/\s+/g, " ");
  assert(
    /revoke execute on function public\.flag_group_set_next_round\([^)]*\) from public, anon, authenticated/i.test(norm),
    "set_next_round EXECUTE public/anon/authenticated'tan revoke edildi",
  );
  // advance_flag'in server-side timeout guard'ı SQL'de mevcut (10 saniye).
  assert(/interval '10 seconds'/.test(sql) && /round_active/.test(sql),
    "advance_flag server-side timeout guard'ı (interval '10 seconds' + round_active) SQL'de mevcut");
  // next_flag biçim + aynı-bayrak doğrulaması SQL'de mevcut.
  assert(/\^\[a-z\]\{2\}\$/.test(sql) && /next_flag_invalid/.test(sql) && /next_flag_unchanged/.test(sql),
    "next_flag doğrulaması (^[a-z]{2}$ + next_flag_invalid/unchanged) SQL'de mevcut");
  // Atomik anahtarlar flag_seq'e taşınmış.
  assert(/unique \(room_id, game_seq, flag_seq\)/.test(sql) &&
         /unique \(room_id, game_seq, flag_seq, player_id\)/.test(sql),
    "claim + pass_vote unique anahtarları flag_seq'e taşınmış");

  // ── name[] = text[] regresyon guard'ı (SQL Editor hatası: 42883) ──
  // TÜM array_agg(att.attname …) ::text cast'li olmalı (name[] üretmemeli).
  const aggAll = sql.match(/array_agg\(\s*att\.attname[^)]*\)/g) ?? [];
  assert(aggAll.length === 2, `iki dinamik constraint-tespit array_agg'i bulundu (got ${aggAll.length})`);
  assert(aggAll.every(a => /att\.attname::text/.test(a) && /order by att\.attname::text/.test(a)),
    "her array_agg(att.attname) hem değerde hem ORDER BY'da ::text cast'li (name[]≠text[] önlendi)");
  assert(!/array_agg\(\s*att\.attname\s+order by/.test(sql),
    "cast'siz array_agg(att.attname order by …) KALMADI");
  // RHS karşılaştırma dizileri açıkça ::text[].
  assert((sql.match(/\]::text\[\]/g) ?? []).length >= 2, "karşılaştırma dizileri ::text[] cast'li");

  // ── İdempotency guard'ları (partial re-run güvenliği) ──
  assert((sql.match(/add column if not exists flag_seq/g) ?? []).length === 3,
    "3 tablonun flag_seq'i `add column if not exists` ile eklenir (rooms/claims/pass_votes)");
  assert(/create index if not exists flag_group_pass_votes_flag_idx/.test(sql),
    "flag_seq index'i `if not exists` guard'lı");
  assert((sql.match(/if not exists \(\s*select 1 from pg_constraint/g) ?? []).length === 2,
    "yeni unique constraint'ler `if not exists` guard'lı (çift-ekleme yok)");
  assert(/drop function if exists public\.flag_group_toggle_pass_vote\(uuid, uuid, uuid, int, int\)/.test(sql),
    "eski 5-arg toggle_pass_vote `drop function if exists` ile kaldırılır");
  // Fonksiyonlar create or replace (yeniden koşulabilir).
  assert((sql.match(/create or replace function/g) ?? []).length >= 4,
    "RPC'ler create or replace (idempotent)");
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
