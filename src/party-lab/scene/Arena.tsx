import { BUMPERS, PLATFORM } from "./physics";

export default function Arena() {
  return (
    <group>
      <mesh position={[0, -PLATFORM.height / 2, 0]}>
        <boxGeometry args={[PLATFORM.width, PLATFORM.height, PLATFORM.depth]} />
        <meshStandardMaterial color="#82bdae" roughness={0.85} />
      </mesh>
      <mesh position={[0, -1.45, 0]}>
        <boxGeometry args={[13.3, 0.5, 11.3]} />
        <meshStandardMaterial color="#416f70" />
      </mesh>
      {/* Flat perimeter markings make the unguarded edge easy to read. */}
      {[-1, 1].map(side => (
        <group key={side}>
          <mesh position={[0, 0.006, side * 5.72]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[13.45, 0.1]} /><meshBasicMaterial color="#d7ebcc" />
          </mesh>
          <mesh position={[side * 6.72, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.1, 11.45]} /><meshBasicMaterial color="#d7ebcc" />
          </mesh>
        </group>
      ))}
      {BUMPERS.map(bumper => (
        <group key={bumper.color} position={[bumper.x, 0, bumper.z]}>
          <mesh position={[0, bumper.height / 2, 0]}>
            <cylinderGeometry args={[bumper.radius, bumper.radius, bumper.height, 20]} />
            <meshStandardMaterial color={bumper.color} roughness={0.8} />
          </mesh>
          <mesh position={[0, bumper.height + 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[bumper.radius * 0.58, bumper.radius * 0.66, 20]} />
            <meshBasicMaterial color="#f3ecdd" />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.008, 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.8, 0.85, 32]} /><meshBasicMaterial color="#d7ebcc" />
      </mesh>
    </group>
  );
}
