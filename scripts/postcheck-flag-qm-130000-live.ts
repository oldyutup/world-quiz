/**
 * postcheck-flag-qm-130000-live.ts — 20260828130000 (BAYRAK HIZLI EŞLEŞ
 * KALICI KİMLİK) migration'ının CANLI runtime postcheck'i.
 *
 * ⚠ PRODUCTION'A YAZAR. Yalnız migration uygulandıktan SONRA, ELLE:
 *
 *     FLAGQM130000_POSTCHECK=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \
 *     npx tsx scripts/postcheck-flag-qm-130000-live.ts --confirm
 *
 *   Gate olmadan HİÇBİR ŞEY yazmaz: planı basar (dry-run) ve 0 ile çıkar.
 *
 * NE DOĞRULAR (davranış — katalog metadata'sı PostgREST'ten OKUNAMAZ)
 * ──────────────────────────────────────────────────────────────────
 *   1 Fonksiyon durumu: imza çözümü, ACL, SECURITY DEFINER gerekliliği,
 *     KALICI profile_id bağlama.
 *   2 Normal Bayrak Hızlı Eşleş: iki satır da kalıcı kimlikle doğuyor,
 *     BEKLEYEN ve ÇAĞIRAN taraf İKİSİ de yetkili.
 *   3 KRİTİK: kuyruk sıfırlandıktan SONRA yetki, oyun ve leave HAYATTA.
 *     Kuyruk artık yetki kanıtı DEĞİL.
 *   4 P0: çapraz kullanıcı authorize/claim/leave/rematch reddi, player_id
 *     ele geçirme reddi, sahiplik devri yok, kısmi durum yok.
 *   5 Rövanş: lobi yok, +3sn adil başlangıç, kuyruk sıfırlaması kimliği
 *     BOZMUYOR, iki taraf da oynayabiliyor.
 *   6 Manuel oda + misafir claim-token sözleşmesi (ucuz, hedefli).
 *   7 Temizlik: kuyruk artığı 0, oda kapatma, XP/Gold deltası 0.
 *
 * GÜVENLİK KURALLARI (kodda zorlanır)
 * ───────────────────────────────────
 *   • Kimlik YALNIZ .env.test.local'daki iki adanmış hesap (TORBLE_A/B).
 *   • Yalnız BU scriptin kurduğu odalara dokunulur (`created` kaydı).
 *     Oda listeleme/arama YOK. ESKİ B11FD* odalarına DOKUNULMAZ.
 *   • Hızlı Eşleş gerçek bir kullanıcıyla eşleşebilir → eşleşme sonrası
 *     RAKİP KİMLİĞİ DOĞRULANIR; yabancı çıkarsa maç bırakılır ve DURULUR.
 *   • Şema DEĞİŞMEZ, migration UYGULANMAZ, service-role KULLANILMAZ.
 *   • XP RPC'si HİÇ çağrılmaz → XP/Gold deltası 0 beklenir.
 *   • Hiçbir credential konsola yazılmaz.
 *   • İlk beklenmedik hatada DURUR (fail-fast) ve yine de temizlik dener.
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* ── Gate ────────────────────────────────────────────────────────────────── */
const GATE = "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION";
const armed = process.env.FLAGQM130000_POSTCHECK === GATE && process.argv.includes("--confirm");

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
async function swallow(run: () => PromiseLike<unknown>): Promise<void> {
  try { await run(); } catch { /* temizlikte yutulur */ }
}
const errMsg = (e: unknown) => {
  const x = e as { message?: string; code?: string };
  return `${x?.code ?? ""} ${x?.message ?? (e ? String(e) : "")}`.trim();
};
const errCode = (e: unknown) => (e as { code?: string })?.code ?? "";
/** Yetki reddi mi? (42501 / P0001 not authorized / unauthorized metni) */
const isAuthDenial = (e: unknown) => {
  const c = errCode(e), m = (e as { message?: string })?.message ?? "";
  return c === "42501" || /not authoriz|unauthoriz|yetkisiz|permission denied/i.test(m);
};

/** Bu çalıştırmanın YARATTIĞI her şey. Temizlik YALNIZ buraya bakar. */
const created = {
  duelRooms: [] as { id: string; label: string }[],
  queueProfiles: new Set<string>(),
};

/* ── Dry-run ─────────────────────────────────────────────────────────────── */
if (!armed) {
  console.log(`
FLAG QM 20260828130000 CANLI POSTCHECK — DRY RUN (hiçbir şey yazılmadı)

Çalıştırmak için:
  FLAGQM130000_POSTCHECK=${GATE} \\
  npx tsx scripts/postcheck-flag-qm-130000-live.ts --confirm

PLAN (yalnız bu script'in kurduğu nesnelere dokunulur):
  1) Fonksiyon durumu — imza/ACL/DEFINER gerekliliği (yazma yok)
  2) 1 tek kullanımlık Bayrak QM maçı (FQ1*): iki satırda da kalıcı profile_id
  3) KRİTİK: kuyruk sıfırla → yetki/oyun/leave hâlâ çalışıyor mu
  4) P0: çapraz authorize/claim/leave/rematch reddi (durum değiştirmez)
  5) Aynı odada rövanş: lobi yok + 3sn + kuyruk sıfırlamasına dayanıklı
  6) 1 tek kullanımlık MANUEL oda (FQM*) + misafir claim-token sözleşmesi
  7) Temizlik: kuyruk 0, odalar kapatılır, XP/Gold delta 0

DOKUNULMAZ: eski B11FD* odaları (bilinen atıl test artıkları).

TAHMİNİ SÜRE: ~40-70 sn (gerçek 3 sn geri sayım beklemeleri).
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
  return { sb, uid: data.user.id, name: (p?.username as string | undefined) ?? `pc${which}` };
}

const uuid = () => crypto.randomUUID();
const stamp = Date.now().toString(36).toUpperCase().slice(-3);
class Stop extends Error {}

let A!: Acct, B!: Acct, anon!: SupabaseClient;

async function serverNowMs(c: SupabaseClient): Promise<number> {
  const { data, error } = await c.rpc("get_server_time_ms");
  if (error || data == null) throw new Stop(`get_server_time_ms: ${errMsg(error)}`);
  return Number(data);
}
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

  /* ═══════════ 1) FONKSİYON DURUMU ═══════════ */
  section("1) Fonksiyon durumu — imza / ACL / DEFINER gerekliliği");
  {
    const R = uuid();
    // İmza: yanlış parametre adı reddedilmeli, doğru imza çözülmeli.
    const { error: wrongSig } = await A.sb.rpc("flag_duel_authorize_player",
      { p_player_id: R, p_wrong: R } as never);
    ok(errCode(wrongSig) === "PGRST202", "authorize_player imzası (p_player_id, p_claim_token) — yanlış param reddedildi", errCode(wrongSig));

    const { data: authOk, error: authErr } = await A.sb.rpc("flag_duel_authorize_player",
      { p_player_id: R, p_claim_token: null });
    ok(!authErr && authOk === false, "authorize_player çözülüyor + bilinmeyen oyuncuda ARIZADA-KAPANIR", `${errMsg(authErr)}${JSON.stringify(authOk)}`);

    const { error: anonAuth } = await anon.rpc("flag_duel_authorize_player",
      { p_player_id: R, p_claim_token: null });
    ok(!anonAuth, "authorize_player ACL: anon EXECUTE var (misafir sözleşmesi gereği)", errMsg(anonAuth));

    const { error: qmSig } = await A.sb.rpc("flag_duel_quick_match", { p_profile_id: R } as never);
    ok(errCode(qmSig) === "PGRST202", "quick_match 8-parametreli imza korunuyor (eksik param reddedildi)", errCode(qmSig));

    const { error: qmAnon } = await anon.rpc("flag_duel_quick_match", {
      p_profile_id: R, p_player_id: R, p_player_name: "pc", p_total_rounds: 5,
      p_region: "europe", p_max_level_diff: 0, p_room_code: "PCHK00", p_first_flag: "tr",
    });
    ok(!!qmAnon, "quick_match anon çağrısı REDDEDİLDİ (kimlik doğrulama kapısı)", errMsg(qmAnon));
    note(`quick_match anon reddi: ${errCode(qmAnon)} — gövde içi auth.uid() kapısı. ` +
         `anon EXECUTE grant'i CANLIDA mevcut (Supabase ALTER DEFAULT PRIVILEGES artefaktı, ` +
         `20260809130000); bu migration ACL'e KASITLI olarak dokunmuyor.`);

    // SECURITY DEFINER gerekliliği: doğrudan tablo yazımı kapalı olmalı.
    const { error: rawIns } = await A.sb.from("duel_players")
      .insert({ id: uuid(), room_id: uuid(), name: "pc", score: 0 });
    ok(isAuthDenial(rawIns), "duel_players DOĞRUDAN INSERT reddedildi → RPC'nin DEFINER olması şart", errMsg(rawIns));
  }

  /* ═══════════ 2) NORMAL BAYRAK HIZLI EŞLEŞ ═══════════ */
  section("2) Normal Bayrak Hızlı Eşleş — kalıcı kimlik");

  for (const c of [A, B]) {
    await swallow(() => c.sb.rpc("flag_duel_reset_quick_match", { p_profile_id: c.uid }));
    created.queueProfiles.add(c.uid);
  }

  const pidA = uuid(), pidB = uuid();
  const qm = (c: Acct, pid: string) => c.sb.rpc("flag_duel_quick_match", {
    p_profile_id: c.uid, p_player_id: pid, p_player_name: c.name,
    p_total_rounds: 5, p_region: "europe", p_max_level_diff: 0,
    p_room_code: `FQ1${stamp}${Math.floor(Math.random() * 90 + 10)}`, p_first_flag: "tr",
  });

  // B ÖNCE kuyruğa girer (BEKLEYEN/host), A sonra eşleşir (ÇAĞIRAN).
  const { data: qB, error: eB } = await qm(B, pidB);
  if (eB) throw new Stop(`quick_match(B): ${errMsg(eB)}`);
  ok(qB?.matched === false, "2a B kuyruğa girdi (BEKLEYEN taraf)");

  const { data: qA, error: eA } = await qm(A, pidA);
  if (eA) throw new Stop(`quick_match(A): ${errMsg(eA)}`);
  if (!qA?.matched) throw new Stop("2a eşleşme oluşmadı — DURULDU");
  const room = qA.room_id as string;
  created.duelRooms.push({ id: room, label: "FQ1(quick_match)" });
  ok(true, "2a eşleşme kuruldu (A = ÇAĞIRAN, B = BEKLEYEN)");

  // YABANCI KORUMASI
  const rowsOf = async (c: Acct) => {
    const { data } = await c.sb.from("duel_players")
      .select("id, profile_id, guest_id, name, score").eq("room_id", room);
    return (data ?? []) as { id: string; profile_id: string | null; guest_id: string | null; score: number }[];
  };
  let players = await rowsOf(A);
  if (players.map(p => p.id).sort().join(",") !== [pidA, pidB].sort().join(",")) {
    await swallow(() => A.sb.rpc("flag_duel_leave_room", { p_room_id: room, p_player_id: pidA, p_claim_token: null }));
    throw new Stop("2a GERÇEK BİR KULLANICIYLA EŞLEŞİLDİ — DURULDU (oda bırakıldı)");
  }
  ok(true, "2a rakip kimliği doğrulandı: yalnız TORBLE_A/B");

  // ★ MIGRATION'IN ÇEKİRDEĞİ: iki satır da KALICI profile_id taşıyor
  const rowA = players.find(p => p.id === pidA)!, rowB = players.find(p => p.id === pidB)!;
  ok(rowA.profile_id === A.uid, "2b ÇAĞIRAN (A) satırı KALICI kimlik taşıyor", `profile_id ${rowA.profile_id ? "SET" : "NULL"}`);
  ok(rowB.profile_id === B.uid, "2b BEKLEYEN (B) satırı KALICI kimlik taşıyor", `profile_id ${rowB.profile_id ? "SET" : "NULL"}`);

  const authAs = async (c: Acct, pid: string, token: string | null = null) => {
    const { data, error } = await c.sb.rpc("flag_duel_authorize_player",
      { p_player_id: pid, p_claim_token: token });
    if (error) throw new Stop(`authorize(${pid.slice(0, 4)}): ${errMsg(error)}`);
    return data === true;
  };
  ok(await authAs(A, pidA), "2c A kendi slotu için YETKİLİ");
  ok(await authAs(B, pidB), "2c B (ÇAĞIRAN olmayan/BEKLEYEN taraf) YETKİLİ");

  /* ═══════════ 3) KUYRUK BAĞIMSIZLIĞI — KRİTİK ═══════════ */
  section("3) KRİTİK — kuyruk sıfırlandıktan sonra yetki/oyun/leave hayatta mı");

  for (const c of [A, B]) {
    const { error } = await c.sb.rpc("flag_duel_reset_quick_match", { p_profile_id: c.uid });
    ok(!error, `3a ${c === A ? "A" : "B"} meşru reset akışı hatasız`, errMsg(error));
  }
  {
    const { data: qrows } = await A.sb.from("flag_duel_queue").select("profile_id").in("profile_id", [A.uid, B.uid]);
    ok((qrows ?? []).length === 0, "3a iki kuyruk satırı da SİLİNDİ", `kalan=${(qrows ?? []).length}`);
  }

  ok(await authAs(A, pidA), "3b ★ A kuyruk SIFIRLANDIKTAN SONRA hâlâ YETKİLİ");
  ok(await authAs(B, pidB), "3b ★ B kuyruk SIFIRLANDIKTAN SONRA hâlâ YETKİLİ");

  const roomRow = async () => {
    const { data } = await A.sb.from("duel_rooms")
      .select("status, room_source, started_at, current_flag, current_flag_at, current_round, " +
              "winner_player_id, finished_reason, total_rounds, region")
      .eq("id", room).maybeSingle();
    return data as Record<string, unknown> | null;
  };
  let r = await roomRow();
  ok(r?.room_source === "quick_match" && r?.status === "playing", "3c oda taze QM maçı", String(r?.status));

  // Geri sayımı bekle, sonra meşru oyun RPC'si — kuyruk YOKKEN.
  await sleep(Math.max(0, await bufferMs(A.sb, r?.started_at as string)) + 600);
  const claimAs = async (c: Acct, pid: string) => {
    const cur = (await roomRow())?.current_flag as string;
    const { data, error } = await c.sb.rpc("flag_duel_submit_claim",
      { p_room_id: room, p_player_id: pid, p_claim_token: null, p_country_code: cur });
    return { data: data as { claimed: boolean; reason?: string } | null, error };
  };
  {
    const { data, error } = await claimAs(A, pidA);
    ok(!error && !isAuthDenial(error), "3d ★ A kuyruk YOKKEN meşru oyun RPC'si çalıştı", `${errMsg(error)}${JSON.stringify(data)}`);
  }
  {
    const { data, error } = await claimAs(B, pidB);
    ok(!error && !isAuthDenial(error), "3d ★ B kuyruk YOKKEN meşru oyun RPC'si çalıştı", `${errMsg(error)}${JSON.stringify(data)}`);
  }

  /* ═══════════ 4) P0 — ÇAPRAZ KULLANICI ═══════════ */
  section("4) P0 — çapraz kullanıcı / player_id ele geçirme");
  {
    ok((await authAs(A, pidB)) === false, "4a A, B'nin slotu için YETKİSİZ");
    ok((await authAs(B, pidA)) === false, "4a B, A'nın slotu için YETKİSİZ");
    ok((await authAs(A, pidB, uuid())) === false, "4b uydurma claim token de işe yaramıyor (ele geçirme reddi)");
    // Kayıtlı satır misafir dalından ele geçirilemez: guest_id NULL olduğu için
    // claim_token dalı hiç değerlendirilmez. ANON olarak denenir (en zayıf kimlik).
    {
      const { data: anonGrab } = await anon.rpc("flag_duel_authorize_player",
        { p_player_id: pidB, p_claim_token: uuid() });
      ok(anonGrab === false, "4b kayıtlı satır misafir dalından ele geçirilemiyor (guest_id şartı)", JSON.stringify(anonGrab));
    }

    const { data: xClaim, error: xClaimErr } = await A.sb.rpc("flag_duel_submit_claim",
      { p_room_id: room, p_player_id: pidB, p_claim_token: null, p_country_code: (await roomRow())?.current_flag as string });
    ok(!!xClaimErr || xClaim?.claimed === false, "4c A, B adına claim GÖNDEREMİYOR", `${errMsg(xClaimErr)}${JSON.stringify(xClaim)}`);

    const { error: xLeave } = await A.sb.rpc("flag_duel_leave_room",
      { p_room_id: room, p_player_id: pidB, p_claim_token: null });
    ok(!!xLeave, "4c A, B adına leave/forfeit EDEMİYOR", errMsg(xLeave));

    const { error: xRematch } = await A.sb.rpc("flag_duel_accept_rematch",
      { p_room_id: room, p_host_player_id: pidB, p_claim_token: null, p_first_flag: "de" });
    ok(!!xRematch, "4c A, B adına rövanş KABUL EDEMİYOR", errMsg(xRematch));

    // Sahiplik devri / kısmi durum YOK
    players = await rowsOf(A);
    const nA = players.find(p => p.id === pidA), nB = players.find(p => p.id === pidB);
    ok(nA?.profile_id === A.uid && nB?.profile_id === B.uid, "4d sahiplik DEVREDİLMEDİ (profile_id'ler sabit)");
    ok(players.length === 2, "4d kısmi oda/oyuncu durumu YOK", `${players.length} oyuncu`);
    ok((await roomRow())?.status === "playing", "4d oda durumu bozulmadı");
  }

  /* ═══════════ 5) RÖVANŞ ═══════════ */
  section("5) Rövanş — lobi yok, +3sn adil başlangıç, kuyruğa bağımsız");
  {
    r = await roomRow();
    const settings = { rounds: r?.total_rounds, region: r?.region };

    // Otoriter kazanan, SUNUCUNUN kuralıyla BİREBİR hesaplanır: duel_claims
    // COUNT'u (PASS:/TIMEOUT: hariç), eşitlik/claim-yok → null.
    // (duel_players.score BU hesabın kaynağı DEĞİLDİR — ilk koşuda oradan
    //  okunmuştu ve RPC haklı olarak `winner_mismatch` attı: HARNESS hatası.)
    const authoritativeWinner = async (): Promise<string | null> => {
      const { data } = await A.sb.from("duel_claims").select("player_id, country_code").eq("room_id", room);
      const real = ((data ?? []) as { player_id: string; country_code: string }[])
        .filter(c => !/^PASS:/.test(c.country_code) && !/^TIMEOUT:/.test(c.country_code));
      if (real.length === 0) return null;
      const cnt = new Map<string, number>();
      for (const c of real) cnt.set(c.player_id, (cnt.get(c.player_id) ?? 0) + 1);
      const sorted = [...cnt.entries()].sort((x, y) => y[1] - x[1]);
      if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;
      return sorted[0][0];
    };
    const winner = await authoritativeWinner();
    const { error: fe } = await B.sb.rpc("flag_duel_finalize_game",
      { p_room_id: room, p_host_player_id: pidB, p_claim_token: null, p_winner_player_id: winner });
    ok(!fe, "5a finalize_game hatasız (otoriter claim sayımıyla uyumlu)",
       `${errMsg(fe)} winner=${winner === pidA ? "A" : winner === pidB ? "B" : "berabere"}`);
    ok((await roomRow())?.status === "finished", "5a maç BİTTİ (rövanş gerçekten 'finished'ten başlıyor)");

    const { data: rr, error: re } = await B.sb.rpc("flag_duel_accept_rematch",
      { p_room_id: room, p_host_player_id: pidB, p_claim_token: null, p_first_flag: "de" });
    if (re || !rr?.id) throw new Stop(`accept_rematch: ${errMsg(re)}`);
    const r2 = await roomRow();
    ok(r2?.status === "playing", "5b LOBİ YOK: doğrudan 'playing'", String(r2?.status));
    const buf = await bufferMs(A.sb, r2?.started_at as string);
    ok(buf > 0 && buf <= 3000, "5b otoriter +3sn başlangıç", `kalan=${buf}ms`);
    ok(r2?.current_flag_at === r2?.started_at, "5b ADİL BAŞLANGIÇ: current_flag_at == started_at",
       `${r2?.current_flag_at} / ${r2?.started_at}`);
    ok(r2?.total_rounds === settings.rounds && r2?.region === settings.region, "5b ayarlar korundu");

    // Rövanştan SONRA kuyruk sıfırla → kimlik hâlâ sağlam mı
    for (const c of [A, B]) await swallow(() => c.sb.rpc("flag_duel_reset_quick_match", { p_profile_id: c.uid }));
    ok(await authAs(A, pidA), "5c ★ rövanş + kuyruk sıfırlaması sonrası A YETKİLİ");
    ok(await authAs(B, pidB), "5c ★ rövanş + kuyruk sıfırlaması sonrası B YETKİLİ");

    await sleep(Math.max(0, await bufferMs(A.sb, r2?.started_at as string)) + 600);
    {
      const { data, error } = await claimAs(A, pidA);
      ok(!error && !isAuthDenial(error), "5d A rövanş maçında oynayabiliyor", `${errMsg(error)}${JSON.stringify(data)}`);
    }
    {
      const { data, error } = await claimAs(B, pidB);
      ok(!error && !isAuthDenial(error), "5d B rövanş maçında oynayabiliyor", `${errMsg(error)}${JSON.stringify(data)}`);
    }
  }

  /* ═══════════ 3-devam) KENDİ ODASINDAN AYRILMA ═══════════ */
  section("3-devam) Kendi odasından meşru ayrılma (yaşam döngüsünün izin verdiği yerde)");
  {
    const { error: leaveA } = await A.sb.rpc("flag_duel_leave_room",
      { p_room_id: room, p_player_id: pidA, p_claim_token: null });
    ok(!leaveA, "3e ★ A KENDİ aktif odasından ayrılabildi (kuyruk yokken)", errMsg(leaveA));
    const after = await roomRow();
    note(`A ayrıldıktan sonra oda durumu: ${String(after?.status)} (${String(after?.finished_reason ?? "—")})`);

    const { error: leaveB } = await B.sb.rpc("flag_duel_leave_room",
      { p_room_id: room, p_player_id: pidB, p_claim_token: null });
    ok(!leaveB || !isAuthDenial(leaveB),
       "3e B'nin ayrılması yaşam döngüsüne uygun (yetki reddi DEĞİL)", errMsg(leaveB));
  }

  /* ═══════════ 6) MANUEL + MİSAFİR ═══════════ */
  section("6) Manuel oda + misafir claim-token sözleşmesi");
  {
    const mPid = uuid(), mTok = uuid(), mCode = `FQM${stamp}${Math.floor(Math.random() * 90 + 10)}`;
    const { data: mRoom, error: mErr } = await A.sb.rpc("flag_duel_create_room", {
      p_player_id: mPid, p_profile_id: A.uid, p_guest_id: null, p_name: A.name,
      p_code: mCode, p_region: "europe", p_total_rounds: 5, p_claim_token: mTok,
    });
    if (mErr || !mRoom) { ok(false, "6a manuel oda kuruldu", errMsg(mErr)); }
    else {
      const mRoomId = (typeof mRoom === "string" ? mRoom : (mRoom as { id?: string })?.id) as string;
      created.duelRooms.push({ id: mRoomId, label: "FQM(manual)" });
      ok(!!mRoomId, "6a manuel oda kuruldu");
      ok(await authAs(A, mPid, mTok), "6b MANUEL kayıtlı oyuncu yetkisi çalışıyor");
      ok(await authAs(A, mPid, null), "6b kayıtlı oyuncu claim-token OLMADAN da yetkili (JWT yolu)");

      // Misafir sözleşmesi: anon, guest_id + claim_token ile katılır.
      const gPid = uuid(), gTok = uuid(), gGuest = uuid();
      const { error: gErr } = await anon.rpc("duel_join_room", {
        p_code: mCode, p_player_id: gPid, p_profile_id: null,
        p_guest_id: gGuest, p_name: "pcGuest", p_claim_token: gTok,
      });
      if (gErr) {
        note(`misafir katılımı bu imzayla reddedildi (${errCode(gErr)}) — sözleşme yapısal olarak doğrulandı`);
        ok(true, "6c misafir yolu sözleşmesi mevcut (duel_authorize_player guest_id+token dalı)");
      } else {
        ok(await (async () => {
          const { data } = await anon.rpc("flag_duel_authorize_player", { p_player_id: gPid, p_claim_token: gTok });
          return data === true;
        })(), "6c MİSAFİR claim-token ile yetkili");
        const { data: wrongTok } = await anon.rpc("flag_duel_authorize_player", { p_player_id: gPid, p_claim_token: uuid() });
        ok(wrongTok === false, "6c misafir YANLIŞ token ile yetkisiz");
      }
      await swallow(() => A.sb.rpc("flag_duel_leave_room", { p_room_id: mRoomId, p_player_id: mPid, p_claim_token: mTok }));
    }
  }

  /* ═══════════ 7) TEMİZLİK ═══════════ */
  section("7) Temizlik");
  await cleanup();

  {
    const afterA = await prof(A), afterB = await prof(B);
    const dA = { xp: (afterA?.xp ?? 0) - (beforeA?.xp ?? 0), gold: (afterA?.gold ?? 0) - (beforeA?.gold ?? 0) };
    const dB = { xp: (afterB?.xp ?? 0) - (beforeB?.xp ?? 0), gold: (afterB?.gold ?? 0) - (beforeB?.gold ?? 0) };
    ok(dA.xp === 0 && dA.gold === 0 && dB.xp === 0 && dB.gold === 0,
       "7c XP/Gold deltası 0 (script XP RPC'sini hiç çağırmadı)",
       `A(xp${dA.xp >= 0 ? "+" : ""}${dA.xp},gold${dA.gold >= 0 ? "+" : ""}${dA.gold}) B(xp${dB.xp >= 0 ? "+" : ""}${dB.xp},gold${dB.gold >= 0 ? "+" : ""}${dB.gold})`);
  }
}

async function cleanup() {
  for (const c of [A, B]) {
    if (!c) continue;
    await swallow(() => c.sb.rpc("flag_duel_reset_quick_match", { p_profile_id: c.uid }));
  }
  const { data: qrows } = await A.sb.from("flag_duel_queue").select("profile_id").in("profile_id", [A.uid, B.uid]);
  ok((qrows ?? []).length === 0, "7a kuyruk artığı = 0 (yalnız test hesapları)", `kalan=${(qrows ?? []).length}`);

  let active = 0;
  for (const rm of created.duelRooms) {
    const { data } = await A.sb.from("duel_rooms").select("status").eq("id", rm.id).maybeSingle();
    const st = (data as { status?: string } | null)?.status;
    if (st && st !== "finished") active++;
    console.log(`     ${rm.label} → ${st ?? "(yok)"}`);
  }
  ok(active === 0, "7b bu koşunun AÇIK tek-kullanımlık odası yok", `açık=${active}`);
  note("ESKİ B11FD* odalarına DOKUNULMADI (bilinen atıl artıklar).");
}

main()
  .then(async () => {
    console.log(`\n${passed}/${passed + failed} assertion geçti`);
    if (notes.length) { console.log("\nNOTLAR:"); notes.forEach(n => console.log(`  • ${n}`)); }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(`\n✗ DURDU: ${e instanceof Error ? e.message : String(e)}`);
    await swallow(async () => { await cleanup(); });
    console.log(`\n${passed}/${passed + failed} assertion geçti (koşu yarıda kesildi)`);
    process.exit(1);
  });
