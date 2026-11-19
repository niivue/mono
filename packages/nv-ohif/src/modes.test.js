import { expect, mock, test } from 'bun:test'

// Minimal host stand-ins: OHIF is not installed in this monorepo.
const basicLayout = { props: { viewports: [{}] } }
mock.module('@ohif/core', () => ({
  classes: { MetadataProvider: {} },
  DicomMetadataStore: {},
  utils: { guid: () => 'uid' },
}))
mock.module('@ohif/mode-basic', () => ({
  addActivatePanelTriggers: () => [],
  applyToolGroupAdditions: () => {},
  basicLayout,
  basicRoute: { layoutInstance: basicLayout },
  cornerstone: {},
  dicomecg: {},
  dicomRT: {},
  dicomSeg: {},
  dicomvideo: {},
  extensionDependencies: {},
  mode: {
    customizations: {
      basicModeCustomizations: { 'panelSegmentation.disableEditing': true },
    },
  },
  modeInstance: {
    modeCustomizations: 'basicModeCustomizations',
    onModeExit: () => {},
  },
  ohif: {},
  registerModeToolbar: ({ toolbarService }, { toolbarButtons }) =>
    toolbarService.register(toolbarButtons),
  sopClassHandlers: [],
}))
mock.module('@ohif/mode-tmtv', () => ({ initToolGroups: () => {} }))
mock.module('@ohif/mode-preclinical-4d/src/initToolGroups', () => ({
  default: () => {},
}))
mock.module('@ohif/mode-preclinical-4d/src/toolbarButtons', () => ({
  default: [],
}))
const { default: dynamic } = await import('./modes/dynamic.js')
const { default: viewer } = await import('./modes/viewer.js')
const { default: tmtv } = await import('./modes/tmtv.js')

test('the viewer mode does not inherit the basic read-only panel', () => {
  const { modeCustomizations } = viewer.modeInstance
  const block =
    typeof modeCustomizations === 'string'
      ? viewer.customizations[modeCustomizations]
      : modeCustomizations
  expect(block['panelSegmentation.disableEditing']).toBe(false)
})

test('TMTV retargets inherited cornerstone tools to its tool groups', () => {
  const buttons = {}
  const toolbarService = {
    sections: { primary: 'primary' },
    register: (list, replace) => {
      for (const b of list) if (replace || !buttons[b.id]) buttons[b.id] = b
    },
    getButtons: () => buttons,
    updateSection: () => {},
  }
  const length = {
    id: 'Length',
    props: {
      commands: {
        commandName: 'setToolActiveToolbar',
        commandOptions: { toolGroupIds: ['default', 'mpr'] },
      },
    },
  }
  const cornerstone = {
    getConfiguration: () => ({ rendering: {} }),
    setConfiguration: () => {},
  }
  tmtv.modeInstance.onModeEnter.call(tmtv.modeInstance, {
    servicesManager: {
      services: {
        toolbarService,
        measurementService: { clearMeasurements: () => {} },
        customizationService: {
          getCustomization: (k) => (k === 'toolbarButtons' ? [length] : []),
        },
        hangingProtocolService: { addCustomAttribute: () => {} },
      },
    },
    extensionManager: {
      getModuleEntry: () => ({
        exports: { getCornerstoneLibraries: () => ({ cornerstone }) },
      }),
    },
  })
  expect(buttons.Length.props.commands.commandOptions.toolGroupIds).toEqual([
    'ctToolGroup',
    'ptToolGroup',
    'fusionToolGroup',
  ])
})

test('leaving the 4D mode before its panes are up starts no cine', () => {
  const listeners = new Set()
  const cine = []
  const services = {
    workflowStepsService: {
      addWorkflowSteps() {},
      setActiveWorkflowStep() {},
    },
    cineService: {
      setIsCineEnabled: () => cine.push('enable'),
      setCine: () => cine.push('play'),
    },
    viewportGridService: {
      EVENTS: { VIEWPORTS_READY: 'ready' },
      getActiveViewportId: () => 'vp',
      subscribe: (_, f) => {
        listeners.add(f)
        return { unsubscribe: () => listeners.delete(f) }
      },
    },
    hangingProtocolService: { getState: () => ({ activeStudyUID: '1.2' }) },
  }
  const mode = dynamic.modeInstance
  mode.onSetupRouteComplete({ servicesManager: { services } })
  const cornerstone = {
    getConfiguration: () => ({ rendering: {} }),
    setConfiguration() {},
  }
  mode.onModeExit({
    extensionManager: {
      getModuleEntry: () => ({
        exports: { getCornerstoneLibraries: () => ({ cornerstone }) },
      }),
    },
  })
  for (const f of [...listeners]) f()
  expect(cine).toEqual([])
})

// OHIF still runs route setup for a study the server lacks, then redirects.
test('a missing study sets no 4D workflow step', () => {
  const steps = []
  dynamic.modeInstance.onSetupRouteComplete({
    servicesManager: {
      services: {
        workflowStepsService: {
          addWorkflowSteps: () => steps.push('add'),
          setActiveWorkflowStep: () => steps.push('set'),
        },
        hangingProtocolService: { getState: () => ({}) },
      },
    },
  })
  expect(steps).toEqual([])
})

// IDC's proxy returns no ModalitiesInStudy: the viewer must still be offered.
test('the viewer mode is valid for a study with unknown modalities', () => {
  const { isValidMode } = viewer.modeInstance
  expect(
    isValidMode.call(viewer.modeInstance, { modalities: '', study: {} }).valid,
  ).toBe(true)
})
