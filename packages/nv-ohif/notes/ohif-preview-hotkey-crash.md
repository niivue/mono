# Upstream OHIF bug: Enter/Escape preview hotkeys crash on a non-Cornerstone viewport

Status: fix applied locally in the OHIF checkout used as our test rig; not yet
filed upstream. This note is the ready-to-file report plus the patch.

## Summary

OHIF binds `Enter` to the `acceptPreview` command and `Escape` to
`rejectPreview` as global Mousetrap hotkeys (part of the segmentation-labelmap
preview flow). Both route through `actions._handlePreviewAction`, which reads the
active viewport by destructuring the result of `_getActiveViewportEnabledElement()`:

```js
const { viewport } = _getActiveViewportEnabledElement();
```

When the active viewport is not a Cornerstone enabled element, that helper returns
`undefined`, so the destructure throws:

```
TypeError: Cannot destructure property 'viewport' of
'_getActiveViewportEnabledElement(...)' as it is undefined.
```

In a development build this surfaces as React's full-screen "Uncaught runtime
errors" overlay; in production it is an uncaught exception in the Mousetrap key
callback.

This affects any integration that adds a viewport which is not a Cornerstone
enabled element (for example the NiiVue viewport in `@niivue/nv-ohif`). A stray
`Enter` or `Escape` while such a viewport is active crashes the handler.

## Repro

1. Load a mode whose active viewport is not a Cornerstone enabled element (any
   custom viewport extension; in our case a NiiVue viewport).
2. Press `Enter` (or `Escape`).
3. The `TypeError` above is thrown from `_handlePreviewAction`.

## Location

`OHIF/Viewers` - `extensions/cornerstone/src/commandsModule.ts`, in
`actions._handlePreviewAction`.

## Fix

Guard the destructure so the command no-ops when there is no active Cornerstone
enabled element. The command already no-ops when no preview tools are active; this
extends the same tolerance to a missing enabled element.

```diff
     _handlePreviewAction: action => {
-      const { viewport } = _getActiveViewportEnabledElement();
+      const enabledElement = _getActiveViewportEnabledElement();
+      if (!enabledElement) {
+        return;
+      }
+      const { viewport } = enabledElement;
       const previewTools = getPreviewTools({ toolGroupService });
```

## Why fix it upstream (not in nv-ohif)

The failing code, the command, and the global hotkey binding all live in OHIF's
cornerstone extension. The bug is triggered by any non-Cornerstone active
viewport, so the correct and minimal fix is the guard above in OHIF itself.
Working around it inside `@niivue/nv-ohif` would mean intercepting or overriding
OHIF's global `Enter`/`Escape` commands, which is more invasive and registration
order dependent. We therefore keep the guard as an upstream fix and file it with
OHIF.

## Verification (test rig)

With the guard applied in the rig's OHIF checkout: reload the viewer, make the
NiiVue viewport active, and press `Enter`/`Escape` repeatedly. No error overlay
appears and the console logs no exception.
