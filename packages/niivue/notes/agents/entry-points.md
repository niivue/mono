# Entry points and public exports

Moved from `packages/niivue/AGENTS.md`; read it when working on adding, removing or renaming a public export. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Entry points and public exports

### The only sanctioned differences

`src/index.webgl2.ts` and `src/index.webgpu.ts` are the same file apart from
four lines: the header comment, the backend's own slide renderer, the module
`createSlideView` comes from, and the default export.

```bash
diff src/index.webgl2.ts src/index.webgpu.ts
# exactly four hunks:
#   the 'WebGL2-only distribution' header comment vs 'WebGPU-only'
#   export { SlideRenderer } from './gl/slide'
#                             vs   { SlideRendererGPU } from './wgpu/slide'
#   export { default, default as NiiVue } from './NVControlWebGL2'
#                                          vs   './NVControlWebGPU'
#   export { createSlideView } from './slide/slideViewWebGL2'
#                               vs   './slide/slideViewWebGPU'
```

A fifth hunk is a bug. That diff is the cheapest pre-push check there is.

Against the root entry, the one sanctioned omission is the **`*Detail` event
payload types** re-exported from `./NVEvents` (`VolumeLoadedDetail`,
`ClipPlaneChangeDetail`, and the rest). Those are root-only. Everything else the
root entry exports belongs in both backend entries as well.

### Checking a branch

`src/entryPoints.test.ts` asserts all of this and runs in the normal `bun test`
target, so ordinary CI catches the drift now. It checks four things: the two
backend entries differ only by their own slide renderer; neither exports a name
the root entry lacks; nothing but `*Detail` types and the other backend's
renderer is root-only; and every `*Detail` type `NVEvents.ts` declares is
exported from root.

By hand, the same question:

```bash
names() {
  tr '\n' ' ' < "$1" | grep -oE 'export (type )?\{[^}]*\} from' |
  tr -d '{}' | sed 's/export \(type \)*//;s/ from//' | tr ',' '\n' |
  sed 's/.* as //;s/^ *type *//;s/^ *//;s/ *$//' | grep -v '^$' | sort -u
}
diff <(names src/index.ts) <(names src/index.webgl2.ts) | grep '^<' | grep -v 'Detail$'
```

### Keeping the three files in step

The backend entries are a mechanical function of the root entry: root, minus the
`*Detail` names, with the header comment, the slide-renderer line and the default
export swapped. Edit `src/index.ts` first and mirror the change into both backend
files; the test above will tell you if you missed one.

### Rebasing a branch that adds an export

A long-lived branch that adds an export can collide with one that already landed,
and git will not tell you. The re-export lines sit in different hunks, so the
merge is clean; the duplicate becomes a `tsc` error only once both are in the same
file:

```
src/index.ts(264,27): error TS2300: Duplicate identifier 'SliceTile'.
src/index.ts(452,32): error TS2300: Duplicate identifier 'SliceTile'.
```

GitHub reporting a branch MERGEABLE is not evidence of anything here. Mergeable is
a statement about text, not about types, and a branch that merges cleanly can
still break `main` on the next typecheck. A branch already marked CONFLICTING is
the safer case, because someone has to look at it.

Before merging a branch that adds a public export and predates the last change to
`src/index.ts`, check the symbol against all three entries on `main`:

```bash
git fetch origin
for f in index index.webgl2 index.webgpu; do
  printf '%-14s ' "$f"
  git show "origin/main:packages/niivue/src/$f.ts" | grep -c '\bTheSymbol\b'
done
```

Any non-zero count means the branch must drop its own line and widen the existing
one instead.

PR #170 is the worked example: it adds `SliceTile` and `projectMMToCanvas`,
both of which #177 had already exported from all three entries, plus a genuinely
new `CanvasTilePoint`. The rebase keeps only the new name.

### Types named in public signatures

A type that appears in a public getter, setter, method parameter or return type
has to be exported from all three entries. Otherwise a consumer can call the
method and still not be able to name what it hands back.

`entryPoints.test.ts` does not catch this, and cannot as written. It checks that
the three entries agree with each other, and that every `*Detail` type in
`NVEvents.ts` is exported. A type that no entry exports is consistent across all
three, so it passes. Export the types in a method's signature in the same commit
as the method.

To find what has already slipped through, list the PascalCase names used in
`NVControlBase`'s public signatures and subtract the ones the root entry
re-exports:

```bash
cd packages/niivue/src
grep -oE '^  (async )?(get |set )?[a-zA-Z_][a-zA-Z0-9_]*\(.*' NVControlBase.ts \
  | grep -oE '\b[A-Z][A-Za-z0-9_]+\b' | sort -u > /tmp/used.txt
tr '\n' ' ' < index.ts | grep -oE 'export (type )?\{[^}]*\} from' | tr -d '{}' \
  | sed 's/export \(type \)*//;s/ from//' | tr ',' '\n' \
  | sed 's/.* as //;s/^ *type *//;s/^ *//;s/ *$//' | grep -v '^$' | sort -u > /tmp/exported.txt
# keep only names this package declares as an exported type
comm -23 /tmp/used.txt /tmp/exported.txt | while read -r t; do
  grep -rqE "^export (type|interface|class|enum) $t\b" . --exclude-dir=node_modules && echo "$t"
done
```

Read the output as candidates, not findings. The last filter drops builtins and
private classes, but the scan still misses a type that appears only on a
continuation line of a multi-line return type, so it under-reports. Confirm each
hit is used in a genuinely public member before adding it to the entries.

### Before removing an export

An export in this package has consumers you will not find by searching
`packages/niivue`. The extensions, `nv-ohif`, `nv-react`, `uikit`, the demo apps
and `examples/` all import from `@niivue/niivue` by package name.

Two steps, both required:

```bash
# 1. Search the whole workspace, enumerated -- never a remembered list of packages
grep -rn '\bTheSymbol\b' --exclude-dir=node_modules --exclude-dir=dist packages apps

# 2. Typecheck the dependents, not just this package
bunx nx affected -t typecheck        # NOT --projects=niivue
```

`nx run-many`/`--projects=niivue` passes happily while a sibling package is
broken, because the sibling's `typecheck` never runs. `nx affected` follows the
`workspace:*` edges and catches it.

This is not hypothetical. Issue #176 proposed removing five exports on the
finding that they had no consumers. Every one of the five had a consumer:
`NVWorker` in `nv-ext-drawing` and `nv-ext-image-processing`, `slice2DToMM` in
`nv-ohif`, `nii2volume` in an e2e spec and a demo bundle, and the two drawing
helpers in `examples/slides.js`. The search that missed them used a
hand-remembered package list and a niivue-scoped gate.
