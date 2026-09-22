import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ROOFTOP_MAP } from "../../../../shared/party-lab/maps/rooftop";
import { PLAYERS } from "../players";
import {
  ACCESS_BUILDING,
  BACKDROP,
  BACKDROP_WINDOWS,
  CONDENSER,
  CURB_DEPTH,
  CURB_HEIGHT,
  DECK,
  DECK_HEIGHT,
  DRAINS,
  FACADE_BOTTOM,
  FRONT_GAP_HALF,
  HATCH,
  HAZARD_STRIPES,
  HAZE_COLOR,
  HAZE_FAR_COLOR,
  HAZE_OPACITY,
  HAZE_Y,
  PARAPET_DEPTH,
  PARAPET_HEIGHT,
  ROOF,
  STAIRS,
  WATER_TANK,
  WINDOW,
  WINDOW_SPOTS,
} from "./rooftopScenery";
import { WorldGeometry } from "./worldGeometry";

export const ROOFTOP_KIT_URL = "/party-lab/maps/rooftop/rooftop-kit.glb";

/** Parts of the kit GLB, keyed by node name (see scripts/build-party-lab-rooftop-kit.mjs). */
export type KitNode = "ACUnit" | "Parapet" | "Stairs" | "DoorFrame" | "Door" | "Drain" | "Hatch" | "Swatches";
export interface KitPart {
  geometry: BufferGeometry;
  material: Material;
}
export interface RooftopKit {
  parts: Record<KitNode, KitPart[]>;
  materials: Record<string, MeshStandardMaterial>;
}

export function readKit(root: Object3D): RooftopKit {
  const nodes: KitNode[] = ["ACUnit", "Parapet", "Stairs", "DoorFrame", "Door", "Drain", "Hatch", "Swatches"];
  const parts = {} as Record<KitNode, KitPart[]>;
  const materials: Record<string, MeshStandardMaterial> = {};
  for (const name of nodes) {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`rooftop-kit.glb is missing ${name}`);
    parts[name] = [];
    node.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as MeshStandardMaterial;
      parts[name].push({ geometry: mesh.geometry, material });
      materials[material.name] = material;
    });
  }
  for (const needed of ["Asphalt", "Concrete", "RedBrick", "MetalConcrete", "Ornaments", "Glass"])
    if (!materials[needed]) throw new Error(`rooftop-kit.glb is missing material ${needed}`);
  return { parts, materials };
}

const matrix = (x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1) =>
  new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotY),
    new Vector3(sx, sy, sz)
  );

/** Yellow/charcoal diagonal paint, 0.5 m period when mapped with 0.5 m world UVs. */
function hazardTexture() {
  const size = 32,
    data = new Uint8Array(size * size * 4);
  const yellow = [214, 170, 58],
    dark = [38, 38, 40];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = (x + y) % size < size / 2 ? yellow : dark;
      data.set([...c, 255], (y * size + x) * 4);
    }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Geometry with a per-vertex colour, for merging differently tinted pieces into one draw call. */
function tinted(geometry: BufferGeometry, color: string) {
  const c = new Color(color),
    count = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new Float32BufferAttribute(Array.from({ length: count }, () => [c.r, c.g, c.b]).flat(), 3));
  return geometry.index ? geometry.toNonIndexed() : geometry;
}
const placed = (geometry: BufferGeometry, x: number, y: number, z: number, rotX = 0) => {
  if (rotX) geometry.rotateX(rotX);
  return geometry.translate(x, y, z);
};

/**
 * Builds the static rooftop scene from the kit and the shared gameplay layout.
 * Visual only: no physics is created or read here.
 */
export function buildRooftop(kit: RooftopKit, anisotropy = 4) {
  const group = new Group();
  group.name = "rooftop";
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(value: T) => {
    owned.push(value);
    return value;
  };
  const add = (object: Object3D, name: string) => {
    object.name = name;
    object.matrixAutoUpdate = false;
    object.updateMatrix();
    group.add(object);
    return object;
  };
  const kitMaterial = kit.materials;
  for (const m of Object.values(kitMaterial)) {
    const map = m.map as Texture | null;
    if (map && map.anisotropy !== anisotropy) {
      map.anisotropy = anisotropy;
      map.needsUpdate = true;
    }
  }

  // Surfaces reuse the kit textures with world-scaled UVs.
  const asphalt = own(new MeshStandardMaterial({ map: kitMaterial.Asphalt.map, color: "#c9ccce", roughness: 0.95, metalness: 0 }));
  const brick = own(new MeshStandardMaterial({ map: kitMaterial.RedBrick.map, color: "#e6d9d2", roughness: 0.9, metalness: 0 }));
  const concrete = own(new MeshStandardMaterial({ map: kitMaterial.Concrete.map, color: "#d9d6cf", roughness: 0.9, metalness: 0 }));
  const hazard = own(hazardTexture());
  const stripes = own(new MeshStandardMaterial({ map: hazard, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));

  const roofTop = new WorldGeometry(4).box([ROOF.minX, -0.2, ROOF.minZ], [ROOF.maxX, 0, ROOF.maxZ], ["py"]);
  const brickSurfaces = new WorldGeometry(2);
  const concreteSurfaces = new WorldGeometry(2);
  const glassSurfaces = new WorldGeometry(1);
  const stripeSurfaces = new WorldGeometry(0.5);

  // Building below the roof: brick walls into the haze, a flush concrete band marking the roof line.
  brickSurfaces.box([ROOF.minX, FACADE_BOTTOM, ROOF.minZ], [ROOF.maxX, -0.25, ROOF.maxZ], ["px", "nx", "pz"]);
  concreteSurfaces.box([ROOF.minX, -0.25, ROOF.minZ], [ROOF.maxX, 0, ROOF.maxZ], ["px", "nx", "pz"]);
  for (const w of WINDOW_SPOTS) {
    const y0 = WINDOW.centerY - WINDOW.height / 2,
      y1 = WINDOW.centerY + WINDOW.height / 2,
      half = WINDOW.width / 2,
      out = 0.012;
    if (w.face === "front") {
      glassSurfaces.box([w.x - half, y0, w.z], [w.x + half, y1, w.z + out], ["pz"]);
      concreteSurfaces.box([w.x - half - 0.12, y1, w.z], [w.x + half + 0.12, y1 + 0.2, w.z + out], ["pz"]);
      concreteSurfaces.box([w.x - half - 0.06, y0 - 0.12, w.z], [w.x + half + 0.06, y0, w.z + out], ["pz"]);
    } else {
      const sign = w.face === "right" ? 1 : -1,
        face = w.face === "right" ? "px" : "nx";
      const x0 = sign > 0 ? w.x : w.x - out,
        x1 = sign > 0 ? w.x + out : w.x;
      glassSurfaces.box([x0, y0, w.z - half], [x1, y1, w.z + half], [face]);
      concreteSurfaces.box([x0, y1, w.z - half - 0.12], [x1, y1 + 0.2, w.z + half + 0.12], [face]);
      concreteSurfaces.box([x0, y0 - 0.12, w.z - half - 0.06], [x1, y0, w.z + half + 0.06], [face]);
    }
  }

  // Back wall plinth, terminals (the kit piece has open ends) and the raised course's step.
  const parapetBack = ROOF.minZ - 0.02,
    parapetFront = ROOF.minZ + PARAPET_DEPTH + 0.04;
  concreteSurfaces.box([ROOF.minX, 0, parapetBack], [ROOF.maxX, PARAPET_HEIGHT - 1.2, ROOF.minZ + PARAPET_DEPTH + 0.02], ["py", "pz"]);
  for (const [x0, x1, height] of [
    [ROOF.minX, ROOF.minX + 0.34, PARAPET_HEIGHT + 0.1],
    [ROOF.maxX - 0.34, ROOF.maxX, DECK_HEIGHT + PARAPET_HEIGHT + 0.1],
    [STAIRS.x[0], STAIRS.x[0] + 0.34, DECK_HEIGHT + PARAPET_HEIGHT + 0.1],
  ] as const) {
    brickSurfaces.box([x0, 0, parapetBack], [x1, height, parapetFront], ["px", "nx", "pz"]);
    concreteSurfaces.box([x0 - 0.04, height, parapetBack - 0.02], [x1 + 0.04, height + 0.07, parapetFront + 0.04]);
  }

  // Access building: brick box with a recess for the kit door frame, concrete roof cap.
  const [bx0, bx1] = ACCESS_BUILDING.x,
    [bz0, bz1] = ACCESS_BUILDING.z,
    bh = ACCESS_BUILDING.height,
    doorX = (bx0 + bx1) / 2,
    frameHalf = 1,
    frameTop = 3,
    recess = 0.22; // kit frame is 0.2 deep; 2 cm more avoids coplanar faces behind it
  brickSurfaces.box([bx0, 0, bz0], [bx1, bh, bz1], ["px", "nx"]);
  brickSurfaces.box([bx0, 0, bz0], [doorX - frameHalf, bh, bz1], ["pz"]);
  brickSurfaces.box([doorX + frameHalf, 0, bz0], [bx1, bh, bz1], ["pz"]);
  brickSurfaces.box([doorX - frameHalf, frameTop, bz0], [doorX + frameHalf, bh, bz1], ["pz"]);
  brickSurfaces.box([doorX - frameHalf, 0, bz0], [doorX + frameHalf, frameTop, bz1 - recess], ["pz"]);
  brickSurfaces.box([doorX - frameHalf - 0.1, 0, bz1 - recess], [doorX - frameHalf, frameTop, bz1], ["px"]);
  brickSurfaces.box([doorX + frameHalf, 0, bz1 - recess], [doorX + frameHalf + 0.1, frameTop, bz1], ["nx"]);
  brickSurfaces.box([doorX - frameHalf, frameTop, bz1 - recess], [doorX + frameHalf, frameTop + 0.1, bz1], ["ny"]);
  concreteSurfaces.box([bx0 - 0.1, bh, bz0 - 0.1], [bx1 + 0.1, bh + 0.14, bz1 + 0.1]);

  // Raised deck (concrete) and the two curbs.
  concreteSurfaces.box([DECK.x[0], 0, DECK.z[0]], [DECK.x[1], DECK_HEIGHT, DECK.z[1]], ["py", "pz", "px", "nx"]);
  for (const [x0, x1] of [
    [ROOF.minX, -FRONT_GAP_HALF],
    [FRONT_GAP_HALF, ROOF.maxX],
  ] as const)
    concreteSurfaces.box([x0, 0, ROOF.maxZ - CURB_DEPTH], [x1, CURB_HEIGHT, ROOF.maxZ], ["py", "pz", "nz", "px", "nx"]);

  // Condenser pads (4 cm, visual only).
  for (const side of [-1, 1])
    concreteSurfaces.box(
      [side * CONDENSER.x - CONDENSER.halfX - 0.12, 0, CONDENSER.z - CONDENSER.halfZ - 0.12],
      [side * CONDENSER.x + CONDENSER.halfX + 0.12, 0.04, CONDENSER.z + CONDENSER.halfZ + 0.12],
      ["py", "pz", "px", "nx"]
    );

  for (const [x0, x1, z0, z1, y] of HAZARD_STRIPES) stripeSurfaces.box([x0, y - 0.01, z0], [x1, y + 0.004, z1], ["py"]);

  add(new Mesh(own(roofTop.build()), asphalt), "roof");
  add(new Mesh(own(brickSurfaces.build()), brick), "brick");
  add(new Mesh(own(concreteSurfaces.build()), concrete), "concrete");
  add(new Mesh(own(glassSurfaces.build()), kitMaterial.Glass), "windows");
  add(new Mesh(own(stripeSurfaces.build()), stripes), "hazard-stripes");

  // Kit pieces. Repeated ones are instanced; everything shares the kit materials.
  const instanced = (name: KitNode, matrices: Matrix4[]) => {
    for (const part of kit.parts[name]) {
      const mesh = new InstancedMesh(part.geometry, part.material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      own({ dispose: () => mesh.dispose() });
      add(mesh, `kit-${name}`);
    }
  };
  const single = (name: KitNode, m: Matrix4) => {
    for (const part of kit.parts[name]) {
      const mesh = new Mesh(part.geometry, part.material);
      mesh.applyMatrix4(m);
      add(mesh, `kit-${name}`);
    }
  };
  const parapetZ = ROOF.minZ + PARAPET_DEPTH / 2,
    courseLength = ROOF.maxX - STAIRS.x[0],
    coursePiece = courseLength / 3;
  // The 1.6 m safe wall: a concrete plinth under the 1 m kit parapet (scaled 1.2, not stretched to 1.6).
  const plinth = PARAPET_HEIGHT - 1.2;
  instanced("Parapet", [
    ...Array.from({ length: 7 }, (_, i) => matrix(ROOF.minX + 1 + i * 2, plinth, parapetZ, 0, 1, 1.2)),
    ...Array.from({ length: 3 }, (_, i) =>
      matrix(STAIRS.x[0] + coursePiece * (i + 0.5), PARAPET_HEIGHT, parapetZ, 0, coursePiece / 2, DECK_HEIGHT)
    ),
  ]);
  instanced("ACUnit", [-1, 1].map((side) => matrix(side * CONDENSER.x, 0.04, CONDENSER.z, 0, 2, (CONDENSER.height - 0.04) / 1.2 * 2, 2)));
  instanced("Drain", DRAINS.map((d) => matrix(d.x, 0.002, d.z)));
  single("Hatch", matrix(HATCH.x, 0.004, HATCH.z));
  single(
    "Stairs",
    matrix((STAIRS.x[0] + STAIRS.x[1]) / 2, 0, (STAIRS.z[0] + STAIRS.z[1]) / 2, -Math.PI / 2, (STAIRS.z[1] - STAIRS.z[0]) / 2, DECK_HEIGHT / 1.0067, (STAIRS.x[1] - STAIRS.x[0]) / 1.99)
  );
  single("DoorFrame", matrix(doorX, 0, bz1));
  single("Door", matrix(doorX, 0, bz1));

  // Spawn marks: painted rings in each slot colour (one draw call).
  const rings = mergeGeometries(
    ROOFTOP_MAP.spawns.map((s, id) => tinted(placed(new RingGeometry(0.72, 0.8, 40), s.x, 0.006, s.z, -Math.PI / 2), PLAYERS[id].color))
  );
  add(new Mesh(own(rings), own(new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }))), "spawn-rings");

  // Antenna on the access building (silhouette only).
  const mast = mergeGeometries([
    tinted(placed(new CylinderGeometry(0.035, 0.045, 1.9, 6), bx0 + 0.45, bh + 0.14 + 0.95, bz0 + 0.45), "#3d4145"),
    tinted(placed(new BoxGeometry(0.7, 0.035, 0.035), bx0 + 0.45, bh + 1.55, bz0 + 0.45), "#3d4145"),
    tinted(placed(new BoxGeometry(0.45, 0.035, 0.035), bx0 + 0.45, bh + 1.25, bz0 + 0.45), "#3d4145"),
  ]);
  const flat = own(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
  add(new Mesh(own(mast), flat), "antenna");

  // Water tank on the low roof behind the back lane.
  const t = WATER_TANK,
    tankParts = [
      tinted(placed(new CylinderGeometry(t.radius, t.radius, t.height, 18, 1), t.x, t.base + t.legs + t.height / 2, t.z), "#6b5646"),
      tinted(placed(new CylinderGeometry(0.02, t.radius + 0.08, 0.5, 18, 1), t.x, t.base + t.legs + t.height + 0.25, t.z), "#4a4440"),
      tinted(placed(new CylinderGeometry(t.radius + 0.02, t.radius + 0.02, 0.08, 18, 1), t.x, t.base + t.legs + t.height * 0.3, t.z), "#3b3634"),
      tinted(placed(new CylinderGeometry(t.radius + 0.02, t.radius + 0.02, 0.08, 18, 1), t.x, t.base + t.legs + t.height * 0.7, t.z), "#3b3634"),
      ...[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) =>
          tinted(placed(new BoxGeometry(0.12, t.legs, 0.12), t.x + sx * t.radius * 0.7, t.base + t.legs / 2, t.z + sz * t.radius * 0.7), "#2f3336")
        )
      ),
    ];
  add(new Mesh(own(mergeGeometries(tankParts)), flat), "water-tank");

  // Neighbouring buildings: kit brick/concrete with per-block atmospheric tint, window grids
  // (a few lit), three draw calls in total, fogged into the haze. Bottoms hide below the haze.
  const backdropWalls = new WorldGeometry(2.4),
    backdropRoofs = new WorldGeometry(2.4),
    backdropWindows = new WorldGeometry(1);
  const dullBrick = new Color("#8f8987"),
    distant = new Color("#7d8a95"),
    darkPane = new Color("#1d252b"),
    litPane = new Color("#b48d5a");
  const W = BACKDROP_WINDOWS;
  BACKDROP.forEach((b, index) => {
    const tint = dullBrick.clone().lerp(distant, b.tone).toArray() as [number, number, number];
    const bottom = Math.min(HAZE_Y - 1, b.top - 6),
      [x0, x1] = b.x,
      [z0, z1] = b.z;
    backdropWalls.box([x0, bottom, z0], [x1, b.top, z1], ["px", "nx", "pz", "nz"], tint);
    backdropRoofs.box([x0 - 0.12, b.top, z0 - 0.12], [x1 + 0.12, b.top + 0.18, z1 + 0.12], ["py", "pz", "px", "nx"], tint);
    // Windows on the camera-facing side and the side facing the arena.
    const faces: ("pz" | "px" | "nx")[] = ["pz"];
    if (x1 < ROOF.minX) faces.push("px");
    if (x0 > ROOF.maxX) faces.push("nx");
    for (const face of faces) {
      const along = face === "pz" ? [x0, x1] : [z0, z1],
        columns = Math.floor((along[1] - along[0] - 1) / W.spacingX);
      for (let row = 0, y = b.top - W.firstBelowTop; y - W.height > bottom + 1; row++, y -= W.spacingY)
        for (let col = 0; col < columns; col++) {
          const c = along[0] + (along[1] - along[0] - (columns - 1) * W.spacingX) / 2 + col * W.spacingX;
          const lit = (index * 31 + row * 7 + col * 13 + (face === "pz" ? 0 : 5)) % W.litEvery === 0;
          const pane = (lit ? litPane : darkPane).toArray() as [number, number, number];
          const h = W.width / 2,
            yy: [number, number] = [y - W.height, y];
          if (face === "pz") backdropWindows.box([c - h, yy[0], z1], [c + h, yy[1], z1 + 0.02], ["pz"], pane);
          else if (face === "px") backdropWindows.box([x1, yy[0], c - h], [x1 + 0.02, yy[1], c + h], ["px"], pane);
          else backdropWindows.box([x0 - 0.02, yy[0], c - h], [x0, yy[1], c + h], ["nx"], pane);
        }
    }
  });
  add(new Mesh(own(backdropWalls.build()), own(new MeshStandardMaterial({ map: kitMaterial.RedBrick.map, vertexColors: true, roughness: 1, metalness: 0 }))), "backdrop-walls");
  add(new Mesh(own(backdropRoofs.build()), own(new MeshStandardMaterial({ map: kitMaterial.Concrete.map, vertexColors: true, roughness: 1, metalness: 0 }))), "backdrop-roofs");
  add(new Mesh(own(backdropWindows.build()), own(new MeshBasicMaterial({ vertexColors: true }))), "backdrop-windows");

  // City haze: an unlit gradient floor that swallows falling bodies before elimination.
  const haze = new PlaneGeometry(260, 260, 26, 26);
  haze.rotateX(-Math.PI / 2);
  haze.translate(0, HAZE_Y, -30);
  const hazeNear = new Color(HAZE_COLOR),
    hazeFar = new Color(HAZE_FAR_COLOR),
    position = haze.getAttribute("position"),
    colors: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const d = Math.hypot(position.getX(i), position.getZ(i) + 1),
      k = Math.min(1, Math.max(0, (d - 9) / 34));
    const c = hazeNear.clone().lerp(hazeFar, k * k * (3 - 2 * k));
    colors.push(c.r, c.g, c.b);
  }
  haze.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const hazeMesh = add(
    new Mesh(own(haze), own(new MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: HAZE_OPACITY, depthWrite: false }))),
    "haze"
  );
  hazeMesh.renderOrder = 1;

  return {
    group,
    dispose() {
      for (const item of owned) item.dispose();
      owned.length = 0;
    },
  };
}
