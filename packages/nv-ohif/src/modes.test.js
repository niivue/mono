import { expect, mock, test } from 'bun:test'

// Minimal host stand-ins: OHIF is not installed in this monorepo.
const basicLayout = { props: { viewports: [{}] } }
mock.module('@ohif/core', () => ({ classes: { MetadataProvider: {} } }))
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
  modeInstance: { modeCustomizations: 'basicModeCustomizations' },
  ohif: {},
  registerModeToolbar: ({ toolbarService }, { toolbarButtons }) =>
    toolbarService.register(toolbarButtons),
  sopClassHandlers: [],
}))
mock.module('@ohif/mode-segmentation', () => ({
  modeInstance: { toolbarButtons: [], toolbarSections: [] },
}))
mock.module('@ohif/mode-tmtv', () => ({ initToolGroups: () => {} }))
const { default: segmentation } = await import('./segmentation.js')
const { default: tmtv } = await import('./tmtv.js')

test('segmentation mode does not inherit the basic read-only panel', () => {
  const { modeCustomizations } = segmentation.modeInstance
  const block =
    typeof modeCustomizations === 'string'
      ? segmentation.customizations[modeCustomizations]
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
