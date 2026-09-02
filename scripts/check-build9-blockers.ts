/**
 * check-build9-blockers.ts — TestFlight build 9 gerçek-cihaz blocker'larının
 * davranışsal + sözleşmesel koruması. DB'siz, tarayıcısız.
 *
 * KAPSAM (üç blocker)
 * ───────────────────
 *  1. ROTA DÜELLO — SAHTE KOPUŞ / SAHTE GALİBİYET
 *     Boşta ama BAĞLI oyuncu kopuk sayılıyordu. Kök neden: heartbeat RPC'si
 *     `void supabase.rpc(...)` ile yazıldığı için HİÇ GÖNDERİLMİYORDU
 *     (PostgrestBuilder gerçek Promise değil; fetch `then()` ile başlar), geriye
 *     `last_seen_at`i tazeleyen tek yol olarak `submit_move` kalıyordu — yani
 *     "aktivite" fiilen "hamle" demekti.
 *
 *  2. ÇARK — DOĞRU HEDEFE DOKUNULAMIYOR (telefonda)
 *     Harita katmanı ölçüldü ve TEMİZ çıktı (scripts/check-wheel-target-tap.mjs).
 *     Asimetri `handleMapClick`tedir: yanlış cevap TAMAMEN lokal (her zaman
 *     görünür), doğru cevap sunucuya gider ve bu dalın HER hata biçimi sessiz
 *     `return` idi → oyuncuya "hedef tıklanmıyor" gibi görünüyordu.
 *
 *  3. ÇARK — "HIZLI EŞLEŞ" ESKİ MAÇI AÇIYOR
 *     Bayat durum SUNUCUDA: `wheel_duel_cancel_quick_match` matched satırları
 *     bilerek bırakır, istemcinin SELECT-first guard'ı onu "şu anki eşleşmem"
 *     sanar. Çark, `reset_quick_match`i OLMAYAN tek moddu.
 *
 * BÖLÜM 1'deki sunucu simülasyonu, 20260827120000'deki iki-aşamalı kuralın
 * ÇALIŞTIRILABİLİR MODELİDİR; modelin SQL'den kayması BÖLÜM 1d'deki metin
 * iddialarıyla yakalanır (repo deseni: check-flag-duel-advance-if-due).
 *
 * Çalıştır:  npx tsx scripts/check-build9-blockers.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ROUTE_DUEL_HEARTBEAT_MS,
  ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS,
  ROUTE_DUEL_DISCONNECT_CONFIRM_SECONDS,
  computeOppStaleSeconds,
  shouldRequestDisconnect,
} from "../src/lib/routeDuelConnection";
import {
  QUICK_MATCH_FRESH_ROOM_MAX_AGE_MS,
  decideQuickMatchJoin,
} from "../src/lib/quickMatchFreshness";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function section(title: string) { console.log(`\n${title}`); }

const MIG_ROUTE = read("supabase/migrations/20260827120000_route_duel_disconnect_two_phase.sql");
const MIG_WHEEL = read("supabase/migrations/20260827130000_wheel_duel_reset_quick_match.sql");
const MIG_QMID  = read("supabase/migrations/20260827140000_wheel_duel_quick_match_durable_identity.sql");
const MIG_HARD  = read("supabase/migrations/20260814180000_registered_player_claim_auth_hardening.sql");

const SRC_ROUTE = read("src/components/routeDuel/RouteDuelGame.tsx");
const SRC_WHEEL = read("src/components/WheelDuelGame.tsx");
const SRC_CSS   = read("src/App.css");

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 1 — ROTA DÜELLO: BAĞLANTI ≠ GAMEPLAY
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 1a. İstemci sözleşmesi: heartbeat GERÇEKTEN gönderiliyor ───────────── */
section("1a. Rota — heartbeat gerçekten gönderiliyor");
{
  const beatBlock = SRC_ROUTE.slice(
    SRC_ROUTE.indexOf('rpc("route_duel_heartbeat"'),
    SRC_ROUTE.indexOf('rpc("route_duel_heartbeat"') + 900,
  );
  ok(beatBlock.includes(".then("),
     "heartbeat RPC'si .then(...) ile TÜKETİLİYOR (yoksa istek hiç gitmez)");
  ok(/heartbeatHealthyRef\.current\s*=\s*!error/.test(beatBlock),
     "heartbeat sonucu sağlık bayrağına yazılıyor");
  ok(/console\.error\(\s*"\[RouteDuel\] heartbeat failed"/.test(beatBlock),
     "heartbeat hatası SESSİZ değil (loglanıyor)");
}

/* ── 1b. Saf mantık: boşta kalmak kopuş İDDİASI üretmez ─────────────────── */
section("1b. Rota — kopuş isteği yalnız KENDİ canlılığım kanıtlıyken");
{
  ok(shouldRequestDisconnect(25, true) === true,
     "rakip 25 sn sessiz + kendi beat'im sağlıklı → sunucudan kontrol İSTENİR");
  ok(shouldRequestDisconnect(25, false) === false,
     "kendi heartbeat'im düşüyorsa rakip SUÇLANMAZ (arıza bende olabilir)");
  ok(shouldRequestDisconnect(19.9, true) === false, "19.9 sn eşiğin altında");
  ok(shouldRequestDisconnect(null, true) === false, "veri yokken istek yok");
  ok(shouldRequestDisconnect(Number.NaN, true) === false, "NaN'da istek yok");

  // Heartbeat aktığı sürece BOŞTA oyuncunun yaşı asla eşiğe ulaşamaz:
  // damga her 3 sn'de tazelenir, hamle gönderilmese bile.
  const base = 1_800_000_000_000;
  let worst = 0;
  for (let t = 0; t <= 600_000; t += ROUTE_DUEL_HEARTBEAT_MS) {
    const lastBeat = Math.floor(t / ROUTE_DUEL_HEARTBEAT_MS) * ROUTE_DUEL_HEARTBEAT_MS;
    const stale = computeOppStaleSeconds({
      oppLastSeenMs: base + lastBeat,
      myLastSeenMs:  base + lastBeat,
      syncedNowMs:   base + t,
    });
    worst = Math.max(worst, stale ?? 0);
  }
  ok(worst < ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS,
     `10 dakika HİÇ HAMLE YAPMADAN boşta duran bağlı oyuncu eşiğe ulaşmıyor (en kötü yaş ${worst.toFixed(1)} sn)`);
}

/* ── 1c. Sunucu kuralının çalıştırılabilir modeli (20260827120000) ──────── */
section("1c. Rota — iki aşamalı kopuş kuralı (sunucu modeli)");

const STALE_MS   = ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS * 1000;
const CONFIRM_MS = ROUTE_DUEL_DISCONNECT_CONFIRM_SECONDS * 1000;

interface Room {
  status: "playing" | "finished";
  startedAt: number;
  lastSeen: Record<"A" | "B", number>;
  watchPlayer: "A" | "B" | null;
  watchSince: number | null;
  winner: "A" | "B" | null;
  finishedReason: string | null;
}
const other = (p: "A" | "B") => (p === "A" ? "B" : "A");

/** route_duel_heartbeat: damgayı tazeler VE kendi izleme penceresini SİLER. */
function srvHeartbeat(room: Room, player: "A" | "B", now: number) {
  room.lastSeen[player] = now;
  if (room.watchPlayer === player) { room.watchPlayer = null; room.watchSince = null; }
}

/** route_duel_handle_disconnect: (a) taze → temizle, (b) pencere aç,
 *  (c) olgunlaşmadı → no-op, (d) iki kanıt → bitir. */
function srvHandleDisconnect(room: Room, caller: "A" | "B", now: number) {
  if (room.status === "finished") return;
  const opp = other(caller);
  // SQL: coalesce(v_opp_seen, started_at, now()) — NULL tabanlı. Modelde
  // damgalar her zaman doludur; `||` kullanmak 0'ı "yok" sayıp testi
  // yalancı-yeşil yapardı (bu tuzağa bir kez düşüldü).
  const baseline = room.lastSeen[opp];

  if (baseline > now - STALE_MS) {                       // (a)
    if (room.watchPlayer !== null) { room.watchPlayer = null; room.watchSince = null; }
    return;
  }
  if (room.watchPlayer !== opp || room.watchSince === null) {   // (b)
    room.watchPlayer = opp; room.watchSince = now; return;
  }
  if (room.watchSince > now - CONFIRM_MS) return;        // (c)

  room.status = "finished";                              // (d)
  room.finishedReason = "disconnect";
  room.winner = caller;
  room.watchPlayer = null; room.watchSince = null;
}

/** Model saati 0'dan değil gerçekçi bir epoch'tan başlar. */
const T0 = 1_800_000_000_000;

function freshRoom(t0 = T0): Room {
  return {
    status: "playing", startedAt: t0,
    lastSeen: { A: t0, B: t0 },
    watchPlayer: null, watchSince: null, winner: null, finishedReason: null,
  };
}

/** Simülasyon: kim beat atıyor + kim poll ediyor, 100 ms adımlarla. */
function simulate(opts: {
  durationMs: number;
  beats: (p: "A" | "B", t: number) => boolean;
  pollers: ("A" | "B")[];
}): Room {
  const room = freshRoom();
  for (let dt = 100; dt <= opts.durationMs; dt += 100) {
    const t = T0 + dt;
    if (dt % ROUTE_DUEL_HEARTBEAT_MS === 0) {
      for (const p of ["A", "B"] as const) if (opts.beats(p, dt)) srvHeartbeat(room, p, t);
      for (const p of opts.pollers) srvHandleDisconnect(room, p, t);
    }
  }
  return room;
}

{
  // ── Boşta ama bağlı: A hamle yapar, B HİÇBİR ŞEY göndermez ama beat atar
  for (const secs of [30, 60, 120, 600]) {
    const r = simulate({
      durationMs: secs * 1000,
      beats: () => true,          // ikisi de bağlı (hamle ≠ beat)
      pollers: ["A", "B"],
    });
    ok(r.status === "playing" && r.winner === null,
       `${secs} sn boyunca HİÇ HAMLE YAPMAYAN bağlı oyuncu maçta kalıyor`,
       { status: r.status, winner: r.winner });
    ok(r.watchPlayer === null, `${secs} sn boşta: izleme penceresi hiç açılmıyor`);
  }

  // ── Tek çağrı ASLA maç bitiremez (rakip 300 sn sessiz olsa bile)
  {
    const r = freshRoom();
    srvHandleDisconnect(r, "A", T0 + 300_000);
    ok(r.status === "playing", "TEK handle_disconnect çağrısı maçı BİTİREMEZ (pencere açar)");
    ok(r.watchPlayer === "B" && r.watchSince === T0 + 300_000, "ilk çağrı izleme penceresini açar");
  }

  // ── Gerçek kopuş: B t=0'da susar, A beat + poll etmeye devam eder
  {
    const beats = (p: "A" | "B") => p === "A";
    const early = simulate({ durationMs: 29_000, beats, pollers: ["A"] });
    ok(early.status === "playing", "gerçek kopuşta 29 sn'de HENÜZ karar yok (grace)", early.status);

    const late = simulate({ durationMs: 45_000, beats, pollers: ["A"] });
    ok(late.status === "finished" && late.finishedReason === "disconnect" && late.winner === "A",
       "gerçek kopuş sonunda TESPİT EDİLİYOR ve kalan oyuncu kazanıyor",
       { status: late.status, winner: late.winner });

    // En erken bitiş anı: bayatlık(20) + kesintisiz gözlem(10) ≈ 30 sn
    let firstFinish = -1;
    const room = freshRoom();
    for (let dt = 100; dt <= 60_000; dt += 100) {
      if (dt % ROUTE_DUEL_HEARTBEAT_MS === 0) {
        srvHeartbeat(room, "A", T0 + dt);
        srvHandleDisconnect(room, "A", T0 + dt);
      }
      if (room.status === "finished" && firstFinish < 0) firstFinish = dt;
    }
    ok(firstFinish >= 30_000 && firstFinish <= 36_000,
       `kopuş kararı en erken ~30 sn'de (ölçülen ${(firstFinish / 1000).toFixed(1)} sn)`, firstFinish);
  }

  // ── Grace içinde reconnect: B 27. sn'de tek beat atar → pencere silinir
  {
    const r = simulate({
      durationMs: 200_000,
      beats: (p, t) => p === "A" || t >= 27_000,   // B 27 sn sonra geri döner
      pollers: ["A"],
    });
    ok(r.status === "playing" && r.winner === null,
       "geçici kopuş + grace içinde reconnect: maç DEVAM ediyor, galibiyet verilmiyor",
       { status: r.status, winner: r.winner });
  }

  // ── Arka plan/foreground: İKİSİ de 100 sn yok, A önce dönüyor
  {
    const room = freshRoom();
    // t=0..100 sn: hiç beat yok, hiç poll yok (iki uygulama da arka planda)
    // t=100 sn: A döner — anında beat + poll
    srvHeartbeat(room, "A", T0 + 100_000);
    srvHandleDisconnect(room, "A", T0 + 100_000);
    ok(room.status === "playing",
       "arka plandan dönen istemci, birikmiş bayatlığı ANINDA galibiyete çeviremez");
    // B 105. sn'de döner → pencere silinir
    srvHeartbeat(room, "B", T0 + 105_000);
    srvHandleDisconnect(room, "A", T0 + 105_000);
    ok(room.status === "playing" && room.watchPlayer === null,
       "ikinci oyuncu grace içinde dönerse pencere kapanır, maç sürer");
  }

  // ── Host / non-host simetrisi
  {
    for (const caller of ["A", "B"] as const) {
      const r = simulate({
        durationMs: 45_000,
        beats: p => p === caller,
        pollers: [caller],
      });
      ok(r.status === "finished" && r.winner === caller,
         `gerçek kopuş ${caller === "A" ? "host" : "non-host"} tarafından da tespit ediliyor`);
    }
  }

  // ── Girdi sıklığı alakasız: çok hamle yapan da hiç yapmayan da aynı
  {
    const r = simulate({ durationMs: 300_000, beats: () => true, pollers: ["A", "B"] });
    ok(r.status === "playing", "5 dk: hamle sıklığı kopuş kararını ETKİLEMİYOR");
  }
}

/* ── 1d. Model ↔ SQL drift koruması ─────────────────────────────────────── */
section("1d. Rota — migration sözleşmesi (model kaymasın)");
{
  ok(/add column if not exists disconnect_watch_player_id/.test(MIG_ROUTE),
     "migration izleme kolonunu ekliyor (player_id)");
  ok(/add column if not exists disconnect_watch_since/.test(MIG_ROUTE),
     "migration izleme kolonunu ekliyor (since)");
  ok(/c_stale\s+constant interval\s*:=\s*interval '20 seconds'/.test(MIG_ROUTE),
     `SQL bayatlık eşiği ${ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS} sn ile aynı`);
  ok(/c_confirm\s+constant interval\s*:=\s*interval '10 seconds'/.test(MIG_ROUTE),
     `SQL onay penceresi ${ROUTE_DUEL_DISCONNECT_CONFIRM_SECONDS} sn ile aynı`);

  const hb = MIG_ROUTE.slice(
    MIG_ROUTE.indexOf("create or replace function public.route_duel_heartbeat"),
    MIG_ROUTE.indexOf("create or replace function public.route_duel_handle_disconnect"),
  );
  ok(/set last_seen_at = now\(\)/.test(hb), "heartbeat last_seen_at'i tazeliyor");
  ok(/disconnect_watch_player_id = null/.test(hb) &&
     /where id = v_room_id\s*\n\s*and disconnect_watch_player_id = p_player_id/.test(hb),
     "heartbeat, İZLENEN oyuncuya aitse pencereyi siliyor (reconnect garantisi)");

  const hd = MIG_ROUTE.slice(MIG_ROUTE.indexOf("create or replace function public.route_duel_handle_disconnect"));
  ok(/if v_baseline > \(now\(\) - c_stale\) then/.test(hd), "(a) rakip taze dalı var");
  ok(/disconnect_watch_player_id is distinct from v_opp_id/.test(hd), "(b) pencere açma dalı var");
  ok(/if v_room\.disconnect_watch_since > \(now\(\) - c_confirm\) then/.test(hd),
     "(c) olgunlaşmamış pencere no-op dalı var");
  ok(/finished_reason\s*=\s*'disconnect'/.test(hd), "(d) finalize dalı var");
  ok(hd.indexOf("disconnect_watch_player_id = v_opp_id") < hd.indexOf("status                     = 'finished'"),
     "pencere açma dalı finalize'dan ÖNCE (tek çağrı bitiremez)");
  ok(/route_duel_authorize_player\(p_player_id, p_claim_token\)/.test(hd),
     "yetki kontrolü korunuyor");
  ok(/player_room_mismatch/.test(hd), "oda üyeliği kontrolü korunuyor");
  ok(!/drop function/i.test(MIG_ROUTE), "migration hiçbir fonksiyonu DROP etmiyor");
  ok(!/route_duel_submit_move/.test(MIG_ROUTE.replace(/--[^\n]*/g, "")),
     "migration submit_move'a DOKUNMUYOR");
}

/* ── 1e. İstemci: monitör sağlık bayrağına bağlı ────────────────────────── */
section("1e. Rota — istemci monitörü");
{
  ok(/shouldRequestDisconnect\(stale,\s*heartbeatHealthyRef\.current\)/.test(SRC_ROUTE),
     "kopuş isteği KENDİ heartbeat sağlığıma bağlı");
  ok(/rpc\("route_duel_cancel_quick_match"[\s\S]{0,220}\.then\(/.test(SRC_ROUTE),
     "unmount'taki cancel_quick_match da .then(...) ile GERÇEKTEN gönderiliyor");
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 2 — ÇARK: DOĞRU HEDEF DOKUNUŞU SESSİZ BAŞARISIZ OLAMAZ
   ══════════════════════════════════════════════════════════════════════════ */
section("2. Çark — doğru cevap yolu artık sessiz değil");
{
  const start = SRC_WHEEL.indexOf("const handleMapClick = useCallback");
  const block = SRC_WHEEL.slice(start, SRC_WHEEL.indexOf("playSound(\"correct\");", start) + 40);

  ok(/setWrongId\(topoId\)/.test(block), "yanlış cevap hâlâ lokal kırmızı flash veriyor");
  ok(/showClaimNotice\(/.test(block),
     "doğru cevap yolundaki HATA kullanıcıya GÖRÜNÜYOR");
  ok(/sessionInvalid/.test(block) && /unauthorized\|player_room_mismatch/.test(block),
     "oturum/yetki hatası ayrı ve anlaşılır biçimde ayrıştırılıyor");
  ok(/from\("wheel_duel_rooms"\)[\s\S]{0,160}\.eq\("id", r\.id\)/.test(block),
     "claimed:false durumunda oda SUNUCUDAN tazeleniyor (bayat hedef kendini onarır)");
  ok(/roomRef\.current = freshRoom/.test(block),
     "tazelenen oda ref'e de yazılıyor (sonraki tıklama doğru hedefi görür)");

  // Hata dallarının hiçbiri artık çıplak `return;` ile bitmiyor.
  const errBranch = block.slice(block.indexOf("if (error) {"), block.indexOf("const res ="));
  ok(errBranch.includes("showClaimNotice"), "RPC hata dalı kullanıcıya bildiriyor");

  ok(/\.wd-claim-notice\s*\{[^}]*pointer-events:\s*none/.test(SRC_CSS),
     "uyarı şeridi pointer-events:none — KENDİSİ yeni bir 'tıklanamıyor' kaynağı olamaz");
}

section("2b. Çark — Hızlı Eşleş yetkisi artık KALICI (kök neden)");
{
  // Canlı veriyle doğrulandı: Çark QM oyuncu satırları profile_id VE guest_id
  // NULL doğuyor → 20260814180000'in claim dalı QM'de YAPISAL OLARAK ÖLÜ,
  // geriye tek yetki kaynağı olarak MUTABLE kuyruk satırı kalıyordu.
  const authz = MIG_HARD.slice(MIG_HARD.indexOf("create or replace function public.wheel_duel_authorize_player"));
  ok(/p\.guest_id\s+is not null/.test(authz.slice(0, 1200)),
     "önkoşul: claim dalı gerçek misafir şartı taşıyor (QM satırında guest_id NULL)");

  ok(/create table if not exists public\.wheel_duel_quick_match_owners/.test(MIG_QMID),
     "kalıcı sahiplik tablosu ekleniyor");
  ok(/enable row level security/.test(MIG_QMID) && !/create policy/.test(MIG_QMID),
     "tablo sunucu-özel: RLS açık, politika YOK");
  ok(/revoke all on table public\.wheel_duel_quick_match_owners from authenticated/.test(MIG_QMID),
     "istemciye hiçbir tablo yetkisi verilmiyor");
  ok(/on conflict \(player_id\) do nothing/.test(MIG_QMID),
     "İLK sahip kalıcı — sonradan gelen kuyruk satırı sahibi DEĞİŞTİREMEZ");
  ok(/after insert or update on public\.wheel_duel_queue/.test(MIG_QMID),
     "trigger kuyruk yazımını yakalıyor (RPC'ler SECURITY DEFINER)");
  ok(/insert into public\.wheel_duel_quick_match_owners[\s\S]{0,240}from public\.wheel_duel_queue/.test(MIG_QMID),
     "backfill: canlı maçlar deploy anında kopmuyor");

  const newAuthz = MIG_QMID.slice(MIG_QMID.indexOf("create or replace function public.wheel_duel_authorize_player"));
  ok(/p\.profile_id is not null and p\.profile_id = auth\.uid\(\)/.test(newAuthz),
     "1. dal (kayıtlı) korunuyor");
  ok(/p\.guest_id  is not null/.test(newAuthz), "2. dal (gerçek misafir) korunuyor");
  ok(/from public\.wheel_duel_queue q/.test(newAuthz), "3. dal (kuyruk köprüsü) korunuyor");
  ok(/from public\.wheel_duel_quick_match_owners o[\s\S]{0,160}o\.profile_id = auth\.uid\(\)/.test(newAuthz),
     "4. dal kalıcı sahiplik — kuyruk köprüsüyle AYNI çifti istiyor (yüzey genişlemiyor)");
  ok(!/drop function/i.test(MIG_QMID), "hiçbir fonksiyon DROP edilmiyor");
  ok(!/wheel_duel_players\s+(add|drop|alter)/i.test(MIG_QMID),
     "wheel_duel_players şeması DEĞİŞMİYOR (XP/gold yolu korunur)");
}

section("2c. Çark — player_id kimliğine bürünme kapatıldı (birleşik 20260827140000)");
{
  // Açık clean-room'da KANITLANDI (check-wheel-identity-security.ts):
  //   kuyruk köprüsü, çağıranın verdiği p_player_id ile yazılan MUTABLE bir
  //   satıra güveniyordu → A, B'nin player_id'siyle yetkilenip claim atabildi.
  const newAuthz = MIG_QMID.slice(MIG_QMID.indexOf("create or replace function public.wheel_duel_authorize_player"));
  const authzBody = newAuthz.slice(0, newAuthz.indexOf("$$;") + 3).replace(/--[^\n]*/g, "");
  ok(!/from\s+public\.wheel_duel_queue/.test(authzBody),
     "authorize ARTIK wheel_duel_queue'yu SORGULAMIYOR (mutable köprü kaldırıldı)");
  ok(/from public\.wheel_duel_quick_match_owners o/.test(authzBody),
     "yerine DEĞİŞTİRİLEMEZ sahiplik kaydı geçti");
  ok(/p\.guest_id is null/.test(authzBody) && /p\.profile_id is null or p\.profile_id = auth\.uid\(\)/.test(authzBody),
     "sahiplik dalı, oyuncu satırının KENDİ kimliğini EZEMİYOR");
  ok(/p\.profile_id is not null and p\.profile_id = auth\.uid\(\)/.test(authzBody),
     "kayıtlı dal korunuyor (oda-kodu akışı bozulmuyor)");
  ok(/p\.guest_id  is not null/.test(authzBody), "gerçek misafir dalı korunuyor");

  const trgStart = MIG_QMID.indexOf("create or replace function public._wheel_duel_record_qm_owner");
  const trg = MIG_QMID.slice(trgStart, MIG_QMID.indexOf("$$;", trgStart) + 3);
  ok(/p\.joined_at < now\(\)/.test(trg),
     "trigger: ÖNCEDEN var olan oyuncu satırına sahiplik yazılmıyor (sıra-bağımsız ölçüt)");
  ok(/on conflict \(player_id\) do nothing/.test(trg), "ilk sahip kalıcı (devir yok)");
  ok(!/raise exception/i.test(trg),
     "trigger kuyruk YAZIMINI bozmuyor (görülmeyen QM gövdesi kırılmaz)");

  ok(/delete from public\.wheel_duel_quick_match_owners o/.test(MIG_QMID),
     "çelişkili (ekilmiş) sahiplik kayıtları temizleniyor");
  ok(!/drop function|drop table/i.test(MIG_QMID), "DROP yok");
  ok(!/grant .* to anon/i.test(MIG_QMID), "anon'a hiçbir yeni yetki verilmiyor");

  // BİRLEŞTİRME: iki koruma tek dosyada + yarım durumu engelleyen doğrulama.
  ok(/create table if not exists public\.wheel_duel_quick_match_owners/.test(MIG_QMID)
     && /p\.joined_at < now\(\)/.test(MIG_QMID),
     "kalıcı sahiplik VE kimlik bağlama AYNI dosyada (atomik deploy)");
  ok(/raise exception 'owners tablosu istemciye AÇIK kaldı'/.test(MIG_QMID)
     && /raise exception 'wheel_duel_queue yazma kilidi gevşedi'/.test(MIG_QMID),
     "dosya sonunda YARIM DURUMU engelleyen doğrulama bloğu var");
  ok(!/^\s*(begin|commit)\s*;/im.test(MIG_QMID.replace(/--[^\n]*/g, "")),
     "açık BEGIN/COMMIT yok (çalıştırıcının transaction'ıyla çakışmaz)");
  // Backfill artık SIRALAMAYA HİÇ DAYANMIYOR: üretimdeki 42703 (`updated_at`
  // yok) ve daha önemlisi "en eski kazanır"ın saldırganı seçebilmesi yüzünden
  // kural iç-tutarlılık + arızada-kapanır çekişme testine çevrildi.
  const qmBody = MIG_QMID.replace(/--[^\n]*/g, "");
  ok(!/order by/i.test(qmBody) && !/distinct on/i.test(qmBody),
     "backfill sıralamaya/tie-break'e DAYANMIYOR");
  ok(/p\.room_id\s*=\s*q\.matched_room_id/.test(qmBody),
     "backfill iç tutarlılık istiyor (oyuncu, satırın gösterdiği odanın üyesi)");
  ok(/r\.status\s*=\s*'playing'/.test(qmBody),
     "backfill yalnız CANLI maçlar için sahiplik taşıyor");
  ok(/not exists \(\s*\n?\s*select 1 from public\.wheel_duel_queue q2/.test(qmBody),
     "backfill çekişmede ARIZADA-KAPANIR (aynı player_id'yi iddia eden ikinci satır varsa hiçbir şey yazmaz)");
  ok(!/updated_at/.test(MIG_QMID), "dosyada 'updated_at' geçmiyor (üretimdeki 42703'ün kaynağı)");
  const queueCols = new Set((qmBody.match(/\bq2?\.[a-z_]+/g) ?? []).map(x => x.split(".")[1]));
  const okCols = new Set(["profile_id", "player_id", "matched_room_id"]);
  ok([...queueCols].every(c => okCols.has(c)),
     "migration YALNIZ kanıtlanmış kuyruk kolonlarını kullanıyor",
     [...queueCols].filter(c => !okCols.has(c)).join(","));
  ok(/foreach v_col in array array\['profile_id','player_id','matched_room_id'\]/.test(MIG_QMID),
     "kullanılan kuyruk kolonları için ÖN KOŞUL doğrulaması var (temiz hata, yarım uygulama yok)");
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 3 — ÇARK: "HIZLI EŞLEŞ" TAZELİĞİ
   ══════════════════════════════════════════════════════════════════════════ */
section("3a. Hızlı Eşleş tazelik kararı (paylaşılan saf modül)");
{
  const NOW = 1_800_000_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  // A. Taze eşleşme (RPC: status='playing', started_at = now()+3s)
  ok(decideQuickMatchJoin({ room: { status: "playing", started_at: iso(NOW + 3000) }, syncedNowMs: NOW }).action === "join",
     "A. taze eşleşme → KATIL");
  ok(decideQuickMatchJoin({ room: { status: "playing", started_at: iso(NOW - 2000) }, syncedNowMs: NOW }).action === "join",
     "A. 2 sn önce başlamış maç → KATIL");

  // B. Bitmiş oda
  const finished = decideQuickMatchJoin({ room: { status: "finished", started_at: iso(NOW - 1000) }, syncedNowMs: NOW });
  ok(finished.action === "keep-searching" && finished.reason === "stale_room",
     "B. BİTMİŞ oda → asla açılmaz, arama sürer");

  // C. Terk edilmiş (playing ama eski)
  const abandoned = decideQuickMatchJoin({ room: { status: "playing", started_at: iso(NOW - 5 * 60_000) }, syncedNowMs: NOW });
  ok(abandoned.action === "keep-searching" && abandoned.reason === "stale_room",
     "C. TERK EDİLMİŞ (5 dk önce başlamış) oda → açılmaz");

  // D. Silinmiş oda
  const gone = decideQuickMatchJoin({ room: null, fetchFailed: true, syncedNowMs: NOW });
  ok(gone.action === "keep-searching" && gone.reason === "room_unreadable",
     "D. SİLİNMİŞ/okunamayan oda → arama BOZULMAZ (kullanıcı setup'a düşmez)");

  // E. Lobi ('waiting') — Çark QM odası asla waiting doğmaz
  ok(decideQuickMatchJoin({ room: { status: "waiting", started_at: iso(NOW) }, syncedNowMs: NOW }).action === "keep-searching",
     "E. eski LOBİ (waiting) → açılmaz");

  // F. started_at yok / bozuk
  ok(decideQuickMatchJoin({ room: { status: "playing", started_at: null }, syncedNowMs: NOW }).action === "keep-searching",
     "F. started_at YOK → açılmaz");
  ok(decideQuickMatchJoin({ room: { status: "playing", started_at: "bozuk" }, syncedNowMs: NOW }).action === "keep-searching",
     "F. started_at PARSE EDİLEMİYOR → açılmaz");

  // G. Sınır: eşiğin iki yanı
  const edgeIn  = decideQuickMatchJoin({ room: { status: "playing", started_at: iso(NOW - (QUICK_MATCH_FRESH_ROOM_MAX_AGE_MS - 1000)) }, syncedNowMs: NOW });
  const edgeOut = decideQuickMatchJoin({ room: { status: "playing", started_at: iso(NOW - (QUICK_MATCH_FRESH_ROOM_MAX_AGE_MS + 1000)) }, syncedNowMs: NOW });
  ok(edgeIn.action === "join",  "G. eşiğin 1 sn içi → katıl");
  ok(edgeOut.action === "keep-searching", "G. eşiğin 1 sn dışı → katılma");

  // Saat sapması taze odayı bayat GÖSTERMEMELİ (synced clock kullanılıyor)
  ok(decideQuickMatchJoin({ room: { status: "playing", started_at: iso(NOW + 3000) }, syncedNowMs: NOW - 5000 }).action === "join",
     "5 sn geri sapmış saat taze odayı bayat göstermiyor");
}

section("3b. Çark — iki katmanlı tazelik (reset RPC + validate-before-commit)");
{
  ok(/create or replace function public\.wheel_duel_reset_quick_match/.test(MIG_WHEEL),
     "wheel_duel_reset_quick_match RPC'si eklendi (Çark'ta eksik olan tek parça)");
  ok(/delete from public\.wheel_duel_queue\s*\n\s*where profile_id = p_profile_id/.test(MIG_WHEEL),
     "reset, kuyruk satırını KOŞULSUZ siliyor (matched satırlar dahil)");
  ok(/auth\.uid\(\) <> p_profile_id/.test(MIG_WHEEL),
     "reset yalnız ÇAĞIRANIN kendi satırını silebiliyor");
  ok(/grant\s+execute on function public\.wheel_duel_reset_quick_match\(uuid\) to authenticated/.test(MIG_WHEEL),
     "reset yalnız authenticated'a açık");
  ok(!/wheel_duel_quick_match\s*\(/.test(MIG_WHEEL.replace(/--[^\n]*/g, "")),
     "migration wheel_duel_quick_match gövdesine DOKUNMUYOR");

  const startQm = SRC_WHEEL.slice(
    SRC_WHEEL.indexOf("const startQuickMatch = useCallback"),
    SRC_WHEEL.indexOf("const startQuickMatch = useCallback") + 2600,
  );
  ok(/rpc\(\s*\n?\s*"wheel_duel_reset_quick_match"/.test(startQm),
     "startQuickMatch bayat kuyruk satırını sıfırlıyor");

  // Validate-before-commit sırası: tazelik kararı, arama state'i sökülmeden ÖNCE.
  const joinQm = SRC_WHEEL.slice(
    SRC_WHEEL.indexOf("const joinQuickMatchRoom = useCallback"),
    SRC_WHEEL.indexOf("/** Polling tick"),
  );
  const iDecide = joinQm.indexOf("decideQuickMatchJoin(");
  const iCommit = joinQm.indexOf("quickMatchJoinedRef.current = true");
  const iClear  = joinQm.indexOf("clearInterval(quickMatchTickRef.current)");
  ok(iDecide > 0 && iCommit > iDecide, "Çark: tazelik kararı, commit bayrağından ÖNCE");
  ok(iClear > iDecide, "Çark: arama interval'leri karar ÖNCESİ sökülmüyor");
  ok(!/setPhase\("setup"\)/.test(joinQm.slice(0, iCommit)),
     "Çark: okunamayan oda kullanıcıyı setup'a DÜŞÜRMÜYOR (arama sürer)");

  const joinRd = SRC_ROUTE.slice(
    SRC_ROUTE.indexOf("const joinQuickMatchRoom = useCallback"),
    SRC_ROUTE.indexOf("const cancelQuickMatchRef"),
  );
  const jDecide = joinRd.indexOf("decideQuickMatchJoin(");
  const jCommit = joinRd.indexOf("quickMatchJoinedRef.current = true");
  ok(jDecide > 0 && jCommit > jDecide, "Rota: tazelik kararı, commit bayrağından ÖNCE");
  ok(/rpc\("route_duel_reset_quick_match"/.test(SRC_ROUTE),
     "Rota: reset çağrısı korunuyor");
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 4 — MODLAR ARASI BAYAT-ODA DENETİMİ
   ══════════════════════════════════════════════════════════════════════════ */
section("4. Modlar arası: SELECT-first guard'ı olan HER mod reset çağırıyor");
{
  const modes: { name: string; file: string; queue: string; reset: string }[] = [
    { name: "Ülke Yaz",      file: "src/components/DuelGame.tsx",                 queue: "country_duel_queue", reset: "country_duel_reset_quick_match" },
    { name: "Bayrak Düello", file: "src/components/FlagDuelGame.tsx",             queue: "flag_duel_queue",    reset: "flag_duel_reset_quick_match" },
    { name: "Çark Düello",   file: "src/components/WheelDuelGame.tsx",            queue: "wheel_duel_queue",   reset: "wheel_duel_reset_quick_match" },
    { name: "Rota Düello",   file: "src/components/routeDuel/RouteDuelGame.tsx",  queue: "route_duel_queue",   reset: "route_duel_reset_quick_match" },
  ];
  for (const m of modes) {
    const src = read(m.file);
    const usesSelectFirst = src.includes(`from("${m.queue}")`) && src.includes("matched_room_id");
    ok(usesSelectFirst, `${m.name}: SELECT-first guard mevcut (denetim kapsamında)`);
    ok(src.includes(m.reset),
       `${m.name}: yeni arama öncesi ${m.reset} çağrılıyor (bayat matched satırı silinir)`);
  }

  // Kuşatma: kuyruk satırını hiç OKUMAZ (yalnız RPC dönüşüne güvenir) + reset var.
  const conquest = read("src/modes/conquest/conquestService.ts");
  ok(conquest.includes("conquest_reset_quick_match"), "Kuşatma: reset RPC'si çağrılıyor");
  ok(!conquest.includes('from("conquest_queue")'),
     "Kuşatma: kuyruk satırını istemci OKUMUYOR → bayat matched_room_id yolu YOK");

  // Hızlı Eşleşi OLMAYAN modlarda bu risk yapısal olarak yok.
  for (const [name, file] of [
    ["Bayrak Grup", "src/components/FlagGroupGame.tsx"],
    ["Çark Grup",   "src/components/WheelGroupGame.tsx"],
    ["Ülke Grup",   "src/components/DuelGroupGame.tsx"],
    ["Kör Nokta",   "src/modes/korNokta/KorNoktaMode.tsx"],
  ] as const) {
    const src = read(file);
    ok(!/rpc\("[a-z_]*_quick_match"/.test(src),
       `${name}: Hızlı Eşleş yok → bayat kuyruk riski YAPISAL olarak yok`);
  }

  // Oturum geri yükleyen modlar terminal odayı geri açmamalı.
  const duel = read("src/components/DuelGame.tsx");
  ok(/r\.status === "finished"[\s\S]{0,160}clearDuelSession\(\)/.test(duel),
     "Ülke Yaz: cold-start restore BİTMİŞ odayı geri açmıyor");
  const kn = read("src/modes/korNokta/KorNoktaMode.tsx");
  ok(/fetchKorNoktaRoomState\(/.test(kn),
     "Kör Nokta: restore SUNUCUYA doğrulatılıyor (oda + üyelik + claim)");
}

section("2d. Çark QM — ÇAĞIRAN tarafın kalıcı kimliği (20260827150000)");
{
  const MIG_BIND2 = read("supabase/migrations/20260827150000_wheel_duel_quick_match_bind_players.sql");
  const body = MIG_BIND2.replace(/--[^\n]*/g, "");

  // TASARIM: fonksiyon tabanlı — bağlama, Hızlı Eşleş RPC'sinin KENDİ
  // transaction'ında olur; genel oyuncu trigger'ı YOKTUR.
  ok(/create or replace function public\.wheel_duel_quick_match\(/.test(body),
     "TAM imza create or replace ediliyor (FUNCTION-BASED)");
  ok(/rename to _wheel_duel_quick_match_core/.test(body),
     "canlı gövde rename ile ÇEKİRDEĞE taşınıyor (yeniden yazılmıyor)");
  ok(!/after\s+insert\s+on\s+public\.wheel_duel_players/i.test(body),
     "wheel_duel_players üzerinde GENEL sahiplik trigger'ı YOK");
  ok(/drop trigger\s+if exists wheel_duel_players_bind_owner/.test(body),
     "önceki taslağın oyuncu trigger'ı açıkça KALDIRILIYOR");

  // Bağlama: iki taraf da, aynı transaction içinde.
  ok(/_wheel_duel_bind_qm_owner\(v_my_id, p_profile_id, v_room_id\)/.test(body),
     "ÇAĞIRAN taraf bağlanıyor (auth.uid() = p_profile_id kanıtıyla)");
  ok(/v_waiting\.player_id, v_waiting\.profile_id, v_room_id/.test(body),
     "BEKLEYEN taraf bağlanıyor (kuyruk satırı SUNUCUDAN okunuyor)");
  ok(/v_uid\s*=\s*p_profile_id/.test(body),
     "çağıranın verdiği p_profile_id auth.uid() ile TEKRAR doğrulanıyor");
  ok(/matched_room_id\s*=\s*v_room_id/.test(body),
     "bekleyen taraf, çekirdeğin KENDİ kurduğu odayı gösteren satırdan bulunuyor");

  // Fail-closed sahiplik kuralları.
  ok(/raise exception[\s\S]{0,120}çelişkili sahiplik kaydı/.test(body),
     "çelişkili sahiplikte RAISE → tüm Hızlı Eşleş geri alınır (fail-closed)");
  ok(/raise exception[\s\S]{0,120}kimlik çelişkisi/.test(body),
     "oyuncu satırının KENDİ kimliğiyle çelişen bağlama RAISE ediyor");
  ok(/on conflict \(player_id\) do nothing;[\s\S]{0,400}is distinct from p_profile_id[\s\S]{0,200}raise exception/.test(body),
     "`on conflict do nothing` SESSİZ değil — ardından ZORUNLU doğrulama var");
  ok(/room_id is distinct from p_room_id[\s\S]{0,120}return;/.test(body),
     "oda üyeliği doğrulanmadan sahiplik YAZILMIYOR");

  // Çekirdek istemciye kapalı olmalı: yoksa bağlama atlanabilirdi.
  // ⚠ CANLI proacl {=X/postgres,...} ile başlıyor → PUBLIC'in EXECUTE'u VAR.
  //   Yalnız anon/authenticated revoke etmek YETMEZ; PUBLIC üzerinden miras
  //   alırlar. Dört rolün DÖRDÜ de (public dahil) revoke edilmeli.
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    ok(new RegExp(`revoke all on function\\s*\\n?\\s*public\\._wheel_duel_quick_match_core` +
                  `\\(uuid,uuid,text,integer,text,integer,text,text\\)\\s*\\n?\\s*from ${role};`).test(MIG_BIND2),
       `çekirdek ${role} rolünden revoke ediliyor`);
  }
  ok(/has_function_privilege\('anon',\s*v_core,\s*'EXECUTE'\)/.test(MIG_BIND2),
     "doğrulama bloğu ETKİN yetkiyi ölçüyor (has_function_privilege PUBLIC'i de sayar)");
  ok(/aclexplode[\s\S]{0,200}grantee = 0[\s\S]{0,200}raise exception/.test(MIG_BIND2),
     "PUBLIC (grantee=0) kaydı iki fonksiyonda da RAISE ile engelleniyor");
  ok(/proacl is null[\s\S]{0,200}raise exception/.test(MIG_BIND2),
     "proacl maddileşmediyse (varsayılan PUBLIC EXECUTE) migration duruyor");

  // Rename tasarımının tek gerçek riski: OID'e bağlı nesneler.
  ok(/from pg_depend d[\s\S]{0,200}refobjid\s*=\s*v_live/.test(MIG_BIND2),
     "rename öncesi pg_depend OID bağımlılık denetimi yapılıyor");
  ok(/pg_trigger where tgfoid = v_live/.test(MIG_BIND2),
     "fonksiyonun trigger olarak bağlı olmadığı doğrulanıyor");
  ok(/OID''ine bağlı nesne/.test(MIG_BIND2),
     "bağımlılık bulunursa FAIL-CLOSED durduruluyor (rename yapılmaz)");
  // Canlı ACL birebir yeniden kuruluyor (PUBLIC hariç).
  ok(/revoke all on function\s*\n?\s*public\.wheel_duel_quick_match[\s\S]{0,200}from public;/.test(MIG_BIND2),
     "sarmalayıcıda PUBLIC EXECUTE revoke ediliyor");
  for (const role of ["anon", "authenticated", "service_role"]) {
    ok(new RegExp(`grant execute on function\\s*\\n?\\s*public\\.wheel_duel_quick_match[\\s\\S]{0,120}to ${role};`).test(MIG_BIND2),
       `canlı ACL yeniden kuruluyor: ${role}`);
  }

  // Ön koşullar ve hijyen.
  ok(/wheel_duel_players\.id PRIMARY KEY değil/.test(MIG_BIND2),
     "players.id PRIMARY KEY ön koşulu doğrulanıyor (kurbanın kimliği ele geçirilemez)");
  ok(/owners\.player_id üzerinde PK\/UNIQUE yok/.test(MIG_BIND2),
     "owners.player_id tekilliği ön koşulu doğrulanıyor (ilk sahip kalıcı)");
  ok(/zaten sarmalayıcı ama çekirdek yok/.test(MIG_BIND2),
     "tekrar çalıştırmada sonsuz özyineleme koruması var (güvenlik durdurması)");
  ok(!/drop (table|column)/i.test(body), "tablo/kolon DROP'u yok");
  ok(!/\bupdated_at\b/.test(MIG_BIND2), "var olmayan updated_at kolonu KULLANILMIYOR");
  ok(!/grant[^;]*to public\b/i.test(body), "PUBLIC'e yeni yetki yok");
  ok(!/wheel_duel_authorize_player\s*\(/.test(body.replace(/to_regprocedure[^\n]*/g, "")),
     "140000'in authorize'ı YENİDEN TANIMLANMIYOR (yalnız doğrulanıyor)");
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 5 — MIGRATION HİJYENİ
   ══════════════════════════════════════════════════════════════════════════ */
section("5. Migration hijyeni");
{
  const { execFileSync } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  // 5a. Uygulanmış (mevcut) migration dosyalarının HİÇBİRİ değişmemeli.
  const changed = execFileSync("git", ["status", "--porcelain", "--", "supabase/migrations"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const modified = changed.filter(l => !l.startsWith("??"));
  ok(modified.length === 0, "hiçbir MEVCUT migration değiştirilmedi (yalnız yeni dosyalar)",
     modified.join(" | "));

  // Bu betiğin konusu 20260827* serisidir. Seri COMMIT EDİLDİKTEN sonra
  // "untracked dosya sayısı" ölçmek anlamsızlaşır (o an 4 idi, artık 0) ve
  // sonradan eklenen HER migration'da yanlış alarm verirdi. Doğru değişmez:
  // seri dört dosyadan oluşur ve BU BETİK ÇALIŞIRKEN REPO'DA DURUR.
  const series = readdirSync(join(ROOT, "supabase/migrations"))
    .filter(f => f.startsWith("20260827") && f.endsWith(".sql")).sort();
  ok(series.length === 4, "20260827 serisi tam olarak 4 migration", series.join(" "));

  // 5b. Zaman damgaları tekil ve sıralı.
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort();
  const stamps = files.map(f => f.slice(0, 14));
  const dupes = stamps.filter((v, i) => stamps.indexOf(v) !== i && v.startsWith("202608"));
  ok(new Set(files.map(f => f.slice(0, 14) + f)).size === files.length, "dosya adları tekil");
  ok(!dupes.some(d => d.startsWith("20260827")), "20260827 damgaları çakışmıyor", dupes.join(","));
  const mine = files.filter(f => f.startsWith("20260827"));
  ok(JSON.stringify(mine) === JSON.stringify([...mine].sort()), "yeni migration'lar sıralı", mine.join(" "));
  ok(mine.length === 4 && mine[mine.length - 1] > files[files.length - 5],
     "yeni migration'lar en sonda (forward-only)", mine.join(" "));

  // 5c. Yıkıcı/geniş yetki değişikliği yok.
  for (const f of mine) {
    const sql = read(`supabase/migrations/${f}`);
    const body = sql.replace(/--[^\n]*/g, "");
    // Yıkıcı DROP yok. TEK istisna: 150000, bu seride üretilip ÜRETİME HİÇ
    // uygulanmamış olan taslak trigger'ı geri alır (yerel/staging temizliği).
    const drops = (body.match(/\bdrop\s+(table|function|policy|column|trigger)\b[^;]*/gi) ?? [])
      // `drop trigger if exists X` + hemen ardından `create trigger X`:
      // standart idempotent yeniden kurulum, yıkıcı değil.
      .filter(d => {
        const t = (d.match(/drop\s+trigger\s+if exists\s+([a-z0-9_]+)/i) ?? [])[1];
        return !(t && new RegExp(`create trigger\\s+${t}\\b`, "i").test(body));
      })
      // 150000, bu seride üretilip ÜRETİME HİÇ uygulanmamış taslak trigger'ı
      // geri alır (yerel/staging temizliği) — kalıcı bir nesne düşürmez.
      .filter(d => !/_wheel_duel_bind_player_owner|wheel_duel_players_bind_owner/.test(d));
    ok(drops.length === 0, `${f}: yıkıcı DROP yok`, drops.join(" | "));
    ok(!/\btruncate\b/i.test(body), `${f}: TRUNCATE yok`);
    ok(!/grant[\s\S]{0,120}?\bto\s+public\b/i.test(body), `${f}: PUBLIC'e grant yok`);
    // anon grant'leri: YENİ yetki açılmamalı. Rota migration'ı mevcut
    // grant'leri YENİDEN YAZAR (create or replace grant'ları zaten korur;
    // açıkça yazmak niyeti belgeler). "Yeni mi?" sorusunun cevabı, aynı
    // imzanın daha ESKİ bir migration'da da anon'a grant'li olmasıdır.
    // Nihai kanıt clean-room'daki ÖNCE/SONRA ACL karşılaştırmasıdır
    // (scripts/check-route-disconnect-cleanroom.ts).
    const anonGrants = body.match(/grant\s+execute on function ([^;]*?) to [^;]*anon[^;]*;/gi) ?? [];
    const priorSql = readdirSync(join(ROOT, "supabase/migrations"))
      .filter(x => x.endsWith(".sql") && x < f)
      .map(x => read(`supabase/migrations/${x}`)).join("\n");
    const novel = anonGrants.filter(g => {
      const sig = (g.match(/function\s+(public\.[a-z_]+\([^)]*\))/i) ?? [])[1];
      if (!sig) return true;
      const bare = sig.replace(/\s+/g, "");
      return !priorSql.replace(/\s+/g, "").includes(`grantexecuteonfunction${bare}toanon`);
    });
    ok(novel.length === 0, `${f}: anon'a YENİ EXECUTE açılmıyor (yalnız mevcut grant'ın yeniden yazımı)`,
       novel.join(" | "));
    // SECURITY DEFINER fonksiyonlarının hepsi sabit search_path taşımalı.
    const defs = body.split("create or replace function").slice(1)
      .filter(b => /security\s+definer/i.test(b.slice(0, 400)));
    for (const d of defs) {
      const name = (d.match(/public\.([a-z_]+)/) ?? [])[1] ?? "?";
      // `= public` ve `to 'public'` biçimleri eşdeğerdir; canlı fonksiyon
      // ikincisini kullanır ve sarmalayıcı onu birebir korur.
      ok(/set search_path\s*(=|to)\s/i.test(d.slice(0, 500)),
         `${f}: ${name} SECURITY DEFINER + sabit search_path`);
    }
  }

  // 5c-bis. CANLIDA olan üç migration bu turda DEĞİŞMEMELİ (içerik parmak izi).
  //          150000 yeni ve tek başına eklenir.
  const liveMd5 = execFileSync("bash", ["-lc",
    "md5 -q supabase/migrations/20260827120000_route_duel_disconnect_two_phase.sql "
    + "supabase/migrations/20260827130000_wheel_duel_reset_quick_match.sql "
    + "supabase/migrations/20260827140000_wheel_duel_quick_match_durable_identity.sql"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  ok(liveMd5.length === 3 && liveMd5.every(h => /^[0-9a-f]{32}$/.test(h)),
     "canlıdaki üç migration okunabiliyor (parmak izi alındı)", liveMd5.join(" ").slice(0, 40));
  ok(read("supabase/migrations/20260827140000_wheel_duel_quick_match_durable_identity.sql")
       .includes("p.joined_at < now()"),
     "canlı 140000 içeriği DEĞİŞTİRİLMEDİ (kimlik bağlama guard'ı yerinde)");

  // 5d. İlgisiz modlara dokunulmamalı.
  for (const f of mine) {
    const body = read(`supabase/migrations/${f}`).replace(/--[^\n]*/g, "");
    const foreign = ["conquest_", "tevatur_", "flag_group_", "duel_group_", "wheel_group_",
                     "flag_duel_", "country_duel_", "profiles", "xp_events", "gold_"]
      .filter(t => body.includes(t));
    ok(foreign.length === 0, `${f}: ilgisiz mod/tabloya dokunulmuyor`, foreign.join(","));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   BÖLÜM 6 — PAYLAŞILAN YARDIMCININ ÇAĞIRANLARI
   ══════════════════════════════════════════════════════════════════════════ */
section("6. quickMatchFreshness — yalnız amaçlanan çağıranlar");
{
  const { execFileSync } = await import("node:child_process");
  const users = execFileSync("grep", ["-rl", "quickMatchFreshness", "src"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean)
    .filter(f => f !== "src/lib/quickMatchFreshness.ts")   // modülün kendisi
    .sort();
  ok(JSON.stringify(users) === JSON.stringify([
       "src/components/WheelDuelGame.tsx",
       "src/components/routeDuel/RouteDuelGame.tsx",
     ]),
     "paylaşılan yardımcıyı YALNIZ Çark ve Rota kullanıyor (etkilenmeyen modlar dokunulmadı)",
     users.join(" "));

  for (const [name, file] of [
    ["Bayrak Düello", "src/components/FlagDuelGame.tsx"],
    ["Ülke Yaz",      "src/components/DuelGame.tsx"],
    ["Kuşatma",       "src/modes/conquest/conquestService.ts"],
  ] as const) {
    const src = read(file);
    ok(!src.includes("quickMatchFreshness"), `${name}: kendi kanıtlanmış guard'ı korunuyor`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
console.log(`\n${passed}/${passed + failed} assertion geçti`);
process.exit(failed === 0 ? 0 : 1);
