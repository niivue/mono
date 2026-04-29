/**
 * Emit api.generated.json from NVControlBase TypeScript source.
 *
 * Walks `packages/niivue/src/NVControlBase.ts`, classifies every public
 * member, and produces a structured JSON descriptor that downstream
 * emitters (Python wrapper, JS shim) consume. Anything we can't translate
 * cleanly lands in the `skipped` section with a reason. Those become
 * either hand-written code or future codegen improvements.
 *
 * The JSON file is checked in. Reviews of niivue API changes show up as
 * diffs in api.generated.json; downstream emitters re-run automatically.
 */
import * as path from 'node:path'
import * as url from 'node:url'
import {
  type ClassDeclaration,
  type GetAccessorDeclaration,
  type JSDocableNode,
  type MethodDeclaration,
  Node,
  Project,
  type SetAccessorDeclaration,
  SyntaxKind,
  type Type,
} from 'ts-morph'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const niivueRoot = path.join(repoRoot, 'packages/niivue')
const niivueSrc = path.join(niivueRoot, 'src')

// JS members inherited from EventTarget / overridden on the class. Python
// uses traitlet observers (`widget.observe(...)`), not addEventListener,
// so these have no Python analogue.
const EVENTTARGET_ALLOWLIST = new Set([
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'emit',
])

// Methods that take or return non-JSON-serializable values (DOM handles,
// JS callbacks, objects with prototype methods, etc.) and therefore cannot
// be invoked or consumed from Python through the command channel.
const NON_SERIALIZABLE_METHODS = new Map<string, string>([
  [
    'attachToCanvas',
    'arguments are not JSON-serializable (DOM handle or JS object)',
  ],
  [
    'createExtensionContext',
    'return value is not JSON-serializable (JS extension context handle)',
  ],
  [
    'registerVolumeTransform',
    'argument is not JSON-serializable (volume transform with JS function hooks)',
  ],
  [
    'useLoader',
    'argument is not JSON-serializable (converter must be a JS function)',
  ],
])

// NiiVue events the JS template silences before forwarding to Python.
// `canvasResize` and `viewAttached` fire at every layout tick during
// mount (tens to hundreds of times per second on cold load); forwarding
// them via `_msg_outbox` floods the WebSocket and disconnects the
// JupyterLab comm. These names are filtered out of `NIIVUE_EVENT_NAMES`
// so `nv.on(...)` rejects subscriptions that would never fire instead
// of accepting them silently.
const SKIP_EVENT_FORWARDING = ['canvasResize', 'viewAttached', 'viewDestroyed']

// ============================================================
// Type classifier
// ============================================================

type PyTraitlet =
  | { kind: 'Bool' }
  | { kind: 'Float' }
  | { kind: 'Int' }
  | { kind: 'Unicode' }
  | { kind: 'List'; elem: PyTraitlet; length: number | null }
  | { kind: 'Enum'; values: (string | number)[] }
  | { kind: 'Any' }

type ClassifyResult =
  | { ok: true; traitlet: PyTraitlet; tsText: string }
  | { ok: false; reason: string; tsText: string }

function classifyType(t: Type): ClassifyResult {
  const tsText = shortenType(t.getText())

  // Unwrap `T | undefined` / `T | null`: the optional wrapper is common
  // for "value or unset". Nullability is preserved in the Python emitter
  // via .tag(allow_none=True). Here we just take the non-nullable side.
  if (t.isUnion()) {
    const nonNullish = t
      .getUnionTypes()
      .filter((u) => !u.isUndefined() && !u.isNull())
    if (nonNullish.length === 0) {
      return { ok: false, reason: 'union of only null/undefined', tsText }
    }
    if (nonNullish.length === 1) {
      const onlyType = nonNullish[0]
      if (!onlyType) {
        return { ok: false, reason: 'union with missing type', tsText }
      }
      return classifyType(onlyType)
    }
    // Boolean-literal union (`true | false`, ts widens this from `boolean`)
    if (nonNullish.every((u) => u.isBooleanLiteral())) {
      return { ok: true, traitlet: { kind: 'Bool' }, tsText }
    }
    // String-literal union to Enum
    if (nonNullish.every((u) => u.isStringLiteral())) {
      const values = nonNullish.map((u) => u.getLiteralValueOrThrow() as string)
      return { ok: true, traitlet: { kind: 'Enum', values }, tsText }
    }
    // Number-literal union to Enum
    if (nonNullish.every((u) => u.isNumberLiteral())) {
      const values = nonNullish.map((u) => u.getLiteralValueOrThrow() as number)
      return { ok: true, traitlet: { kind: 'Enum', values }, tsText }
    }
    // Compatible-classification merge (e.g. vec3 = `[number,number,number]
    // | Float32Array` collapses to `List<Float>[3]`).
    const results = nonNullish.map(classifyType)
    if (results.every((r) => r.ok)) {
      let merged: PyTraitlet | null = results[0].traitlet
      for (const r of results.slice(1)) {
        merged = mergeTraitlets(merged, r.traitlet)
        if (!merged) break
      }
      if (merged) return { ok: true, traitlet: merged, tsText }
    }
    return {
      ok: false,
      reason: `unsupported union: ${tsText}`,
      tsText,
    }
  }

  if (t.isBoolean() || t.isBooleanLiteral()) {
    return { ok: true, traitlet: { kind: 'Bool' }, tsText }
  }
  if (t.isNumber() || t.isNumberLiteral()) {
    return { ok: true, traitlet: { kind: 'Float' }, tsText }
  }
  if (t.isString() || t.isStringLiteral()) {
    return { ok: true, traitlet: { kind: 'Unicode' }, tsText }
  }

  // Tuple to fixed-length List
  if (t.isTuple()) {
    const elems = t.getTupleElements()
    if (elems.length === 0) {
      return {
        ok: false,
        reason: 'empty tuple',
        tsText,
      }
    }
    const firstElem = elems[0]
    if (!firstElem) {
      return {
        ok: false,
        reason: 'tuple with missing element type',
        tsText,
      }
    }
    const elemResult = classifyType(firstElem)
    if (!elemResult.ok) return elemResult
    // All elements should match the first (we don't support mixed tuples)
    for (const e of elems.slice(1)) {
      const r = classifyType(e)
      if (!r.ok || !sameTraitlet(r.traitlet, elemResult.traitlet)) {
        return {
          ok: false,
          reason: `mixed-type tuple: ${tsText}`,
          tsText,
        }
      }
    }
    return {
      ok: true,
      traitlet: {
        kind: 'List',
        elem: elemResult.traitlet,
        length: elems.length,
      },
      tsText,
    }
  }

  // Array to variable-length List
  if (t.isArray()) {
    const elem = t.getArrayElementType()
    if (!elem)
      return { ok: false, reason: 'array with no element type', tsText }
    const elemResult = classifyType(elem)
    if (!elemResult.ok) return elemResult
    return {
      ok: true,
      traitlet: { kind: 'List', elem: elemResult.traitlet, length: null },
      tsText,
    }
  }

  // Typed arrays are JSON-serializable as plain number arrays.
  const symbolName = t.getSymbol()?.getName()
  if (symbolName && /^(Int|Uint|Float)\d+(Clamped)?Array$/.test(symbolName)) {
    return {
      ok: true,
      traitlet: { kind: 'List', elem: { kind: 'Float' }, length: null },
      tsText,
    }
  }

  // Structural number-indexed collection (e.g. gl-matrix's IndexedCollection,
  // anything that exposes `[i: number]: number` with a `length` property).
  // Treat as a variable-length number list.
  const numIndex = t.getNumberIndexType()
  if (numIndex && (numIndex.isNumber() || numIndex.isNumberLiteral())) {
    return {
      ok: true,
      traitlet: { kind: 'List', elem: { kind: 'Float' }, length: null },
      tsText,
    }
  }

  // Type-alias resolution: `vec3`, `vec4` etc. show up as nominal here,
  // but their apparent type may be a tuple. Try the apparent type once.
  const apparent = t.getApparentType()
  if (apparent !== t && apparent.isTuple()) {
    return classifyType(apparent)
  }

  return {
    ok: false,
    reason: `non-serializable nominal type: ${tsText}`,
    tsText,
  }
}

/**
 * Merge two traitlet classifications produced by union members. Returns
 * the most-specific traitlet they're both compatible with, or null if
 * they can't be unified. Used so e.g. vec3 (= `[number,number,number] |
 * Float32Array`) collapses into `List<Float>[3]` rather than failing.
 */
function mergeTraitlets(a: PyTraitlet, b: PyTraitlet): PyTraitlet | null {
  if (sameTraitlet(a, b)) return a
  if (a.kind === 'List' && b.kind === 'List') {
    const elem = mergeTraitlets(a.elem, b.elem)
    if (!elem) return null
    // Prefer the specific length over null (variable). If both specify and
    // they disagree, abort.
    let length: number | null
    if (a.length === null) length = b.length
    else if (b.length === null) length = a.length
    else if (a.length === b.length) length = a.length
    else return null
    return { kind: 'List', elem, length }
  }
  return null
}

function sameTraitlet(a: PyTraitlet, b: PyTraitlet): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function shortenType(t: string): string {
  return t.replace(/import\("[^"]+"\)\./g, '').replace(/\s+/g, ' ')
}

// ============================================================
// Walker
// ============================================================

const project = new Project({
  tsConfigFilePath: path.join(niivueRoot, 'tsconfig.json'),
})

const controlBase = project.getSourceFileOrThrow(
  path.join(niivueSrc, 'NVControlBase.ts'),
)

const cls: ClassDeclaration | undefined = controlBase
  .getClasses()
  .find((c) => c.isDefaultExport())
if (!cls) {
  console.error('Could not find default-exported class in NVControlBase.ts')
  process.exit(1)
}

const className = cls.getName() ?? '<anonymous>'

type PropertyDescriptor = {
  jsName: string
  pyName: string
  tsType: string
  pyTraitlet: PyTraitlet
  hasGetter: boolean
  hasSetter: boolean
  doc: string | null
}

type ParamDescriptor = {
  name: string
  tsType: string
  optional: boolean
  /** Per-parameter description from the corresponding `@param` JSDoc tag. */
  doc: string | null
}

type MethodDescriptor = {
  jsName: string
  pyName: string
  isAsync: boolean
  /**
   * True when the JS method returns a meaningful value to Python
   * (handled via request/response with correlation IDs). False for
   * methods returning void / Promise<void> / Promise<this>, which
   * stay fire-and-forget for the cheap path.
   */
  returnsValue: boolean
  params: ParamDescriptor[]
  returns: string
  /** Method-level JSDoc description (excludes @param / @returns tags). */
  doc: string | null
  /** Description from the `@returns` (or `@return`) tag. */
  returnsDoc: string | null
}

type EventDescriptor = {
  jsName: string
  pyName: string
  detailType: string
  doc: string | null
}

type SkippedItem = {
  jsName: string
  tsType?: string
  reason: string
}

type ApiDescriptor = {
  niivueVersion: string
  source: string
  className: string
  properties: PropertyDescriptor[]
  readonlyProperties: PropertyDescriptor[]
  methods: MethodDescriptor[]
  events: EventDescriptor[]
  skipped: {
    properties: SkippedItem[]
    methods: SkippedItem[]
    events: SkippedItem[]
  }
}

const getters = new Map<string, GetAccessorDeclaration>()
const setters = new Map<string, SetAccessorDeclaration>()
const methods: MethodDeclaration[] = []
const skippedMethods: SkippedItem[] = []

for (const member of cls.getMembers()) {
  switch (member.getKind()) {
    case SyntaxKind.GetAccessor: {
      const g = member as GetAccessorDeclaration
      if (g.getScope() === 'private') continue
      if (g.getName().startsWith('_')) continue
      getters.set(g.getName(), g)
      break
    }
    case SyntaxKind.SetAccessor: {
      const s = member as SetAccessorDeclaration
      if (s.getScope() === 'private') continue
      if (s.getName().startsWith('_')) continue
      setters.set(s.getName(), s)
      break
    }
    case SyntaxKind.MethodDeclaration: {
      const m = member as MethodDeclaration
      if (m.getScope() === 'private') continue
      if (m.getName().startsWith('_')) continue
      if (EVENTTARGET_ALLOWLIST.has(m.getName())) continue
      const nonSerializableReason = NON_SERIALIZABLE_METHODS.get(m.getName())
      if (nonSerializableReason) {
        skippedMethods.push({
          jsName: m.getName(),
          reason: nonSerializableReason,
        })
        continue
      }
      methods.push(m)
      break
    }
  }
}

const properties: PropertyDescriptor[] = []
const readonlyProperties: PropertyDescriptor[] = []
const skippedProperties: SkippedItem[] = []

// Reactive (paired) and read-only properties
for (const [name, getter] of getters) {
  const setter = setters.get(name)
  const tsTypeNode = setter
    ? setter.getParameters()[0]?.getType()
    : getter.getReturnType()
  if (!tsTypeNode) {
    skippedProperties.push({
      jsName: name,
      reason: 'could not resolve type',
    })
    continue
  }
  const cls = classifyType(tsTypeNode)
  if (!cls.ok) {
    skippedProperties.push({
      jsName: name,
      tsType: cls.tsText,
      reason: cls.reason,
    })
    continue
  }
  const desc: PropertyDescriptor = {
    jsName: name,
    pyName: snakeCase(name),
    tsType: cls.tsText,
    pyTraitlet: cls.traitlet,
    hasGetter: true,
    hasSetter: !!setter,
    doc: extractDoc(setter ?? getter),
  }
  if (setter) properties.push(desc)
  else readonlyProperties.push(desc)
}

// Setter-only (rare; treat as write-only reactive)
for (const [name, setter] of setters) {
  if (getters.has(name)) continue
  const tsTypeNode = setter.getParameters()[0]?.getType()
  if (!tsTypeNode) {
    skippedProperties.push({
      jsName: name,
      reason: 'could not resolve type',
    })
    continue
  }
  const cls = classifyType(tsTypeNode)
  if (!cls.ok) {
    skippedProperties.push({
      jsName: name,
      tsType: cls.tsText,
      reason: cls.reason,
    })
    continue
  }
  properties.push({
    jsName: name,
    pyName: snakeCase(name),
    tsType: cls.tsText,
    pyTraitlet: cls.traitlet,
    hasGetter: false,
    hasSetter: true,
    doc: extractDoc(setter),
  })
}

// Methods
const methodDescriptors: MethodDescriptor[] = []
for (const m of methods) {
  try {
    const methodDoc = extractMethodDoc(m)
    const params: ParamDescriptor[] = m.getParameters().map((p) => {
      const name = p.getName()
      return {
        name,
        tsType: shortenType(p.getType().getText()),
        optional: p.isOptional() || p.hasInitializer(),
        doc: methodDoc.paramDocs.get(name) ?? null,
      }
    })
    const returnsText = shortenType(m.getReturnType().getText())
    methodDescriptors.push({
      jsName: m.getName(),
      pyName: snakeCase(m.getName()),
      isAsync: m.isAsync(),
      returnsValue: methodReturnsValue(returnsText),
      params,
      returns: returnsText,
      doc: methodDoc.description,
      returnsDoc: methodDoc.returnsDoc,
    })
  } catch (e) {
    skippedMethods.push({
      jsName: m.getName(),
      reason: String(e),
    })
  }
}

// Events from NVEventMap
const events: EventDescriptor[] = []
const skippedEvents: SkippedItem[] = []
const eventsFile = project
  .getSourceFiles()
  .find((f) => f.getFilePath().endsWith('NVEvents.ts'))
if (eventsFile) {
  const eventMap = eventsFile.getInterface('NVEventMap')
  if (eventMap) {
    for (const p of eventMap.getProperties()) {
      const detailType = shortenType(p.getType().getText())
      events.push({
        jsName: p.getName(),
        pyName: snakeCase(p.getName()),
        detailType,
        doc: extractDoc(p),
      })
    }
  } else {
    skippedEvents.push({
      jsName: '<all>',
      reason: 'NVEventMap interface not found in NVEvents.ts',
    })
  }
} else {
  skippedEvents.push({
    jsName: '<all>',
    reason: 'NVEvents.ts not found',
  })
}

// niivue version from its package.json
const niivuePkg = await Bun.file(path.join(niivueRoot, 'package.json')).json()

const descriptor: ApiDescriptor = {
  niivueVersion: niivuePkg.version,
  source: path.relative(repoRoot, controlBase.getFilePath()),
  className,
  properties: properties.sort((a, b) => a.jsName.localeCompare(b.jsName)),
  readonlyProperties: readonlyProperties.sort((a, b) =>
    a.jsName.localeCompare(b.jsName),
  ),
  methods: methodDescriptors.sort((a, b) => a.jsName.localeCompare(b.jsName)),
  events: events.sort((a, b) => a.jsName.localeCompare(b.jsName)),
  skipped: {
    properties: skippedProperties.sort((a, b) =>
      a.jsName.localeCompare(b.jsName),
    ),
    methods: skippedMethods.sort((a, b) => a.jsName.localeCompare(b.jsName)),
    events: skippedEvents.sort((a, b) => a.jsName.localeCompare(b.jsName)),
  },
}

// Write JSON
const outPath = path.join(__dirname, '..', 'api.generated.json')
await Bun.write(outPath, `${JSON.stringify(descriptor, null, 2)}\n`)

// Write Python (_generated.py)
const pythonPath = path.join(
  __dirname,
  '..',
  'src',
  'ipyniivue',
  '_generated.py',
)
await Bun.write(pythonPath, emitPython(descriptor))

// Write the JS shim *source* (small, reviewable, imports niivue from the
// workspace package). Then bundle it into a self-contained widget.js
// because anywidget serves the _esm via a data:/blob: URL that has no
// hierarchical base for relative imports to resolve against.
const staticDir = path.join(__dirname, '..', 'src', 'ipyniivue', 'static')
const jsTemplatePath = path.join(staticDir, '_widget.template.js')
const jsBundledPath = path.join(staticDir, 'widget.js')
await Bun.write(jsTemplatePath, emitJs(descriptor))

const buildResult = await Bun.build({
  entrypoints: [jsTemplatePath],
  target: 'browser',
  format: 'esm',
})
if (!buildResult.success) {
  for (const log of buildResult.logs) console.error(log)
  console.error('Bun.build failed bundling widget.js')
  process.exit(1)
}
const bundledBlob = buildResult.outputs[0]
if (!bundledBlob) {
  console.error('Bun.build produced no output')
  process.exit(1)
}
let bundledText = await bundledBlob.text()

// niivue's bundled code references assets via
//   `new URL("assets/X", import.meta.url).href`
// which Vite emits so the URL resolves against the served script path.
// anywidget serves widget.js via a `blob:` URL whose scheme is not
// hierarchical, so `new URL` throws at module init. Inline the assets
// as base64 `data:` URLs at bundle time.
const niivueAssetsDir = path.join(niivueRoot, 'dist', 'assets')
const assetPattern = /new URL\("assets\/([^"]+)", import\.meta\.url\)(\.href)?/g
const referencedAssets = new Set<string>()
for (const m of bundledText.matchAll(assetPattern)) {
  if (m[1]) referencedAssets.add(m[1])
}
const dataUrls = new Map<string, string>()
for (const name of referencedAssets) {
  const filePath = path.join(niivueAssetsDir, name)
  const bytes = await Bun.file(filePath).bytes()
  const mime = mimeForExtension(path.extname(name).toLowerCase())
  const b64 = Buffer.from(bytes).toString('base64')
  dataUrls.set(name, `data:${mime};base64,${b64}`)
}
bundledText = bundledText.replace(assetPattern, (match, name) => {
  const url = dataUrls.get(name)
  return url ? JSON.stringify(url) : match
})
bundledText = `${bundledText.replace(/[ \t]+$/gm, '').replace(/\n*$/, '')}\n`

await Bun.write(jsBundledPath, bundledText)

function mimeForExtension(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

// Remove the now-orphaned standalone niivue.js if it exists from an older
// pipeline. It's been folded into widget.js.
const orphanNiivuePath = path.join(staticDir, 'niivue.js')
try {
  await Bun.file(orphanNiivuePath).delete()
} catch {
  // already gone, fine
}

// Summary to stdout
console.log(`# Codegen summary - ${className} @ niivue ${niivuePkg.version}`)
console.log()
console.log(`Wrote ${path.relative(repoRoot, outPath)}`)
console.log()
console.log(
  `Reactive properties: ${descriptor.properties.length}  (skipped ${descriptor.skipped.properties.length})`,
)
console.log(`Read-only properties: ${descriptor.readonlyProperties.length}`)
console.log(
  `Methods: ${descriptor.methods.length}  (skipped ${descriptor.skipped.methods.length})`,
)
console.log(
  `Events: ${descriptor.events.length}  (skipped ${descriptor.skipped.events.length})`,
)

if (descriptor.skipped.properties.length > 0) {
  console.log()
  console.log('## Skipped properties')
  for (const s of descriptor.skipped.properties) {
    console.log(`  ${s.jsName}: ${s.reason}`)
  }
}

if (descriptor.skipped.methods.length > 0) {
  console.log()
  console.log('## Skipped methods')
  for (const s of descriptor.skipped.methods) {
    console.log(`  ${s.jsName}: ${s.reason}`)
  }
}

console.log()
const traitletCounts = new Map<string, number>()
for (const p of descriptor.properties) {
  const k = traitletKindLabel(p.pyTraitlet)
  traitletCounts.set(k, (traitletCounts.get(k) ?? 0) + 1)
}
console.log('## Traitlet histogram')
for (const [k, n] of [...traitletCounts.entries()].sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${k.padEnd(30)} ${n}`)
}

function traitletKindLabel(t: PyTraitlet): string {
  if (t.kind === 'List') {
    return `List<${traitletKindLabel(t.elem)}>${t.length ? `[${t.length}]` : ''}`
  }
  if (t.kind === 'Enum') return `Enum(${t.values.length} vals)`
  return t.kind
}

function snakeCase(s: string): string {
  // Order matters. Each rule inserts an underscore at one kind of word
  // boundary in CamelCase / PascalCase / mixed-with-digits names.
  return (
    s
      // letter, digits, uppercase: split before digits  (in3D to in_3D)
      .replace(/([a-z])(\d+)(?=[A-Z])/g, '$1_$2')
      // digit, uppercase, lowercase: split before uppercase  (1Sl to 1_Sl)
      .replace(/(\d)([A-Z])(?=[a-z])/g, '$1_$2')
      // uppercase run followed by uppercase+lowercase: split (ABCdef to AB_Cdef)
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      // standard camel boundary  (aB to a_B)
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
  )
}

function extractDoc(node: JSDocableNode): string | null {
  const docs = node.getJsDocs()
  if (docs.length === 0) return null
  const text = docs
    .map((d) => d.getDescription().trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || null
}

/**
 * Extract method-level JSDoc plus per-parameter `@param name desc` tags
 * and the `@returns` tag, so the Python emitter can render NumPy-style
 * docstrings with Parameters/Returns blocks. Returns nulls / empty Map
 * when no JSDoc is present.
 */
function extractMethodDoc(node: JSDocableNode): {
  description: string | null
  paramDocs: Map<string, string>
  returnsDoc: string | null
} {
  const description = extractDoc(node)
  const paramDocs = new Map<string, string>()
  let returnsDoc: string | null = null
  for (const doc of node.getJsDocs()) {
    for (const tag of doc.getTags()) {
      const tagName = tag.getTagName()
      // JSDoc convention permits an optional `- ` separator between the
      // name and the description (`@param foo - description`); strip it
      // so the rendered NumPy block reads as plain prose.
      const comment = (tag.getCommentText() ?? '')
        .replace(/^\s*-\s+/, '')
        .trim()
      if (!comment) continue
      if (tagName === 'param' && Node.isJSDocParameterTag(tag)) {
        const name = tag.getName()
        if (name) paramDocs.set(name, comment)
      } else if (tagName === 'returns' || tagName === 'return') {
        returnsDoc = comment
      }
    }
  }
  return { description, paramDocs, returnsDoc }
}

// ============================================================
// Python emitter
// ============================================================

function emitPython(api: ApiDescriptor): string {
  const lines: string[] = []
  lines.push('# This file is auto-generated by scripts/codegen.ts.')
  lines.push('# Do not edit by hand; re-run `bunx nx codegen ipyniivue`.')
  lines.push(`# Source: ${api.source} @ niivue ${api.niivueVersion}`)
  lines.push('')
  lines.push('# ruff: noqa')
  lines.push('# mypy: ignore-errors')
  lines.push('')
  lines.push('from __future__ import annotations')
  lines.push('')
  lines.push('from typing import Any')
  lines.push('')
  lines.push('import anywidget')
  lines.push('import traitlets')
  lines.push('')
  lines.push('')
  lines.push('_UNSET = object()')
  lines.push('_JS_UNDEFINED = {"__ipyniivue_undefined__": True}')
  lines.push('')
  lines.push('')
  lines.push('def _make_args(*values: Any) -> list[Any]:')
  lines.push(
    '    """Build JSON-safe JS call args while preserving omitted optionals."""',
  )
  lines.push('    trimmed = list(values)')
  lines.push('    while trimmed and trimmed[-1] is _UNSET:')
  lines.push('        trimmed.pop()')
  lines.push(
    '    return [_JS_UNDEFINED if value is _UNSET else value for value in trimmed]',
  )
  lines.push('')
  lines.push('')
  lines.push('# Set of event names that JS may dispatch to Python. The')
  lines.push(
    '# hand-written `widget.NiiVue.on()` method validates against this.',
  )
  lines.push(
    '# Events that the JS template intentionally suppresses (high-frequency',
  )
  lines.push(
    '# layout ticks like `canvasResize`) are filtered out so subscribing to',
  )
  lines.push('# them raises instead of silently never firing.')
  lines.push('NIIVUE_EVENT_NAMES: frozenset[str] = frozenset({')
  const skipEvents = new Set(SKIP_EVENT_FORWARDING)
  for (const e of api.events) {
    if (skipEvents.has(e.jsName)) continue
    lines.push(`    "${e.jsName}",`)
  }
  lines.push('})')
  lines.push('')
  lines.push('')
  lines.push(`class _GeneratedNiiVue(anywidget.AnyWidget):`)
  lines.push('    """Auto-generated reactive properties and command methods.')
  lines.push('')
  lines.push(`    Mirrors NiiVueGPU @ niivue ${api.niivueVersion}.`)
  lines.push('')
  lines.push('    Reactive properties are kept in sync with the JS view via')
  lines.push('    anywidget. Methods send command messages over the same')
  lines.push('    channel. Void-returning methods are fire-and-forget;')
  lines.push('    value-returning methods use request/response correlation')
  lines.push('    and should return small JSON-serializable payloads.')
  lines.push('    """')
  lines.push('')
  lines.push(
    '    # Synthetic inbox for Python-to-JS commands. Python may queue',
  )
  lines.push(
    '    # commands immediately after display(nv), before the browser view',
  )
  lines.push(
    '    # has loaded this widget module and registered msg:custom handlers.',
  )
  lines.push(
    '    # Storing commands as synced state makes that cold-start path',
  )
  lines.push(
    '    # durable; JS processes any unhandled seq values after initialize.',
  )
  lines.push('    _msg_inbox = traitlets.List([]).tag(sync=True)')
  lines.push('')
  lines.push(
    '    # Highest seq from `_msg_inbox` that JS has fully drained. JS sets',
  )
  lines.push(
    '    # this after each inbox-processing pass; Python observes it and',
  )
  lines.push(
    "    # prunes acknowledged items so a session's worth of buffer payloads",
  )
  lines.push('    # does not pin base64 strings in trait state forever.')
  lines.push('    _msg_inbox_ack = traitlets.Int(0).tag(sync=True)')
  lines.push('')
  lines.push(
    '    # Synthetic outbox for JS-to-Python messages. anywidget 0.9.x +',
  )
  lines.push(
    '    # ipywidgets 8.x do not reliably route `model.send()` from JS',
  )
  lines.push("    # through Python's `on_msg` callbacks in our setup; the")
  lines.push('    # message succeeds JS-side but vanishes before reaching the')
  lines.push('    # Python widget. As a workaround, JS writes outbound')
  lines.push('    # messages here (a Dict trait with a monotonic seq), Python')
  lines.push('    # observes `change:_msg_outbox`, and `widget.NiiVue` routes')
  lines.push('    # the body through `_dispatch_message`. State-update is the')
  lines.push('    # same channel the seed-step uses, which is verifiably')
  lines.push('    # reliable end-to-end.')
  lines.push('    _msg_outbox = traitlets.Dict({}).tag(sync=True)')
  lines.push('')
  lines.push('    # Reactive properties (read+write, synced)')

  for (const p of api.properties) {
    emitTrait(lines, p, /* readOnly */ false)
  }

  lines.push('')
  lines.push('    # Read-only properties (synced from JS to Python)')
  for (const p of api.readonlyProperties) {
    emitTrait(lines, p, /* readOnly */ true)
  }

  lines.push('')
  lines.push('    # Command methods')
  for (const m of api.methods) {
    emitMethod(lines, m)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

function emitTrait(
  lines: string[],
  p: PropertyDescriptor,
  readOnly: boolean,
): void {
  const traitletExpr = formatTraitlet(p.pyTraitlet)
  const helpEsc = p.doc ? pyStringEscape(p.doc) : null
  const tagArgs: string[] = ['sync=True']
  if (readOnly) tagArgs.push('o2py_readonly=True')
  if (helpEsc) {
    lines.push(`    ${p.pyName} = ${traitletExpr}.tag(${tagArgs.join(', ')})`)
    lines.push(`    """${helpEsc}"""`)
  } else {
    lines.push(`    ${p.pyName} = ${traitletExpr}.tag(${tagArgs.join(', ')})`)
  }
}

function formatTraitlet(t: PyTraitlet): string {
  // Every trait defaults to None and allows None. The JS shim seeds real
  // values from NiiVue on first attach, so Python "doesn't know" until
  // then. This avoids placeholder defaults that may violate trait
  // constraints (e.g. an empty list failing minlen=4) and keeps NiiVue
  // as the single source of truth for defaults.
  switch (t.kind) {
    case 'Bool':
      return 'traitlets.Bool(None, allow_none=True)'
    case 'Float':
      return 'traitlets.Float(None, allow_none=True)'
    case 'Int':
      return 'traitlets.Int(None, allow_none=True)'
    case 'Unicode':
      return 'traitlets.Unicode(None, allow_none=True)'
    case 'List': {
      const elem = formatTraitlet(t.elem)
      const args = [`trait=${elem}`, 'default_value=None']
      if (t.length !== null) {
        args.push(`minlen=${t.length}`, `maxlen=${t.length}`)
      }
      args.push('allow_none=True')
      return `traitlets.List(${args.join(', ')})`
    }
    case 'Enum': {
      const values = t.values
        .map((v) => (typeof v === 'string' ? `"${pyStringEscape(v)}"` : `${v}`))
        .join(', ')
      return `traitlets.Enum([${values}], None, allow_none=True)`
    }
    case 'Any':
      return 'traitlets.Any(allow_none=True)'
  }
}

function emitMethod(lines: string[], m: MethodDescriptor): void {
  const params = m.params
  const sig = params
    .map(
      (p) => `${snakeCase(p.name)}${p.optional ? ': Any = _UNSET' : ': Any'}`,
    )
    .join(', ')
  const argsList = params.map((p) => snakeCase(p.name)).join(', ')
  const argsTuple = params.length === 0 ? '[]' : `_make_args(${argsList})`
  const declParams = sig ? `, ${sig}` : ''
  if (m.returnsValue) {
    // Request/response: await the JS round-trip and return whatever
    // shape JSON.stringify left us with. The Python type is `Any`
    // because the JSON descriptor preserves only the raw TS type
    // string; richer translation (TypedDict / pydantic) is future work.
    lines.push(`    async def ${m.pyName}(self${declParams}) -> Any:`)
    emitMethodDocstring(lines, m)
    lines.push(
      `        return await self._request("${m.jsName}", ${argsTuple})`,
    )
  } else {
    // Fire-and-forget. The cheap path for void/Promise<void>/Promise<this>.
    lines.push(`    def ${m.pyName}(self${declParams}) -> None:`)
    emitMethodDocstring(lines, m)
    lines.push(
      `        self.send({"cmd": "${m.jsName}", "args": ${argsTuple}})`,
    )
  }
  lines.push('')
}

/**
 * Emit a NumPy-style docstring for a method. Trigger is "anything is
 * documented": method-level description, any `@param` text, or `@returns`
 * text. Methods with no JSDoc at all stay docstring-less to avoid
 * churning the generated file with type-only stubs.
 */
function emitMethodDocstring(lines: string[], m: MethodDescriptor): void {
  const hasParamDocs = m.params.some((p) => p.doc)
  const hasAnyDoc = !!m.doc || hasParamDocs || !!m.returnsDoc
  if (!hasAnyDoc) return

  const indent = '        '
  const out: string[] = []

  // Summary + extended description from the method-level description.
  // NumPy convention: summary is one line; extended body follows a blank
  // line; further paragraphs are separated by blank lines.
  //
  // JSDoc varies. Some authors wrap a single sentence across hard
  // newlines (no blank line between them); others put a one-line
  // summary then continue the description on the next line. We honor
  // both: the summary is everything up to the first sentence-ending
  // `[.!?]` followed by whitespace, OR up to the first blank line,
  // whichever comes first. Internal newlines inside the summary are
  // collapsed to spaces so it lands on one line in NumPy style.
  const { summary, extended } = splitSummaryAndBody(m.doc ?? '')
  if (summary) out.push(summary)
  const extendedParas = extended
    .split(/\n\s*\n+/)
    .map((p: string) => p.trim())
    .filter(Boolean)
  let firstExtended = true
  for (const p of extendedParas) {
    if (out.length > 0 && firstExtended) out.push('')
    if (!firstExtended) out.push('')
    firstExtended = false
    for (const ln of p.split('\n')) out.push(ln)
  }

  // Parameters block: emit when any param exists, even without per-param
  // text, so the type info (which Python's signature loses to `Any`) is
  // visible to readers.
  if (m.params.length > 0) {
    if (out.length > 0) out.push('')
    out.push('Parameters')
    out.push('----------')
    for (const p of m.params) {
      const py = snakeCase(p.name)
      const ty = p.tsType || 'Any'
      out.push(`${py} : ${ty}`)
      const body = (p.doc ?? '').trim()
      if (body) {
        for (const ln of body.split('\n')) {
          out.push(`    ${ln.replace(/^\s+/, '')}`)
        }
      }
    }
  }

  // Returns block: only for value-returning methods. Use the @returns
  // tag if present; otherwise the TS return type with no prose.
  if (m.returnsValue) {
    if (out.length > 0) out.push('')
    out.push('Returns')
    out.push('-------')
    out.push(m.returns || 'Any')
    if (m.returnsDoc) {
      for (const ln of m.returnsDoc.trim().split('\n')) {
        out.push(`    ${ln.replace(/^\s+/, '')}`)
      }
    }
  }

  // Render with the method's indentation.
  lines.push(`${indent}"""${pyStringEscape(out[0] ?? '')}`)
  for (const ln of out.slice(1)) {
    lines.push(ln ? `${indent}${pyStringEscape(ln)}` : '')
  }
  lines.push(`${indent}"""`)
}

function pyStringEscape(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * Split a JSDoc description body into a NumPy-style summary line and
 * the remaining extended body. Cuts at the earlier of (a) the first
 * sentence-ending `.` followed by whitespace, or (b) a blank line.
 * Internal newlines within the summary are collapsed to spaces.
 *
 * We restrict the sentence-end match to `.` (not `!` or `?`) because
 * the TS optional-marker `?` inside code spans (e.g. `{ R, G, B, A?, I? }`)
 * would otherwise split mid-clause. Authors who want a different split
 * boundary can add a blank line after the intended summary.
 *
 * Decimal points like `1.5` are safe because the next char is a digit,
 * not whitespace. Common abbreviations (`e.g.`) inside parens followed
 * by `,` (the niivue convention) likewise don't match `\.\s`.
 */
function splitSummaryAndBody(text: string): {
  summary: string
  extended: string
} {
  const trimmed = text.trim()
  if (!trimmed) return { summary: '', extended: '' }
  const blankIdx = trimmed.search(/\n\s*\n/)
  const sentenceMatch = /\.(?=\s|$)/.exec(trimmed)
  const sentenceEnd = sentenceMatch
    ? sentenceMatch.index + sentenceMatch[0].length
    : -1
  let cut: number
  if (blankIdx < 0 && sentenceEnd < 0) cut = trimmed.length
  else if (blankIdx < 0) cut = sentenceEnd
  else if (sentenceEnd < 0) cut = blankIdx
  else cut = Math.min(blankIdx, sentenceEnd)
  const summary = trimmed
    .slice(0, cut)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
  const extended = trimmed.slice(cut).trim()
  return { summary, extended }
}

/**
 * Decide whether a method's return type carries a value Python should
 * await for, vs. being fire-and-forget. Promise<this> covers method-
 * chaining returns like `loadVolumes(...): Promise<this>`; the JS
 * instance is not serializable, so we treat it as void.
 */
function methodReturnsValue(returns: string): boolean {
  const trimmed = returns.trim()
  if (trimmed === 'void') return false
  if (trimmed === 'Promise<void>') return false
  if (trimmed === 'this') return false
  if (trimmed === 'Promise<this>') return false
  return true
}

// ============================================================
// JS shim emitter
// ============================================================

/**
 * Emit `static/widget.js`, the anywidget ESM module that:
 *   1. Reads non-null traitlets as NiiVue constructor overrides
 *   2. Constructs NiiVue and attaches it to a freshly-created canvas
 *   3. Seeds Python with NiiVue's *actual* current values (single source
 *      of truth: NiiVue's own defaults)
 *   4. Wires bidirectional reactive sync for read-write properties
 *   5. Forwards NiiVue events to Python via `model.send`
 *   6. Dispatches Python command messages to NiiVue methods
 *   7. Cleans up listeners and calls `nv.destroy()` on widget unmount
 */
function emitJs(api: ApiDescriptor): string {
  const propsRw = api.properties
    .filter((p) => p.hasSetter)
    .map((p) => [p.jsName, p.pyName] as const)
  const propsRo = api.readonlyProperties.map(
    (p) => [p.jsName, p.pyName] as const,
  )
  const events = api.events.map((e) => e.jsName)

  const lines: string[] = []
  lines.push('// This file is auto-generated by scripts/codegen.ts.')
  lines.push('// Do not edit by hand; re-run `bunx nx codegen ipyniivue`.')
  lines.push(`// Source: ${api.source} @ niivue ${api.niivueVersion}`)
  lines.push('')
  lines.push('// niivue is resolved at bundle time by Bun.build (called from')
  lines.push(
    '// scripts/codegen.ts). The output `widget.js` is self-contained;',
  )
  lines.push('// this template file is the small, reviewable input.')
  lines.push(
    '// nx-ignore-next-line: bundled widget asset, not a Python runtime dependency',
  )
  lines.push(`import NiiVue from '@niivue/niivue'`)
  lines.push(
    `import { conform, connectedLabel, otsu, removeHaze } from '@niivue/nv-ext-image-processing'`,
  )
  lines.push(
    `import { findDrawingBoundarySlices, interpolateMaskSlices } from '@niivue/nv-ext-drawing'`,
  )
  lines.push('')
  lines.push('// Image-processing transforms bundled from @niivue/nv-ext-*.')
  lines.push(
    '// Registered with NiiVue in initialize() so Python can apply them',
  )
  lines.push('// via __ext_apply_image_transform without shipping JS.')
  lines.push('const IMAGE_PROCESSING_TRANSFORMS = [')
  lines.push('  conform,')
  lines.push('  connectedLabel,')
  lines.push('  otsu,')
  lines.push('  removeHaze,')
  lines.push(']')
  lines.push('')
  lines.push('// [jsName, pyName] for read-write reactive properties.')
  lines.push('const PROPS_RW = [')
  for (const [js, py] of propsRw) {
    lines.push(`  [${jsString(js)}, ${jsString(py)}],`)
  }
  lines.push(']')
  lines.push('')
  lines.push(
    '// [jsName, pyName] for read-only properties (JS-to-Python only).',
  )
  lines.push('const PROPS_RO = [')
  for (const [js, py] of propsRo) {
    lines.push(`  [${jsString(js)}, ${jsString(py)}],`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// Constructor-only options that NiiVue exposes as getters,')
  lines.push('// not setters. Python can still pass them before attach.')
  lines.push('const CONSTRUCTOR_PROPS = [')
  lines.push('  ...PROPS_RW,')
  lines.push('  ["backend", "backend"],')
  lines.push(']')
  lines.push('')
  lines.push('// NiiVue events that we forward to Python via model.send.')
  lines.push('// `canvasResize` and `viewAttached` fire at every layout tick')
  lines.push('// during mount (tens to hundreds of times per second on cold')
  lines.push('// load), and forwarding each one to Python via model.send')
  lines.push('// floods the WebSocket. We have observed this disconnecting')
  lines.push('// the JupyterLab comm channel and crashing the widget. Skip')
  lines.push('// them; users rarely observe these and they have no Python-')
  lines.push('// side use cases that justify the bandwidth.')
  lines.push('const SKIP_EVENT_FORWARDING = new Set([')
  for (const e of SKIP_EVENT_FORWARDING) {
    lines.push(`  "${e}",`)
  }
  lines.push('])')
  lines.push('const EVENTS = [')
  for (const e of events) {
    lines.push(`  ${jsString(e)},`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// Per-widget runtime state. anywidget passes different proxy')
  lines.push('// objects to initialize() and render(), so key by the stable')
  lines.push('// model id instead of proxy object identity.')
  lines.push('const STATE = new Map()')
  lines.push('const createState = () => {')
  lines.push('  let initializedResolve = null')
  lines.push(
    '  const initializedPromise = new Promise((r) => { initializedResolve = r })',
  )
  lines.push('  let mountedResolve = null')
  lines.push(
    '  const mountedPromise = new Promise((r) => { mountedResolve = r })',
  )
  lines.push('  return {')
  lines.push('    nv: null,')
  lines.push('    extContext: null,')
  lines.push('    initializedResolve,')
  lines.push('    initializedPromise,')
  lines.push('    mountedResolve,')
  lines.push('    mountedPromise,')
  lines.push('    commandQueue: Promise.resolve(),')
  lines.push('    lastInboxSeq: 0,')
  lines.push('    outboxSeq: 0,')
  lines.push('    hasAttached: false,')
  lines.push('    canvas: null,')
  lines.push('  }')
  lines.push('}')
  lines.push('const stateKey = (model) => {')
  lines.push('  try {')
  lines.push('    return model.get("_anywidget_id") || model')
  lines.push('  } catch {')
  lines.push('    return model')
  lines.push('  }')
  lines.push('}')
  lines.push('const getState = (model) => {')
  lines.push('  const key = stateKey(model)')
  lines.push('  let state = STATE.get(key)')
  lines.push('  if (!state) {')
  lines.push('    state = createState()')
  lines.push('    STATE.set(key, state)')
  lines.push('  }')
  lines.push('  return state')
  lines.push('}')
  lines.push('const deleteState = (model) => {')
  lines.push('  STATE.delete(stateKey(model))')
  lines.push('}')
  lines.push('')
  lines.push(
    '// Recursively coerce typed arrays (vec3/vec4 etc.) into plain arrays',
  )
  lines.push(
    '// before crossing the comm. Caps protect against NiiVue events like',
  )
  lines.push(
    '// volumeLoaded that carry the full voxel buffer in their detail;',
  )
  lines.push(
    '// serializing 50 MB across the WebSocket disconnects the kernel.',
  )
  lines.push('const TJS_TYPED_MAX = 1024')
  lines.push('const TJS_ARRAY_MAX = 4096')
  lines.push('const toJsonSafe = (v, seen) => {')
  lines.push('  if (v == null) return v')
  lines.push('  const t = typeof v')
  lines.push(
    '  if (t === "function" || t === "symbol" || t === "undefined") return null',
  )
  lines.push(
    '  if (t === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v)',
  )
  lines.push('  if (ArrayBuffer.isView(v)) {')
  lines.push('    return v.length <= TJS_TYPED_MAX ? Array.from(v) : null')
  lines.push('  }')
  lines.push('  if (t !== "object") return v')
  lines.push('  seen ??= new WeakSet()')
  lines.push('  if (seen.has(v)) return null')
  lines.push('  seen.add(v)')
  lines.push('  if (Array.isArray(v)) {')
  lines.push('    if (v.length > TJS_ARRAY_MAX) return null')
  lines.push('    return v.map((x) => toJsonSafe(x, seen))')
  lines.push('  }')
  lines.push('  const out = {}')
  lines.push(
    '  for (const k of Object.keys(v)) out[k] = toJsonSafe(v[k], seen)',
  )
  lines.push('  return out')
  lines.push('}')
  lines.push('')
  lines.push('const PY_UNDEFINED_KEY = "__ipyniivue_undefined__"')
  lines.push('const RESPONSE_BINARY_KEY = "__ipyniivue_binary__"')
  lines.push('const isPyUndefined = (v) => (')
  lines.push('  v && typeof v === "object" && v[PY_UNDEFINED_KEY] === true')
  lines.push(')')
  lines.push('const coerceCommandArgs = (args) => (')
  lines.push('  Array.isArray(args)')
  lines.push('    ? args.map((v) => (isPyUndefined(v) ? undefined : v))')
  lines.push('    : []')
  lines.push(')')
  lines.push('const bytesToBase64 = (bytes) => {')
  lines.push('  let binary = ""')
  lines.push('  const chunk = 0x8000')
  lines.push('  for (let i = 0; i < bytes.length; i += chunk) {')
  lines.push(
    '    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))',
  )
  lines.push('  }')
  lines.push('  return btoa(binary)')
  lines.push('}')
  lines.push('const toBinaryPayload = (v) => {')
  lines.push('  const bytes = ArrayBuffer.isView(v)')
  lines.push('    ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)')
  lines.push('    : new Uint8Array(v)')
  lines.push('  return {')
  lines.push('    [RESPONSE_BINARY_KEY]: true,')
  lines.push('    data: bytesToBase64(bytes),')
  lines.push('    byteLength: bytes.byteLength,')
  lines.push(
    '    dtype: v.constructor && v.constructor.name ? v.constructor.name : "ArrayBuffer",',
  )
  lines.push('  }')
  lines.push('}')
  lines.push('const toResponseSafe = (v, seen) => {')
  lines.push('  if (v == null) return v')
  lines.push('  const t = typeof v')
  lines.push(
    '  if (t === "function" || t === "symbol" || t === "undefined") return null',
  )
  lines.push(
    '  if (t === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v)',
  )
  lines.push('  if (ArrayBuffer.isView(v)) {')
  lines.push(
    '    const length = typeof v.length === "number" ? v.length : Number.POSITIVE_INFINITY',
  )
  lines.push(
    '    return length <= TJS_TYPED_MAX ? Array.from(v) : toBinaryPayload(v)',
  )
  lines.push('  }')
  lines.push('  if (v instanceof ArrayBuffer) return toBinaryPayload(v)')
  lines.push('  if (t !== "object") return v')
  lines.push('  seen ??= new WeakSet()')
  lines.push('  if (seen.has(v)) return null')
  lines.push('  seen.add(v)')
  lines.push('  if (Array.isArray(v)) {')
  lines.push('    if (v.length > TJS_ARRAY_MAX) return null')
  lines.push('    return v.map((x) => toResponseSafe(x, seen))')
  lines.push('  }')
  lines.push('  const out = {}')
  lines.push(
    '  for (const k of Object.keys(v)) out[k] = toResponseSafe(v[k], seen)',
  )
  lines.push('  return out')
  lines.push('}')
  lines.push('')
  lines.push(
    '// `initialize` runs once per Python widget instance. This is the',
  )
  lines.push(
    '// anywidget-recommended place for model-level wiring (msg:custom,',
  )
  lines.push('// change observers, NiiVue event listeners). Putting these in')
  lines.push('// `render` instead causes per-view re-registration and breaks')
  lines.push(
    "// JS-to-Python message routing. That's the bug that took us hours",
  )
  lines.push('// to find. See https://anywidget.dev/blog/anywidget-lifecycle/.')
  lines.push('async function initialize({ model }) {')
  lines.push('  const state = getState(model)')
  lines.push('')
  lines.push('  // Outbox writer. JS-to-Python messages route via a synthetic')
  lines.push('  // `_msg_outbox` trait. State-update is more reliable than')
  lines.push('  // `model.send()` in our anywidget setup.')
  lines.push('  const sendToPython = (body) => {')
  lines.push('    try {')
  lines.push('      model.set("_msg_outbox", { seq: ++state.outboxSeq, body })')
  lines.push('      model.save_changes()')
  lines.push('    } catch (err) {')
  lines.push('      console.warn("ipyniivue: outbox write failed:", err)')
  lines.push('    }')
  lines.push('  }')
  lines.push('')
  lines.push('  const sameJsonValue = (a, b) => {')
  lines.push('    try { return JSON.stringify(a) === JSON.stringify(b) }')
  lines.push('    catch { return a === b }')
  lines.push('  }')
  lines.push('  const syncReadOnlyProperties = () => {')
  lines.push('    const nv = state.nv')
  lines.push('    if (!nv) return')
  lines.push('    let changed = false')
  lines.push('    for (const [jsName, pyName] of PROPS_RO) {')
  lines.push('      try {')
  lines.push('        const v = nv[jsName]')
  lines.push('        if (v === undefined) continue')
  lines.push('        const safe = toJsonSafe(v)')
  lines.push('        if (!sameJsonValue(model.get(pyName), safe)) {')
  lines.push('          model.set(pyName, safe)')
  lines.push('          changed = true')
  lines.push('        }')
  lines.push('      } catch (err) {')
  lines.push(
    '        console.warn("ipyniivue: failed to sync " + pyName + ":", err)',
  )
  lines.push('      }')
  lines.push('    }')
  lines.push('    if (changed) {')
  lines.push('      try { model.save_changes() } catch (err) {')
  lines.push(
    '        console.warn("ipyniivue: read-only sync save failed:", err)',
  )
  lines.push('      }')
  lines.push('    }')
  lines.push('  }')
  lines.push('')
  lines.push('  // Command handler: Python-to-JS commands. Awaits mount before')
  lines.push(
    '  // touching `state.nv`; `__ready__` is the synthetic command behind',
  )
  lines.push('  // `nv.wait_ready()`. The `buffers` argument carries binary')
  lines.push('  // payloads (raw NIfTI/mesh bytes from add_volume_from_bytes /')
  lines.push(
    '  // add_mesh_from_bytes), supplied by `decodeInboxBuffer` when the',
  )
  lines.push('  // inbox body has a base64 `_b64` field.')
  lines.push('  const runCommand = async (msg, buffers) => {')
  lines.push('    if (!msg || typeof msg !== "object") return')
  lines.push('    if (typeof msg.cmd !== "string") return')
  lines.push('    const reqId = msg.req_id ?? null')
  lines.push('    const respond = (ok, payload) => {')
  lines.push('      if (reqId === null) return')
  lines.push('      const body = { kind: "response", req_id: reqId, ok }')
  lines.push('      if (ok) body.result = payload')
  lines.push('      else body.error = String(payload)')
  lines.push('      sendToPython(body)')
  lines.push('    }')
  lines.push('    await state.mountedPromise')
  lines.push('    if (msg.cmd === "__ready__") {')
  lines.push('      if (reqId !== null) respond(true, true)')
  lines.push('      return')
  lines.push('    }')
  lines.push('    // Composite extension command: apply a bundled transform to')
  lines.push(
    '    // the volume at args[1], optionally replacing the background.',
  )
  lines.push('    // Returns { name, elapsed_ms } so Python can show progress.')
  lines.push('    if (msg.cmd === "__ext_apply_image_transform") {')
  lines.push('      const args = coerceCommandArgs(msg.args)')
  lines.push('      const name = args[0]')
  lines.push('      const volIdx = args[1] ?? 0')
  lines.push('      const options = args[2] || {}')
  lines.push('      const replaceBg = !!args[3]')
  lines.push('      try {')
  lines.push(
    '        const ctx = state.extContext ?? (state.extContext = state.nv.createExtensionContext())',
  )
  lines.push('        const vol = ctx.volumes[volIdx]')
  lines.push('        if (!vol) {')
  lines.push(
    '          if (reqId !== null) respond(false, "no volume at index " + volIdx)',
  )
  lines.push('          return')
  lines.push('        }')
  lines.push('        const t0 = performance.now()')
  lines.push(
    '        const result = await ctx.applyVolumeTransform(name, vol, options)',
  )
  lines.push('        const info = state.nv.getVolumeTransformInfo(name)')
  lines.push('        if (info && info.resultDefaults) {')
  lines.push(
    '          if (info.resultDefaults.colormap) result.colormap = info.resultDefaults.colormap',
  )
  lines.push(
    '          if (info.resultDefaults.opacity != null) result.opacity = info.resultDefaults.opacity',
  )
  lines.push('        }')
  lines.push('        if (replaceBg) await ctx.removeAllVolumes()')
  lines.push('        await ctx.addVolume(result)')
  lines.push('        const elapsedMs = performance.now() - t0')
  lines.push(
    '        if (reqId !== null) respond(true, { name: name, elapsed_ms: elapsedMs })',
  )
  lines.push('      } catch (err) {')
  lines.push('        if (reqId !== null) respond(false, err)')
  lines.push(
    '        else console.error("ipyniivue: __ext_apply_image_transform threw:", err)',
  )
  lines.push('      }')
  lines.push('      return')
  lines.push('    }')
  lines.push(
    '    // Drawing extension: find first/last slices containing drawing data',
  )
  lines.push(
    '    // along an axis. Returns { first, last } or null. Reads the live',
  )
  lines.push(
    '    // bitmap from ctx.drawing; returns null if no drawing volume exists.',
  )
  lines.push('    if (msg.cmd === "__ext_drawing_find_boundaries") {')
  lines.push('      const args = coerceCommandArgs(msg.args)')
  lines.push('      const axis = args[0] ?? 0')
  lines.push('      try {')
  lines.push(
    '        const ctx = state.extContext ?? (state.extContext = state.nv.createExtensionContext())',
  )
  lines.push('        const dr = ctx.drawing')
  lines.push('        if (!dr) {')
  lines.push('          if (reqId !== null) respond(true, null)')
  lines.push('          return')
  lines.push('        }')
  lines.push('        const t0 = performance.now()')
  lines.push(
    '        const result = await findDrawingBoundarySlices(axis, dr.bitmap, dr.dims)',
  )
  lines.push('        const elapsedMs = performance.now() - t0')
  lines.push('        if (reqId !== null) {')
  lines.push(
    '          respond(true, result ? { first: result.first, last: result.last, elapsed_ms: elapsedMs } : null)',
  )
  lines.push('        }')
  lines.push('      } catch (err) {')
  lines.push('        if (reqId !== null) respond(false, err)')
  lines.push(
    '        else console.error("ipyniivue: __ext_drawing_find_boundaries threw:", err)',
  )
  lines.push('      }')
  lines.push('      return')
  lines.push('    }')
  // Binary buffer ingress: Python ships raw file bytes (NIfTI, MGZ,
  // mesh format, etc.) inlined as base64 in the inbox body, decoded by
  // `decodeInboxBuffer` into `buffers[0]` here. The JS handler wraps the
  // buffer into a File and hands it to NiiVue's standard URL/File loader
  // path, which dispatches by filename extension.
  lines.push(
    "    // Buffer ingress: wrap bytes into a File and dispatch via NiiVue's",
  )
  lines.push(
    '    // URL/File loader so the existing extension-based reader path runs.',
  )
  lines.push('    if (msg.cmd === "__add_volume_from_bytes") {')
  lines.push('      const args = coerceCommandArgs(msg.args)')
  lines.push('      const name = args[0] || "volume.nii"')
  lines.push('      const options = args[1] || {}')
  lines.push('      try {')
  lines.push('        if (!buffers || !buffers[0]) {')
  lines.push(
    '          const errMsg = "no buffer attached to add_volume_from_bytes"',
  )
  lines.push('          console.error("[ipyniivue]", errMsg)')
  lines.push(
    '          sendToPython({ kind: "error", source: msg.cmd, message: errMsg })',
  )
  lines.push('          if (reqId !== null) respond(false, errMsg)')
  lines.push('          return')
  lines.push('        }')
  lines.push('        // buffers[0] is a Uint8Array from decodeInboxBuffer.')
  lines.push(
    '        // Pass the underlying ArrayBuffer slice to File for browser',
  )
  lines.push(
    '        // compatibility (some Blob constructors are picky about views).',
  )
  lines.push('        const dv = buffers[0]')
  lines.push(
    '        const ab = dv.buffer ? dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength) : dv',
  )
  lines.push('        const file = new File([ab], name)')
  lines.push(
    '        await state.nv.loadVolumes([Object.assign({}, options, { url: file, name: name })])',
  )
  lines.push('        if (reqId !== null) respond(true, null)')
  lines.push('      } catch (err) {')
  lines.push(
    '        console.error("[ipyniivue] __add_volume_from_bytes threw:", err)',
  )
  lines.push(
    '        sendToPython({ kind: "error", source: msg.cmd, message: String(err) })',
  )
  lines.push('        if (reqId !== null) respond(false, err)')
  lines.push('      }')
  lines.push('      return')
  lines.push('    }')
  lines.push('    if (msg.cmd === "__add_mesh_from_bytes") {')
  lines.push('      const args = coerceCommandArgs(msg.args)')
  lines.push('      const name = args[0] || "mesh.mz3"')
  lines.push('      const options = args[1] || {}')
  lines.push('      try {')
  lines.push('        if (!buffers || !buffers[0]) {')
  lines.push(
    '          const errMsg = "no buffer attached to add_mesh_from_bytes"',
  )
  lines.push('          console.error("[ipyniivue]", errMsg)')
  lines.push(
    '          sendToPython({ kind: "error", source: msg.cmd, message: errMsg })',
  )
  lines.push('          if (reqId !== null) respond(false, errMsg)')
  lines.push('          return')
  lines.push('        }')
  lines.push('        const dv = buffers[0]')
  lines.push(
    '        const ab = dv.buffer ? dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength) : dv',
  )
  lines.push('        const file = new File([ab], name)')
  lines.push(
    '        await state.nv.loadMeshes([Object.assign({}, options, { url: file, name: name })])',
  )
  lines.push('        if (reqId !== null) respond(true, null)')
  lines.push('      } catch (err) {')
  lines.push(
    '        console.error("[ipyniivue] __add_mesh_from_bytes threw:", err)',
  )
  lines.push(
    '        sendToPython({ kind: "error", source: msg.cmd, message: String(err) })',
  )
  lines.push('        if (reqId !== null) respond(false, err)')
  lines.push('      }')
  lines.push('      return')
  lines.push('    }')
  lines.push(
    '    // Drawing extension: interpolate between drawn slices to fill gaps.',
  )
  lines.push(
    '    // Pulls the live bitmap, runs the worker, writes the result back via',
  )
  lines.push(
    '    // ctx.drawing.update. Returns { before, after, elapsed_ms } voxel counts.',
  )
  lines.push('    if (msg.cmd === "__ext_drawing_interpolate_slices") {')
  lines.push('      const args = coerceCommandArgs(msg.args)')
  lines.push('      const axis = args[0] ?? 0')
  lines.push('      const useIntensity = !!args[1]')
  lines.push('      const userOptions = args[2] || {}')
  lines.push('      try {')
  lines.push(
    '        const ctx = state.extContext ?? (state.extContext = state.nv.createExtensionContext())',
  )
  lines.push('        const dr = ctx.drawing')
  lines.push('        if (!dr) {')
  lines.push(
    '          if (reqId !== null) respond(false, "no drawing volume; call create_empty_drawing() first")',
  )
  lines.push('          return')
  lines.push('        }')
  lines.push('        const bg = ctx.backgroundVolume')
  lines.push('        const imageData = useIntensity && bg ? bg.imgRAS : null')
  lines.push(
    '        const maxVal = useIntensity && bg ? (bg.globalMax || 1) : 1',
  )
  lines.push(
    '        const options = Object.assign({ sliceType: axis, useIntensityGuided: useIntensity }, userOptions)',
  )
  lines.push(
    '        const before = dr.bitmap.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)',
  )
  lines.push('        const t0 = performance.now()')
  lines.push('        const newBitmap = await interpolateMaskSlices(')
  lines.push(
    '          dr.bitmap, dr.dims, imageData, maxVal, undefined, undefined, options,',
  )
  lines.push('        )')
  lines.push('        const elapsedMs = performance.now() - t0')
  lines.push(
    '        const after = newBitmap.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)',
  )
  lines.push('        dr.update(newBitmap)')
  lines.push(
    '        if (reqId !== null) respond(true, { before: before, after: after, elapsed_ms: elapsedMs })',
  )
  lines.push('      } catch (err) {')
  lines.push('        if (reqId !== null) respond(false, err)')
  lines.push(
    '        else console.error("ipyniivue: __ext_drawing_interpolate_slices threw:", err)',
  )
  lines.push('      }')
  lines.push('      return')
  lines.push('    }')
  lines.push('    const nv = state.nv')
  lines.push('    if (!nv) {')
  lines.push('      respond(false, "NiiVue instance is not initialized")')
  lines.push('      return')
  lines.push('    }')
  lines.push('    const fn = nv[msg.cmd]')
  lines.push('    if (typeof fn !== "function") {')
  lines.push('      const errMsg = "unknown command: " + msg.cmd')
  lines.push('      if (reqId !== null) respond(false, errMsg)')
  lines.push('      else console.warn("ipyniivue: " + errMsg)')
  lines.push('      return')
  lines.push('    }')
  lines.push('    try {')
  lines.push('      const args = coerceCommandArgs(msg.args)')
  lines.push('      let result = fn.apply(nv, args)')
  lines.push('      if (result && typeof result.then === "function") {')
  lines.push('        result = await result')
  lines.push('      }')
  lines.push('      syncReadOnlyProperties()')
  lines.push('      if (reqId !== null) {')
  lines.push('        let safe = null')
  lines.push('        try { safe = toResponseSafe(result ?? null) } catch {}')
  lines.push('        respond(true, safe)')
  lines.push('      }')
  lines.push('    } catch (err) {')
  lines.push('      if (reqId !== null) respond(false, err)')
  lines.push(
    '      else console.error("ipyniivue: command " + msg.cmd + " threw:", err)',
  )
  lines.push('    }')
  lines.push('  }')
  lines.push('  const cmdHandler = (msg, buffers) => {')
  lines.push('    state.commandQueue = state.commandQueue')
  lines.push('      .then(() => runCommand(msg, buffers))')
  lines.push('      .catch((err) => {')
  lines.push("        console.error('ipyniivue: command queue error:', err)")
  lines.push('      })')
  lines.push('  }')
  lines.push('  // Decode an inline base64 buffer attached to a command body.')
  lines.push(
    '  // Buffer-carrying commands (add_volume_from_bytes, etc.) inline',
  )
  lines.push(
    '  // their payload as `_b64` so they can ride the synced _msg_inbox',
  )
  lines.push('  // channel like every other command, instead of raw model.send')
  lines.push('  // with the buffers= argument. Raw send is unreliable in our')
  lines.push('  // anywidget setup and required a wait_ready() ping-pong that')
  lines.push('  // could time out before the response made it back to Python.')
  lines.push('  const decodeInboxBuffer = (body) => {')
  lines.push('    if (!body || typeof body._b64 !== "string") return undefined')
  lines.push('    try {')
  lines.push('      const bin = atob(body._b64)')
  lines.push('      const out = new Uint8Array(bin.length)')
  lines.push(
    '      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)',
  )
  lines.push('      return [out]')
  lines.push('    } catch (err) {')
  lines.push(
    '      // Malformed base64 must not abandon the rest of the inbox batch.',
  )
  lines.push(
    '      // Surface to Python and let the downstream handler see no buffer.',
  )
  lines.push('      const msg = "malformed _b64 buffer: " + String(err)')
  lines.push('      console.error("ipyniivue:", msg)')
  lines.push(
    '      sendToPython({ kind: "error", source: body && body.cmd, message: msg })',
  )
  lines.push('      return undefined')
  lines.push('    }')
  lines.push('  }')
  lines.push('  const inboxHandler = () => {')
  lines.push('    const inbox = model.get("_msg_inbox")')
  lines.push('    if (!Array.isArray(inbox)) return')
  lines.push('    let highest = state.lastInboxSeq')
  lines.push('    for (const item of inbox) {')
  lines.push(
    '      const seq = item && typeof item.seq === "number" ? item.seq : null',
  )
  lines.push('      if (seq === null || seq <= state.lastInboxSeq) continue')
  lines.push('      state.lastInboxSeq = seq')
  lines.push('      cmdHandler(item.body, decodeInboxBuffer(item.body))')
  lines.push('      if (seq > highest) highest = seq')
  lines.push('    }')
  lines.push(
    '    // Ack drained items so Python can prune base64 payloads from',
  )
  lines.push(
    '    // _msg_inbox state. The ack reflects items received and queued',
  )
  lines.push(
    '    // for execution, not necessarily completed; that is fine because',
  )
  lines.push('    // the inbox is only there to bridge the cold-start race.')
  lines.push('    const prevAck = model.get("_msg_inbox_ack") || 0')
  lines.push('    if (highest > prevAck) {')
  lines.push('      model.set("_msg_inbox_ack", highest)')
  lines.push('      try { model.save_changes() } catch (err) {')
  lines.push('        console.warn("ipyniivue: inbox ack save failed:", err)')
  lines.push('      }')
  lines.push('    }')
  lines.push('  }')
  lines.push('  model.on("change:_msg_inbox", inboxHandler)')
  lines.push('  inboxHandler()')
  lines.push('')
  lines.push("  // Build NiiVue with constructor opts from user's overrides.")
  lines.push('  const opts = {}')
  lines.push('  for (const [jsName, pyName] of CONSTRUCTOR_PROPS) {')
  lines.push('    const v = model.get(pyName)')
  lines.push('    if (v !== null && v !== undefined) opts[jsName] = v')
  lines.push('  }')
  lines.push('  const thumbnailUrl = model.get("thumbnail_url")')
  lines.push('  if (thumbnailUrl !== null && thumbnailUrl !== undefined) {')
  lines.push('    opts.thumbnail = thumbnailUrl')
  lines.push('  }')
  lines.push('  state.nv = new NiiVue(opts)')
  lines.push('  // Register bundled image-processing transforms before any')
  lines.push('  // user command can land. Idempotent on re-register.')
  lines.push('  for (const transform of IMAGE_PROCESSING_TRANSFORMS) {')
  lines.push('    try { state.nv.registerVolumeTransform(transform) }')
  lines.push('    catch (err) {')
  lines.push(
    '      console.warn("ipyniivue: failed to register " + transform.name + ":", err)',
  )
  lines.push('    }')
  lines.push('  }')
  lines.push('  if (state.initializedResolve) {')
  lines.push('    state.initializedResolve()')
  lines.push('    state.initializedResolve = null')
  lines.push('  }')
  lines.push('')
  lines.push(
    '  // Property change observers: Python-to-JS. Each handler awaits',
  )
  lines.push('  // mount so changes set during cold start are applied as soon')
  lines.push('  // as `nv` is attached.')
  lines.push('  const observers = []')
  lines.push('  for (const [jsName, pyName] of PROPS_RW) {')
  lines.push('    const handler = async () => {')
  lines.push('      await state.mountedPromise')
  lines.push('      const v = model.get(pyName)')
  lines.push('      try {')
  lines.push('        const nv = state.nv')
  lines.push('        if (nv && nv[jsName] !== v) nv[jsName] = v')
  lines.push('      } catch (err) {')
  lines.push(
    '        console.warn("ipyniivue: failed to set " + jsName + ":", err)',
  )
  lines.push('      }')
  lines.push('    }')
  lines.push('    model.on("change:" + pyName, handler)')
  lines.push('    observers.push([pyName, handler])')
  lines.push('  }')
  lines.push('')
  lines.push('  // NiiVue event listeners: JS-to-Python.')
  lines.push('  const evtListeners = []')
  lines.push('  for (const eventName of EVENTS) {')
  lines.push('    if (SKIP_EVENT_FORWARDING.has(eventName)) continue')
  lines.push('    const handler = (e) => {')
  lines.push('      let detail = null')
  lines.push('      try { detail = toJsonSafe(e && e.detail) } catch {}')
  lines.push('      sendToPython({ kind: "event", name: eventName, detail })')
  lines.push('    }')
  lines.push('    state.nv.addEventListener(eventName, handler)')
  lines.push('    evtListeners.push([eventName, handler])')
  lines.push('  }')
  lines.push('')
  lines.push('  // Cleanup on widget disposal.')
  lines.push('  return () => {')
  lines.push('    model.off("change:_msg_inbox", inboxHandler)')
  lines.push('    for (const [pyName, handler] of observers) {')
  lines.push('      model.off("change:" + pyName, handler)')
  lines.push('    }')
  lines.push('    const nv = state.nv')
  lines.push(
    '    if (state.extContext && typeof state.extContext.dispose === "function") {',
  )
  lines.push('      try { state.extContext.dispose() } catch {}')
  lines.push('    }')
  lines.push('    state.extContext = null')
  lines.push('    if (nv) {')
  lines.push('      for (const [eventName, handler] of evtListeners) {')
  lines.push('        nv.removeEventListener(eventName, handler)')
  lines.push('      }')
  lines.push('      if (typeof nv.destroy === "function") nv.destroy()')
  lines.push('    }')
  lines.push('    state.nv = null')
  lines.push('    deleteState(model)')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  lines.push(
    '// `render` runs per view (potentially multiple times for one model)',
  )
  lines.push(
    '// and only handles DOM work: create a canvas, attach `nv` to it,',
  )
  lines.push('// seed Python with NiiVue defaults on first attach.')
  lines.push('async function render({ model, el }) {')
  lines.push('  const state = getState(model)')
  lines.push('  await state.initializedPromise')
  lines.push('  const nv = state?.nv')
  lines.push('  if (!state || !nv) {')
  lines.push(
    "    console.error('ipyniivue: render called without an initialized NiiVue')",
  )
  lines.push('    return')
  lines.push('  }')
  lines.push(
    '  // Reuse the existing canvas across views. NiiVue is bound to one',
  )
  lines.push(
    '  // canvas, so when the same widget is displayed in a second cell',
  )
  lines.push(
    '  // we move that canvas into the new container instead of creating',
  )
  lines.push('  // a fresh blank one. (anywidget calls render() per view.)')
  lines.push('  let canvas = state.canvas')
  lines.push('  if (!canvas) {')
  lines.push('    canvas = document.createElement("canvas")')
  lines.push(
    '    canvas.style.cssText = "width:100%;height:600px;display:block"',
  )
  lines.push('    canvas.width = 640')
  lines.push('    canvas.height = 480')
  lines.push("    // Suppress JupyterLab's cell context menu on right-click.")
  lines.push('    // NiiVue uses right-click for secondary drag (clip plane,')
  lines.push('    // contrast, etc.); without stopPropagation the contextmenu')
  lines.push(
    "    // event bubbles to JupyterLab's document handler, which pops",
  )
  lines.push(
    '    // up Cut Cell / Copy Cell / etc. Holding Shift bypasses both',
  )
  lines.push("    // (matches NiiVue's existing escape hatch).")
  lines.push('    canvas.addEventListener("contextmenu", (e) => {')
  lines.push('      if (e.shiftKey) return')
  lines.push('      e.preventDefault()')
  lines.push('      e.stopPropagation()')
  lines.push('    })')
  lines.push('    state.canvas = canvas')
  lines.push('  }')
  lines.push('  el.appendChild(canvas)')
  lines.push('  // One animation frame for layout to measure the parent.')
  lines.push('  await new Promise((r) => requestAnimationFrame(() => r()))')
  lines.push('')
  lines.push(
    '  // Only the first render performs the attach + seed. Subsequent',
  )
  lines.push('  // views reuse the canvas we created above.')
  lines.push('  if (!state.hasAttached) {')
  lines.push('    await nv.attachToCanvas(canvas)')
  lines.push('    state.hasAttached = true')
  lines.push("    // Seed Python with NiiVue's actual current values.")
  lines.push('    for (const [jsName, pyName] of [...PROPS_RW, ...PROPS_RO]) {')
  lines.push('      try {')
  lines.push('        const v = nv[jsName]')
  lines.push('        if (v !== undefined) model.set(pyName, toJsonSafe(v))')
  lines.push('      } catch (err) {')
  lines.push(
    '        console.warn("ipyniivue: failed to seed " + pyName + ":", err)',
  )
  lines.push('      }')
  lines.push('    }')
  lines.push('    if (state.mountedResolve) {')
  lines.push('      state.mountedResolve()')
  lines.push('      state.mountedResolve = null')
  lines.push('    }')
  lines.push('    try {')
  lines.push('      model.save_changes()')
  lines.push('    } catch (err) {')
  lines.push(
    "      console.warn('ipyniivue: failed to sync initial state:', err)",
  )
  lines.push('    }')
  lines.push('  }')
  lines.push('  return () => {')
  lines.push(
    '    // Per-view cleanup: nothing; canvas is detached by JupyterLab,',
  )
  lines.push('    // and `nv` is destroyed by the initialize-cleanup callback.')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  lines.push('export default { initialize, render }')
  lines.push('')
  return lines.join('\n')
}

function jsString(s: string): string {
  return JSON.stringify(s)
}
