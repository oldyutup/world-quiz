import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildBlockout, buildPropScenery, PROP_KIT_URL, readPropKit, type PropKit } from "./scenery";

function KitProps({ onKit }: { onKit: (kit: PropKit | null) => void }) {
  const gltf = useLoader(GLTFLoader, PROP_KIT_URL);
  const kit = useMemo(() => readPropKit(gltf.scene), [gltf]);
  const built = useMemo(() => buildPropScenery(kit), [kit]);
  // The merged copies are ours; the loader cache keeps the kit itself.
  useEffect(() => () => built.dispose(), [built]);
  useEffect(() => {
    onKit(kit);
    return () => onKit(null);
  }, [kit, onKit]);
  return <primitive object={built.group} />;
}

/** Until the kit is in (or if it never loads), plain shapes stand where the props are: an obstacle is never invisible. */
function Blockout() {
  const built = useMemo(buildBlockout, []);
  useEffect(() => () => built.dispose(), [built]);
  return <primitive object={built.group} />;
}

class KitBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Party Lab prop hunt kit could not be displayed", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Orman Kampı's kit props (scenery.ts): they load on their own and the round never waits.
 * `onKit` hands the loaded kit to the playground (the disguises draw the same models), null while none.
 */
export default function PropHuntScenery({ onKit }: { onKit: (kit: PropKit | null) => void }) {
  return (
    <KitBoundary fallback={<Blockout />}>
      <Suspense fallback={<Blockout />}>
        <KitProps onKit={onKit} />
      </Suspense>
    </KitBoundary>
  );
}
