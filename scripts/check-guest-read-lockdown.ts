/**
 * check-guest-read-lockdown.ts
 *
 * "Misafir başka odaları enumerate edemez" SÖZLEŞMESİNİ saf/DB'siz doğrular.
 * Gerçek Supabase GEREKMEZ.
 *
 * Kapsam:
 *   1. Kör Nokta kilidi   — 20260811120000_kornokta_guest_read_lockdown.sql
 *   2. Kuşatma regresyonu — 20260810120000_conquest_guest_read_lockdown…sql
 *   3. İstemci sözleşmesi — hiçbir yerde ham tablo SELECT'i kalmadı mı?
 *   4. Migration sırası   — kilit dosyaları bağımlılıklarından SONRA mı?
 *
 * DRIFT UYARISI: bu dosya migration'ların AYNASIDIR. SQL değişirse burası da
 * güncellenmeli.
 *
 * Çalıştır:  npx tsx scripts/check-guest-read-lockdown.ts
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

const KN_FILE = "20260811120000_kornokta_guest_read_lockdown.sql";
const CQ_FILE = "20260810120000_conquest_guest_read_lockdown_and_host_rules.sql";

const kn = readFileSync(join(migrationsDir, KN_FILE), "utf8");
const cq = readFileSync(join(migrationsDir, CQ_FILE), "utf8");

/** Yorum satırlarını atar — iddialar YALNIZ çalışan SQL üzerinde kurulmalı,
 *  yoksa bir açıklama metni testi yanlışlıkla geçirebilir. */
function sqlOnly(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.trimStart().startsWith("--"))
    .join("\n");
}

const knSql = sqlOnly(kn);
const cqSql = sqlOnly(cq);

/* ════════════════════════════════════════════════════════════════════════
   1) KÖR NOKTA — ham anon okuma kapandı mı?
════════════════════════════════════════════════════════════════════════ */
console.log("\n1) Kör Nokta ham anon SELECT kilidi");

for (const table of ["tevatur_rooms", "tevatur_players"]) {
  ok(
    new RegExp(`revoke\\s+select\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon`, "i").test(knSql),
    `${table}: anon SELECT grant'i geri alındı`,
  );
  ok(
    new RegExp(`drop policy if exists "${table}_select_public"`, "i").test(knSql),
    `${table}: eski "select_public" policy'si düşürüldü`,
  );
  const policy = new RegExp(
    `create policy "${table}_select_auth"[\\s\\S]{0,200}?for select[\\s\\S]{0,80}?to authenticated`,
    "i",
  );
  ok(policy.test(knSql), `${table}: yeni SELECT policy'si YALNIZ authenticated`);
  ok(
    !new RegExp(`create policy[^;]*on public\\.${table}[^;]*to anon`, "i").test(knSql),
    `${table}: anon'a policy TANIMLANMADI`,
  );
}

ok(
  /for pol in[\s\S]*?pg_policies[\s\S]*?tevatur_rooms['\s,]*'tevatur_players'[\s\S]*?'anon'\s*=\s*any\(roles\)/i.test(knSql),
  "Süpürücü blok: anon'a açık ARTIK policy'ler dinamik olarak düşürülüyor",
);

/* ════════════════════════════════════════════════════════════════════════
   2) KÖR NOKTA — yetkili okuma RPC'si
════════════════════════════════════════════════════════════════════════ */
console.log("\n2) tevatur_get_room_state sözleşmesi");

const rpcBody =
  knSql.match(/create or replace function public\.tevatur_get_room_state[\s\S]*?\n\$\$;/i)?.[0] ?? "";

ok(rpcBody.length > 0, "tevatur_get_room_state tanımlı");
ok(/security definer/i.test(rpcBody), "SECURITY DEFINER");
ok(/set search_path\s*=\s*public, auth/i.test(rpcBody), "search_path sabitlenmiş");
ok(/\bstable\b/i.test(rpcBody), "STABLE (yazma yapmaz)");

ok(
  /p_room_id\s+uuid,\s*\n\s*p_player_id\s+uuid,\s*\n\s*p_claim_token\s+uuid/i.test(rpcBody),
  "İmza: tek room_id + player_id + claim_token (filtre/limit/order YOK)",
);
ok(
  !/\b(p_limit|p_offset|p_order|p_filter|p_status|p_search)\b/i.test(rpcBody),
  "Enumerasyona yarayacak parametre YOK",
);

ok(
  /p\.id\s*=\s*p_player_id[\s\S]{0,120}p\.room_id\s*=\s*p_room_id/i.test(rpcBody),
  "Üyelik İKİ şart ister: satır bana ait VE satır İSTENEN odada",
);
ok(
  /public\.tevatur_authorize_player\(p_player_id,\s*p_claim_token\)/i.test(rpcBody),
  "claim_token merkezî authorize helper'ıyla doğrulanıyor",
);
ok(
  /'ok',\s*false,\s*'reason',\s*'not_a_member'/i.test(rpcBody),
  "Üye olmayan / var olmayan oda → aynı genel cevap (not_a_member)",
);
ok(
  !/tevatur_player_claims/i.test(rpcBody),
  "claim_token cevaba GİRMİYOR (claims tablosu sorguya hiç girmiyor)",
);
ok(
  !/guest_id/i.test(rpcBody),
  "guest_id expose EDİLMİYOR",
);
ok(
  /jsonb_build_object\(\s*\n?\s*'id',\s*p\.id/i.test(rpcBody) && !/to_jsonb\(p\)/i.test(rpcBody),
  "Oyuncu alanları TEK TEK sayılıyor (to_jsonb(p) ile toptan sızma yok)",
);

ok(
  /revoke all\s+on function public\.tevatur_get_room_state\(uuid, uuid, uuid\) from public/i.test(knSql),
  "RPC: public'ten revoke",
);
ok(
  /grant\s+execute on function public\.tevatur_get_room_state\(uuid, uuid, uuid\) to anon, authenticated/i.test(knSql),
  "RPC: anon + authenticated'a execute",
);

/* ════════════════════════════════════════════════════════════════════════
   3) KÖR NOKTA — sinyal yayını (veri taşımaz)
════════════════════════════════════════════════════════════════════════ */
console.log("\n3) Broadcast sinyali");

for (const fn of ["tevatur_broadcast_room_signal", "tevatur_broadcast_player_signal"]) {
  const body = knSql.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`, "i"))?.[0] ?? "";
  ok(body.length > 0, `${fn} tanımlı`);
  ok(/security definer/i.test(body), `${fn}: SECURITY DEFINER`);
  ok(
    /jsonb_build_object\('room_id',\s*v_room_id,\s*'op',\s*TG_OP,\s*'src',\s*'(rooms|players)'\)/i.test(body),
    `${fn}: yük YALNIZ {room_id, op, src}`,
  );
  ok(
    !/\b(new|old)\.(name|team|score|game_state|profile_id|guest_id|code)\b[^;]*jsonb_build_object/i.test(body) &&
    !/jsonb_build_object\([^)]*\b(name|team|score|game_state|code|claim)\b/i.test(body),
    `${fn}: ad/takım/skor/rol/oda-kodu yüke KONMUYOR`,
  );
  ok(
    /exception when others then\s*\n?\s*null/i.test(body),
    `${fn}: yayın hatası oyun yazmasını BOZMUYOR`,
  );
  ok(/'kornokta:'\s*\|\|\s*v_room_id/i.test(body), `${fn}: odaya özel konu adı`);
  ok(/,\s*true\s*\n?\s*\)/.test(body) || /true\s*--\s*private/i.test(body), `${fn}: private kanal`);
}

ok(
  /create trigger tevatur_rooms_broadcast_signal[\s\S]*?after insert or update or delete on public\.tevatur_rooms/i.test(knSql),
  "tevatur_rooms trigger'ı kurulu",
);
ok(
  /create trigger tevatur_players_broadcast_signal[\s\S]*?after insert or update or delete on public\.tevatur_players/i.test(knSql),
  "tevatur_players trigger'ı kurulu",
);
ok(
  /realtime\.topic\(\)\s*like\s*'kornokta:%'/i.test(knSql),
  "realtime.messages: yalnız kornokta:* konusu dinlenebiliyor",
);
ok(
  /raise warning[\s\S]*?realtime\.messages policy oluşturulamadı/i.test(kn),
  "realtime policy kurulamazsa migration DURMUYOR (yoklama yedeği devrede)",
);

/* ════════════════════════════════════════════════════════════════════════
   4) KÖR NOKTA — migration güvenliği
════════════════════════════════════════════════════════════════════════ */
console.log("\n4) Migration güvenliği");

ok(/do \$pre\$[\s\S]*?raise exception[\s\S]*?ÖN KOŞUL EKSİK/i.test(kn), "Ön koşul denetimi açık hata veriyor");
ok(/tevatur_authorize_player\(uuid,uuid\)/i.test(kn), "Ön koşul: authorize helper aranıyor");
ok(/tevatur_players[\s\S]{0,200}column_name\s*=\s*'guest_id'/i.test(kn), "Ön koşul: guest_id kolonu aranıyor");
ok(/conquest_get_room_state\(uuid,uuid,uuid\)/i.test(kn), "Ön koşul: 20260810120000 önce uygulanmış olmalı");

ok(!/drop\s+table/i.test(knSql), "DROP TABLE yok");
ok(!/\bdelete\s+from\b/i.test(knSql), "DELETE FROM yok (aktif oda verisi silinmiyor)");
ok(!/\btruncate\b/i.test(knSql), "TRUNCATE yok");
ok(!/raise\s+(notice|log|warning)[^;]*claim_token/i.test(knSql), "claim_token loglanmıyor");

const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
ok(files.includes(KN_FILE), "Kilit migration'ı dizinde");
ok(
  files.indexOf(KN_FILE) > files.indexOf(CQ_FILE),
  "Sıra: Kör Nokta kilidi, Kuşatma kilidinden SONRA",
);
ok(
  files.indexOf(CQ_FILE) > files.indexOf("20260809120000_guest_browse_gate_and_kornokta.sql"),
  "Sıra: Kuşatma kilidi, misafir şema hizalamasından SONRA",
);
/* ESKİDEN: `files[files.length-1] === KN_FILE` — "kilit en son migration olmalı".
   Bu iddia yeni bir migration eklenir eklenmez kırılıyordu ve asıl riski
   ÖLÇMÜYORDU: tehlike kilidin son sırada olmaması değil, kendisinden SONRA
   gelen bir migration'ın kilidi sessizce geri açmasıdır. İddia o değişmezle
   değiştirildi. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Kilitlenen tablolar — hem "sonraki migration kilidi açmasın" denetimi hem de
 *  aşağıdaki istemci ham-okuma taraması bu tek listeyi kullanır. */
const LOCKED_TABLES = [
  "tevatur_rooms",
  "tevatur_players",
  "conquest_rooms",
  "conquest_players",
];

const laterFiles = files.slice(files.indexOf(KN_FILE) + 1);
for (const f of laterFiles) {
  const sql = stripSqlComments(readFileSync(join(migrationsDir, f), "utf8"));
  for (const table of LOCKED_TABLES) {
    ok(!new RegExp(`grant[^;]*\\bselect\\b[^;]*\\b${table}\\b[^;]*\\banon\\b`, "i").test(sql),
       `${f}: ${table} anon SELECT grant'i geri VERİLMİYOR`);
    ok(!new RegExp(`create policy[^;]*\\b${table}\\b[\\s\\S]{0,240}?\\bto\\b[^;]*\\banon\\b`, "i").test(sql),
       `${f}: ${table} için anon SELECT policy'si yeniden AÇILMIYOR`);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   5) KUŞATMA REGRESYONU — 20260810120000 hâlâ ayakta
════════════════════════════════════════════════════════════════════════ */
console.log("\n5) Kuşatma regresyonu");

for (const table of ["conquest_rooms", "conquest_players"]) {
  ok(
    new RegExp(`revoke select on table public\\.${table} from anon`, "i").test(cqSql),
    `${table}: anon SELECT hâlâ kapalı`,
  );
}
ok(
  /grant\s+execute on function public\.conquest_get_room_state\(uuid, uuid, uuid\) to anon, authenticated/i.test(cqSql),
  "conquest_get_room_state misafire açık",
);

const browseGate = readFileSync(
  join(migrationsDir, "20260809120000_guest_browse_gate_and_kornokta.sql"),
  "utf8",
);
ok(
  /grant\s+execute on function public\.conquest_list_public_rooms\(\)\s*to authenticated;/i.test(sqlOnly(browseGate)) &&
  !/conquest_list_public_rooms\(\)\s*to anon/i.test(sqlOnly(browseGate)),
  "\"Odalara Göz At\" RPC'si YALNIZ authenticated",
);

// Misafir host olamaz: dört leave_room fonksiyonunda da kayıtlı-aday filtresi.
for (const fn of [
  "conquest_leave_room",
  "wheel_group_leave_room",
  "duel_group_leave_room",
  "tevatur_leave_room",
]) {
  const body = cqSql.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`, "i"))?.[0] ?? "";
  ok(body.length > 0, `${fn}: 20260810120000'de yeniden tanımlı`);
  ok(
    /profile_id is not null/i.test(body),
    `${fn}: host adayı YALNIZ kayıtlı oyuncu (misafir host olamaz)`,
  );
}

/* ════════════════════════════════════════════════════════════════════════
   6) İSTEMCİ SÖZLEŞMESİ — ham tablo okuması kalmadı mı?
════════════════════════════════════════════════════════════════════════ */
console.log("\n6) İstemci: ham tablo SELECT'i kalmadı mı?");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const srcFiles = walk(srcDir);
// LOCKED_TABLES yukarıda (migration sırası denetiminde) tanımlı — tek liste.

// YALNIZ ham OKUMA aranır: `.from(t).select(...)`. Yazma zincirleri
// (`.from(t).update(…).select("*")`) KAPSAM DIŞIDIR — onlar RLS'te
// host-only'dir (conquest_rooms_update_host: host_profile_id = auth.uid()),
// misafir hiçbir modda host olamaz ve kayıtlı host'un SELECT yetkisi durur.
for (const table of LOCKED_TABLES) {
  const rawRead = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\.select\\(`);
  const offenders = srcFiles.filter(f => rawRead.test(readFileSync(f, "utf8")));
  ok(offenders.length === 0, `Ham okuma yok: .from("${table}").select(…)`, offenders);
}

const roomState = readFileSync(join(srcDir, "modes/korNokta/korNoktaRoomState.ts"), "utf8");
ok(/rpc\("tevatur_get_room_state"/.test(roomState), "korNoktaRoomState: okuma yetkili RPC'den");
ok(/config:\s*\{\s*private:\s*true\s*\}/.test(roomState), "korNoktaRoomState: misafir kanalı private");
ok(/POLL_FAST_MS/.test(roomState) && /POLL_SLOW_MS/.test(roomState), "korNoktaRoomState: yoklama yedeği var");
ok(
  /status === "error"/.test(roomState) || /{ status: "error" }/.test(roomState),
  "korNoktaRoomState: geçici hata üyelik kaybı SAYILMIYOR",
);
// Misafir dalının GÖVDESİNDE postgres_changes olmamalı (dosyanın başındaki
// açıklama metni değil, çalışan kod sınanır).
const guestBranch = roomState.slice(roomState.indexOf("function subscribeAsGuest("));
ok(guestBranch.length > 0 && !/postgres_changes/.test(guestBranch),
   "korNoktaRoomState: misafir dalı postgres_changes KULLANMIYOR");
ok(/function subscribeAsMember\([\s\S]*?postgres_changes/.test(roomState),
   "korNoktaRoomState: kayıtlı kullanıcı postgres_changes'te KALIYOR");

/* ════════════════════════════════════════════════════════════════════════ */
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} başarısız\n`);
process.exit(failed === 0 ? 0 : 1);
