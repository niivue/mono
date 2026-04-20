import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the images directory in this package. */
export const imagesDir = resolve(__dirname, "../images");

/** Absolute path to the volumes subdirectory. */
export const volumesDir = resolve(imagesDir, "volumes");

/** Absolute path to the meshes subdirectory. */
export const meshesDir = resolve(imagesDir, "meshes");

/** Resolve an image name to its absolute file path. */
export function imagePath(name: string): string {
  return resolve(imagesDir, name);
}
