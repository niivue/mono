// Minimal local typings for the slice of the OHIF 3.12 extension API this package
// consumes. We intentionally do NOT import from `@ohif/core` here: it pulls OHIF's
// webpack-oriented dependency graph, and typing only what we use keeps this package
// buildable/testable in isolation (the host OHIF app provides the real modules at
// runtime). When wiring into a concrete OHIF app, these can be swapped for the real
// `@ohif/core` types. Verify field names against the target OHIF version (3.12.x).

// An OHIF display set — the unit of data a viewport renders. Only the fields we read
// are typed; everything else is left open. Real display sets vary by data source
// (DICOM vs NIfTI/custom), so consumers of this must probe defensively.
export interface OhifDisplaySet {
  displaySetInstanceUID?: string
  SeriesInstanceUID?: string
  SeriesDescription?: string
  Modality?: string
  // A NIfTI/volume display set may expose a direct URL (data-source dependent).
  url?: string
  // DICOM display sets carry per-instance metadata; a NIfTI-JSON source may put a
  // URL on the instance. Typed loosely — probed in displaySetToNiivue.
  instances?: ReadonlyArray<Record<string, unknown>>
  [key: string]: unknown
}

// The subset of OHIF managers a viewport receives. Typed as opaque for now; the
// viewport uses them only to run commands / read services once those paths land.
export interface OhifServicesManager {
  services: Record<string, unknown>
}
export interface OhifExtensionManager {
  getModuleEntry: (id: string) => unknown
}
export interface OhifCommandsManager {
  runCommand: (name: string, options?: Record<string, unknown>) => unknown
}

// Props OHIF passes to a viewport component (3.12). `displaySets` is the array of
// display sets hung in this viewport; `viewportOptions` carries layout/orientation.
export interface OhifViewportProps {
  displaySets: ReadonlyArray<OhifDisplaySet>
  viewportId: string
  viewportOptions?: { orientation?: string; viewportType?: string }
  servicesManager?: OhifServicesManager
  extensionManager?: OhifExtensionManager
  commandsManager?: OhifCommandsManager
  children?: unknown
}

// What getViewportModule returns: a named viewport component entry.
export interface OhifViewportModuleEntry {
  name: string
  component: (props: OhifViewportProps) => unknown
}

// A SOPClassHandler module entry — declares which display sets this viewport claims.
export interface OhifSopClassHandlerEntry {
  name: string
  sopClassUids: string[]
  getDisplaySetsFromSeries: (
    instances: ReadonlyArray<Record<string, unknown>>,
  ) => ReadonlyArray<OhifDisplaySet>
}

// The parameter object OHIF passes to every extension module getter.
export interface OhifExtensionParams {
  servicesManager?: OhifServicesManager
  extensionManager?: OhifExtensionManager
  commandsManager?: OhifCommandsManager
}

// A toolbar button definition (the slice of @ohif/core's Button type we emit).
// `commands` is a command name, or `{ commandName, commandOptions }`, or a list
// of those; `evaluate` names a registered toolbar evaluator.
export interface OhifToolbarButtonCommand {
  commandName: string
  commandOptions?: Record<string, unknown>
}
export interface OhifToolbarButton {
  id: string
  uiType: string
  props: {
    icon?: string
    label?: string
    tooltip?: string
    buttonSection?: boolean
    commands?: string | OhifToolbarButtonCommand | OhifToolbarButtonCommand[]
    evaluate?: string | Record<string, unknown>
    [key: string]: unknown
  }
}

// What a toolbar evaluator returns to shape button state; undefined leaves the
// button untouched.
export interface OhifToolbarEvaluation {
  disabled?: boolean
  disabledText?: string
  isActive?: boolean
  className?: string
}
export interface OhifToolbarModuleEntry {
  name: string
  evaluate?: (state: {
    viewportId?: string
    button?: OhifToolbarButton
    [key: string]: unknown
  }) => OhifToolbarEvaluation | undefined
}

// What getCommandsModule returns: named command functions plus the context
// they register under.
export interface OhifCommandsModule {
  actions: Record<string, (...args: never[]) => unknown>
  definitions: Record<string, (...args: never[]) => unknown>
  defaultContext?: string
}

// A customization module entry; the entry named 'default' is auto-merged at
// default scope when the extension registers.
export interface OhifCustomizationModuleEntry {
  name: string
  value: Record<string, unknown>
}

// The extension object OHIF registers.
export interface OhifExtension {
  id: string
  version?: string
  getViewportModule: (context: OhifExtensionParams) => OhifViewportModuleEntry[]
  getSopClassHandlerModule?: (
    context: OhifExtensionParams,
  ) => OhifSopClassHandlerEntry[]
  getCommandsModule?: (context: OhifExtensionParams) => OhifCommandsModule
  getToolbarModule?: (context: OhifExtensionParams) => OhifToolbarModuleEntry[]
  getCustomizationModule?: (
    context: OhifExtensionParams,
  ) => OhifCustomizationModuleEntry[]
}
