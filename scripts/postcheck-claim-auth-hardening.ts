/**
 * postcheck-claim-auth-hardening.ts
 * 20260814180000_registered_player_claim_auth_hardening.sql — CANLI POSTCHECK
 *
 * ⚠ CANLI Supabase. Sırasıyla:
 *   FAZ A  READ-ONLY  — hiçbir yazma yok (SELECT + reddedilen yazma denemeleri)
 *   FAZ B  SMOKE      — YALNIZ disposable test odası/oyuncusu; sonda tam cleanup
 *
 * Gerçek kullanıcı odalarına/oyuncularına DOKUNMAZ: yalnız bu script'in
 * kurduğu, sabit "PC-" ön ekli oda kodlarıyla çalışır ve sonunda hepsini siler.
 *
 * GÜVENLİK: secret yok. Yalnız PUBLIC anon key (.env) + test hesapları
 * (.env.test.local). Hiçbir anahtar/parola konsola yazılmaz.
 *
 * Çalıştır: npx tsx scripts/postcheck-claim-auth-hardening.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* ── env ─────────────────────────────────────────────────────────────── */
function readEnvFile(rel: string): Record<string, string> {
  const p = new URL(rel, import.meta.url);
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const baseEnv = readEnvFile("../.env");
const testEnv = readEnvFile("../.env.test.local");
const URL_ = process.env.VITE_SUPABASE_URL?.trim() || baseEnv.VITE_SUPABASE_URL;
const KEY_ = process.env.VITE_SUPABASE_ANON_KEY?.trim() || baseEnv.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY_) throw new Error("VITE_SUPABASE_URL / ANON_KEY bulunamadı");

/* ── sonuç toplayıcı ─────────────────────────────────────────────────── */
type Status = "PASS" | "FAIL" | "INFO" | "SKIP";
const results: { phase: string; id: string; what: string; expected: string; actual: string; status: Status }[] = [];
let unexpectedExceptions = 0;
function rec(phase: string, id: string, what: string, expected: string, actual: string, status: Status) {
  results.push({ phase, id, what, expected, actual, status });
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : status === "SKIP" ? "–" : "·";
  console.log(`  ${icon} [${id}] ${what}\n      beklenen: ${expected}\n      gerçek  : ${actual}`);
}

const anon = () => createClient(URL_, KEY_, { auth: { persistSession: false, autoRefreshToken: false } });
const uuid = () => crypto.randomUUID();

/** RPC/So sonucu tek satır özete indirger. */
function errStr(e: { code?: string; message?: string } | null): string {
  if (!e) return "OK";
  return `${e.code ?? "?"} ${(e.message ?? "").slice(0, 90)}`;
}
/** 42501 / unauthorized / permission denied sayılır mı? */
function isDenied(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  const c = e.code ?? "";
  const m = (e.message ?? "").toLowerCase();
  return c === "42501" || c === "PGRST301" || c === "PGRST116"
    || m.includes("unauthorized") || m.includes("permission denied")
    || m.includes("violates row-level security");
}

/* ════════════════════════════════════════════════════════════════════════
   FAZ A — READ-ONLY POSTCHECK
   ════════════════════════════════════════════════════════════════════════ */
async function phaseA() {
  console.log("\n══════ FAZ A — READ-ONLY schema/ACL postcheck (yazma YOK)\n");
  const a = anon();

  // A1: wheel_duel_queue SELECT korunmalı (istemci own-row + realtime buna bağlı)
  {
    const { error } = await a.from("wheel_duel_queue").select("profile_id,player_id").limit(1);
    rec("A", "A1", "wheel_duel_queue SELECT (anon) korunuyor mu",
      "erişilebilir (revoke yalnız yazma)", errStr(error),
      error ? "FAIL" : "PASS");
  }

  // A2: köprünün dayandığı kolonlar
  {
    const { error } = await a.from("wheel_duel_queue").select("profile_id,player_id,matched_room_id").limit(1);
    rec("A", "A2", "wheel_duel_queue köprü kolonları (profile_id/player_id/matched_room_id)",
      "hepsi mevcut", errStr(error), error ? "FAIL" : "PASS");
  }

  // A3: kontrol — flag_duel_queue zaten kilitli (20260516140000)
  {
    const { error } = await a.from("flag_duel_queue").select("profile_id").limit(1);
    rec("A", "A3", "KONTROL flag_duel_queue anon SELECT (kilitli olmalı)",
      "42501 permission denied", errStr(error),
      isDenied(error) ? "PASS" : "INFO");
  }
  return true;
}

/* ════════════════════════════════════════════════════════════════════════
   FAZ B — wheel_duel_queue DOĞRUDAN YAZMA KİLİDİ
   Reddedilen denemeler veri BIRAKMAZ. Kabul edilirse anında temizlenir
   ve FAIL olarak raporlanır.
   ════════════════════════════════════════════════════════════════════════ */
async function phaseB(authed: SupabaseClient | null, authedLabel: string, myProfileId: string | null) {
  const cli = authed ?? anon();
  const role = authed ? authedLabel : "anon";
  const strayProfile = uuid();
  const strayPlayer = uuid();

  // INSERT
  {
    const { error } = await cli.from("wheel_duel_queue")
      .insert({ profile_id: strayProfile, player_id: strayPlayer });
    const denied = isDenied(error) || !!error;
    if (!error) {
      // Kabul edildiyse DERHAL temizle
      await cli.from("wheel_duel_queue").delete().eq("profile_id", strayProfile);
      await anon().from("wheel_duel_queue").delete().eq("profile_id", strayProfile);
    }
    rec("B", `B-${role}-INS`, `wheel_duel_queue DOĞRUDAN INSERT (${role})`,
      "REDDEDİLMELİ", error ? errStr(error) : "KABUL EDİLDİ (temizlendi)",
      denied ? "PASS" : "FAIL");
  }

  // UPDATE — kendi satırı olsa bile yazma kapalı olmalı
  {
    const { error, data } = await cli.from("wheel_duel_queue")
      .update({ player_id: strayPlayer })
      .eq("profile_id", myProfileId ?? strayProfile)
      .select();
    const changed = Array.isArray(data) && data.length > 0;
    rec("B", `B-${role}-UPD`, `wheel_duel_queue DOĞRUDAN UPDATE (${role})`,
      "REDDEDİLMELİ veya 0 satır", error ? errStr(error) : `${changed ? data.length : 0} satır etkilendi`,
      (error && isDenied(error)) || !changed ? "PASS" : "FAIL");
  }

  // DELETE
  {
    const { error, data } = await cli.from("wheel_duel_queue")
      .delete().eq("profile_id", myProfileId ?? strayProfile).select();
    const changed = Array.isArray(data) && data.length > 0;
    rec("B", `B-${role}-DEL`, `wheel_duel_queue DOĞRUDAN DELETE (${role})`,
      "REDDEDİLMELİ veya 0 satır", error ? errStr(error) : `${changed ? data.length : 0} satır silindi`,
      (error && isDenied(error)) || !changed ? "PASS" : "FAIL");
  }
}

/* ════════════════════════════════════════════════════════════════════════
   CLEANUP KAYDI — kurulan her disposable kayıt buraya yazılır
   ════════════════════════════════════════════════════════════════════════ */
const created = {
  duelRooms:  [] as { roomId: string; playerId: string; token: string | null; guest?: boolean; owner?: SupabaseClient }[],
  wheelRooms: [] as { roomId: string; playerId: string; token: string | null; owner?: SupabaseClient }[],
  queueProfiles: [] as { cli: SupabaseClient; profileId: string }[],
};
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");

/* ════════════════════════════════════════════════════════════════════════
   FAZ C — ÜLKE YAZ DÜELLO kimlik matrisi (duel_authorize_player)
   ════════════════════════════════════════════════════════════════════════ */
async function phaseC(cliA: SupabaseClient, profA: string, cliB: SupabaseClient | null) {
  console.log("\n══════ FAZ C — Ülke Yaz Düello kimlik matrisi (disposable oda)\n");

  const playerA = uuid(), tokenA = uuid(), code = roomCode();
  const { data: room, error: crErr } = await cliA.rpc("duel_create_room", {
    p_player_id: playerA, p_profile_id: profA, p_guest_id: null,
    p_name: "PostcheckA", p_code: code, p_duration: 60,
    p_region: "world", p_claim_token: tokenA,
  });
  if (crErr || !room) {
    rec("C", "C0", "disposable oda kurulumu (kayıtlı A)", "başarılı", errStr(crErr), "FAIL");
    return;
  }
  const roomId = (room as { id: string }).id;
  created.duelRooms.push({ roomId, playerId: playerA, token: tokenA, owner: cliA });
  rec("C", "C0", "disposable oda kurulumu (kayıtlı A)", "başarılı", `room=${code}`, "INFO");

  // C1 — kayıtlı A, kendi oturumu + kendi token'ı
  {
    const { error } = await cliA.rpc("duel_heartbeat", { p_player_id: playerA, p_claim_token: tokenA });
    rec("C", "C1", "KAYITLI A kendi oturumu + kendi token'ı", "PASS", errStr(error), error ? "FAIL" : "PASS");
  }
  // C2 — kayıtlı A, token GÖNDERMEDEN (auth.uid() dalı tek başına yetmeli)
  {
    const { error } = await cliA.rpc("duel_heartbeat", { p_player_id: playerA, p_claim_token: null });
    rec("C", "C2", "KAYITLI A kendi oturumu, token YOK (auth.uid() dalı)", "PASS", errStr(error), error ? "FAIL" : "PASS");
  }
  // C3 — ÇALINMIŞ kayıtlı claim token'ı, ANON çağıran  ← P0'ın ta kendisi
  {
    const { error } = await anon().rpc("duel_heartbeat", { p_player_id: playerA, p_claim_token: tokenA });
    rec("C", "C3", "ÇALINMIŞ kayıtlı claim token'ı + ANON çağıran", "REDDEDİLMELİ (42501)",
      errStr(error), isDenied(error) ? "PASS" : "FAIL");
  }
  // C4 — ÇALINMIŞ token, BAŞKA kayıtlı kullanıcı (B)
  if (cliB) {
    const { error } = await cliB.rpc("duel_heartbeat", { p_player_id: playerA, p_claim_token: tokenA });
    rec("C", "C4", "ÇALINMIŞ kayıtlı token + BAŞKA authed kullanıcı (B)", "REDDEDİLMELİ (42501)",
      errStr(error), isDenied(error) ? "PASS" : "FAIL");
  } else {
    rec("C", "C4", "ÇALINMIŞ kayıtlı token + BAŞKA authed kullanıcı", "REDDEDİLMELİ", "B hesabı yok", "SKIP");
  }

  // ── MİSAFİR uyumluluğu: anon, gerçek guest_id + kendi token'ı ──────────
  const playerG = uuid(), tokenG = uuid(), guestId = `pc-guest-${uuid().slice(0, 8)}`;
  const cliG = anon();
  {
    const { error } = await cliG.rpc("duel_join_room", {
      p_code: code, p_player_id: playerG, p_profile_id: null,
      p_guest_id: guestId, p_name: "PostcheckG", p_claim_token: tokenG,
    });
    rec("C", "C5", "MİSAFİR odaya katılıyor (guest_id + claim_token)", "PASS",
      errStr(error), error ? "FAIL" : "PASS");
    if (!error) created.duelRooms.push({ roomId, playerId: playerG, token: tokenG, guest: true });
  }
  // C6 — misafir kendi doğru token'ı
  {
    const { error } = await cliG.rpc("duel_heartbeat", { p_player_id: playerG, p_claim_token: tokenG });
    rec("C", "C6", "MİSAFİR doğru token (geriye uyumluluk)", "PASS", errStr(error), error ? "FAIL" : "PASS");
  }
  // C7 — misafir YANLIŞ token
  {
    const { error } = await cliG.rpc("duel_heartbeat", { p_player_id: playerG, p_claim_token: uuid() });
    rec("C", "C7", "MİSAFİR YANLIŞ token", "REDDEDİLMELİ", errStr(error), isDenied(error) ? "PASS" : "FAIL");
  }
  // C8 — misafir, BAŞKA oyuncunun (A'nın) token'ı
  {
    const { error } = await cliG.rpc("duel_heartbeat", { p_player_id: playerG, p_claim_token: tokenA });
    rec("C", "C8", "MİSAFİR başka oyuncunun token'ı", "REDDEDİLMELİ", errStr(error), isDenied(error) ? "PASS" : "FAIL");
  }

  // ── CROSS-ROOM: geçerli token, YANLIŞ oda ─────────────────────────────
  const code2 = roomCode(), playerA2 = uuid(), tokenA2 = uuid();
  const { data: room2, error: cr2 } = await cliA.rpc("duel_create_room", {
    p_player_id: playerA2, p_profile_id: profA, p_guest_id: null,
    p_name: "PostcheckA2", p_code: code2, p_duration: 60,
    p_region: "world", p_claim_token: tokenA2,
  });
  if (!cr2 && room2) {
    const room2Id = (room2 as { id: string }).id;
    created.duelRooms.push({ roomId: room2Id, playerId: playerA2, token: tokenA2, owner: cliA });
    const { error } = await cliG.rpc("duel_leave_room", {
      p_room_id: room2Id, p_player_id: playerG, p_claim_token: tokenG,
    });
    rec("C", "C9", "CROSS-ROOM: misafirin geçerli token'ı BAŞKA odaya", "REDDEDİLMELİ",
      errStr(error), isDenied(error) ? "PASS" : "FAIL");
  } else {
    rec("C", "C9", "CROSS-ROOM testi", "ikinci oda", errStr(cr2), "SKIP");
  }
}

/* ════════════════════════════════════════════════════════════════════════
   FAZ D — ÇARK DÜELLO Hızlı Eşleş (queue köprüsü + revoke uyumu)
   ════════════════════════════════════════════════════════════════════════ */
async function phaseD(cliA: SupabaseClient, profA: string, cliB: SupabaseClient | null, profB: string | null) {
  console.log("\n══════ FAZ D — Çark Düello Hızlı Eşleş (SECURITY DEFINER yolu)\n");

  // Gerçek kullanıcı eşleşmesini önlemek için kuyruk BOŞ olmalı
  const { data: qBefore } = await anon().from("wheel_duel_queue").select("profile_id");
  const others = (qBefore ?? []).filter(r => r.profile_id !== profA && r.profile_id !== profB);
  if (others.length > 0) {
    rec("D", "D0", "kuyrukta GERÇEK kullanıcı var mı (eşleşme çakışması)",
      "boş olmalı", `${others.length} gerçek arayan var — test ATLANDI`, "SKIP");
    return;
  }
  rec("D", "D0", "kuyrukta gerçek kullanıcı yok", "boş", "boş", "INFO");

  const playerA = uuid(), codeA = roomCode();
  const qmArgs = (pid: string, plid: string, name: string, code: string) => ({
    p_profile_id: pid, p_player_id: plid, p_player_name: name,
    p_duration: 60, p_region: "world", p_max_level_diff: 99,
    p_room_code: code, p_first_target: "TUR",
  });

  // D1 — kuyruk satırı oluşturma (revoke sonrası SECURITY DEFINER INSERT)
  const { data: r1, error: e1 } = await cliA.rpc("wheel_duel_quick_match", qmArgs(profA, playerA, "PostcheckA", codeA));
  rec("D", "D1", "wheel_duel_quick_match kuyruk satırı yazıyor (revoke sonrası)",
    "başarılı (SECURITY DEFINER)", errStr(e1), e1 ? "FAIL" : "PASS");
  if (!e1) created.queueProfiles.push({ cli: cliA, profileId: profA });
  if (e1) return;

  // D2 — eşleşme: ikinci oyuncu (queue UPDATE + oda/player INSERT yolu)
  if (!cliB || !profB) {
    rec("D", "D2", "eşleşme akışı", "B ile eşleşme", "B hesabı yok", "SKIP");
  } else {
    const playerB = uuid(), codeB = roomCode();
    const { data: r2, error: e2 } = await cliB.rpc("wheel_duel_quick_match", qmArgs(profB, playerB, "PostcheckB", codeB));
    const matched = (r2 as { matched?: boolean } | null)?.matched === true;
    const roomId = (r2 as { room_id?: string } | null)?.room_id;
    rec("D", "D2", "Hızlı Eşleş EŞLEŞMESİ (queue UPDATE + oda kurulumu)",
      "matched=true", e2 ? errStr(e2) : `matched=${matched}`,
      !e2 && matched ? "PASS" : "FAIL");
    if (!e2) created.queueProfiles.push({ cli: cliB, profileId: profB });

    if (matched && roomId) {
      created.wheelRooms.push({ roomId, playerId: playerB, token: null, owner: cliB });
      created.wheelRooms.push({ roomId, playerId: playerA, token: null, owner: cliA });

      // D3 — MEŞRU QM sahibi: queue köprüsü (claim YOK)
      {
        const { error } = await cliA.rpc("wheel_duel_advance_if_due", {
          p_room_id: roomId, p_player_id: playerA, p_claim_token: null, p_expected_target: "TUR",
        });
        rec("D", "D3", "MEŞRU Çark QM sahibi (queue köprüsü, claim YOK)", "PASS",
          errStr(error), error ? "FAIL" : "PASS");
      }
      // D4 — EKİLMİŞ claim + anon: kimliksiz QM satırı ele geçirilemez
      {
        const planted = uuid();
        const { error: insErr } = await anon().from("wheel_duel_player_claims")
          .insert({ player_id: playerA, claim_token: planted });
        const { error } = await anon().rpc("wheel_duel_advance_if_due", {
          p_room_id: roomId, p_player_id: playerA, p_claim_token: planted, p_expected_target: "TUR",
        });
        rec("D", "D4", "EKİLMİŞ claim + ANON, kimliksiz Çark QM satırı",
          "REDDEDİLMELİ (42501)",
          `claim insert: ${insErr ? errStr(insErr) : "kabul"} → rpc: ${errStr(error)}`,
          isDenied(error) ? "PASS" : "FAIL");
      }
      // D5 — başka authed kullanıcı (B) A'nın player_id'siyle
      {
        const { error } = await cliB.rpc("wheel_duel_advance_if_due", {
          p_room_id: roomId, p_player_id: playerA, p_claim_token: null, p_expected_target: "TUR",
        });
        rec("D", "D5", "BAŞKA authed kullanıcı, A'nın player_id'si", "REDDEDİLMELİ",
          errStr(error), isDenied(error) ? "PASS" : "FAIL");
      }
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════
   CLEANUP — kurulan her şeyi geri al, residual kanıtla
   ════════════════════════════════════════════════════════════════════════ */
async function cleanup(cliA: SupabaseClient | null) {
  console.log("\n══════ CLEANUP\n");
  let residual = 0;

  // ⚠ SIRA ÖNEMLİ: Çark QM satırının yetkisi `wheel_duel_queue` KÖPRÜSÜNDEN
  //   gelir. Kuyruk önce iptal edilirse köprü kopar ve leave_room 42501 verir.
  //   Bu yüzden ÖNCE oda kapatılır, SONRA kuyruk iptal edilir.
  //
  // ⚠ SINIR: `wheel_duel_leave_room` 'finished' odada TASARIM GEREĞİ no-op'tur
  //   (20260814160000) ve wheel tablolarında DELETE policy'si YOKTUR (M3).
  //   Maç 'finished'a ulaştıysa oda istemci tarafından SİLİNEMEZ → residual
  //   raporlanır, sessizce yutulmaz.
  for (const w of created.wheelRooms) {
    const cli = w.owner ?? cliA ?? anon();
    const { error } = await cli.rpc("wheel_duel_leave_room", {
      p_room_id: w.roomId, p_player_id: w.playerId, p_claim_token: w.token,
    });
    if (error) console.log(`   ! wheel leave (${w.playerId.slice(0, 8)}): ${errStr(error)}`);
  }
  for (const q of created.queueProfiles) {
    const { error } = await q.cli.rpc("wheel_duel_cancel_quick_match", { p_profile_id: q.profileId });
    if (error) console.log(`   ! kuyruk cancel: ${errStr(error)}`);
  }
  // Ülke Yaz odaları — misafirler önce, host sonra.
  // ⚠ KAYITLI oyuncunun satırı artık SADECE kendi oturumuyla kapatılabilir
  //   (yamanın ta kendisi): anon + claim_token yolu bilerek REDDEDİLİR.
  for (const d of [...created.duelRooms].reverse()) {
    const cli = d.owner ?? (d.guest ? anon() : (cliA ?? anon()));
    const { error } = await cli.rpc("duel_leave_room", {
      p_room_id: d.roomId, p_player_id: d.playerId,
      p_claim_token: d.guest ? d.token : null,
    });
    if (error) console.log(`   ! duel leave (${d.playerId.slice(0, 8)}): ${errStr(error)}`);
  }

  // ── RESIDUAL DOĞRULAMA ────────────────────────────────────────────────
  const a = anon();
  for (const d of created.duelRooms) {
    const { data } = await a.from("duel_rooms").select("id").eq("id", d.roomId).maybeSingle();
    if (data) { residual++; console.log(`   ✗ ARTIK duel_rooms ${d.roomId}`); }
    const { data: p } = await a.from("duel_players").select("id").eq("id", d.playerId).maybeSingle();
    if (p) { residual++; console.log(`   ✗ ARTIK duel_players ${d.playerId}`); }
  }
  for (const w of created.wheelRooms) {
    const { data } = await a.from("wheel_duel_rooms").select("id").eq("id", w.roomId).maybeSingle();
    if (data) { residual++; console.log(`   ✗ ARTIK wheel_duel_rooms ${w.roomId}`); }
    const { data: p } = await a.from("wheel_duel_players").select("id").eq("id", w.playerId).maybeSingle();
    if (p) { residual++; console.log(`   ✗ ARTIK wheel_duel_players ${w.playerId}`); }
  }
  for (const q of created.queueProfiles) {
    const { data } = await a.from("wheel_duel_queue").select("profile_id").eq("profile_id", q.profileId).maybeSingle();
    if (data) { residual++; console.log(`   ✗ ARTIK wheel_duel_queue ${q.profileId.slice(0, 8)}`); }
  }
  rec("CLEANUP", "Z1", "disposable test verisi artığı", "0", String(residual), residual === 0 ? "PASS" : "FAIL");
  return residual;
}

/* ── main ────────────────────────────────────────────────────────────── */
async function main() {
  console.log("POSTCHECK — 20260814180000_registered_player_claim_auth_hardening");
  console.log("CANLI Supabase (host gizli). FAZ A/B: yazma yok veya reddedilen deneme.\n");

  await phaseA();

  console.log("\n══════ FAZ B — wheel_duel_queue doğrudan yazma kilidi\n");
  await phaseB(null, "anon", null);

  // authenticated rol için test hesabı A
  if (testEnv.TORBLE_A_EMAIL && testEnv.TORBLE_A_PASSWORD) {
    const cliA = anon();
    const { data, error } = await cliA.auth.signInWithPassword({
      email: testEnv.TORBLE_A_EMAIL, password: testEnv.TORBLE_A_PASSWORD,
    });
    if (error || !data.user) {
      rec("B", "B-auth-login", "test hesabı A ile giriş", "başarılı", errStr(error), "SKIP");
    } else {
      rec("B", "B-auth-login", "test hesabı A ile giriş", "başarılı", "OK", "INFO");
      await phaseB(cliA, "authenticated", data.user.id);
      await cliA.auth.signOut();
    }
  } else {
    rec("B", "B-auth-login", "test hesabı A kimlik bilgisi", "mevcut", ".env.test.local yok", "SKIP");
  }

  /* ── FAZ C / D — kontrollü smoke (disposable) ── */
  let cliA: SupabaseClient | null = null, profA: string | null = null;
  let cliB: SupabaseClient | null = null, profB: string | null = null;
  if (testEnv.TORBLE_A_EMAIL && testEnv.TORBLE_B_EMAIL) {
    cliA = anon();
    const ra = await cliA.auth.signInWithPassword({
      email: testEnv.TORBLE_A_EMAIL, password: testEnv.TORBLE_A_PASSWORD,
    });
    profA = ra.data.user?.id ?? null;
    cliB = anon();
    const rb = await cliB.auth.signInWithPassword({
      email: testEnv.TORBLE_B_EMAIL, password: testEnv.TORBLE_B_PASSWORD,
    });
    profB = rb.data.user?.id ?? null;
  }

  let residual = 0;
  try {
    if (cliA && profA) {
      await phaseC(cliA, profA, cliB);
      await phaseD(cliA, profA, cliB, profB);
    } else {
      rec("C", "C-login", "test hesapları ile giriş", "başarılı", "hesap yok", "SKIP");
    }
  } catch (e) {
    unexpectedExceptions++;
    console.error("FAZ C/D BEKLENMEDİK HATA:", (e as Error)?.message ?? e);
  } finally {
    residual = await cleanup(cliA);
    await cliA?.auth.signOut(); await cliB?.auth.signOut();
  }

  /* ── özet ── */
  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const skip = results.filter(r => r.status === "SKIP").length;
  console.log("\n════════════════════════════════════════════════");
  console.log(`SONUÇ:  ${pass} PASS / ${fail} FAIL / ${skip} SKIP`);
  console.log(`cleanup residual      : ${residual}`);
  console.log(`beklenmedik exception : ${unexpectedExceptions}`);
  if (fail > 0 || residual > 0) {
    console.log("\n❌ SORUN VAR — üretimde OTOMATİK DÜZELTME YAPILMADI, duruldu.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  unexpectedExceptions++;
  console.error("BEKLENMEDİK HATA:", e?.message ?? e);
  process.exitCode = 1;
});
