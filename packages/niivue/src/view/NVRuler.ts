import { SLICE_TYPE } from "@/NVConstants";
import type { BuildTextFn, GlyphBatch } from "./NVFont";
import type { BuildLineFn, LineData } from "./NVLine";
import type { SliceTile } from "./NVSliceLayout";

// In-plane axis indices per orientation: [u, v] (depth axis excluded)
const IN_PLANE: Record<number, [number, number]> = {
  [SLICE_TYPE.AXIAL]: [0, 1],
  [SLICE_TYPE.CORONAL]: [0, 2],
  [SLICE_TYPE.SAGITTAL]: [1, 2],
};

// Nice ruler lengths to try, in descending order (in current unit)
const NICE_VALUES = [10, 5, 2, 1];

/**
 * Select the 2D tile with the longest in-plane dimension.
 * Returns null if no 2D tiles exist.
 */
function selectRulerTile(tiles: SliceTile[]): SliceTile | null {
  let best: SliceTile | null = null;
  let bestSpan = 0;
  for (const tile of tiles) {
    if (tile.axCorSag === SLICE_TYPE.RENDER) continue;
    if (!tile.screen || !tile.leftTopWidthHeight) continue;
    const axes = IN_PLANE[tile.axCorSag];
    if (!axes) continue;
    const fov = tile.screen.fovMM;
    const span = Math.max(
      Math.abs(fov[axes[0]] as number),
      Math.abs(fov[axes[1]] as number),
    );
    if (span > bestSpan) {
      bestSpan = span;
      best = tile;
    }
  }
  return best;
}

/**
 * Choose a ruler length (in mm) and label string.
 * Returns { lengthMM, label } or null if nothing reasonable fits.
 */
function chooseRulerSize(
  fovMM: number,
): { lengthMM: number; label: string } | null {
  // Ruler should fit within ~65% of tile width
  const maxMM = fovMM * 0.65;
  if (maxMM <= 0) return null;

  // Try cm first (if object is large enough)
  if (fovMM >= 50) {
    for (const v of NICE_VALUES) {
      const mm = v * 10; // cm → mm
      if (mm <= maxMM) {
        return { lengthMM: mm, label: `${v} cm` };
      }
    }
  }
  // Fall back to mm
  for (const v of NICE_VALUES) {
    if (v <= maxMM) {
      return { lengthMM: v, label: `${v} mm` };
    }
  }
  return null;
}

export type RulerResult = { lines: LineData[]; labels: GlyphBatch[] };

/**
 * Build a checkerboard scale ruler on the best 2D tile.
 * Returns lines and labels in canvas-pixel coordinates, or null if no ruler should be drawn.
 */
export function buildRuler(
  tiles: SliceTile[],
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  fontColor: number[],
  _backColor: number[],
): RulerResult | null {
  const tile = selectRulerTile(tiles);
  if (!tile?.screen || !tile.leftTopWidthHeight) return null;

  const axes = IN_PLANE[tile.axCorSag];
  if (!axes) return null;

  const fov = tile.screen.fovMM;
  // Use the horizontal (u-axis) FOV for ruler sizing since we draw horizontally
  const hFovMM = Math.abs(fov[axes[0]] as number);
  const [tileLeft, tileTop, tileWidth, tileHeight] = tile.leftTopWidthHeight;

  const ruler = chooseRulerSize(hFovMM);
  if (!ruler) return null;

  // Convert mm to pixels
  const pxPerMM = tileWidth / hFovMM;
  const rulerPx = ruler.lengthMM * pxPerMM;

  const segments = 5;
  const segPx = rulerPx / segments;
  const thickness = 4;

  // Position: bottom-right of tile, inset by 8px from edges
  const inset = 8;
  const rulerRight = tileLeft + tileWidth - inset;
  const rulerLeft = rulerRight - rulerPx;
  const rulerY = tileTop + tileHeight - inset - thickness;

  const lines: LineData[] = [];
  // Draw checkerboard segments (only odd segments filled)
  for (let i = 0; i < segments; i++) {
    if (i % 2 === 0) {
      const x0 = rulerLeft + i * segPx;
      const x1 = rulerLeft + (i + 1) * segPx;
      lines.push(buildLine(x0, rulerY, x1, rulerY, thickness, fontColor));
    }
  }
  // Top and bottom border lines (thin)
  const borderThick = 1;
  const borderTop = rulerY - thickness / 2;
  const borderBot = rulerY + thickness / 2;
  lines.push(
    buildLine(
      rulerLeft,
      borderTop,
      rulerRight,
      borderTop,
      borderThick,
      fontColor,
    ),
  );
  lines.push(
    buildLine(
      rulerLeft,
      borderBot,
      rulerRight,
      borderBot,
      borderThick,
      fontColor,
    ),
  );
  // Left and right caps
  lines.push(
    buildLine(
      rulerLeft,
      borderTop,
      rulerLeft,
      borderBot,
      borderThick,
      fontColor,
    ),
  );
  lines.push(
    buildLine(
      rulerRight,
      borderTop,
      rulerRight,
      borderBot,
      borderThick,
      fontColor,
    ),
  );
  // Segment dividers
  for (let i = 1; i < segments; i++) {
    const x = rulerLeft + i * segPx;
    lines.push(buildLine(x, borderTop, x, borderBot, borderThick, fontColor));
  }

  // Label centered below the ruler
  const labelX = rulerLeft + rulerPx / 2;
  const labelY = rulerY + thickness / 2 + 2;
  const labels: GlyphBatch[] = [];
  const label = buildText(ruler.label, labelX, labelY, 0.8, fontColor, 0, 0);
  if (label.count > 0) labels.push(label);

  return { lines, labels };
}
