/**
 * check-kornokta-advance-if-due.ts
 *
 * Kör Nokta "sunucu-otoriter deadline ilerletme" SÖZLEŞMESİNİ saf/DB'siz
 * doğrular. Gerçek Supabase ve tarayıcı GEREKMEZ.
 *
 * NEDEN VAR
 * ─────────
 * Faz ilerletme eskiden TEK bir tarayıcıya (host'un setInterval'i) bağlıydı ve
 * `tevatur_kn_advance_phase` phaseEndsAt'a hiç bakmıyordu. Host telefonu
 * kilitlediğinde maç dört oyuncu için birden donuyordu. 20260813120000 ayrı bir
 * `tevatur_kn_advance_if_due` ekledi: odanın her üyesi çağırabilir ama SUNUCU
 * süreyi kendi saatiyle doğrular.
 *
 * Bu dosya iki şeyi kilitler:
 *   1. GÜVENLİK — yeni RPC'nin kontrolleri ve sırası; manuel host-only yolun
 *      DEĞİŞMEMİŞ olması; istemcinin otomatik yoldan artık host-only RPC'yi
 *      çağırmaması.
 *   2. DRIFT — iki fonksiyonun GEÇİŞ ZİNCİRİ birebir aynı kalmalı. Ortak bir
 *      helper'a çıkarmak advance_phase'in gövdesini değiştirmeyi gerektirirdi
 *      (bilinçli olarak dokunulmadı), bu yüzden eşitlik testle korunur.
 *
 * KAPSAM DIŞI (kasıtlı): çalışma-zamanı davranışı. Kilit/CAS/deadline
 * semantiği gerçek Postgres'te ayrıca doğrulandı; burada YALNIZ sözleşmenin
 * kaynak kodda durduğu doğrulanır.
 *
 * DRIFT UYARISI: bu dosya migration'ın ve KorNoktaGame'in AYNASIDIR.
 *
 * Çalıştır:  npx tsx scripts/check-kornokta-advance-if-due.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const here          = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../supabase/migrations");
const srcDir        = join(here, "../src");

const NEW_FILE  = "20260813120000_kornokta_advance_if_due.sql";
const BASE_FILE = "20260723120000_kornokta_phase_durations_35s.sql";

const newRaw  = readFileSync(join(migrationsDir, NEW_FILE),  "utf8");
const baseRaw = readFileSync(join(migrationsDir, BASE_FILE), "utf8");

/** Yorum satırlarını atar — iddialar YALNIZ çalışan SQL üzerinde kurulmalı,
 *  yoksa bir açıklama metni testi yanlışlıkla geçirebilir. */
function sqlOnly(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.trimStart().startsWith("--"))
    .join("\n");
}
const newSql  = sqlOnly(newRaw);
const baseSql = sqlOnly(baseRaw);

/* ════════════════════════════════════════════════════════════════════════
   1) YENİ RPC — imza ve parametre disiplini
════════════════════════════════════════════════════════════════════════ */
console.log("\n1) tevatur_kn_advance_if_due imzası");

const sigMatch = newSql.match(
  /create\s+or\s+replace\s+function\s+public\.tevatur_kn_advance_if_due\s*\(([\s\S]*?)\)\s*returns\s+public\.tevatur_rooms/i,
);
ok(!!sigMatch, "Fonksiyon tanımlı ve tevatur_rooms döndürüyor (no-op'ta da taze satır)");

const params = (sigMatch?.[1] ?? "").toLowerCase();
for (const p of ["p_room_id", "p_player_id", "p_claim_token", "p_expected_round", "p_expected_phase"]) {
  ok(params.includes(p), `Parametre var: ${p}`);
}
ok(!/p_host_player_id/.test(params), "Host parametresi YOK (bu yol host-only değil)");

// İstemciden ALINMAMASI gerekenler: sunucu bunları kendi kilitli satırından
// okur; parametre olsalardı istemci deadline'ı uydurabilirdi.
for (const forbidden of ["deadline", "ends_at", "endsat", "now_ms", "client", "timestamp", "guest_id", "nick", "name"]) {
  ok(!params.includes(forbidden), `İstemciden ALINMIYOR: ${forbidden}`);
}
ok((params.match(/,/g) ?? []).length === 4, "Tam 5 parametre (fazlası yok)");

/* ════════════════════════════════════════════════════════════════════════
   2) KONTROL SIRASI — yetki → üyelik → kilit → CAS → deadline
════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Gövde: kontroller ve SIRALARI");

const body = newSql.slice(newSql.indexOf("tevatur_kn_advance_if_due"));
const at = (re: RegExp): number => body.search(re);

const iAuth     = at(/if\s+not\s+public\.tevatur_authorize_player\s*\(\s*p_player_id\s*,\s*p_claim_token\s*\)/i);
const iMember   = at(/not\s+exists\s*\([\s\S]{0,200}?from\s+public\.tevatur_players[\s\S]{0,200}?room_id\s*=\s*p_room_id/i);
const iLock     = at(/select\s+\*\s+into\s+v_room\s+from\s+public\.tevatur_rooms\s+where\s+id\s*=\s*p_room_id\s+for\s+update/i);
const iStatus   = at(/v_room\.status\s*<>\s*'playing'/i);
const iCas      = at(/v_idx\s*<>\s*p_expected_round\s+or\s+v_phase\s*<>\s*p_expected_phase/i);
const iDeadline = at(/public\.tevatur_kn_now_ms\s*\(\s*\)\s*<\s*v_deadline/i);
const iChain    = at(/if\s+v_phase\s*=\s*'role_reveal'\s+then/i);

ok(iAuth     > 0, "tevatur_authorize_player ile kimlik doğrulaması var");
ok(iMember   > 0, "Oyuncu satırının BU odada olduğu doğrulanıyor (çapraz-oda token'ı kapalı)");
ok(iLock     > 0, "Oda satırı FOR UPDATE ile kilitleniyor");
ok(iStatus   > 0, "Oda status kontrolü var");
ok(iCas      > 0, "CAS: expected_round + expected_phase karşılaştırması var");
ok(iDeadline > 0, "Deadline: tevatur_kn_now_ms() < v_deadline kontrolü var");

ok(iAuth   < iMember, "SIRA: kimlik → üyelik");
ok(iMember < iLock,   "SIRA: üyelik → satır kilidi");
ok(iLock   < iStatus, "SIRA: kilit → status (okumalar kilit ALTINDA)");
ok(iLock   < iCas,    "SIRA: kilit → CAS");
ok(iCas    < iDeadline, "SIRA: CAS → deadline");
ok(iDeadline < iChain,  "SIRA: deadline → geçiş zinciri (süre dolmadan ilerleme YOK)");

// phaseEndsAt KİLİTLİ SATIRDAN okunmalı, parametreden değil.
ok(
  /v_deadline\s*:=\s*\(\s*v_state\s*->>\s*'phaseEndsAt'\s*\)\s*::\s*bigint/i.test(body),
  "phaseEndsAt kilitli satırın game_state'inden okunuyor",
);
ok(/if\s+v_deadline\s+is\s+null\s+then[\s\S]{0,60}?return\s+v_room/i.test(body),
   "phaseEndsAt null ise no-op");
ok(/v_phase\s*=\s*'final_results'[\s\S]{0,60}?return\s+v_room/i.test(body),
   "final_results terminal (ilerletilemez)");

// Reddedilen dallar exception DEĞİL no-op olmalı (yarışı kaybeden 3 çağıran
// kullanıcıya hata göstermesin + bayat istemci taze satırla onarılsın).
const casBlock = body.slice(iCas, iCas + 200);
ok(/return\s+v_room/.test(casBlock) && !/raise\s+exception/i.test(casBlock),
   "CAS reddi exception değil, no-op (taze satır döner)");

/* ════════════════════════════════════════════════════════════════════════
   3) ACL
════════════════════════════════════════════════════════════════════════ */
console.log("\n3) ACL");

ok(
  /revoke\s+all\s+on\s+function\s+public\.tevatur_kn_advance_if_due\s*\([^)]*\)\s*from\s+public/i.test(newSql),
  "advance_if_due: revoke all from public",
);
ok(
  /grant\s+execute\s+on\s+function\s+public\.tevatur_kn_advance_if_due\s*\([^)]*\)\s*to\s+anon\s*,\s*authenticated/i.test(newSql),
  "advance_if_due: grant execute to anon, authenticated (misafir KASITLI)",
);
ok(/security\s+definer/i.test(body), "advance_if_due SECURITY DEFINER");
ok(/set\s+search_path\s*=\s*public\s*,\s*auth/i.test(body), "advance_if_due search_path pinli");

// Manuel yolun ACL'ine DOKUNULMAMALI.
ok(
  !/(grant|revoke)[^;]*tevatur_kn_advance_phase/i.test(newSql),
  "advance_phase ACL'ine DOKUNULMADI",
);

/* ════════════════════════════════════════════════════════════════════════
   4) ADDITIVE — şema/RLS/mevcut fonksiyon DEĞİŞMEDİ
════════════════════════════════════════════════════════════════════════ */
console.log("\n4) Migration additive mi?");

ok(!/create\s+table/i.test(newSql),        "Tablo OLUŞTURMUYOR");
ok(!/alter\s+table/i.test(newSql),         "Tablo DEĞİŞTİRMİYOR");
ok(!/create\s+policy|drop\s+policy/i.test(newSql), "Policy dokunmuyor");
ok(!/row\s+level\s+security/i.test(newSql), "RLS dokunmuyor");
ok(!/create\s+trigger|drop\s+trigger/i.test(newSql), "Trigger dokunmuyor");
ok(!/drop\s+function/i.test(newSql),        "Fonksiyon DÜŞÜRMÜYOR");

const createdFns = [...newSql.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map(m => m[1]);
ok(
  createdFns.length === 1 && createdFns[0] === "tevatur_kn_advance_if_due",
  "Migration TEK yeni fonksiyon tanımlıyor",
  createdFns,
);
ok(
  !/create\s+or\s+replace\s+function\s+public\.tevatur_kn_advance_phase/i.test(newSql),
  "advance_phase GÖVDESİ bu migration'da yeniden tanımlanmıyor",
);

/* ════════════════════════════════════════════════════════════════════════
   5) DRIFT KİLİDİ — geçiş zinciri iki fonksiyonda BİREBİR aynı
════════════════════════════════════════════════════════════════════════ */
console.log("\n5) Geçiş zinciri drift kilidi");

/**
 * Fonksiyon gövdesinden faz geçiş zincirini çeker ve YALNIZ ÇALIŞAN SQL'e
 * indirger: satır-içi `--` yorumları da atılır (iki fonksiyonun açıklama
 * metinleri farklı olabilir; kilitlenmesi gereken şey davranıştır), sonra
 * boşluklar tek boşluğa sıkıştırılır.
 */
function extractChain(sql: string, fnName: string): string | null {
  const fnAt = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fnName}\\b`, "i"));
  if (fnAt < 0) return null;
  const rest  = sql.slice(fnAt);
  const start = rest.search(/if\s+v_phase\s*=\s*'role_reveal'\s+then/i);
  if (start < 0) return null;
  const end = rest.indexOf("$$;", start);
  if (end < 0) return null;
  return rest
    .slice(start, end)
    .split("\n")
    .map(line => line.replace(/--.*$/, ""))   // satır-içi yorum
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

const chainNew  = extractChain(newSql,  "tevatur_kn_advance_if_due");
const chainBase = extractChain(baseSql, "tevatur_kn_advance_phase");

ok(!!chainNew,  "Yeni fonksiyonun geçiş zinciri çıkarılabildi");
ok(!!chainBase, "advance_phase'in geçiş zinciri çıkarılabildi");
ok(
  !!chainNew && !!chainBase && chainNew === chainBase,
  "Geçiş zinciri BİREBİR aynı (advance_phase ↔ advance_if_due drift YOK)",
);

// Zincirin altı fazı da kapsadığını ayrıca doğrula (yanlışlıkla boşalmasın).
for (const marker of [
  "'observe_report'", "'answer_questions'", "'detective_guess'",
  "tevatur_kn_apply_round", "tevatur_kn_build_round", "'final_results'",
]) {
  ok((chainNew ?? "").includes(marker), `Zincir kapsıyor: ${marker}`);
}

/* ════════════════════════════════════════════════════════════════════════
   6) MIGRATION SIRASI
════════════════════════════════════════════════════════════════════════ */
console.log("\n6) Migration sırası");

const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
ok(files.includes(NEW_FILE), "Yeni migration klasörde");
for (const dep of [BASE_FILE, "20260809120000_guest_browse_gate_and_kornokta.sql"]) {
  ok(
    files.indexOf(NEW_FILE) > files.indexOf(dep),
    `Bağımlılıktan SONRA uygulanıyor: ${dep}`,
  );
}

/* ════════════════════════════════════════════════════════════════════════
   7) İSTEMCİ SÖZLEŞMESİ — KorNoktaGame watchdog'u
════════════════════════════════════════════════════════════════════════ */
console.log("\n7) İstemci: KorNoktaGame deadline watchdog");

const game = readFileSync(join(srcDir, "modes/korNokta/KorNoktaGame.tsx"), "utf8");
/** JSX/TS yorumlarını atar — iddialar çalışan koda dayanmalı. */
const gameCode = game
  .split("\n")
  .filter(l => {
    const t = l.trimStart();
    return !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("//");
  })
  .join("\n");

ok(
  gameCode.includes(`supabase.rpc("tevatur_kn_advance_if_due"`),
  "Otomatik yol advance_if_due çağırıyor",
);
ok(
  !gameCode.includes("tevatur_kn_advance_phase"),
  "Otomatik yoldan host-only advance_phase ARTIK çağrılmıyor",
);
ok(
  /p_player_id:\s*myId/.test(gameCode) && !/p_host_player_id/.test(gameCode),
  "RPC yükü p_player_id taşıyor (host parametresi yok)",
);

// Watchdog artık host'a kapalı OLMAMALI.
const effect = gameCode.slice(
  gameCode.indexOf("const graceMs"),
  gameCode.indexOf("}, [isHost, phase, roundIndex, phaseEndsAt, advanceIfDue]);"),
);
ok(effect.length > 0, "Watchdog effect'i bulundu");
ok(
  !/if\s*\(\s*!isHost[\s\S]{0,40}?return/.test(gameCode),
  "Watchdog `if (!isHost) return` ile KAPATILMIYOR (her üye izler)",
);

// Stagger: host önce, diğerleri sonra.
const hostGrace  = Number(gameCode.match(/ADVANCE_GRACE_HOST_MS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, ""));
const otherGrace = Number(gameCode.match(/ADVANCE_GRACE_OTHER_MS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, ""));
ok(Number.isFinite(hostGrace),  "ADVANCE_GRACE_HOST_MS tanımlı",  hostGrace);
ok(Number.isFinite(otherGrace), "ADVANCE_GRACE_OTHER_MS tanımlı", otherGrace);
ok(hostGrace > 0 && hostGrace < otherGrace,
   "Stagger: host birincil, diğer üyeler güvenlik ağı (host < diğer)", { hostGrace, otherGrace });
ok(/isHost\s*\?\s*ADVANCE_GRACE_HOST_MS\s*:\s*ADVANCE_GRACE_OTHER_MS/.test(gameCode),
   "graceMs isHost'a göre seçiliyor");

// In-flight guard korunmuş olmalı.
ok(/advanceInFlightRef\.current\)\s*return/.test(gameCode), "In-flight guard korundu");
ok(/finally\s*{\s*advanceInFlightRef\.current\s*=\s*false/.test(gameCode),
   "In-flight bayrağı finally'de sıfırlanıyor (takılı kalmaz)");

// Sunucu saati kullanılmalı (ham Date.now() ile karar verilmemeli).
ok(/getSyncedNowMs\(\)\s*>=\s*phaseEndsAt\s*\+\s*graceMs/.test(gameCode),
   "Due kararı sunucu-senkron saatle veriliyor");

// Uyanma tetikleyicileri + cleanup.
for (const ev of ["visibilitychange", "focus", "online"]) {
  ok(gameCode.includes(`addEventListener("${ev}"`), `Wake listener eklendi: ${ev}`);
  ok(gameCode.includes(`removeEventListener("${ev}"`), `Wake listener SÖKÜLÜYOR: ${ev}`);
}
ok(/check\(\);\s*\n\s*const id = window\.setInterval\(check, 500\)/.test(gameCode),
   "Mount/faz değişiminde interval beklenmeden ANINDA due kontrolü");

/* ════════════════════════════════════════════════════════════════════════
   8) KAPSAM — Rota Düello dosyalarına dokunulmadı
════════════════════════════════════════════════════════════════════════ */
console.log("\n8) Kapsam koruması");

const rdConn = readFileSync(join(srcDir, "lib/routeDuelConnection.ts"), "utf8");
ok(!/korNokta|kornokta/i.test(rdConn), "routeDuelConnection.ts Kör Nokta'ya referans VERMİYOR");
ok(
  !/routeDuel/i.test(gameCode),
  "KorNoktaGame Rota Düello modüllerinden import ETMİYOR (ortak helper sonraki iş)",
);

/* ════════════════════════════════════════════════════════════════════════ */
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
