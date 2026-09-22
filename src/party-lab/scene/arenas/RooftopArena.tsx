import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import { Color, Fog } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildRooftop, readKit, ROOFTOP_KIT_URL } from "./buildRooftop";
import { FOG, HAZE_COLOR, HAZE_FAR_COLOR, HAZE_Y } from "./rooftopScenery";
import { ROOFTOP_MAP } from "../../../../shared/party-lab/maps/rooftop";
import type { ColliderRole } from "../../../../shared/party-lab/maps";

function RooftopScene() {
  const gltf = useLoader(GLTFLoader, ROOFTOP_KIT_URL);
  const gl = useThree((state) => state.gl);
  const built = useMemo(
    () => buildRooftop(readKit(gltf.scene), Math.min(4, gl.capabilities.getMaxAnisotropy())),
    [gltf, gl]
  );
  // The loader cache owns the kit geometry/textures; only locally created resources are disposed.
  useEffect(() => () => built.dispose(), [built]);
  return <primitive object={built.group} />;
}

const PLACEHOLDER_COLORS: Partial<Record<ColliderRole, string>> = {
  floor: "#3a3d40",
  parapet: "#8a4f3f",
  building: "#8a4f3f",
  deck: "#8d8a83",
  stairs: "#8d8a83",
  condenser: "#d9d4c7",
  curb: "#8d8a83",
};

/**
 * Shown while the ~180 KB kit loads (or if it fails): every gameplay collider as a
 * plain box straight from the shared map, so what you see is what you collide with.
 */
function Placeholder() {
  return (
    <group>
      {ROOFTOP_MAP.colliders.map((c, i) => {
        if (c.shape === "cylinder") return null;
        const floor = c.role === "floor",
          height = floor ? 0.2 : c.half.y * 2;
        const ramp = c.shape === "ramp" ? Math.atan2(c.half.y * 2, c.half.x * 2) : 0;
        return (
          <mesh
            key={i}
            position={[c.center.x, floor ? -0.1 : c.center.y, c.center.z]}
            rotation={[0, 0, ramp]}
            scale={ramp ? [1 / Math.cos(ramp), 0.08 / height, 1] : 1}
          >
            <boxGeometry args={[c.half.x * 2, height, c.half.z * 2]} />
            <meshStandardMaterial color={PLACEHOLDER_COLORS[c.role] ?? "#777"} roughness={0.95} />
          </mesh>
        );
      })}
      <mesh position={[0, HAZE_Y, -30]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[260, 260]} />
        <meshBasicMaterial color={HAZE_COLOR} fog={false} />
      </mesh>
    </group>
  );
}

/** A missing/broken kit must not take the match down: keep the plain slab. */
class KitBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Party Lab rooftop kit could not be displayed", error);
  }
  render() {
    return this.state.failed ? <Placeholder /> : this.props.children;
  }
}

export default function RooftopArena() {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(HAZE_FAR_COLOR, FOG.near, FOG.far);
    scene.background = new Color(HAZE_FAR_COLOR);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  return (
    <>
      <hemisphereLight args={["#f4efe6", "#41575b", 1.65]} />
      <directionalLight position={[-5, 11, 7]} intensity={2.1} color="#fff1dc" />
      <KitBoundary>
        <Suspense fallback={<Placeholder />}>
          <RooftopScene />
        </Suspense>
      </KitBoundary>
    </>
  );
}
