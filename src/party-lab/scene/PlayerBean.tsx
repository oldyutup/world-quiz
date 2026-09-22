import { forwardRef } from "react";
import { PARTS, SHAPES } from "./ragdoll/config";
import type { Group } from "three";

/** Each child transform is copied from its own real dynamic body. No skeletal pose. */
const PlayerBean = forwardRef<Group, { color: string }>(function PlayerBean(
  { color },
  ref
) {
  return (
    <group ref={ref}>
      {PARTS.map((name) => {
        const shape = SHAPES[name];
        return (
          <group key={name} name={name}>
            <mesh name="skin">
              {shape.half ? (
                <capsuleGeometry args={[shape.radius, shape.half * 2, 4, 10]} />
              ) : (
                <sphereGeometry args={[shape.radius, 12, 8]} />
              )}
              <meshStandardMaterial
                color={color}
                roughness={0.8}
                emissive="#f5c66c"
                emissiveIntensity={0}
              />
            </mesh>
            {name === "head" && (
              <>
                {[-1, 1].map((side) => (
                  <mesh
                    key={side}
                    position={[side * 0.105, 0.045, 0.267]}
                    scale={[0.75, 1, 0.5]}
                  >
                    <sphereGeometry args={[0.046, 8, 6]} />
                    <meshBasicMaterial color="#253c3e" />
                  </mesh>
                ))}
                <group name="stars" position={[0, 0.42, 0]} visible={false}>
                  {[0, 1, 2].map((i) => (
                    <mesh
                      key={i}
                      position={[
                        Math.cos((i * Math.PI * 2) / 3) * 0.3,
                        0,
                        Math.sin((i * Math.PI * 2) / 3) * 0.3,
                      ]}
                    >
                      <octahedronGeometry args={[0.08, 0]} />
                      <meshBasicMaterial color="#f3d586" />
                    </mesh>
                  ))}
                </group>
              </>
            )}
          </group>
        );
      })}
    </group>
  );
});
export default PlayerBean;
