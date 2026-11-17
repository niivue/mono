// OHIF's 4D display (preclinical-4d) on NiiVue panes: its hanging protocol
// (default4D: PT 2hot slices, CT, fusion; camera/VOI sync groups), its tool
// groups and all four workflow steps, cine auto-play at 24 fps, and nv-ohif's
// 4D, ROI and time-activity panels in place of the cornerstone-cache ones.
import { DicomMetadataStore, utils } from '@ohif/core'
// Deep imports: @ohif/mode-preclinical-4d exports neither from its index.
import initPreclinicalToolGroups from '@ohif/mode-preclinical-4d/src/initToolGroups'
import preclinicalButtons from '@ohif/mode-preclinical-4d/src/toolbarButtons'
import { roiButtons, roiSection, withToolGroups } from './tmtv'
import { modeInstance, niivueMode } from './viewer'

const nvPanel = '@niivue/nv-ohif.panelModule.dynamic-volume'
const nvRoiPanel = '@niivue/nv-ohif.panelModule.roi-quantification'
const nvTacPanel = '@niivue/nv-ohif.panelModule.time-activity'
const chart = {
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.chart',
  viewport: '@ohif/extension-default.viewportModule.chartViewport',
}

// As preclinical-4d's getDefaultButtons; NiivueCrosshair stands in for Crosshairs.
const toolbarButtons = [
  {
    buttonSection: 'primary',
    buttons: [
      'MeasurementTools',
      'Zoom',
      'WindowLevel',
      'NiivueCrosshair',
      'Pan',
    ],
  },
  {
    buttonSection: 'MeasurementTools',
    buttons: ['Length', 'Bidirectional', 'ArrowAnnotate', 'EllipticalROI'],
  },
]
const step = (id, name, extra = {}) => ({
  id,
  name,
  layout: { panels: { left: [[nvPanel]], right: [] } },
  toolbarButtons,
  hangingProtocol: { protocolId: 'default4D', stageId: id },
  ...extra,
})
const steps = [
  step('dataPreparation', 'Data Preparation'),
  step('registration', 'Registration'),
  // 1x3 fusion with Brush/Eraser/Threshold and RectangleROIStartEndThreshold.
  step('roiQuantification', 'ROI Quantification', {
    layout: {
      panels: { left: [[nvPanel]], right: [[nvRoiPanel]] },
      options: { leftPanelClosed: false, rightPanelClosed: false },
    },
    toolbarButtons: [
      ...toolbarButtons,
      { buttonSection: 'primary', buttons: ['NvSegmentationTools'] },
      { buttonSection: 'NvSegmentationTools', buttons: roiSection },
    ],
  }),
  // 3 fusion + chart: the chart display set comes from nv-ohif's curves.
  step('kineticAnalysis', 'Kinetic Analysis', {
    layout: { panels: { left: [[nvPanel]], right: [[nvTacPanel]] } },
    onEnter: [{ commandName: 'niivueUpdateChartDisplaySet' }],
  }),
]

// OHIF's updateSegmentationsChartDisplaySet with nv-ohif's time-activity curves
// (one series per segment, as OHIF's one per segmentation). Curves are async,
// so the stage is re-applied once the chart display set exists.
const chartSeriesUID = utils.guid()
async function updateChartDisplaySet({ servicesManager, commandsManager }) {
  const { displaySetService, hangingProtocolService } = servicesManager.services
  const tac = await commandsManager.runCommand('niivueTimeActivity')
  const study = displaySetService
    .getActiveDisplaySets()
    .find((ds) => ds.Modality === 'PT')
  if (!tac?.curves.length || !study) return
  const colors = [
    '#e6194b',
    '#3cb44b',
    '#ffe119',
    '#4363d8',
    '#f58231',
    '#911eb4',
  ]
  const instance = {
    SOPClassUID: '1.9.451.13215.7.3.2.7.6.1',
    Modality: 'CHT',
    SOPInstanceUID: utils.guid(),
    SeriesInstanceUID: chartSeriesUID,
    StudyInstanceUID: study.StudyInstanceUID,
    StudyDescription: study.StudyDescription,
    SeriesNumber: 100,
    SeriesDescription: 'Segmentation chart series data',
    chartData: {
      series: tac.curves.map((c, k) => ({
        label: c.label,
        points: c.mean.map((v, i) => [tac.timePoints[i], v]),
        color: colors[k % colors.length],
      })),
      axis: { x: { label: `Time (${tac.unit})` }, y: { label: 'Vl (Bq/ml)' } },
    },
  }
  const { chartData, SOPInstanceUID, ...series } = instance
  DicomMetadataStore.addSeriesMetadata([series], true)
  DicomMetadataStore.addInstances([instance], true)
  for (const ds of displaySetService
    .getActiveDisplaySets()
    .filter((d) => d.Modality === 'CHT'))
    if (
      !hangingProtocolService.displaySets.some(
        (k) => k.displaySetInstanceUID === ds.displaySetInstanceUID,
      )
    )
      hangingProtocolService.displaySets.push(ds)
  commandsManager.runCommand('setHangingProtocol', {
    protocolId: 'default4D',
    stageId: 'kineticAnalysis',
  })
}

function onModeEnter(ctx) {
  modeInstance.onModeEnter.call(this, ctx)
  const { toolbarService } = ctx.servicesManager.services
  // preclinical-4d's buttons: cornerstone's target the basic tool groups, not dynamic4D-*.
  const ids = toolbarButtons.flatMap((b) => b.buttons)
  toolbarService.register(
    preclinicalButtons.filter(
      (b) => ids.includes(b.id) || b.id === 'ProgressDropdown',
    ),
    true,
  )
  // Step 3's ROI tools, on the dynamic4D tool groups.
  const groups = ['dynamic4D-pt', 'dynamic4D-ct', 'dynamic4D-fusion']
  toolbarService.register(
    roiButtons.map((b) => withToolGroups(b, groups)),
    true,
  )
  ctx.commandsManager.registerCommand(
    'DEFAULT',
    'niivueUpdateChartDisplaySet',
    {
      commandFn: () => updateChartDisplaySet(ctx),
    },
  )
  toolbarService.updateSection(toolbarService.sections.secondary, [
    'ProgressDropdown',
  ])
}

// The pending cine start, dropped if the mode exits before the panes are up.
let stopCineStart = () => {}

// After hanging-protocol matching, as OHIF's: steps may change the stage.
function onSetupRouteComplete({ servicesManager }) {
  const { workflowStepsService, cineService, viewportGridService } =
    servicesManager.services
  workflowStepsService.addWorkflowSteps(steps)
  workflowStepsService.setActiveWorkflowStep(steps[0].id)
  // OHIF auto-plays the active pane at 24 fps once its volume loads; NiiVue
  // panes start playing when their 4D series arrives. The protocol's panes
  // (not the route's first 'default' pane) are up at VIEWPORTS_READY.
  const { unsubscribe } = viewportGridService.subscribe(
    viewportGridService.EVENTS.VIEWPORTS_READY,
    () => {
      unsubscribe()
      cineService.setIsCineEnabled(true)
      cineService.setCine({
        id: viewportGridService.getActiveViewportId(),
        isPlaying: true,
        frameRate: 24,
      })
    },
  )
  stopCineStart = unsubscribe
}

function onModeExit(ctx) {
  stopCineStart()
  modeInstance.onModeExit.call(this, ctx)
}

export default niivueMode({
  id: '@niivue/nv-ohif/modes/dynamic',
  routeName: 'niivue-dynamic',
  displayName: 'NiiVue 4D (preview)',
  layout: {
    leftPanels: [nvPanel],
    rightPanels: [],
    rightPanelClosed: true,
    // Step 4's chart pane.
    viewports: [
      ...modeInstance.routes[0].layoutInstance.props.viewports,
      {
        namespace: chart.viewport,
        displaySetsToDisplay: [chart.sopClassHandler],
      },
    ],
  },
  extensions: {
    ...modeInstance.extensions,
    '@ohif/extension-cornerstone-dynamic-volume': '^3.0.0',
  },
  sopClassHandlers: [...modeInstance.sopClassHandlers, chart.sopClassHandler],
  // Registered by cornerstone-dynamic-volume under its bare id, as preclinical-4d names it.
  hangingProtocol: 'default4D',
  // dynamic4D-pt, -ct, -fusion: the tool groups the protocol names.
  initToolGroups: ({
    extensionManager,
    toolGroupService,
    commandsManager,
    servicesManager,
  }) => {
    const { toolNames, Enums } = extensionManager.getModuleEntry(
      '@ohif/extension-cornerstone.utilityModule.tools',
    ).exports
    initPreclinicalToolGroups({
      toolNames,
      Enums,
      toolGroupService,
      commandsManager,
      servicesManager,
    })
  },
  onModeEnter,
  onModeExit,
  onSetupRouteComplete,
  // As preclinical-4d: OHIF's own 4D test checks the demo study's MRN.
  isValidMode: ({ study }) => ({
    valid: study.mrn === 'M1',
    description: 'Only for 4D PET/CT studies',
  }),
})
