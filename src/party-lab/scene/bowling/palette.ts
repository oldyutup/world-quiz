import { BufferGeometry, Color } from 'three';

/** Local Human Bowling art direction. OKLCH-authored swatches are preconverted
 * to sRGB for Three/Canvas; vertex buffers receive linear RGB via Color.
 * Friendly outdoor stunt event: pale ground, warm stone, coral and teal.
 * The daytime sky stays atmospheric; asphalt and ivory targets keep contrast. */
export const BOWLING_PALETTE = {
  ground: '#c8c3b9', // Pale warm stone, keeping the outer terrain light and quiet.
  groundEdge: '#c0baaf', // Slightly deeper pale apron, with the same quiet warmth.
  asphalt: '#323239', // oklch(32% .013 285)
  ramp: '#41414b',
  lane: '#54585a',
  laneAlternate: '#585c5e',
  steel: '#495253', // oklch(43% .012 210), graphite poles and metal
  wall: '#aca79b', // oklch(73% .018 90)
  stone: '#c4bdb0', // oklch(80% .02 85)
  seat: '#cc8275', // oklch(68% .095 30)
  seatAlternate: '#b36e65', // oklch(61% .09 28)
  barrier: '#d97f70', // oklch(69% .115 30)
  chalk: '#e9e0cf', // oklch(91% .025 85)
  pin: '#f3ece1', // oklch(94.5% .016 80)
  stripe: '#bb584d', // oklch(58% .13 28)
  amber: '#d4a054', // oklch(74% .112 75)
  wood: '#665444',
  foliage: '#688368', // oklch(58% .05 145)
  ballCoral: '#e47d70', // oklch(70% .13 28)
  ballTeal: '#479994', // oklch(63% .08 190)
  carCoral: '#ef6856', // oklch(68% .17 30), stronger than scenery
  carAmber: '#eeb154', // oklch(80% .13 75)
  serviceTeal: '#298e89', // oklch(59% .09 190)
  fog: '#b6a7c2',
  skyLight: '#f5eee8',
  groundLight: '#969f8f', // oklch(69% .025 130)
  sunlight: '#fff1e3',
} as const;

const p = BOWLING_PALETTE;
// Exact baked swatches in the existing licensed kit, grouped by authored role.
// Keep the original mesh, normals, indices, flat facets and material batching.
const scenery: Record<string, Record<string, string>> = {
  Pin: { '233,214,179': p.pin, '166,25,18': p.stripe },
  BarrierRed: { '232,85,83': p.barrier },
  BarrierWhite: { '241,242,246': p.chalk },
  Stand: { '241,242,246': p.stone, '255,255,255': p.chalk, '232,85,83': p.seat, '68,68,68': p.wall },
  Flag: { '241,242,246': p.stone, '255,255,255': p.chalk, '222,200,147': p.chalk, '9,18,23': p.steel, '68,68,68': p.steel },
  Gantry: { '241,242,246': p.stone },
  Sign: { '241,242,246': p.stone, '255,255,255': p.wall, '68,68,68': p.steel, '212,167,108': p.wood },
  Tree: { '77,143,110': p.foliage, '212,167,108': p.wood },
  Tent: { '241,242,246': p.stone, '232,85,83': p.seatAlternate },
  Arrow: { '206,107,16': p.amber },
  Pad: { '34,87,82': p.wall },
};

/** Own only a small replacement color buffer. Never mutate the loader cache;
 * position/normal/index buffers remain shared, with no extra GPU geometry. */
export function bowlingKitGeometry(source: BufferGeometry, name: string) {
  const geometry = new BufferGeometry();
  geometry.setIndex(source.index);
  for (const [key, attribute] of Object.entries(source.attributes)) geometry.setAttribute(key, attribute);
  geometry.boundingBox = source.boundingBox?.clone() ?? null;
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
  const original = source.getAttribute('color'), colors = original.clone();
  const swatches = new Map<string, Color>(), color = new Color();
  for (let i = 0; i < colors.count; i++) {
    const r = original.getX(i), g = original.getY(i), b = original.getZ(i);
    const key = [r, g, b].map(v => Math.round(v * 255)).join(',');
    let replacement = swatches.get(key);
    if (!replacement) {
      color.setRGB(r, g, b);
      const mapped = scenery[name]?.[key];
      if (mapped) color.set(mapped);
      // Preserve baked shading and dark tyres/cockpits on the Kenney vehicles.
      if (name === 'Car' && r > g * 2 && r > b * 2) color.set(g > .25 ? p.carAmber : p.carCoral).multiplyScalar(.8 + .2 * r);
      if (name === 'ServiceCar' && g > r * 2 && g > b * 1.4) color.set(p.serviceTeal).multiplyScalar(.7 + .3 * g);
      replacement = color.clone(); swatches.set(key, replacement);
    }
    colors.setXYZ(i, replacement.r, replacement.g, replacement.b);
  }
  geometry.setAttribute('color', colors);
  return geometry;
}
