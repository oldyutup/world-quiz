import { BoxGeometry, BufferGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, LatheGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Shape, ShapeGeometry, SphereGeometry, SRGBColorSpace, Vector2 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CLASSIC as C, COLORS, PIN_PROFILE, rackPositions } from './config';
import type { ClassicGame } from './game';

/** Warm toy-sized alley. Static decoration is merged into one draw call. */
export function classicVisual() {
  const root = new Group(), parts: BufferGeometry[] = [];
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: .72 });
  const box = (size: [number, number, number], at: [number, number, number], color: string) => {
    const indexed = new BoxGeometry(...size).translate(...at), g = indexed.toNonIndexed(); indexed.dispose();
    g.deleteAttribute('uv'); const rgb = new Color(color), colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) rgb.toArray(colors, i);
    g.setAttribute('color', new Float32BufferAttribute(colors, 3)); parts.push(g);
  };
  box([13, .25, 23], [0, -.5, 3], '#acb8b1');
  box([13, 4.5, .25], [0, 1.7, 13.5], '#a8c9bd');
  for (const side of [-1, 1]) {
    box([.2, 4.5, 23], [side * 6.4, 1.7, 3], '#dfb39f');
    box([.22, .2, 23], [side * 6.3, 2.8, 3], '#f4dfae');
    // Comfy benches and ball returns, outside the lane silhouette.
    box([1.2, .35, 2.2], [side * 3.9, .02, -2.7], '#448a86');
    box([.25, .65, 2.2], [side * 4.45, .25, -2.7], '#589a94');
    box([.42, .5, 1.7], [side * 1.6, 0, -.9], '#879697');
    box([.5, .16, 1.8], [side * 1.6, .3, -.9], '#dbe1d6');
    box([.06, .1, 1.2], [side * 1.6 - .2, .4, -1], '#51676b');
    box([.06, .1, 1.2], [side * 1.6 + .2, .4, -1], '#51676b');
  }
  for (const laneX of [-3, 0, 3]) {
    box([2.2, .12, 3.5], [laneX, -.065, -1.8], '#bb9364');
    // Low-poly board pattern, restrained alternation; all flush with the collision plane.
    for (let i = 0; i < 19; i++) {
      const x = laneX + (i + .5) * C.laneWidth / 19 - C.laneWidth / 2;
      box([C.laneWidth / 19 - .003, .1, C.deckEnd], [x, -.05, C.deckEnd / 2], ['#d5b17a', '#d9b782', '#d0aa73'][i % 3]);
    }
    box([C.laneWidth, .01, .055], [laneX, .007, -.03], laneX === 0 ? '#438d89' : '#716b5b');
    for (const side of [-1, 1]) {
      const x = laneX + side * (C.laneWidth / 2 + C.gutterWidth / 2);
      box([C.gutterWidth, .08, C.deckEnd], [x, -C.gutterDepth - .04, C.deckEnd / 2], '#637877');
      box([.075, .43, C.deckEnd], [laneX + side * (C.laneWidth / 2 + C.gutterWidth + .04), -.055, C.deckEnd / 2], '#abb8aa');
      box([.08, .9, 1.9], [laneX + side * (C.laneWidth / 2 + C.gutterWidth + .04), .55, C.headZ + .65], '#819991');
    }
    box([2.3, .18, 1.8], [laneX, -.27, 12.3], '#465d61');
    box([2.4, 1, .4], [laneX, 1.35, 12.6], laneX === 0 ? '#3e8584' : '#779b91');
    box([2.4, .07, .44], [laneX, .83, 12.58], '#ead79d');
    // Ceiling strips establish depth without a dark enclosed ceiling.
    for (const z of [1, 5, 9]) box([.8, .08, 1.6], [laneX, 3.55, z], '#eee2bb');
    for (let i = -3; i <= 3; i++) {
      box([.035, .012, .095], [laneX + i * .17, .011, 2.2 + Math.abs(i) * .09], '#967448');
      box([.045, .012, .045], [laneX + i * .17, .011, -.35], '#537f77');
    }
  }
  const merged = mergeGeometries(parts); parts.forEach(p => p.dispose());
  const scenery = new Mesh(merged, material); root.add(scenery);
  // A shared mesh profile exactly matches the compound physical silhouette.
  const original = new LatheGeometry(PIN_PROFILE.map(([r, y]) => new Vector2(r, y)), 12);
  const pinGeometry = original.toNonIndexed(); original.dispose(); pinGeometry.deleteAttribute('uv');
  const attr = pinGeometry.attributes.position, pinColors = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i += 3) {
    const y = (attr.getY(i) + attr.getY(i + 1) + attr.getY(i + 2)) / 3;
    const color = new Color((y > .30 && y < .335) || (y > .35 && y < .37) ? '#bb5247' : '#f2ead9');
    for (let j = 0; j < 3; j++) color.toArray(pinColors, (i + j) * 3);
  }
  pinGeometry.setAttribute('color', new Float32BufferAttribute(pinColors, 3));
  const pins = Array.from({ length: 10 }, () => { const mesh = new Mesh(pinGeometry, material); root.add(mesh); return mesh; });
  for (const laneX of [-3, 3]) for (const at of rackPositions()) { const m = new Mesh(pinGeometry, material); m.position.set(laneX + at.x, at.y, at.z); root.add(m); }
  const ballGeometry = new SphereGeometry(C.ballRadius, 24, 16), ballMaterial = new MeshStandardMaterial({ color: COLORS[0], roughness: .25, metalness: .12 });
  const ball = new Group(), shell = new Mesh(ballGeometry, ballMaterial); ball.add(shell); root.add(ball);
  const holeGeometry = new SphereGeometry(.018, 8, 6), holeMaterial = new MeshBasicMaterial({ color: '#254c54' });
  for (const [x, z] of [[-.03, -.014], [.03, -.014], [0, .047]]) { const hole = new Mesh(holeGeometry, holeMaterial); hole.position.set(x, Math.sqrt(C.ballRadius ** 2 - x ** 2 - z ** 2) - .007, z); ball.add(hole); }
  const balls: Mesh[] = [];
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
    const m = new Mesh(ballGeometry, new MeshStandardMaterial({ color: COLORS[i], roughness: .35 })); m.position.set(side * 1.6, .5, -1.4 + i * .31); root.add(m); balls.push(m);
  }
  const arrowShape = new Shape([new Vector2(-.035, 0), new Vector2(.035, 0), new Vector2(.035, 1.06), new Vector2(.14, 1.06), new Vector2(0, 1.42), new Vector2(-.14, 1.06), new Vector2(-.035, 1.06)]);
  const arrowGeometry = new ShapeGeometry(arrowShape).rotateX(Math.PI / 2), arrowMaterial = new MeshBasicMaterial({ color: '#317d82', side: DoubleSide });
  const arrow = new Mesh(arrowGeometry, arrowMaterial); root.add(arrow);
  const markerGeometry = new CylinderGeometry(.18, .18, .008, 32), markerMaterial = new MeshBasicMaterial({ color: '#ead79d' });
  const marker = new Mesh(markerGeometry, markerMaterial); root.add(marker);
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#3e8584'; ctx.fillRect(0, 0, 1024, 256); ctx.fillStyle = '#f1e7ce'; ctx.textAlign = 'center'; ctx.font = 'bold 82px sans-serif'; ctx.fillText('KLASİK BOWLING', 512, 120); ctx.font = '28px sans-serif'; ctx.fillText('PARTY LAB    •    01', 512, 184);
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
  const signGeometry = new BoxGeometry(2.35, .59, .01), signMaterial = new MeshBasicMaterial({ map: texture });
  const sign = new Mesh(signGeometry, signMaterial); sign.position.set(0, 1.42, 12.38); sign.rotation.y = Math.PI; root.add(sign);
  return {
    root, ball, pins,
    update(g: ClassicGame) {
      for (const mesh of pins) mesh.visible = false;
      for (const p of g.pins) { const mesh = pins[p.id]; mesh.visible = true; mesh.position.copy(p.body.translation()); mesh.quaternion.copy(p.body.rotation()); }
      ballMaterial.color.set(COLORS[g.score.seat]);
      ball.visible = g.phase !== 'results';
      if (g.ball) { ball.position.copy(g.ball.translation()); ball.quaternion.copy(g.ball.rotation()); }
      else { ball.position.set(g.position, C.ballRadius, 0); ball.quaternion.identity(); }
      const setup = ['position', 'direction', 'power'].includes(g.phase);
      arrow.visible = setup; marker.visible = setup;
      marker.position.set(g.position, .011, 0);
      arrow.position.set(g.position, .06, .22);
      arrow.rotation.y = g.angle * Math.PI / 180;
      arrow.scale.z = 1 + (g.phase === 'power' ? (g.power - 35) / 65 * .4 : 0);
    },
    dispose() {
      for (const geometry of [merged, pinGeometry, ballGeometry, holeGeometry, markerGeometry, signGeometry, arrowGeometry]) geometry.dispose();
      for (const mat of [material, ballMaterial, holeMaterial, markerMaterial, signMaterial, arrowMaterial, ...balls.map(m => m.material as MeshStandardMaterial)]) mat.dispose();
      texture.dispose();
    },
  };
}
