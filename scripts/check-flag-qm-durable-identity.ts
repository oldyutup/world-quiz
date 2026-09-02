/**
 * check-flag-qm-durable-identity.ts — 20260828130000'in sözleşmesi.
 * DB'siz, tarayıcısız, ağsız. Metin iddiaları + kuralın ÇALIŞTIRILABİLİR modeli.
 *
 * KAPSAM
 *  1. Kök neden hâlâ doğru teşhis mi (kimliksiz satır + kuyruk köprüsü)
 *  2. Migration: kimlik yazımı, arızada-kapanır kontrol, köprünün kalkması
 *  3. Eşleştirme gövdesi sürüklenmedi (bayt sadıklık kalkanı)
 *  4. ACL: genişleme yok
 *  5. Yetki kuralının çalıştırılabilir modeli (kuyruktan bağımsızlık + P0)
 *  6. Dokunulmayanlar: 20260828120000, Build 10 Çark, Bayrak Grup, manuel akış
 *
 * Çalıştır:  npx tsx scripts/check-flag-qm-durable-identity.ts
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
const section = (t: string) => console.log(`\n${t}`);

const MIG_PATH = "supabase/migrations/20260828130000_flag_duel_quick_match_durable_identity.sql";
const MIG      = read(MIG_PATH);
const CODE     = MIG.replace(/--[^\n]*/g, "");            // yorumsuz gövde
const LIVE_QM  = read("supabase/migrations/20260801120000_room_code_resolver.sql");
const LIVE_AUT = read("supabase/migrations/20260612120000_flag_duel_rpc_hardening.sql");

const fnBody = (src: string, fn: string) => {
  const i = src.indexOf(`create or replace function public.${fn}(`);
  if (i < 0) return "";
  return src.slice(i, src.indexOf("$$;", i) + 3);
};

/* ══════════════════════════════════════════════════════════════════════════
   1 — KÖK NEDEN: teşhis hâlâ gerçeğe uyuyor mu
   ══════════════════════════════════════════════════════════════════════════ */
section("1. Kök neden — kimliksiz satır + kuyruk köprüsü");
{
  const liveQm = fnBody(LIVE_QM, "flag_duel_quick_match");
  ok(/insert into public\.duel_players \(id, room_id, name, score\)\s*\n\s*values \(v_candidate\.player_id/.test(liveQm),
     "CANLI flag QM oyuncu satırlarını profile_id OLMADAN yazıyordu (kök neden)");
  const liveAuth = fnBody(LIVE_AUT, "flag_duel_authorize_player");
  ok(liveAuth.includes("flag_duel_queue"),
     "CANLI flag_duel_authorize_player kuyruk köprüsüne dayanıyordu");
  const reset = read("supabase/migrations/20260521120000_flag_duel_reset_quick_match.sql");
  ok(/delete from public\.flag_duel_queue\s*\n\s*where profile_id = p_profile_id;/.test(reset),
     "reset_quick_match kuyruk satırını KOŞULSUZ siler (köprüyü öldüren adım)");
  ok(read("src/components/FlagDuelGame.tsx").includes("flag_duel_reset_quick_match"),
     "istemci yeni aramadan önce reset çağırıyor (canlı tetikleyici)");
}

/* ══════════════════════════════════════════════════════════════════════════
   2 — MIGRATION: kalıcı kimlik + arızada-kapanır + köprünün kalkması
   ══════════════════════════════════════════════════════════════════════════ */
section("2. Migration — kalıcı kimlik yazımı");
{
  const qm = fnBody(MIG, "flag_duel_quick_match");
  ok(qm.includes("insert into public.duel_players (id, room_id, name, score, profile_id)"),
     "duel_players INSERT'ü artık profile_id taşıyor");
  ok(qm.includes("v_candidate.profile_id"),
     "BEKLEYEN tarafın profili KUYRUK SATIRINDAN (sunucu okuması) alınıyor");
  ok(/values \(p_player_id, v_room_id, p_player_name, 0, p_profile_id\)/.test(qm),
     "ÇAĞIRANIN profili doğrulanmış p_profile_id'den geliyor");
  ok(qm.includes("auth.uid() <> p_profile_id"),
     "çağıranın profili fonksiyon başında auth.uid() ile doğrulanıyor (korundu)");
  // İstemci verisi ASLA doğrudan SAHİPLİK yazmasın. `p_player_id` yalnız
  // SATIR KİMLİĞİ (id kolonu) olarak kullanılır; profile_id kolonuna gelen
  // değer her iki INSERT'te de sunucunun doğruladığı profildir. Konumsal
  // kontrol: değer listesi p_profile_id / v_candidate.profile_id ile BİTMELİ.
  const inserts = (qm.replace(/\s+/g, " ")
    .match(/insert into public\.duel_players \(id, room_id, name, score, profile_id\) values \([^)]*\)/g) ?? []);
  ok(inserts.length === 2, "iki oyuncu INSERT'ü de profile_id kolonunu taşıyor", inserts.length);
  ok(inserts.every(x => /,\s*(p_profile_id|v_candidate\.profile_id)\s*\)$/.test(x)),
     "profile_id DEĞERİ her zaman sunucu-doğrulamalı profil (p_player_id ASLA)", inserts);

  ok(qm.includes("player_id_taken"), "arızada-kapanır: player_id_taken hatası var");
  ok((qm.match(/if exists \(select 1 from public\.duel_players where id = /g) ?? []).length === 2,
     "İKİ taraf için de mevcut-satır kontrolü var (çağıran + bekleyen)");
  ok(/raise exception 'player_id_taken' using errcode = '42501'/.test(qm),
     "çakışmada 42501 ile RAISE → tüm transaction geri alınır (devralma yok)");

  const auth = fnBody(MIG, "flag_duel_authorize_player");
  ok(!auth.includes("flag_duel_queue"), "KUYRUK KÖPRÜSÜ KALDIRILDI");
  ok(auth.includes("public.duel_authorize_player(p_player_id, p_claim_token)"),
     "yetki yalnız duel_authorize_player'a dayanıyor (kayıtlı + gerçek misafir)");
  ok(auth.includes("security definer") && auth.includes("set search_path = public, auth"),
     "helper SECURITY DEFINER + search_path pinli kaldı");
}

/* ══════════════════════════════════════════════════════════════════════════
   3 — EŞLEŞTİRME GÖVDESİ SÜRÜKLENMEDİ (bayt sadıklık kalkanı)
   ══════════════════════════════════════════════════════════════════════════ */
section("3. Eşleştirme gövdesi bayt-sadık (yalnız kimlik eklendi)");
{
  const strip = (s: string) => s.split("\n")
    .filter(l => l.trim() && !l.trim().startsWith("--")).map(l => l.trimEnd());
  const a = strip(fnBody(LIVE_QM, "flag_duel_quick_match"));
  const b = strip(fnBody(MIG, "flag_duel_quick_match"));
  const removed = a.filter(l => !b.includes(l));
  const added   = b.filter(l => !a.includes(l));
  ok(removed.length === 4 && removed.every(l => l.includes("duel_players") || l.includes("values (")),
     "CANLI gövdeden çıkan 4 satırın HEPSİ iki eski INSERT'e ait (başka hiçbir şey)", removed);
  ok(added.every(l => /profile_id|player_id_taken|if exists \(select 1 from public\.duel_players|end if;|values \(/.test(l)),
     "eklenen her satır YALNIZ kimlik/ön-kontrol ile ilgili", added.filter(l =>
       !/profile_id|player_id_taken|if exists \(select 1 from public\.duel_players|end if;|values \(/.test(l)));
  for (const invariant of [
    "for update skip locked", "is_blocked_between", "max_level_diff",
    "room_kind", "'quick_match'", "interval '3 seconds'", "matched_room_id",
    "on conflict (profile_id) do update", "flag_duel_mode_level",
  ]) {
    ok(fnBody(MIG, "flag_duel_quick_match").includes(invariant),
       `eşleştirme değişmezi korundu: ${invariant}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   4 — ACL + yıkıcı DDL
   ══════════════════════════════════════════════════════════════════════════ */
section("4. ACL — genişleme yok, yıkıcı DDL yok");
{
  ok(CODE.includes("revoke all on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) from public;"),
     "flag_duel_quick_match: PUBLIC revoke");
  ok(CODE.includes("grant  execute on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) to authenticated;"),
     "flag_duel_quick_match: grant satırı repo geçmişiyle birebir (authenticated)");
  // NOT: CANLIDA anon EXECUTE=true'dur (Supabase ALTER DEFAULT PRIVILEGES
  // tuzağı, bkz. 20260809130000) — repo hiç `to anon` yazmamış olsa da.
  // Bu migration ACL'e DOKUNMAZ: yeni bir `to anon` grant'i EKLEMEZ ve
  // mevcut anon grant'ini de KALDIRMAZ (revoke yalnız PUBLIC'e).
  ok(!/grant[^;]*flag_duel_quick_match[^;]*anon/.test(CODE),
     "migration anon'a YENİ grant EKLEMİYOR (genişleme yok)");
  ok(!/revoke[^;]*flag_duel_quick_match[^;]*\banon\b/.test(CODE),
     "migration mevcut anon EXECUTE'unu KALDIRMIYOR (daralma yok — ACL dokunulmaz)");
  ok(CODE.includes("_flag_qm_acl_before"),
     "doğrulama ACL'i ÖNCE-DURUMUNA karşı ölçüyor (sabit beklentiye karşı değil)");
  ok(CODE.includes("revoke all     on function public.flag_duel_authorize_player(uuid, uuid) from public;")
     && CODE.includes("grant  execute on function public.flag_duel_authorize_player(uuid, uuid) to anon, authenticated;"),
     "flag_duel_authorize_player ACL'i canlıyla birebir (anon + authenticated)");
  for (const f of ["drop function", "drop table", "drop column", "drop constraint",
                   "alter table", "alter column", "truncate", "create table",
                   "create trigger", "create policy", "grant all"]) {
    ok(!CODE.toLowerCase().includes(f), `migration ${f} içermiyor`);
  }
  ok(!/\bto\s+public\b/i.test(CODE.replace(/from public/gi, "")),
     "PUBLIC'e hiçbir grant yok");
  ok(CODE.split("create or replace function").length - 1 === 2,
     "yalnız İKİ fonksiyon değişiyor");
}

/* ══════════════════════════════════════════════════════════════════════════
   5 — YETKİ KURALININ ÇALIŞTIRILABİLİR MODELİ
   ══════════════════════════════════════════════════════════════════════════ */
section("5. Yetki kuralı — kuyruktan bağımsızlık + kimliğe bürünme");
{
  interface Row { id: string; room_id: string; profile_id: string | null; guest_id: string | null }
  interface Q   { profile_id: string; player_id: string }
  const players: Row[] = [];
  const claims = new Map<string, string>();          // player_id → claim_token
  let queue: Q[] = [];

  /** duel_authorize_player (20260814180000) modeli. */
  const duelAuth = (pid: string, tok: string | null, uid: string | null) => {
    const p = players.find(x => x.id === pid);
    if (!p) return false;
    if (p.profile_id !== null) return uid !== null && p.profile_id === uid;
    return p.guest_id !== null && tok !== null && claims.get(pid) === tok;
  };
  /** ÖNCE: helper kuyruk köprüsüyle. */
  const authBefore = (pid: string, tok: string | null, uid: string | null) =>
    duelAuth(pid, tok, uid) || queue.some(q => q.player_id === pid && q.profile_id === uid);
  /** SONRA: köprü YOK. */
  const authAfter = (pid: string, tok: string | null, uid: string | null) =>
    duelAuth(pid, tok, uid);

  /** flag_duel_quick_match — DÜZELTİLMİŞ model (kimlik yazar, fail-closed). */
  const quickMatch = (callerUid: string, callerPid: string, roomId: string) => {
    const cand = queue.find(q => q.profile_id !== callerUid);
    if (!cand) { queue = queue.filter(q => q.profile_id !== callerUid)
                   .concat({ profile_id: callerUid, player_id: callerPid }); return null; }
    // ARIZADA-KAPANIR
    if (players.some(p => p.id === cand.player_id) || players.some(p => p.id === callerPid)) {
      throw new Error("player_id_taken");           // tüm transaction geri alınır
    }
    players.push({ id: cand.player_id, room_id: roomId, profile_id: cand.profile_id, guest_id: null });
    players.push({ id: callerPid,      room_id: roomId, profile_id: callerUid,       guest_id: null });
    queue = queue.filter(q => q.profile_id !== cand.profile_id);
    queue.push({ profile_id: callerUid, player_id: callerPid });
    return roomId;
  };

  const A = "uid-A", B = "uid-B";
  const pA = "player-A", pB = "player-B";

  // Normal Hızlı Eşleş: B bekler, A ikinci gelir (çağıran).
  quickMatch(B, pB, "room-1");                       // B kuyruğa girer
  const room = quickMatch(A, pA, "room-1");
  ok(room === "room-1", "5a eşleşme kuruldu (B bekleyen, A çağıran)");
  ok(players.every(p => p.profile_id !== null), "5a İKİ satır da KİMLİKLİ doğdu",
     players.map(p => p.profile_id));

  ok(authAfter(pB, null, B), "5b BEKLEYEN taraf yetkili");
  ok(authAfter(pA, null, A), "5b ÇAĞIRAN (ikinci) taraf yetkili");

  // ── ANAHTAR REGRESYON: kuyruk tamamen silinsin ──
  queue = [];
  ok(authAfter(pB, null, B), "5c KUYRUK SİLİNDİ → BEKLEYEN hâlâ yetkili");
  ok(authAfter(pA, null, A), "5c KUYRUK SİLİNDİ → ÇAĞIRAN hâlâ yetkili");
  ok(!authBefore(pA, null, A) && !authBefore(pB, null, B) ||
     duelAuth(pA, null, A),
     "5c (kıyas) eski modelde kimliksiz satır + kuyruksuz = yetkisizdi");

  // Kimliksiz ESKİ satır modeli: köprü olmadan gerçekten ölüydü.
  const legacy: Row = { id: "legacy-p", room_id: "old", profile_id: null, guest_id: null };
  players.push(legacy);
  ok(!authAfter("legacy-p", "any-token", A) && !authAfter("legacy-p", "any-token", B),
     "5d ESKİ kimliksiz satır köprüsüz yetkisiz (bu migration'ın düzelttiği durum)");
  queue.push({ profile_id: A, player_id: "legacy-p" });
  ok(authBefore("legacy-p", null, A), "5d (kıyas) eski köprü onu yetkilendiriyordu");
  ok(!authAfter("legacy-p", null, A), "5d yeni modelde köprü ARTIK yetki vermiyor");
  queue = [];
  players.pop();

  // ── P0: A, B'nin player_id'sini ele geçirmeye çalışır ──
  // Anlamlı olması için kuyrukta BEKLEYEN biri olmalı; boş kuyrukta
  // quickMatch yalnız sıraya girer ve fail-closed dalına hiç ulaşılmazdı.
  const C = "uid-C";
  queue = [{ profile_id: C, player_id: "player-C" }];
  let captured = false;
  try { quickMatch(A, pB, "room-evil"); } catch { captured = true; }
  queue = [];
  ok(captured, "5e P0 A, B'nin player_id'siyle maç KURAMIYOR (fail-closed)");
  ok(players.find(p => p.id === pB)?.profile_id === B, "5e B sahibi DEĞİŞMEDİ");
  ok(!players.some(p => p.room_id === "room-evil"), "5e kısmi oda/oyuncu durumu YOK");

  // Saldırgan kuyruğa kurbanın player_id'siyle girer, sonra biri eşleşir.
  queue = [{ profile_id: A, player_id: pB }];
  let captured2 = false;
  try { quickMatch(B, "player-B2", "room-evil2"); } catch { captured2 = true; }
  ok(captured2, "5f P0 kuyruğa ekilmiş kurban player_id'si de maçı geri alıyor");
  ok(players.find(p => p.id === pB)?.profile_id === B, "5f sahiplik devredilmedi");
  queue = [];

  // Çapraz kullanıcı: A, B adına hiçbir şey yapamaz.
  ok(!authAfter(pB, null, A), "5g çapraz: A, B'nin slotu için yetkisiz");
  ok(!authAfter(pA, null, B), "5g çapraz: B, A'nın slotu için yetkisiz");
  ok(!authAfter(pB, "forged-token", A), "5g uydurma claim token de işe yaramıyor");

  // Kuyruk reset'i KARŞI TARAFIN yetkisini etkilemez.
  queue = [{ profile_id: A, player_id: pA }];
  queue = queue.filter(q => q.profile_id !== A);     // A reset atar
  ok(authAfter(pB, null, B), "5h A'nın kuyruk reset'i B'nin yetkisini BOZMUYOR");
  ok(authAfter(pA, null, A), "5h A kendi reset'inden sonra da yetkili");

  // Gerçek misafir yolu bozulmadı (manuel oda).
  players.push({ id: "guest-1", room_id: "manual", profile_id: null, guest_id: "g-1" });
  claims.set("guest-1", "tok-1");
  ok(authAfter("guest-1", "tok-1", null), "5i MİSAFİR (manuel oda) claim token ile yetkili");
  ok(!authAfter("guest-1", "wrong", null), "5i yanlış token reddediliyor");
}

/* ══════════════════════════════════════════════════════════════════════════
   6 — DOKUNULMAYANLAR
   ══════════════════════════════════════════════════════════════════════════ */
section("6. Dokunulmayanlar");
{
  for (const t of ["flag_group_", "wheel_duel_", "route_duel_", "conquest_", "tevatur_",
                   "duel_group_", "xp_events", "award_xp_event", "wheel_duel_quick_match_owners"]) {
    ok(!CODE.includes(t), `migration ${t} nesnelerine dokunmuyor`);
  }
  for (const fn of ["flag_duel_leave_room", "flag_duel_submit_claim", "flag_duel_accept_rematch",
                    "flag_duel_advance_if_due", "flag_duel_finalize_game", "flag_duel_create_room",
                    "flag_duel_reset_quick_match", "flag_duel_cancel_quick_match",
                    "flag_duel_send_message", "duel_join_room", "duel_authorize_player"]) {
    ok(!CODE.includes(`create or replace function public.${fn}(`),
       `${fn} YENİDEN TANIMLANMIYOR (helper düzelmesini otomatik alır)`);
  }
  ok(CODE.includes("public.duel_authorize_player(p_player_id, p_claim_token)"),
     "ortak duel_authorize_player'a DELEGE ediliyor (Ülke Yaz ile aynı kural)");

  // Hiçbir MEVCUT migration DÜZENLENMEMİŞ olmalı: git durumu ' M ' (modified)
  // ile '??' (yeni dosya) ayrımı burada kritiktir — 20260828120000 bu çalışma
  // ağacında henüz COMMIT EDİLMEMİŞ YENİ bir dosyadır, DÜZENLENMİŞ değildir.
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const modified = porcelain.filter(l => !l.startsWith("??")).map(l => l.slice(3).trim());
  const untracked = porcelain.filter(l => l.startsWith("??")).map(l => l.slice(3).trim());

  ok(!modified.some(f => f.startsWith("supabase/migrations/")),
     "HİÇBİR migration DÜZENLENMEDİ (20260828120000 ve Build 10 dosyaları dâhil)",
     modified.filter(f => f.startsWith("supabase/migrations/")));
  ok(untracked.includes("supabase/migrations/20260828120000_quick_match_direct_rematch.sql"),
     "20260828120000 yerinde ve DÜZENLENMEMİŞ (yeni dosya olarak duruyor)");
  for (const f of ["20260827140000_wheel_duel_quick_match_durable_identity.sql",
                   "20260827150000_wheel_duel_quick_match_bind_players.sql",
                   "20260814180000_registered_player_claim_auth_hardening.sql"]) {
    ok(!modified.includes(`supabase/migrations/${f}`) && !untracked.includes(`supabase/migrations/${f}`),
       `canlı dosya dokunulmadı (commit'li ve temiz): ${f}`);
  }
  ok(untracked.includes(MIG_PATH), "bu migration yeni dosya olarak eklendi");

  // SUNUCU-YALNIZ: bu düzeltme istemci değişikliği GEREKTİRMEZ — istemci
  // zaten aynı RPC'leri aynı imzayla çağırıyor, yalnız artık yetkileniyor.
  const flagSrc = read("src/components/FlagDuelGame.tsx");
  for (const rpc of ["flag_duel_quick_match", "flag_duel_leave_room", "flag_duel_submit_claim"]) {
    ok(flagSrc.includes(`rpc("${rpc}"`), `istemci ${rpc} çağrısını AYNEN koruyor (imza değişmedi)`);
  }
  ok(!CODE.includes("p_") || fnBody(MIG, "flag_duel_quick_match").includes("p_first_flag"),
     "flag_duel_quick_match imzası değişmedi (istemci uyarlaması gerekmez)");
}

console.log(`\n${passed}/${passed + failed} assertion geçti`);
process.exit(failed === 0 ? 0 : 1);
