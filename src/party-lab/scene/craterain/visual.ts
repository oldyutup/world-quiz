import { BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Group, InstancedMesh, InstancedBufferAttribute, PlaneGeometry, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, PointsMaterial, Quaternion, Sprite, SpriteMaterial, SRGBColorSpace, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCharacterVisual } from '../visual/characterVisual';
import { PARTS, SHAPES } from '../ragdoll/config';
import { localCostumeForSlot, type SelectableCostumeId } from '../visual/costumes';
import { BOXES, BOX_KINDS, CRATE_RAIN as C, FEET, smoothFacing, PLAYER_COLORS, PLAYER_NAMES } from './config';
import type { CrateRainGame } from './game';
import { warningPose } from './warnings';

function paint(geometry: BufferGeometry, hex: string) {
  const color = new Color(hex), n = geometry.attributes.position.count, colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3)); return geometry;
}
function block(size: number[], pos: number[], color: string) { return paint(new BoxGeometry(size[0], size[1], size[2]).translate(pos[0], pos[1], pos[2]), color); }
function merge(pieces: BufferGeometry[]) { const result = mergeGeometries(pieces)!; pieces.forEach(g => g.dispose()); return result; }
function label(text: string, color: string, width = 256) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 64;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#283c3c'; ctx.beginPath(); ctx.roundRect(4, 4, width - 8, 56, 18); ctx.fill();
  ctx.fillStyle = color; ctx.font = '700 27px system-ui'; ctx.textAlign = 'center'; ctx.fillText(text, width / 2, 41);
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
  return new Sprite(new SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
}
/** All original primitive geometry. Three instanced crate draws regardless of count. */
export function crateVisual(count: number, costume: SelectableCostumeId, names = PLAYER_NAMES) {
  const root = new Group(), material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, flatShading: true });
  const environment: BufferGeometry[] = [];
  const add = (size: number[], pos: number[], color: string) => environment.push(block(size, pos, color));
  const half = C.arenaSize / 2, size = C.arenaSize;
  add([size + 4, 0.65, size + 4], [0, -0.84, 0], '#779088');
  add([size + .9, 0.55, size + .9], [0, -0.28, 0], '#d8ceb5');
  // A quiet continuous floor. The planning grid is intentionally invisible.
  for (const x of [-half + .35, half - .35]) add([.1, .015, size - .6], [x, .015, 0], '#eae0c9');
  for (const z of [-half + .35, half - .35]) add([size - .6, .015, .1], [0, .015, z], '#eae0c9');
  // Literal courtyard cargo-cage boundary, readable from every ground-level view.
  for (const axis of ['x', 'z']) for (const sign of [-1, 1]) {
    const along = (n: number[], t: number, y: number) => add(axis === 'x' ? n : [n[2], n[1], n[0]], axis === 'x' ? [sign * (half + .22), y, t] : [t, y, sign * (half + .22)], '#6b8b7c');
    along([0.44, 1.1, size + .9], 0, 0.55);
    for (let t = -half; t <= half; t += size / 6) along([0.13, C.wallHeight, 0.13], t, C.wallHeight / 2);
    for (let y = 1.15; y <= C.wallHeight; y += 1.4) along([0.045, 0.045, size + .5], 0, y);
    for (let t = -half + .5; t < half; t += .75) along([0.025, C.wallHeight - 1.1, 0.025], t, (C.wallHeight + 1.1) / 2);
    along([0.18, 0.18, size + .7], 0, C.wallHeight);
  }
  // Small depot behind the court; the playable floor starts empty.
  add([13, 6.0, 4], [0, 2.5, -15], '#c4b99b'); add([13.6, 0.45, 4.7], [0, 5.65, -15], '#53786e');
  for (const x of [-4.5, 0, 4.5]) {
    add([3.4, 3.4, 0.12], [x, 1.2, -12.94], '#7b9d92');
    for (let y = 0; y < 3; y += 0.4) add([3.3, 0.035, 0.04], [x, y, -12.85], '#65877d');
    add([2.0, 0.55, 0.10], [x, 4.2, -12.88], '#e2d6b8');
  }
  add([4, 1.5, 5], [-15, 0, -6], '#b6c4b2'); add([4, 2.4, 4], [15, 0.4, -10], '#a4b8a8');
  const scenery = new Mesh(merge(environment), material); root.add(scenery);
  const instanced = BOX_KINDS.map(kind => {
    const { size: [x, y, z], color, strap } = BOXES[kind];
    const pieces = [block([x, y, z], [0, 0, 0], color)];
    // Batten frame and two straps are merged vertex colors, no per-crate material.
    for (const side of [-1, 1]) {
      pieces.push(block([x + 0.014, 0.10, z + 0.014], [0, side * (y / 2 - 0.07), 0], '#d4b285'));
      pieces.push(block([0.11, y + 0.018, z + 0.02], [side * x * 0.30, 0, 0], strap));
    }
    pieces.push(block([x * 0.28, y * 0.20, 0.012], [0, 0.03, z / 2 + 0.01], '#eee0bd'));
    pieces.push(block([0.025, y * 0.11, 0.018], [-0.04, 0.03, z / 2 + 0.02], strap), block([0.025, y * 0.11, 0.018], [0.04, 0.03, z / 2 + 0.02], strap));
    const mesh = new InstancedMesh(merge(pieces), material, C.boxCap); mesh.instanceMatrix.setUsage(DynamicDrawUsage); mesh.frustumCulled = false; mesh.count = 0; root.add(mesh); return mesh;
  });
  // Soft square shadow, divided into nine projected patches so it follows the
  // TOP of uneven piles instead of disappearing beneath the inaccessible floor.
  const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 64;
  const ctx = shadowCanvas.getContext('2d')!;
  const pixels = ctx.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const edge = Math.max(Math.abs(x - 31.5), Math.abs(y - 31.5)) / 32;
    const i = (y * 64 + x) * 4; pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    pixels.data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, (1 - edge) / 0.28)));
  }
  ctx.putImageData(pixels, 0, 0);
  const shadowTexture = new CanvasTexture(shadowCanvas);
  const warningMaterial = new MeshBasicMaterial({ color: '#302a21', map: shadowTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadowGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowAlpha = new InstancedBufferAttribute(new Float32Array(144), 1).setUsage(DynamicDrawUsage);
  const shadowTile = new InstancedBufferAttribute(new Float32Array(144 * 2), 2).setUsage(DynamicDrawUsage);
  shadowGeometry.setAttribute('shadowAlpha', shadowAlpha); shadowGeometry.setAttribute('shadowTile', shadowTile);
  warningMaterial.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute float shadowAlpha; attribute vec2 shadowTile; varying float vShadowAlpha;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vMapUv = (vMapUv + shadowTile) / 3.0; vShadowAlpha = shadowAlpha;');
    shader.fragmentShader = 'varying float vShadowAlpha;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n diffuseColor.a *= vShadowAlpha;');
  };
  const warningMesh = new InstancedMesh(shadowGeometry, warningMaterial, 144); warningMesh.instanceMatrix.setUsage(DynamicDrawUsage); warningMesh.frustumCulled = false; warningMesh.count = 0; root.add(warningMesh);
  const people = Array.from({ length: count }, (_, i) => {
    const person = createCharacterVisual(PLAYER_COLORS[i], localCostumeForSlot(costume, i));
    person.root.scale.setScalar(0.81);
    PARTS.forEach((name, index) => { const part = person.root.children[index], shape = SHAPES[name]; part.position.set(shape.x, shape.y, 0); });
    root.add(person.root);
    const tag = label(`${i + 1} · ${names[i]}`, i === 0 ? '#ffd3b9' : '#eef0db'); tag.scale.set(1.1, 0.28, 1); tag.renderOrder = 5; root.add(tag);
    const shadow = new Mesh(new CircleGeometry(0.46, 20), new MeshBasicMaterial({ color: '#546556', transparent: true, opacity: 0.2, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; root.add(shadow);
    return { person, tag, shadow, round: -1, yaw: 0 };
  });
  const positions = new Float32Array(72 * 3), velocity = new Float32Array(72 * 3), life = new Float32Array(72); positions.fill(-1000);
  const dustGeometry = new BufferGeometry(); dustGeometry.setAttribute('position', new BufferAttribute(positions, 3));
  const dust = new Points(dustGeometry, new PointsMaterial({ color: '#ead9b7', size: 0.16, transparent: true, opacity: 0.66, depthWrite: false })); dust.frustumCulled = false; root.add(dust);
  const matrix = new Matrix4(), pos = new Vector3(), quat = new Quaternion(), scale = new Vector3(); let cursor = 0;
  return { root, facing: () => people.map(p => p.yaw),
    burst(p: { x: number; y: number; z: number }) { for (let j = 0; j < 10; j++) { const i = cursor++ % 72, a = i * 2.39996; life[i] = 0.5; positions.set([p.x, p.y + 0.05, p.z], i * 3); velocity.set([Math.sin(a) * 1.8, 0.8 + j % 3 * 0.3, Math.cos(a) * 1.8], i * 3); } },
    update(g: CrateRainGame, dt: number, hiddenPlayer = -1, alpha = 1) {
      const counts = [0, 0, 0];
      for (const c of g.crates) {
        const index = BOX_KINDS.indexOf(c.kind), p = c.body.translation(), q = c.body.rotation();
        pos.set(p.x, p.y, p.z); quat.set(q.x, q.y, q.z, q.w); scale.set(1, 1, 1); matrix.compose(pos, quat, scale); instanced[index].setMatrixAt(counts[index]++, matrix);
      }
      // The crate is visible from the first warning, even before physics release.
      for (const w of g.warnings) if (!w.spawned && !w.landed) {
        const { at } = warningPose(g, w), index = BOX_KINDS.indexOf(w.kind);
        pos.set(at.x, at.y, at.z); quat.identity(); scale.set(1, 1, 1); matrix.compose(pos, quat, scale); instanced[index].setMatrixAt(counts[index]++, matrix);
      }
      instanced.forEach((mesh, i) => { mesh.count = counts[i]; mesh.instanceMatrix.needsUpdate = true; });
      let n = 0;
      for (const w of g.warnings) if (!w.landed && n <= 135) {
        const pose = warningPose(g, w), cell = pose.size / 3;
        for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
          const px = pose.at.x + (x - 1) * cell, pz = pose.at.z + (z - 1) * cell;
          const surface = g.surface(px, pz, pose.at.y - BOXES[w.kind].size[1] / 2 + 0.03);
          pos.set(px, surface.y + 0.028, pz); quat.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(surface.normal.x, surface.normal.y, surface.normal.z));
          scale.set(cell * 1.025, 1, cell * 1.025); matrix.compose(pos, quat, scale); warningMesh.setMatrixAt(n, matrix);
          shadowAlpha.setX(n, pose.opacity); shadowTile.setXY(n, x, 2 - z); n++;
        }
      }
      warningMesh.count = n; warningMesh.instanceMatrix.needsUpdate = shadowAlpha.needsUpdate = shadowTile.needsUpdate = true;
      people.forEach((visual, i) => {
        const { person, tag, shadow } = visual;
        const p = g.players[i], at = p.body.translation(), v = p.body.linvel(); person.root.visible = p.alive && i !== hiddenPlayer; tag.visible = p.alive && i !== hiddenPlayer; shadow.visible = p.alive;
        // Existing skins are adapted to the local capsule's 1.48 m standing height.
        const targetYaw = Math.hypot(v.x, v.z) > .25 ? Math.atan2(v.x, v.z) : p.heading;
        if (visual.round !== g.round) { visual.yaw = p.heading; visual.round = g.round; }
        visual.yaw = smoothFacing(visual.yaw, targetYaw, dt);
        const prev = p.positionBefore;
        person.root.position.set(prev.x + (at.x - prev.x) * alpha, prev.y + (at.y - prev.y) * alpha - .13, prev.z + (at.z - prev.z) * alpha);
        person.root.rotation.y = visual.yaw;
        const gait = Math.sin(g.elapsed * 12) * Math.min(0.42, Math.hypot(v.x, v.z) * 0.065) * Number(p.grounded);
        person.root.children[7].rotation.x = gait; person.root.children[8].rotation.x = -gait;
        person.root.children[3].rotation.x = -gait * 0.8; person.root.children[5].rotation.x = gait * 0.8;
        person.root.children[4].position.z = Math.sin(-gait) * 0.32; person.root.children[6].position.z = Math.sin(gait) * 0.32;
        tag.position.set(at.x, at.y + 0.96, at.z); shadow.position.set(at.x, Math.max(0.023, at.y - FEET + 0.016), at.z); shadow.visible = p.alive && p.grounded;
      });
      for (let i = 0; i < 72; i++) { life[i] -= dt; if (life[i] > 0) { velocity[i * 3 + 1] -= dt * 3; for (let j = 0; j < 3; j++) positions[i * 3 + j] += velocity[i * 3 + j] * dt; } else positions[i * 3 + 1] = -1000; }
      dustGeometry.attributes.position.needsUpdate = true;
    },
    dispose() {
      [...instanced, warningMesh].forEach(mesh => mesh.dispose());
      people.forEach(p => { root.remove(p.person.root); p.person.dispose(); });
      const geometries = new Set<BufferGeometry>(), materials = new Set<MeshStandardMaterial | MeshBasicMaterial | SpriteMaterial | PointsMaterial>();
      root.traverse(o => { if (o instanceof Mesh || o instanceof Sprite || o instanceof Points) { if ('geometry' in o) geometries.add(o.geometry); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => { m.map?.dispose(); m.dispose(); });
    },
  };
}
