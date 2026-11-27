// Minimal local typings for the slice of the OHIF 3.13/3.14 extension API this package
// consumes. We intentionally do NOT import from `@ohif/core` here: it pulls OHIF's
// webpack-oriented dependency graph, and typing only what we use keeps this package
// buildable/testable in isolation (the host OHIF app provides the real modules at
// runtime). When wiring into a concrete OHIF app, these can be swapped for the real
// `@ohif/core` types. Checked against OHIF v3.13.14 and master (3.14 beta).

// An OHIF display set — the unit of data a viewport renders. Only the fields we read
// are typed; everything else is left open. Real display sets vary by data source
// (DICOM vs NIfTI/custom), so consumers of this must probe defensively.
export interface OhifDisplaySet {
  displaySetInstanceUID?: string
  StudyInstanceUID?: string
  SeriesInstanceUID?: string
  SeriesDescription?: string
  Modality?: string
  /** OHIF's verdict that the instances stack into a volume (false: lone or orthogonal images). */
  isReconstructable?: boolean
  // A NIfTI/volume display set may expose a direct URL (data-source dependent).
  url?: string
  // DICOM display sets carry per-instance metadata; a NIfTI-JSON source may put a
  // URL on the instance. Typed loosely — probed in displaySetToNiivue.
  instances?: ReadonlyArray<Record<string, unknown>>
  // WADO-RS imageIds, one per instance (aligned with `instances`). For a DICOM-WSI
  // (SM) display set each is a per-level frame base (`wadors:.../frames/1`).
  imageIds?: ReadonlyArray<string>
  // Optional callback OHIF's study browser calls to resolve a series preview
  // thumbnail (object URL or null). A display set that supplies one bypasses the
  // panel's default cornerstone-render fallback.
  getThumbnailSrc?: (options?: {
    signal?: AbortSignal
  }) => Promise<string | null>
  [key: string]: unknown
}

// OHIF's PubSubService surface. A payload's shape depends on the event, so
// each subscriber names the one it handles.
export interface OhifPubSub<Payload = unknown> {
  EVENTS: Record<string, string>
  subscribe<E = Payload>(
    event: string,
    cb: (e: E) => void,
  ): { unsubscribe(): void }
}

// A MeasurementService row; only the fields we read are typed.
export interface OhifMeasurement {
  uid: string
  toolName?: string
  label?: string
  isVisible?: boolean
  points?: number[][]
  referenceSeriesUID?: string
  source?: { name?: string }
  metadata?: { sliceType?: number }
  /** Stats as stored: per image for cornerstone rows (an SR's NUM values). */
  data?: Record<string, unknown>
  SOPInstanceUID?: string
  frameNumber?: number
  referencedImageId?: string
  [key: string]: unknown
}
export interface OhifMeasurementSource {
  uid?: string
}
export interface OhifMeasurementEvent {
  viewportId?: string
  // MEASUREMENT_UPDATED/JUMP carry the full measurement object; the
  // MEASUREMENT_REMOVED payload carries the uid as a bare string.
  measurement?: string | OhifMeasurement
}
export interface OhifMeasurementService
  extends OhifPubSub<OhifMeasurementEvent> {
  createSource(name: string, version: string): OhifMeasurementSource
  addMapping(
    source: OhifMeasurementSource,
    annotationType: string,
    matchingCriteria: Array<{ valueType: string; points?: number }>,
    toAnnotationSchema: (data: unknown) => unknown,
    toMeasurementSchema: (data: { measurement: unknown }) => unknown,
  ): void
  addRawMeasurement(
    source: OhifMeasurementSource,
    annotationType: string,
    data: unknown,
    toMeasurementSchema: (data: { measurement: unknown }) => unknown,
  ): string | undefined
  getMeasurements(): OhifMeasurement[]
  getMeasurement(uid: string): OhifMeasurement | undefined
  remove(uid: string, source?: OhifMeasurementSource): void
  clearMeasurements?: (...args: unknown[]) => unknown
  /** Set once installClearHistory has wrapped clearMeasurements. */
  __nvClear?: true
}

export interface OhifSegmentationService
  extends OhifPubSub<{ segmentationId?: string } | undefined> {
  setActiveSegmentation(viewportId: string, id: string): void
  setActiveSegment(id: string, index: number): void
  getActiveSegmentation(
    viewportId: string,
  ): { segmentationId: string; segments?: Record<string, unknown> } | undefined
  getActiveSegment(viewportId: string): { segmentIndex: number } | undefined
  getNextAvailableSegmentIndex(segmentationId: string): number
  addSegment(segmentationId: string, config: { segmentIndex: number }): void
  getSegmentations?(): unknown[]
  getSegmentation?(id: string): { label?: string } | undefined
  getSegmentationRepresentations?(viewportId: string): unknown[]
}

export interface OhifDisplaySetService extends Partial<OhifPubSub> {
  getActiveDisplaySets?(): OhifDisplaySet[]
  getDisplaySetsForSeries?(uid: string): ReadonlyArray<OhifDisplaySet>
  getDisplaySetByUID?(uid: string): OhifDisplaySet | undefined
}

export interface OhifViewportGridService extends Partial<OhifPubSub> {
  getActiveViewportId(): string | null | undefined
  setActiveViewportId?(viewportId: string): void
  getDisplaySetsUIDsForViewport?(viewportId: string): string[]
  getState?(): {
    activeViewportId?: string
    viewports?: Map<
      string,
      {
        displaySetInstanceUIDs?: string[]
        displaySetOptions?: Record<string, unknown>[]
      }
    >
  }
}

export interface OhifCustomizationService {
  getCustomization?(id: string): unknown
}

export interface OhifToolbarService {
  refreshToolbarState?(props: Record<string, unknown>): void
  getButtonComponentForUIType?(uiType: string): unknown
  _evaluateFunction?: Record<string, (args: Record<string, unknown>) => unknown>
}

export interface OhifToolGroup {
  toolOptions?: Record<
    string,
    { mode?: string; bindings?: { mouseButton?: number }[] }
  >
  getToolConfiguration?: (tool: string, key?: string) => unknown
}
export interface OhifToolGroupService extends Partial<OhifPubSub> {
  getActivePrimaryMouseButtonTool?(toolGroupId?: string): string | undefined
  getToolGroup?(toolGroupId: string): OhifToolGroup | undefined
}

export interface OhifUiNotificationService {
  show?(notification: Record<string, unknown>): void
}
export interface OhifUiModalService {
  show?(modal: Record<string, unknown>): void
  hide?(): void
}
export type OhifViewportDialog = { viewportId?: string } & Record<
  string,
  unknown
>
export interface OhifUiViewportDialogService {
  show(dialog: OhifViewportDialog): void
  hide(): void
  /** Listeners viewportNotification mirrors show/hide to, once wrapped. */
  __nvMirror?: Set<(dialog: OhifViewportDialog | null) => void>
}
// Some modals close through the provider itself, so only isEmpty is reliable.
export interface OhifUiDialogService {
  isEmpty?(): boolean
}

export type OhifCine = { isPlaying?: boolean; frameRate?: number }
export interface OhifCineService extends Partial<OhifPubSub> {
  getState?():
    | { isCineEnabled?: boolean; cines?: Record<string, OhifCine> }
    | undefined
  setCine?(cine: { id: string } & OhifCine): void
  setIsCineEnabled?(isCineEnabled: boolean): void
}

export interface OhifUserAuthenticationService {
  getAuthorizationHeader?(): { Authorization?: string } | undefined
}

// The services this package reads. Any may be missing from a host.
export interface OhifServices {
  measurementService?: OhifMeasurementService
  segmentationService?: OhifSegmentationService
  displaySetService?: OhifDisplaySetService
  viewportGridService?: OhifViewportGridService
  customizationService?: OhifCustomizationService
  toolbarService?: OhifToolbarService
  toolGroupService?: OhifToolGroupService
  uiNotificationService?: OhifUiNotificationService
  uiModalService?: OhifUiModalService
  uiViewportDialogService?: OhifUiViewportDialogService
  uiDialogService?: OhifUiDialogService
  cineService?: OhifCineService
  userAuthenticationService?: OhifUserAuthenticationService
}

// The subset of OHIF managers a viewport receives.
export interface OhifServicesManager {
  services: OhifServices
}
export interface OhifExtensionManager {
  getModuleEntry: (id: string) => unknown
  getActiveDataSource?: () => ReadonlyArray<{
    getImageIdsForDisplaySet?: (ds: OhifDisplaySet) => string[]
  }>
}
export interface OhifCommandsManager {
  runCommand: (
    name: string,
    options?: Record<string, unknown>,
    context?: string,
  ) => unknown
}

// Props the OHIF viewport grid passes (ViewportGrid.tsx, 3.13 and 3.14), plus
// the managers, which getNiivueViewportModule injects from its params.
export interface OhifViewportProps {
  displaySets: ReadonlyArray<OhifDisplaySet>
  viewportId: string
  viewportLabel?: string
  dataSource?: unknown
  viewportOptions?: {
    orientation?: string
    viewportType?: string
    toolGroupId?: string
    /** Pane background, RGB 0-1 (TMTV's MIP pane). */
    background?: number[]
    syncGroups?: ReadonlyArray<{ type?: string; id?: string } | string>
    /** Hanging-protocol extras; `hideOverlays` drops the corner text (e.g. a 3D pane). */
    customViewportProps?: { hideOverlays?: boolean }
  }
  // Per display set, hanging-protocol options (e.g. `options.voi`).
  displaySetOptions?: ReadonlyArray<Record<string, unknown>>
  needsRerendering?: boolean
  isHangingProtocolLayout?: boolean
  // Marks the viewport ready (viewportGridService.setViewportIsReady).
  onElementEnabled?: (evt?: unknown) => void
  servicesManager?: OhifServicesManager
  commandsManager?: OhifCommandsManager
  extensionManager?: OhifExtensionManager
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
  context?: string
}
export interface OhifToolbarButton {
  id: string
  uiType: string
  props: {
    icon?: string
    label?: string
    tooltip?: string
    buttonSection?: boolean
    commands?:
      | string
      | OhifToolbarButtonCommand
      | Array<string | OhifToolbarButtonCommand>
    evaluate?:
      | string
      | Record<string, unknown>
      | Array<string | Record<string, unknown>>
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
  // Makes `name` a toolbar uiType: a React component OHIF renders buttons of
  // that uiType with (their props plus the evaluated state).
  defaultComponent?: unknown
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
  definitions: Record<
    string,
    {
      commandFn: (...args: never[]) => unknown
      options?: Record<string, unknown>
    }
  >
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
  getPanelModule?: (context: OhifExtensionParams) => unknown[]
  getCustomizationModule?: (
    context: OhifExtensionParams,
  ) => OhifCustomizationModuleEntry[]
  onModeExit?: () => void
}
