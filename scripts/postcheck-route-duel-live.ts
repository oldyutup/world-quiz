/**
 * postcheck-route-duel-live.ts — Rota Düello CANLI runtime postcheck.
 *
 * ⚠ PRODUCTION'A YAZAR. 20260821150000 uygulandıktan SONRA, ELLE, BİR KEZ.
 *
 *     ROUTE_DUEL_LIVE_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \
 *     npx tsx scripts/postcheck-route-duel-live.ts --confirm
 *
 * Gate olmadan çalıştırıldığında HİÇBİR ŞEY yazmaz: yalnız planı basar
 * (dry-run) ve 0 ile çıkar.
 *
 * NE DOĞRULAR
 * ───────────
 * 20260821150000'in canlıdaki DAVRANIŞINI (metadata değil):
 *   T1 kimlik + oda başlatma; iki istemci AYNI sunucu state'ini okur
 *   T2 hamle senkronu — otorite DB; taze SELECT + GERÇEK realtime
 *      postgres_changes gözlemi (broadcast'e GÜVENİLMEZ)
 *   T3 OYUN İÇİ SÜRE YOK — 15/30/65+ sn gerçek bekleme; süre maçı bitirmez,
 *      hamle hâlâ kabul, kazanansız advance reddedilir
 *   T4 SUNUCU SETTLE — kazanandan hemen sonra / 3200 ms öncesi advance
 *      reddedilir; sonrasında TEK tur ilerler; duplicate ikinci turu atlamaz;
 *      non-host da ilerletebilir
 *   T5 reconnect — TAZE authenticated client aynı state'i görür
 *   T6 meşru tamamlama — 3 turluk maç normal biter, kazanan doğru
 *   T7 temizlik — bu scriptin kurduğu her oda kapanır (residual 0)
 *
 * GÜVENLİK KURALLARI (kodda zorlanır)
 *   • Kimlik YALNIZ .env.test.local'daki iki adanmış hesap (TORBLE_A/B).
 *   • Yalnız BU scriptin kurduğu odalara dokunulur: her sorgu `createdRoomIds`
 *     ile sınırlanır. Oda listeleme/arama YOK.
 *   • Oda kodları `RD-LIVE-` önekli ve tek kullanımlık.
 *   • Şema DEĞİŞMEZ, migration UYGULANMAZ: istemcinin route_duel tablolarında
 *     INSERT/UPDATE/DELETE grant'i YOKTUR (RPC-only) — script yapısal olarak
 *     satır mutasyonu yapamaz, yalnız desteklenen RPC'leri çağırır.
 *   • Zaman damgaları ASLA elle ileri/geri alınmaz; T3 gerçek süre bekler.
 *   • Hiçbir credential (url/key/e-posta/parola) konsola yazılmaz.
 *   • İlk beklenmedik hatada DURUR (fail-fast) ve yine de temizlik dener.
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NEIGHBOR_GRAPH } from "../src/data/countries";

/* ── Ortam ─────────────────────────────────────────────────────────────── */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!m) continue;
    const trimmed = m[2].trim();
    const quoted = trimmed.match(/^(["'])([\s\S]*)\1$/);
    out[m[1]] = quoted ? quoted[2] : trimmed;
  }
  return out;
}
const fileEnv = { ...readEnvFile(".env"), ...readEnvFile(".env.test.local") };
const cfg = (k: string) => process.env[k] ?? fileEnv[k] ?? "";

const SUPA_URL = cfg("VITE_SUPABASE_URL");
const SUPA_KEY = cfg("VITE_SUPABASE_ANON_KEY");
const ACCOUNTS = [
  { email: cfg("TORBLE_A_EMAIL"), password: cfg("TORBLE_A_PASSWORD") },
  { email: cfg("TORBLE_B_EMAIL"), password: cfg("TORBLE_B_PASSWORD") },
];

const ARMED =
  process.env.ROUTE_DUEL_LIVE_POSTCHECK === "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION" &&
  process.argv.includes("--confirm");

const PLAN = `
ROTA DÜELLO CANLI POSTCHECK — PLAN (dry-run)

  Ön koşul : 20260821150000 production'a UYGULANMIŞ olmalı.
  Kimlik   : .env.test.local → TORBLE_A / TORBLE_B (adanmış test hesapları)
  Odalar   : RD-LIVE-* önekli, script tarafından kurulur ve silinir

  T1  kimlik + oda kurulumu + iki taraf aynı state'i okur
  T2  hamle senkronu (taze SELECT + gerçek realtime postgres_changes)
  T3  SÜRE YOK: 15 / 30 / 65+ sn gerçek bekleme, sonra hamle hâlâ kabul
  T4  settle: hemen / <3200ms reddedilir, >=3200ms TEK tur ilerler
  T5  reconnect: taze authenticated client aynı state'i görür
  T6  meşru tamamlama (3 tur) → normal finalize
  T7  temizlik → residual 0

  Süre ~2-3 dk (T3 gerçek zaman bekler; damga DEĞİŞTİRİLMEZ).

  Çalıştırmak için:
    ROUTE_DUEL_LIVE_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \\
    npx tsx scripts/postcheck-route-duel-live.ts --confirm
`;

/* ── Raporlama ─────────────────────────────────────────────────────────── */
let passed = 0, failed = 0;
const results: string[] = [];
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); results.push(`PASS ${label}`); }
  else {
    failed++;
    console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`);
    results.push(`FAIL ${label}`);
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Beklenmedik hata → fail-fast (körlemesine retry YOK). */
class Fatal extends Error {}
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Fatal(`beklenmedik: ${what} yok`);
  return v;
}

/* ── Rota grafı yardımcıları (istemci kanonik grafı; sunucu grafı client'a
      KAPALI — route_duel_graph'ta hiçbir grant yok) ───────────────────── */
function bfsPath(start: string, target: string): string[] {
  if (start === target) return [start];
  const prev = new Map<string, string>([[start, ""]]);
  let frontier = [start];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of NEIGHBOR_GRAPH[cur] ?? []) {
        if (prev.has(nb)) continue;
        prev.set(nb, cur);
        if (nb === target) {
          const path = [nb];
          let c = cur;
          while (c) { path.unshift(c); c = prev.get(c)!; }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  throw new Fatal(`yol bulunamadı ${start}→${target}`);
}
/** Hedefe DOĞRU olmayan bir komşu (turu bitirmeden hamle yapmak için). */
function neighborAvoidingTarget(cur: string, target: string): string {
  const nbs = (NEIGHBOR_GRAPH[cur] ?? []).filter(n => n !== target);
  if (!nbs.length) throw new Fatal(`${cur} için hedef-dışı komşu yok`);
  return nbs[0];
}

const uuid = () => crypto.randomUUID();
const roomCode = () => `RD-LIVE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

interface Seat { client: SupabaseClient; playerId: string; claim: string; profileId: string; name: string; }

/* ── Ana akış ──────────────────────────────────────────────────────────── */
const createdRoomIds: string[] = [];
/** Temizlik için: her odanın iki koltuğu (leave_room claim-token ister). */
const seatsByRoom = new Map<string, { a: Seat; b: Seat }>();
let A!: SupabaseClient, B!: SupabaseClient;

async function readRoom(c: SupabaseClient, roomId: string) {
  const { data, error } = await c.from("route_duel_rooms").select("*").eq("id", roomId).maybeSingle();
  if (error) throw new Fatal(`oda okunamadı: ${error.message}`);
  return must(data, "oda satırı") as Record<string, unknown>;
}
async function readPlayers(c: SupabaseClient, roomId: string) {
  const { data, error } = await c.from("route_duel_players").select("*")
    .eq("room_id", roomId).order("joined_at", { ascending: true });
  if (error) throw new Fatal(`oyuncular okunamadı: ${error.message}`);
  return must(data, "oyuncu satırları") as Record<string, unknown>[];
}

/** Hesabın kendi username'i (yoksa güvenli yedek). Değer loglanmaz. */
async function ownUsername(c: SupabaseClient, profileId: string, fallback: string): Promise<string> {
  const { data } = await c.from("profiles").select("username").eq("id", profileId).maybeSingle();
  const u = (data as { username?: string } | null)?.username?.trim();
  return u && u.length >= 2 && u.length <= 16 ? u : fallback;
}

/** Odayı kurup maçı başlatır; iki koltuğu döndürür. */
async function openRoom(totalRounds: number): Promise<{ roomId: string; code: string; a: Seat; b: Seat }> {
  const code = roomCode();
  const a: Seat = { client: A, playerId: uuid(), claim: uuid(), profileId: "", name: "" };
  const b: Seat = { client: B, playerId: uuid(), claim: uuid(), profileId: "", name: "" };
  a.profileId = (await A.auth.getUser()).data.user!.id;
  b.profileId = (await B.auth.getUser()).data.user!.id;
  // Görünen ad HESABIN KENDİ username'i olmalı: assert_display_name_allowed
  // başka bir kayıtlı kullanıcıya ait bir adı 'registered_username_taken' ile
  // reddeder. Kendi nick'i 4. kuraldan her zaman geçer.
  a.name = await ownUsername(A, a.profileId, "RDLiveA");
  b.name = await ownUsername(B, b.profileId, "RDLiveB");

  const { data: created, error: cErr } = await A.rpc("route_duel_create_room", {
    p_player_id: a.playerId, p_profile_id: a.profileId, p_guest_id: null,
    p_name: a.name, p_code: code, p_total_rounds: totalRounds,
    p_route_length: "5", p_claim_token: a.claim,
  });
  if (cErr) throw new Fatal(`create_room: ${cErr.message}`);
  const roomId = (created as { id: string }).id;
  createdRoomIds.push(roomId);
  // Join/start başarısız olsa bile oda kurulmuş olur → hemen kaydet.
  seatsByRoom.set(roomId, { a, b });

  const { error: jErr } = await B.rpc("route_duel_join_room", {
    p_code: code, p_player_id: b.playerId, p_profile_id: b.profileId,
    p_guest_id: null, p_name: b.name, p_claim_token: b.claim,
  });
  if (jErr) throw new Fatal(`join_room: ${jErr.message}`);

  const { error: sErr } = await A.rpc("route_duel_start_game", {
    p_room_id: roomId, p_host_player_id: a.playerId, p_claim_token: a.claim,
  });
  if (sErr) throw new Fatal(`start_game: ${sErr.message}`);
  seatsByRoom.set(roomId, { a, b });   // temizlik kaydı — ASLA atlanmaz
  return { roomId, code, a, b };
}

async function submit(seat: Seat, roomId: string, key: string) {
  const { data, error } = await seat.client.rpc("route_duel_submit_move", {
    p_room_id: roomId, p_player_id: seat.playerId, p_claim_token: seat.claim, p_country_key: key,
  });
  if (error) return { accepted: false, reason: `rpc:${error.message}` } as Record<string, unknown>;
  return (data ?? {}) as Record<string, unknown>;
}
async function advance(seat: Seat, roomId: string): Promise<string> {
  const { error } = await seat.client.rpc("route_duel_advance_round", {
    p_room_id: roomId, p_player_id: seat.playerId, p_claim_token: seat.claim,
  });
  return error ? error.message : "ok";
}
/** Turu `seat` kazanacak şekilde gerçek yolu yürür. */
async function winRound(seat: Seat, roomId: string): Promise<void> {
  const room = await readRoom(seat.client, roomId);
  const players = await readPlayers(seat.client, roomId);
  const me = players.find(p => p.id === seat.playerId)!;
  const path = bfsPath(String(me.current_key), String(room.round_target_key));
  for (let i = 1; i < path.length; i++) {
    const res = await submit(seat, roomId, path[i]);
    if (!res.accepted) throw new Fatal(`tur kazanma hamlesi reddedildi: ${JSON.stringify(res)}`);
  }
}
/** 3 sn ortak geri sayımın bitmesini SUNUCU damgasına göre bekler. */
async function waitCountdown(c: SupabaseClient, roomId: string) {
  for (let i = 0; i < 40; i++) {
    const room = await readRoom(c, roomId);
    const startedMs = Date.parse(String(room.round_started_at));
    const { data: nowMs } = await c.rpc("get_server_time_ms");
    if (typeof nowMs === "number" && nowMs >= startedMs) return;
    await sleep(400);
  }
  throw new Fatal("geri sayım bitmedi");
}

async function main() {
  if (!SUPA_URL || !SUPA_KEY) { console.error("FAIL: VITE_SUPABASE_URL / ANON_KEY yok"); process.exit(1); }
  if (!ACCOUNTS[0].email || !ACCOUNTS[0].password || !ACCOUNTS[1].email || !ACCOUNTS[1].password) {
    console.error("FAIL: .env.test.local içinde TORBLE_A_*/TORBLE_B_* eksik"); process.exit(1);
  }
  if (!ARMED) { console.log(PLAN); process.exit(0); }

  A = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
  B = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

  /* ═══ T1 — KİMLİK + ODA BAŞLATMA ═══ */
  console.log("\nT1) Kimlik + oda başlatma");
  const sa = await A.auth.signInWithPassword(ACCOUNTS[0]);
  ok(!sa.error && !!sa.data.user, "TORBLE_A giriş yaptı", sa.error?.message);
  const sb = await B.auth.signInWithPassword(ACCOUNTS[1]);
  ok(!sb.error && !!sb.data.user, "TORBLE_B giriş yaptı", sb.error?.message);
  if (sa.error || sb.error) throw new Fatal("giriş başarısız");

  // XP/gold taban çizgisi (Rota Düello ödül yazmamalı).
  const baseline: Record<string, { xp: number; gold: number; level: number }> = {};
  for (const [tag, c, pid] of [["A", A, sa.data.user!.id], ["B", B, sb.data.user!.id]] as const) {
    const { data } = await c.from("profiles").select("xp, gold, level").eq("id", pid).maybeSingle();
    baseline[tag] = {
      xp: Number((data as Record<string, unknown> | null)?.xp ?? 0),
      gold: Number((data as Record<string, unknown> | null)?.gold ?? 0),
      level: Number((data as Record<string, unknown> | null)?.level ?? 0),
    };
  }

  const r1 = await openRoom(5);
  console.log(`  · oda ${r1.code}`);
  await waitCountdown(A, r1.roomId);

  const roomA = await readRoom(A, r1.roomId);
  const roomB = await readRoom(B, r1.roomId);
  ok(roomA.status === "playing", "oda 'playing'", roomA.status);
  ok(roomA.current_round === 1, "current_round = 1", roomA.current_round);
  ok(!!roomA.round_start_key && !!roomA.round_target_key, "start/target atandı");
  ok(JSON.stringify(roomA) === JSON.stringify(roomB), "A ve B AYNI oda satırını okuyor");
  const plA = await readPlayers(A, r1.roomId);
  const plB = await readPlayers(B, r1.roomId);
  ok(JSON.stringify(plA) === JSON.stringify(plB), "A ve B AYNI oyuncu satırlarını okuyor");
  ok(plA.every(p => p.current_key === roomA.round_start_key), "iki oyuncu da start'ta");
  ok(plA.every(p => Number(p.score) === 0), "skorlar 0-0");

  /* ═══ T2 — OTORİTER HAMLE SENKRONU (+ GERÇEK REALTIME) ═══ */
  console.log("\nT2) Hamle senkronu — otorite DB + realtime postgres_changes");
  // B'nin GERÇEK realtime aboneliği (üretim istemcisiyle aynı filtre).
  const rtEvents: Record<string, unknown>[] = [];
  // `chan.state === "joined"` YETMEZ: phoenix kanalı katılmış olsa bile
  // postgres_changes binding'i sunucuda biraz SONRA kurulur. Bağlanma
  // onayının tek güvenilir işareti subscribe() callback'indeki 'SUBSCRIBED'
  // durumudur; state'e bakıp hemen hamle yapmak olayı kaçırır (ilk koşuda
  // tam olarak bu oldu — üretimde realtime çalışıyordu, ölçüm yanlıştı).
  let subStatus = "";
  const chan = B.channel(`rd-live:${r1.roomId}`)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "route_duel_players", filter: `room_id=eq.${r1.roomId}` },
      payload => { rtEvents.push(payload.new as Record<string, unknown>); })
    .subscribe(st => { subStatus = st; });
  const subscribed = await new Promise<boolean>(res => {
    const t = setTimeout(() => res(false), 15_000);
    const iv = setInterval(() => {
      if (subStatus === "SUBSCRIBED") { clearInterval(iv); clearTimeout(t); res(true); }
      if (subStatus === "CHANNEL_ERROR" || subStatus === "TIMED_OUT") {
        clearInterval(iv); clearTimeout(t); res(false);
      }
    }, 150);
  });
  ok(subscribed, "B realtime kanalı SUBSCRIBED", subStatus);
  await sleep(1500);   // binding'in tam oturması için küçük pay

  const startKey = String(roomA.round_start_key);
  const targetKey = String(roomA.round_target_key);
  const aMove1 = neighborAvoidingTarget(startKey, targetKey);
  const resA = await submit(r1.a, r1.roomId, aMove1);
  ok(resA.accepted === true, "A hamlesi KABUL", resA);

  const aRowSrv = (await readPlayers(A, r1.roomId)).find(p => p.id === r1.a.playerId)!;
  ok(aRowSrv.current_key === aMove1, "A current_key sunucuda değişti", aRowSrv.current_key);
  ok(Array.isArray(aRowSrv.path) && (aRowSrv.path as string[]).length === 2,
     "A path sunucuda uzadı", aRowSrv.path);

  // B TAZE SELECT ile aynı otoriter state'i görüyor mu?
  const aRowSeenByB = (await readPlayers(B, r1.roomId)).find(p => p.id === r1.a.playerId)!;
  ok(JSON.stringify(aRowSeenByB) === JSON.stringify(aRowSrv), "B, A'nın satırını BİREBİR aynı görüyor");

  // Gerçek realtime olayı geldi mi?
  let rtSeen = false;
  for (let i = 0; i < 40 && !rtSeen; i++) {
    rtSeen = rtEvents.some(e => e.id === r1.a.playerId && e.current_key === aMove1);
    if (!rtSeen) await sleep(250);
  }
  ok(rtSeen, "B realtime postgres_changes ile A'nın hamlesini gördü",
     rtEvents.map(e => ({ id: e.id, k: e.current_key })));

  // B kendi yolunda hamle yapıyor → A görüyor.
  const bMove1 = neighborAvoidingTarget(startKey, targetKey);
  const resB = await submit(r1.b, r1.roomId, bMove1);
  ok(resB.accepted === true, "B hamlesi KABUL (non-host)", resB);
  const bRowSeenByA = (await readPlayers(A, r1.roomId)).find(p => p.id === r1.b.playerId)!;
  ok(bRowSeenByA.current_key === bMove1, "A, B'nin otoriter güncellemesini görüyor", bRowSeenByA.current_key);
  ok((bRowSeenByA.path as string[]).length === 2, "B path sunucuda uzadı", bRowSeenByA.path);

  /* ═══ T3 — OYUN İÇİ SÜRE YOK (GERÇEK ZAMAN) ═══ */
  console.log("\nT3) Oyun içi süre YOK — gerçek zaman bekleniyor (damga DEĞİŞTİRİLMEZ)");
  const t3Start = Date.now();
  for (const mark of [15, 30, 66]) {
    while (Date.now() - t3Start < mark * 1000) await sleep(1000);
    const rm = await readRoom(A, r1.roomId);
    const elapsed = Math.round((Date.now() - t3Start) / 1000);
    ok(rm.status === "playing", `>${mark}s: oda hâlâ 'playing' (t=${elapsed}s)`, rm.status);
    ok(rm.current_round === 1, `>${mark}s: tur ilerlemedi`, rm.current_round);
    ok(rm.winner_player_id === null, `>${mark}s: maç kazananı yok`, rm.winner_player_id);
  }
  // Eski 60 sn sınırının ÖTESİNDE hamle hâlâ kabul edilmeli.
  const aCur = String((await readPlayers(A, r1.roomId)).find(p => p.id === r1.a.playerId)!.current_key);
  const lateMove = neighborAvoidingTarget(aCur, targetKey);
  const lateRes = await submit(r1.a, r1.roomId, lateMove);
  ok(lateRes.accepted === true, ">65s sonra hamle HÂLÂ kabul (expired YOK)", lateRes);
  // Kazanan yokken advance zamanla ilerletemez.
  const advNoWinner = await advance(r1.a, r1.roomId);
  ok(advNoWinner.includes("round_not_over"), "kazanansız advance reddedildi (deadline tek başına ilerletmez)", advNoWinner);
  const afterAdv = await readRoom(A, r1.roomId);
  ok(afterAdv.status === "playing" && afterAdv.current_round === 1,
     "deadline-only advance sonrası oda değişmedi", { s: afterAdv.status, r: afterAdv.current_round });
  ok(afterAdv.round_deadline !== null, "legacy 6h round_deadline hâlâ dolu (eski istemci uyumu)", afterAdv.round_deadline);

  /* ═══ T4 — SUNUCU SETTLE ═══ */
  console.log("\nT4) Sunucu-otoriter settle penceresi");
  await winRound(r1.a, r1.roomId);
  const won = await readRoom(A, r1.roomId);
  ok(won.round_winner_player_id === r1.a.playerId, "tur kazananı sunucuda", won.round_winner_player_id);
  ok(won.round_decided_at !== null, "round_decided_at yazıldı");
  const decidedAtMs = Date.parse(String(won.round_decided_at));

  const immediate = await advance(r1.a, r1.roomId);
  ok(immediate.includes("round_not_over"), "kazanandan HEMEN sonra advance reddedildi", immediate);
  ok((await readRoom(A, r1.roomId)).current_round === 1, "tur atlamadı");

  // 3200 ms dolmadan (sunucu saatine göre) ikinci deneme de reddedilmeli.
  const { data: nowSrv } = await A.rpc("get_server_time_ms");
  const sinceDecided = Number(nowSrv) - decidedAtMs;
  if (sinceDecided < 3000) {
    const early = await advance(r1.b, r1.roomId);
    ok(early.includes("round_not_over"),
       `<3200ms (t=${sinceDecided}ms): advance hâlâ reddedildi`, early);
  } else {
    ok(true, `<3200ms penceresi ölçülemedi (t=${sinceDecided}ms) — hemen-sonra reddi yeterli kanıt`);
  }

  // Pencere dolduktan sonra NON-HOST ilerletebilmeli, TEK tur.
  while (Number((await A.rpc("get_server_time_ms")).data) - decidedAtMs < 3400) await sleep(250);
  const post = await advance(r1.b, r1.roomId);
  ok(post === "ok", "settle sonrası NON-HOST advance başarılı", post);
  const afterSettle = await readRoom(A, r1.roomId);
  ok(afterSettle.current_round === 2, "TAM BİR tur ilerledi", afterSettle.current_round);
  const dup = await advance(r1.a, r1.roomId);
  ok(dup.includes("round_not_over"), "duplicate/racing advance reddedildi", dup);
  ok((await readRoom(A, r1.roomId)).current_round === 2, "duplicate ikinci turu ATLAMADI");
  ok(Number((await readPlayers(A, r1.roomId)).find(p => p.id === r1.a.playerId)!.score) === 1,
     "kazanan puanı 1");

  /* ═══ T5 — RECONNECT ═══ */
  console.log("\nT5) Reconnect — taze authenticated client");
  const snapRoom = await readRoom(A, r1.roomId);
  const snapPlayers = await readPlayers(A, r1.roomId);
  const fresh = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
  const fr = await fresh.auth.signInWithPassword(ACCOUNTS[0]);
  ok(!fr.error, "taze client giriş yaptı", fr.error?.message);
  const reRoom = await readRoom(fresh, r1.roomId);
  const rePlayers = await readPlayers(fresh, r1.roomId);
  ok(reRoom.current_round === snapRoom.current_round, "reconnect: current_round aynı");
  ok(reRoom.round_start_key === snapRoom.round_start_key
     && reRoom.round_target_key === snapRoom.round_target_key, "reconnect: start/target aynı");
  ok(reRoom.status === snapRoom.status, "reconnect: faz/status aynı");
  ok(String(reRoom.round_winner_player_id) === String(snapRoom.round_winner_player_id),
     "reconnect: tur kazananı aynı");
  ok(JSON.stringify(rePlayers) === JSON.stringify(snapPlayers),
     "reconnect: current_key / path / skorlar BİREBİR aynı");
  await fresh.auth.signOut({ scope: "local" });

  /* ═══ T6 — MEŞRU TAMAMLAMA (3 tur) ═══ */
  console.log("\nT6) Meşru tamamlama — 3 turluk maç");
  const r2 = await openRoom(3);
  console.log(`  · oda ${r2.code}`);
  for (let round = 1; round <= 3; round++) {
    await waitCountdown(A, r2.roomId);
    await winRound(r2.a, r2.roomId);
    const rr = await readRoom(A, r2.roomId);
    ok(rr.round_winner_player_id === r2.a.playerId, `tur ${round}: kazanan kaydedildi`);
    const dMs = Date.parse(String(rr.round_decided_at));
    while (Number((await A.rpc("get_server_time_ms")).data) - dMs < 3400) await sleep(250);
    const adv = await advance(r2.a, r2.roomId);
    ok(adv === "ok", `tur ${round}: settle sonrası ilerledi`, adv);
  }
  const done = await readRoom(A, r2.roomId);
  ok(done.status === "finished", "maç 'finished'", done.status);
  ok(done.finished_reason === "completed", "finished_reason = completed (timeout DEĞİL)", done.finished_reason);
  ok(done.winner_player_id === r2.a.playerId, "maç kazananı doğru", done.winner_player_id);
  const finalPlayers = await readPlayers(A, r2.roomId);
  ok(Number(finalPlayers.find(p => p.id === r2.a.playerId)!.score) === 3, "kazanan skoru 3");
  ok(Number(finalPlayers.find(p => p.id === r2.b.playerId)!.score) === 0, "kaybeden skoru 0");
  const dupFinal = await advance(r2.b, r2.roomId);
  ok(dupFinal === "ok", "bitmiş maçta advance idempotent (exception yok)", dupFinal);
  const stillDone = await readRoom(A, r2.roomId);
  ok(stillDone.winner_player_id === r2.a.playerId && stillDone.status === "finished",
     "çift finalize YOK — kazanan/durum değişmedi");

  /* ═══ XP / GOLD ═══ */
  console.log("\nXP/Gold — Rota Düello ödül yazmamalı");
  for (const [tag, c, pid] of [["A", A, sa.data.user!.id], ["B", B, sb.data.user!.id]] as const) {
    const { data } = await c.from("profiles").select("xp, gold, level").eq("id", pid).maybeSingle();
    const d = (data ?? {}) as Record<string, unknown>;
    const same = Number(d.xp ?? 0) === baseline[tag].xp
      && Number(d.gold ?? 0) === baseline[tag].gold
      && Number(d.level ?? 0) === baseline[tag].level;
    ok(same, `TORBLE_${tag}: xp/gold/level DEĞİŞMEDİ`,
       same ? undefined : { before: baseline[tag], after: { xp: d.xp, gold: d.gold, level: d.level } });
  }

  await B.removeChannel(chan);
}

/* ── Temizlik: yalnız BU scriptin kurduğu odalar ───────────────────────── */
async function cleanup() {
  console.log("\nT7) Temizlik");
  // Oturum ölmüş olabilir (ör. beklenmedik hata) → temizlikten önce yeniden
  // kimliklen. Oyuncu satırları DB'den okunur: bellekteki koltuklara bağlı
  // kalmak, süreç ortasında çöken bir koşuda odayı kalıntı bırakıyordu.
  try {
    if (!(await A.auth.getUser()).data.user) await A.auth.signInWithPassword(ACCOUNTS[0]);
    if (!(await B.auth.getUser()).data.user) await B.auth.signInWithPassword(ACCOUNTS[1]);
  } catch { /* aşağıdaki hata raporlaması yeterli */ }
  const aId = (await A.auth.getUser()).data.user?.id ?? "";
  const bId = (await B.auth.getUser()).data.user?.id ?? "";

  for (const roomId of createdRoomIds) {
    const { data: rows } = await A.from("route_duel_players")
      .select("id, profile_id, is_host").eq("room_id", roomId);
    // Misafir ÖNCE (playing ise forfeit → finished), host SONRA (finished →
    // oda DELETE). Kayıtlı oyuncu profile_id = auth.uid() ile yetkilenir;
    // claim token gerekmez (authorize_player'ın ilk dalı).
    const ordered = [...((rows ?? []) as Record<string, unknown>[])]
      .sort((x, y) => Number(x.is_host) - Number(y.is_host));
    for (const p of ordered) {
      const c = p.profile_id === aId ? A : p.profile_id === bId ? B : null;
      if (!c) { console.error(`  ! yabancı oyuncu atlandı: ${String(p.id).slice(0, 8)}`); continue; }
      const { error } = await c.rpc("route_duel_leave_room", {
        p_room_id: roomId, p_player_id: p.id, p_claim_token: seatsByRoom.get(roomId)
          ? (p.profile_id === aId ? seatsByRoom.get(roomId)!.a.claim : seatsByRoom.get(roomId)!.b.claim)
          : crypto.randomUUID(),
      });
      if (error) console.error(`  ! leave_room(${roomId.slice(0, 8)}): ${error.message}`);
    }
  }
  let residual = 0;
  for (const roomId of createdRoomIds) {
    const { data } = await A.from("route_duel_rooms").select("id, code, status").eq("id", roomId).maybeSingle();
    if (data) { residual++; console.error(`  ! kalıntı oda: ${(data as { code: string }).code}`); }
  }
  ok(residual === 0, `residual oda = 0 (kurulan: ${createdRoomIds.length})`, residual);
  const { data: players } = await A.from("route_duel_players").select("id").in("room_id", createdRoomIds);
  ok(!players || players.length === 0, "residual oyuncu satırı = 0", players?.length);
}

main()
  .then(async () => { await cleanupWrap(); })
  .catch(async e => {
    failed++;
    console.error(`\n✗ DURDURULDU: ${e instanceof Error ? e.message : String(e)}`);
    await cleanupWrap();
  })
  .finally(async () => {
    console.log(`\n${passed}/${passed + failed} assertion geçti`);
    try { await A?.auth.signOut({ scope: "local" }); await B?.auth.signOut({ scope: "local" }); } catch { /* yut */ }
    process.exit(failed > 0 ? 1 : 0);
  });

async function cleanupWrap() {
  try { await cleanup(); }
  catch (e) { console.error(`  ! temizlik hatası: ${e instanceof Error ? e.message : String(e)}`); }
}
