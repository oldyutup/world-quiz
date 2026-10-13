import { Color, HemisphereLight, DirectionalLight, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderTarget, type WebGLRenderer } from "three";
import { createCharacterVisual } from "../visual/characterVisual";
import { PARTS, SHAPES } from "../ragdoll/config";
import type { BomberLook } from "./source";

const SIZE = 128;
/**
 * Head-and-shoulders pictures of the players' characters (their costume and colour) for the
 * HUD, drawn once with the arena's renderer into a small target. Data URLs, "" when it fails.
 */
export function renderPortraits(gl: WebGLRenderer, looks: readonly BomberLook[]): string[] {
  const target = new WebGLRenderTarget(SIZE, SIZE);
  target.texture.colorSpace = SRGBColorSpace;
  const scene = new Scene(),
    camera = new PerspectiveCamera(26, 1, 0.1, 20);
  scene.add(new HemisphereLight("#fff6e6", "#5d6470", 2.4));
  const sun = new DirectionalLight("#ffffff", 1.8);
  sun.position.set(2, 4, 5);
  scene.add(sun);
  const previous = gl.getRenderTarget(),
    clear = gl.getClearColor(new Color()),
    alpha = gl.getClearAlpha();
  const pixels = new Uint8Array(SIZE * SIZE * 4),
    canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  const urls = looks.map((look) => {
    const person = createCharacterVisual(look.color, look.costume);
    try {
      PARTS.forEach((name, index) => person.root.children[index].position.set(SHAPES[name].x, SHAPES[name].y, 0));
      person.root.rotation.y = -0.35;
      scene.add(person.root);
      const head = person.root.children[PARTS.indexOf("head")].getWorldPosition(new Vector3());
      camera.position.set(0.05, head.y + 0.05, 2.1);
      camera.lookAt(0, head.y - 0.22, 0);
      gl.setRenderTarget(target);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(scene, camera);
      gl.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, pixels);
      if (!ctx) return "";
      const image = ctx.createImageData(SIZE, SIZE);
      // Rows come bottom-up from WebGL.
      for (let y = 0; y < SIZE; y++) image.data.set(pixels.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return "";
    } finally {
      scene.remove(person.root);
      person.dispose();
    }
  });
  gl.setRenderTarget(previous);
  gl.setClearColor(clear, alpha);
  target.dispose();
  return urls;
}
