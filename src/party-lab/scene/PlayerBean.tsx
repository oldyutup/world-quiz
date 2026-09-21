import { forwardRef } from "react";
import type { Group } from "three";
import { PHYSICS } from "./physics";

const PlayerBean = forwardRef<Group>(function PlayerBean(_, ref) {
  return (
    <group ref={ref}>
      <mesh>
        <capsuleGeometry args={[PHYSICS.radius, PHYSICS.halfHeight * 2, 6, 12]} />
        <meshStandardMaterial color="#f6c773" roughness={0.75} />
      </mesh>
      {[-1, 1].map(side => (
        <mesh key={side} position={[side * 0.145, 0.2, 0.395]} scale={[0.7, 1, 0.45]}>
          <sphereGeometry args={[0.085, 8, 6]} />
          <meshBasicMaterial color="#253c3e" />
        </mesh>
      ))}
    </group>
  );
});

export default PlayerBean;
