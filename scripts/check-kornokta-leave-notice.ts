/**
 * check-kornokta-leave-notice.ts
 *
 * "Oyuncu ayrıldı, oyun devam ediyor" bildiriminin KARARINI doğrular
 * (korNoktaLeaveNotice.ts). DB ve tarayıcı GEREKMEZ.
 *
 * NEDEN VAR
 * ─────────
 * Buradaki tek gerçek risk bir YARIŞ: kayıtlı kullanıcıda `tevatur_players`
 * ve `tevatur_rooms` AYRI postgres_changes olaylarıyla gelir, yani oyuncu
 * satırı silindiği an oda satırı hâlâ ESKİ olabilir. `room.status`a bakan
 * naif bir karar, maçın BİTTİĞİ 2v2'de bir anlığına "Oyun devam ediyor"
 * yazardı — tam da istenmeyen şey. Karar bu yüzden `game_state.teams`in
 * kırpılmış olup olmadığına bakıyor ve bu dosya o davranışı kilitliyor.
 *
 * Çalıştır:  npx tsx scripts/check-kornokta-leave-notice.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveKnLeaveNotices,
  knLeaveNoticeText,
} from "../src/modes/korNokta/korNoktaLeaveNotice";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* Sunucu durumunu taklit eden küçük bir maç modeli. Takımlar eşit kurulur
   (start_game kuralı), `leave()` sunucunun 20260821120000'de yaptığını yapar:
   oyuncu satırını siler, teams'i kırpar, takım minimum viable (2) altına
   düşerse odayı terminal yapar. */
function match(perTeam: number) {
  const blue = Array.from({ length: perTeam }, (_, i) => `b${i + 1}`);
  const red  = Array.from({ length: perTeam }, (_, i) => `r${i + 1}`);
  return {
    status: "playing",
    players: [...blue, ...red],
    teams:   { blue: [...blue], red: [...red] },
    /** Sunucu tarafı çıkış — teams ve status AYNI anda güncellenir. */
    leave(id: string) {
      this.players = this.players.filter(p => p !== id);
      this.teams.blue = this.teams.blue.filter(p => p !== id);
      this.teams.red  = this.teams.red.filter(p => p !== id);
      const team = id.startsWith("b") ? this.teams.blue : this.teams.red;
      if (team.length < 2) this.status = "finished";   // min viable = 2
    },
    /** Kadro küçüldü ama ODA SATIRI HENÜZ GELMEDİ (yarış penceresi). */
    leaveWithStaleRoom(id: string) {
      this.players = this.players.filter(p => p !== id);
    },
  };
}

/** Çağıran effect'in yaptığı akış: karar + hatırlama. */
function view(m: ReturnType<typeof match>, myId: string) {
  const roster = new Map<string, string>();
  const announced = new Set<string>();
  const shown: string[] = [];
  return {
    shown,
    /** Bir sunucu anlık görüntüsü işle. */
    tick() {
      const res = resolveKnLeaveNotices({
        status:        m.status,
        livePlayerIds: m.players,
        teamIds:       [...m.teams.blue, ...m.teams.red],
        knownRoster:   roster,
        announced,
        myId,
      });
      for (const id of res.markAnnounced) announced.add(id);
      for (const n of res.notices) shown.push(knLeaveNoticeText(n.name));
      for (const p of m.players) roster.set(p, `Oyuncu-${p}`);
    },
  };
}

console.log("\n1) 3v3 — ilk çıkış: maç devam eder + bildirim");
{
  const m = match(3);
  const v = view(m, "b1");
  v.tick();                       // maç başladı, kadro hatırlandı
  m.leave("r3");
  v.tick();
  ok(m.status === "playing", "maç devam ediyor", m.status);
  ok(v.shown.length === 1, "tek bildirim gösterildi", v.shown);
  ok(v.shown[0] === "Oyuncu-r3 oyundan ayrıldı. Oyun devam ediyor.",
     "metin istenen biçimde", v.shown[0]);
  v.tick(); v.tick();
  ok(v.shown.length === 1, "tekrar eden okumalar bildirimi ÇOĞALTMIYOR", v.shown.length);
}

console.log("\n2) 3v3 — ikinci çıkış: takım 1'e düşer → terminal, toast YOK");
{
  const m = match(3);
  const v = view(m, "b1");
  v.tick();
  m.leave("r3"); v.tick();
  const afterFirst = v.shown.length;
  m.leave("r2"); v.tick();
  ok(m.status === "finished", "maç terminal", m.status);
  ok(v.shown.length === afterFirst,
     "ikinci çıkışta 'oyun devam ediyor' toast'ı YOK (ekran konuşur)", v.shown);
}

console.log("\n3) 2v2 — ilk çıkış: doğrudan terminal, toast YOK");
{
  const m = match(2);
  const v = view(m, "b1");
  v.tick();
  m.leave("r2"); v.tick();
  ok(m.status === "finished", "maç terminal", m.status);
  ok(v.shown.length === 0, "hiç toast gösterilmedi", v.shown);
}

console.log("\n4) 2v2 YARIŞ — kadro küçüldü, oda satırı hâlâ ESKİ");
{
  const m = match(2);
  const v = view(m, "b1");
  v.tick();
  m.leaveWithStaleRoom("r2");     // players olayı geldi, room olayı GELMEDİ
  v.tick();
  ok(v.shown.length === 0,
     "eski oda satırıyla YANLIŞ 'oyun devam ediyor' toast'ı çıkmıyor", v.shown);
  // Şimdi gerçek oda satırı gelsin (terminal).
  m.teams.red = m.teams.red.filter(p => p !== "r2");
  m.status = "finished";
  v.tick();
  ok(v.shown.length === 0, "oda satırı gelince de toast yok (terminal)", v.shown);
}

console.log("\n5) 3v3 YARIŞ — kadro küçüldü, oda satırı sonra gelir");
{
  const m = match(3);
  const v = view(m, "b1");
  v.tick();
  m.leaveWithStaleRoom("r3");
  v.tick();
  ok(v.shown.length === 0, "oda satırı eskiyken karar ERTELENİYOR", v.shown);
  m.teams.red = m.teams.red.filter(p => p !== "r3");   // taze oda satırı
  v.tick();
  ok(v.shown.length === 1, "taze oda satırı gelince bildirim düşüyor", v.shown);
  ok(m.status === "playing", "maç hâlâ devam ediyor", m.status);
}

console.log("\n6) Kimlik — misafir/kayıtlı ayrımı YOK, kendi çıkışım sessiz");
{
  // Karar yalnız id/ad üzerinden çalışır; misafir-kayıtlı dalı hiç yoktur.
  const src = readFileSync(join(ROOT, "src/modes/korNokta/korNoktaLeaveNotice.ts"), "utf8");
  ok(!/guest|profile_id|misafir ise|isGuest/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
     "karar gövdesinde misafir/kayıtlı dalı YOK → ikisi aynı davranır");

  const m = match(3);
  const v = view(m, "r3");        // ayrılan BENİM
  v.tick();
  m.leave("r3"); v.tick();
  ok(v.shown.length === 0, "kendi çıkışım bana toast'lanmıyor", v.shown);

  const m2 = match(3);
  const v2 = view(m2, "b1");      // misafir de olsa kayıtlı da olsa aynı yol
  v2.tick();
  m2.leave("r3"); v2.tick();
  ok(v2.shown.length === 1, "başkasının çıkışı toast'lanıyor (kimlikten bağımsız)", v2.shown);
}

console.log("\n7) Engellemeyen sunum — modal değil, mevcut toast yolu");
{
  const mode = readFileSync(join(ROOT, "src/modes/korNokta/KorNoktaMode.tsx"), "utf8");
  ok(/useSocialOptional\(\)\?\.toast/.test(mode),
     "projedeki paylaşılan toast yolu kullanılıyor");
  ok(/toast\?\.\(knLeaveNoticeText\(/.test(mode),
     "metin tek kaynaktan (knLeaveNoticeText) geliyor");
  ok(!/setLeaveConfirmOpen\(true\)[\s\S]{0,80}ayrıldı/.test(mode),
     "bildirim modal AÇMIYOR");
  ok(/knInGame && !knAbandoned/.test(mode),
     "terkediş ekranı hâlâ terminal maçta gösteriliyor (2v2 davranışı korunuyor)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
