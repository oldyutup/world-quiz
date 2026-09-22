import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Group } from 'three';
import { createCharacterVisual } from './visual/characterVisual';
import type { CostumeId } from './visual/costumes';

/** The arenas still own every transform, visibility and combat indicator. */
const PlayerBean = forwardRef<Group, { color: string; costume?: CostumeId }>(function PlayerBean(
  { color, costume = 'default' }, ref
) {
  const root = useRef<Group>(null!);
  useImperativeHandle(ref, () => root.current, []);
  useLayoutEffect(() => {
    const visual = createCharacterVisual(color, costume);
    const parts = [...visual.root.children];
    const group = root.current;
    group.add(...parts);
    return () => {
      group.remove(...parts);
      visual.dispose();
    };
  }, [color, costume]);
  return <group ref={root} />;
});
export default PlayerBean;
