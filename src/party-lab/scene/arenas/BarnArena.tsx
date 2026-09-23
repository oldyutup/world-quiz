import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { Color, Fog, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { buildBarn, readBarnKit } from "./buildBarn";
import { createBarnEffects, createHeldWeapons } from "./barnCombatVisuals";
import type { BarnBridge } from "./barnView";
import { PLAYERS } from "../players";
import { BARN_KIT_URL, FOG, SKY_COLOR } from "./barnScenery";
import { BARN_MAP } from "../../../../shared/party-lab/maps/barn";
import { rampHull, type ColliderRole } from "../../../../shared/party-lab/maps";

function BarnScene({ bridge }: { bridge?: BarnBridge }) {
  const gltf = useLoader(GLTFLoader, BARN_KIT_URL);
  const kit = useMemo(() => readBarnKit(gltf.scene), [gltf]);
  const built = useMemo(() => buildBarn(kit), [kit]);
  const held = useMemo(() => createHeldWeapons(kit, PLAYERS.length), [kit]);
  // The loader cache owns the kit geometry/materials; only locally created resources are disposed.
  useEffect(() => () => built.dispose(), [built]);
  // With combat, the arena loop drives pickups, traps and held weapons once per frame
  // (after it interpolates the poses); without, the preview just turns.
  useEffect(
    () =>
      bridge?.subscribe((frame) => {
        built.update(frame.elapsed, frame.props);
        held.update(frame.held);
      }),
    [bridge, built, held]
  );
  useFrame((state) => {
    if (!bridge) built.update(state.clock.elapsedTime);
  });
  return (
    <>
      <primitive object={built.group} />
      <primitive object={held.group} />
    </>
  );
}

/** Tracers, muzzle flashes and impact puffs: kit-free, so they work with the placeholder too. */
function BarnEffects({ bridge }: { bridge: BarnBridge }) {
  const effects = useMemo(() => createBarnEffects(), []);
  useEffect(() => () => effects.dispose(), [effects]);
  useEffect(() => bridge.subscribe((frame) => effects.update(frame)), [bridge, effects]);
  return <primitive object={effects.group} />;
}

const PLACEHOLDER_COLORS: Partial<Record<ColliderRole, string>> = {
  floor: "#a47b52",
  wall: "#7a3a2c",
  loft: "#8a5d3b",
  post: "#634028",
  stairs: "#9b744b",
  step: "#b39a58",
  rail: "#5c3b25",
  hay: "#c2a45a",
  crate: "#a8773a",
  stall: "#8f6240",
  barrel: "#6b4a2e",
};

/**
 * Shown while the ~0.25 MB kit loads (or if it fails): every gameplay collider as a
 * plain shape straight from the shared map, so what you see is what you collide with.
 */
function Placeholder() {
  const ramps = useMemo(
    () =>
      BARN_MAP.colliders.flatMap((c) =>
        c.shape === "ramp" ? [new ConvexGeometry(rampHull(c).map((p) => new Vector3(p.x, p.y, p.z)))] : []
      ),
    []
  );
  useEffect(() => () => ramps.forEach((g) => g.dispose()), [ramps]);
  return (
    <group>
      {BARN_MAP.colliders.map((c, i) => {
        const color = PLACEHOLDER_COLORS[c.role] ?? "#777";
        if (c.shape === "ramp") return null;
        if (c.shape === "cylinder")
          return (
            <mesh key={i} position={[c.center.x, c.center.y, c.center.z]}>
              <cylinderGeometry args={[c.radius, c.radius, c.halfHeight * 2, 16]} />
              <meshStandardMaterial color={color} roughness={0.95} />
            </mesh>
          );
        return (
          <mesh key={i} position={[c.center.x, c.center.y, c.center.z]}>
            <boxGeometry args={[c.half.x * 2, c.half.y * 2, c.half.z * 2]} />
            <meshStandardMaterial color={color} roughness={0.95} />
          </mesh>
        );
      })}
      {ramps.map((geometry, i) => (
        <mesh key={`ramp-${i}`} geometry={geometry}>
          <meshStandardMaterial color={PLACEHOLDER_COLORS.stairs} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/** A missing/broken kit must not take the arena down: keep the collider view. */
class KitBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Party Lab barn kit could not be displayed", error);
  }
  render() {
    return this.state.failed ? <Placeholder /> : this.props.children;
  }
}

export default function BarnArena({ bridge }: { bridge?: BarnBridge }) {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(SKY_COLOR, FOG.near, FOG.far);
    scene.background = new Color(SKY_COLOR);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  return (
    <>
      {/* Even light for an inside-the-barn camera; a warm ground bounce keeps the roof and undersides readable. */}
      <hemisphereLight args={["#eef3f7", "#b0916c", 2.1]} />
      <directionalLight position={[-1.5, 14, 10]} intensity={2.1} color="#fff0d8" />
      <KitBoundary>
        <Suspense fallback={<Placeholder />}>
          <BarnScene bridge={bridge} />
        </Suspense>
      </KitBoundary>
      {bridge && <BarnEffects bridge={bridge} />}
    </>
  );
}
