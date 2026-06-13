#!/usr/bin/env node
// Guarded post-build prune for the lightweight app build output.
//
// Removes a small, hardcoded set of heavy / desktop-only assets from a build
// output directory (default: dist-app) so the app bundle stays small. It NEVER
// touches source files in public/ — it only operates on a freshly produced
// build directory, and refuses to run against the project root, public, src,
// dist, or anything outside the project root.
//
// Usage: node scripts/prune-app-assets.mjs [targetDir=dist-app]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Paths removed from inside the target directory. Relative to the target.
const REMOVE_PATHS = [
  'assets/history',
  'assets/detective-scenes',
  'assets/backgrounds/kor-nokta',
  'debug',
  'sounds/kor-nokta-report-ambient.mp3',
];

function fail(message) {
  console.error(`\n✗ prune-app-assets: ${message}\n`);
  process.exit(1);
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}

function pathSize(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isFile() || stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(target)) {
    total += pathSize(path.join(target, entry));
  }
  return total;
}

// --- Resolve & validate target -------------------------------------------

const targetArg = process.argv[2] || 'dist-app';
const target = path.resolve(projectRoot, targetArg);

const protectedDirs = {
  'project root': projectRoot,
  public: path.join(projectRoot, 'public'),
  src: path.join(projectRoot, 'src'),
  dist: path.join(projectRoot, 'dist'),
};

const relFromRoot = path.relative(projectRoot, target);
if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
  fail(`target resolves outside the project root: ${target}`);
}

for (const [label, dir] of Object.entries(protectedDirs)) {
  if (target === dir) {
    fail(`refusing to prune protected directory (${label}): ${target}`);
  }
}

if (!fs.existsSync(target)) {
  fail(`target directory does not exist: ${target}`);
}
if (!fs.statSync(target).isDirectory()) {
  fail(`target is not a directory: ${target}`);
}

// --- Prune ----------------------------------------------------------------

console.log('prune-app-assets');
console.log(`  target: ${target}`);

const sizeBefore = pathSize(target);
console.log(`  size before: ${formatSize(sizeBefore)}`);
console.log('  pruning:');

for (const rel of REMOVE_PATHS) {
  const abs = path.resolve(target, rel);

  // Defensive: never let a hardcoded entry escape the target directory.
  const within = path.relative(target, abs);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    console.log(`    - skip (outside target): ${rel}`);
    continue;
  }

  if (!fs.existsSync(abs)) {
    console.log(`    - skip (missing): ${rel}`);
    continue;
  }

  const removed = pathSize(abs);
  fs.rmSync(abs, { recursive: true, force: true });
  console.log(`    - removed: ${rel} (${formatSize(removed)})`);
}

const sizeAfter = pathSize(target);
console.log(`  size after:  ${formatSize(sizeAfter)}`);
console.log(`  reclaimed:   ${formatSize(sizeBefore - sizeAfter)}`);
