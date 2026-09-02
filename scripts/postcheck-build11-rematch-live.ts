/**
 * postcheck-build11-rematch-live.ts — 20260828120000 (HIZLI EŞLEŞ DOĞRUDAN
 * RÖVANŞ) migration'ının CANLI runtime postcheck'i.
 *
 * ⚠ PRODUCTION'A YAZAR. Yalnız 20260828120000 uygulandıktan SONRA, ELLE:
 *
 *     BUILD11_LIVE_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \
 *     npx tsx scripts/postcheck-build11-rematch-live.ts --confirm
 *
 *   Gate olmadan HİÇBİR ŞEY yazmaz: planı basar (dry-run) ve 0 ile çıkar.
 *
 * NE DOĞRULAR (metadata değil, DAVRANIŞ)
 * ──────────────────────────────────────
 *   1 ÇARK Hızlı Eşleş rövanşı — LOBİ YOK: status doğrudan 'playing',
 *     started_at = now()+3sn, ayarlar korunur, maç durumu sıfırlanır,
 *     geri sayım BİTMEDEN claim REDDEDİLİR, bittikten sonra BEKLEYEN ve
 *     ÇAĞIRAN taraf İKİSİ de yetkili ve claim atıyor (42501 yok).
 *   5 Tek taraflı rövanş isteği maç AÇMAZ (aynı odada, ek maliyet yok).
 *   8 Build 10 güvenliği: çapraz kullanıcı authorize/claim/leave reddi +
 *     çekirdek sarmalayıcı bypass'ı kapalı.
 *   6 MANUEL oda rövanşı DEĞİŞMEDİ: 'waiting' + started_at NULL (lobi).
 *   2 ÜLKE YAZ Hızlı Eşleş rövanşı — yeni oda 'quick_match' DOĞAR (eskiden
 *     'manual' doğuyordu), +3sn, ayarlar korunur, başlamadan claim reddedilir.
 *   3 BAYRAK Hızlı Eşleş rövanşı — started_at VE current_flag_at aynı ana
 *     kayar (adil başlangıç), başlamadan claim reddedilir.
 *   4 ROTA ucuz sağlamlık — YAZMA YOK (zaten uyumluydu).
 *   7 KUŞATMA ürün davranışı — YAZMA YOK, sunucu QM RPC'si ÇAĞRILMAZ.
 *   9 XP/Gold — bu script XP RPC'sini HİÇ çağırmaz → delta 0 BEKLENİR.
 *  10 Temizlik.
 *
 * GÜVENLİK KURALLARI (kodda zorlanır)
 * ───────────────────────────────────
 *   • Kimlik YALNIZ .env.test.local'daki iki adanmış hesap (TORBLE_A/B).
 *   • Yalnız BU scriptin kurduğu odalara dokunulur (`created` kaydı).
 *     Oda listeleme/arama YOK.
 *   • Hızlı Eşleş gerçek bir kullanıcıyla eşleşebilir → eşleşme sonrası
 *     RAKİP KİMLİĞİ DOĞRULANIR; yabancı çıkarsa maç bırakılır ve DURULUR.
 *   • Şema DEĞİŞMEZ, migration UYGULANMAZ, service-role KULLANILMAZ.
 *   • Hiçbir credential konsola yazılmaz.
 *   • İlk beklenmedik hatada DURUR (fail-fast) ve yine de temizlik dener.
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { QUICK_MATCH_MODE_META, QUICK_MATCH_MODES, isQuickMatchMode } from "../src/lib/quickMatch";
import { computeStartCountdownSeconds, QUICK_MATCH_START_BUFFER_SECONDS } from "../src/lib/quickMatchStart";

/* ── Gate ────────────────────────────────────────────────────────────────── */
const GATE = "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION";
const armed = process.env.BUILD11_LIVE_POSTCHECK === GATE && process.argv.includes("--confirm");
/** Yalnız belirtilen bölümleri koş (ör. BUILD11_ONLY=3). Boşsa hepsi.
 *  Amaç: bir bölüm düzeltilip yeniden koşulurken CANLIDA gereksiz yeni nesne
 *  üretilmesin. Atlanan bölümler raporda AÇIKÇA belirtilir. */
const ONLY = new Set((process.env.BUILD11_ONLY ?? "").split(",").map(x => x.trim()).filter(Boolean));
const run = (id: string) => ONLY.size === 0 || ONLY.has(id);

/* ── Env (gizli değer ASLA basılmaz) ─────────────────────────────────────── */
function parseEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
const env = { ...parseEnv(".env"), ...parseEnv(".env.test.local") };
const URL = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;

/* ── Raporlama ───────────────────────────────────────────────────────────── */
let passed = 0, failed = 0;
const notes: string[] = [];
function ok(cond: boolean, name: string, detail: unknown = "") {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (cond) { passed++; console.log(`  ✓ ${name}${d ? `   [${d}]` : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${d ? `   [${d}]` : ""}`); }
}
function note(msg: string) { notes.push(msg); console.log(`  ℹ ${msg}`); }
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** PostgrestBuilder gerçek Promise DEĞİL (.catch yok) → await + try tek yol. */
async function swallow(run: () => PromiseLike<unknown>): Promise<void> {
  try { await run(); } catch { /* temizlikte yutulur */ }
}
const errMsg = (e: unknown) => {
  const x = e as { message?: string; code?: string };
  return `${x?.code ?? ""} ${x?.message ?? (e ? String(e) : "")}`.trim();
};

/** Bu çalıştırmanın YARATTIĞI her şey. Temizlik YALNIZ buraya bakar. */
const created = {
  wheelRooms: [] as { id: string; code: string }[],
  duelRooms:  [] as { id: string; code: string }[],   // country + flag (duel_rooms)
  queueProfiles: new Set<string>(),
};

/* ── Dry-run ─────────────────────────────────────────────────────────────── */
if (!armed) {
  console.log(`
BUILD11 CANLI POSTCHECK — DRY RUN (hiçbir şey yazılmadı)

Çalıştırmak için:
  BUILD11_LIVE_POSTCHECK=${GATE} \\
  npx tsx scripts/postcheck-build11-rematch-live.ts --confirm

PLAN (yalnız bu script'in kurduğu nesnelere dokunulur):
  1) ÇARK Hızlı Eşleş  — 1 tek kullanımlık maç (WCX*): eşleş → oyna → bitir
                          → iki taraf rövanş → LOBİ YOK + 3-2-1 + taze maç
  5) aynı odada: tek taraflı rövanş isteği maç AÇMIYOR
  8) aynı odada: çapraz kullanıcı authorize/claim/leave reddi + çekirdek kapalı
  6) ÇARK MANUEL oda   — 1 tek kullanımlık oda (WMX*): rövanş → 'waiting' (lobi)
  2) ÜLKE YAZ Hızlı Eşleş — 1 maç + 1 rövanş odası (B11CD*)
  3) BAYRAK Hızlı Eşleş   — 1 maç (B11FD*), aynı odada rövanş
  4) ROTA  — YAZMA YOK (yalnız kolon/RPC varlığı)
  7) KUŞATMA — YAZMA YOK (yalnız istemci mod yapılandırması)
  9) XP/Gold delta = 0 beklenir (script XP RPC'sini hiç çağırmaz)
 10) Temizlik: kuyruk sıfır, tek kullanımlık odalar kapatılır

TAHMİNİ SÜRE: ~60-90 sn (yalnız 3 sn'lik gerçek geri sayım beklemeleri).
`);
  process.exit(0);
}

/* ══════════════════════════════════════════════════════════════════════════
   ÇALIŞTIRMA
   ══════════════════════════════════════════════════════════════════════════ */
if (!URL || !KEY) { console.error("✗ VITE_SUPABASE_URL / ANON_KEY yok"); process.exit(1); }

const mkClient = () => createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
type Acct = { sb: SupabaseClient; uid: string; name: string };

async function signIn(which: "A" | "B"): Promise<Acct> {
  const sb = mkClient();
  const { data, error } = await sb.auth.signInWithPassword({
    email: env[`TORBLE_${which}_EMAIL`], password: env[`TORBLE_${which}_PASSWORD`],
  });
  if (error || !data.user) throw new Error(`TORBLE_${which} girişi başarısız: ${errMsg(error)}`);
  const { data: p } = await sb.from("profiles").select("username").eq("id", data.user.id).maybeSingle();
  const name = (p?.username as string | undefined) ?? `pc${which}`;
  return { sb, uid: data.user.id, name };
}

const uuid = () => crypto.randomUUID();
const stamp = Date.now().toString(36).toUpperCase().slice(-3);
/** Çark oda kodu: sunucu 6 karakter + kısıtlı alfabe dayatıyor (I/O/0/1 yok). */
const WA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const wheelCode = (mark: string) =>
  mark + Array.from({ length: 6 - mark.length }, () => WA[Math.floor(Math.random() * WA.length)]).join("");

class Stop extends Error {}

let A!: Acct, B!: Acct, anon!: SupabaseClient;

/** SUNUCU saati — zamanlama iddiaları istemci saatine bağlanmasın. */
async function serverNowMs(c: SupabaseClient): Promise<number> {
  const { data, error } = await c.rpc("get_server_time_ms");
  if (error || data == null) throw new Stop(`get_server_time_ms: ${errMsg(error)}`);
  return Number(data);
}
/** started_at'e kalan süre, SUNUCU saatiyle. */
async function bufferMs(c: SupabaseClient, startedAt: string | null): Promise<number> {
  if (!startedAt) return Number.NaN;
  return Date.parse(startedAt) - await serverNowMs(c);
}

async function main() {
  A = await signIn("A"); B = await signIn("B"); anon = mkClient();
  console.log("giriş: TORBLE_A + TORBLE_B OK (kimlikler basılmaz)");

  const prof = async (c: Acct) => {
    const { data } = await c.sb.from("profiles").select("xp, gold, level").eq("id", c.uid).maybeSingle();
    return data as { xp: number; gold: number; level: number } | null;
  };
  const beforeA = await prof(A), beforeB = await prof(B);
  ok(!!beforeA && !!beforeB, "XP/Gold başlangıcı okundu",
     `A(xp=${beforeA?.xp},gold=${beforeA?.gold}) B(xp=${beforeB?.xp},gold=${beforeB?.gold})`);

  /* ═══════════ 1) ÇARK HIZLI EŞLEŞ RÖVANŞI — KRİTİK ═══════════ */
  section("1) ÇARK Hızlı Eşleş rövanşı — lobi yok, 3-2-1, taze maç");

  const wdA = uuid(), wdB = uuid();       // A = ÇAĞIRAN, B = BEKLEYEN(=host)
  let wdRoom = "";
  if (!run("W")) note("ÇARK bölümleri (1/5/8) ATLANDI — BUILD11_ONLY");
  if (run("W")) {
    for (const c of [A, B]) {
      await swallow(() => c.sb.rpc("wheel_duel_reset_quick_match", { p_profile_id: c.uid }));
      created.queueProfiles.add(c.uid);
    }
    const qm = (c: Acct, pid: string) => c.sb.rpc("wheel_duel_quick_match", {
      p_profile_id: c.uid, p_player_id: pid, p_player_name: c.name,
      p_duration: 60, p_region: "world", p_max_level_diff: 0,
      p_room_code: wheelCode("WCX"), p_first_target: "792",
    });

    const { data: qb, error: eb } = await qm(B, wdB);
    if (eb) throw new Stop(`wheel_duel_quick_match(B): ${errMsg(eb)}`);
    ok(qb?.matched === false, "1a B kuyruğa girdi (bekleyen taraf)", JSON.stringify(qb));

    const { data: qa, error: ea } = await qm(A, wdA);
    if (ea) throw new Stop(`wheel_duel_quick_match(A): ${errMsg(ea)}`);
    if (!qa?.matched) throw new Stop("1a eşleşme oluşmadı — DURULDU");
    wdRoom = qa.room_id;
    created.wheelRooms.push({ id: wdRoom, code: String(qa.room_code ?? "(WCX…)") });

    // ── RAKİP KİMLİĞİ DOĞRULAMASI — yabancıysa DERHAL DUR ──
    const { data: ps0 } = await A.sb.from("wheel_duel_players").select("id").eq("room_id", wdRoom);
    const actual = (ps0 ?? []).map(p => p.id as string).sort().join(",");
    if (actual !== [wdA, wdB].sort().join(",")) {
      throw new Stop("1a GERÇEK BİR KULLANICIYLA EŞLEŞİLDİ — oda bırakılıyor, postcheck DURDURULDU");
    }
    ok(true, "1a taze Hızlı Eşleş maçı; rakip DOĞRULANDI (iki test hesabı)", wdRoom.slice(0, 8));
  }

  const wdRow = async () => {
    const { data } = await A.sb.from("wheel_duel_rooms")
      .select("status, room_source, started_at, finished_at, finished_reason, winner_player_id, " +
              "duration_seconds, region, current_target_topoid, used_target_topoids, " +
              "rematch_requested_by, match_seq, current_match_id")
      .eq("id", wdRoom).maybeSingle();
    return data as Record<string, unknown> | null;
  };
  const wdScores = async () => {
    const { data } = await A.sb.from("wheel_duel_players").select("id, score").eq("room_id", wdRoom);
    return Object.fromEntries((data ?? []).map(p => [p.id as string, p.score as number]));
  };
  const wdTarget = async () => (await wdRow())?.current_target_topoid as string | null;
  const wdEnsureTarget = async (c: SupabaseClient, pid: string, tries = 6) => {
    for (let i = 0; i < tries; i++) {
      const t = await wdTarget();
      if (t) return t;
      await swallow(() => c.rpc("wheel_duel_advance_if_due",
        { p_room_id: wdRoom, p_player_id: pid, p_claim_token: null, p_expected_target: null }));
      await sleep(700);
    }
    return await wdTarget();
  };
  const wdClaim = async (c: SupabaseClient, pid: string, target?: string) => {
    const t = target ?? await wdEnsureTarget(c, pid);
    if (!t) return { skipped: true as const };
    const { data, error } = await c.rpc("wheel_duel_claim_target",
      { p_room_id: wdRoom, p_player_id: pid, p_claim_token: null, p_target: t });
    return { skipped: false as const, data, error, target: t };
  };
  const wdAuth = async (c: SupabaseClient, pid: string) => {
    const { data } = await c.rpc("wheel_duel_authorize_player", { p_player_id: pid, p_claim_token: null });
    return data === true;
  };

  const m1 = run("W") ? await wdRow() : null;
  if (run("W")) {
    ok(m1?.status === "playing" && m1?.room_source === "quick_match",
       "1b maç 1: playing + quick_match", `${m1?.status}/${m1?.room_source}`);
  }
  const m1Settings = { duration: m1?.duration_seconds, region: m1?.region };
  const m1MatchId = m1?.current_match_id as string;
  const m1Seq = Number(m1?.match_seq ?? 1);

  const usedBefore: string[] = [];
  if (run("W")) {
    await sleep(3500);                                 // ilk maçın 3 sn tamponu
    const c1 = await wdClaim(A.sb, wdA);
    if (!c1.skipped && c1.data?.claimed) usedBefore.push(c1.target!);
    ok(!c1.skipped && !c1.error && c1.data?.claimed === true, "1b maç 1 oynanıyor (ÇAĞIRAN claim)",
       c1.skipped ? "hedef yok" : `${errMsg(c1.error)}${JSON.stringify(c1.data)}`);
    await sleep(1600);
    const c2 = await wdClaim(B.sb, wdB);
    if (!c2.skipped && c2.data?.claimed) usedBefore.push(c2.target!);
    ok(!c2.skipped && !c2.error && c2.data?.claimed === true, "1b maç 1 oynanıyor (BEKLEYEN claim)",
       c2.skipped ? "hedef yok" : `${errMsg(c2.error)}${JSON.stringify(c2.data)}`);
  }

  // ── Maçı bitir (host = BEKLEYEN taraf = B) ──
  if (run("W")) {
    const { error } = await B.sb.rpc("wheel_duel_finish_game",
      { p_room_id: wdRoom, p_host_player_id: wdB, p_claim_token: null, p_reason: "timeout" });
    if (error) throw new Stop(`wheel_duel_finish_game: ${errMsg(error)}`);
    const r = await wdRow();
    ok(r?.status === "finished", "1c maç 1 bitti", String(r?.status));
  }

  // ── 5) TEK TARAFLI İSTEK: maç AÇILMAMALI ──
  section("5) Tek taraflı rövanş isteği — maç AÇILMIYOR");
  if (run("W")) {
    const { error: e1 } = await A.sb.rpc("wheel_duel_request_rematch",
      { p_room_id: wdRoom, p_player_id: wdA, p_claim_token: null });
    ok(!e1, "5a tek taraf (ÇAĞIRAN) rövanş istedi", errMsg(e1));
    const { error: pe } = await B.sb.rpc("wheel_duel_process_rematch",
      { p_room_id: wdRoom, p_host_player_id: wdB, p_claim_token: null });
    ok(!!pe && /not_enough_votes/i.test(errMsg(pe)),
       "5b tek oyla process_rematch REDDEDİLDİ (not_enough_votes)", errMsg(pe) || "(hata yok!)");
    const r = await wdRow();
    ok(r?.status === "finished" && r?.started_at != null,
       "5c oda hâlâ 'finished' — sahte lobi/yeni maç YOK", `${r?.status}`);
    ok((r?.rematch_requested_by as string[] ?? []).length === 1,
       "5d yalnız BİR oy kayıtlı", JSON.stringify(r?.rematch_requested_by));
  }

  // ── 1) İKİNCİ ONAY → DOĞRUDAN RÖVANŞ ──
  section("1) …ikinci onay → doğrudan rövanş");
  let m2StartedAt = "";
  if (run("W")) {
    const { error: e2 } = await B.sb.rpc("wheel_duel_request_rematch",
      { p_room_id: wdRoom, p_player_id: wdB, p_claim_token: null });
    ok(!e2, "1d ikinci taraf da rövanş istedi", errMsg(e2));

    const t0 = Date.now();
    const { error: pe } = await B.sb.rpc("wheel_duel_process_rematch",
      { p_room_id: wdRoom, p_host_player_id: wdB, p_claim_token: null });
    if (pe) throw new Stop(`wheel_duel_process_rematch: ${errMsg(pe)}`);
    const r = await wdRow();
    m2StartedAt = String(r?.started_at ?? "");

    // ── LOBİ YOK ──
    ok(r?.status === "playing",
       "1e LOBİ YOK: oda doğrudan 'playing' (eskiden 'waiting' → lobi)", String(r?.status));
    ok(r?.started_at != null, "1e started_at yazıldı (host 'Başlat' beklenmiyor)", String(r?.started_at));

    // ── 3-2-1: SUNUCU OTORİTELİ ──
    const buf = await bufferMs(A.sb, m2StartedAt);
    const elapsed = Date.now() - t0;
    ok(buf > 0 && buf <= 3000,
       "1f started_at GELECEKTE ve tampon ≤ 3 sn (sunucu saatiyle ölçüldü)",
       `kalan=${buf}ms, ölçüm gecikmesi=${elapsed}ms`);
    ok(computeStartCountdownSeconds({
         room: { room_source: "quick_match", status: "playing", started_at: m2StartedAt },
         syncedNowMs: Date.parse(m2StartedAt) - QUICK_MATCH_START_BUFFER_SECONDS * 1000,
       }) === QUICK_MATCH_START_BUFFER_SECONDS,
       "1f istemci sözleşmesi bu satırdan 3'ten saymaya başlar (senkron 3-2-1)");

    // ── AYNI AYARLAR ──
    ok(r?.room_source === "quick_match", "1g rövanş odası hâlâ 'quick_match'", String(r?.room_source));
    ok(r?.duration_seconds === m1Settings.duration && r?.region === m1Settings.region,
       "1g AYNI ayarlar (süre + bölge) korundu",
       `${r?.duration_seconds}sn/${r?.region} (maç1: ${m1Settings.duration}sn/${m1Settings.region})`);

    // ── TAZE DURUM ──
    ok(r?.winner_player_id === null && r?.finished_reason === null && r?.finished_at === null,
       "1h kazanan/bitiş nedeni/bitiş anı temizlendi");
    ok((r?.used_target_topoids as string[] ?? []).length === 0,
       "1h kullanılmış hedefler sıfırlandı", JSON.stringify(r?.used_target_topoids));
    ok((r?.rematch_requested_by as string[] ?? []).length === 0, "1h rövanş oyları temizlendi");
    ok(Number(r?.match_seq) === m1Seq + 1 && r?.current_match_id !== m1MatchId,
       "1h match_seq +1 ve YENİ current_match_id (XP anahtarı döndü → ödül tekrarı yok)",
       `seq ${m1Seq}->${r?.match_seq}`);
    const sc = await wdScores();
    ok(Object.values(sc).every(v => v === 0), "1h skorlar sıfırlandı", JSON.stringify(sc));

    // ── GİRDİ KİLİDİ: started_at'ten ÖNCE claim REDDEDİLMELİ ──
    // Sunucu hedefi geri-bildirim penceresinden (1200 ms) sonra üretir; tampon
    // 3 sn. Yani hedefin VAR olduğu ama maçın BAŞLAMADIĞI ~1,8 sn'lik pencere
    // vardır. Ölçüm sunucu saatiyle yapılır; pencere kaçarsa iddia edilmez.
    await sleep(1400);
    await swallow(() => A.sb.rpc("wheel_duel_advance_if_due",
      { p_room_id: wdRoom, p_player_id: wdA, p_claim_token: null, p_expected_target: null }));
    const early = await wdTarget();
    const bufNow = await bufferMs(A.sb, m2StartedAt);
    if (early && bufNow > 250) {
      const c = await wdClaim(A.sb, wdA, early);
      ok(!c.skipped && !c.error && c.data?.claimed === false,
         "1i GERİ SAYIM SÜRERKEN claim REDDEDİLDİ (sunucu otoritesi)",
         `kalan=${bufNow}ms → ${JSON.stringify(c.data)}${errMsg(c.error)}`);
      const sc2 = await wdScores();
      ok(Object.values(sc2).every(v => v === 0), "1i reddedilen claim skor YAZMADI", JSON.stringify(sc2));
    } else {
      note(`1i erken-claim penceresi ölçülemedi (hedef=${early ? "var" : "yok"}, kalan=${bufNow}ms) — İDDİA EDİLMEDİ`);
    }

    // ── BAŞLADIKTAN SONRA: İKİ TARAF DA yetkili + claim atabiliyor ──
    const wait = Math.max(0, await bufferMs(A.sb, m2StartedAt)) + 600;
    await sleep(wait);
    ok(await wdAuth(B.sb, wdB), "1j rövanş sonrası BEKLEYEN taraf yetkili (kalıcı sahiplik)");
    ok(await wdAuth(A.sb, wdA), "1j rövanş sonrası ÇAĞIRAN taraf yetkili (kalıcı sahiplik)");

    const ca = await wdClaim(A.sb, wdA);
    ok(!ca.skipped && !ca.error && ca.data?.claimed === true,
       "1k ÇAĞIRAN (ikinci/tetikleyen oyuncu) hedefini KAPIYOR — 42501 YOK",
       ca.skipped ? "hedef yok" : `${errMsg(ca.error)}${JSON.stringify(ca.data)}`);
    ok(!ca.skipped && !/42501/.test(errMsg(ca.error)), "1k ÇAĞIRAN tarafta 42501 yok", errMsg(ca.error) || "(temiz)");
    await sleep(1600);
    const cb = await wdClaim(B.sb, wdB);
    ok(!cb.skipped && !cb.error && cb.data?.claimed === true,
       "1k BEKLEYEN taraf hedefini KAPIYOR",
       cb.skipped ? "hedef yok" : `${errMsg(cb.error)}${JSON.stringify(cb.data)}`);

    const fresh = [ca.target, cb.target].filter(Boolean) as string[];
    note(`1l maç1 hedefleri=${usedBefore.join(",") || "-"} · maç2 hedefleri=${fresh.join(",") || "-"} ` +
         `(sıra satırı silindiği için maç 2 YENİ sıradan üretilir; gözlem)`);
    const sc3 = await wdScores();
    ok(Object.values(sc3).some(v => v > 0), "1l başlangıçtan sonra skor işleniyor (maç gerçekten akıyor)",
       JSON.stringify(sc3));
  }

  /* ═══════════ 8) BUILD 10 GÜVENLİK REGRESYONU (yalnız Çark) ═══════════ */
  section("8) Build 10 güvenlik regresyonu — çapraz kullanıcı reddi");
  if (run("W")) {
    // A, B'nin player_id'siyle yetkilenmeye/oynamaya çalışır.
    ok((await wdAuth(A.sb, wdB)) === false, "8a A, B'nin player_id'siyle YETKİLENEMİYOR");
    const t = await wdTarget();
    const { data: cd, error: ce } = await A.sb.rpc("wheel_duel_claim_target",
      { p_room_id: wdRoom, p_player_id: wdB, p_claim_token: null, p_target: t ?? "792" });
    ok(!!ce && /42501|unauthorized/i.test(errMsg(ce)),
       "8b A, B adına claim ATAMIYOR (42501)", errMsg(ce) || JSON.stringify(cd));
    const { error: le } = await A.sb.rpc("wheel_duel_leave_room",
      { p_room_id: wdRoom, p_player_id: wdB, p_claim_token: null });
    const { data: bStill } = await A.sb.from("wheel_duel_players").select("id").eq("id", wdB).maybeSingle();
    ok(!!le || !!bStill, "8c A, B'yi odadan ATAMIYOR (leave reddi veya satır duruyor)",
       `${errMsg(le) || "hatasız"} / B satırı=${bStill ? "duruyor" : "YOK"}`);
    // Çekirdek sarmalayıcı bypass'ı hâlâ kapalı mı?
    const { error: coreErr } = await A.sb.rpc("_wheel_duel_quick_match_core", {
      p_profile_id: A.uid, p_player_id: uuid(), p_player_name: A.name,
      p_duration: 60, p_region: "world", p_max_level_diff: 0,
      p_room_code: wheelCode("WCX"), p_first_target: "792",
    });
    ok(!!coreErr, "8d çekirdek `_wheel_duel_quick_match_core` istemciye KAPALI (sarmalayıcı atlanamaz)",
       errMsg(coreErr));
  }

  /* ═══════════ 6) MANUEL ODA RÖVANŞI — DEĞİŞMEMELİ ═══════════ */
  section("6) MANUEL oda rövanşı — lobi davranışı korunuyor");
  if (!run("6")) note("bölüm 6 ATLANDI — BUILD11_ONLY");
  if (run("6")) {
    const code = wheelCode("WMX");
    const hA = uuid(), hTok = uuid(), gB = uuid(), gTok = uuid();
    const { data: room, error: e1 } = await A.sb.rpc("wheel_duel_create_room", {
      p_player_id: hA, p_profile_id: A.uid, p_guest_id: null, p_name: A.name,
      p_code: code, p_duration: 60, p_region: "europe", p_claim_token: hTok,
    });
    if (e1 || !room?.id) throw new Stop(`wheel_duel_create_room: ${errMsg(e1)}`);
    created.wheelRooms.push({ id: room.id, code });
    const mRoom = room.id as string;
    ok(room.room_source === "manual", "6a manuel oda kuruldu", String(room.room_source));

    const { error: e2 } = await B.sb.rpc("wheel_duel_join_room", {
      p_code: code, p_player_id: gB, p_profile_id: B.uid, p_guest_id: null,
      p_name: B.name, p_claim_token: gTok,
    });
    if (e2) throw new Stop(`wheel_duel_join_room: ${errMsg(e2)}`);

    const { error: e3 } = await A.sb.rpc("wheel_duel_start_game",
      { p_room_id: mRoom, p_host_player_id: hA, p_claim_token: hTok, p_first_target: "792" });
    if (e3) throw new Stop(`wheel_duel_start_game: ${errMsg(e3)}`);
    const { data: started } = await A.sb.from("wheel_duel_rooms")
      .select("status, started_at, room_source").eq("id", mRoom).maybeSingle();
    const mBuf = await bufferMs(A.sb, started?.started_at as string);
    ok(started?.status === "playing" && mBuf <= 0,
       "6b MANUEL maç started_at = now() (3 sn tamponu YOK — doğru)", `kalan=${mBuf}ms`);

    await A.sb.rpc("wheel_duel_finish_game",
      { p_room_id: mRoom, p_host_player_id: hA, p_claim_token: hTok, p_reason: "timeout" });
    for (const [c, pid, tok] of [[A, hA, hTok], [B, gB, gTok]] as const) {
      await c.sb.rpc("wheel_duel_request_rematch", { p_room_id: mRoom, p_player_id: pid, p_claim_token: tok });
    }
    const { error: pe } = await A.sb.rpc("wheel_duel_process_rematch",
      { p_room_id: mRoom, p_host_player_id: hA, p_claim_token: hTok });
    ok(!pe, "6c manuel rövanş işlendi", errMsg(pe));
    const { data: after } = await A.sb.from("wheel_duel_rooms")
      .select("status, started_at, room_source, duration_seconds, region").eq("id", mRoom).maybeSingle();
    ok(after?.status === "waiting",
       "6d MANUEL rövanş LOBİYE dönüyor (status='waiting') — davranış DEĞİŞMEDİ", String(after?.status));
    ok(after?.started_at === null,
       "6d MANUEL rövanşta started_at NULL (3 sn geri sayımı UYGULANMIYOR)", String(after?.started_at));
    ok(after?.room_source === "manual" && after?.region === "europe",
       "6d manuel oda kaynağı + ayarları korundu", `${after?.room_source}/${after?.region}`);
  }

  /* ═══════════ 2) ÜLKE YAZ HIZLI EŞLEŞ RÖVANŞI ═══════════ */
  section("2) ÜLKE YAZ Hızlı Eşleş rövanşı");
  if (!run("2")) note("bölüm 2 ATLANDI — BUILD11_ONLY");
  if (run("2")) {
    for (const c of [A, B]) await swallow(() => c.sb.rpc("country_duel_reset_quick_match", { p_profile_id: c.uid }));
    const cdA = uuid(), cdB = uuid();
    const qm = (c: Acct, pid: string) => c.sb.rpc("country_duel_quick_match", {
      p_profile_id: c.uid, p_player_id: pid, p_player_name: c.name,
      p_duration: 60, p_region: "europe", p_max_level_diff: 0,
      p_room_code: `B11CD${stamp}${Math.floor(Math.random() * 90 + 10)}`,
    });
    const { data: qb, error: eb } = await qm(B, cdB);
    if (eb) throw new Stop(`country_duel_quick_match(B): ${errMsg(eb)}`);
    ok(qb?.matched === false, "2a B kuyruğa girdi");
    const { data: qa, error: ea } = await qm(A, cdA);
    if (ea) throw new Stop(`country_duel_quick_match(A): ${errMsg(ea)}`);
    if (!qa?.matched) throw new Stop("2a eşleşme oluşmadı — DURULDU");
    const oldRoom = qa.room_id as string;
    created.duelRooms.push({ id: oldRoom, code: "B11CD…" });

    const { data: ps } = await A.sb.from("duel_players").select("id").eq("room_id", oldRoom);
    if ((ps ?? []).map(p => p.id as string).sort().join(",") !== [cdA, cdB].sort().join(",")) {
      throw new Stop("2a GERÇEK BİR KULLANICIYLA EŞLEŞİLDİ — DURULDU");
    }
    const { data: r1 } = await A.sb.from("duel_rooms")
      .select("status, room_source, duration_seconds, region").eq("id", oldRoom).maybeSingle();
    ok(r1?.room_source === "quick_match" && r1?.status === "playing", "2a taze QM maçı", `${r1?.status}`);

    await A.sb.rpc("duel_finish_game", { p_room_id: oldRoom, p_player_id: cdA, p_claim_token: null });
    const { data: fin } = await A.sb.from("duel_rooms").select("status").eq("id", oldRoom).maybeSingle();
    ok(fin?.status === "finished", "2b maç bitti", String(fin?.status));

    // Kabul eden (B) yeni odayı kurar; isteyen (A) katılır — istemcideki akış.
    const newCode = `B11CD${stamp}R${Math.floor(Math.random() * 90 + 10)}`;
    const nB = uuid(), nBTok = uuid(), nA = uuid(), nATok = uuid();
    const { data: nr, error: are } = await B.sb.rpc("duel_accept_rematch", {
      p_old_room_id: oldRoom, p_old_player_id: cdB, p_old_claim_token: null,
      p_new_room_code: newCode, p_new_player_id: nB, p_new_claim_token: nBTok,
    });
    if (are || !nr?.id) throw new Stop(`duel_accept_rematch: ${errMsg(are)}`);
    const newRoom = nr.id as string;
    created.duelRooms.push({ id: newRoom, code: newCode });
    ok(nr.room_source === "quick_match",
       "2c RÖVANŞ ODASI 'quick_match' DOĞDU (eskiden 'manual' → lobi)", String(nr.room_source));
    ok(nr.duration_seconds === r1?.duration_seconds && nr.region === r1?.region,
       "2c AYNI ayarlar kopyalandı", `${nr.duration_seconds}sn/${nr.region}`);
    ok(nr.status === "waiting_rematch" && nr.started_at === null,
       "2c rakip katılmadan maç BAŞLAMIYOR", `${nr.status}`);

    const { data: jr, error: je } = await A.sb.rpc("duel_join_rematch_room", {
      p_new_room_id: newRoom, p_player_id: nA, p_profile_id: A.uid,
      p_guest_id: null, p_name: A.name, p_claim_token: nATok,
    });
    if (je || !jr?.id) throw new Stop(`duel_join_rematch_room: ${errMsg(je)}`);
    ok(jr.status === "playing", "2d katılışta maç ATOMİK başladı — LOBİ/oda-kodu ekranı YOK", String(jr.status));
    const cBuf = await bufferMs(A.sb, jr.started_at as string);
    ok(cBuf > 0 && cBuf <= 3000, "2d started_at = now()+3sn (sunucu otoriteli geri sayım)", `kalan=${cBuf}ms`);

    // Girdi kilidi: başlamadan claim REDDEDİLİR.
    const { data: early, error: ee } = await A.sb.rpc("duel_submit_claim", {
      p_room_id: newRoom, p_player_id: nA, p_claim_token: nATok, p_country_code: "250",
    });
    ok(!ee && early?.claimed === false && early?.reason === "not_started",
       "2e geri sayım sürerken claim REDDEDİLDİ (reason=not_started)", `${errMsg(ee)}${JSON.stringify(early)}`);

    await sleep(Math.max(0, await bufferMs(A.sb, jr.started_at as string)) + 500);
    const { data: late, error: le2 } = await A.sb.rpc("duel_submit_claim", {
      p_room_id: newRoom, p_player_id: nA, p_claim_token: nATok, p_country_code: "250",
    });
    ok(!le2 && late?.claimed === true, "2f başlangıçtan sonra normal oyun ÇALIŞIYOR",
       `${errMsg(le2)}${JSON.stringify(late)}`);
    const { data: nb, error: nbe } = await B.sb.rpc("duel_submit_claim", {
      p_room_id: newRoom, p_player_id: nB, p_claim_token: nBTok, p_country_code: "276",
    });
    ok(!nbe && nb?.claimed === true, "2f karşı taraf da oynayabiliyor", `${errMsg(nbe)}${JSON.stringify(nb)}`);
    const { data: cl } = await A.sb.from("duel_claims").select("player_id").eq("room_id", newRoom);
    ok((cl ?? []).length === 2, "2g maç 2 SIFIRDAN başladı (yalnız yeni claim'ler)", String((cl ?? []).length));
  }

  /* ═══════════ 3) BAYRAK HIZLI EŞLEŞ RÖVANŞI ═══════════ */
  section("3) BAYRAK Hızlı Eşleş rövanşı");
  if (!run("3")) note("bölüm 3 ATLANDI — BUILD11_ONLY");
  if (run("3")) {
    for (const c of [A, B]) await swallow(() => c.sb.rpc("flag_duel_reset_quick_match", { p_profile_id: c.uid }));
    const fdA = uuid(), fdB = uuid();
    const qm = (c: Acct, pid: string) => c.sb.rpc("flag_duel_quick_match", {
      p_profile_id: c.uid, p_player_id: pid, p_player_name: c.name,
      p_total_rounds: 5, p_region: "europe", p_max_level_diff: 0,
      p_room_code: `B11FD${stamp}${Math.floor(Math.random() * 90 + 10)}`, p_first_flag: "tr",
    });
    const { data: qb, error: eb } = await qm(B, fdB);
    if (eb) throw new Stop(`flag_duel_quick_match(B): ${errMsg(eb)}`);
    ok(qb?.matched === false, "3a B kuyruğa girdi");
    const { data: qa, error: ea } = await qm(A, fdA);
    if (ea) throw new Stop(`flag_duel_quick_match(A): ${errMsg(ea)}`);
    if (!qa?.matched) throw new Stop("3a eşleşme oluşmadı — DURULDU");
    const room = qa.room_id as string;
    created.duelRooms.push({ id: room, code: "B11FD…" });

    const { data: ps } = await A.sb.from("duel_players").select("id").eq("room_id", room);
    if ((ps ?? []).map(p => p.id as string).sort().join(",") !== [fdA, fdB].sort().join(",")) {
      throw new Stop("3a GERÇEK BİR KULLANICIYLA EŞLEŞİLDİ — DURULDU");
    }
    const fRow = async () => {
      const { data } = await A.sb.from("duel_rooms")
        .select("status, room_source, started_at, current_flag, current_flag_at, current_round, " +
                "winner_player_id, finished_reason, total_rounds, region")
        .eq("id", room).maybeSingle();
      return data as Record<string, unknown> | null;
    };
    const r1 = await fRow();
    ok(r1?.room_source === "quick_match" && r1?.status === "playing", "3a taze QM maçı", String(r1?.status));
    const settings = { rounds: r1?.total_rounds, region: r1?.region };

    // Bitir (host = bekleyen taraf = B).
    // ⚠ `flag_duel_finalize_game` FE'nin gönderdiği kazananı OTORİTER claim
    // sayımıyla ÇAPRAZ DOĞRULAR ve uyuşmazsa `winner_mismatch` fırlatır. Bu
    // maçta hiç gerçek claim yok → otoriter sonuç BERABERE (winner = null).
    // (İlk koşuda buraya `fdB` geçilmişti; RPC haklı olarak reddetti ve hata
    //  yakalanmadığı için maç 'playing' kalmıştı — HARNESS hatası, ürün değil.)
    const { error: fe } = await B.sb.rpc("flag_duel_finalize_game",
      { p_room_id: room, p_host_player_id: fdB, p_claim_token: null, p_winner_player_id: null });
    ok(!fe, "3b finalize_game hatasız", errMsg(fe));
    ok((await fRow())?.status === "finished", "3b maç BİTTİ (rövanş gerçekten 'finished'ten başlıyor)",
       String((await fRow())?.status));

    // Rövanş (host-only RPC; istemcide iki taraf da anlaştıktan SONRA çağrılır)
    const { data: rr, error: re } = await B.sb.rpc("flag_duel_accept_rematch",
      { p_room_id: room, p_host_player_id: fdB, p_claim_token: null, p_first_flag: "de" });
    if (re || !rr?.id) throw new Stop(`flag_duel_accept_rematch: ${errMsg(re)}`);
    const r2 = await fRow();
    ok(r2?.status === "playing", "3c LOBİ YOK: doğrudan 'playing'", String(r2?.status));
    const fBuf = await bufferMs(A.sb, r2?.started_at as string);
    ok(fBuf > 0 && fBuf <= 3000, "3c started_at = now()+3sn (senkron 3-2-1)", `kalan=${fBuf}ms`);
    ok(r2?.current_flag_at === r2?.started_at,
       "3d ADİL BAŞLANGIÇ: current_flag_at == started_at (tur süresi erken akmıyor)",
       `${r2?.current_flag_at} / ${r2?.started_at}`);
    ok(r2?.current_round === 1 && r2?.winner_player_id === null && r2?.finished_reason === null,
       "3d tur/kazanan/bitiş nedeni sıfırlandı", `round=${r2?.current_round}`);
    ok(r2?.total_rounds === settings.rounds && r2?.region === settings.region,
       "3d AYNI ayarlar korundu", `${r2?.total_rounds} tur/${r2?.region}`);
    const { data: cl0 } = await A.sb.from("duel_claims").select("id").eq("room_id", room);
    ok((cl0 ?? []).length === 0, "3d önceki maçın claim'leri silindi", String((cl0 ?? []).length));
    const { data: sc } = await A.sb.from("duel_players").select("score").eq("room_id", room);
    ok((sc ?? []).every(p => p.score === 0), "3d skorlar sıfır", JSON.stringify(sc));

    const { data: early, error: ee } = await A.sb.rpc("flag_duel_submit_claim",
      { p_room_id: room, p_player_id: fdA, p_claim_token: null, p_country_code: "de" });
    ok(!ee && early?.claimed === false && early?.reason === "not_started",
       "3e geri sayım sürerken claim REDDEDİLDİ", `${errMsg(ee)}${JSON.stringify(early)}`);

    await sleep(Math.max(0, await bufferMs(A.sb, r2?.started_at as string)) + 500);
    const { data: late, error: le3 } = await A.sb.rpc("flag_duel_submit_claim",
      { p_room_id: room, p_player_id: fdA, p_claim_token: null, p_country_code: "de" });
    ok(!le3 && late?.claimed === true, "3f başlangıçtan sonra tur normal işliyor",
       `${errMsg(le3)}${JSON.stringify(late)}`);
  }

  /* ═══════════ 4) ROTA — UCUZ SAĞLAMLIK (YAZMA YOK) ═══════════ */
  section("4) ROTA — ucuz regresyon (hiçbir oda kurulmaz)");
  {
    const ghost = uuid();
    const { error: colErr } = await A.sb.from("route_duel_rooms")
      .select("id, room_source, round_started_at, rematch_requested_by").eq("id", ghost);
    ok(!colErr, "4a doğrudan-rövanş + geri sayım kolonları canlı şemada", errMsg(colErr));
    const { error: rmErr } = await A.sb.rpc("route_duel_request_rematch",
      { p_room_id: ghost, p_player_id: ghost, p_claim_token: null });
    ok(!!rmErr && !/does not exist|not find the function|PGRST202/i.test(errMsg(rmErr)),
       "4b route_duel_request_rematch canlıda mevcut ve yetki kapılı (lobi yolu yok)", errMsg(rmErr));
    const { data: g } = await A.sb.from("route_duel_rooms").select("id").eq("id", ghost).maybeSingle();
    ok(!g, "4c hiçbir Rota odası OLUŞTURULMADI (sıfır yazma)");
  }

  /* ═══════════ 7) KUŞATMA — ÜRÜN DAVRANIŞI (YAZMA YOK) ═══════════ */
  section("7) KUŞATMA — ürün seviyesinde kapalı (sunucu QM RPC'si ÇAĞRILMAZ)");
  {
    ok(!(QUICK_MATCH_MODES as readonly string[]).includes("conquest"),
       "7a Hızlı Eşleş mod listesinde Kuşatma YOK", QUICK_MATCH_MODES.join(","));
    ok(!QUICK_MATCH_MODE_META.some(m => (m.mode as string) === "conquest"),
       "7a mod yapılandırmasında Kuşatma girişi YOK",
       QUICK_MATCH_MODE_META.map(m => m.mode).join(","));
    ok(isQuickMatchMode("conquest") === false && isQuickMatchMode("wheel") === true,
       "7b bayat kalıcı niyet 'conquest' istemci mantığınca REDDEDİLİYOR");
    ok(true, "7c Kuşatma sunucu QM RPC'si BU POSTCHECK'TE HİÇ ÇAĞRILMADI (tasarım gereği)");
  }

  /* ═══════════ 9) XP / GOLD ═══════════ */
  section("9) XP / Gold — beklenmeyen ödül yok");
  {
    const afterA = await prof(A), afterB = await prof(B);
    // Bu script XP/Gold RPC'lerini (award_xp_event vb.) HİÇ çağırmaz; ödül
    // yolu İSTEMCİDEDİR (awardXpEvent). Dolayısıyla BEKLENEN delta = 0.
    // Sıfırdan farklı bir delta, sunucu tarafında beklenmeyen bir ödül
    // yolunun tetiklendiği anlamına gelirdi.
    ok(afterA?.xp === beforeA?.xp && afterA?.gold === beforeA?.gold,
       "9a A: beklenmeyen XP/Gold YOK", `xp ${beforeA?.xp}->${afterA?.xp}, gold ${beforeA?.gold}->${afterA?.gold}`);
    ok(afterB?.xp === beforeB?.xp && afterB?.gold === beforeB?.gold,
       "9b B: beklenmeyen XP/Gold YOK", `xp ${beforeB?.xp}->${afterB?.xp}, gold ${beforeB?.gold}->${afterB?.gold}`);
    note("9c ödül yolu istemcide (awardXpEvent); postcheck yalnız sunucu RPC'lerini sürdüğü için " +
         "BEKLENEN delta 0'dır — tamamlanmış maçların meşru ödülü bu koşuda hiç talep edilmedi");
  }

  /* ═══════════ 10) TEMİZLİK ═══════════ */
  section("10) Temizlik");
  await cleanup();
}

/** Yalnız BU çalıştırmanın kurduğu nesnelere dokunur. */
async function cleanup() {
  let queueLeft = 0;
  for (const uid of created.queueProfiles.size ? created.queueProfiles : new Set([A?.uid, B?.uid])) {
    if (!uid) continue;
    const c = uid === A.uid ? A : B;
    for (const rpc of ["wheel_duel_reset_quick_match", "country_duel_reset_quick_match",
                       "flag_duel_reset_quick_match"]) {
      await swallow(() => c.sb.rpc(rpc, { p_profile_id: uid }));
    }
    for (const tbl of ["wheel_duel_queue", "country_duel_queue", "flag_duel_queue"]) {
      const { data } = await c.sb.from(tbl).select("profile_id").eq("profile_id", uid).maybeSingle();
      if (data) queueLeft++;
    }
  }
  ok(queueLeft === 0, "10a kuyruk artığı = 0", String(queueLeft));

  const history: string[] = [], stuck: string[] = [];
  const sweep = async (roomsTbl: string, playersTbl: string, leaveRpc: string,
                       rooms: { id: string; code: string }[]) => {
    for (const room of rooms) {
      const { data: ps } = await A.sb.from(playersTbl).select("id").eq("room_id", room.id);
      for (const p of ps ?? []) for (const c of [A, B]) {
        await swallow(() => c.sb.rpc(leaveRpc,
          { p_room_id: room.id, p_player_id: p.id, p_claim_token: null }));
      }
      const { data: still } = await A.sb.from(roomsTbl)
        .select("id, status, rematch_requested_by").eq("id", room.id).maybeSingle();
      if (!still) { console.log(`     ${room.code}: SİLİNDİ`); continue; }
      const label = `${room.code}(${still.status})`;
      if (still.status === "finished") history.push(label); else stuck.push(label);
      console.log(`     ${room.code}: kaldı (status=${still.status})`);
    }
  };
  await sweep("wheel_duel_rooms", "wheel_duel_players", "wheel_duel_leave_room", created.wheelRooms);
  await sweep("duel_rooms", "duel_players", "duel_leave_room", created.duelRooms);

  ok(stuck.length === 0, "10b AKSİYON GEREKTİREN artık = 0 (aktif/bekleyen tek kullanımlık oda yok)",
     stuck.join(", ") || "yok");
  ok(true, "10c beklenen TARİHÇE (bitmiş oda; leave_room bilerek no-op)", history.join(", ") || "yok");

  // Sarkan rövanş oyu kalmamalı (kalan odalarda).
  let voteLeft = 0;
  for (const r of created.wheelRooms) {
    const { data } = await A.sb.from("wheel_duel_rooms")
      .select("rematch_requested_by").eq("id", r.id).maybeSingle();
    voteLeft += ((data?.rematch_requested_by as string[]) ?? []).length;
  }
  ok(voteLeft === 0, "10d sarkan rövanş isteği durumu = 0", String(voteLeft));
}

main()
  .catch(async e => {
    failed++;
    console.error(`\n✗✗ DURDURULDU: ${e instanceof Error ? e.message : String(e)}`);
    try { await cleanup(); } catch { /* temizlik de başarısız */ }
  })
  .finally(async () => {
    for (const c of [A, B]) { try { await c?.sb.auth.signOut(); } catch { /* yoksay */ } }
    if (notes.length) console.log(`\nNOTLAR:\n${notes.map(n => "  · " + n).join("\n")}`);
    console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı`);
    process.exit(failed === 0 ? 0 : 1);
  });
