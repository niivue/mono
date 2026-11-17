// OHIF's measurement CSV (downloadCSVReport) skips rows without getReport.
// Columns follow cornerstone's measurement mappings, so NiiVue and cornerstone
// rows share them.
type RowData = Record<string, unknown>

/** A row's getReport: its values under cornerstone's column names. */
export function rowReport(
  toolName: string,
  data: RowData,
  points: ReadonlyArray<ReadonlyArray<number>>,
  frameOfReferenceUID?: string,
): () => { columns: string[]; values: unknown[] } {
  return () => {
    const columns = ['AnnotationType']
    const values: unknown[] = [`NiiVue:${toolName}`]
    const add = (column: string, value: unknown) => {
      columns.push(column)
      values.push(value)
    }
    if (data.width !== undefined) {
      add('Length', data.length)
      add('Width', data.width)
      add('Unit', data.unit)
    } else if (data.length !== undefined) {
      add('Length', data.length)
      add('Unit', data.unit)
    } else if (data.value !== undefined)
      add(`Probe (${data.modalityUnit})`, data.value)
    else if (data.angle !== undefined) add('Angle (°)', data.angle)
    else if (data.mean !== undefined) {
      add(`max (${data.unit})`, data.max)
      add(`mean (${data.unit})`, data.mean)
      add(`std (${data.unit})`, data.stdDev)
      add('Area', data.area)
      add('Unit', data.areaUnit)
    } else if (data.area !== undefined) {
      add('Area', data.area)
      add('Unit', data.areaUnit)
    }
    if (frameOfReferenceUID) add('FrameOfReferenceUID', frameOfReferenceUID)
    if (points.length) add('points', points.map((p) => p.join(' ')).join(';'))
    return { columns, values }
  }
}
