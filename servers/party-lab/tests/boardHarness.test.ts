import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The local board E2E hook (scripts/board-e2e-server.ts) must never reach production. */
const pkg = fileURLToPath(new URL("..", import.meta.url));
const repo = join(pkg, "../..");
const MARKERS = ["board-e2e", "finish-mini"];
function files(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

test("the board E2E hook is outside the production build", { timeout: 180000 }, () => {
  // 1. The production tsconfig compiles src/ and shared/party-lab only.
  const listed = execFileSync(process.execPath, [join(pkg, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--listFilesOnly"], { cwd: pkg, encoding: "utf8" })
    .split("\n")
    .filter((line) => line && !line.includes("/node_modules/"));
  assert.ok(listed.some((f) => f.endsWith("servers/party-lab/src/PartyRoom.ts")));
  assert.ok(listed.some((f) => f.endsWith("shared/party-lab/board/session.ts")));
  assert.deepEqual(listed.filter((f) => f.includes("/scripts/") || f.includes("board-e2e")), []);
  // 2. Nothing the server or the page ships mentions or imports it.
  for (const dir of [join(pkg, "src"), join(repo, "shared/party-lab"), join(repo, "src/party-lab")])
    for (const file of files(dir).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      for (const marker of MARKERS) assert.ok(!text.includes(marker), `${relative(repo, file)} mentions ${marker}`);
    }
  // 3. A real production build: the emitted server has no hook.
  const out = mkdtempSync(join(tmpdir(), "party-lab-build-"));
  try {
    execFileSync(process.execPath, [join(pkg, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", out], { cwd: pkg, stdio: "pipe" });
    const emitted = files(out);
    assert.ok(emitted.some((f) => f.endsWith("servers/party-lab/src/index.js")));
    assert.ok(emitted.some((f) => f.endsWith("shared/party-lab/board/session.js")));
    for (const file of emitted) {
      assert.ok(!file.includes("/scripts/"), relative(out, file));
      const text = readFileSync(file, "utf8");
      for (const marker of MARKERS) assert.ok(!text.includes(marker), `${relative(out, file)} mentions ${marker}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  // 4. The hook itself refuses to start in production.
  assert.match(readFileSync(join(pkg, "scripts/board-e2e-server.ts"), "utf8"), /NODE_ENV === "production"\) throw/);
});
