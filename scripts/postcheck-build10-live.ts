/**
 * postcheck-build10-live.ts — Build 10 sunucu düzeltmelerinin CANLI runtime
 * postcheck'i.
 *
 * ⚠ PRODUCTION'A YAZAR. Yalnız 20260827120000 / 130000 / 140000 uygulandıktan
 *   SONRA, ELLE, BİR KEZ:
 *
 *     BUILD10_LIVE_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \
 *     npx tsx scripts/postcheck-build10-live.ts --confirm
 *
 *   Gate olmadan çalıştırılırsa HİÇBİR ŞEY yazmaz: yalnız planı basar
 *   (dry-run) ve 0 ile çıkar.
 *
 * NE DOĞRULAR (metadata değil, DAVRANIŞ)
 * ──────────────────────────────────────
 *   A  Rota Düello kopuş modeli — boşta oyuncu kopuk sayılmıyor; tek çağrı
 *      maçı bitiremiyor; grace içinde reconnect kurtarıyor; gerçek kopuş
 *      sonunda kesinleşiyor; host ve non-host simetrik.
 *   B  Çark Hızlı Eşleş — taze eşleşme; BEKLEYEN **ve** ÇAĞIRAN tarafın
 *      İKİSİ de yetkili, ikisi de kendi hedefini kapıyor; iki kuyruk satırı
 *      silindikten sonra da ikisi de çalışıyor (20260827150000).
 *   C  P0 — A, B'nin player_id'siyle yetkilenemiyor / claim atamıyor /
 *      maçı düşüremiyor; sahiplik devralınamıyor; çapraz oda reddediliyor.
 *   D  Bayat maç — bitmiş maçın kuyruk işaretçisi yeni aramayı kirletemiyor.
 *   E  Sahiplik tablosu istemci rollerine tamamen KAPALI.
 *   F  Temizlik + XP/Gold değişmedi.
 *
 * GÜVENLİK KURALLARI (kodda zorlanır)
 * ───────────────────────────────────
 *   • Kimlik YALNIZ .env.test.local'daki iki adanmış hesap (TORBLE_A/B).
 *   • Yalnız BU scriptin kurduğu odalara dokunulur: her mutasyon
 *     `created.rooms` ile sınırlanır. Oda listeleme/arama YOK.
 *   • Oda kodları tek kullanımlık ve önekli: Rota `B10-RD-…`, Çark `WBX…`
 *     (Çark tarafında sunucu 6 karakter + kısıtlı alfabe dayatıyor).
 *   • Hızlı Eşleş gerçek bir kullanıcıyla eşleşebilir (kuyruk görünmez).
 *     Bu yüzden eşleşme sonrası RAKİP KİMLİĞİ DOĞRULANIR; beklenmeyen rakip
 *     çıkarsa maç DERHAL bırakılır ve script DURUR (asla kör devam etmez).
 *   • Şema DEĞİŞMEZ, migration UYGULANMAZ, service-role KULLANILMAZ:
 *     istemci tablolarında INSERT/UPDATE/DELETE grant'i yoktur (RPC-only).
 *   • Hiçbir credential (url/key/e-posta/parola) konsola yazılmaz.
 *   • İlk beklenmedik hatada DURUR (fail-fast) ve yine de temizlik dener.
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* ── Gate ────────────────────────────────────────────────────────────────── */
const GATE = "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION";
const armed = process.env.BUILD10_LIVE_POSTCHECK === GATE && process.argv.includes("--confirm");
/** Yeniden koşuda TAM geçmiş bölümleri atlamak için (ör. "A"): gereksiz yere
 *  yeni canlı nesne üretilmesin. Atlanan bölüm raporda AÇIKÇA belirtilir. */
const SKIP = new Set((process.env.BUILD10_SKIP_SECTIONS ?? "").split(",").map(x => x.trim()).filter(Boolean));

/* ── Env (gizli değer ASLA basılmaz) ─────────────────────────────────────── */
function parseEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    // Sondaki boşluk KIRPILIR: .env.test.local'daki e-postalar trailing space
    // taşıyor ve kırpılmazsa signInWithPassword "Invalid login credentials" der.
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
const env = { ...parseEnv(".env"), ...parseEnv(".env.test.local") };
const URL = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;

/* ── Raporlama ───────────────────────────────────────────────────────────── */
let passed = 0, failed = 0;
const results: { name: string; pass: boolean; detail: string }[] = [];
function ok(cond: boolean, name: string, detail: unknown = "") {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (cond) { passed++; console.log(`  ✓ ${name}${d ? `   [${d}]` : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${d ? `   [${d}]` : ""}`); }
  results.push({ name, pass: cond, detail: d });
}
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * PostgrestBuilder GERÇEK BİR PROMISE DEĞİLDİR: `.then` vardır, `.catch` YOKTUR.
 * `builder.catch(...)` → TypeError ve çağıran fonksiyon ortasında ölür — ilk
 * canlı koşuda temizlik tam olarak böyle çöktü. Tek güvenli yol `await` + try.
 */
async function swallow(run: () => PromiseLike<unknown>): Promise<void> {
  try { await run(); } catch { /* temizlikte hata yutulur */ }
}

const errMsg = (e: unknown) => {
  const x = e as { message?: string; code?: string };
  return `${x?.code ?? ""} ${x?.message ?? String(e)}`.trim();
};

/** Bu çalıştırmanın YARATTIĞI her şey. Temizlik YALNIZ buraya bakar. */
const created = {
  routeRooms: [] as { id: string; code: string }[],
  wheelRooms: [] as { id: string; code: string }[],
  queueProfiles: new Set<string>(),
};

/* ── Dry-run ─────────────────────────────────────────────────────────────── */
if (!armed) {
  console.log(`
BUILD10 CANLI POSTCHECK — DRY RUN (hiçbir şey yazılmadı)

Çalıştırmak için:
  BUILD10_LIVE_POSTCHECK=${GATE} \\
  npx tsx scripts/postcheck-build10-live.ts --confirm

PLAN (yalnız bu script'in kurduğu nesnelere dokunulur):
  A) Rota Düello — 2 tek kullanımlık oda (B10-RD-*)
     A1 oda kur/katıl/başlat; iki taraf 3 sn heartbeat; B HİÇ hamle yapmaz
     A2 >30 sn ve >60 sn: oda hâlâ 'playing', kazanan yok
     A3 B beat'i durur → 21 sn → handle_disconnect: YALNIZ pencere açar
     A4 hemen ikinci çağrı: hâlâ bitmez (10 sn onay penceresi)
     A5 B tek beat atar → pencere silinir, maç sürer  (reconnect)
     A6 B tekrar susar → 21 sn + 11 sn → maç A lehine biter
     A7 ikinci oda: NON-HOST (B) A'nın kopuşunu kesinleştirir
  B) Çark Hızlı Eşleş — 1 tek kullanımlık maç (WBX*)
     B1 A ve B kuyruğa girer; RAKİP KİMLİĞİ DOĞRULANIR (yabancıysa DUR)
     B2 BEKLEYEN ve ÇAĞIRAN taraf: ikisi de yetkili, ikisi de claim atıyor
     B3 iki tarafın kuyruk satırı da reset_quick_match ile silinir
     B4 kuyruk YOKKEN İKİSİ de hâlâ yetkili ve claim atabiliyor
     B5 çekirdek RPC (_wheel_duel_quick_match_core): anon + authenticated KAPALI mı
  C) P0 — A, B'nin player_id'siyle: authorize / claim / leave_room dener
     C5 A, B'nin player_id'siyle kuyruğa girip sahiplik üretmeyi dener
     C6 çapraz oda reddi
  D) Bayat maç — bitmiş maçın kuyruk işaretçisi + reset + taze arama
     (Çark ve Rota)
  E) owners tablosu: anon ve authenticated ile SELECT/INSERT/UPDATE/DELETE
  F) Temizlik + XP/Gold karşılaştırması

TAHMİNİ SÜRE: ~4-6 dakika (gerçek grace beklemeleri).
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

async function signIn(which: "A" | "B") {
  const sb = mkClient();
  const { data, error } = await sb.auth.signInWithPassword({
    email: env[`TORBLE_${which}_EMAIL`], password: env[`TORBLE_${which}_PASSWORD`],
  });
  if (error || !data.user) throw new Error(`TORBLE_${which} girişi başarısız: ${errMsg(error)}`);
  return { sb, uid: data.user.id };
}

const uuid = () => crypto.randomUUID();
const stamp = Date.now().toString(36).toUpperCase().slice(-4);

/**
 * ÇARK oda kodu. İstenen `B10-WD-` öneki BURADA KULLANILAMAZ:
 * `wheel_duel_quick_match` kodu doğruluyor ("Invalid room_code") ve istemcinin
 * ürettiği biçim `W` + 5 karakter; alfabe I/O/0/1 İÇERMEZ
 * (ROOM_CODE_ALPHABET, WheelDuelGame.tsx:136). Bu yüzden tek kullanımlık
 * işaretimiz kısıtın İÇİNDE kalan `WBX` önekidir.
 * ROTA tarafında böyle bir kısıt yok → orada `B10-RD-` öneki kullanılır.
 */
const WHEEL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const wheelCode = () => "WBX" + Array.from({ length: 3 },
  () => WHEEL_ALPHABET[Math.floor(Math.random() * WHEEL_ALPHABET.length)]).join("");

class Stop extends Error {}

let A!: { sb: SupabaseClient; uid: string };
let B!: { sb: SupabaseClient; uid: string };
let anon!: SupabaseClient;

async function main() {
  A = await signIn("A"); B = await signIn("B"); anon = mkClient();
  console.log("giriş: TORBLE_A + TORBLE_B OK (kimlikler basılmaz)");

  const prof = async (c: { sb: SupabaseClient; uid: string }) => {
    const { data } = await c.sb.from("profiles").select("xp, gold, level").eq("id", c.uid).maybeSingle();
    return data as { xp: number; gold: number; level: number } | null;
  };
  const beforeA = await prof(A), beforeB = await prof(B);
  ok(!!beforeA && !!beforeB, "XP/Gold başlangıç değerleri okundu",
     `A(xp=${beforeA?.xp},gold=${beforeA?.gold}) B(xp=${beforeB?.xp},gold=${beforeB?.gold})`);

  /* ═══════════ A) ROTA DÜELLO KOPUŞ MODELİ ═══════════ */
  if (SKIP.has("A")) {
    // UCUZ SAĞLAMLIK: tam Rota süiti (60+ sn gerçek grace beklemeleri) önceki
    // koşuda 14/14 geçti ve 150000 Rota'ya HİÇ dokunmuyor. Burada yalnız
    // "yol hâlâ ayakta mı" doğrulanır: HİÇBİR oda kurulmaz, hiçbir satır
    // yazılmaz, gerçek kullanıcı verisi okunmaz (var olmayan uuid filtresi).
    section("A) Rota Düello — UCUZ SAĞLAMLIK (tam süit atlandı; yazma YOK)");
    {
      const ghostRoom = uuid(), ghostPlayer = uuid();

      // A1 — iki-aşamalı kopuş kolonları canlı API şemasında duruyor mu?
      const { error: colErr } = await A.sb.from("route_duel_rooms")
        .select("id, disconnect_watch_player_id, disconnect_watch_since")
        .eq("id", ghostRoom);
      ok(!colErr, "A-sanity 20260827120000 kolonları canlı şemada (iki-aşamalı kopuş)",
         errMsg(colErr));

      // A2/A3 — RPC'ler var ve YETKİ KAPILI: var olmayan oda/oyuncu ile çağrı
      //         "fonksiyon yok" değil, yetki/durum reddi vermeli. Yazma olmaz.
      // İMZA: route_duel_heartbeat(p_player_id, p_claim_token) — p_room_id YOK
      // (20260827120000; istemci de bu iki argümanla çağırır).
      const { error: hbErr } = await A.sb.rpc("route_duel_heartbeat", {
        p_player_id: ghostPlayer, p_claim_token: null,
      });
      ok(!hbErr || !/does not exist|not find the function|PGRST202/i.test(errMsg(hbErr)),
         "A-sanity route_duel_heartbeat RPC'si canlıda mevcut", errMsg(hbErr) || "(hatasız)");

      const { error: dcErr } = await A.sb.rpc("route_duel_handle_disconnect", {
        p_room_id: ghostRoom, p_player_id: ghostPlayer, p_claim_token: null,
      });
      ok(!dcErr || !/does not exist|not find the function|PGRST202/i.test(errMsg(dcErr)),
         "A-sanity route_duel_handle_disconnect RPC'si canlıda mevcut",
         errMsg(dcErr) || "(hatasız)");

      // A4 — hayalet oda gerçekten yok: sağlamlık testi hiçbir şey yaratmadı.
      const { data: ghost } = await A.sb.from("route_duel_rooms")
        .select("id").eq("id", ghostRoom).maybeSingle();
      ok(!ghost, "A-sanity hiçbir Rota odası OLUŞTURULMADI (sıfır yazma)");
    }
  } else {
  section("A) Rota Düello — bağlantı modeli (canlı)");

  /** Bir tek kullanımlık rota maçı kurar ve oynanır hâle getirir. */
  async function makeRouteMatch(tag: string) {
    const code = `B10-RD-${stamp}${tag}`;
    const hostId = uuid(), hostTok = uuid(), guestId = uuid(), guestTok = uuid();
    const { data: room, error: e1 } = await A.sb.rpc("route_duel_create_room", {
      p_player_id: hostId, p_profile_id: A.uid, p_guest_id: null, p_name: "pcA",
      p_code: code, p_total_rounds: 3, p_route_length: "5", p_claim_token: hostTok,
    });
    if (e1 || !room?.id) throw new Stop(`route_duel_create_room: ${errMsg(e1)}`);
    created.routeRooms.push({ id: room.id, code });

    const { error: e2 } = await B.sb.rpc("route_duel_join_room", {
      p_code: code, p_player_id: guestId, p_profile_id: B.uid, p_guest_id: null,
      p_name: "pcB", p_claim_token: guestTok,
    });
    if (e2) throw new Stop(`route_duel_join_room: ${errMsg(e2)}`);

    const { data: started, error: e3 } = await A.sb.rpc("route_duel_start_game", {
      p_room_id: room.id, p_host_player_id: hostId, p_claim_token: hostTok,
    });
    if (e3 || started?.status !== "playing") throw new Stop(`route_duel_start_game: ${errMsg(e3)}`);
    return { roomId: room.id as string, code, hostId, hostTok, guestId, guestTok };
  }

  const beat = (c: SupabaseClient, pid: string, tok: string) =>
    c.rpc("route_duel_heartbeat", { p_player_id: pid, p_claim_token: tok }).then(({ error }) => error);
  const disc = (c: SupabaseClient, roomId: string, pid: string, tok: string) =>
    c.rpc("route_duel_handle_disconnect", { p_room_id: roomId, p_player_id: pid, p_claim_token: tok });
  const routeRoom = async (id: string) => {
    const { data } = await A.sb.from("route_duel_rooms")
      .select("status, winner_player_id, finished_reason, disconnect_watch_player_id, disconnect_watch_since")
      .eq("id", id).maybeSingle();
    return data as Record<string, unknown> | null;
  };
  const seenAt = async (roomId: string) => {
    const { data } = await A.sb.from("route_duel_players").select("id, last_seen_at").eq("room_id", roomId);
    return Object.fromEntries((data ?? []).map(r => [r.id as string, r.last_seen_at as string]));
  };

  const m1 = await makeRouteMatch("1");
  ok(true, "A1 tek kullanımlık rota maçı kuruldu ve başladı", m1.code);

  // A2 — 65 sn boyunca İKİ taraf da beat atar, B HİÇ hamle yapmaz.
  {
    const t0 = Date.now();
    let checked30 = false, seen30 = "", seen65 = "";
    const first = await seenAt(m1.roomId);
    while (Date.now() - t0 < 65_000) {
      await beat(A.sb, m1.hostId, m1.hostTok);
      await beat(B.sb, m1.guestId, m1.guestTok);
      // Her iki taraf da kopuş kontrolü ister (istemcinin yaptığı gibi).
      await disc(A.sb, m1.roomId, m1.hostId, m1.hostTok);
      await disc(B.sb, m1.roomId, m1.guestId, m1.guestTok);
      const el = Date.now() - t0;
      if (!checked30 && el > 31_000) {
        checked30 = true;
        const r = await routeRoom(m1.roomId);
        seen30 = String(r?.status);
        ok(r?.status === "playing" && !r?.winner_player_id,
           "A2 >30 sn boşta (B hiç hamle yapmadı): maç sürüyor, kazanan yok", seen30);
      }
      await sleep(3000);
    }
    const r = await routeRoom(m1.roomId);
    seen65 = String(r?.status);
    ok(r?.status === "playing" && !r?.winner_player_id,
       "A2 >60 sn boşta: maç sürüyor, kazanan yok", seen65);
    ok(!r?.disconnect_watch_player_id, "A2 izleme penceresi hiç açılmadı");
    const last = await seenAt(m1.roomId);
    ok(Date.parse(last[m1.guestId]) > Date.parse(first[m1.guestId]),
       "A2 hamle YAPMAYAN oyuncunun last_seen_at'i heartbeat ile tazeleniyor");
  }

  // A3/A4 — B susar; tek çağrı bitiremez.
  {
    await sleep(21_000);                       // B'nin damgası 20 sn'yi geçsin
    await beat(A.sb, m1.hostId, m1.hostTok);   // A canlı
    const { data: r1, error: d1 } = await disc(A.sb, m1.roomId, m1.hostId, m1.hostTok);
    if (d1) throw new Stop(`handle_disconnect(1): ${errMsg(d1)}`);
    ok(r1?.status === "playing" && r1?.disconnect_watch_player_id === m1.guestId,
       "A3 20 sn bayatlık TEK BAŞINA bitirmiyor — yalnız pencere açıldı",
       `${r1?.status}/${r1?.disconnect_watch_player_id ? "armed" : "yok"}`);
    const { data: r2 } = await disc(A.sb, m1.roomId, m1.hostId, m1.hostTok);
    ok(r2?.status === "playing", "A4 hemen ardından ikinci çağrı da bitirmiyor", String(r2?.status));
  }

  // A5 — reconnect: B tek beat atar → pencere silinir.
  {
    const e = await beat(B.sb, m1.guestId, m1.guestTok);
    ok(!e, "A5 B'nin heartbeat'i kabul edildi (reconnect)");
    const r = await routeRoom(m1.roomId);
    ok(r?.status === "playing" && !r?.disconnect_watch_player_id,
       "A5 pencere SİLİNDİ, maç sürüyor (grace içinde reconnect kurtardı)",
       `${r?.status}/${r?.disconnect_watch_player_id ?? "temiz"}`);
  }

  // A6 — gerçek kopuş: B bir daha dönmez.
  {
    await sleep(21_000);
    await beat(A.sb, m1.hostId, m1.hostTok);
    const { data: armed1 } = await disc(A.sb, m1.roomId, m1.hostId, m1.hostTok);
    ok(armed1?.status === "playing", "A6 pencere yeniden açıldı (sayaç sıfırdan)");
    await sleep(11_000);
    await beat(A.sb, m1.hostId, m1.hostTok);
    const { data: fin } = await disc(A.sb, m1.roomId, m1.hostId, m1.hostTok);
    ok(fin?.status === "finished" && fin?.finished_reason === "disconnect"
       && fin?.winner_player_id === m1.hostId,
       "A6 gerçek kopuş kesinleşti; kalan oyuncu (host) kazandı",
       `${fin?.status}/${fin?.finished_reason}`);
    const { data: again } = await disc(A.sb, m1.roomId, m1.hostId, m1.hostTok);
    ok(again?.status === "finished" && again?.winner_player_id === m1.hostId,
       "A6 bitmiş oda idempotent (ikinci çağrı değiştirmiyor)");
  }

  // A7 — NON-HOST tarafı da kopuş tespit edebiliyor.
  {
    const m2 = await makeRouteMatch("2");
    await sleep(21_000);
    await beat(B.sb, m2.guestId, m2.guestTok);          // yalnız misafir canlı
    const { data: a1 } = await disc(B.sb, m2.roomId, m2.guestId, m2.guestTok);
    ok(a1?.status === "playing", "A7 non-host pencereyi açtı");
    await sleep(11_000);
    await beat(B.sb, m2.guestId, m2.guestTok);
    const { data: f2 } = await disc(B.sb, m2.roomId, m2.guestId, m2.guestTok);
    ok(f2?.status === "finished" && f2?.winner_player_id === m2.guestId,
       "A7 non-host (misafir taraf) kopuşu kesinleştirdi ve kazandı",
       `${f2?.status}/${f2?.finished_reason}`);
  }

  }

  /* ═══════════ B) ÇARK HIZLI EŞLEŞ ═══════════ */
  section("B) Çark Hızlı Eşleş — taze maç + kalıcı sahiplik (canlı)");

  const wdPlayerA = uuid(), wdPlayerB = uuid();
  let wdRoomId = "", wdMyA = "", wdMyB = "";
  {
    // Kuyruk kirliyse önce temizle (kendi satırımız).
    for (const c of [A, B]) {
      await c.sb.rpc("wheel_duel_reset_quick_match", { p_profile_id: c.uid });
      created.queueProfiles.add(c.uid);
    }
    const qm = (c: { sb: SupabaseClient; uid: string }, pid: string, name: string, code: string) =>
      c.sb.rpc("wheel_duel_quick_match", {
        p_profile_id: c.uid, p_player_id: pid, p_player_name: name,
        p_duration: 60, p_region: "world", p_max_level_diff: 0,
        p_room_code: code, p_first_target: "792",
      });

    const { data: qb, error: eb } = await qm(B, wdPlayerB, "safis", wheelCode());
    if (eb) throw new Stop(`wheel_duel_quick_match(B): ${errMsg(eb)}`);
    ok(qb?.matched === false, "B1 B kuyruğa girdi (henüz eşleşme yok)", JSON.stringify(qb));

    const { data: qa, error: ea } = await qm(A, wdPlayerA, "darsar", wheelCode());
    if (ea) throw new Stop(`wheel_duel_quick_match(A): ${errMsg(ea)}`);
    if (!qa?.matched) throw new Stop("B1 eşleşme oluşmadı — kuyrukta başka birine düşmüş olabilir; DURULDU");

    wdRoomId = qa.room_id; wdMyA = qa.my_player_id;
    created.wheelRooms.push({ id: wdRoomId, code: String(qa.room_code ?? "(WBX…)") });

    // ── RAKİP KİMLİĞİ DOĞRULAMASI — yabancıysa DERHAL DUR ──
    const { data: ps } = await A.sb.from("wheel_duel_players").select("id").eq("room_id", wdRoomId);
    const ids = (ps ?? []).map(p => p.id as string);
    const expected = [wdPlayerA, wdPlayerB].sort().join(",");
    const actual = [...ids].sort().join(",");
    if (actual !== expected) {
      throw new Stop(
        `B1 GERÇEK BİR KULLANICIYLA EŞLEŞİLDİ (beklenen test oyuncuları değil). ` +
        `Oda derhal bırakılıyor ve postcheck DURDURULUYOR.`);
    }
    wdMyB = wdPlayerB;
    ok(true, "B1 taze Hızlı Eşleş maçı kuruldu; rakip DOĞRULANDI (iki test hesabı)", wdRoomId.slice(0, 8));

    const { data: room } = await A.sb.from("wheel_duel_rooms")
      .select("status, room_source, current_target_topoid, started_at").eq("id", wdRoomId).maybeSingle();
    ok(room?.status === "playing" && room?.room_source === "quick_match",
       "B1 oda/oyuncu satırları kuruldu", `${room?.status}/${room?.room_source}`);

    // Geri sayım tamponu (started_at = now()+3s) geçsin.
    await sleep(4000);

    const targetNow = async () => {
      const { data: r } = await A.sb.from("wheel_duel_rooms")
        .select("current_target_topoid").eq("id", wdRoomId).maybeSingle();
      return (r?.current_target_topoid as string | null) ?? null;
    };
    /** Hedef yoksa: sunucunun geri bildirim penceresi (1200 ms) dolar dolmaz
     *  `wheel_duel_advance_if_due` ile SIRADAKİ hedefi getirt. Gerçek istemci
     *  de tam olarak bunu yapar (WheelDuelGame: FEEDBACK_MS + advance_if_due);
     *  bu çağrı olmadan claim tarafı asla test edilemez. */
    const ensureTarget = async (c: SupabaseClient, pid: string) => {
      let t = await targetNow();
      if (t) return t;
      await sleep(1500);
      await swallow(() => c.rpc("wheel_duel_advance_if_due", {
        p_room_id: wdRoomId, p_player_id: pid, p_claim_token: null,
        p_expected_target: null,
      }));
      t = await targetNow();
      return t;
    };
    const claim = async (c: SupabaseClient, pid: string) => {
      const t = await ensureTarget(c, pid);
      if (!t) return { skipped: true as const };
      const { data, error } = await c.rpc("wheel_duel_claim_target", {
        p_room_id: wdRoomId, p_player_id: pid, p_claim_token: null, p_target: t,
      });
      return { skipped: false as const, data, error, target: t };
    };
    const authOf = async (c: SupabaseClient, pid: string) => {
      const { data } = await c.rpc("wheel_duel_authorize_player", {
        p_player_id: pid, p_claim_token: null,
      });
      return data === true;
    };

    // ── B2: İKİ TARAF DA yetkili olmalı ────────────────────────────────
    // B (bekleyen) = kuyruk satırı olan taraf; A (çağıran) = eşleşmeyi
    // tetikleyen taraf. 20260827150000 öncesinde ÇAĞIRAN taraf sahipsizdi.
    const aAuth0 = await authOf(A.sb, wdMyA);
    const bAuth0 = await authOf(B.sb, wdMyB);
    ok(bAuth0, "B2 BEKLEYEN taraf yetkili", String(bAuth0));
    ok(aAuth0, "B2 ÇAĞIRAN taraf yetkili (20260827150000'in asıl düzeltmesi)", String(aAuth0));

    const c1 = await claim(A.sb, wdMyA);
    ok(!c1.skipped && !c1.error && c1.data?.claimed === true,
       "B2 ÇAĞIRAN taraf kendi hedefini KAPIYOR",
       c1.skipped ? "hedef yok" : `${errMsg(c1.error)}${JSON.stringify(c1.data)}`);

    await sleep(2500);
    const c1b = await claim(B.sb, wdMyB);
    ok(!c1b.skipped && !c1b.error && c1b.data?.claimed === true,
       "B2 BEKLEYEN taraf kendi hedefini KAPIYOR",
       c1b.skipped ? "hedef yok" : `${errMsg(c1b.error)}${JSON.stringify(c1b.data)}`);

    // ── B3: İKİ kuyruk satırı da sıfırlansın ───────────────────────────
    for (const c of [A, B]) {
      const { error: rErr } = await c.sb.rpc("wheel_duel_reset_quick_match", { p_profile_id: c.uid });
      ok(!rErr, `B3 reset_quick_match çalıştı (${c === A ? "çağıran" : "bekleyen"})`, errMsg(rErr));
    }
    const { data: qA } = await A.sb.from("wheel_duel_queue").select("player_id").eq("profile_id", A.uid).maybeSingle();
    const { data: qB } = await B.sb.from("wheel_duel_queue").select("player_id").eq("profile_id", B.uid).maybeSingle();
    ok(!qA && !qB, "B3 iki kuyruk satırı da SİLİNDİ", `A=${qA ? "var" : "yok"} B=${qB ? "var" : "yok"}`);

    // ── B4: kuyruk YOKKEN İKİ TARAF DA hâlâ yetkili ve claim atabiliyor ─
    ok(await authOf(A.sb, wdMyA), "B4 kuyruk silindikten sonra ÇAĞIRAN hâlâ yetkili");
    ok(await authOf(B.sb, wdMyB), "B4 kuyruk silindikten sonra BEKLEYEN hâlâ yetkili");
    await sleep(2500);
    const c2 = await claim(A.sb, wdMyA);
    ok(!c2.skipped && !c2.error && c2.data?.claimed === true,
       "B4 kuyruk YOKken ÇAĞIRAN claim atabiliyor (kalıcı sahiplik)",
       c2.skipped ? "hedef yok" : `${errMsg(c2.error)}${JSON.stringify(c2.data)}`);
    await sleep(2500);
    const c3 = await claim(B.sb, wdMyB);
    ok(!c3.skipped && !c3.error && c3.data?.claimed === true,
       "B4 kuyruk YOKken BEKLEYEN claim atabiliyor",
       c3.skipped ? "hedef yok" : `${errMsg(c3.error)}${JSON.stringify(c3.data)}`);

    // ── B5: FONKSİYON TABANLI tasarımın istemciden görülebilen sözleşmesi ─
    // 20260827150000 canlı gövdeyi `_wheel_duel_quick_match_core` adına taşır
    // ve aynı imzalı sarmalayıcıyı kurar. Çekirdek İSTEMCİYE KAPALI olmalı;
    // aksi hâlde istemci sarmalayıcıyı (ve sahiplik bağlamasını) atlayabilir.
    // ⚠ CANLI proacl'de PUBLIC EXECUTE vardı ({=X/postgres,...}); 150000 onu
    //   HEM çekirdekten HEM sarmalayıcıdan kaldırır. PUBLIC kalsaydı anon ve
    //   authenticated çekirdeği PUBLIC üzerinden çağırıp bağlamayı atlardı.
    //   Bu yüzden İKİ istemci rolü de ayrı ayrı denenir.
    const coreProbe = async (c: SupabaseClient, uid: string) =>
      c.rpc("_wheel_duel_quick_match_core", {
        p_profile_id: uid, p_player_id: uuid(), p_player_name: "x",
        p_duration: 60, p_region: "world", p_max_level_diff: 0,
        p_room_code: wheelCode(), p_first_target: "792",
      });
    for (const [label, cl, uid] of [
      ["authenticated", A.sb, A.uid], ["anon", anon, A.uid],
    ] as [string, SupabaseClient, string][]) {
      const { error: coreErr } = await coreProbe(cl, uid);
      ok(!!coreErr, `B5 çekirdek RPC ${label} rolüne KAPALI (sarmalayıcı atlanamaz)`,
         errMsg(coreErr) || "HATA YOK — ÇEKİRDEK AÇIK!");
      ok(!!coreErr && !/duplicate|room_code|already|invalid/i.test(errMsg(coreErr)),
         `B5 ${label} reddi YETKİ kaynaklı (fonksiyon hiç çalışmadı)`, errMsg(coreErr));
    }

    // Sarmalayıcı gerçekten kurulu mu? Davranışsal kanıt: 150000 olmadan
    // ÇAĞIRAN taraf sahipsiz kalırdı (B2/B4 zaten bunu ölçtü). Ek olarak
    // dönüş sözleşmesinin bozulmadığını doğrula.
    ok(typeof wdRoomId === "string" && wdRoomId.length > 10 && wdMyA.length > 10,
       "B5 matched yanıtı room_id + my_player_id taşıyor (istemci sözleşmesi aynı)");
  }

  /* ═══════════ C) P0 ÇAPRAZ KULLANICI SALDIRISI ═══════════ */
  section("C) P0 — A, B'nin player_id'siyle hiçbir şey yapamıyor (canlı)");
  {
    const { data: authz } = await A.sb.rpc("wheel_duel_authorize_player", {
      p_player_id: wdMyB, p_claim_token: null,
    });
    ok(authz === false, "C1 A, B'nin player_id'siyle authorize OLAMIYOR", String(authz));

    // Saldırı denemelerinden ÖNCE gerçek bir hedef olduğundan emin ol.
    // Sunucunun geri bildirim penceresi (wheel_duel_feedback_delay_ms, 1200 ms)
    // dolmadan advance_if_due REFILL yapmaz; bu yüzden önce beklenir.
    await sleep(1500);
    await swallow(() => B.sb.rpc("wheel_duel_advance_if_due", {
      p_room_id: wdRoomId, p_player_id: wdMyB, p_claim_token: null,
      p_expected_target: null,
    }));
    const { data: room } = await A.sb.from("wheel_duel_rooms")
      .select("current_target_topoid, status").eq("id", wdRoomId).maybeSingle();
    // Karşılaştırma AYNI TÜRDEN olmalı: hedef gerçekten yoksa null ile null
    // karşılaştırılır; saldırı denemesi için yine de bir hedef metni gerekir.
    const targetBefore = (room?.current_target_topoid as string | null) ?? null;
    const target = targetBefore ?? "792";

    const { error: ce } = await A.sb.rpc("wheel_duel_claim_target", {
      p_room_id: wdRoomId, p_player_id: wdMyB, p_claim_token: null, p_target: target,
    });
    ok(!!ce && /unauthorized|42501/i.test(errMsg(ce)),
       "C2 A, B adına claim_target ATAMIYOR (unauthorized)", errMsg(ce));

    const { error: le } = await A.sb.rpc("wheel_duel_leave_room", {
      p_room_id: wdRoomId, p_player_id: wdMyB, p_claim_token: null,
    });
    ok(!!le && /unauthorized|42501/i.test(errMsg(le)),
       "C3 A, B adına leave_room/forfeit ÇAĞIRAMIYOR (unauthorized)", errMsg(le));

    const { data: after } = await A.sb.rpc("wheel_duel_authorize_player", {
      p_player_id: wdMyB, p_claim_token: null,
    });
    const { data: roomAfter } = await A.sb.from("wheel_duel_rooms")
      .select("status, current_target_topoid").eq("id", wdRoomId).maybeSingle();
    ok(after === false, "C4 tekrar denendiğinde de yetki YOK");
    ok(roomAfter?.status === "playing", "C4 B'nin odası HÂLÂ 'playing'", String(roomAfter?.status));
    ok((roomAfter?.current_target_topoid ?? null) === targetBefore,
       "C4 B'nin hedefi DEĞİŞMEDİ",
       `${targetBefore ?? "yok"} -> ${roomAfter?.current_target_topoid ?? "yok"}`);

    // C5 — A, B'nin player_id'siyle KUYRUĞA girip sahiplik üretmeyi dener.
    const { error: qe } = await A.sb.rpc("wheel_duel_quick_match", {
      p_profile_id: A.uid, p_player_id: wdMyB, p_player_name: "darsar",
      p_duration: 60, p_region: "world", p_max_level_diff: 0,
      p_room_code: wheelCode(), p_first_target: "792",
    });
    created.queueProfiles.add(A.uid);
    const { data: authz2 } = await A.sb.rpc("wheel_duel_authorize_player", {
      p_player_id: wdMyB, p_claim_token: null,
    });
    ok(authz2 === false,
       "C5 A, B'nin player_id'siyle kuyruğa girse bile SAHİPLİK/YETKİ ALAMIYOR",
       `enqueue=${qe ? "reddedildi" : "kabul"} authorize=${authz2}`);
    // Saldırı satırı KUYRUKTA BIRAKILMAZ: içinde ZATEN VAR OLAN bir player_id
    // taşıdığı için, onunla eşleşen bir sonraki arama `wheel_duel_players`
    // primary-key ihlaline çarpar (çekirdeğin kendi koruması). Bu, D bölümünü
    // testin kendi artığıyla düşürürdü.
    await A.sb.rpc("wheel_duel_reset_quick_match", { p_profile_id: A.uid });
    const { data: qLeft } = await A.sb.from("wheel_duel_queue")
      .select("profile_id").eq("profile_id", A.uid).maybeSingle();
    ok(!qLeft, "C5 saldırı kuyruk satırı temizlendi (sonraki testler kirlenmesin)");

    // C6 — SİMETRİ: B de A adına hiçbir şey yapamaz.
    const { data: bAsA } = await B.sb.rpc("wheel_duel_authorize_player", {
      p_player_id: wdMyA, p_claim_token: null,
    });
    ok(bAsA === false, "C6 B, A'nın player_id'siyle authorize OLAMIYOR", String(bAsA));

    const { error: xe } = await B.sb.rpc("wheel_duel_claim_target", {
      p_room_id: wdRoomId, p_player_id: wdMyA, p_claim_token: null, p_target: target,
    });
    ok(!!xe && /unauthorized|42501/i.test(errMsg(xe)),
       "C6 B de A'nın player_id'siyle claim ATAMIYOR (simetrik)", errMsg(xe));

    const { error: leA } = await B.sb.rpc("wheel_duel_leave_room", {
      p_room_id: wdRoomId, p_player_id: wdMyA, p_claim_token: null,
    });
    ok(!!leA && /unauthorized|42501/i.test(errMsg(leA)),
       "C6 B, A adına leave_room/forfeit ÇAĞIRAMIYOR (simetrik)", errMsg(leA));

    // ÇAPRAZ ODA: geçerli oyuncu, ÜYESİ OLMADIĞI oda. (Rota süiti atlandıysa
    // var olmayan bir oda id'si kullanılır — üyelik kapısı yine devrede.)
    const crossRoom = created.routeRooms[0]?.id ?? uuid();
    const { error: xr } = await A.sb.rpc("wheel_duel_claim_target", {
      p_room_id: crossRoom, p_player_id: wdMyA, p_claim_token: null, p_target: target,
    });
    ok(!!xr, "C6 ÇAPRAZ ODA reddedildi (oda üyeliği zorunlu)", errMsg(xr));

    // Her iki tarafın MEŞRU yetkisi bozulmadı.
    const { data: bAuth } = await B.sb.rpc("wheel_duel_authorize_player", {
      p_player_id: wdMyB, p_claim_token: null,
    });
    ok(bAuth === true, "C7 B'nin KENDİ meşru yetkisi çalışmaya devam ediyor", String(bAuth));
    const { data: aAuth } = await A.sb.rpc("wheel_duel_authorize_player", {
      p_player_id: wdMyA, p_claim_token: null,
    });
    ok(aAuth === true, "C7 A'nın KENDİ meşru yetkisi çalışmaya devam ediyor", String(aAuth));

    const { data: roomC6 } = await A.sb.from("wheel_duel_rooms")
      .select("status").eq("id", wdRoomId).maybeSingle();
    ok(roomC6?.status === "playing",
       "C7 reddedilen saldırılardan sonra oda HÂLÂ 'playing'", String(roomC6?.status));
  }

  /* ═══════════ D) BAYAT MAÇ ═══════════ */
  section("D) Bayat maç — bitmiş oda yeni aramayı kirletemiyor (canlı)");
  {
    // Çark maçını bitir: B kendi maçından çıkar (meşru forfeit).
    const { error: lb } = await B.sb.rpc("wheel_duel_leave_room", {
      p_room_id: wdRoomId, p_player_id: wdMyB, p_claim_token: null,
    });
    ok(!lb, "D1 B kendi Çark maçından meşru şekilde çıktı", errMsg(lb));

    const { data: qB } = await B.sb.from("wheel_duel_queue")
      .select("matched_room_id").eq("profile_id", B.uid).maybeSingle();
    ok(true, "D2 bitmiş maçtan sonra B'nin kuyruk satırı",
       qB ? `matched_room_id=${qB.matched_room_id ? "DOLU (bayat işaretçi)" : "null"}` : "satır yok");

    // Reset → yeni arama TAZE olmalı.
    await B.sb.rpc("wheel_duel_reset_quick_match", { p_profile_id: B.uid });
    const { data: qB2 } = await B.sb.from("wheel_duel_queue")
      .select("matched_room_id").eq("profile_id", B.uid).maybeSingle();
    ok(!qB2, "D3 reset sonrası bayat kuyruk satırı YOK", qB2 ? "hâlâ var" : "temiz");

    const freshPid = uuid();
    const { data: fresh, error: fe } = await B.sb.rpc("wheel_duel_quick_match", {
      p_profile_id: B.uid, p_player_id: freshPid, p_player_name: "safis",
      p_duration: 60, p_region: "world", p_max_level_diff: 0,
      p_room_code: wheelCode(), p_first_target: "792",
    });
    created.queueProfiles.add(B.uid);
    ok(!fe && fresh?.matched === false,
       "D4 yeni Hızlı Eşleş TAZE arama başlattı — eski bitmiş oda GERİ DÖNMEDİ",
       `${errMsg(fe)}${JSON.stringify(fresh)}`);
    if (fresh?.matched && fresh?.room_id === wdRoomId) {
      ok(false, "D4 ESKİ ODA GERİ DÖNDÜ — bayat maç yeniden açıldı", wdRoomId);
    }
    await B.sb.rpc("wheel_duel_cancel_quick_match", { p_profile_id: B.uid });

    // Rota tarafı: reset RPC kapsamı + taze arama.
    await A.sb.rpc("route_duel_reset_quick_match", { p_profile_id: A.uid });
    const rPid = uuid();
    const { data: rq, error: rqe } = await A.sb.rpc("route_duel_quick_match", {
      p_profile_id: A.uid, p_player_id: rPid, p_player_name: "darsar",
      p_claim_token: uuid(), p_total_rounds: 3, p_route_length: "5",
      p_max_level_diff: 0, p_room_code: `B10-RD-${stamp}Q`,
    });
    created.queueProfiles.add(A.uid);
    ok(!rqe && rq?.matched === false,
       "D5 Rota: reset sonrası yeni arama TAZE (eski oda dönmedi)",
       `${errMsg(rqe)}${JSON.stringify(rq)}`);
    await A.sb.rpc("route_duel_cancel_quick_match", { p_profile_id: A.uid });
    const { data: rrow } = await A.sb.from("route_duel_queue")
      .select("matched_room_id").eq("profile_id", A.uid).maybeSingle();
    ok(!rrow, "D5 Rota kuyruk satırı temizlendi", rrow ? "hâlâ var" : "temiz");
  }

  /* ═══════════ E) OWNERS TABLOSU — İSTEMCİ ERİŞİMİ ═══════════ */
  section("E) owners tablosu istemci rollerine KAPALI (canlı)");
  {
    const probes: [string, SupabaseClient][] = [["anon", anon], ["authenticated", A.sb]];
    for (const [role, c] of probes) {
      const { data: sel, error: se } = await c.from("wheel_duel_quick_match_owners").select("player_id").limit(1);
      ok(!!se || (sel ?? []).length === 0,
         `E ${role}: SELECT engellendi/boş`, se ? errMsg(se) : `${(sel ?? []).length} satır`);
      const { error: ie } = await c.from("wheel_duel_quick_match_owners")
        .insert({ player_id: uuid(), profile_id: A.uid });
      ok(!!ie, `E ${role}: INSERT engellendi`, errMsg(ie));
      const { error: ue } = await c.from("wheel_duel_quick_match_owners")
        .update({ profile_id: A.uid }).eq("player_id", wdMyB);
      ok(!!ue, `E ${role}: UPDATE engellendi`, errMsg(ue));
      const { error: de } = await c.from("wheel_duel_quick_match_owners")
        .delete().eq("player_id", wdMyB);
      ok(!!de, `E ${role}: DELETE engellendi`, errMsg(de));
    }
    ok(true, "E meşru sahiplik üretimi B2/B4'te DAVRANIŞSAL olarak kanıtlandı " +
             "(tablo tasarım gereği istemciye okunmaz)");
  }

  /* ═══════════ F) TEMİZLİK + XP/GOLD ═══════════ */
  section("F) Temizlik + XP/Gold");
  await cleanup();

  const afterA = await prof(A), afterB = await prof(B);
  ok(afterA?.xp === beforeA?.xp && afterA?.gold === beforeA?.gold,
     "F A hesabında beklenmeyen XP/Gold yazımı YOK",
     `xp ${beforeA?.xp}->${afterA?.xp}, gold ${beforeA?.gold}->${afterA?.gold}`);
  ok(afterB?.xp === beforeB?.xp && afterB?.gold === beforeB?.gold,
     "F B hesabında beklenmeyen XP/Gold yazımı YOK",
     `xp ${beforeB?.xp}->${afterB?.xp}, gold ${beforeB?.gold}->${afterB?.gold}`);
}

/** Yalnız BU çalıştırmanın kurduğu nesnelere dokunur. */
async function cleanup() {
  let queueLeft = 0, roomsLeft = 0;
  for (const uid of created.queueProfiles) {
    const c = uid === A.uid ? A : B;
    await swallow(() => c.sb.rpc("wheel_duel_reset_quick_match", { p_profile_id: uid }));
    await swallow(() => c.sb.rpc("route_duel_reset_quick_match", { p_profile_id: uid }));
    const { data: w } = await c.sb.from("wheel_duel_queue").select("profile_id").eq("profile_id", uid).maybeSingle();
    const { data: r } = await c.sb.from("route_duel_queue").select("profile_id").eq("profile_id", uid).maybeSingle();
    if (w) queueLeft++;
    if (r) queueLeft++;
  }
  ok(queueLeft === 0, "F kuyruk artığı = 0", String(queueLeft));

  // ARTIK SINIFLANDIRMASI:
  //   AKSİYON GEREKTİREN = hâlâ 'waiting'/'playing' olan tek kullanımlık oda
  //                        (canlı oyun durumu bırakmış oluruz → HATA)
  //   BEKLENEN TARİHÇE    = 'finished' oda. `*_leave_room` bitmiş odada
  //                        bilerek no-op'tur; ürün tamamlanmış maçları saklar.
  const history: string[] = [];
  const stuck: string[] = [];
  const sweep = async (
    kind: "wheel" | "route",
    rooms: { id: string; code: string }[],
  ) => {
    for (const room of rooms) {
      const { data: ps } = await A.sb.from(`${kind}_duel_players`).select("id").eq("room_id", room.id);
      for (const p of ps ?? []) {
        for (const c of [A, B]) {
          await swallow(() => c.sb.rpc(`${kind}_duel_leave_room`,
            { p_room_id: room.id, p_player_id: p.id, p_claim_token: null }));
        }
      }
      const { data: still } = await A.sb.from(`${kind}_duel_rooms`)
        .select("id, status").eq("id", room.id).maybeSingle();
      const label = `${kind === "wheel" ? "çark" : "rota"} ${room.code}`;
      if (!still) { console.log(`     ${label}: SİLİNDİ`); continue; }
      roomsLeft++;
      if (still.status === "finished") { history.push(`${label}(finished)`); }
      else { stuck.push(`${label}(${still.status})`); }
      console.log(`     ${label}: kaldı (status=${still.status})`);
    }
  };
  await sweep("wheel", created.wheelRooms);
  await sweep("route", created.routeRooms);

  ok(stuck.length === 0,
     "F AKSİYON GEREKTİREN artık = 0 (aktif/bekleyen tek kullanımlık oda yok)",
     stuck.join(", ") || "yok");
  ok(true, "F beklenen TARİHÇE (bitmiş oda; leave_room bilerek no-op)",
     history.join(", ") || "yok");
}

main()
  .catch(async e => {
    failed++;
    console.error(`\n✗✗ DURDURULDU: ${e instanceof Error ? e.message : String(e)}`);
    try { await cleanup(); } catch { /* temizlik de başarısız */ }
  })
  .finally(async () => {
    for (const c of [A, B]) { try { await c?.sb.auth.signOut(); } catch { /* yoksay */ } }
    console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı`);
    process.exit(failed === 0 ? 0 : 1);
  });
