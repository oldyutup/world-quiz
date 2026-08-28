/**
 * check-floating-postgrest.ts — "hiç gönderilmeyen" Supabase isteklerini bulur.
 *
 * NEDEN: @supabase/postgrest-js'te PostgrestBuilder gerçek bir Promise DEĞİL,
 * bir thenable'dır ve HTTP fetch'i `then()` çağrıldığı anda başlatır. Bu yüzden
 *
 *     void supabase.rpc("x", {...});      // ← HİÇBİR İSTEK GİTMEZ
 *
 * sessizce no-op'tur (kanıt: probe, 0 HTTP request). `await`, `.then(...)`,
 * atama veya `return` olmadan bir builder ifadesi ölü koddur.
 *
 * Bu tarayıcı, `supabase` (veya `sb`) kökünden başlayan ve await/then/atama
 * ile tüketilmeyen ExpressionStatement'ları raporlar. Realtime API'leri
 * (removeChannel/channel/subscribe/...) GERÇEK Promise/nesne döndürdüğü için
 * allowlist'tedir.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;

/** Postgrest OLMAYAN (gerçek Promise / nesne dönen) supabase yüzeyleri. */
const REALTIME_OK = new Set([
  "removeChannel", "removeAllChannels", "channel", "subscribe", "unsubscribe", "send",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

interface Finding { file: string; line: number; text: string }
const findings: Finding[] = [];

for (const file of walk(ROOT)) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node)) {
      let expr: ts.Expression = node.expression;
      // `void <expr>;` → içini aç. `await <expr>` zaten tüketir.
      if (ts.isVoidExpression(expr)) expr = expr.expression;
      else if (ts.isAwaitExpression(expr)) { ts.forEachChild(node, visit); return; }

      if (ts.isCallExpression(expr)) {
        // Zincirin kökünü ve method adlarını topla.
        const methods: string[] = [];
        let cur: ts.Node = expr;
        while (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
          if (ts.isPropertyAccessExpression(cur)) methods.push(cur.name.text);
          cur = ts.isCallExpression(cur) ? cur.expression : cur.expression;
        }
        const rootName = ts.isIdentifier(cur) ? cur.text : "";
        const isSupabaseRoot = /^(supabase|sb)$/.test(rootName);
        const consumed = methods.some(m => m === "then" || m === "catch" || m === "finally");
        const realtime = methods.some(m => REALTIME_OK.has(m));
        if (isSupabaseRoot && !consumed && !realtime) {
          const { line } = src.getLineAndCharacterOfPosition(node.getStart());
          findings.push({
            file: file.replace(ROOT, "src"),
            line: line + 1,
            text: node.getText().split("\n")[0].trim().slice(0, 90),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

if (findings.length === 0) {
  console.log("PASS — hiçbir Supabase isteği tüketilmeden bırakılmamış (0 ölü builder).");
  process.exit(0);
}
console.log(`FAIL — ${findings.length} ölü (hiç gönderilmeyen) Supabase isteği:`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.text}`);
process.exit(1);
