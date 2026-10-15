import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useLoader } from "@react-three/fiber";
import type { Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { PropMapId } from "../../../../shared/party-lab/maps/propTypes";
import { buildBlockout, buildPropScenery, PROP_KIT_URL, readPropKit, type PropKit, type PropSceneryMeshes } from "./scenery";
import { buildMarketBlockout, buildMarketScenery, MARKET_KIT_URL, readMarketKit } from "./market/scenery";

/** Each map's kit: where it is, how its nodes are read, what is built from it, and the stand-in until it is in. */
const KITS: Readonly<Record<PropMapId, { url: string; read: (root: Object3D) => PropKit; build: (kit: PropKit) => PropSceneryMeshes; blockout: () => PropSceneryMeshes }>> = {
  camp: { url: PROP_KIT_URL, read: readPropKit, build: buildPropScenery, blockout: buildBlockout },
  market: { url: MARKET_KIT_URL, read: readMarketKit, build: buildMarketScenery, blockout: buildMarketBlockout },
};

function KitProps({ map, onKit }: { map: PropMapId; onKit: (kit: PropKit | null) => void }) {
  const source = KITS[map];
  const gltf = useLoader(GLTFLoader, source.url);
  const kit = useMemo(() => source.read(gltf.scene), [gltf, source]);
  const built = useMemo(() => source.build(kit), [kit, source]);
  // The merged copies are ours; the loader cache keeps the kit itself.
  useEffect(() => () => built.dispose(), [built]);
  useEffect(() => {
    onKit(kit);
    return () => onKit(null);
  }, [kit, onKit]);
  return <primitive object={built.group} />;
}

/** Until the kit is in (or if it never loads), plain shapes stand where the props are: an obstacle is never invisible. */
function Blockout({ map }: { map: PropMapId }) {
  const built = useMemo(() => KITS[map].blockout(), [map]);
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
 * A Saklambaç map's kit props (Orman Kampı: scenery.ts; Market: market/scenery.ts): they load on
 * their own and the round never waits. `onKit` hands the loaded kit to the playground (the
 * disguises draw the same models), null while none. Only the played map's kit is fetched.
 */
export default function PropHuntScenery({ onKit, map = "camp" }: { onKit: (kit: PropKit | null) => void; map?: PropMapId }) {
  return (
    <KitBoundary fallback={<Blockout map={map} />}>
      <Suspense fallback={<Blockout map={map} />}>
        <KitProps map={map} onKit={onKit} />
      </Suspense>
    </KitBoundary>
  );
}
