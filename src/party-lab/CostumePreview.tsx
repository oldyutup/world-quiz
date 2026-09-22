import { useLayoutEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { Group } from 'three';
import { PARTS, SHAPES } from './scene/ragdoll/config';
import PlayerBean from './scene/PlayerBean';
import { COSTUME_NAMES, type SelectableCostumeId } from './scene/visual/costumes';

function DisplayCharacter({ costumeId }: { costumeId: SelectableCostumeId }) {
  const visual = useRef<Group>(null);
  const invalidate = useThree(state => state.invalidate);
  useLayoutEffect(() => {
    const root = visual.current;
    if (!root) return;
    PARTS.forEach((name, index) => {
      const shape = SHAPES[name];
      root.children[index].position.set(shape.x, shape.y + 0.79, 0);
    });
    invalidate();
  }, [costumeId, invalidate]);
  return <group rotation={[0, -0.22, 0]}>
    <PlayerBean ref={visual} color="#e8bfa2" costume={costumeId} />
  </group>;
}

/** Uses the same nine body-local meshes as the arenas, without a physics world. */
export default function CostumePreview({ costumeId }: { costumeId: SelectableCostumeId }) {
  return <div className="pl-costume-preview" role="img" aria-label={`${COSTUME_NAMES[costumeId]} kostümünün 3D önizlemesi`}>
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: [0, 1.2, 4.3], fov: 33, near: 0.1, far: 10 }}
      onCreated={({ camera }) => camera.lookAt(0, 1.08, 0)}
      gl={{ alpha: true, antialias: true }}
      fallback={<span className="pl-preview-fallback">3D önizleme kullanılamıyor.</span>}
    >
      <hemisphereLight args={["#fff1dc", "#6c7472", 2.0]} />
      <directionalLight position={[3, 6, 5]} intensity={2.0} color="#fff1dc" />
      <DisplayCharacter costumeId={costumeId} />
    </Canvas>
  </div>;
}
