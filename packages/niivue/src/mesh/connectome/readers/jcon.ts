import type {
  NVConnectomeData,
  NVConnectomeEdge,
  NVConnectomeNode,
  NVConnectomeOptions,
} from "@/NVTypes";
import type { ConnectomeFileData } from "../index";
import { convertDenseToSparse, defaultConnectomeOptions } from "../index";

export const extensions = ["JCON"];

/**
 * Read a JCON (JSON Connectome) file.
 * Handles both sparse and dense (legacy) formats.
 */
export async function read(
  buffer: ArrayBufferLike,
): Promise<ConnectomeFileData> {
  const text = new TextDecoder().decode(buffer);
  const json = JSON.parse(text) as Record<string, unknown>;

  // Extract display options from the file (if present)
  const fileOptions: Partial<NVConnectomeOptions> = {};
  if (typeof json.nodeColormap === "string")
    fileOptions.nodeColormap = json.nodeColormap;
  if (typeof json.nodeColormapNegative === "string")
    fileOptions.nodeColormapNegative = json.nodeColormapNegative;
  if (typeof json.nodeMinColor === "number")
    fileOptions.nodeMinColor = json.nodeMinColor;
  if (typeof json.nodeMaxColor === "number")
    fileOptions.nodeMaxColor = json.nodeMaxColor;
  if (typeof json.nodeScale === "number")
    fileOptions.nodeScale = json.nodeScale;
  if (typeof json.edgeColormap === "string")
    fileOptions.edgeColormap = json.edgeColormap;
  if (typeof json.edgeColormapNegative === "string")
    fileOptions.edgeColormapNegative = json.edgeColormapNegative;
  if (typeof json.edgeMin === "number") fileOptions.edgeMin = json.edgeMin;
  if (typeof json.edgeMax === "number") fileOptions.edgeMax = json.edgeMax;
  if (typeof json.edgeScale === "number")
    fileOptions.edgeScale = json.edgeScale;

  // Detect format variant
  if (isDenseFormat(json)) {
    return readDense(json, fileOptions);
  }
  if (isSparseFormat(json)) {
    return readSparse(json, fileOptions);
  }
  throw new Error(
    "Unrecognized JCON format: expected sparse or dense connectome",
  );
}

/** Dense format: nodes.names/X/Y/Z/Color/Size + flat edge matrix */
function isDenseFormat(json: Record<string, unknown>): boolean {
  const nodes = json.nodes as Record<string, unknown> | undefined;
  return (
    !!nodes && "names" in nodes && "X" in nodes && Array.isArray(json.edges)
  );
}

/** Sparse format: nodes[] array of objects + edges[] array of objects */
function isSparseFormat(json: Record<string, unknown>): boolean {
  return Array.isArray(json.nodes) && Array.isArray(json.edges);
}

function readDense(
  json: Record<string, unknown>,
  fileOptions: Partial<NVConnectomeOptions>,
): ConnectomeFileData {
  const nodesObj = json.nodes as {
    names: string[];
    X: number[];
    Y: number[];
    Z: number[];
    Color: number[];
    Size: number[];
  };
  const edgesFlat = json.edges as number[];
  const { data } = convertDenseToSparse(nodesObj, edgesFlat);
  return {
    data,
    options: { ...defaultConnectomeOptions, ...fileOptions },
  };
}

function readSparse(
  json: Record<string, unknown>,
  fileOptions: Partial<NVConnectomeOptions>,
): ConnectomeFileData {
  const rawNodes = json.nodes as Array<Record<string, unknown>>;
  const rawEdges = json.edges as Array<Record<string, unknown>>;

  const nodes: NVConnectomeNode[] = rawNodes.map((n) => ({
    name: (n.name as string) ?? "",
    x: (n.x as number) ?? 0,
    y: (n.y as number) ?? 0,
    z: (n.z as number) ?? 0,
    colorValue: (n.colorValue as number) ?? 0,
    sizeValue: (n.sizeValue as number) ?? 1,
  }));

  const edges: NVConnectomeEdge[] = rawEdges.map((e) => ({
    first: (e.first as number) ?? 0,
    second: (e.second as number) ?? 0,
    colorValue: (e.colorValue as number) ?? 0,
  }));

  const data: NVConnectomeData = { nodes, edges };
  return {
    data,
    options: { ...defaultConnectomeOptions, ...fileOptions },
  };
}
