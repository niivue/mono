/**
 * Phase 2.1 — Emit api.generated.json from NVControlBase TypeScript source.
 *
 * Walks `packages/niivue/src/NVControlBase.ts`, classifies every public
 * member, and produces a structured JSON descriptor that downstream
 * emitters (Python wrapper, JS shim) consume. Anything we can't translate
 * cleanly lands in the `skipped` section with a reason — those become
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

  // Unwrap `T | undefined` / `T | null` — the optional wrapper is common
  // for "value or unset" and we can preserve nullability in traitlets via
  // .tag(allow_none=True) in the Python emitter (Phase 2.2). For now, take
  // the non-nullable side.
  if (t.isUnion()) {
    const nonNullish = t
      .getUnionTypes()
      .filter((u) => !u.isUndefined() && !u.isNull())
    if (nonNullish.length === 0) {
      return { ok: false, reason: 'union of only null/undefined', tsText }
    }
    if (nonNullish.length === 1) {
      return classifyType(nonNullish[0]!)
    }
    // Boolean-literal union (`true | false`, ts widens this from `boolean`)
    if (nonNullish.every((u) => u.isBooleanLiteral())) {
      return { ok: true, traitlet: { kind: 'Bool' }, tsText }
    }
    // String-literal union → Enum
    if (nonNullish.every((u) => u.isStringLiteral())) {
      const values = nonNullish.map((u) => u.getLiteralValueOrThrow() as string)
      return { ok: true, traitlet: { kind: 'Enum', values }, tsText }
    }
    // Number-literal union → Enum
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

  // Tuple → fixed-length List
  if (t.isTuple()) {
    const elems = t.getTupleElements()
    if (elems.length === 0) {
      return {
        ok: false,
        reason: 'empty tuple',
        tsText,
      }
    }
    const elemResult = classifyType(elems[0]!)
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

  // Array → variable-length List
  if (t.isArray()) {
    const elem = t.getArrayElementType()
    if (!elem) return { ok: false, reason: 'array with no element type', tsText }
    const elemResult = classifyType(elem)
    if (!elemResult.ok) return elemResult
    return {
      ok: true,
      traitlet: { kind: 'List', elem: elemResult.traitlet, length: null },
      tsText,
    }
  }

  // Typed arrays — JSON-serializable as plain number arrays.
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
}

type MethodDescriptor = {
  jsName: string
  pyName: string
  isAsync: boolean
  params: ParamDescriptor[]
  returns: string
  doc: string | null
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
  generatedAt: string
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
      methods.push(m)
      break
    }
  }
}

const properties: PropertyDescriptor[] = []
const readonlyProperties: PropertyDescriptor[] = []
const skippedProperties: SkippedItem[] = []
const skippedMethods: SkippedItem[] = []

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
    const params: ParamDescriptor[] = m.getParameters().map((p) => ({
      name: p.getName(),
      tsType: shortenType(p.getType().getText()),
      optional: p.isOptional() || p.hasInitializer(),
    }))
    methodDescriptors.push({
      jsName: m.getName(),
      pyName: snakeCase(m.getName()),
      isAsync: m.isAsync(),
      params,
      returns: shortenType(m.getReturnType().getText()),
      doc: extractDoc(m),
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
const niivuePkg = await Bun.file(
  path.join(niivueRoot, 'package.json'),
).json()

const descriptor: ApiDescriptor = {
  niivueVersion: niivuePkg.version,
  source: path.relative(repoRoot, controlBase.getFilePath()),
  generatedAt: new Date().toISOString(),
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

// Write JS shim (static/widget.js)
const jsPath = path.join(
  __dirname,
  '..',
  'src',
  'ipyniivue',
  'static',
  'widget.js',
)
await Bun.write(jsPath, emitJs(descriptor))

// Summary to stdout
console.log(`# Codegen summary — ${className} @ niivue ${niivuePkg.version}`)
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
  return s
    // letter, digits, uppercase → split before digits  (in3D → in_3D)
    .replace(/([a-z])(\d+)(?=[A-Z])/g, '$1_$2')
    // digit, uppercase, lowercase → split before uppercase  (1Sl → 1_Sl)
    .replace(/(\d)([A-Z])(?=[a-z])/g, '$1_$2')
    // uppercase run followed by uppercase+lowercase → split  (ABCdef → AB_Cdef)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // standard camel boundary  (aB → a_B)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
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

// ============================================================
// Python emitter (Phase 2.2)
// ============================================================

function emitPython(api: ApiDescriptor): string {
  const lines: string[] = []
  lines.push('# This file is auto-generated by scripts/codegen.ts.')
  lines.push('# Do not edit by hand — re-run `bunx nx codegen ipyniivue`.')
  lines.push(`# Source: ${api.source} @ niivue ${api.niivueVersion}`)
  lines.push(`# Generated at: ${api.generatedAt}`)
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
  lines.push('# Set of event names that JS may dispatch to Python. The')
  lines.push('# hand-written `widget.NiiVue.on()` method validates against this.')
  lines.push('NIIVUE_EVENT_NAMES: frozenset[str] = frozenset({')
  for (const e of api.events) {
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
  lines.push('    channel; for now they are fire-and-forget. A future phase')
  lines.push('    will introduce request/response semantics for methods that')
  lines.push('    return data.')
  lines.push('    """')
  lines.push('')
  lines.push('    # ─── Reactive properties (read+write, synced) ───────────────')

  for (const p of api.properties) {
    emitTrait(lines, p, /* readOnly */ false)
  }

  lines.push('')
  lines.push('    # ─── Read-only properties (synced from JS to Python) ────────')
  for (const p of api.readonlyProperties) {
    emitTrait(lines, p, /* readOnly */ true)
  }

  lines.push('')
  lines.push('    # ─── Command methods (fire-and-forget) ──────────────────────')
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
  // values from NiiVue on attach (Phase 2.3), so Python "doesn't know"
  // until then. This avoids placeholder defaults that may violate trait
  // constraints (e.g. an empty list failing minlen=4) and matches the
  // 1b strategy: NiiVue is the single source of truth for defaults.
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
      const args = [
        `trait=${elem}`,
        'default_value=None',
      ]
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
    .map((p) => `${snakeCase(p.name)}${p.optional ? ': Any = None' : ': Any'}`)
    .join(', ')
  const argsList = params.map((p) => snakeCase(p.name)).join(', ')
  const argsTuple = params.length === 0 ? '[]' : `[${argsList}]`
  lines.push(
    `    def ${m.pyName}(self${sig ? `, ${sig}` : ''}) -> None:`,
  )
  if (m.doc) {
    const docLines = m.doc.split('\n')
    lines.push(`        """${pyStringEscape(docLines[0]!)}`)
    for (const dl of docLines.slice(1)) {
      lines.push(`        ${pyStringEscape(dl)}`)
    }
    lines.push(`        """`)
  }
  lines.push(`        self.send({"cmd": "${m.jsName}", "args": ${argsTuple}})`)
  lines.push('')
}

function pyStringEscape(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

// ============================================================
// JS shim emitter (Phase 2.3)
// ============================================================

/**
 * Emit `static/widget.js` — the anywidget ESM module that:
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
  lines.push('// Do not edit by hand — re-run `bunx nx codegen ipyniivue`.')
  lines.push(`// Source: ${api.source} @ niivue ${api.niivueVersion}`)
  lines.push(`// Generated at: ${api.generatedAt}`)
  lines.push('')
  lines.push('// niivue is bundled into ./niivue.js by the Nx `bundle` target,')
  lines.push('// which depends on `niivue:build`. The bundle is checked in so a')
  lines.push('// fresh `pip install` does not require the JS toolchain.')
  lines.push(`import NiiVue from './niivue.js'`)
  lines.push('')
  lines.push('// [jsName, pyName] for read-write reactive properties.')
  lines.push('const PROPS_RW = [')
  for (const [js, py] of propsRw) {
    lines.push(`  [${jsString(js)}, ${jsString(py)}],`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// [jsName, pyName] for read-only properties (JS → Python only).')
  lines.push('const PROPS_RO = [')
  for (const [js, py] of propsRo) {
    lines.push(`  [${jsString(js)}, ${jsString(py)}],`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// NiiVue events that we forward to Python via model.send.')
  lines.push('const EVENTS = [')
  for (const e of events) {
    lines.push(`  ${jsString(e)},`)
  }
  lines.push(']')
  lines.push('')
  lines.push(`async function render({ model, el }) {`)
  lines.push('  const canvas = document.createElement("canvas")')
  lines.push('  canvas.style.cssText = "width:100%;height:600px;display:block"')
  lines.push('  el.appendChild(canvas)')
  lines.push('')
  lines.push('  // 1. Build constructor opts from non-null traitlets — these')
  lines.push('  //    are the user\'s explicit overrides via NiiVue(...) kwargs.')
  lines.push('  const opts = {}')
  lines.push('  for (const [jsName, pyName] of PROPS_RW) {')
  lines.push('    const v = model.get(pyName)')
  lines.push('    if (v !== null && v !== undefined) opts[jsName] = v')
  lines.push('  }')
  lines.push('')
  lines.push('  // 2. Construct NiiVue and attach.')
  lines.push('  const nv = new NiiVue(opts)')
  lines.push('  await nv.attachToCanvas(canvas)')
  lines.push('')
  lines.push('  // 3. Seed Python with NiiVue\'s actual current values. This')
  lines.push('  //    overwrites placeholder traitlet defaults (None / 0 / "")')
  lines.push('  //    with NiiVue\'s real defaults.')
  lines.push('  for (const [jsName, pyName] of [...PROPS_RW, ...PROPS_RO]) {')
  lines.push('    try {')
  lines.push('      const v = nv[jsName]')
  lines.push('      if (v !== undefined) model.set(pyName, v)')
  lines.push('    } catch (err) {')
  lines.push('      console.warn(`ipyniivue: failed to seed ${pyName}:`, err)')
  lines.push('    }')
  lines.push('  }')
  lines.push('  model.save_changes()')
  lines.push('')
  lines.push('  // 4. Bidirectional sync — Python → JS for read-write props.')
  lines.push('  //    A guard prevents the JS-side write from echoing back to')
  lines.push('  //    Python and triggering an infinite loop.')
  lines.push('  const observers = []')
  lines.push('  for (const [jsName, pyName] of PROPS_RW) {')
  lines.push('    const handler = () => {')
  lines.push('      const v = model.get(pyName)')
  lines.push('      try {')
  lines.push('        if (nv[jsName] !== v) nv[jsName] = v')
  lines.push('      } catch (err) {')
  lines.push('        console.warn(`ipyniivue: failed to set ${jsName}:`, err)')
  lines.push('      }')
  lines.push('    }')
  lines.push('    model.on(`change:${pyName}`, handler)')
  lines.push('    observers.push([pyName, handler])')
  lines.push('  }')
  lines.push('')
  lines.push('  // 5. Forward NiiVue events to Python. Detail is round-tripped')
  lines.push('  //    through JSON to drop functions / DOM refs / circular refs.')
  lines.push('  const evtListeners = []')
  lines.push('  for (const eventName of EVENTS) {')
  lines.push('    const handler = (e) => {')
  lines.push('      let detail = e && e.detail')
  lines.push('      try { detail = JSON.parse(JSON.stringify(detail)) }')
  lines.push('      catch { detail = null }')
  lines.push('      model.send({ kind: "event", name: eventName, detail })')
  lines.push('    }')
  lines.push('    nv.addEventListener(eventName, handler)')
  lines.push('    evtListeners.push([eventName, handler])')
  lines.push('  }')
  lines.push('')
  lines.push('  // 6. Dispatch Python commands to NiiVue methods. Async results')
  lines.push('  //    are fire-and-forget for now; a future phase will add')
  lines.push('  //    request/response correlation for methods that return data.')
  lines.push('  const cmdHandler = (msg) => {')
  lines.push('    if (!msg || typeof msg !== "object") return')
  lines.push('    if (typeof msg.cmd !== "string") return')
  lines.push('    const fn = nv[msg.cmd]')
  lines.push('    if (typeof fn !== "function") {')
  lines.push('      console.warn(`ipyniivue: unknown command ${msg.cmd}`)')
  lines.push('      return')
  lines.push('    }')
  lines.push('    try {')
  lines.push('      const result = fn.apply(nv, msg.args || [])')
  lines.push('      if (result && typeof result.then === "function") {')
  lines.push('        result.catch((err) => {')
  lines.push(
    '          console.error(`ipyniivue: command ${msg.cmd} rejected:`, err)',
  )
  lines.push('        })')
  lines.push('      }')
  lines.push('    } catch (err) {')
  lines.push(
    '      console.error(`ipyniivue: command ${msg.cmd} threw:`, err)',
  )
  lines.push('    }')
  lines.push('  }')
  lines.push('  model.on("msg:custom", cmdHandler)')
  lines.push('')
  lines.push('  // 7. Cleanup on widget unmount.')
  lines.push('  return () => {')
  lines.push('    for (const [eventName, handler] of evtListeners) {')
  lines.push('      nv.removeEventListener(eventName, handler)')
  lines.push('    }')
  lines.push('    for (const [pyName, handler] of observers) {')
  lines.push('      model.off(`change:${pyName}`, handler)')
  lines.push('    }')
  lines.push('    model.off("msg:custom", cmdHandler)')
  lines.push('    if (typeof nv.destroy === "function") nv.destroy()')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  lines.push('export default { render }')
  lines.push('')
  return lines.join('\n')
}

function jsString(s: string): string {
  return JSON.stringify(s)
}
