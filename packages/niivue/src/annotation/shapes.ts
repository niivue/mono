import type {
  AnnotationPoint,
  AnnotationTool,
  PolygonWithHoles,
} from "@/NVTypes"

const ELLIPSE_SEGMENTS = 64

export function generateEllipse(
  start: AnnotationPoint,
  end: AnnotationPoint,
): PolygonWithHoles[] {
  const cx = (start.x + end.x) / 2
  const cy = (start.y + end.y) / 2
  const rx = Math.abs(end.x - start.x) / 2
  const ry = Math.abs(end.y - start.y) / 2
  if (rx < 0.25 && ry < 0.25) return []
  const outer: AnnotationPoint[] = []
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2
    outer.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry })
  }
  return [{ outer, holes: [] }]
}

export function generateRectangle(
  start: AnnotationPoint,
  end: AnnotationPoint,
): PolygonWithHoles[] {
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  if (dx < 0.25 && dy < 0.25) return []
  const minX = Math.min(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxX = Math.max(start.x, end.x)
  const maxY = Math.max(start.y, end.y)
  const outer: AnnotationPoint[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  return [{ outer, holes: [] }]
}

function perp(dx: number, dy: number, len: number): [number, number] {
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d < 1e-9) return [0, 0]
  return [(-dy / d) * len, (dx / d) * len]
}

export function generateLine(
  start: AnnotationPoint,
  end: AnnotationPoint,
  width: number,
): PolygonWithHoles[] {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.25) return []
  const hw = width / 2
  const [px, py] = perp(dx, dy, hw)
  const outer: AnnotationPoint[] = [
    { x: start.x + px, y: start.y + py },
    { x: end.x + px, y: end.y + py },
    { x: end.x - px, y: end.y - py },
    { x: start.x - px, y: start.y - py },
  ]
  return [{ outer, holes: [] }]
}

export function generateArrow(
  start: AnnotationPoint,
  end: AnnotationPoint,
  width: number,
): PolygonWithHoles[] {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.5) return []
  // Normalize direction
  const ux = dx / len
  const uy = dy / len
  const hw = width / 2
  const headWidth = width * 1.5
  let headLength = width * 4
  if (headLength > len * 0.5) headLength = len * 0.5
  // Shaft end (where arrowhead starts)
  const shaftEndX = end.x - ux * headLength
  const shaftEndY = end.y - uy * headLength
  const [px, py] = perp(dx, dy, hw)
  const [hpx, hpy] = perp(dx, dy, headWidth)
  // 7-point polygon: shaft left → shaft right → head base right → tip → head base left
  const outer: AnnotationPoint[] = [
    { x: start.x + px, y: start.y + py },
    { x: shaftEndX + px, y: shaftEndY + py },
    { x: shaftEndX + hpx, y: shaftEndY + hpy },
    { x: end.x, y: end.y },
    { x: shaftEndX - hpx, y: shaftEndY - hpy },
    { x: shaftEndX - px, y: shaftEndY - py },
    { x: start.x - px, y: start.y - py },
  ]
  return [{ outer, holes: [] }]
}

export function constrainCircleEnd(
  start: AnnotationPoint,
  end: AnnotationPoint,
): AnnotationPoint {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const size = Math.max(Math.abs(dx), Math.abs(dy))
  return {
    x: start.x + Math.sign(dx || 1) * size,
    y: start.y + Math.sign(dy || 1) * size,
  }
}

export function generateCircle(
  start: AnnotationPoint,
  end: AnnotationPoint,
): PolygonWithHoles[] {
  const constrained = constrainCircleEnd(start, end)
  const cx = (start.x + constrained.x) / 2
  const cy = (start.y + constrained.y) / 2
  const r = Math.abs(constrained.x - start.x) / 2
  if (r < 0.25) return []
  const outer: AnnotationPoint[] = []
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2
    outer.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r })
  }
  return [{ outer, holes: [] }]
}

export function generateShape(
  tool: AnnotationTool,
  start: AnnotationPoint,
  end: AnnotationPoint,
  strokeWidth: number,
): PolygonWithHoles[] {
  switch (tool) {
    case "ellipse":
    case "measureEllipse":
      return generateEllipse(start, end)
    case "rectangle":
    case "measureRect":
      return generateRectangle(start, end)
    case "line":
    case "measureLine":
      return generateLine(start, end, strokeWidth)
    case "arrow":
      return generateArrow(start, end, strokeWidth)
    case "circle":
    case "measureCircle":
      return generateCircle(start, end)
    default:
      return []
  }
}
