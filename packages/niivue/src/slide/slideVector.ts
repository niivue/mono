// Vector annotation layer for a slide, in *slide* base-pixel coordinates
// (resolution-independent, unlike the SlideDrawing raster). Shapes are simple
// point lists so they map cleanly to SVG elements and to the existing
// annotation `shapes` generators. Export produces a standalone .svg whose
// viewBox is the slide's pixel extent, so the annotation lines up with the slide
// in any viewer.

export type SlideVectorKind = 'polygon' | 'polyline'

export interface SlideVectorShape {
  kind: SlideVectorKind
  /** Vertices in slide base pixels. */
  points: Array<[number, number]>
  /** CSS color for the stroke (e.g. '#e62d37'). */
  color: string
  /** Stroke width in slide pixels. */
  strokeWidth: number
}

export class SlideVectorLayer {
  readonly shapes: SlideVectorShape[] = []
  /** Bumped on any change, so the renderer knows to repaint. */
  version = 0

  add(shape: SlideVectorShape): void {
    this.shapes.push(shape)
    this.version++
  }

  /** Add a closed polygon from slide-pixel vertices. Ignores < 3 points. */
  addPolygon(
    points: ReadonlyArray<readonly [number, number]>,
    color: string,
    strokeWidth = 6,
  ): boolean {
    if (points.length < 3) return false
    this.shapes.push({
      kind: 'polygon',
      points: points.map(([x, y]) => [x, y]),
      color,
      strokeWidth,
    })
    this.version++
    return true
  }

  /** Remove the most recently added shape. */
  removeLast(): boolean {
    if (this.shapes.length === 0) return false
    this.shapes.pop()
    this.version++
    return true
  }

  clear(): void {
    if (this.shapes.length === 0) return
    this.shapes.length = 0
    this.version++
  }

  /**
   * Serialize to a standalone SVG document sized to the slide's pixel extent
   * (`width` x `height`), so the paths register with the slide in any viewer.
   */
  toSVG(width: number, height: number): string {
    const round = (n: number): string => (Math.round(n * 100) / 100).toString()
    const body = this.shapes
      .map((s) => {
        const pts = s.points
          .map(([x, y]) => `${round(x)},${round(y)}`)
          .join(' ')
        const tag = s.kind === 'polygon' ? 'polygon' : 'polyline'
        return `  <${tag} points="${pts}" fill="none" stroke="${s.color}" stroke-width="${round(s.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round" />`
      })
      .join('\n')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}">\n${body}\n</svg>\n`
  }
}
