/**
 * check-route-duel-logic.ts — Rota Duel sunucu-otoriter oyun mantığı sözleşmesi.
 *
 * 20260802120000_route_duel_init.sql'deki RPC durum makinesinin SAF/DB'siz
 * aynası (check-room-code-resolver.ts'in simulateResolve yaklaşımı). SQL'in
 * kilit (FOR UPDATE) altında SERİ çalıştığı varsayımıyla mutasyonlar burada
 * sıralı fonksiyonlardır; UNIQUE(room, game_seq, round) + round_winner guard
 * birlikte modellenir.
 *
 * DRIFT UYARISI: SQL RPC kuralları değişirse burası da güncellenmeli.
 *
 * Çalıştır:  npx tsx scripts/check-route-duel-logic.ts
 */
import { NEIGHBOR_GRAPH } from "../src/data/countries";
import { ROUTE_DUEL_POOL } from "../src/data/routeDuelData.generated";
import {
  intermediatesForLength,
  matchOutcomeAfterRound,
  routeDuelChatKey,
  routePairKey,
  type RouteDuelLength,
} from "../src/lib/routeDuelShared";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, a);
}

/* ════════════════════════════════════════════════════════════════════════
   SUNUCU AYNASI — route_duel_* RPC durum makinesi
════════════════════════════════════════════════════════════════════════ */

const COUNTDOWN_MS = 3000;
const ROUND_MS = 60000;

interface SimPlayer {
  id: string;
  name: string;
  profileId: string | null;
  isHost: boolean;
  score: number;
  currentKey: string | null;
  path: string[];
  lastSeenMs: number;
}

interface SimClaim { gameSeq: number; round: number; playerId: string; steps: number }

interface SimRoom {
  status: "waiting" | "playing" | "finished";
  totalRounds: number;
  routeLength: RouteDuelLength;
  hostId: string;
  gameSeq: number;
  currentRound: number;
  roundStart: string | null;
  roundTarget: string | null;
  roundPair: string | null;
  roundStartedMs: number;
  roundDeadlineMs: number;
  roundWinnerId: string | null;
  roundDecidedMs: number;
  usedPairKeys: string[];
  rematchVotes: string[];
  matchSeq: number;
  winnerId: string | null;
  finishedReason: string | null;
  players: SimPlayer[];
  claims: SimClaim[];
  /** Deterministik rota seçici (test enjekte eder; SQL'de ORDER BY random()). */
  rng: () => number;
}

type MoveResult = { accepted: boolean; finished: boolean; won: boolean; reason?: string };

/** _route_duel_pick_route aynası: bant filtresi + used dışlama + rastgele yön. */
function pickRoute(room: SimRoom): { pair: string; start: string; target: string } {
  const bands = intermediatesForLength(room.routeLength);
  let candidates = ROUTE_DUEL_POOL.filter(
    ([a, b, mid]) => bands.includes(mid) && !room.usedPairKeys.includes(routePairKey(a, b)),
  );
  if (candidates.length === 0) {
    // Havuz tükendi fallback'i (SQL ile aynı: used filtresi bırakılır).
    candidates = ROUTE_DUEL_POOL.filter(([, , mid]) => bands.includes(mid));
  }
  if (candidates.length === 0) throw new Error("route_pool_empty");
  const [a, b] = candidates[Math.floor(room.rng() * candidates.length) % candidates.length];
  const flip = room.rng() < 0.5;
  return { pair: routePairKey(a, b), start: flip ? b : a, target: flip ? a : b };
}

/** _route_duel_begin_round aynası. */
function beginRound(room: SimRoom, nextRound: number, nowMs: number) {
  const r = pickRoute(room);
  room.currentRound = nextRound;
  room.roundStart = r.start;
  room.roundTarget = r.target;
  room.roundPair = r.pair;
  room.roundStartedMs = nowMs + COUNTDOWN_MS;
  room.roundDeadlineMs = nowMs + COUNTDOWN_MS + ROUND_MS;
  room.roundWinnerId = null;
  room.roundDecidedMs = 0;
  room.usedPairKeys.push(r.pair);
  for (const p of room.players) {
    p.currentKey = r.start;
    p.path = [r.start];
  }
}

function createRoom(opts: {
  hostProfileId: string | null;
  totalRounds: number;
  routeLength: RouteDuelLength;
  rng?: () => number;
}): SimRoom {
  return {
    status: "waiting",
    totalRounds: opts.totalRounds,
    routeLength: opts.routeLength,
    hostId: "H",
    gameSeq: 0,
    currentRound: 0,
    roundStart: null,
    roundTarget: null,
    roundPair: null,
    roundStartedMs: 0,
    roundDeadlineMs: 0,
    roundWinnerId: null,
    roundDecidedMs: 0,
    usedPairKeys: [],
    rematchVotes: [],
    matchSeq: 1,
    winnerId: null,
    finishedReason: null,
    players: [{
      id: "H", name: "Host", profileId: opts.hostProfileId,
      isHost: true, score: 0, currentKey: null, path: [], lastSeenMs: 0,
    }],
    claims: [],
    rng: opts.rng ?? Math.random,
  };
}

/** route_duel_join_room aynası: kapasite KESİN 2 + aynı profil + status guard. */
function joinRoom(room: SimRoom, playerId: string, profileId: string | null, name: string): string | null {
  if (room.status === "finished") return "room_finished";
  if (room.status === "playing") return "room_in_progress";
  if (profileId !== null && room.players.some(p => p.profileId === profileId)) return "already_in_room";
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return "name_taken";
  if (room.players.length >= 2) return "room_full";
  room.players.push({
    id: playerId, name, profileId, isHost: false,
    score: 0, currentKey: null, path: [], lastSeenMs: 0,
  });
  return null;
}

/** route_duel_start_game aynası. */
function startGame(room: SimRoom, callerId: string, nowMs: number): string | null {
  if (callerId !== room.hostId) return "unauthorized";
  if (room.status !== "waiting") return "room_not_waiting";
  if (room.players.length < 2) return "not_enough_players";
  room.claims = [];
  for (const p of room.players) { p.score = 0; p.currentKey = null; p.path = []; }
  room.status = "playing";
  room.gameSeq += 1;
  room.rematchVotes = [];
  room.winnerId = null;
  room.finishedReason = null;
  beginRound(room, 1, nowMs);
  return null;
}

/** route_duel_submit_move aynası — client YALNIZ hedef ülke anahtarı gönderir;
 *  konum (currentKey) SUNUCU state'inden okunur (sahte current_country YOK). */
function submitMove(room: SimRoom, playerId: string, countryKey: string, nowMs: number): MoveResult {
  const player = room.players.find(p => p.id === playerId);
  if (!player) throw new Error("player_room_mismatch");
  if (room.status !== "playing") throw new Error("room_not_playing");

  if (room.roundWinnerId !== null) return { accepted: false, finished: false, won: false, reason: "round_over" };
  if (nowMs < room.roundStartedMs) return { accepted: false, finished: false, won: false, reason: "not_started" };
  if (nowMs >= room.roundDeadlineMs) return { accepted: false, finished: false, won: false, reason: "expired" };

  if (player.currentKey === null) throw new Error("round_not_initialized");
  if (countryKey === player.currentKey) return { accepted: false, finished: false, won: false, reason: "same_country" };

  const neighbors = NEIGHBOR_GRAPH[player.currentKey] ?? [];
  if (!neighbors.includes(countryKey)) {
    return { accepted: false, finished: false, won: false, reason: "not_neighbor" };
  }

  player.currentKey = countryKey;
  player.path = [...player.path, countryKey];
  const steps = player.path.length - 1;

  if (countryKey !== room.roundTarget) {
    return { accepted: true, finished: false, won: false };
  }

  // UNIQUE(room, game_seq, round) — ilk-bitiren claim'i.
  if (room.claims.some(c => c.gameSeq === room.gameSeq && c.round === room.currentRound)) {
    return { accepted: true, finished: true, won: false, reason: "dup" };
  }
  room.claims.push({ gameSeq: room.gameSeq, round: room.currentRound, playerId, steps });
  player.score += 1;
  room.roundWinnerId = playerId;
  room.roundDecidedMs = nowMs;
  return { accepted: true, finished: true, won: true };
}

/** route_duel_advance_round aynası: tur bitmeden ilerleme YOK; son turda skor
 *  farklıysa finalize; eşitse uzatma turu. */
function advanceRound(room: SimRoom, callerId: string, nowMs: number): string | null {
  if (!room.players.some(p => p.id === callerId)) return "player_room_mismatch";
  if (room.status === "finished") return null; // idempotent
  if (room.status !== "playing") return "room_not_playing";

  const roundOver = room.roundWinnerId !== null || nowMs >= room.roundDeadlineMs;
  if (!roundOver) return "round_not_over";

  const scores = room.players.map(p => p.score);
  const hi = Math.max(...scores);
  const lo = Math.min(...scores);

  if (room.currentRound >= room.totalRounds && hi !== lo) {
    const winner = [...room.players].sort((a, b) => b.score - a.score)[0];
    room.status = "finished";
    room.finishedReason = "completed";
    room.winnerId = winner.id;
    return null;
  }
  beginRound(room, room.currentRound + 1, nowMs);
  return null;
}

/** route_duel_request_rematch aynası — TEK sunucu-otoriter RPC (SQL'de FOR
 *  UPDATE altında seri): oy kaydı + İKİNCİ ONAYDA aynı transaction'da yeni
 *  maç. Ayrı process_rematch YOK; host client'ına bağımlılık YOK.
 *  Dönüş: started = bu çağrı yeni maçı başlattı mı. */
function requestRematch(
  room: SimRoom,
  playerId: string,
  nowMs: number,
): { error: string | null; started: boolean } {
  if (!room.players.some(p => p.id === playerId)) {
    return { error: "player_room_mismatch", started: false };
  }
  // finished DIŞI faz: oy KAYDEDİLMEZ, no-op (retry/çift tık ikinci maç açamaz).
  if (room.status !== "finished") return { error: null, started: false };

  // Idempotent oy + bayat oy temizliği (yalnız mevcut üyelerin oyları sayılır).
  if (!room.rematchVotes.includes(playerId)) room.rematchVotes.push(playerId);
  room.rematchVotes = room.rematchVotes.filter(v => room.players.some(p => p.id === v));

  if (room.rematchVotes.length < 2) return { error: null, started: false };

  // İKİNCİ ONAY → aynı transaction'da yeni maç (kim onaylarsa onaylasın).
  room.claims = [];
  for (const p of room.players) { p.score = 0; p.currentKey = null; p.path = []; }
  room.status = "playing";
  room.rematchVotes = [];
  room.gameSeq += 1;
  room.matchSeq += 1;
  room.winnerId = null;
  room.finishedReason = null;
  beginRound(room, 1, nowMs);
  return { error: null, started: true };
}

/** route_duel_leave_room aynası. Dönüş: odanın silinip silinmediği. */
function leaveRoom(room: SimRoom, playerId: string): { deleted: boolean } {
  const isHost = playerId === room.hostId;
  if (room.status === "playing") {
    const other = room.players.find(p => p.id !== playerId);
    if (other) {
      room.status = "finished";
      room.finishedReason = "opponent_left";
      room.winnerId = other.id;
      return { deleted: false };
    }
  }
  if (isHost) return { deleted: true };
  room.players = room.players.filter(p => p.id !== playerId);
  return { deleted: room.players.length === 0 };
}

/** route_duel_handle_disconnect aynası (20 sn sunucu eşiği). */
function handleDisconnect(room: SimRoom, callerId: string, nowMs: number): boolean {
  if (room.status !== "playing") return false;
  const opp = room.players.find(p => p.id !== callerId);
  if (!opp) return false;
  if (opp.lastSeenMs > nowMs - 20000) return false; // eşik dolmadı → no-op
  room.status = "finished";
  room.finishedReason = "disconnect";
  room.winnerId = callerId;
  return true;
}

/** route_duel_quick_match eşleşme filtresi aynası. */
function queueMatches(
  a: { totalRounds: number; routeLength: string; level: number; maxDiff: number },
  b: { totalRounds: number; routeLength: string; level: number; maxDiff: number },
): boolean {
  return (
    a.totalRounds === b.totalRounds &&
    a.routeLength === b.routeLength &&
    Math.abs(a.level - b.level) <= Math.min(a.maxDiff, b.maxDiff)
  );
}

/* ── Deterministik RNG (mulberry32) ── */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** BFS ile en kısa yolu bul (sim oyuncusunun 'mükemmel' hamle dizisi). */
function bfsPath(start: string, end: string): string[] {
  const prev = new Map<string, string>([[start, ""]]);
  let frontier = [start];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of NEIGHBOR_GRAPH[cur] ?? []) {
        if (prev.has(nb)) continue;
        prev.set(nb, cur);
        if (nb === end) {
          const path: string[] = [nb];
          let at = cur;
          while (at !== "") { path.unshift(at); at = prev.get(at)!; }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  throw new Error(`no path ${start}→${end}`);
}

/** Bir turu 'playerId kazansın' diye oynat (en kısa yol + advance). */
function playRoundWonBy(room: SimRoom, winnerId: string, nowMs: number): number {
  let t = Math.max(nowMs, room.roundStartedMs);
  const path = bfsPath(room.roundStart!, room.roundTarget!);
  for (let i = 1; i < path.length; i++) {
    const res = submitMove(room, winnerId, path[i], t);
    if (!res.accepted) throw new Error(`move rejected: ${res.reason}`);
    t += 300;
  }
  const err = advanceRound(room, room.hostId, t + 1000);
  if (err) throw new Error(`advance failed: ${err}`);
  return t + 1000;
}

/* ════════════════════════════════════════════════════════════════════════
   TESTLER
════════════════════════════════════════════════════════════════════════ */

console.log("\n▶ Rota Duel oyun mantığı sözleşmesi\n");

/* ── ODA YAŞAM DÖNGÜSÜ ── */
console.log("· 1. Oda: kapasite 2 / aynı kullanıcı / playing odaya giriş");
{
  const room = createRoom({ hostProfileId: "prof-H", totalRounds: 5, routeLength: "5", rng: seededRng(1) });
  eq(joinRoom(room, "G", "prof-G", "Guest"), null, "ikinci oyuncu katılır");
  eq(joinRoom(room, "X", "prof-X", "Third"), "room_full", "üçüncü oyuncu → room_full (kapasite KESİN 2)");
  const r2 = createRoom({ hostProfileId: "prof-H", totalRounds: 5, routeLength: "5", rng: seededRng(2) });
  eq(joinRoom(r2, "H2", "prof-H", "HostAgain"), "already_in_room", "aynı kullanıcı (profil) iki slot alamaz");
  joinRoom(r2, "G", "prof-G", "Guest");
  startGame(r2, "H", 0);
  eq(joinRoom(r2, "L", "prof-L", "Late"), "room_in_progress", "oyun başlamış odaya giriş engelli");
}

console.log("· 2. Oda: host ayrılınca lobby kapanır; playing'de leave = forfeit");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(3) });
  joinRoom(room, "G", null, "Guest");
  eq(leaveRoom(room, "H").deleted, true, "lobby'de host leave → oda DELETE (guest 'oda kapatıldı' görür)");

  const r2 = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(4) });
  joinRoom(r2, "G", null, "Guest");
  startGame(r2, "H", 0);
  const res = leaveRoom(r2, "G");
  ok(!res.deleted && r2.status === "finished" && r2.winnerId === "H" && r2.finishedReason === "opponent_left",
    "playing'de guest leave → forfeit, host kazanır, oda korunur");
}

/* ── ROTA ÜRETİMİ ── */
console.log("· 3. Rota üretimi: iki oyuncuya AYNI route state + doğru bant");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(5) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  ok(!!room.roundStart && !!room.roundTarget && room.roundStart !== room.roundTarget,
    "başlangıç ≠ hedef, ikisi de dolu");
  const [pH, pG] = room.players;
  ok(pH.currentKey === room.roundStart && pG.currentKey === room.roundStart,
    "iki oyuncu da AYNI başlangıçta (oda-seviyesi tek route state)");
  const entry = ROUTE_DUEL_POOL.find(([a, b]) => routePairKey(a, b) === room.roundPair);
  eq(entry?.[2], 5, "'5' ayarı → seçilen rota gerçekten 5 ara ülke");
}

console.log("· 4. Rota üretimi: '7plus' yalnız 8/9; asla 10+; 7 değil");
{
  for (let seed = 10; seed < 30; seed++) {
    const room = createRoom({ hostProfileId: null, totalRounds: 3, routeLength: "7plus", rng: seededRng(seed) });
    joinRoom(room, "G", null, "Guest");
    startGame(room, "H", 0);
    const entry = ROUTE_DUEL_POOL.find(([a, b]) => routePairKey(a, b) === room.roundPair)!;
    if (entry[2] !== 8 && entry[2] !== 9) {
      ok(false, `seed ${seed}: '7plus' bant dışı rota üretti`, entry[2]);
    }
  }
  ok(true, "20 farklı seed'de '7plus' hep 8 veya 9 ara ülke üretti");
}

console.log("· 5. Aynı maçta aynı rota (ve tersi) tekrar gelmez");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 15, routeLength: "5", rng: seededRng(42) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = 0;
  const seen = new Set<string>([room.roundPair!]);
  for (let i = 0; i < 14; i++) {
    t = playRoundWonBy(room, i % 2 === 0 ? "H" : "G", t + 5000);
    if (room.status !== "playing") break;
    ok2NoDup(seen, room.roundPair!);
  }
  function ok2NoDup(s: Set<string>, pair: string) {
    if (s.has(pair)) ok(false, "aynı maçta rota tekrarı!", pair);
    s.add(pair);
  }
  ok(true, `15 turluk maçta ${seen.size} benzersiz rota (tekrar yok; ters çift aynı pair_key)`);
  eq(new Set(room.usedPairKeys).size, room.usedPairKeys.length, "used_pair_keys duplicate içermiyor");
}

/* ── HAMLE DOĞRULAMA ── */
console.log("· 6. Hamle: komşu kabul / komşu-olmayan red / sahte konum imkânsız");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(7) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  const t0 = room.roundStartedMs + 100;

  const start = room.roundStart!;
  const neighbor = NEIGHBOR_GRAPH[start][0];
  const nonNeighbor = Object.keys(NEIGHBOR_GRAPH).find(
    k => k !== start && !NEIGHBOR_GRAPH[start].includes(k),
  )!;

  eq(submitMove(room, "H", neighbor, t0).accepted, true, "geçerli komşu hamlesi kabul");
  eq(submitMove(room, "G", nonNeighbor, t0).reason, "not_neighbor", "komşu olmayan ülke reddedilir");
  eq(submitMove(room, "G", start, t0).reason, "same_country", "yerinde sayma reddedilir");

  // 'Sahte current_country': API yüzeyinde konum parametresi YOK — H şu an
  // neighbor'da; hedef başka bir kıtadaysa bile SUNUCU konumundan doğrular.
  // H, start'ın (artık gerisinde kaldığı) komşusuna değil, kendi GERÇEK
  // konumunun komşusuna göre değerlendirilir:
  const hNow = room.players.find(p => p.id === "H")!.currentKey!;
  eq(hNow, neighbor, "sunucu konumu H'nin GERÇEK konumu (client iddiası değil)");
  const fakeFrom = NEIGHBOR_GRAPH[start].find(k => k !== hNow && !NEIGHBOR_GRAPH[hNow].includes(k));
  if (fakeFrom) {
    eq(submitMove(room, "H", fakeFrom, t0 + 1).reason, "not_neighbor",
      "start'ın komşusu ama H'nin konumunun komşusu değil → red (sahte konum işlemez)");
  } else {
    ok(true, "start komşuları hep H konumuna da komşu (bu rotada ayrım yok) — atlandı");
  }

  // Geri sayım bitmeden hamle yok:
  eq(submitMove(room, "G", NEIGHBOR_GRAPH[start][1] ?? neighbor, room.roundStartedMs - 1000).reason,
    "not_started", "3sn ortak geri sayımda hamle işlenmez");
}

/* ── İLK-BİTİREN + SKOR ── */
console.log("· 7. İlk tamamlayan kazanır; ikinci completion skoru değiştirmez");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(8) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = room.roundStartedMs + 100;
  const path = bfsPath(room.roundStart!, room.roundTarget!);

  // İki oyuncu paralel ilerler; H son hamleyi önce yapar.
  for (let i = 1; i < path.length - 1; i++) {
    submitMove(room, "H", path[i], t); t += 100;
    submitMove(room, "G", path[i], t); t += 100;
  }
  const rH = submitMove(room, "H", path[path.length - 1], t); t += 50;
  const rG = submitMove(room, "G", path[path.length - 1], t);

  ok(rH.won === true, "ilk tamamlayan turu kazanır");
  ok(rG.won === false && rG.reason === "round_over", "ikinci completion kazanamaz (round_over)");
  eq(room.players.find(p => p.id === "H")!.score, 1, "kazanan skoru +1");
  eq(room.players.find(p => p.id === "G")!.score, 0, "kaybedenin skoru DEĞİŞMEZ");
  eq(room.claims.length, 1, "tur başına TEK claim (UNIQUE bucket)");
  ok(room.roundWinnerId === "H", "tur kazananı sunucu state'inde");

  // 'Sahte finished/winner': API'de winner/finished parametresi YOK — kazanan
  // yalnız claim insert'iyle oluşur. G'nin tekrar denemesi de değiştirmez:
  const rG2 = submitMove(room, "G", path[path.length - 1], t + 10);
  ok(rG2.won === false, "tekrar deneme de kazandırmaz");
  eq(room.roundWinnerId, "H", "kazanan sabit kalır");
}

console.log("· 8. Erken tur atlama imkânsız; timeout puansız ilerler");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(9) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  const midRound = room.roundStartedMs + 5000;
  eq(advanceRound(room, "H", midRound), "round_not_over", "kazanan yok + süre dolmadı → advance reddedilir");

  // Timeout: kimse bitiremedi → puansız ilerleme.
  const afterDeadline = room.roundDeadlineMs + 1000;
  eq(submitMove(room, "H", NEIGHBOR_GRAPH[room.roundStart!][0], afterDeadline).reason, "expired",
    "deadline sonrası hamle 'expired' (sunucu saati; client kronometresi değil)");
  // Timeout ilerlemesi HOST'A BAĞIMLI DEĞİL: non-host (G) tetikler.
  eq(advanceRound(room, "G", afterDeadline), null,
    "timeout sonrası advance kabul (non-host tetikledi; host client'ına bağımlılık YOK)");
  eq(room.currentRound, 2, "tur 2'ye geçti");
  eq(room.players.every(p => p.score === 0), true, "timeout turunda KİMSE puan almadı");
  eq(room.claims.length, 0, "timeout turu claim üretmedi");

  // Duplicate advance (iki client'ın yarışı / retry): yeni tur bitmeden
  // ikinci çağrı 'round_not_over' alır → aynı tur İKİ kez ilerlemez.
  eq(advanceRound(room, "H", afterDeadline + 200), "round_not_over",
    "ikinci advance çağrısı reddedilir (duplicate ilerleme YOK)");
  eq(room.currentRound, 2, "tur numarası 2'de sabit (çift advance işlemedi)");
}

console.log("· 9. Tur skorları doğru; belirlenen tur sayısında sonuç");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 3, routeLength: "5", rng: seededRng(11) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = 0;
  t = playRoundWonBy(room, "H", t + 4000);   // 1-0
  t = playRoundWonBy(room, "H", t + 4000);   // 2-0
  t = playRoundWonBy(room, "G", t + 4000);   // 2-1 → maç biter
  eq(room.players.find(p => p.id === "H")!.score, 2, "H skoru 2");
  eq(room.players.find(p => p.id === "G")!.score, 1, "G skoru 1");
  eq(room.status, "finished", "3 tur sonunda maç bitti");
  eq(room.winnerId, "H", "kazanan = yüksek skor (sunucu hesabı)");
  eq(room.finishedReason, "completed", "finished_reason = completed");
}

/* ── UZATMA ── */
console.log("· 10. Eşitlik uzatmaya gider; ilk uzatma galibi maçı kazanır");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 10, routeLength: "5", rng: seededRng(12) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = 0;
  // 10 turu 5-5 eşitliğe getir.
  for (let i = 0; i < 10; i++) t = playRoundWonBy(room, i % 2 === 0 ? "H" : "G", t + 4000);
  eq(room.status, "playing", "10 tur 5-5 → sonuç ekranı DEĞİL, maç sürüyor");
  eq(room.currentRound, 11, "uzatma (sudden-death) turu 11 başladı");
  ok(!room.usedPairKeys.slice(0, -1).includes(room.roundPair!), "uzatma rotası da kullanılmamış rota");
  eq(matchOutcomeAfterRound(10, 10, 5, 5), "continue", "saf kural: eşitlik → continue");

  // Uzatma turu da timeout olursa → yeni uzatma turu.
  const afterDl = room.roundDeadlineMs + 500;
  eq(advanceRound(room, "H", afterDl), null, "uzatma timeout → yeni uzatma turu");
  eq(room.currentRound, 12, "ikinci uzatma turu");
  eq(room.status, "playing", "eşitlik sürdükçe sudden-death devam");

  // İlk uzatma galibiyeti maçı bitirir.
  t = playRoundWonBy(room, "G", room.roundStartedMs + 100);
  eq(room.status, "finished", "uzatma galibi → maç biter");
  eq(room.winnerId, "G", "uzatmayı kazanan maçın galibi");
  eq(matchOutcomeAfterRound(12, 10, 5, 6), "finalize", "saf kural: uzatma sonrası fark → finalize");
}

/* ── RÖVANŞ ── */
console.log("· 11. Rövanş: İKİNCİ ONAY sunucuda maçı başlatır (host client'sız)");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 3, routeLength: "5", rng: seededRng(13) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = 0;
  t = playRoundWonBy(room, "H", t + 4000);
  t = playRoundWonBy(room, "H", t + 4000);
  t = playRoundWonBy(room, "H", t + 4000);
  eq(room.status, "finished", "maç bitti (3-0)");
  const firstMatchPairs = [...room.usedPairKeys];

  // Tek onay → maç BAŞLAMAZ, yalnız bekleme durumu.
  eq(requestRematch(room, "H", t).started, false, "tek onayla maç BAŞLAMAZ (bekleme durumu)");
  eq(room.status, "finished", "tek onay sonrası oda hâlâ finished");
  // Aynı kullanıcının duplicate onayı ikinci oyuncu SAYILMAZ.
  eq(requestRematch(room, "H", t).started, false, "aynı oyuncunun duplicate onayı maç başlatmaz");
  eq(room.rematchVotes.length, 1, "duplicate oy ikinci oyuncu sayılmadı (1 oy)");

  // İkinci onay GUEST'ten gelir; host client HİÇBİR ek RPC çağırmaz
  // (host sekmesi arka planda/bağlantısız senaryosuyla birebir aynı akış:
  // sunucu maçı bu çağrının transaction'ında başlatır).
  const second = requestRematch(room, "G", t);
  eq(second.started, true, "guest'in ikinci onayı rövanşı BAŞLATIR (host'tan ek RPC YOK)");
  eq(room.status, "playing", "AYNI odada yeni maç (lobiye dönmeden); host bağlantısız olsa da başlar");
  eq(room.players.every(p => p.score === 0), true, "skorlar sıfırlandı");
  const [rpH, rpG] = room.players;
  ok(rpH.currentKey === room.roundStart && rpG.currentKey === room.roundStart,
    "rövanşta iki oyuncuya AYNI yeni rota (current_key = ortak start)");
  eq(room.totalRounds, 3, "ayarlar korundu (tur sayısı)");
  eq(room.routeLength, "5", "ayarlar korundu (rota uzunluğu)");
  eq(room.gameSeq, 2, "game_seq arttı (eski claim'ler yeni maçı etkileyemez)");
  eq(room.claims.length, 0, "eski claim'ler temizlendi");
  ok(!firstMatchPairs.includes(room.roundPair!), "rövanşın ilk rotası önceki maçta KULLANILMAMIŞ");

  // Rövanş maçını oyna: önceki maç rotaları hâlâ dışlanıyor.
  t = playRoundWonBy(room, "G", t + 4000);
  if (room.status === "playing") {
    ok(!firstMatchPairs.includes(room.roundPair!), "rövanş 2. turu da önceki maç rotalarını dışlar");
  }
}

console.log("· 11b. Rövanş: eşzamanlı ikinci-onay / ağ retry'ı / çift tık → TEK maç");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 3, routeLength: "5", rng: seededRng(21) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = 0;
  t = playRoundWonBy(room, "H", t + 4000);
  t = playRoundWonBy(room, "H", t + 4000);
  t = playRoundWonBy(room, "H", t + 4000);
  requestRematch(room, "H", t);

  // İki eşzamanlı ikinci-onay isteği (SQL'de FOR UPDATE seri işler): yalnız
  // İLKİ maçı başlatır; ikincisi status='playing' görür → no-op.
  const c1 = requestRematch(room, "G", t);
  const seqAfterStart = room.gameSeq;
  const pairAfterStart = room.roundPair;
  const c2 = requestRematch(room, "G", t + 10); // retry / çift tık / eski state
  eq(c1.started, true, "eşzamanlı ikinci-onaylardan İLKİ maçı başlatır");
  eq(c2.started, false, "kilidi sonra alan çağrı no-op (ikinci maç YOK)");
  eq(room.gameSeq, seqAfterStart, "iki eşzamanlı istek TEK game_seq üretti");
  eq(room.roundPair, pairAfterStart, "retry yeni rota seçmedi (tur state'i bozulmadı)");

  // Skorlar yalnız BİR kez sıfırlanır: retry öncesi atılan hamle korunur.
  const mv = submitMove(room, "H", bfsPath(room.roundStart!, room.roundTarget!)[1], room.roundStartedMs + 100);
  eq(mv.accepted, true, "yeni maçta hamle işliyor");
  const pathLenBefore = room.players.find(p => p.id === "H")!.path.length;
  requestRematch(room, "H", room.roundStartedMs + 200); // playing'de geç retry
  eq(room.players.find(p => p.id === "H")!.path.length, pathLenBefore,
    "playing'de gelen geç retry skorları/konumu İKİNCİ kez sıfırlamadı");
  eq(room.rematchVotes.length, 0, "playing'de oy kaydedilmez");
}

console.log("· 11c. Rövanş: finished olmayan oda + ayrılan oyuncunun bayat oyu");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 3, routeLength: "5", rng: seededRng(22) });
  joinRoom(room, "G", null, "Guest");

  // waiting odada rövanş başlatılamaz / oy kaydedilmez.
  eq(requestRematch(room, "H", 0).started, false, "waiting odada rövanş başlatılamaz");
  eq(room.rematchVotes.length, 0, "waiting odada oy kaydedilmez");

  startGame(room, "H", 0);
  eq(requestRematch(room, "H", 1000).started, false, "playing odada rövanş başlatılamaz");
  eq(room.status, "playing", "playing oda etkilenmedi");

  // Bayat oy: guest oylar, odadan ayrılır; host'un tek onayı maç başlatamaz.
  let t = 0;
  t = playRoundWonBy(room, "H", t + 4000);
  t = playRoundWonBy(room, "H", t + 4000);
  t = playRoundWonBy(room, "H", t + 4000);
  eq(room.status, "finished", "maç bitti");
  requestRematch(room, "G", t);
  leaveRoom(room, "G"); // finished'da guest ayrılır (oy dizisinde bayat kayıt)
  const res = requestRematch(room, "H", t);
  eq(res.started, false, "ayrılan oyuncunun bayat oyu + host oyu maç BAŞLATAMAZ");
  eq(room.status, "finished", "tek kişilik odada rövanş başlamadı");
}

/* ── RECONNECT / DISCONNECT ── */
console.log("· 12. Reconnect state bozmaz; kopuş kararı sunucuda");
{
  const room = createRoom({ hostProfileId: null, totalRounds: 5, routeLength: "5", rng: seededRng(14) });
  joinRoom(room, "G", null, "Guest");
  startGame(room, "H", 0);
  let t = room.roundStartedMs + 100;
  const path = bfsPath(room.roundStart!, room.roundTarget!);
  submitMove(room, "H", path[1], t); t += 100;

  // 'Reconnect': client state'i kaybolur ama SUNUCU konum/path'i korur —
  // kaldığı yerden bir SONRAKİ komşuya devam edebilir (start'tan değil).
  const serverKey = room.players.find(p => p.id === "H")!.currentKey;
  eq(serverKey, path[1], "reconnect sonrası konum sunucuda aynen durur");
  eq(submitMove(room, "H", path[2], t).accepted, true, "kaldığı yerden devam eder");
  eq(room.players.find(p => p.id === "H")!.path.length, 3, "path bütünlüğü bozulmadı");

  // Disconnect: eşik dolmadan çağrı → no-op; dolunca kalan oyuncu kazanır.
  room.players.find(p => p.id === "G")!.lastSeenMs = t - 5000;
  eq(handleDisconnect(room, "H", t), false, "5 sn'lik sessizlik → sunucu reddeder (erken iddia)");
  room.players.find(p => p.id === "G")!.lastSeenMs = t - 25000;
  eq(handleDisconnect(room, "H", t), true, "20+ sn sessizlik → sunucu doğrular, maç biter");
  eq(room.winnerId, "H", "kalan oyuncu kazanır");
  eq(room.finishedReason, "disconnect", "finished_reason = disconnect");
}

/* ── HIZLI EŞLEŞ ── */
console.log("· 13. Hızlı Eşleş: aynı tur + aynı rota uzunluğu şartı");
{
  const me = { totalRounds: 5, routeLength: "7", level: 3, maxDiff: 5 };
  ok(queueMatches(me, { totalRounds: 5, routeLength: "7", level: 4, maxDiff: 5 }), "aynı tercihler + yakın seviye → eşleşir");
  ok(!queueMatches(me, { totalRounds: 10, routeLength: "7", level: 3, maxDiff: 5 }), "farklı tur sayısı → eşleşmez");
  ok(!queueMatches(me, { totalRounds: 5, routeLength: "7plus", level: 3, maxDiff: 5 }), "farklı rota uzunluğu → eşleşmez");
  ok(!queueMatches(me, { totalRounds: 5, routeLength: "7", level: 30, maxDiff: 9999 }), "bracket LEAST(caller, candidate) — dar taraf kazanır");
  ok(queueMatches({ ...me, maxDiff: 9999 }, { totalRounds: 5, routeLength: "7", level: 30, maxDiff: 9999 }), "iki taraf da geniş bracket → eşleşir");
}

/* ── CHAT İZOLASYONU ── */
console.log("· 14. Chat: mod-izole namespaced anahtar");
{
  eq(routeDuelChatKey("RABC12"), "route_duel:RABC12", "anahtar 'route_duel:<code>'");
  ok(routeDuelChatKey("RABC12") !== "RABC12", "plain koddan farklı (1v1 duel/wheel mesajlarına düşmez)");
  ok(!routeDuelChatKey("RABC12").startsWith("flag_group:"), "flag_group namespace'inden ayrık");
}

console.log(failed === 0 ? `\n✅ ${passed} passed, 0 failed` : `\n❌ ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
