/**
 * Prepares Capacitor asset-generator source images from the two master
 * Torble brand files in this folder. NATIVE BRANDING ONLY — this script
 * never touches the web build.
 *
 *   torble-app-icon-v1.png  -> full-bleed globe mascot icon (iOS + Android)
 *   torble-logo.png         -> centered TORBLE wordmark on a blue splash
 *
 * Output goes to assets/native/capacitor-assets/, which is then consumed by
 *   npx capacitor-assets generate --assetPath assets/native/capacitor-assets
 *
 * Uses `sharp`, which is bundled with @capacitor/assets, so it adds no extra
 * dependency. Re-runnable / idempotent.
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'assets/native';
const OUT = join(SRC, 'capacitor-assets');
mkdirSync(OUT, { recursive: true });

const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

async function regionAvg(file, left, top, width, height) {
  const { data } = await sharp(file)
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0;
  const n = data.length / 3;
  for (let i = 0; i < data.length; i += 3) {
    r += data[i]; g += data[i + 1]; b += data[i + 2];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// ---------------------------------------------------------------------------
// APP ICON: crop the bright blue square out of the dark/rounded master so the
// icon is full-bleed. iOS and Android apply their own corner masks.
// ---------------------------------------------------------------------------
const iconFile = join(SRC, 'torble-app-icon-v1.png');
const { data, info } = await sharp(iconFile)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: ch } = info;

// The blue square already bleeds to the mid-edges; only the rounded corners
// hold dark navy. Crop inward just past the corner rounding so all four
// corners become solid blue. This way no mask (iOS squircle / Android circle)
// can leave a dark sliver, and we add no rounded corners of our own.
const TH = 70; // dark navy corner ~27, blue square ~120+
const bright = (x, y) => {
  const i = (y * W + x) * ch;
  return (data[i] + data[i + 1] + data[i + 2]) / 3;
};
const cornersBlue = (m) =>
  bright(m, m) > TH &&
  bright(W - 1 - m, m) > TH &&
  bright(m, H - 1 - m) > TH &&
  bright(W - 1 - m, H - 1 - m) > TH;
let inset = 0;
const maxInset = Math.floor(W / 3);
while (inset < maxInset && !cornersBlue(inset)) inset++;
inset = Math.min(inset + Math.round(W * 0.015), maxInset); // small safety margin
const cropW = W - 2 * inset;
const cropH = H - 2 * inset;
console.log('icon corner inset', inset, '-> crop', { cropW, cropH });

// Representative blue, sampled from a now-solid-blue corner of the crop.
const iconBlue = await regionAvg(iconFile, inset + 6, inset + 6, 32, 32);

// icon-only  -> iOS app icon + Android legacy launcher (full bleed).
// icon-foreground -> Android adaptive foreground (same full-bleed art; the
//   adaptive icon is wired in android/.../mipmap-anydpi-v26 to a full-bleed
//   @color/ic_launcher_background (the sampled blue below) with the foreground
//   inset ~10%, so the mascot sits seamlessly on brand blue with no
//   transparent margin under any launcher mask.
const iconCrop = sharp(iconFile)
  .extract({ left: inset, top: inset, width: cropW, height: cropH })
  .resize(1024, 1024, { fit: 'fill' });
await iconCrop.clone().png().toFile(join(OUT, 'icon-only.png'));
await iconCrop.clone().png().toFile(join(OUT, 'icon-foreground.png'));

// ---------------------------------------------------------------------------
// SPLASH: blue full-screen canvas with the trimmed TORBLE wordmark centered.
// ---------------------------------------------------------------------------
const logoFile = join(SRC, 'torble-logo.png');
const splashBlue = await regionAvg(logoFile, 0, 0, 80, 80); // top-left = pure bg

const CANVAS = 2732;
// Logo width as a fraction of the square splash canvas. Kept conservative so
// the TORBLE wordmark never crops on narrow phones: the iOS LaunchScreen uses
// scaleAspectFill, which scales this square to cover the screen height and
// overflows the width on tall portrait devices (~2.16x), so a fraction here
// reads visually larger on-device. 0.45 leaves wide centered margins on all
// sides and fits within the launch screen. (Lower this toward 0.42 for even
// more on-device margin; raising it past ~0.46 risks edge-to-edge on the
// tallest iPhones.)
const LOGO_SCALE = 0.45;
const trimmed = await sharp(logoFile)
  .trim({ background: { r: splashBlue[0], g: splashBlue[1], b: splashBlue[2] }, threshold: 28 })
  .toBuffer();
const tMeta = await sharp(trimmed).metadata();
console.log('trimmed wordmark', { width: tMeta.width, height: tMeta.height });

const logoResized = await sharp(trimmed)
  .resize({ width: Math.round(CANVAS * LOGO_SCALE) })
  .png()
  .toBuffer();
const lMeta = await sharp(logoResized).metadata();

const splash = () =>
  sharp({
    create: { width: CANVAS, height: CANVAS, channels: 3, background: { r: splashBlue[0], g: splashBlue[1], b: splashBlue[2] } },
  }).composite([
    {
      input: logoResized,
      left: Math.round((CANVAS - lMeta.width) / 2),
      top: Math.round((CANVAS - lMeta.height) / 2),
    },
  ]).png();

await splash().toFile(join(OUT, 'splash.png'));
await splash().toFile(join(OUT, 'splash-dark.png'));

console.log('\nSampled brand colors:');
console.log('  icon background blue :', hex(...iconBlue));
console.log('  splash background blue:', hex(...splashBlue));
console.log('\nWrote sources to', OUT);
