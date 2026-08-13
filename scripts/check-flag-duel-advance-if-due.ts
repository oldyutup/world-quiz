/**
 * check-flag-duel-advance-if-due.ts
 *
 * Bayrak Düello "sunucu-otoriter tur ilerletme" SÖZLEŞMESİNİ saf/DB'siz
 * doğrular. Gerçek Supabase ve tarayıcı GEREKMEZ.
 *
 * NEDEN VAR
 * ─────────
 * Tur ilerletme eskiden TEK bir tarayıcıya (host'un realtime handler'ı +
 * timer'ı) bağlıydı ve üç ayrı yerden SPOF üretiyordu:
 *   (1) sıradaki bayrak host'un RAM'indeki `flagPoolRef` (Math.random ile
 *       kurulmuş, rakiple FARKLI) havuzundaydı,
 *   (2) `advanceRoundAsHost` `if (!isHostRef.current) return;` ile başlıyordu,
 *   (3) TIMEOUT claim'ini yalnız host yazıyordu.
 * Host uygulamayı arka plana atınca maç İKİ oyuncu için birden donuyordu.
 *
 * 20260813130000 üç ayağı da kesti: bayrak sırası `duel_rooms.flag_sequence`e
 * persist edildi, `flag_duel_advance_if_due` eklendi (her üye çağırır, SUNUCU
 * süreyi kendi saatiyle doğrular), TIMEOUT claim'ini sunucu yazıyor.
 *
 * Bu dosya üç şeyi kilitler:
 *   1. GÜVENLİK — yeni RPC'lerin kontrolleri ve SIRASI; host-only manuel
 *      yolların (set_next_round / finalize_game) DEĞİŞMEMİŞ olması.
 *   2. İSTEMCİ SÖZLEŞMESİ — host-only otomatik yolun tamamen kalkmış olması,
 *      watchdog'un her istemcide çalışması, uyanma tetikleyicileri.
 *   3. DRIFT — istemci ile sunucudaki zaman sabitleri (10 sn / 2000 ms /
 *      700 ms) ve pas kotası tablosu BİREBİR aynı kalmalı. İkisi ayrı dilde
 *      yazıldığı için eşitlik ancak testle korunabilir.
 *
 * KAPSAM DIŞI (kasıtlı): çalışma-zamanı davranışı. Kilit/CAS/deadline/altın tur
 * semantiği gerçek Postgres'te ayrıca clean-room ile doğrulandı (84 assert);
 * burada YALNIZ sözleşmenin kaynak kodda durduğu doğrulanır.
 *
 * DRIFT UYARISI: bu dosya migration'ın ve FlagDuelGame'in AYNASIDIR.
 *
 * Çalıştır:  npx tsx scripts/check-flag-duel-advance-if-due.ts
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

const NEW_FILE  = "20260813130000_flag_duel_advance_if_due.sql";
const BASE_FILE = "20260612120000_flag_duel_rpc_hardening.sql";

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
   1) advance_if_due — imza ve parametre disiplini
════════════════════════════════════════════════════════════════════════ */
console.log("\n1) flag_duel_advance_if_due imzası");

const sigMatch = newSql.match(
  /create\s+or\s+replace\s+function\s+public\.flag_duel_advance_if_due\s*\(([\s\S]*?)\)\s*returns\s+public\.duel_rooms/i,
);
ok(!!sigMatch, "Fonksiyon tanımlı ve duel_rooms döndürüyor (no-op'ta da taze satır)");

const params = (sigMatch?.[1] ?? "").toLowerCase();
for (const p of ["p_room_id", "p_player_id", "p_claim_token", "p_expected_round", "p_expected_flag"]) {
  ok(params.includes(p), `Parametre var: ${p}`);
}
ok(!/p_host_player_id/.test(params), "Host parametresi YOK (bu yol host-only değil)");
ok((params.match(/,/g) ?? []).length === 4, "Tam 5 parametre (fazlası yok)");

// İstemciden ALINMAMASI gerekenler. Sunucu bunları kendi kilitli satırından /
// duel_claims.created_at'ten okur; parametre olsalardı istemci deadline'ı,
// bayrağı ya da kazananı uydurabilirdi.
for (const forbidden of [
  "deadline", "ends_at", "endsat", "now", "client", "timestamp", "elapsed",
  "next_flag", "winner", "score", "guest_id", "nick", "name", "reason",
]) {
  ok(!params.includes(forbidden), `İstemciden ALINMIYOR: ${forbidden}`);
}

/* ════════════════════════════════════════════════════════════════════════
   2) advance_if_due gövdesi — kontroller ve SIRALARI
════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Gövde: kontroller ve SIRALARI");

const body = newSql.slice(newSql.indexOf("create or replace function public.flag_duel_advance_if_due"));
const at = (re: RegExp): number => body.search(re);

const iAuth     = at(/if\s+not\s+public\.flag_duel_authorize_player\s*\(\s*p_player_id\s*,\s*p_claim_token\s*\)/i);
const iMember   = at(/not\s+exists\s*\([\s\S]{0,200}?from\s+public\.duel_players[\s\S]{0,120}?room_id\s*=\s*p_room_id/i);
const iLock     = at(/select\s+\*\s+into\s+v_room\s+from\s+public\.duel_rooms\s+where\s+id\s*=\s*p_room_id\s+for\s+update/i);
const iStatus   = at(/v_room\.status\s*<>\s*'playing'/i);
const iCas      = at(/v_room\.current_round\s+is\s+distinct\s+from\s+p_expected_round/i);
const iDeadline = at(/v_now\s*<\s*v_room\.current_flag_at\s*\+/i);
const iAdvance  = at(/if\s+v_reason\s*=\s*'both_passed'\s+then/i);

ok(iAuth     > 0, "flag_duel_authorize_player ile kimlik doğrulaması var");
ok(iMember   > 0, "Oyuncu satırının BU odada olduğu doğrulanıyor (çapraz-oda token'ı kapalı)");
ok(iLock     > 0, "Oda satırı FOR UPDATE ile kilitleniyor");
ok(iStatus   > 0, "Oda status kontrolü var");
ok(iCas      > 0, "CAS: current_round karşılaştırması var");
ok(at(/v_flag\s+is\s+distinct\s+from\s+p_expected_flag/i) > 0, "CAS: current_flag karşılaştırması var");
ok(iDeadline > 0, "Deadline: current_flag_at + timeout kontrolü var");

ok(iAuth   < iMember, "SIRA: kimlik → üyelik");
ok(iMember < iLock,   "SIRA: üyelik → satır kilidi");
ok(iLock   < iStatus, "SIRA: kilit → status (okumalar kilit ALTINDA)");
ok(iLock   < iCas,    "SIRA: kilit → CAS");
ok(iCas    < iDeadline, "SIRA: CAS → deadline");
ok(iDeadline < iAdvance, "SIRA: deadline → ilerletme (süre dolmadan geçiş YOK)");

// Deadline KİLİTLİ SATIRDAN / sunucu saatinden okunmalı.
ok(/v_now\s+timestamptz\s*:=\s*now\(\)/i.test(body), "Sunucu saati now() ile alınıyor");
ok(
  /v_now\s*<\s*v_room\.current_flag_at\s*\+\s*[\s\S]{0,80}?flag_duel_flag_timeout_seconds\s*\(\s*\)/i.test(body),
  "Bayrak süresi kilitli satırın current_flag_at'inden hesaplanıyor",
);
// Reveal penceresi de SUNUCU verisinden (claim.created_at) gelmeli.
ok(/v_resolved_at\s*:=\s*v_answer_at/i.test(body),  "Çözülme anı: cevabın created_at'i");
ok(/v_resolved_at\s*:=\s*v_timeout_at/i.test(body), "Çözülme anı: TIMEOUT claim'inin created_at'i");
ok(/v_resolved_at\s*:=\s*v_pass_at/i.test(body),    "Çözülme anı: son PASS claim'inin created_at'i");
ok(
  /v_now\s*<\s*v_resolved_at\s*\+\s*make_interval\s*\(\s*secs\s*=>\s*v_delay_ms\s*\/\s*1000/i.test(body),
  "Reveal penceresi sunucu saatiyle doğrulanıyor",
);

// Reddedilen dallar exception DEĞİL no-op olmalı (yarışı kaybeden çağıran
// kullanıcıya hata göstermesin + bayat istemci taze satırla onarılsın).
const casBlock = body.slice(iCas, iCas + 260);
ok(/return\s+v_room/.test(casBlock) && !/raise\s+exception/i.test(casBlock),
   "CAS reddi exception değil, no-op (taze satır döner)");

// TIMEOUT claim'ini SUNUCU yazmalı ve idempotent olmalı.
ok(
  /insert\s+into\s+public\.duel_claims[\s\S]{0,200}?on\s+conflict\s+do\s+nothing/i.test(body),
  "TIMEOUT claim'i sunucuda yazılıyor ve idempotent (on conflict do nothing)",
);

// UPDATE'lerin HEPSİ CAS koşullu olmalı (çift ilerleme kapısı).
const updates = [...body.matchAll(/update\s+public\.duel_rooms[\s\S]*?returning\s+\*\s+into\s+v_room/gi)]
  .map(m => m[0]);
ok(updates.length >= 5, "Beklenen sayıda duel_rooms UPDATE'i var", updates.length);
ok(
  updates.every(u => /where\s+id\s*=\s*p_room_id/i.test(u)),
  "Her UPDATE oda id'siyle sınırlı",
);
const casGuarded = updates.filter(
  u => /current_round\s*=\s*p_expected_round/i.test(u) && /current_flag\s*=\s*p_expected_flag/i.test(u),
);
ok(
  casGuarded.length === updates.length - 1,
  "Onarım UPDATE'i hariç TÜM UPDATE'ler CAS koşullu (çift ilerleme imkânsız)",
  { total: updates.length, casGuarded: casGuarded.length },
);
ok(
  updates.some(u => /current_flag\s+is\s+null/i.test(u)),
  "Onarım UPDATE'i kendi CAS'ını kullanıyor (current_flag is null)",
);

// finished_at YAZILMAMALI — kolon canlı şemada YOK (20260613120000).
ok(!/finished_at/i.test(newSql), "finished_at'e YAZILMIYOR (kolon canlı şemada yok)");

// Sıradaki bayrak PERSIST EDİLMİŞ diziden gelmeli.
ok(
  /v_next_flag\s*:=\s*public\.flag_duel_next_flag\s*\(\s*p_room_id\s*,\s*v_room\.flag_sequence\s*\)/i.test(body),
  "Sıradaki bayrak flag_sequence'ten seçiliyor (istemci öneremez)",
);
// Kazanan SUNUCUDA sayılmalı.
ok(
  /v_winner\s*:=\s*public\.flag_duel_score_winner\s*\(\s*p_room_id\s*\)/i.test(body),
  "Kazanan sunucuda sayılıyor (istemci söyleyemez)",
);

/* ════════════════════════════════════════════════════════════════════════
   3) set_flag_sequence — host-only + girdi disiplini
════════════════════════════════════════════════════════════════════════ */
console.log("\n3) flag_duel_set_flag_sequence");

const seqBody = newSql.slice(
  newSql.indexOf("create or replace function public.flag_duel_set_flag_sequence"),
  newSql.indexOf("create or replace function public.flag_duel_advance_if_due"),
);
ok(seqBody.length > 0, "Fonksiyon tanımlı");
ok(
  /if\s+not\s+public\.flag_duel_authorize_host\s*\(\s*p_room_id\s*,\s*p_host_player_id\s*,\s*p_claim_token\s*\)/i.test(seqBody),
  "HOST-ONLY (authorize_host) — bugünkü güven modeli korunuyor",
);
ok(/for\s+update/i.test(seqBody), "Oda satırı FOR UPDATE ile kilitleniyor");
ok(/v_room\.status\s+not\s+in\s*\(\s*'waiting'\s*,\s*'playing'\s*\)/i.test(seqBody),
   "Yalnız waiting/playing odaya yazılabilir");
for (const guard of [
  ["flag_sequence_required",  /cardinality\s*\(\s*p_flag_sequence\s*\)\s*=\s*0/i],
  ["flag_sequence_too_long",  /cardinality\s*\(\s*p_flag_sequence\s*\)\s*>\s*512/i],
  ["flag_sequence_duplicate", /v_uniq\s*<>\s*v_count/i],
  ["flag_sequence_invalid",   /length\s*\(\s*x\s*\)\s*>\s*8/i],
]) {
  ok((guard[1] as RegExp).test(seqBody), `Girdi kontrolü var: ${guard[0] as string}`);
}
// NULL elemanı ÖNCE elenmeli: count(distinct) NULL saymaz, sonra bakılırsa
// ['TR', null] yanlışlıkla "duplicate" olarak raporlanır.
const iNullChk = seqBody.search(/where\s+x\s+is\s+null/i);
const iDupChk  = seqBody.search(/v_uniq\s*<>\s*v_count/i);
ok(iNullChk > 0 && iNullChk < iDupChk,
   "SIRA: NULL eleman kontrolü tekrar kontrolünden ÖNCE", { iNullChk, iDupChk });

/* ════════════════════════════════════════════════════════════════════════
   4) ACL
════════════════════════════════════════════════════════════════════════ */
console.log("\n4) ACL");

for (const [fn, args] of [
  ["flag_duel_advance_if_due",    "uuid, uuid, uuid, int, text"],
  ["flag_duel_set_flag_sequence", "uuid, uuid, uuid, text\\[\\]"],
] as const) {
  ok(
    new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*from\\s+public`, "i").test(newSql),
    `${fn}: revoke all from public`,
  );
  ok(
    new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\(${args}\\)\\s*to\\s+anon\\s*,\\s*authenticated`, "i").test(newSql),
    `${fn}: grant execute to anon, authenticated (AÇIK — varsayılana güvenilmiyor)`,
  );
}

// İç helper'lar anon/authenticated'a KAPALI olmalı (Supabase'de public
// şemadaki yeni fonksiyonlar anon'a DOĞRUDAN doğar; açıkça geri alınmalı).
for (const fn of [
  "flag_duel_next_flag", "flag_duel_used_flag_codes", "flag_duel_score_winner",
  "flag_duel_pass_quota", "flag_duel_flag_timeout_seconds",
  "flag_duel_reveal_delay_ms", "flag_duel_pass_reveal_ms",
]) {
  ok(
    new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*from\\s+anon\\s*,\\s*authenticated`, "i").test(newSql),
    `${fn}: anon+authenticated EXECUTE açıkça geri alındı`,
  );
  ok(
    !new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\b[^;]*to\\s+anon`, "i").test(newSql),
    `${fn}: anon'a grant YOK`,
  );
}

for (const fn of ["flag_duel_advance_if_due", "flag_duel_set_flag_sequence"]) {
  const fnBody = newSql.slice(newSql.indexOf(`create or replace function public.${fn}`));
  ok(/security\s+definer/i.test(fnBody.slice(0, 600)), `${fn}: SECURITY DEFINER`);
  ok(/set\s+search_path\s*=\s*public\s*,\s*auth/i.test(fnBody.slice(0, 600)),
     `${fn}: search_path pinli`);
}

/* ════════════════════════════════════════════════════════════════════════
   5) ADDITIVE — mevcut RPC'ler ve RLS DEĞİŞMEDİ
════════════════════════════════════════════════════════════════════════ */
console.log("\n5) Migration additive mi?");

ok(!/create\s+table/i.test(newSql),                  "Tablo OLUŞTURMUYOR");
ok(!/create\s+policy|drop\s+policy/i.test(newSql),   "Policy dokunmuyor");
ok(!/row\s+level\s+security/i.test(newSql),          "RLS dokunmuyor");
ok(!/create\s+trigger|drop\s+trigger/i.test(newSql), "Trigger dokunmuyor");
ok(!/drop\s+function/i.test(newSql),                 "Fonksiyon DÜŞÜRMÜYOR (DROP+CREATE anon'u geri getirirdi)");
ok(!/drop\s+column|alter\s+column/i.test(newSql),    "Kolon düşürmüyor/değiştirmiyor");

const alters = [...newSql.matchAll(/alter\s+table\s+public\.(\w+)([\s\S]*?);/gi)];
ok(alters.length === 1, "Tek ALTER TABLE var", alters.length);
ok(alters[0]?.[1] === "duel_rooms", "ALTER hedefi duel_rooms", alters[0]?.[1]);
ok(
  /add\s+column\s+if\s+not\s+exists\s+flag_sequence\s+text\[\]/i.test(alters[0]?.[2] ?? ""),
  "Yalnız `add column if not exists flag_sequence text[]` (nullable, default yok)",
);
ok(
  !/not\s+null|default/i.test(alters[0]?.[2] ?? ""),
  "Yeni kolonda NOT NULL / DEFAULT yok → mevcut satırlar etkilenmez",
);

// Mevcut Flag Duel RPC'lerinin GÖVDESİ veya ACL'i bu migration'da yeniden
// tanımlanmamalı.
for (const fn of [
  "flag_duel_start_game", "flag_duel_set_next_round", "flag_duel_finalize_game",
  "flag_duel_accept_rematch", "flag_duel_submit_claim", "flag_duel_leave_room",
  "flag_duel_create_room", "flag_duel_update_settings", "flag_duel_quick_match",
  "flag_duel_authorize_host", "flag_duel_authorize_player",
]) {
  ok(
    !new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\b`, "i").test(newSql),
    `${fn} GÖVDESİ bu migration'da yeniden tanımlanmıyor`,
  );
  ok(
    !new RegExp(`(grant|revoke)[^;]*\\b${fn}\\s*\\(`, "i").test(newSql),
    `${fn} ACL'ine DOKUNULMADI`,
  );
}

// Diğer modlara sızıntı yok.
for (const foreign of ["tevatur_", "conquest_", "wheel_", "route_duel_", "flag_group_"]) {
  ok(!newSql.includes(foreign), `Kapsam dışı moda dokunmuyor: ${foreign}*`);
}

/* ════════════════════════════════════════════════════════════════════════
   6) DRIFT KİLİDİ — kazanan kuralı finalize_game ile aynı
════════════════════════════════════════════════════════════════════════ */
console.log("\n6) Kazanan kuralı drift kilidi");

/** Bir fonksiyon gövdesinden "gerçek claim sayımı" sorgularını çeker ve
 *  yalnız çalışan SQL'e indirger (boşluklar sıkıştırılır). */
function extractCounting(sql: string, fnName: string): string | null {
  const fnAt = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fnName}\\b`, "i"));
  if (fnAt < 0) return null;
  const rest = sql.slice(fnAt);
  const end  = rest.indexOf("$$;");
  if (end < 0) return null;
  const chunk = rest.slice(0, end);
  const parts = [...chunk.matchAll(
    /select\s+count\(\*\)\s+as\s+cnt[\s\S]*?limit\s+1/gi,
  )].map(m => m[0].replace(/--.*$/gm, "").replace(/\s+/g, " ").trim());
  const first = chunk.match(
    /select\s+player_id,\s*count\(\*\)\s+as\s+cnt[\s\S]*?limit\s+1/i,
  );
  if (!first) return null;
  return [first[0].replace(/--.*$/gm, "").replace(/\s+/g, " ").trim(), ...parts].join(" || ");
}

const countNew  = extractCounting(newSql,  "flag_duel_score_winner");
const countBase = extractCounting(baseSql, "flag_duel_finalize_game");
ok(!!countNew,  "score_winner'ın sayım sorguları çıkarılabildi");
ok(!!countBase, "finalize_game'in sayım sorguları çıkarılabildi");
ok(
  !!countNew && !!countBase && countNew === countBase,
  "Kazanan sayımı BİREBİR aynı (finalize_game ↔ score_winner drift YOK)",
);
for (const marker of ["not like 'PASS:%'", "not like 'TIMEOUT:%'", "order by count(*) desc"]) {
  ok((countNew ?? "").includes(marker), `Sayım kapsıyor: ${marker}`);
}
ok(
  /if\s+v_second_cnt\s+is\s+not\s+null\s+and\s+v_second_cnt\s*=\s*v_top_cnt/i.test(newSql),
  "Beraberlik semantiği korundu (top-1 == top-2 → kazanan NULL)",
);

/* ════════════════════════════════════════════════════════════════════════
   7) MIGRATION SIRASI
════════════════════════════════════════════════════════════════════════ */
console.log("\n7) Migration sırası");

const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
ok(files.includes(NEW_FILE), "Yeni migration klasörde");
for (const dep of [
  BASE_FILE,
  "20260613120000_flag_duel_patch_finished_at.sql",
  "20260620120000_flag_duel_quick_match_set_host.sql",
  "20260709120000_flag_duel_display_name_guard.sql",
]) {
  ok(files.indexOf(NEW_FILE) > files.indexOf(dep), `Bağımlılıktan SONRA uygulanıyor: ${dep}`);
}

/* ════════════════════════════════════════════════════════════════════════
   8) İSTEMCİ SÖZLEŞMESİ — FlagDuelGame watchdog'u
════════════════════════════════════════════════════════════════════════ */
console.log("\n8) İstemci: FlagDuelGame deadline watchdog");

const game = readFileSync(join(srcDir, "components/FlagDuelGame.tsx"), "utf8");
/** JSX/TS yorumlarını atar — iddialar çalışan koda dayanmalı, açıklama metni
 *  bir testi yanlışlıkla geçiremez (ya da düşüremez). Blok yorumlar tam olarak
 *  silinir; satır yorumları YALNIZ satır başındaysa atılır (kod içindeki
 *  "https://" gibi diziler bozulmasın). */
const gameCode = game
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter(l => !l.trimStart().startsWith("//"))
  .join("\n");

ok(gameCode.includes(`supabase.rpc("flag_duel_advance_if_due"`), "Otomatik yol advance_if_due çağırıyor");
ok(gameCode.includes(`supabase.rpc("flag_duel_set_flag_sequence"`), "Host bayrak sırasını persist ediyor");

// SPOF'un üç ayağı da kalkmış olmalı.
ok(!/advanceRoundAsHost/.test(gameCode), "advanceRoundAsHost KALDIRILDI");
ok(!gameCode.includes(`supabase.rpc("flag_duel_set_next_round"`),
   "Otomatik yoldan host-only set_next_round ARTIK çağrılmıyor");
ok(!gameCode.includes(`supabase.rpc("flag_duel_finalize_game"`),
   "Otomatik yoldan host-only finalize_game ARTIK çağrılmıyor");
ok(
  !/TIMEOUT:R\$\{[^}]*\}:\$\{[^}]*\}`?,?\s*\n?\s*\}\);/.test(gameCode)
    && !/p_country_code:\s*`TIMEOUT:/.test(gameCode),
  "TIMEOUT claim'ini istemci ARTIK yazmıyor (sunucu yazıyor)",
);

ok(/p_player_id:\s*myIdRef\.current/.test(gameCode) , "advance RPC yükü p_player_id taşıyor");
ok(
  !/flag_duel_advance_if_due[\s\S]{0,400}?p_host_player_id/.test(gameCode),
  "advance RPC yükünde host parametresi YOK",
);
// İstemci deadline/bayrak/kazanan GÖNDERMEMELİ.
const advPayload = gameCode.slice(
  gameCode.indexOf(`supabase.rpc("flag_duel_advance_if_due"`),
  gameCode.indexOf(`supabase.rpc("flag_duel_advance_if_due"`) + 400,
);
for (const forbidden of ["p_deadline", "p_now", "p_next_flag", "p_winner", "Date.now()"]) {
  ok(!advPayload.includes(forbidden), `advance yükünde YOK: ${forbidden}`);
}

// Watchdog artık host'a kapalı OLMAMALI.
ok(
  !/const\s+check\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,200}?if\s*\(\s*!isHost/.test(gameCode),
  "Watchdog `if (!isHost) return` ile KAPATILMIYOR (her üye izler)",
);

// Stagger: host önce, rakip sonra.
const hostGrace  = Number(gameCode.match(/ADVANCE_GRACE_HOST_MS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, ""));
const otherGrace = Number(gameCode.match(/ADVANCE_GRACE_OTHER_MS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, ""));
ok(Number.isFinite(hostGrace),  "ADVANCE_GRACE_HOST_MS tanımlı",  hostGrace);
ok(Number.isFinite(otherGrace), "ADVANCE_GRACE_OTHER_MS tanımlı", otherGrace);
ok(hostGrace > 0 && hostGrace < otherGrace,
   "Stagger: host birincil, rakip güvenlik ağı (host < diğer)", { hostGrace, otherGrace });
ok(/isHost\s*\?\s*ADVANCE_GRACE_HOST_MS\s*:\s*ADVANCE_GRACE_OTHER_MS/.test(gameCode),
   "graceMs isHost'a göre seçiliyor");

// In-flight guard.
ok(/if\s*\(advancingRef\.current\)\s*return/.test(gameCode), "In-flight guard var");
ok(/finally\s*\{\s*\n?\s*advancingRef\.current\s*=\s*false/.test(gameCode),
   "In-flight bayrağı finally'de sıfırlanıyor (takılı kalmaz)");

// Sunucu saati kullanılmalı (ham Date.now() ile karar verilmemeli).
ok(/const\s+now\s*=\s*getSyncedNowMs\(\);\s*\n\s*if\s*\(now\s*<\s*watchdogDueAtMs\s*\+\s*graceMs\)\s*return;/.test(gameCode),
   "Due kararı sunucu-senkron saatle veriliyor");

// Uyanma tetikleyicileri + cleanup.
for (const ev of ["visibilitychange", "focus", "online"]) {
  ok(gameCode.includes(`addEventListener("${ev}"`), `Wake listener eklendi: ${ev}`);
  ok(gameCode.includes(`removeEventListener("${ev}"`), `Wake listener SÖKÜLÜYOR: ${ev}`);
}
ok(/check\(\);\s*\n\s*const id = window\.setInterval\(check, 500\)/.test(gameCode),
   "Mount/tur değişiminde interval beklenmeden ANINDA due kontrolü");
ok(/const checkNow = \(\) => \{ attempts = 0; lastAttemptMs = 0; check\(\); \};/.test(gameCode),
   "Uyanma olayları backoff sayacını sıfırlıyor (arka plandan dönüş anında denenir)");

// Realtime claim handler'ı artık host'a kilitli olmamalı.
const claimHandler = gameCode.slice(
  gameCode.indexOf(`table: "duel_claims"`),
  gameCode.indexOf(`.subscribe()`),
);
ok(claimHandler.length > 0, "duel_claims INSERT handler'ı bulundu");
ok(/setClaims\(prev/.test(claimHandler), "Handler claim'i her istemcide state'e yazıyor");
ok(!/isHostRef\.current/.test(claimHandler),
   "Handler'daki host-only kapı KALDIRILDI (rakip de otoriter state'i görür)");

// Bayrak sırası maçı BAŞLATMADAN ÖNCE yazılmalı (SPOF penceresi kalmasın).
const startIdx = gameCode.indexOf("const startGame = async () => {");
const startBlock = gameCode.slice(startIdx, startIdx + 900);
ok(
  startBlock.indexOf("persistFlagSequence") > 0 &&
  startBlock.indexOf("persistFlagSequence") < startBlock.indexOf(`rpc("flag_duel_start_game"`),
  "startGame: sıra START'TAN ÖNCE yazılıyor",
);

/* ════════════════════════════════════════════════════════════════════════
   9) SABİT DRIFT KİLİDİ — istemci ↔ sunucu zaman/kota tablosu
════════════════════════════════════════════════════════════════════════ */
console.log("\n9) Sabitler: istemci ↔ sunucu");

const sqlTimeout = Number(newSql.match(/flag_duel_flag_timeout_seconds\(\)[\s\S]*?select\s+(\d+)\s*;/i)?.[1]);
const sqlReveal  = Number(newSql.match(/flag_duel_reveal_delay_ms\(\)[\s\S]*?select\s+(\d+)\s*;/i)?.[1]);
const sqlPass    = Number(newSql.match(/flag_duel_pass_reveal_ms\(\)[\s\S]*?select\s+(\d+)\s*;/i)?.[1]);

const tsTimeout = Number(gameCode.match(/FLAG_TIMEOUT_SEC\s*=\s*(\d+)/)?.[1]);
const tsReveal  = Number(gameCode.match(/REVEAL_DELAY_MS\s*=\s*(\d+)/)?.[1]);
const tsPass    = Number(gameCode.match(/PASS_REVEAL_MS\s*=\s*(\d+)/)?.[1]);

ok(sqlTimeout === tsTimeout && Number.isFinite(sqlTimeout),
   "FLAG_TIMEOUT_SEC ↔ flag_duel_flag_timeout_seconds() aynı", { sqlTimeout, tsTimeout });
ok(sqlReveal === tsReveal && Number.isFinite(sqlReveal),
   "REVEAL_DELAY_MS ↔ flag_duel_reveal_delay_ms() aynı", { sqlReveal, tsReveal });
ok(sqlPass === tsPass && Number.isFinite(sqlPass),
   "PASS_REVEAL_MS ↔ flag_duel_pass_reveal_ms() aynı", { sqlPass, tsPass });

/** SQL `case when p_total_rounds <= N then M … else K end` tablosunu okur. */
function sqlPassQuota(): Array<[number, number]> {
  const blk = newSql.match(/flag_duel_pass_quota[\s\S]*?case([\s\S]*?)end\s*;/i)?.[1] ?? "";
  const rows: Array<[number, number]> = [...blk.matchAll(/when\s+p_total_rounds\s*<=\s*(\d+)\s*then\s*(\d+)/gi)]
    .map(m => [Number(m[1]), Number(m[2])]);
  const els = blk.match(/else\s+(\d+)/i);
  if (els) rows.push([Number.POSITIVE_INFINITY, Number(els[1])]);
  return rows;
}
/** TSX `passQuota()` gövdesindeki aynı tabloyu okur. */
function tsPassQuota(): Array<[number, number]> {
  const blk = gameCode.match(/function\s+passQuota\s*\([\s\S]*?\n\}/)?.[0] ?? "";
  const rows: Array<[number, number]> = [...blk.matchAll(/totalRounds\s*<=\s*(\d+)\)\s*return\s*(\d+)/g)]
    .map(m => [Number(m[1]), Number(m[2])]);
  const tail = blk.match(/return\s+(\d+)\s*;\s*\n\}/);
  if (tail) rows.push([Number.POSITIVE_INFINITY, Number(tail[1])]);
  return rows;
}
const qSql = sqlPassQuota();
const qTs  = tsPassQuota();
ok(qSql.length === 4, "SQL pas kotası tablosu 4 satır", qSql);
ok(qTs.length === 4,  "TSX pas kotası tablosu 4 satır", qTs);
ok(JSON.stringify(qSql) === JSON.stringify(qTs),
   "Pas kotası tablosu istemci ↔ sunucu BİREBİR aynı", { qSql, qTs });

/* ════════════════════════════════════════════════════════════════════════
   10) KAPSAM KORUMASI — başka modlara dokunulmadı
════════════════════════════════════════════════════════════════════════ */
console.log("\n10) Kapsam koruması");

for (const rel of [
  "components/DuelGame.tsx",
  "modes/korNokta/KorNoktaGame.tsx",
] as const) {
  const other = readFileSync(join(srcDir, rel), "utf8");
  ok(!other.includes("flag_duel_advance_if_due"), `${rel} yeni RPC'yi ÇAĞIRMIYOR`);
  ok(!other.includes("flag_duel_set_flag_sequence"), `${rel} sıra RPC'sini ÇAĞIRMIYOR`);
}
// Ülke 1v1 aynı duel_rooms tablosunu paylaşır — yeni kolonu okumamalı/yazmamalı.
const duelGame = readFileSync(join(srcDir, "components/DuelGame.tsx"), "utf8");
ok(!duelGame.includes("flag_sequence"), "DuelGame (Ülke 1v1) flag_sequence'e DOKUNMUYOR");

/* ════════════════════════════════════════════════════════════════════════ */
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
