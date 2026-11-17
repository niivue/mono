import {
  addActivatePanelTriggers,
  applyToolGroupAdditions,
  extensionDependencies as basicDependencies,
  basicLayout,
  mode as basicMode,
  modeInstance as basicModeInstance,
  basicRoute,
  sopClassHandlers as basicSopClassHandlers,
  cornerstone,
  dicomecg,
  dicomRT,
  dicomSeg,
  dicomvideo,
  ohif,
  registerModeToolbar,
} from '@ohif/mode-basic'

const id = '@niivue/nv-ohif/modes/viewer'

export const niivue = {
  viewport: '@niivue/nv-ohif.viewportModule.niivue',
  wsiSopClassHandler: '@niivue/nv-ohif.sopClassHandlerModule.niivue-wsi',
  // Registered by @niivue/nv-ohif: on a NiiVue viewport it disables buttons
  // whose commands or tools NiiVue does not answer; elsewhere it defers to the
  // button's own evaluators.
  unsupportedEvaluator: 'evaluate.niivue.unsupported',
  segmentationEvaluator: 'evaluate.niivue.segmentation',
}

// Mirrors OHIF's longitudinal mode (route /viewer): measurement tracking, with
// its tracked series list and measurements panel; nv-ohif forwards NiiVue
// measurements to the tracker in place of the tracked cornerstone viewport.
export const tracked = {
  measurements:
    '@ohif/extension-measurement-tracking.panelModule.trackedMeasurements',
  thumbnailList: '@ohif/extension-measurement-tracking.panelModule.seriesList',
}

export const extensionDependencies = {
  ...basicDependencies,
  '@ohif/extension-measurement-tracking': '^3.0.0',
  '@niivue/nv-ohif': '^1.0.0',
}

// NiiVue claims the SM SOP class instead of Cornerstone; registering both
// handlers would create two competing display sets per slide.
export const sopClassHandlers = basicSopClassHandlers.map((handler) =>
  handler === ohif.wsiSopClassHandler ? niivue.wsiSopClassHandler : handler,
)

export const niivueLayout = {
  ...basicLayout,
  props: {
    ...basicLayout.props,
    leftPanels: [tracked.thumbnailList],
    rightPanels: [cornerstone.segmentation, tracked.measurements],
    viewports: [
      {
        namespace: niivue.viewport,
        // A SEG or RTSTRUCT shows as a NiiVue drawing over the series it references.
        displaySetsToDisplay: [
          ohif.sopClassHandler,
          niivue.wsiSopClassHandler,
          dicomSeg.sopClassHandler,
          dicomRT.sopClassHandler,
        ],
      },
      {
        namespace: cornerstone.viewport,
        displaySetsToDisplay: [
          dicomvideo.sopClassHandler,
          dicomecg.sopClassHandler,
        ],
      },
      // SR, PDF and PMAP keep their own (Cornerstone-based) viewports.
      ...basicLayout.props.viewports
        .slice(1)
        .filter(
          (viewport) =>
            viewport.namespace !== dicomSeg.viewport &&
            viewport.namespace !== dicomRT.viewport,
        ),
    ],
  },
}

export const niivueRoute = {
  ...basicRoute,
  path: 'niivue-viewer',
  layoutInstance: niivueLayout,
}

// Cornerstone's segmentation evaluator wants a cornerstone tool group per pane;
// nv-ohif's answers it for NiiVue panes and defers to cornerstone's elsewhere.
// Only where the installed nv-ohif registers it (OHIF throws on an unknown evaluator).
let hasNiivueSegmentationEvaluator = false
function niivueSegmentationEvaluator(evaluator) {
  if (!hasNiivueSegmentationEvaluator) return evaluator
  const name = typeof evaluator === 'string' ? evaluator : evaluator?.name
  if (name !== 'evaluate.cornerstone.segmentation') return evaluator
  return typeof evaluator === 'string'
    ? niivue.segmentationEvaluator
    : { ...evaluator, name: niivue.segmentationEvaluator }
}

/**
 * Adds the NiiVue evaluator in front of a button's own evaluators. Done here,
 * not by importing @niivue/nv-ohif's withNiivueSupport, so loading this mode at
 * app start does not pull NiiVue into the startup bundle: the extension is
 * only imported when the mode is entered.
 */
function withNiivueSupport(button) {
  if (!button?.props?.commands) {
    // Section lists, menus and the layout selector carry no commands.
    return button
  }
  const { evaluate } = button.props
  const evaluators = evaluate === undefined ? [] : [].concat(evaluate)
  // OHIF reads hideWhenDisabled from a single object evaluator, not from a list.
  const hideWhenDisabled =
    !Array.isArray(evaluate) && evaluate?.hideWhenDisabled === true
      ? { hideWhenDisabled: true }
      : {}
  return {
    ...button,
    props: {
      ...button.props,
      ...hideWhenDisabled,
      evaluate: [
        niivue.unsupportedEvaluator,
        ...evaluators.map(niivueSegmentationEvaluator),
      ],
    },
  }
}

function onModeEnter({ servicesManager, extensionManager, commandsManager }) {
  const {
    measurementService,
    toolbarService,
    toolGroupService,
    customizationService,
  } = servicesManager.services

  measurementService.clearMeasurements()
  this._unsubscriptions = []

  // Toolbar evaluators create cornerstone's rendering engine even here, and
  // its default pool holds 7 WebGL contexts of the ~16 a page may keep live;
  // NiiVue panes need them (TMTV hangs 10). Cornerstone only draws SR/video here.
  const { cornerstone } = extensionManager
    .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
    .exports.getCornerstoneLibraries()
  const config = cornerstone.getConfiguration()
  this._cornerstoneContextCount = config.rendering.webGlContextCount
  cornerstone.setConfiguration({
    ...config,
    rendering: { ...config.rendering, webGlContextCount: 1 },
  })

  // NiiVue mirrors the active primary tool of the 'default' tool group.
  this.initToolGroups?.({
    extensionManager,
    toolGroupService,
    commandsManager,
    servicesManager,
  })

  hasNiivueSegmentationEvaluator =
    !!toolbarService._evaluateFunction?.[niivue.segmentationEvaluator]
  const toolbarButtons = [].concat(
    customizationService.getCustomization('toolbarButtons') ?? [],
  )
  registerModeToolbar(
    { toolbarService },
    {
      toolbarButtons: toolbarButtons.map(withNiivueSupport),
      toolbarSections: customizationService.getCustomization('toolbarSections'),
    },
  )

  applyToolGroupAdditions(
    { toolGroupService },
    customizationService.getCustomization('toolGroupAdditions'),
  )

  this._unsubscriptions.push(
    ...addActivatePanelTriggers(
      { servicesManager },
      this.activatePanelTriggers,
    ),
  )
}

// Basic exit destroys the rendering engine; the next one gets the default pool back.
function onModeExit(ctx) {
  basicModeInstance.onModeExit.call(this, ctx)
  const { cornerstone } = ctx.extensionManager
    .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
    .exports.getCornerstoneLibraries()
  const config = cornerstone.getConfiguration()
  cornerstone.setConfiguration({
    ...config,
    rendering: {
      ...config.rendering,
      webGlContextCount: this._cornerstoneContextCount,
    },
  })
}

export const modeInstance = {
  ...basicModeInstance,
  id,
  routeName: 'niivue-viewer',
  displayName: 'NiiVue Viewer',
  routes: [niivueRoute],
  extensions: extensionDependencies,
  sopClassHandlers,
  onModeEnter,
  onModeExit,
  toolbarButtons: [
    { $reference: 'cornerstone.toolbarButtons' },
    { $reference: 'niivue.toolbarButtons' },
  ],
  toolbarSections: [
    { $reference: 'cornerstone.toolbarSections' },
    { $reference: 'niivue.toolbarSections' },
    {
      // NiivueCapture and NiivueCrosshair replace Cornerstone's Capture and
      // Crosshairs, which fail or no-op on a NiiVue viewport.
      primary: [
        'MeasurementTools',
        'Zoom',
        'Pan',
        'WindowLevel',
        // Views live in each pane's upper-left orientation menu, as cornerstone's.
        'NiivueWindowLevel',
        'NiivueColormap',
        'NiivueClip',
        'NiivueCapture',
        'Layout',
        'NiivueCrosshair',
        'MoreTools',
      ],
    },
  ],
}

const mode = {
  ...basicMode,
  id,
  modeInstance,
  extensionDependencies,
}

/**
 * Mode factory: the NiiVue viewer under another route, its layout props and
 * modeInstance fields overridden (hooks see the instance as `this`).
 */
export function niivueMode({ id, routeName, layout = {}, ...overrides }) {
  return {
    ...mode,
    id,
    modeInstance: {
      ...modeInstance,
      id,
      routeName,
      routes: modeInstance.routes.map((route) => ({
        ...route,
        path: routeName,
        layoutInstance: {
          ...route.layoutInstance,
          props: { ...route.layoutInstance.props, ...layout },
        },
      })),
      ...overrides,
    },
  }
}

export default mode
