/**
 * check-env-parser.ts
 *
 * postcheck-kornokta-leave-live.ts'in `readEnvFile` ayrıştırıcısını doğrular.
 *
 * NEDEN VAR
 * ─────────
 * Eski regex'te sondaki `\s*`, `(.*)` açgözlü olduğu için hep boş eşleşiyordu
 * ve satır sonundaki boşluk DEĞERİN İÇİNDE kalıyordu. `.env.test.local`daki
 * e-posta satırlarının sonundaki tek bir görünmez boşluk canlı postcheck'i
 * "Invalid login credentials" ile düşürdü. Görünmez bir karakterin sebep
 * olduğu bir hata, tam olarak testle kilitlenmesi gereken şeydir.
 *
 * Test, fonksiyonu KOPYALAMAZ: gerçek dosyadan kaynağını çıkarıp değerlendirir
 * (aynı repo-truth deseni SQL fonksiyonları için de kullanılıyor). Böylece
 * sevk edilen kodun kendisi sınanır.
 *
 * GİZLİLİK: yalnız geçici fixture dosyaları okunur; .env / .env.test.local'a
 * DOKUNULMAZ ve hiçbir gerçek değer okunmaz/basılmaz.
 *
 * Çalıştır:  npx tsx scripts/check-env-parser.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC  = join(ROOT, "scripts/postcheck-kornokta-leave-live.ts");

/* Sevk edilen fonksiyonun kaynağını çıkar (kopya değil, repo-truth). */
const text  = readFileSync(SRC, "utf8");
const start = text.indexOf("function readEnvFile(");
const end   = text.indexOf("\n}", start);
if (start < 0 || end < 0) { console.error("FAIL: readEnvFile kaynağı bulunamadı"); process.exit(1); }
const body = text.slice(start, end + 2).replace(/: Record<string, string>|: string/g, "");

const factory = new Function("existsSync", "readFileSync", `${body}; return readEnvFile;`);
const readEnvFile = factory(existsSync, readFileSync) as (p: string) => Record<string, string>;

const dir = mkdtempSync(join(tmpdir(), "envparse-"));
function parse(contents: string): Record<string, string> {
  const f = join(dir, "fixture.env");
  writeFileSync(f, contents);
  return readEnvFile(f);
}

console.log("\n1) Kazara kenar boşluğu temizleniyor (asıl hata)");
{
  // Not: aşağıdaki değerler UYDURMADIR; gerçek credential DEĞİLDİR.
  const r = parse("TORBLE_A_EMAIL=user@example.com \nTORBLE_A_PASSWORD=hunter2 \n");
  ok(r.TORBLE_A_EMAIL === "user@example.com", "EMAIL=değer<boşluk> → değer", r.TORBLE_A_EMAIL);
  ok(r.TORBLE_A_PASSWORD === "hunter2", "PASSWORD=değer<boşluk> → değer", r.TORBLE_A_PASSWORD);
}
{
  const r = parse("K=v\t\nL=  v2  \nM=v3\r\n");
  ok(r.K === "v", "sondaki TAB kırpılıyor", r.K);
  ok(r.L === "v2", "iki yandaki boşluk kırpılıyor", r.L);
  ok(r.M === "v3", "CRLF'in CR'ı değere sızmıyor", r.M);
}

console.log("\n2) Kasıtlı boşluk KORUNUYOR");
{
  const r = parse('A=pass word\nB="  padded  "\nC=\'  s  \'\nD=a b  c\n');
  ok(r.A === "pass word", "iç boşluk silinmiyor", r.A);
  ok(r.B === "  padded  ", "çift tırnak → kenar boşluğu AYNEN korunuyor", r.B);
  ok(r.C === "  s  ", "tek tırnak → kenar boşluğu AYNEN korunuyor", r.C);
  ok(r.D === "a b  c", "çoklu iç boşluk korunuyor", r.D);
}

console.log("\n3) Tırnak davranışı bozulmadı");
{
  const r = parse('A="quoted"\nB=\'quoted\'\nC=unquoted\nD=say "hi"\nE=trailing"\n');
  ok(r.A === "quoted", "çift tırnak soyuluyor", r.A);
  ok(r.B === "quoted", "tek tırnak soyuluyor", r.B);
  ok(r.C === "unquoted", "tırnaksız değer aynen", r.C);
  ok(r.D === 'say "hi"', "iç tırnaklar korunuyor", r.D);
  // Eski kod tek taraflı tırnağı da soyuyordu → bu değeri BOZARDI.
  ok(r.E === 'trailing"', "eşleşmeyen tek tırnak SOYULMUYOR", r.E);
}

console.log("\n4) Boş / eksik tespiti korunuyor");
{
  const r = parse("EMPTY=\nSPACES=   \nOK=v\n# COMMENT=x\n\nBAD LINE\n");
  ok(r.EMPTY === "", "boş değer boş string", r.EMPTY);
  ok(r.SPACES === "", "yalnız-boşluk değer boş string → 'eksik' sayılır", r.SPACES);
  ok(!("COMMENT" in r), "yorum satırı ayrıştırılmıyor");
  ok(!("BAD" in r) && !("BAD LINE" in r), "bozuk satır yok sayılıyor");
  ok(r.OK === "v", "geçerli satır etkilenmiyor", r.OK);
  // Script'in kapısı: !email || !password → boş string burada 'yok' demektir.
  ok(!r.EMPTY && !r.SPACES && !!r.OK, "script'in boş kontrolü aynı sonucu veriyor");
}
{
  ok(Object.keys(readEnvFile(join(dir, "yok-boyle-bir-dosya.env"))).length === 0,
     "olmayan dosya → boş sözlük (mevcut davranış)");
}

console.log("\n5) Gerçek env dosyalarına DOKUNULMADI");
{
  ok(!text.includes(".env.test.local\", \"w\"") && !/writeFileSync\(\s*["'`]\.env/.test(text),
     "postcheck script'i env dosyalarına YAZMIYOR");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
