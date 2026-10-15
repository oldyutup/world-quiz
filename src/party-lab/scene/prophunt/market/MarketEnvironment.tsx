import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Color, Fog } from "three";
import { buildMarketArena } from "./arena";

const OUTSIDE = "#cfe4f2";
/** The shop's bright, even light (strip lights everywhere: every corner readable), the arena, the daylight outside the glass. */
export default function MarketEnvironment() {
  const scene = useThree((state) => state.scene);
  const arena = useMemo(buildMarketArena, []);
  useEffect(() => {
    const previous = { fog: scene.fog, background: scene.background };
    scene.fog = new Fog(OUTSIDE, 40, 110);
    scene.background = new Color(OUTSIDE);
    return () => {
      scene.fog = previous.fog;
      scene.background = previous.background;
    };
  }, [scene]);
  useEffect(() => () => arena.dispose(), [arena]);
  return (
    <>
      <hemisphereLight args={["#ffffff", "#c9c4b8", 1.75]} />
      <directionalLight position={[4, 30, 6]} intensity={1.25} color="#ffffff" />
      <directionalLight position={[-12, 18, -10]} intensity={0.45} color="#f4f7ff" />
      <primitive object={arena.group} />
    </>
  );
}
