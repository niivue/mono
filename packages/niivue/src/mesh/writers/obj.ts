export const extensions = ["OBJ"];

export async function write(
  positions: Float32Array,
  indices: Uint32Array,
): Promise<ArrayBuffer> {
  let content = "";
  for (let i = 0; i < positions.length; i += 3) {
    content += `v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}\n`;
  }
  // OBJ indices are 1-based
  for (let i = 0; i < indices.length; i += 3) {
    content += `f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}\n`;
  }
  return new TextEncoder().encode(content).buffer;
}
