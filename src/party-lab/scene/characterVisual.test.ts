import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { createCharacterVisual } from './visual/characterVisual';
import { localCostumeForSlot, playerCostumeAtSlot, resolveCostume } from './visual/costumes';
import { PARTS } from './ragdoll/config';

test('costumes preserve transforms; local selection and online identity never depend on slot', () => {
  assert.deepEqual([0, 1, 2].map(slot => localCostumeForSlot('gazelle', slot)), ['gazelle', 'cat', 'anchovy']);
  assert.deepEqual([0, 1, 2].map(slot => localCostumeForSlot('anchovy', slot)), ['anchovy', 'cat', 'gazelle']);
  const players = [{ slot: 0, costumeId: 'anchovy' }, { slot: 1, costumeId: 'cat' }, { slot: 2, costumeId: 'gazelle' }];
  assert.deepEqual([0, 1, 2].map(slot => playerCostumeAtSlot(players, slot)), ['anchovy', 'cat', 'gazelle']);
  assert.equal(playerCostumeAtSlot([{ slot: 0, costumeId: 'invalid' }], 0), 'default');
  assert.equal(resolveCostume('anchovy'), 'anchovy');
  assert.equal(resolveCostume('gazelle'), 'gazelle');
  assert.equal(resolveCostume('unknown'), 'default');
  for (const costume of ['default', 'cat', 'anchovy', 'gazelle'] as const) {
    const visual = createCharacterVisual('#f6c773', costume);
    try {
      assert.deepEqual(visual.root.children.map(part => part.name), [...PARTS]);
      let triangles = 0;
      for (const part of visual.root.children) {
        const skin = part.getObjectByName('skin') as Mesh;
        assert.ok(skin);
        assert.equal(part.children.filter(child => child instanceof Mesh).length, 1);
        const vertices = skin.geometry.getAttribute('position');
        triangles += vertices.count / 3;
        assert.ok(Array.from(vertices.array).every(Number.isFinite));
        // Sample the ear tip / tail end, including collapsed/carried/rotated poses.
        let vertex = vertices.count - 1;
        for (let i = 0; i < vertices.count; i++) {
          if (part.name === 'head' && vertices.getY(i) > vertices.getY(vertex)) vertex = i;
          if (part.name === 'pelvis' && vertices.getZ(i) < vertices.getZ(vertex)) vertex = i;
        }
        if (costume === 'cat' && part.name === 'head') assert.ok(vertices.getY(vertex) > 0.48);
        if (costume === 'cat' && part.name === 'pelvis') assert.ok(vertices.getZ(vertex) < -0.55);
        if (costume === 'anchovy' && part.name === 'head') assert.ok(vertices.getY(vertex) > 0.55);
        if (costume === 'anchovy' && part.name === 'pelvis') assert.ok(vertices.getZ(vertex) < -0.48);
        if (costume === 'gazelle' && part.name === 'head') assert.ok(vertices.getY(vertex) > 0.55);
        if (costume === 'gazelle' && part.name === 'pelvis') assert.ok(vertices.getZ(vertex) < -0.50);
        const local = new Vector3().fromBufferAttribute(vertices, vertex);
        part.position.set(2, -1, 3);
        part.rotation.set(1.7, -0.8, 2.1);
        visual.root.updateMatrixWorld(true);
        const expected = local.clone().applyMatrix4(part.matrixWorld);
        assert.ok(skin.localToWorld(local.clone()).distanceTo(expected) < 1e-10);
      }
      assert.ok(triangles < (costume === 'gazelle' ? 7000 : 6000), `${costume}: ${triangles} triangles`);
      assert.equal(visual.root.getObjectByName('stars')?.visible, false);
      console.log(`${costume}: ${triangles} triangles, 9 skin draw calls`);
    } finally { visual.dispose(); }
  }
});

test('gazelle ear, antler and tail tips follow their real head and pelvis poses', () => {
  const visual = createCharacterVisual('#79bbed', 'gazelle');
  try {
    const head = visual.root.getObjectByName('head')!;
    const pelvis = visual.root.getObjectByName('pelvis')!;
    const headSkin = head.getObjectByName('skin') as Mesh;
    const pelvisSkin = pelvis.getObjectByName('skin') as Mesh;
    const headPositions = headSkin.geometry.getAttribute('position');
    const tailPositions = pelvisSkin.geometry.getAttribute('position');
    for (const side of [-1, 1]) {
      let earTip = 0;
      for (let i = 0; i < headPositions.count; i++)
        if (side * headPositions.getX(i) > side * headPositions.getX(earTip)) earTip = i;
      assert.ok(side * headPositions.getX(earTip) > 0.50);
      const local = new Vector3().fromBufferAttribute(headPositions, earTip);
      head.position.set(-1, 1.3, 2);
      head.rotation.set(2.1, side * 0.8, -0.9);
      visual.root.updateMatrixWorld(true);
      assert.ok(headSkin.localToWorld(local.clone()).distanceTo(local.applyMatrix4(head.matrixWorld)) < 1e-10);
    }
    let hornTip = 0;
    for (let i = 0; i < headPositions.count; i++)
      if (headPositions.getY(i) > headPositions.getY(hornTip)) hornTip = i;
    assert.ok(headPositions.getY(hornTip) > 0.54 && headPositions.getY(hornTip) < 0.61);
    let tailTip = 0;
    for (let i = 0; i < tailPositions.count; i++)
      if (tailPositions.getZ(i) < tailPositions.getZ(tailTip)) tailTip = i;
    pelvis.position.set(2, 0.3, -1);
    pelvis.rotation.set(Math.PI, -0.6, 0.4);
    visual.root.updateMatrixWorld(true);
    const local = new Vector3().fromBufferAttribute(tailPositions, tailTip);
    assert.ok(pelvisSkin.localToWorld(local.clone()).distanceTo(local.applyMatrix4(pelvis.matrixWorld)) < 1e-10);
    assert.ok(visual.root.getObjectByName('stars')!.position.y > headPositions.getY(hornTip));
  } finally { visual.dispose(); }
});

test('anchovy side fins follow the head through collapse, carry and throw rotations', () => {
  const visual = createCharacterVisual('#e985a2', 'anchovy');
  try {
    const head = visual.root.getObjectByName('head')!;
    const skin = head.getObjectByName('skin') as Mesh;
    const vertices = skin.geometry.getAttribute('position');
    for (const side of [-1, 1]) {
      let tip = 0;
      for (let i = 0; i < vertices.count; i++)
        if (vertices.getX(i) * side > vertices.getX(tip) * side) tip = i;
      assert.ok(vertices.getX(tip) * side > 0.5);
      const point = new Vector3().fromBufferAttribute(vertices, tip);
      for (const angle of [Math.PI / 2, Math.PI, -2.1]) {
        head.position.set(-1, 2.4, 3);
        head.rotation.set(angle, 0.8, -0.4);
        visual.root.updateMatrixWorld(true);
        const expected = point.clone().applyMatrix4(head.matrixWorld);
        assert.ok(skin.localToWorld(point.clone()).distanceTo(expected) < 1e-10);
      }
    }
    assert.ok(visual.root.getObjectByName('stars')!.position.y > 0.65);
  } finally { visual.dispose(); }
});

test('shared geometry survives one owner leaving; flash and cleanup remain isolated', () => {
  const a = createCharacterVisual('#79bbed', 'cat');
  const b = createCharacterVisual('#79bbed', 'cat');
  const first = a.root.getObjectByName('skin') as Mesh;
  const second = b.root.getObjectByName('skin') as Mesh;
  assert.equal(first.geometry, second.geometry);
  assert.notEqual(first.material, second.material);
  (first.material as MeshStandardMaterial).emissiveIntensity = 0.7;
  assert.equal((second.material as MeshStandardMaterial).emissiveIntensity, 0);
  let disposed = 0;
  first.geometry.addEventListener('dispose', () => disposed++);
  a.dispose();
  a.dispose();
  assert.equal(disposed, 0);
  b.dispose();
  assert.equal(disposed, 1);
  const remount = createCharacterVisual('#79bbed', 'cat');
  assert.notEqual((remount.root.getObjectByName('skin') as Mesh).geometry, first.geometry);
  remount.dispose();
});
