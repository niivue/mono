/**
 * The planes an agent can ask for, and the arithmetic behind them.
 *
 * NiiVue keeps a clip plane as a depth and two angles, and a render camera
 * as two angles; this module is the part both ends of the socket share:
 * naming a plane, the normal it has, the camera that faces it, and the
 * depth that puts it through a point. Nothing here touches NiiVue or the
 * DOM, so it is tested as plain functions.
 */

/**
 * The whole planes an agent can ask for, as NiiVue's azimuth and elevation.
 * Named for the side they take off, the way the app's `c` key names them.
 */
export const PLANE_ANGLES: ReadonlyArray<{
  name: string
  azimuth: number
  elevation: number
}> = [
  { name: 'left', azimuth: 270, elevation: 0 },
  { name: 'right', azimuth: 90, elevation: 0 },
  { name: 'posterior', azimuth: 0, elevation: 0 },
  { name: 'anterior', azimuth: 180, elevation: 0 },
  { name: 'inferior', azimuth: 0, elevation: -90 },
  { name: 'superior', azimuth: 0, elevation: 90 },
]

/**
 * The anatomical names for the same planes, for an agent that thinks in
 * slices rather than sides. Each is one of the two sides it could mean; the
 * chosen one is the side the experiments already cut.
 */
export const PLANE_ALIASES: Readonly<Record<string, string>> = {
  coronal: 'posterior',
  sagittal: 'left',
  axial: 'superior',
  transverse: 'superior',
  horizontal: 'superior',
}

/**
 * Past this depth, either way, NiiVue's shader treats the plane as no plane
 * at all. NiiVue's own default reads back as depth -2 and its "off" as +2,
 * so a test of whether a plane is cut looks at the size of the depth, not
 * its sign.
 */
export const PLANE_OFF = 1.8

/** Whether a plane at this depth cuts anything: within `PLANE_OFF` of the centre on either side. */
export function planeDepthCuts(depth: number): boolean {
  return Math.abs(depth) < PLANE_OFF
}

/**
 * The angles for a plane an agent named, or null when the name is not one
 * of ours. `current` keeps the plane the scene already has when one is cut,
 * and falls back to coronal when nothing is, so a first visit gets a face
 * to land on and a later one does not lose the orientation the technician
 * chose.
 */
export function resolvePlane(
  name: string | undefined,
  current: readonly [number, number, number] | null,
): { name: string; azimuth: number; elevation: number } | null {
  const wanted = (name ?? 'current').trim().toLowerCase()
  if (wanted === 'current') {
    if (current && planeDepthCuts(current[0])) {
      const known = PLANE_ANGLES.find(
        (plane) =>
          plane.azimuth === current[1] && plane.elevation === current[2],
      )
      return (
        known ?? { name: 'current', azimuth: current[1], elevation: current[2] }
      )
    }
    return PLANE_ANGLES.find((plane) => plane.name === 'posterior') ?? null
  }
  const canonical = PLANE_ALIASES[wanted] ?? wanted
  return PLANE_ANGLES.find((plane) => plane.name === canonical) ?? null
}

/**
 * The unit normal NiiVue gives a clip plane at these angles.
 *
 * Mirrors `depthAziElevToClipPlane` in NiiVue, which turns the azimuth half
 * a turn before converting, so a plane named for the posterior side has its
 * normal pointing anterior, `[0, 1, 0]`. The app's sweep relies on the same
 * fact for its coronal default.
 */
export function clipNormal(
  azimuth: number,
  elevation: number,
): [number, number, number] {
  const phi = -elevation * (Math.PI / 180)
  const theta = ((azimuth + 180 - 90) % 360) * (Math.PI / 180)
  const v: [number, number, number] = [
    Math.cos(phi) * Math.cos(theta),
    Math.cos(phi) * Math.sin(theta),
    Math.sin(phi),
  ]
  const length = Math.hypot(v[0], v[1], v[2])
  if (length <= 0) return v
  return [v[0] / length, v[1] / length, v[2] / length]
}

/**
 * The direction NiiVue's render camera looks along at these angles, from the
 * near side of the volume to the far, in the same fraction space as a clip
 * plane's normal.
 *
 * Mirrors `calculateRayDirection` in NiiVue: the model matrix mirrors x,
 * tilts by `270 - elevation` about x and turns by `azimuth - 180` about z,
 * and the view direction is that matrix's inverse applied to the screen's
 * own depth axis. Worked through, that is a compass bearing in the axial
 * plane with the elevation tilting it down: the default view, azimuth 110
 * and elevation 10, looks rightwards and a little back and down, which is a
 * camera on the left, in front and above.
 */
export function viewDirection(
  azimuth: number,
  elevation: number,
): [number, number, number] {
  const az = azimuth * (Math.PI / 180)
  const el = elevation * (Math.PI / 180)
  return [
    Math.cos(el) * Math.sin(az),
    Math.cos(el) * Math.cos(az),
    -Math.sin(el),
  ]
}

/**
 * The camera angles that look straight at the face a plane at these angles
 * exposes: the view direction along the plane's normal, from the side the
 * cut takes off into the side it keeps.
 *
 * NiiVue's shader keeps the side the normal points to, so the exposed face
 * looks back along the normal; a camera whose view direction is that normal
 * sits on the cut-away side and sees the face square on. Comparing
 * `viewDirection` with `clipNormal` term by term, that is the plane's own
 * elevation and its azimuth turned the other way round the vertical, so a
 * plane cut from the right (azimuth 90) is faced from azimuth 270.
 */
export function cameraForPlane(
  azimuth: number,
  elevation: number,
): { azimuth: number; elevation: number } {
  return { azimuth: (((360 - azimuth) % 360) + 360) % 360, elevation }
}

/**
 * The depth that puts a plane with this normal through `frac`.
 *
 * NiiVue's shader keeps the plane as `dot(normal, p - 0.5) + depth = 0` in
 * the volume's fraction space, so the depth through a point is the negative
 * of its signed distance from the middle along the normal.
 */
export function depthThrough(
  normal: readonly [number, number, number],
  frac: readonly number[],
): number {
  const depth = -(
    normal[0] * (frac[0] - 0.5) +
    normal[1] * (frac[1] - 0.5) +
    normal[2] * (frac[2] - 0.5)
  )
  // Tidy the -0 that a point on the middle plane produces.
  return depth === 0 ? 0 : depth
}

/** The depth that turns the plane off: past `PLANE_OFF`, as the app's own Clip slider sets it. */
export const PLANE_NONE = 2

/**
 * Whether two planes' angles name the same plane. NiiVue 1.0 keeps a plane
 * as its normal and works the angles back out of it when asked, so a plane
 * set at an azimuth of 270 can come back as -90, give or take rounding:
 * comparing the normals is what survives the round trip.
 */
export function samePlane(
  a: readonly [number, number],
  b: readonly [number, number],
): boolean {
  const n = clipNormal(a[0], a[1])
  const m = clipNormal(b[0], b[1])
  return n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0.9999
}

/**
 * The name for the plane NiiVue reports: a side when its angles are one of
 * the six, `off` past the depth the shader ignores, and `custom` otherwise.
 */
export function namePlane(
  depth: number,
  azimuth: number,
  elevation: number,
): string {
  if (!planeDepthCuts(depth)) return 'off'
  const known = PLANE_ANGLES.find((plane) =>
    samePlane([plane.azimuth, plane.elevation], [azimuth, elevation]),
  )
  return known?.name ?? 'custom'
}
