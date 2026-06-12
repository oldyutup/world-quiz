// Harita Dedektifi 360 test pipeline — adım 1: üretim.
//
// AI Horde (https://aihorde.net, anonim anahtar "0000000000") üzerinde
// Flux.1-Schnell ile 1408×704 equirectangular taban üretir ve worker
// tarafında RealESRGAN_x4plus post-processing ile 5632×2816'ya çıkarır.
// Anonim kullanıcılar 1024×1024 piksel bütçesiyle sınırlı olduğu için taban
// çözünürlük 1408×704 seçilmiştir (2:1, 64'ün katı, bütçenin altında).
//
// Kullanım:
//   node scripts/history360/generate.mjs            # tüm sahneler, sahne başına 2 aday
//   node scripts/history360/generate.mjs h360_001    # id öneki eşleşen sahneler
//
// Çıktılar: scripts/history360/raw/<sceneId>_cand<N>.webp (5632×2816 ham aday)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HORDE = "https://aihorde.net/api/v2";
const HEADERS = {
  apikey: "0000000000",
  "Client-Agent": "world-quiz-history360-test:1.0:dev",
  "Content-Type": "application/json",
};
const CANDIDATES_PER_SCENE = 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.join(here, "raw");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(prompt) {
  const body = {
    prompt,
    params: {
      sampler_name: "k_euler",
      cfg_scale: 1.0,
      width: 1408,
      height: 704,
      steps: 8,
      n: 1,
      post_processing: ["RealESRGAN_x4plus"],
    },
    models: ["Flux.1-Schnell fp8 (Compact)"],
    nsfw: false,
    r2: true,
    shared: false,
  };
  const res = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new Error(`submit failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.id;
}

async function waitFor(id, label) {
  // Tipik bekleme 1-15 dk (anonim öncelik düşük). 40 dk sonra pes eder.
  for (let i = 0; i < 240; i++) {
    await sleep(10_000);
    const res = await fetch(`${HORDE}/generate/check/${id}`, {
      headers: { "Client-Agent": HEADERS["Client-Agent"] },
    });
    const s = await res.json();
    if (s.faulted) throw new Error(`${label}: horde reported faulted`);
    if (s.done) return;
    if (i % 6 === 0) {
      console.log(
        `  ${label}: queue=${s.queue_position} wait≈${s.wait_time}s processing=${s.processing}`,
      );
    }
  }
  throw new Error(`${label}: timed out`);
}

async function download(id, outFile, label) {
  const res = await fetch(`${HORDE}/generate/status/${id}`, {
    headers: { "Client-Agent": HEADERS["Client-Agent"] },
  });
  const json = await res.json();
  const gen = json.generations?.[0];
  if (!gen?.img) throw new Error(`${label}: no image in status`);
  if (gen.censored) throw new Error(`${label}: censored by worker`);
  const img = await fetch(gen.img);
  if (!img.ok) throw new Error(`${label}: download failed ${img.status}`);
  await writeFile(outFile, Buffer.from(await img.arrayBuffer()));
  console.log(`  ${label}: saved ${path.basename(outFile)} (worker: ${gen.worker_name})`);
}

async function main() {
  const filter = process.argv[2] ?? "";
  const { scenes } = JSON.parse(
    await readFile(path.join(here, "scenes.json"), "utf8"),
  );
  const wanted = scenes.filter((s) => s.id.startsWith(filter));
  if (wanted.length === 0) {
    console.error(`no scene matches "${filter}"`);
    process.exit(1);
  }
  await mkdir(rawDir, { recursive: true });

  // Adaylar sahne başına ayrı istek olarak paralel gönderilir; AI Horde
  // anonim istekleri kudos önceliğine göre sıraya alır, eşzamanlılık sorun değil.
  const jobs = [];
  for (const scene of wanted) {
    for (let c = 1; c <= CANDIDATES_PER_SCENE; c++) {
      const label = `${scene.id} cand${c}`;
      const outFile = path.join(rawDir, `${scene.id}_cand${c}.webp`);
      jobs.push(
        (async () => {
          const id = await submit(scene.prompt);
          console.log(`submitted ${label} → ${id}`);
          await waitFor(id, label);
          await download(id, outFile, label);
        })().catch((err) => {
          console.error(`FAILED ${label}: ${err.message}`);
          return "failed";
        }),
      );
      // Submit'ler arasında küçük boşluk — IP bazlı flood korumasına takılmamak için.
      await sleep(1500);
    }
  }
  const results = await Promise.all(jobs);
  const failed = results.filter((r) => r === "failed").length;
  console.log(`done: ${results.length - failed}/${results.length} candidates ok`);
  if (failed > 0) process.exitCode = 1;
}

main();
