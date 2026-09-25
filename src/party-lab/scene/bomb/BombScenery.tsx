import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CRATE_COLOR } from "./arena";
import { BOMB_KIT_URL, buildBombProps, cratePlacements, readBombKit, type BombKit } from "./scenery";

function KitProps({ onKit }: { onKit: (kit: BombKit | null) => void }) {
  const gltf = useLoader(GLTFLoader, BOMB_KIT_URL);
  const kit = useMemo(() => readBombKit(gltf.scene), [gltf]);
  const built = useMemo(() => buildBombProps(kit), [kit]);
  // The merged copies are ours; the loader cache keeps the kit itself.
  useEffect(() => () => built.dispose(), [built]);
  useEffect(() => {
    onKit(kit);
    return () => onKit(null);
  }, [kit, onKit]);
  return <primitive object={built.group} />;
}

/** Until the kit is in (or if it never loads), plain wooden boxes stand where the crates are: an obstacle is never invisible. */
function CrateFallback() {
  return (
    <group name="bomb-crate-fallback">
      {cratePlacements().map((p, k) => (
        <mesh key={k} position={[p.x, p.scale[1] / 2, p.z]}>
          <boxGeometry args={[p.scale[0] - 0.04, p.scale[1], p.scale[2] - 0.04]} />
          <meshLambertMaterial color={CRATE_COLOR} />
        </mesh>
      ))}
    </group>
  );
}

class KitBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Party Lab bomb kit could not be displayed", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Oyun Parkı's kit props (see scenery.ts); they load on their own and the round never waits.
 * `onKit` hands the loaded kit to the playground (the carrier's bomb model), null while none.
 */
export default function BombScenery({ onKit }: { onKit: (kit: BombKit | null) => void }) {
  return (
    <KitBoundary fallback={<CrateFallback />}>
      <Suspense fallback={<CrateFallback />}>
        <KitProps onKit={onKit} />
      </Suspense>
    </KitBoundary>
  );
}
