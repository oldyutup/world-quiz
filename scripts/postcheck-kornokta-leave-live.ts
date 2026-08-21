/**
 * postcheck-kornokta-leave-live.ts
 *
 * ⚠⚠ CANLI SUPABASE RUNTIME POSTCHECK — 20260821120000 + 20260821130000
 *
 * NE ZAMAN ÇALIŞTIRILIR
 * ─────────────────────
 * İKİ migration da production'a UYGULANDIKTAN SONRA, elle. Amaç, clean-room'da
 * kanıtlanmış davranışın canlı şema/ACL/RLS altında da geçerli olduğunu
 * görmektir — özellikle yardımcının EXECUTE'u kapalıyken misafirin ve kayıtlı
 * kullanıcının maçtan gerçekten çıkabildiğini.
 *
 * ÇALIŞTIRMA KİLİDİ
 * ─────────────────
 * Kazara koşmayı imkânsız kılmak için iki kapı vardır ve İKİSİ de gereklidir:
 *
 *     KN_LIVE_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \
 *     npx tsx scripts/postcheck-kornokta-leave-live.ts --confirm
 *
 * Bayraksız çağrı hiçbir şey yazmaz: yalnız planı basar ve çıkar (dry-run).
 *
 * VERİ HİJYENİ
 * ────────────
 *   • Kimlik: YALNIZ .env.test.local'daki iki adanmış test hesabı
 *     (TORBLE_A_*, TORBLE_B_*). Gerçek kullanıcı kimliği kullanılmaz.
 *   • Oda kodları KN- öneki + zaman damgası taşır; script SADECE kendi
 *     kurduğu oda id'lerine dokunur. Kod/oda ARAMASI YAPMAZ, listelemez,
 *     başka odaya hiçbir koşulda yazmaz.
 *   • Diğer katılımcılar misafir oturumlarıdır (guest_id de KN- öneklidir).
 *   • Her senaryo sonunda oda kapatılır; en sonda "artık kalmadı" (residual 0)
 *     ayrıca doğrulanır. Doğrulanamazsa postcheck FAIL verir — sessizce
 *     çöp bırakmaz.
 *   • XP/gold/kazanan yazılmadığı, test hesabının xp_events satır sayısı
 *     ÖNCE/SONRA karşılaştırılarak kanıtlanır.
 *
 * GÜVENLİK: hiçbir secret hardcode edilmez ve hiçbiri konsola yazılmaz.
 * Bağlantı bilgisi PUBLIC anon anahtarıdır (service-role YOK), şifreler yalnız
 * signInWithPassword çağrısına gider.
 *
 * KAPSAM: yalnız Kör Nokta çıkış akışı. Başka mod, başka tablo, başka RPC yok.
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* ── Ortam ─────────────────────────────────────────────────────────────── */
/**
 * `KEY=value` satırlarını okur.
 *
 * NEDEN KIRPIYOR: eski hâlde regex'in sondaki `\s*`i, `(.*)` açgözlü olduğu
 * için hep boş eşleşiyordu ve satır sonundaki boşluk DEĞERİN İÇİNDE kalıyordu.
 * `.env.test.local`daki e-posta satırlarının sonundaki tek bir görünmez boşluk
 * adresi "user@example.com " yapıp girişi "Invalid login credentials" ile
 * düşürüyordu. Kırpma YALNIZ kenarlardadır (CR dâhil): değerin İÇİNDEKİ
 * boşluklar — parolalarda olabilir — aynen korunur.
 *
 * TIRNAK BİR KAÇIŞ YOLUDUR: `KEY=" abc "` yazıldığında eşleşen tırnak çifti
 * soyulur ve içerideki boşluk AYNEN kalır. Yani kasıtlı kenar boşluğu hâlâ
 * ifade edilebilir; kazara olan temizlenir. (Eski kod tek taraflı tırnağı da
 * soyuyordu — `abc"` gibi bir değeri bozardı; artık yalnız EŞLEŞEN çift.)
 */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  // CRLF'e dikkat: JS'te `\r` bir SATIR SONLANDIRICIDIR, yani `.` onu
  // eşleştirmez ve `(.*)$` CRLF'li bir satırda TÜM eşleşmeyi düşürür — değişken
  // sessizce "yok" olurdu. Satırları bölerken `\r`i baştan atıyoruz.
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

/* ── Çalıştırma kilidi ─────────────────────────────────────────────────── */
const ARMED =
  process.env.KN_LIVE_POSTCHECK === "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION" &&
  process.argv.includes("--confirm");

const PLAN = `
KÖR NOKTA CANLI ÇIKIŞ POSTCHECK — PLAN

  Ön koşul : 20260821120000 + 20260821130000 production'a UYGULANMIŞ olmalı.
  Kimlik   : .env.test.local → TORBLE_A / TORBLE_B (adanmış test hesapları)
  Diğerleri: KN- önekli tek kullanımlık misafir oturumları

  S0  ACL     : yardımcı (tevatur_kn_min_viable_team_size) DOĞRUDAN çağrılamaz
                → anon ve authenticated için 42501/404 beklenir
  S1  2v2     : A(host,kayıtlı) + misafir  vs  B(kayıtlı) + misafir
                B çıkar → status=finished, finished_reason='abandoned'
                phase 'final_results' OLMAMALI, kazanan YAZILMAMALI
  S2  2v2     : aynı kurulum, bu kez MİSAFİR çıkar → aynı terminal sonuç
                (yardımcı ACL kapalıyken misafir yolu çalışıyor mu?)
  S3  3v3     : A + 2 misafir vs B + 2 misafir
                bir çıkış → status HÂLÂ 'playing' (takım 2 → viable)
                ikinci çıkış aynı takımdan → 'abandoned'
  S4  GÜVENLİK: yanlış claim_token → reddedilir (oda BOZULMAZ)
                cross-room (S3 oyuncusu S1 odasını bitirmeye çalışır) → reddedilir
  S5  ÖDÜL    : test hesaplarının xp_events sayısı ÖNCE == SONRA
  S6  TEMİZLİK: kurulan her oda kapatılır; residual oda sayısı 0 doğrulanır

  Bu çalıştırma HİÇBİR ŞEY YAZMADI (dry-run).
  Gerçekten koşmak için:
    KN_LIVE_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \\
    npx tsx scripts/postcheck-kornokta-leave-live.ts --confirm
`;

if (!ARMED) {
  console.log(PLAN);
  process.exit(0);
}

/* ══════════════════════════════════════════════════════════════════════════
   Buradan aşağısı YALNIZ iki kapı da açıkken koşar.
══════════════════════════════════════════════════════════════════════════ */
let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

if (!SUPA_URL || !SUPA_KEY) { console.error("FAIL: VITE_SUPABASE_URL/ANON_KEY yok"); process.exit(1); }
if (ACCOUNTS.some(a => !a.email || !a.password)) {
  console.error("FAIL: .env.test.local içinde TORBLE_A_*/TORBLE_B_* eksik"); process.exit(1);
}

const TAG = `KN-${Date.now().toString(36).toUpperCase()}`;
const uuid = () => crypto.randomUUID();
/** Oda kodu: T öneki mod kuralı, kalanı bu koşuya özgü — çakışma/karışma yok. */
const roomCode = (n: number) => `T${TAG.slice(3, 8)}${n}`.slice(0, 10).toUpperCase();

/** Kurulan her oda ve İÇİNDEKİ HER KOLTUK burada izlenir.
 *  Temizlik yalnız host'u çıkarsaydı oda AYAKTA kalırdı: `tevatur_leave_room`
 *  host ayrıldığında odayı ancak geriye KAYITLI oyuncu kalmadıysa siler. O
 *  yüzden önce kayıtlı olmayan/ikincil koltuklar, EN SON host çıkar → oda
 *  cascade ile gerçekten silinir. */
const created: { roomId: string; seats: Seat[] }[] = [];
function track(roomId: string, seat: Seat) {
  created.find(c => c.roomId === roomId)?.seats.push(seat);
}

function anonClient(): SupabaseClient {
  return createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
}
async function signedInClient(i: number): Promise<SupabaseClient> {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword(ACCOUNTS[i]);
  if (error) throw new Error(`signIn[${i}] failed: ${error.message}`);
  return c;
}

interface Seat { client: SupabaseClient; playerId: string; token: string; guest: boolean }

/* ── start_game yükleri ───────────────────────────────────────────────────
   `tevatur_kn_start_game` (20260719130000) ikisini de ZORUNLU kılar ve
   şekillerini sıkı doğrular:
     • p_scenes        → tam round_count(5) eleman, her biri {id, lat, lng}
                         (lat -90..90, lng -180..180)
     • p_question_pool → 4 kategori (alphabet/traffic/architecture/nature),
                         her birinde >=3 farklı, boş olmayan id
   Buradaki içerik TAMAMEN sentetiktir ve KN- etiketiyle işaretlidir: gerçek
   sahne kataloğundan hiçbir şey okunmaz, hiçbir üretim içeriği kullanılmaz.
   Amaç maçı 'playing' durumuna getirmek; tur oynanmaz. */
const SCENES = Array.from({ length: 5 }, (_, i) => ({
  id: `${TAG}-scene${i + 1}`,
  lat: 41 + i * 0.5,
  lng: 29 + i * 0.5,
}));
const QUESTION_POOL = Object.fromEntries(
  ["alphabet", "traffic", "architecture", "nature"].map(cat => [
    cat, [1, 2, 3].map(n => `${TAG}-${cat}${n}`),
  ]),
);

/** Kayıtlı host bir oda kurar (oda kurma login-only). */
async function createRoom(host: SupabaseClient, code: string): Promise<{ roomId: string; seat: Seat }> {
  const playerId = uuid(); const token = uuid();
  const { data, error } = await host.rpc("tevatur_create_room", {
    p_player_id: playerId, p_code: code, p_round_count: 5,
    p_photo_seconds: 10, p_claim_token: token,
  });
  if (error) throw new Error(`create_room: ${error.message}`);
  const roomId = (data as { id: string }).id;
  const seat: Seat = { client: host, playerId, token, guest: false };
  created.push({ roomId, seats: [seat] });   // [0] = host, HER ZAMAN son çıkar
  return { roomId, seat };
}

async function joinRegistered(c: SupabaseClient, code: string, roomId: string): Promise<Seat> {
  const playerId = uuid(); const token = uuid();
  const { error } = await c.rpc("tevatur_join_room", {
    p_code: code, p_player_id: playerId, p_claim_token: token,
    p_guest_id: null, p_name: null,
  });
  if (error) throw new Error(`join(registered): ${error.message}`);
  const seat: Seat = { client: c, playerId, token, guest: false };
  track(roomId, seat);
  return seat;
}

async function joinGuest(code: string, n: number, roomId: string): Promise<Seat> {
  const c = anonClient();
  const playerId = uuid(); const token = uuid();
  const { error } = await c.rpc("tevatur_join_room", {
    p_code: code, p_player_id: playerId, p_claim_token: token,
    p_guest_id: `${TAG}-g${n}`, p_name: `${TAG}g${n}`,
  });
  if (error) throw new Error(`join(guest${n}): ${error.message}`);
  const seat: Seat = { client: c, playerId, token, guest: true };
  track(roomId, seat);
  return seat;
}

async function roomState(seat: Seat, roomId: string) {
  const { data, error } = await seat.client.rpc("tevatur_get_room_state", {
    p_room_id: roomId, p_player_id: seat.playerId, p_claim_token: seat.token,
  });
  if (error) return null;
  return data as { room?: Record<string, unknown> } | null;
}

async function leave(seat: Seat, roomId: string, token = seat.token) {
  return seat.client.rpc("tevatur_kn_leave_match", {
    p_room_id: roomId, p_player_id: seat.playerId, p_claim_token: token,
  });
}

async function xpCount(c: SupabaseClient): Promise<number> {
  const { count } = await c.from("xp_events").select("*", { count: "exact", head: true })
    .eq("mode_key", "kornokta");
  return count ?? 0;
}

async function main() {
  console.log(`\nKÖR NOKTA CANLI POSTCHECK · etiket ${TAG}\n`);
  const A = await signedInClient(0);
  const B = await signedInClient(1);

  const xpBeforeA = await xpCount(A);
  const xpBeforeB = await xpCount(B);

  /* ── S0: yardımcı DOĞRUDAN çağrılamamalı ── */
  console.log("S0) Yardımcı ACL");
  for (const [label, c] of [["anon", anonClient()], ["authenticated", A]] as const) {
    const { error } = await c.rpc("tevatur_kn_min_viable_team_size", {});
    ok(!!error, `${label} yardımcıyı DOĞRUDAN çağıramıyor`, error?.code ?? "ALLOWED");
  }

  /* ── S1/S2: 2v2 (kayıtlı çıkış / misafir çıkış) ── */
  for (const [idx, who] of [[1, "kayıtlı"], [2, "misafir"]] as const) {
    console.log(`\nS${idx}) 2v2 — ${who} oyuncu çıkıyor`);
    const code = roomCode(idx);
    const { roomId, seat: host } = await createRoom(A, code);
    const reg = await joinRegistered(B, code, roomId);
    const g1 = await joinGuest(code, idx * 10 + 1, roomId);
    const g2 = await joinGuest(code, idx * 10 + 2, roomId);
    for (const [s, team] of [[host, "blue"], [g1, "blue"], [reg, "red"], [g2, "red"]] as const) {
      await A.rpc("tevatur_kn_set_team", {
        p_room_id: roomId, p_host_player_id: host.playerId, p_claim_token: host.token,
        p_target_player_id: s.playerId, p_team: team,
      });
    }
    const { error: startErr } = await A.rpc("tevatur_kn_start_game", {
      p_room_id: roomId, p_host_player_id: host.playerId, p_claim_token: host.token,
      p_scenes: SCENES, p_question_pool: QUESTION_POOL,
    });
    ok(!startErr, "maç başladı", startErr?.message);

    const leaver = idx === 1 ? reg : g2;
    const { error: leaveErr } = await leave(leaver, roomId);
    ok(!leaveErr, `${who} çıkış RPC'si kabul edildi (yardımcı kapalıyken)`, leaveErr?.message);

    const st = await roomState(host, roomId);
    const room = st?.room as Record<string, unknown> | undefined;
    ok(room?.status === "finished", "maç terminal", room?.status);
    ok(room?.finished_reason === "abandoned", "reason=abandoned", room?.finished_reason);
    const gs = room?.game_state as { phase?: string } | undefined;
    ok(gs?.phase !== "final_results", "phase final_results DEĞİL (XP tetiklenmez)", gs?.phase);
    ok(!("winner_player_id" in (room ?? {})) || room?.winner_player_id == null,
       "kazanan YAZILMADI", room?.winner_player_id);
  }

  /* ── S3: 3v3 devam / ikinci çıkışta terminal ── */
  console.log("\nS3) 3v3 — ilk çıkış devam, ikinci çıkış terminal");
  const code3 = roomCode(3);
  const { roomId: r3, seat: host3 } = await createRoom(A, code3);
  const reg3 = await joinRegistered(B, code3, r3);
  const gs3 = [await joinGuest(code3, 31, r3), await joinGuest(code3, 32, r3),
               await joinGuest(code3, 33, r3), await joinGuest(code3, 34, r3)];
  const seating = [[host3, "blue"], [gs3[0], "blue"], [gs3[1], "blue"],
                   [reg3, "red"], [gs3[2], "red"], [gs3[3], "red"]] as const;
  for (const [s, team] of seating) {
    await A.rpc("tevatur_kn_set_team", {
      p_room_id: r3, p_host_player_id: host3.playerId, p_claim_token: host3.token,
      p_target_player_id: s.playerId, p_team: team,
    });
  }
  await A.rpc("tevatur_kn_start_game", {
    p_room_id: r3, p_host_player_id: host3.playerId, p_claim_token: host3.token,
    p_scenes: SCENES, p_question_pool: QUESTION_POOL,
  });
  await leave(gs3[3], r3);
  let s3 = (await roomState(host3, r3))?.room as Record<string, unknown> | undefined;
  ok(s3?.status === "playing", "3v3 ilk çıkış → maç DEVAM ediyor", s3?.status);
  await leave(gs3[2], r3);
  s3 = (await roomState(host3, r3))?.room as Record<string, unknown> | undefined;
  ok(s3?.status === "finished" && s3?.finished_reason === "abandoned",
     "3v3 ikinci çıkış → abandoned", { status: s3?.status, reason: s3?.finished_reason });

  /* ── S4: güvenlik ── */
  console.log("\nS4) Güvenlik");
  const code4 = roomCode(4);
  const { roomId: r4, seat: host4 } = await createRoom(A, code4);
  const reg4 = await joinRegistered(B, code4, r4);
  const g41 = await joinGuest(code4, 41, r4);
  const g42 = await joinGuest(code4, 42, r4);
  for (const [s, team] of [[host4, "blue"], [g41, "blue"], [reg4, "red"], [g42, "red"]] as const) {
    await A.rpc("tevatur_kn_set_team", {
      p_room_id: r4, p_host_player_id: host4.playerId, p_claim_token: host4.token,
      p_target_player_id: s.playerId, p_team: team,
    });
  }
  await A.rpc("tevatur_kn_start_game", {
    p_room_id: r4, p_host_player_id: host4.playerId, p_claim_token: host4.token,
    p_scenes: SCENES, p_question_pool: QUESTION_POOL,
  });
  const { error: badTok } = await leave(reg4, r4, uuid());
  ok(!!badTok, "yanlış claim_token reddedildi", badTok?.code ?? "ALLOWED");
  const st4a = (await roomState(host4, r4))?.room as Record<string, unknown> | undefined;
  ok(st4a?.status === "playing", "yanlış token oda durumunu BOZMADI", st4a?.status);

  // cross-room: S3 odasının oyuncusu S4 odasını bitirmeye çalışır.
  await leave({ ...gs3[0], client: gs3[0].client }, r4);
  const st4b = (await roomState(host4, r4))?.room as Record<string, unknown> | undefined;
  ok(st4b?.status === "playing", "cross-room çıkış yabancı odayı BİTİREMEDİ", st4b?.status);

  /* ── S5: ödül yazılmadı ── */
  console.log("\nS5) Ödül/XP");
  ok(await xpCount(A) === xpBeforeA, "A hesabına kornokta XP yazılmadı");
  ok(await xpCount(B) === xpBeforeB, "B hesabına kornokta XP yazılmadı");

  /* ── S6: temizlik + residual ── */
  console.log("\nS6) Temizlik");
  for (const c of created) {
    // Host [0] EN SON: ondan önce kayıtlı bir oyuncu kalırsa oda silinmez,
    // host devredilir. Sırayı ters çevirip host'u sona bırakıyoruz.
    for (const seat of [...c.seats.slice(1), c.seats[0]]) {
      await seat.client.rpc("tevatur_kn_leave_match", {
        p_room_id: c.roomId, p_player_id: seat.playerId, p_claim_token: seat.token,
      });
    }
  }
  let residual = 0;
  const residualDetail: string[] = [];
  for (const c of created) {
    for (const seat of c.seats) {
      const { data } = await seat.client.rpc("tevatur_get_room_state", {
        p_room_id: c.roomId, p_player_id: seat.playerId, p_claim_token: seat.token,
      });
      if (data && (data as { room?: unknown }).room) {
        residual++;
        residualDetail.push(`${c.roomId.slice(0, 8)}…/${seat.guest ? "guest" : "reg"}`);
      }
    }
  }
  ok(residual === 0,
     `artık oda kalmadı (residual 0) — ${created.length} oda, ` +
     `${created.reduce((n, c) => n + c.seats.length, 0)} koltuk tarandı`,
     residual === 0 ? undefined : residualDetail);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("POSTCHECK ERROR:", e.message); process.exit(1); });
