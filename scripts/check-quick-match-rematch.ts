/**
 * check-quick-match-rematch.ts — HIZLI EŞLEŞ RÖVANŞI + KUŞATMA QM KALDIRMA
 * korumaları. DB'siz, tarayıcısız, ağsız.
 *
 * KAPSAM
 * ──────
 *  1. KUŞATMA: kullanıcıya açık Hızlı Eşleş girişi YOK; normal oda/lobi akışı
 *     bozulmamış.
 *  2. Paylaşılan sözleşme (lib/quickMatchStart.ts): kaynak otoritesi
 *     `room_source`, rövanş hedefi (direct/lobby), sunucu-çapalı 3-2-1.
 *  3. Migration 20260828120000: beş rövanş RPC'sinin quick_match dalı + manuel
 *     dalın DEĞİŞMEMESİ + claim yolunda started_at otoritesi.
 *  4. Sunucu davranışının ÇALIŞTIRILABİLİR MODELİ: aynı ayarlar korunur, maça
 *     özgü durum sıfırlanır, tek taraflı istek maç AÇMAZ.
 *  5. İstemci kablolaması: üç düello da türetilmiş geri sayımı kullanıyor,
 *     Hızlı Eşleş rövanşı lobi UI'ına düşmüyor, ROTA'ya dokunulmadı.
 *  6. Build 10 kimlik/güvenlik yüzeyi ve canlı migration'lar DEĞİŞMEDİ.
 *
 * Çalıştır:  npx tsx scripts/check-quick-match-rematch.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  QUICK_MATCH_START_BUFFER_SECONDS,
  isQuickMatchRoom,
  decideRematchDestination,
  computeStartCountdownSeconds,
  isStartLocked,
} from "../src/lib/quickMatchStart";
import {
  QUICK_MATCH_MODE_META,
  QUICK_MATCH_MODES,
  isQuickMatchMode,
} from "../src/lib/quickMatch";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function section(title: string) { console.log(`\n${title}`); }

const MIG_PATH = "supabase/migrations/20260828120000_quick_match_direct_rematch.sql";
const MIG      = read(MIG_PATH);
/** Yorumsuz gövde — iddialar YORUM METNİYLE değil, gerçek SQL'le kanıtlanmalı. */
const MIG_CODE = MIG.replace(/--[^\n]*/g, "");

const SRC_APP    = read("src/App.tsx");
const SRC_QM     = read("src/lib/quickMatch.ts");
const SRC_START  = read("src/lib/quickMatchStart.ts");
const SRC_MODAL  = read("src/components/QuickMatchModal.tsx");
const SRC_MHOME  = read("src/components/MobileHome.tsx");
const SRC_DUEL   = read("src/components/DuelGame.tsx");
const SRC_FLAG   = read("src/components/FlagDuelGame.tsx");
const SRC_WHEEL  = read("src/components/WheelDuelGame.tsx");

/** Kod (yorumsuz) — "yorumda geçiyor" yanlış pozitiflerini eler. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const CODE_APP   = code(SRC_APP);
const CODE_QM    = code(SRC_QM);
const CODE_MODAL = code(SRC_MODAL);
const CODE_MHOME = code(SRC_MHOME);
const CODE_DUEL  = code(SRC_DUEL);

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 1 — KUŞATMA: ÜRÜNDE HIZLI EŞLEŞ YOK
   ══════════════════════════════════════════════════════════════════════════ */
section("1. Kuşatma — kullanıcıya açık Hızlı Eşleş girişi ABSENT");
{
  // 1a. Tip düzeyi: birlik "conquest" içermiyor → intent temsil EDİLEMEZ.
  ok(!/export type QuickMatchMode =[^\n;]*conquest/.test(SRC_QM),
     "QuickMatchMode birliğinde 'conquest' yok (tip düzeyinde imkânsız)");
  ok(!QUICK_MATCH_MODES.includes("conquest" as never),
     "QUICK_MATCH_MODES listesinde conquest yok", QUICK_MATCH_MODES.join(","));
  ok(JSON.stringify(QUICK_MATCH_MODE_META.map(m => m.mode))
       === JSON.stringify(["country", "wheel", "flag", "route"]),
     "QUICK_MATCH_MODE_META tam olarak 4 canlı düello modu",
     QUICK_MATCH_MODE_META.map(m => m.mode).join(","));
  ok(QUICK_MATCH_MODE_META.every(m => m.enabled),
     "listelenen her mod gerçekten etkin (görünüp çalışmayan giriş yok)");

  // 1b. Çalışma zamanı: bayat sessionStorage niyeti diriltemez.
  ok(isQuickMatchMode("wheel") && !isQuickMatchMode("conquest"),
     "isQuickMatchMode: 'conquest' reddediliyor, canlı modlar kabul");
  ok(CODE_APP.includes("isQuickMatchMode(parsed.mode)"),
     "App: kalıcı niyet okunurken mod DOĞRULANIYOR (trust boundary)");

  // 1c. Yönlendirme tablosu ve giriş yüzeyleri.
  const screenMap = CODE_APP.match(/QUICK_MATCH_SCREEN: Record<QuickMatchMode, AppScreen> = \{[\s\S]*?\};/);
  ok(!!screenMap && !screenMap[0].includes("conquest"),
     "App QUICK_MATCH_SCREEN'de conquest satırı yok");
  ok(!/conquest/.test(CODE_MODAL), "QuickMatchModal kodunda conquest referansı yok");
  ok(!/conquest/.test(CODE_MHOME), "MobileHome QM sheet kodunda conquest referansı yok");
  ok(!/QUICK_MATCH_CONQUEST|CONQUEST_QUICK_MATCH_ENABLED/.test(CODE_QM + CODE_MODAL + CODE_MHOME + CODE_APP),
     "conquest'e özel QM sabitleri (rounds/map/enabled) tamamen kaldırıldı");

  // 1d. ConquestMode'a artık autoQuickMatch GEÇİLMİYOR → eski arama fazı ve
  //     conquest_quick_match* RPC'leri hiçbir kullanıcı yolundan tetiklenemez.
  const conquestMount = CODE_APP.match(/<ConquestMode[\s\S]*?\/>/g) ?? [];
  ok(conquestMount.length > 0, "ConquestMode hâlâ mount ediliyor (normal akış duruyor)");
  ok(conquestMount.every(m => !m.includes("autoQuickMatch")),
     "hiçbir ConquestMode mount'u autoQuickMatch prop'u geçmiyor",
     conquestMount.filter(m => m.includes("autoQuickMatch")).length);

  // 1e. Normal Kuşatma oda/lobi akışı BOZULMADI.
  for (const [screen, phase] of [
    ["conquest-game",  'initialPhase="create"'],
    ["conquest-rooms", 'initialPhase="rooms"'],
    ["conquest-join",  'initialPhase="join-code"'],
  ] as const) {
    ok(CODE_APP.includes(`screen === "${screen}"`) && CODE_APP.includes(phase),
       `Kuşatma normal akışı duruyor: ${screen} (${phase})`);
  }
  const conquestSvc = read("src/modes/conquest/conquestService.ts");
  for (const fn of ["createConquestRoom", "joinConquestRoomByCode"]) {
    ok(conquestSvc.includes(fn), `conquestService.${fn} korunuyor (oda kur / kodla katıl)`);
  }
  // Misafir/host kısıtları dokunulmadı (ayrı migration; repo'da duruyor).
  ok(existsSync(join(ROOT, "supabase/migrations/20260810120000_conquest_guest_read_lockdown_and_host_rules.sql")),
     "Kuşatma misafir/host kısıt migration'ı yerinde (dokunulmadı)");

  // 1f. Bu iş Kuşatma backend'ini SİLMEZ: legacy RPC'ler yerinde ama
  //     yalnız ConquestMode'un artık beslenmeyen prop'undan çağrılabilir.
  // NOT: yorum metinlerini saymamak için GERÇEK `.rpc("conquest_*quick_match")`
  // çağrıları aranır — dokümantasyonda modun adının geçmesi bir yol DEĞİLDİR.
  const qmCallers = execFileSync(
    "grep", ["-rlE", String.raw`rpc\("conquest_[a-z_]*quick_match"`, "src"],
    { cwd: ROOT, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean).sort();
  ok(JSON.stringify(qmCallers) === JSON.stringify(["src/modes/conquest/conquestService.ts"]),
     "conquest_quick_match RPC'sini çağıran tek dosya conquestService (ulaşılamaz)",
     qmCallers.join(" "));
  ok(!MIG.includes("conquest"),
     "yeni migration Kuşatma DB nesnelerine dokunmuyor (salt-temizlik DROP yok)");
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 2 — PAYLAŞILAN SÖZLEŞME (saf mantık)
   ══════════════════════════════════════════════════════════════════════════ */
section("2. lib/quickMatchStart — kaynak otoritesi + sunucu-çapalı 3-2-1");
{
  ok(QUICK_MATCH_START_BUFFER_SECONDS === 3, "tampon 3 sn (SQL: interval '3 seconds')");

  const qm     = { room_source: "quick_match", status: "playing" };
  const manual = { room_source: "manual",      status: "playing" };

  ok(isQuickMatchRoom(qm) && !isQuickMatchRoom(manual) && !isQuickMatchRoom(null),
     "isQuickMatchRoom yalnız room_source='quick_match'e true");
  ok(decideRematchDestination(qm) === "direct", "quick_match → doğrudan rövanş (lobi YOK)");
  ok(decideRematchDestination(manual) === "lobby", "manual → mevcut lobi davranışı KORUNUR");
  ok(decideRematchDestination(null) === "lobby", "bilinmeyen kaynak güvenli tarafa (lobby) düşer");
  ok(decideRematchDestination({ room_source: "manual", status: "finished" }) === "lobby",
     "karar yalnız kaynağa bakar, istemci fazına değil");

  const T0 = Date.parse("2026-08-28T12:00:00.000Z");
  const at = (offsetMs: number, room: object = qm) =>
    computeStartCountdownSeconds({
      room: { ...room, started_at: new Date(T0).toISOString() } as never,
      syncedNowMs: T0 + offsetMs,
    });

  ok(at(-3000) === 3, "T-3.0sn → 3", at(-3000));
  ok(at(-2100) === 3, "T-2.1sn → 3 (ceil)", at(-2100));
  ok(at(-2000) === 2, "T-2.0sn → 2", at(-2000));
  ok(at(-900)  === 1, "T-0.9sn → 1", at(-900));
  ok(at(0)     === 0, "T+0 → 0 (maç başladı)", at(0));
  ok(at(5000)  === 0, "maç içinde → 0", at(5000));
  ok(at(-3000, manual) === 0, "MANUEL odada geri sayım YOK (davranış değişmedi)", at(-3000, manual));
  ok(computeStartCountdownSeconds({
       room: { ...qm, status: "waiting", started_at: new Date(T0).toISOString() },
       syncedNowMs: T0 - 3000,
     }) === 0, "status!=playing → geri sayım yok");
  ok(computeStartCountdownSeconds({ room: { ...qm, started_at: null }, syncedNowMs: T0 }) === 0,
     "started_at yoksa geri sayım yok");
  ok(computeStartCountdownSeconds({
       room: { ...qm, started_at: new Date(T0).toISOString() }, syncedNowMs: Number.NaN,
     }) === 0, "saat bilinmiyorsa geri sayım UYDURULMAZ");

  // Kilit ile gösterim BİREBİR aynı kaynaktan → ikisi ayrışamaz.
  ok(isStartLocked({ room: { ...qm, started_at: new Date(T0).toISOString() }, syncedNowMs: T0 - 1500 }),
     "geri sayım sürerken girdi KİLİTLİ");
  ok(!isStartLocked({ room: { ...qm, started_at: new Date(T0).toISOString() }, syncedNowMs: T0 }),
     "geri sayım bitince girdi AÇIK");

  // RECONNECT: geri sayım hiçbir lokal state taşımaz — aynı satır + aynı saat
  // her zaman aynı sonucu verir (yeniden yükleme, arka plandan dönüş).
  const probe = { ...qm, started_at: new Date(T0).toISOString() };
  ok(computeStartCountdownSeconds({ room: probe, syncedNowMs: T0 - 1500 })
       === computeStartCountdownSeconds({ room: { ...probe }, syncedNowMs: T0 - 1500 }),
     "saf fonksiyon: taze mount ile devam eden mount AYNI değeri verir (reconnect)");
  ok(!/setTimeout|setInterval|Date\.now\(\)/.test(code(SRC_START)),
     "quickMatchStart KODUNDA istemci zamanlayıcısı/lokal saat YOK (otorite started_at)");

  // React köprüsü sayacı AZALTMAZ; her tick'te SIFIRDAN hesaplar. Arka plana
  // alınan / throttle edilen sekme geri geldiğinde değer kendini düzeltir —
  // biriken bir sayaç olsaydı iki istemci ayrışırdı.
  const SRC_HOOK = code(read("src/lib/useQuickMatchCountdown.ts"));
  ok(SRC_HOOK.includes("getSyncedNowMs()") && SRC_HOOK.includes("computeStartCountdownSeconds"),
     "hook her okumada sunucu-senkron saatle YENİDEN hesaplıyor");
  ok(!/seconds\s*-\s*1|prev\s*-\s*1|--/.test(SRC_HOOK),
     "hook sayacı azaltmıyor (biriken istemci sayacı YOK)");
  ok(/\[roomSource, status, startedAt\]/.test(SRC_HOOK),
     "hook oda satırının üç alanına bağlı → rövanş/reconnect kendiliğinden yeniden kurar");
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 3 — MIGRATION: quick_match dalı var, manuel dal DEĞİŞMEDİ
   ══════════════════════════════════════════════════════════════════════════ */
section("3. 20260828120000 — sunucu tarafı rövanş sözleşmesi");
{
  const fns = [
    "public.wheel_duel_process_rematch(uuid, uuid, uuid)",
    "public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid)",
    "public.flag_duel_accept_rematch(uuid, uuid, uuid, text)",
    "public.duel_accept_rematch(uuid, uuid, uuid, text, uuid, uuid)",
    "public.duel_join_rematch_room(uuid, uuid, uuid, text, text, uuid)",
    "public.wheel_duel_claim_target(uuid, uuid, uuid, text)",
    "public.duel_submit_claim(uuid, uuid, uuid, text)",
    "public.flag_duel_submit_claim(uuid, uuid, uuid, text)",
  ];
  for (const sig of fns) {
    const name = sig.split("(")[0];
    ok(MIG_CODE.includes(`create or replace function ${name}(`), `${name} yeniden tanımlı`);
    ok(MIG_CODE.includes(`revoke all     on function ${sig} from public;`),
       `${name}: PUBLIC revoke (varsayılan grant tuzağı)`);
    ok(MIG_CODE.includes(`grant  execute on function ${sig} to anon, authenticated;`),
       `${name}: canlı istemci ACL'i BİREBİR yeniden kuruluyor`);
  }
  ok(MIG_CODE.split("security definer").length - 1 === fns.length,
     "sekiz fonksiyon da SECURITY DEFINER");
  ok(MIG_CODE.split("set search_path = public, auth").length - 1 === fns.length,
     "sekizinde de search_path pinli");

  // Yıkıcı DDL yok.
  for (const forbidden of ["drop function", "drop table", "drop column",
                           "drop constraint", "alter column", "truncate"]) {
    ok(!MIG_CODE.toLowerCase().includes(forbidden),
       `migration ${forbidden} içermiyor (yıkıcı DDL yok)`);
  }
  // Tek istisna: repo'da DDL'i hiç bulunmayan (canlıda VAR olan) üç Çark
  // kolonunun İDEMPOTENT güvencesi. Canlıda no-op; yalnız temiz bir
  // veritabanına baştan uygulamayı mümkün kılar.
  const alters = MIG_CODE.match(/alter table[\s\S]*?;/g) ?? [];
  ok(alters.length === 3, "tam olarak 3 şema güvencesi (fazlası yok)", alters.length);
  ok(alters.every(a => /add column if not exists/.test(a)),
     "her ALTER yalnız `add column if not exists` (idempotent, veri dokunulmaz)");
  ok(alters.every(a => a.includes("public.wheel_duel_rooms")),
     "şema güvenceleri yalnız wheel_duel_rooms'a");
  for (const col of ["room_source", "match_seq", "current_match_id"]) {
    ok(alters.some(a => a.includes(col)), `wheel_duel_rooms.${col} güvenceye alındı`);
  }
  ok(!/add constraint|check \(/.test(MIG_CODE.split("create or replace function")[0]),
     "mevcut satırların doğrulanmasını gerektirecek CHECK constraint EKLENMİYOR");

  // 3a. quick_match dalı: üç ailede de +3 sn.
  const body = (name: string) => {
    const i = MIG_CODE.indexOf(`create or replace function ${name}(`);
    const j = MIG_CODE.indexOf("$$;", i);
    return i >= 0 && j > i ? MIG_CODE.slice(i, j) : "";
  };
  for (const fn of [
    "public.wheel_duel_process_rematch",
    "public.wheel_duel_process_rematch_if_ready",
    "public.flag_duel_accept_rematch",
    "public.duel_join_rematch_room",
  ]) {
    const b = body(fn);
    ok(b.includes("room_source = 'quick_match'"), `${fn}: kaynak SUNUCUDAN okunuyor`);
    ok(b.includes("now() + interval '3 seconds'"), `${fn}: quick_match dalı +3 sn yazıyor`);
  }

  // 3b. MANUEL dal DEĞİŞMEDİ — regresyon koruması.
  for (const fn of ["public.wheel_duel_process_rematch", "public.wheel_duel_process_rematch_if_ready"]) {
    const b = body(fn);
    ok(b.includes("else 'waiting'"), `${fn}: manuel oda hâlâ 'waiting' (lobi korunur)`);
    ok(b.includes("else null"), `${fn}: manuel oda started_at=null (eski davranış)`);
    ok(b.includes("delete from public.wheel_duel_room_sequences"),
       `${fn}: yeni maç YENİ hedef sırası alır (bayat sıra sızmaz)`);
    ok(b.includes("match_seq             = coalesce(match_seq, 1) + 1")
       && b.includes("current_match_id      = gen_random_uuid()"),
       `${fn}: XP idempotency anahtarı SUNUCUDA döner (ödül tekrarı yok)`);
    ok(b.includes("score = 0") && b.includes("used_target_topoids   = '{}'")
       && b.includes("winner_player_id      = null") && b.includes("rematch_requested_by  = '{}'"),
       `${fn}: skor/kullanılmış hedef/kazanan/oylar sıfırlanıyor`);
  }
  for (const fn of ["public.flag_duel_accept_rematch", "public.duel_join_rematch_room"]) {
    ok(body(fn).includes("else now()"), `${fn}: manuel oda hâlâ started_at=now()`);
  }
  {
    const b = body("public.flag_duel_accept_rematch");
    ok(b.includes("current_flag_at        = v_start_at"),
       "flag: tur damgası da kaydırılıyor (ilk tur 3 sn kaybetmiyor)");
    ok(b.includes("delete from public.duel_claims") && b.includes("set score        = 0")
       && b.includes("current_round          = 1"),
       "flag: claim/skor/tur sıfırlanıyor");
  }
  {
    const b = body("public.duel_accept_rematch");
    ok(b.includes("case when v_old_room.room_source = 'quick_match' then 'quick_match' else 'manual' end"),
       "country: yeni rövanş odası kaynağı ESKİ ODADAN devralıyor");
    ok(b.includes("v_old_room.duration_seconds") && b.includes("v_old_room.region"),
       "country: AYNI ayarlar (süre + bölge) kopyalanıyor — varsayılana düşmüyor");
    ok(b.includes("'country'"), "country: room_kind sunucu-otoriter kalıyor");
    ok(b.includes("v_old_player.profile_id") && b.includes("v_old_player.guest_id"),
       "country: oyuncu kimliği ESKİ SATIRDAN taşınıyor (istemci verisi değil)");
  }

  // 3c. Başlangıç otoritesi claim yolunda.
  ok(body("public.wheel_duel_claim_target").includes("(started_at is null or now() >= started_at)"),
     "wheel_duel_claim_target: geri sayım bitmeden claim YAZILMAZ");
  for (const fn of ["public.duel_submit_claim", "public.flag_duel_submit_claim"]) {
    const b = body(fn);
    ok(b.includes("v_started_at is not null and now() < v_started_at")
       && b.includes("'not_started'"),
       `${fn}: geri sayım sürerken sessiz reddediyor`);
    ok(b.includes("'dup'"), `${fn}: mevcut dup sözleşmesi korunuyor`);
  }

  // 3d. Yetki kontrolleri AYNEN duruyor (rövanş bir yetki genişlemesi DEĞİL).
  ok(body("public.wheel_duel_process_rematch").includes("wheel_duel_authorize_host"),
     "wheel process_rematch: host yetkisi korunuyor");
  ok(body("public.wheel_duel_process_rematch_if_ready").includes("wheel_duel_authorize_player")
     && body("public.wheel_duel_process_rematch_if_ready").includes("not_a_member"),
     "wheel _if_ready: oyuncu yetkisi + ÜYELİK kontrolü korunuyor");
  ok(body("public.flag_duel_accept_rematch").includes("flag_duel_authorize_host"),
     "flag accept_rematch: host yetkisi korunuyor");
  ok(body("public.duel_accept_rematch").includes("duel_authorize_player"),
     "country accept_rematch: oyuncu yetkisi korunuyor");
  ok(body("public.duel_join_rematch_room").includes("p_profile_id <> v_uid")
     && body("public.duel_join_rematch_room").includes("profile_mismatch"),
     "country join_rematch: auth.uid() eşleşmesi zorunlu (başkasının yerine katılım yok)");
  ok(body("public.duel_join_rematch_room").includes("room_full"),
     "country join_rematch: üçüncü oyuncu odaya giremez");

  // 3e. İKİ ONAY kuralı — tek taraflı istek maç AÇMAZ.
  for (const fn of ["public.wheel_duel_process_rematch", "public.wheel_duel_process_rematch_if_ready"]) {
    ok(body(fn).includes("array_length(v_room.rematch_requested_by, 1), 0) < 2"),
       `${fn}: 2 oy toplanmadan reset YOK`);
  }
  ok(body("public.wheel_duel_process_rematch").includes("v_room.status <> 'finished'"),
     "wheel: yalnız BİTMİŞ maç rövanşa açılır (çift reset yok)");
  ok(body("public.duel_accept_rematch").includes("old_room_not_finished"),
     "country: yalnız BİTMİŞ maç rövanşa açılır");

  // 3f. BUILD 10 GÜVENLİK YÜZEYİ: bu migration ona DOKUNMUYOR.
  for (const forbidden of [
    "wheel_duel_authorize_player(", "wheel_duel_quick_match_owners",
    "_wheel_duel_quick_match_core", "create or replace function public.wheel_duel_quick_match",
    "wheel_duel_queue", "duel_authorize_player(", "flag_duel_authorize_host(",
  ]) {
    const isDefinition =
      MIG_CODE.includes(`create or replace function ${forbidden}`) ||
      MIG_CODE.includes(`create function ${forbidden}`) ||
      (forbidden.startsWith("create") && MIG_CODE.includes(forbidden));
    ok(!isDefinition, `build 10 / yetki nesnesi YENİDEN TANIMLANMIYOR: ${forbidden}`);
  }
  ok(!MIG_CODE.includes("insert into public.wheel_duel_quick_match_owners"),
     "sahiplik tablosuna bu migration'dan yazım YOK");

  // 3g. İlgisiz modlara dokunulmuyor.
  for (const t of ["route_duel_", "conquest_", "tevatur_", "flag_group_", "wheel_group_",
                   "duel_group_", "xp_events", "gold_", "profiles"]) {
    ok(!MIG_CODE.includes(t), `migration ${t} nesnelerine dokunmuyor`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 4 — SUNUCU DAVRANIŞININ ÇALIŞTIRILABİLİR MODELİ
   ──────────────────────────────────────────────────────────────────────────
   Bölüm 3 SQL METNİNİ doğrular; bu bölüm KURALIN KENDİSİNİ sürer. İkisi
   birlikte "metin var ama mantık yanlış" ve "mantık doğru ama SQL kaymış"
   hatalarının ikisini de yakalar (repo deseni: check-build9-blockers).
   ══════════════════════════════════════════════════════════════════════════ */
section("4. Rövanş reset kuralının çalıştırılabilir modeli");
{
  const NOW = 1_000_000;
  interface Room {
    room_source: "manual" | "quick_match";
    status: string;
    started_at: number | null;
    duration_seconds: number;
    region: string;
    score_a: number; score_b: number;
    winner: string | null;
    finished_reason: string | null;
    used_targets: string[];
    votes: string[];
    match_id: string;
    sequence: string[] | null;
  }
  const finished = (source: "manual" | "quick_match", votes: string[]): Room => ({
    room_source: source, status: "finished", started_at: NOW - 60_000,
    duration_seconds: 180, region: "europe",
    score_a: 7, score_b: 4, winner: "A", finished_reason: "timeout",
    used_targets: ["TR", "DE", "FR"], votes,
    match_id: "match-1", sequence: ["TR", "DE", "FR", "IT"],
  });

  /** wheel_duel_process_rematch* modeli. */
  function processRematch(r: Room, now = NOW): Room {
    if (r.status !== "finished") return r;          // çift reset yok
    if (r.votes.length < 2) return r;               // tek taraflı istek → no-op
    const qm = r.room_source === "quick_match";
    return {
      ...r,
      status: qm ? "playing" : "waiting",
      started_at: qm ? now + 3000 : null,
      score_a: 0, score_b: 0,
      winner: null, finished_reason: null,
      used_targets: [], votes: [],
      match_id: "match-2",                          // sunucu üretir
      sequence: null,                               // yeni sıra üretilecek
    };
  }

  // A) HIZLI EŞLEŞ, iki onay → lobi YOK, +3 sn, taze durum, ayarlar korunuyor.
  {
    const before = finished("quick_match", ["A", "B"]);
    const after  = processRematch(before);
    ok(after.status === "playing", "QM rövanş: status 'playing' (lobiye düşmüyor)", after.status);
    ok(after.started_at === NOW + 3000, "QM rövanş: started_at = now + 3 sn", after.started_at);
    ok(computeStartCountdownSeconds({
         room: { room_source: after.room_source, status: after.status,
                 started_at: new Date(after.started_at!).toISOString() },
         syncedNowMs: NOW,
       }) === 3, "QM rövanş: istemci 3'ten saymaya başlar");
    ok(after.duration_seconds === before.duration_seconds && after.region === before.region,
       "QM rövanş: AYNI ayarlar (süre + bölge) korunuyor");
    ok(after.score_a === 0 && after.score_b === 0, "QM rövanş: skorlar sıfır");
    ok(after.winner === null && after.finished_reason === null,
       "QM rövanş: kazanan/bitiş nedeni temizlendi");
    ok(after.used_targets.length === 0 && after.sequence === null,
       "QM rövanş: hedef/sıra durumu tamamen yenilendi");
    ok(after.votes.length === 0, "QM rövanş: rövanş oyları temizlendi");
    ok(after.match_id !== before.match_id, "QM rövanş: yeni maç kimliği → XP tekrarı imkânsız");
  }

  // B) TEK TARAFLI istek → hiçbir şey olmaz.
  {
    const before = finished("quick_match", ["A"]);
    const after  = processRematch(before);
    ok(after === before, "tek taraflı rövanş isteği maç BAŞLATMAZ");
    ok(after.status === "finished", "tek taraflı istekte sonuç ekranı korunur");
  }

  // C) RET / AYRILMA → oy hiç düşmez, sahte iki kişilik lobi kurulmaz.
  {
    const declined = finished("quick_match", []);
    ok(processRematch(declined) === declined, "ret/ayrılma sonrası yeni maç AÇILMAZ");
  }

  // D) MANUEL oda → lobi davranışı AYNEN.
  {
    const after = processRematch(finished("manual", ["A", "B"]));
    ok(after.status === "waiting" && after.started_at === null,
       "manuel rövanş: lobi + host 'Başlat' akışı korunuyor",
       `${after.status}/${after.started_at}`);
    ok(decideRematchDestination(after) === "lobby", "manuel oda 'lobby' hedefinde kalıyor");
  }

  // E) ÇİFT TETİKLEME (ağ retry / iki istemci) → ikinci çağrı no-op.
  {
    const once  = processRematch(finished("quick_match", ["A", "B"]));
    const twice = processRematch(once);
    ok(twice === once, "reset idempotent: ikinci çağrı skorları TEKRAR sıfırlamaz");
    ok(twice.match_id === "match-2", "çift tetiklemede maç kimliği bir kez döner");
  }

  // F) Geri sayım bitmeden claim reddi (server guard modeli).
  {
    const room = processRematch(finished("quick_match", ["A", "B"]));
    const claimAccepted = (now: number) =>
      room.status === "playing" && (room.started_at === null || now >= room.started_at);
    ok(!claimAccepted(NOW + 1000), "geri sayımın ORTASINDA claim reddedilir");
    ok(!claimAccepted(NOW + 2999), "başlangıç anından 1 ms önce bile reddedilir");
    ok(claimAccepted(NOW + 3000), "başlangıç anında claim kabul edilir");
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 5 — İSTEMCİ KABLOLAMASI
   ══════════════════════════════════════════════════════════════════════════ */
section("5. İstemci — türetilmiş geri sayım, lobi bypass, Rota dokunulmadı");
{
  // 5a. Üç düello da paylaşılan türetilmiş sayacı kullanıyor.
  for (const [name, src] of [
    ["Ülke Yaz", SRC_DUEL], ["Bayrak", SRC_FLAG], ["Çark", SRC_WHEEL],
  ] as const) {
    ok(src.includes("useQuickMatchCountdown(room)"),
       `${name}: geri sayım ODA SATIRINDAN türetiliyor`);
    ok(!src.includes("setCountdownSeconds") && !src.includes("quickMatchCountdownRef"),
       `${name}: eski tek-atışlık geri sayım kablolaması kaldırıldı`);
  }

  // 5b. Ülke Yaz: Hızlı Eşleş rövanşı LOBİYE düşmüyor.
  ok(CODE_DUEL.includes('"rematch-wait"'), "Ülke Yaz: lobi olmayan 'rematch-wait' fazı var");
  ok(CODE_DUEL.includes('setPhase(destination === "direct" ? "rematch-wait" : "waiting")'),
     "Ülke Yaz: hedef SUNUCU kaynağından seçiliyor (direct → lobi yok)");
  ok(CODE_DUEL.includes("decideRematchDestination(newRoom)"),
     "Ülke Yaz: karar paylaşılan sözleşmeden geliyor");
  {
    // rematch-wait bloğu lobi ürününü (oda kodu / davet / başlat) İÇERMEMELİ.
    const i = SRC_DUEL.indexOf('{phase === "rematch-wait" && room && (');
    const j = SRC_DUEL.indexOf("{/* ════════ WAITING", i);
    const block = i >= 0 && j > i ? SRC_DUEL.slice(i, j) : "";
    ok(block.length > 0, "rematch-wait render bloğu bulundu");
    for (const lobbyBit of ["duel-room-code", "LobbyInviteBar", "shareLink", "Başlat"]) {
      ok(!block.includes(lobbyBit), `rematch-wait bloğunda lobi öğesi yok: ${lobbyBit}`);
    }
    ok(block.includes("Rövanş hazırlanıyor"), "rematch-wait: net bir ara ekran metni var");
  }
  {
    // Eski "quick match auto-start" yalnız 'waiting'te — rematch-wait'te ASLA
    // (yoksa duel_start_game started_at=now() yazıp geri sayımı yok ederdi).
    const i = CODE_DUEL.indexOf("isQuickRef.current &&");
    const cond = i >= 0 ? CODE_DUEL.slice(i, i + 220) : "";
    ok(cond.includes('phaseRef.current === "waiting"') && !cond.includes("rematch-wait"),
       "Ülke Yaz: legacy auto-start rematch-wait fazında tetiklenmiyor");
  }

  // 5c. Bayrak: geri sayım sürerken gameplay girdisi kilitli.
  ok(SRC_FLAG.includes("const startLocked = countdownSeconds > 0;")
     && SRC_FLAG.split("if (startLocked) return;").length - 1 >= 2,
     "Bayrak: cevap ve pas geri sayım boyunca kilitli");
  // Host'un İYİMSER satırı sunucuyla AYNI tamponu taşımalı; yoksa host geri
  // sayımı hiç görmez ve tur sayacı 3 sn erken akar (tam olarak düzeltilen
  // asimetri).
  ok(SRC_FLAG.includes("isQuickMatchRoom(currentRoom)")
     && SRC_FLAG.includes("QUICK_MATCH_START_BUFFER_SECONDS * 1000")
     && SRC_FLAG.includes("getSyncedNowMs() + startBufferMs"),
     "Bayrak: host'un iyimser rövanş satırı da +3 sn tamponu taşıyor");
  ok(/const remaining = Math\.min\(\s*FLAG_TIMEOUT_SEC,/.test(SRC_FLAG),
     "Bayrak: tur sayacı tampon boyunca tur süresini AŞMIYOR (tavanlı)");

  // 5d. Çark: yeni maç kimliği geçici durumu sıfırlıyor (1. maç sızmıyor).
  ok(SRC_WHEEL.includes("const matchIdentity = room?.current_match_id ?? null;")
     && SRC_WHEEL.includes("endingRef.current   = false;"),
     "Çark: current_match_id değişince maç-içi ref'ler sıfırlanıyor");

  // 5e. ROTA: zaten sözleşmeye uygun (status='playing' + round_started_at+3sn)
  //     → bu iş kapsamında DOKUNULMADI.
  const changed = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).map(l => l.slice(3).trim()).sort();
  ok(!changed.some(f => f.startsWith("src/components/routeDuel/")),
     "Rota Düello istemcisi değiştirilmedi", changed.filter(f => f.includes("routeDuel")).join(","));
  ok(!changed.some(f => f.startsWith("src/modes/")),
     "Kuşatma/Kör Nokta mod içleri değiştirilmedi", changed.filter(f => f.startsWith("src/modes/")).join(","));
  const routeMig = read("supabase/migrations/20260802120000_route_duel_init.sql");
  ok(routeMig.includes("round_started_at       = now() + interval '3 seconds'"),
     "Rota: sunucu-otoriter +3 sn mekanizması yerinde (yeniden kullanıldı, kopyalanmadı)");

  // 5f. CANLI (build 10) migration'lar DEĞİŞMEDİ.
  for (const f of ["20260827120000_route_duel_disconnect_two_phase.sql",
                   "20260827130000_wheel_duel_reset_quick_match.sql",
                   "20260827140000_wheel_duel_quick_match_durable_identity.sql",
                   "20260827150000_wheel_duel_quick_match_bind_players.sql"]) {
    ok(!changed.includes(`supabase/migrations/${f}`), `canlı migration dokunulmadı: ${f}`);
  }
  // Değişmez: bu işin migration'ı DURUYOR ve HİÇBİR MEVCUT migration
  // DÜZENLENMEDİ. ("kaç yeni dosya var" ölçmek yanlış olurdu: sonradan
  // eklenen ilgisiz bir migration bu iddiayı haksız yere düşürürdü —
  // nitekim 20260828130000 eklenince tam olarak bu oldu.)
  const migModified = execFileSync("git", ["status", "--porcelain", "--", "supabase/migrations"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean)
    .filter(l => !l.startsWith("??")).map(l => l.slice(3).trim());
  ok(migModified.length === 0, "hiçbir MEVCUT migration düzenlenmedi", migModified.join(","));
  ok(changed.includes(MIG_PATH), "bu işin migration'ı yerinde", MIG_PATH);
}

/* ══════════════════════════════════════════════════════════════════════════ */
console.log(`\n${passed}/${passed + failed} assertion geçti`);
process.exit(failed === 0 ? 0 : 1);
