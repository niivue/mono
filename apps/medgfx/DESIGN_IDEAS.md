# medgfx Design Ideas

## Product direction

Treat medgfx as a native, viewer-first medical imaging workspace rather than a settings dashboard. The image canvas should remain the dominant element, while native controls appear contextually around it using familiar macOS, iPadOS, and iOS conventions.

The existing architecture remains appropriate: SwiftUI owns the application chrome and document interactions, while `NiiVueWebView` is a focused rendering surface.

## Design principles

1. **Viewer first** — preserve as much space as possible for medical images.
2. **Progressive disclosure** — keep common display controls close at hand and move implementation-oriented controls into Advanced settings.
3. **Native on every platform** — share concepts and data models, but use platform-appropriate navigation and presentation.
4. **Contextual controls** — show controls that apply to the selected volume, mesh, viewport, or mode.
5. **Quiet chrome** — use restrained materials, typography, and color so grayscale images retain perceptual priority.
6. **Direct manipulation** — prioritize gestures, drag and drop, and canvas interactions over persistent controls.

## macOS layout

Use a three-region workspace with a thin toolbar and status bar:

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Open   Sidebar │ Axial Coronal Sagittal  3D │ Fit  Reset │ Inspector│
├───────────────┬───────────────────────────────────────┬─────────────┤
│ STUDY         │                                       │ DISPLAY     │
│               │                                       │             │
│ mni152        │              VIEWER                   │ Window      │
│   Volume 1  ● │                                       │ Level       │
│               │                                       │ Opacity     │
│ Recent files  │                                       │ Colormap    │
│               │                                       │             │
│               │                                       │ VIEW        │
│               │                                       │ Layout      │
│               │                                       │ Overlays    │
├───────────────┴───────────────────────────────────────┴─────────────┤
│ Ready                      x: 12  y: -18  z: 24 mm       WebGPU     │
└─────────────────────────────────────────────────────────────────────┘
```

### Study sidebar

The leading sidebar should contain document and layer-level information:

- Open volume or mesh
- Drop target for supported files
- Loaded items with selection and visibility controls
- Optional opacity control for each loaded item
- Recent documents when nothing is loaded
- File metadata and dimensions in a disclosure section

Use a standard collapsible sidebar and remember its visibility between launches.

### Central viewer

The viewer should always receive most of the window:

- Accept files dropped directly onto the canvas
- Show transient information in a small heads-up display
- Allow double-clicking a viewport to maximize or restore it
- Show loading state without unnecessarily replacing an existing image
- Keep persistent controls outside the canvas unless they directly manipulate the view

### Inspector

Use a collapsible trailing inspector approximately 300–340 points wide. Controls should describe user goals rather than implementation details. Prefer grouped controls and disclosure sections over a segmented picker that replaces the entire inspector.

Where practical, use native split-view and inspector APIs so resizing, keyboard focus, restoration, and accessibility behave like other macOS applications.

## iPadOS layout

Use the same workspace concepts while adapting to available width:

- Full-screen viewer by default
- Leading study sidebar as a collapsible split view
- Trailing inspector as an inspector, popover, or sheet
- Compact view-mode controls in the toolbar
- Support pointer hover, hardware keyboards, drag and drop, and multiple windows
- Collapse controls into sheets in portrait, Slide Over, or narrow Split View rather than squeezing the canvas

A possible toolbar arrangement:

```text
[Files]       [Axial | Coronal | Sagittal | 3D]       [Display] [More]
```

The iPad experience should be capable of desktop-style inspection without requiring the macOS layout to be reproduced exactly.

## iPhone layout

Use a focused single-document inspection experience:

```text
┌───────────────────────────┐
│ ‹ Files    mni152    •••  │
├───────────────────────────┤
│                           │
│                           │
│          VIEWER           │
│                           │
│                           │
├───────────────────────────┤
│ A   C   S   3D  │ Display│
└───────────────────────────┘
```

- Let the canvas occupy nearly the entire screen
- Use a bottom toolbar to change orientation or layout
- Open display controls in a detented sheet
- Show coordinates as a compact transient overlay
- Keep file management one navigation level above the viewer
- Avoid reproducing desktop sidebars on a compact screen

## Information architecture

Rename the current inspector categories around user intent:

| Current name | Suggested name |
| --- | --- |
| View | Layout |
| Chrome | Overlays |
| Scene | Appearance |
| Backend | Advanced > Rendering Engine |

### Display

Controls related to the selected image or layer:

- Window and level, when available
- Colormap
- Opacity
- Gamma
- Background color

### Layout

Controls related to viewport arrangement:

- Axial, coronal, sagittal, multiplanar, and 3D modes
- Multiplanar arrangement
- 3D panel visibility
- Radiological orientation
- Mosaic configuration inside an Advanced Layout disclosure

### Overlays

Controls for information drawn over the image:

- Crosshair
- Cross lines
- Orientation labels
- Colorbar
- Ruler
- Legend
- Orientation cube

### 3D

Controls that apply to volume or mesh rendering:

- Azimuth and elevation
- Reset camera
- X-ray strength rather than only an on/off switch
- Render quality options when exposed by NiiVue

### Advanced

Implementation and diagnostic options:

- WebGPU or WebGL2 rendering engine
- Rendering capabilities
- Diagnostic information
- Web-view or bridge status in development builds

Backend switching recreates the rendering resources and re-renders the loaded data; it does not discard the data. It remains an Advanced control because most users do not need to choose the graphics implementation.

## Toolbar design

The primary toolbar should contain frequent, workspace-level actions:

- Open file
- Toggle study sidebar
- Select axial, coronal, sagittal, multiplanar, or 3D view
- Fit view
- Reset camera or view
- Toggle inspector

Less frequent actions should move to an overflow menu. Avoid placing every NiiVue property in the toolbar.

On compact iOS, use a bottom toolbar for view selection and a single Display button that presents a sheet.

## Visual language

Keep the native interface restrained:

- Use system materials and typography
- Use a black or near-black viewer background
- Use neutral gray application chrome
- Select one cool accent color, such as blue or cyan
- Use SF Symbols for familiar actions
- Avoid decorative cards around every section
- Use separators, grouped controls, and alignment to establish hierarchy
- Reserve monospaced digits for coordinates, measurements, and technical values

Controls should remain readable in both light and dark system appearances, while the viewer itself can remain dark in either appearance.

## Empty state

Replace the permanent **Load sample** footer action with an empty-state overlay shown when no document is loaded:

```text
              [medical image symbol]

               Open an image

       Drop a NIfTI or supported mesh here
             [Open…]  [Try Sample]
```

The empty state should:

- Explain supported input at a high level
- Accept drag and drop on macOS and iPadOS
- Offer a native file importer
- Keep the bundled sample as a secondary learning action
- Disappear as soon as content starts loading

## Loading and errors

### Loading

- Keep the current image visible when loading additional content where possible
- Show compact progress in the toolbar or layer row
- Offer cancellation for large files
- Disable only actions that would conflict with loading
- Avoid blocking the complete interface with a modal spinner

### Errors

Errors should identify the file and provide a useful next action. For example:

> `mni152.nii.gz` could not be decoded.
>
> Show Details · Choose Another File

Technical bridge errors should be translated into user-facing language, with raw details available in a disclosure or diagnostics view.

## Interaction model

Suggested default interactions:

- Drag: move the crosshair in 2D or rotate the scene in 3D
- Scroll or pinch: zoom
- Secondary drag or two-finger drag: pan
- Double-click or double-tap: maximize or restore a viewport
- Two-finger tap: reset the current view
- Long press: show coordinate and intensity information

The exact gesture behavior should follow NiiVue capabilities and remain consistent across view modes. Touch devices should include an accessible gesture-help screen.

## Keyboard shortcuts

Suggested macOS and hardware-keyboard shortcuts:

| Shortcut | Action |
| --- | --- |
| `Command-O` | Open |
| `Command-1` | Axial |
| `Command-2` | Coronal |
| `Command-3` | Sagittal |
| `Command-4` | 3D |
| `Command-0` | Multiplanar |
| `Command-Shift-I` | Toggle inspector |
| `Command-Backslash` | Toggle study sidebar |
| `F` | Fit view |
| `R` | Reset camera or view |

Shortcuts should be exposed through menu commands so users can discover them from the menu bar.

## Accessibility

- Give every icon-only control an explicit accessibility label
- Do not communicate layer state using color alone
- Ensure inspector controls support keyboard and switch navigation
- Preserve Dynamic Type on iOS and iPadOS
- Provide sufficiently large touch targets
- Announce loading completion and errors through accessibility notifications
- Offer text coordinate readouts rather than relying only on crosshair position
- Respect Reduce Motion when animating sidebars, sheets, and viewport transitions

## Privacy and safety

Medical files may contain sensitive information. The interface should make its local behavior clear:

- Process files locally by default
- Do not upload content without an explicit user action
- Avoid exposing patient or file names in notifications
- Use privacy-conscious recent-document presentation
- Clearly label any future network-backed feature

## Suggested implementation sequence

### Phase 1: improve the current shell

1. Turn the current footer into a thin macOS status bar.
2. Move **Load sample** into an empty-state overlay.
3. Rename **Chrome** to **Overlays** and **Scene** to **Appearance**.
4. Move backend selection into an Advanced section.
5. Add a compact orientation and layout picker to the main toolbar.
6. Replace the segmented inspector header with grouped, collapsible sections on compact iOS.

### Phase 2: native document interactions

1. Add native file opening.
2. Add drag and drop on macOS and iPadOS.
3. Add recent documents to the empty state or study sidebar.
4. Add menu commands and keyboard shortcuts.
5. Add loading, cancellation, and actionable error presentation.

### Phase 3: workspace features

1. Add a loaded-items study sidebar when multiple volumes or meshes are supported.
2. Add selection-aware display controls.
3. Restore sidebar, inspector, layout, and window state.
4. Add iPad multiwindow document support.
5. Add a diagnostics view for rendering backend and bridge information.

## Relationship to the current code

These ideas preserve the existing architecture:

- `NiiVueWebView` remains the dominant rendering surface.
- `NiiVueModel` remains the synchronized SwiftUI model.
- Inspector controls continue to use the generic property bridge.
- Platform-specific SwiftUI containers determine how the same controls are presented.
- Bespoke bridge methods are added only for document operations or NiiVue methods that cannot use property synchronization.

The main design change is hierarchy: common image-viewing actions become prominent, document handling becomes native, and low-level rendering options move out of the primary workflow.
