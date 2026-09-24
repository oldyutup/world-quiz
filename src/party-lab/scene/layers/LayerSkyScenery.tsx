import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildSkyScenery, LAYERS_KIT_URL, readSkyKit } from "./skyScenery";

function SkyScenery() {
  const gltf = useLoader(GLTFLoader, LAYERS_KIT_URL);
  const built = useMemo(() => buildSkyScenery(readSkyKit(gltf.scene)), [gltf]);
  // The merged copies are ours; the loader cache keeps the kit itself.
  useEffect(() => () => built.dispose(), [built]);
  return <primitive object={built.group} />;
}

/** Decoration only: a missing or broken kit leaves the plain sky, never the round. */
class SceneryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Party Lab layers kit could not be displayed", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** "Gök Petekleri" background for Katman Kaosu (see skyScenery.ts); loads on its own, the round never waits. */
export default function LayerSkyScenery() {
  return (
    <SceneryBoundary>
      <Suspense fallback={null}>
        <SkyScenery />
      </Suspense>
    </SceneryBoundary>
  );
}
